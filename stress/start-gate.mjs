/**
 * Judges must wait until the host starts judging (iPad, WebKit).
 *
 *   G1  session created on /host/new, judges join: they stay on the waiting
 *       screen with no answer buttons, and no team is current in the database
 *   G2  host presses «بدء جلسة التحكيم»: every judge gets the first team
 *   G3  host moves on, then start runs again: the session is NOT sent back
 *   G4  a session opened on the control page before starting shows a start
 *       button (no prev/next), and pressing it sends the first team
 *   G5  a judge joining after the start lands on the current team
 *
 * Runs against a local build (`npm run build && npx vite preview --port 4173`)
 * with the database in .env.local; everything created is tagged and removed.
 *
 *   PW_DIR=<playwright install> node stress/start-gate.mjs
 */

import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';

const req = createRequire(process.env.PW_DIR ? `${process.env.PW_DIR}/package.json` : import.meta.url);
const { webkit, devices } = req('playwright');
try { process.loadEnvFile('.env.local'); } catch { /* exported env */ }

const BASE = process.env.BASE_URL || 'http://localhost:4173';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@judgeplatform.dyam.tech';
const DEVICE = devices['iPad Pro 11'];
const RUN = new Date().toISOString().replace(/[-:T.]/g, '').slice(2, 12);
const TAG = `LT${RUN}`;
const OUT = `stress/results/start-gate-${RUN}`;
mkdirSync(OUT, { recursive: true });

