/**
 * Scenario: a judge loses their connection for several minutes mid-judging,
 * and the host moves to the next team during the outage.
 *
 * Faithful to src/pages/JudgePage.tsx:
 *   - the judge only knows the current team from its own 4s session check,
 *     which needs the network (no other way to learn about a team change)
 *   - answers go into the real OfflineAnswerQueue (src/lib/offlineQueue.ts)
 *     and are sent with the same upsert; the queue retries every 8s
 *   - the app has no offline cache, so a page reload is only possible once
 *     the network is back
 *
 *   node --experimental-strip-types stress/scenario-offline.mjs [--minutes 3]
 */

import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import { setTimeout as sleep } from 'node:timers/promises';
import { OfflineAnswerQueue } from '../src/lib/offlineQueue.ts';

try { process.loadEnvFile('.env.local'); } catch { /* exported env */ }

const ai = process.argv.indexOf('--minutes');
const OUTAGE_MIN = ai > -1 ? Number(process.argv[ai + 1]) : 3;
const POLL_MS = 4_000;   // JudgePage POLL_MS
const RETRY_MS = 8_000;  // JudgePage QUEUE_RETRY_MS

const sb = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const RUN = new Date().toISOString().replace(/[-:T.]/g, '').slice(2, 12);
const TAG = `LT${RUN}`;
const SID = `lt${RUN.slice(-6)}`;
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s]`, ...a);

// The judge device's network. The host is on a different device and stays online.
let online = true;
const offlineError = () => new TypeError('fetch failed');

// localStorage stand-in that survives a page reload
const disk = new Map();
const storage = { getItem: (k) => disk.get(k) ?? null, setItem: (k, v) => disk.set(k, v), removeItem: (k) => disk.delete(k) };

const send = async (p) => {
  if (!online) throw offlineError();
  const { error } = await sb.from('answers').upsert({
    answer: p.answer, points: p.points, question_id: p.question_id,
    team_id: p.team_id, judge_id: p.judge_id, session_id: p.session_id,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'session_id,team_id,judge_id,question_id' });
  if (error) throw error;
};

async function main() {
  // ---- setup (tagged, removed at the end) ----
  const { data: bank } = await sb.from('question_banks').insert({ name: `${TAG} scenario bank` }).select().single();
  const { data: qs } = await sb.from('questions').insert(Array.from({ length: 5 }, (_, n) => ({
    text: `${TAG} Q${n + 1}`, choices: [{ text: 'A', weight: 3 }, { text: 'B', weight: 2 }, { text: 'C', weight: 1 }],
    section: 'scenario', weight: 1, bank_id: bank.id,
  }))).select();
  qs.sort((a, b) => a.text.localeCompare(b.text));
  const teams = [`${TAG}-team-1`, `${TAG}-team-2`];
  await sb.from('sessions').insert({ name: `${TAG} load test session`, session_id: SID, host_token: crypto.randomUUID(), status: 'active', current_team_index: 0, current_team_id: teams[0], total_points: 100 });
  await sb.from('session_teams').insert(teams.map((name, position) => ({ session_id: SID, name, position })));
  const { data: judge } = await sb.from('judges').insert({ name: `${TAG}-judge-01`, judge_token: crypto.randomUUID(), session_id: SID }).select().single();
  const qkey = `answerQueue_${SID}_${judge.id}`;

  // ---- the judge page ----
  const page = { team: null, queue: null, timers: [] };
  const expected = new Map(); // `${team}|${qid}` -> final answer
  let teamSwitchSeenAt = null;

  const poll = async () => {                       // JudgePage poll(): needs the network
    if (!online) throw offlineError();
    const { data, error } = await sb.from('sessions').select('current_team_id, status').eq('session_id', SID).single();
    if (error) throw error;
    if (data.current_team_id !== page.team) {
      if (page.team) { teamSwitchSeenAt = Date.now(); log(`page: switched to ${data.current_team_id.slice(-6)} (learned from the 4s check)`); }
      page.team = data.current_team_id;
    }
  };
  const openPage = async () => {                   // load / reload the page (online only)
    page.timers.forEach(clearInterval);
    page.queue = new OfflineAnswerQueue(qkey, storage);
    await poll();
    await page.queue.flush(send).catch(() => {});
    page.timers = [
      setInterval(() => poll().catch(() => {}), POLL_MS),
      setInterval(() => { if (page.queue.size) page.queue.flush(send).catch(() => {}); }, RETRY_MS),
    ];
  };
  const pick = async (q, choice) => {              // judge taps an answer on the team shown on screen
    const team = page.team;
    const points = { A: 1, B: 0.67, C: 0.33 }[choice];
    page.queue.enqueue({ session_id: SID, team_id: team, judge_id: judge.id, question_id: q.id, answer: choice, points });
    expected.set(`${team}|${q.id}`, choice);
    await page.queue.flush(send).catch(() => {});
  };
  const qn = (q) => q.text.slice(-2);

  log(`session ${SID}, outage ${OUTAGE_MIN} min`);
  await openPage();
  log(`page shows ${page.team.slice(-6)}`);

  // 1. online
  await pick(qs[0], 'A'); await pick(qs[1], 'B');
  log(`online : answered ${page.team.slice(-6)} Q1, Q2  | waiting on device: ${page.queue.size}`);

  // 2. judge's network drops
  online = false;
  const outageStart = Date.now();
  log('JUDGE NETWORK DOWN (host stays online)');

  // 3. judge keeps judging the team on screen
  await pick(qs[2], 'C'); await pick(qs[3], 'A'); await pick(qs[0], 'C');
  log(`offline: answered Q3, Q4, changed Q1 A->C on ${page.team.slice(-6)} | waiting: ${page.queue.size}`);

  await sleep(30_000);
  const { error: hostErr } = await sb.from('sessions').update({ current_team_index: 1, current_team_id: teams[1] }).eq('session_id', SID);
  log(`HOST moves to team-2 ${hostErr ? 'FAILED' : 'ok'} | judge page still shows ${page.team.slice(-6)} (cannot know)`);

  await pick(qs[4], 'B');
  log(`offline: answered Q5 on ${page.team.slice(-6)} (judge still sees team-1) | waiting: ${page.queue.size}`);

  const left = outageStart + OUTAGE_MIN * 60_000 - Date.now();
  if (left > 0) await sleep(left);

  // 4. network back: nobody touches anything, the page's timers do the work
  online = true;
  const backAt = Date.now();
  log(`JUDGE NETWORK UP after ${((backAt - outageStart) / 60000).toFixed(1)} min`);
  while ((page.queue.size || page.team !== teams[1]) && Date.now() - backAt < 60_000) await sleep(200);
  log(`queue sent and page on ${page.team.slice(-6)} within ${((Date.now() - backAt) / 1000).toFixed(1)}s` +
      ` (team switch seen after ${((teamSwitchSeenAt - backAt) / 1000).toFixed(1)}s)`);

  // 5. judge now judges team-2, then refreshes the page once for good measure
  for (const [i, c] of [[0, 'A'], [1, 'A'], [2, 'B'], [3, 'C'], [4, 'A']]) await pick(qs[i], c);
  log(`online : answered ${page.team.slice(-6)} Q1-Q5 | waiting: ${page.queue.size}`);
  await openPage();
  log(`page reloaded online: page on ${page.team.slice(-6)}, waiting: ${page.queue.size}`);
  page.timers.forEach(clearInterval);

  // 6. verify in Postgres
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const rows = (await c.query('select team_id, question_id, answer from answers where session_id=$1', [SID])).rows;
  const got = new Map(rows.map((r) => [`${r.team_id}|${r.question_id}`, r.answer]));
  const missing = [...expected.keys()].filter((k) => !got.has(k));
  const wrong = [...expected.entries()].filter(([k, v]) => got.has(k) && got.get(k) !== v);
  const byTeam = (t) => rows.filter((r) => r.team_id === t).map((r) => `${qn(qs.find((q) => q.id === r.question_id))}=${r.answer}`).sort().join(' ');
  console.log('\nRESULT (read back from Postgres)');
  console.log(`  team-1 : ${byTeam(teams[0])}`);
  console.log(`  team-2 : ${byTeam(teams[1])}`);
  console.log(`  expected ${expected.size}, in DB ${rows.length}, missing ${missing.length}, wrong ${wrong.length}, duplicates ${rows.length - got.size}`);
  const pass = !missing.length && !wrong.length && rows.length === expected.size && page.queue.size === 0;
  console.log(`  ${pass ? 'PASS: no data loss, every answer under the team the judge was actually judging' : 'FAIL'}`);

  await c.query('delete from answers where session_id=$1', [SID]);
  await c.query('delete from judges where session_id=$1', [SID]);
  await c.query('delete from sessions where session_id=$1', [SID]);
  await c.query('delete from questions where bank_id=$1', [bank.id]);
  await c.query('delete from question_banks where id=$1', [bank.id]);
  await c.end();
  log('test data removed');
  process.exit(pass ? 0 : 2);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