const URL_ = process.env.VITE_SUPABASE_URL;
const sb = createClient(URL_, process.env.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const REF = new URL(URL_).hostname.split('.')[0];
const TEAMS = [1, 2, 3].map((i) => `${TAG} فريق ${i}`);

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s]`, ...a);
const results = [];
const record = (id, title, ok, details) => {
  results.push({ id, title, status: ok ? 'PASS' : 'FAIL', details });
  log(`${(ok ? 'PASS' : 'FAIL').padEnd(5)} ${id} ${title} :: ${JSON.stringify(details)}`);
};
const created = { sessions: [], bankId: null };
const waitFor = async (fn, timeout = 30000, step = 150) => {
  const s = Date.now();
  while (Date.now() - s < timeout) { if (await fn().catch(() => false)) return Date.now() - s; await sleep(step); }
  return null;
};

async function adminSession() {
  const admin = createClient(URL_, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email: ADMIN_EMAIL });
  if (error) throw error;
  const anon = createClient(URL_, process.env.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: v, error: ve } = await anon.auth.verifyOtp({ token_hash: data.properties.hashed_token, type: 'magiclink' });
  if (ve) throw ve;
  return v.session;
}

async function newIPad(browser, session) {
  const ctx = await browser.newContext({ ...DEVICE, locale: 'ar-SA', timezoneId: 'Asia/Riyadh' });
  if (session) {
    await ctx.addInitScript(([key, value]) => { if (!localStorage.getItem(key)) localStorage.setItem(key, value); },
      [`sb-${REF}-auth-token`, JSON.stringify(session)]);
  }
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  page.on('pageerror', (e) => log('  pageerror:', String(e).slice(0, 160)));
  return page;
}

/** What a judge iPad shows right now. */
const judgeView = async (p) => ({
  team: (await p.locator('.judge-team-banner .team-name').innerText().catch(() => '')).trim(),
  waiting: await p.getByText('في انتظار بدء التحكيم').count(),
  answerButtons: await p.locator('.answer-btn').count(),
});
const currentTeamInDb = async (sid) => (await db.query('select current_team_id t from sessions where session_id=$1', [sid])).rows[0]?.t ?? null;

async function joinJudges(browser, sid, n, from = 1) {
  const pages = [];
  for (let j = 0; j < n; j++) {
    const p = await newIPad(browser);
    await p.goto(`${BASE}/judge/${sid}`);
    await p.selectOption('#judgeName', { index: from + j }); // preset names; option 0 is the placeholder
    await p.click('button:has-text("انضمام للجلسة")');
    await p.locator('.judge-team-banner').waitFor({ timeout: 20000 });
    pages.push(p);
  }
  return pages;
}

/** A session made directly in the database the way createSession now makes it (not started). */
async function dbSession(qids) {
  const sid = `sg${RUN.slice(-6)}`;
  await db.query(`insert into sessions(name, session_id, host_token, host_id, status, current_team_index, current_team_id, total_points)
    values ($1, $2, gen_random_uuid()::text, (select id from auth.users where email=$3), 'active', 0, null, 100)`, [`${TAG} start gate`, sid, ADMIN_EMAIL]);
  await db.query(`insert into session_teams(session_id, name, track, position) select $1, t, null, i - 1 from unnest($2::text[]) with ordinality as x(t, i)`, [sid, TEAMS]);
  await db.query(`insert into session_questions(session_id, question_id, position) select $1, q, i - 1 from unnest($2::uuid[]) with ordinality as x(q, i)`, [sid, qids]);
  created.sessions.push(sid);
  return sid;
}

async function main() {
  await db.connect();
  const { data: bankId, error } = await sb.rpc('create_question_bank', {
    p_name: `${TAG} أسئلة البدء`,
    p_questions: [1, 2, 3].map((i) => ({ text: `${i}. سؤال ${i}`, section: 'عام', weight: 1,
      choices: [{ text: 'ممتاز', weight: 3 }, { text: 'جيد', weight: 2 }, { text: 'ضعيف', weight: 1 }] })),
  });
  if (error) throw error;
  created.bankId = bankId;
  const qids = (await db.query('select id from questions where bank_id=$1 order by text', [bankId])).rows.map((r) => r.id);
  writeFileSync(`${OUT}/teams.csv`, '﻿اسم الفريق,المسار\r\n' + TEAMS.map((t) => `${t},عام`).join('\r\n') + '\r\n');

  const browser = await webkit.launch();
  log(`WebKit ${browser.version()} as iPad Pro 11 | app ${BASE}`);
  const host = await newIPad(browser, await adminSession());

  // ---- G1: create on /host/new exactly like the admin, judges join and must wait ----
  await host.goto(`${BASE}/host/new`);
  await host.locator('#teamsFile').waitFor({ state: 'attached', timeout: 20000 });
  await host.setInputFiles('#teamsFile', `${OUT}/teams.csv`);
  await host.locator('.upload-panel button:has-text("حفظ 3 فريق")').waitFor({ timeout: 10000 });
  await host.click('.upload-panel button:has-text("حفظ 3 فريق")');
  await host.locator('.upload-panel .alert-success').waitFor({ timeout: 15000 });
  await host.selectOption('#bankSelect', bankId);
  await host.locator('.question-picker input[type=checkbox]').first().waitFor({ timeout: 15000 });
  await host.locator('.field', { hasText: 'اختر الأسئلة' }).locator('button:has-text("تحديد الكل")').click();
  await host.click('button:has-text("إنشاء الجلسة ورابط المحكمين")');
  await host.locator('.session-code').waitFor({ timeout: 20000 });
  const sid = (await host.locator('.session-code').innerText()).trim();
  created.sessions.push(sid);
  const judges = await joinJudges(browser, sid, 3);
  await sleep(9000); // longer than the judges' 4 s check and a realtime round trip
  const before = await Promise.all(judges.map(judgeView));
  const dbBefore = await currentTeamInDb(sid);
  record('G1', 'After «إنشاء الجلسة», judges who join wait: no team, no answer buttons',
    dbBefore === null && before.every((v) => v.waiting === 1 && v.answerButtons === 0 && !TEAMS.includes(v.team)),
    { currentTeamInDb: dbBefore, judges: before });

  // ---- G2: host presses start -> every judge gets team 1 ----

  await host.click('button:has-text("بدء جلسة التحكيم")');
  const reached = await Promise.all(judges.map((p) => waitFor(async () => {
    const v = await judgeView(p);
    return v.team === TEAMS[0] && v.answerButtons === 9;
  }, 20000)));
  await host.locator('.team-display .team-name').filter({ hasText: TEAMS[0] }).waitFor({ timeout: 15000 });
  const hostCounter = (await host.locator('.card-title', { hasText: /^الفريق الحالي \(/ }).innerText()).trim();
  record('G2', 'Pressing «بدء جلسة التحكيم» sends team 1 to every judge and the host page',
    reached.every((ms) => ms !== null) && (await currentTeamInDb(sid)) === TEAMS[0] && /1\/3/.test(hostCounter),
    { msToEachJudge: reached, hostCounter });

  // ---- G3: move to team 2, then start again (second tab / retry): must not go back ----
  await host.click('button:has-text("التالي")');
  await waitFor(async () => (await currentTeamInDb(sid)) === TEAMS[1], 15000);
  const { data: again, error: ae } = await sb.from('sessions')
    .update({ current_team_index: 0, current_team_id: TEAMS[0] })
    .eq('session_id', sid).is('current_team_id', null).select('session_id'); // same guarded update as startSession
  await sleep(5000);
  const after = await Promise.all(judges.map(judgeView));
  record('G3', 'Starting again after moving on changes nothing (no jump back to team 1)',
    !ae && again.length === 0 && (await currentTeamInDb(sid)) === TEAMS[1] && after.every((v) => v.team === TEAMS[1]),
    { rowsChangedBySecondStart: again?.length, currentTeamInDb: await currentTeamInDb(sid), judges: after.map((v) => v.team) });

  // ---- G5: a judge joining now lands on the current team ----
  const [late] = await joinJudges(browser, sid, 1, 4);
  const lateOk = await waitFor(async () => (await judgeView(late)).team === TEAMS[1] && (await judgeView(late)).answerButtons === 9, 15000);
  record('G5', 'A judge who joins after the start lands on the current team', lateOk !== null, { team: (await judgeView(late)).team });

  // ---- G4: control page opened before starting (e.g. from the dashboard) ----
  const sid2 = await dbSession(qids);
  const judges2 = await joinJudges(browser, sid2, 2);
  await host.goto(`${BASE}/host/${sid2}/control`);
  await host.getByText('لم يبدأ التحكيم بعد').waitFor({ timeout: 20000 });
  const ui = {
    startButton: await host.locator('button:has-text("بدء التحكيم")').count(),
    nextButton: await host.locator('button:has-text("التالي")').count(),
    counter: (await host.locator('.card-title', { hasText: /^الفريق الحالي \(/ }).innerText()).trim(),
  };
  await sleep(6000);
  const waiting2 = await Promise.all(judges2.map(judgeView));
  await host.click('button:has-text("بدء التحكيم")');
  const reached2 = await Promise.all(judges2.map((p) => waitFor(async () => (await judgeView(p)).team === TEAMS[0], 20000)));
  const nextAfter = await host.locator('button:has-text("التالي")').count();
  record('G4', 'Control page before start: start button only; judges wait; pressing it sends team 1',
    ui.startButton === 1 && ui.nextButton === 0 && /0\/3/.test(ui.counter) && waiting2.every((v) => v.waiting === 1 && v.answerButtons === 0)
      && reached2.every((ms) => ms !== null) && nextAfter === 1 && (await currentTeamInDb(sid2)) === TEAMS[0],
    { beforeStart: ui, judgesBefore: waiting2.map((v) => v.team), msToJudges: reached2, nextShownAfterStart: nextAfter === 1 });

  await browser.close();
}

async function cleanup() {
  for (const sid of created.sessions) {
    await db.query('delete from answers where session_id=$1', [sid]);
    await db.query('delete from session_results where session_id=$1', [sid]);
    await db.query('delete from judges where session_id=$1', [sid]);
    await db.query('delete from sessions where session_id=$1', [sid]);
  }
  await db.query('delete from teams where name like $1', [`${TAG} %`]);
  if (created.bankId) {
    await db.query('delete from questions where bank_id=$1', [created.bankId]);
    await db.query('delete from question_banks where id=$1', [created.bankId]);
  }
  log(`cleanup: ${created.sessions.length} session(s) and tagged teams/bank removed`);
}

try { await main(); }
catch (e) { log('ERROR', e.stack || e.message); results.push({ id: 'RUN', status: 'FAIL', details: e.message }); }
finally {
  await cleanup().catch((e) => log('cleanup error', e.message));
  await db.end();
  writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
  const fails = results.filter((r) => r.status === 'FAIL').length;
  log(`${results.length - fails} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
}
