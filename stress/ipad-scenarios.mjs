/**
 * Live iPad scenario suite.
 *
 * Runs the REAL judge page from the live site (judgeplatform.dyam.tech) in
 * WebKit, Safari's engine, emulating iPad Pro 11, against the production
 * database. A 20-team session is judged by six iPads while failures are
 * injected at specific teams. The host is driven from Node exactly like
 * src/pages/ControlPage.tsx does it (sessions UPDATE + 'team-change' broadcast,
 * finish_session RPC).
 *
 * Network control per iPad:
 *   - context.setOffline()            -> every fetch fails ("Load failed")
 *   - context.routeWebSocket(...)     -> realtime sockets are proxied so they
 *                                        can be cut, and refused while offline
 *
 * Requires Playwright 1.61 (WebKit 26.x):
 *   npm i -D playwright@1.61 && npx playwright install webkit
 *   node --experimental-strip-types stress/ipad-scenarios.mjs [--keep]
 * or point PW_DIR at a folder where playwright is installed.
 */

import { createRequire } from 'node:module';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import { writeFileSync, mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const req = createRequire(process.env.PW_DIR ? `${process.env.PW_DIR}/package.json` : import.meta.url);
const { webkit, devices } = req('playwright');

try { process.loadEnvFile('.env.local'); } catch { /* exported env */ }

const BASE = process.env.BASE_URL || 'https://judgeplatform.dyam.tech';
const DEVICE = devices['iPad Pro 11'];
const KEEP = process.argv.includes('--keep');
const RUN = new Date().toISOString().replace(/[-:T.]/g, '').slice(2, 12);
const TAG = `LT${RUN}`;
const OUT = `stress/results/ipad-${RUN}`;
mkdirSync(OUT, { recursive: true });

const sb = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY, {
  realtime: { params: { eventsPerSecond: 10 } },
  auth: { persistSession: false, autoRefreshToken: false },
});
const pgc = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 60000).toFixed(1).padStart(5)}m]`, ...a);
const results = []; // {id, title, status: PASS|FAIL|KNOWN, details}
const record = (id, title, status, details) => { results.push({ id, title, status, details }); log(`${status.padEnd(5)} ${id} ${title} :: ${JSON.stringify(details)}`); };
const createdSessions = [];
let bankId = null;

// ------------------------------------------------------------------ data --

const CHOICES = [
  { text: 'ممتاز', weight: 5 }, { text: 'جيد جدا', weight: 4 }, { text: 'جيد', weight: 3 },
  { text: 'مقبول', weight: 2 }, { text: 'ضعيف', weight: 1 },
];
const QTEXT = ['وضوح المشكلة وأهميتها', 'جودة الحل المقترح', 'قابلية التطبيق', 'الابتكار والتميز', 'جودة العرض'];

async function makeBank() {
  // saved like the app does: bank + questions + choices in one transaction
  const { data: id, error } = await sb.rpc('create_question_bank', {
    p_name: `${TAG} ipad bank`,
    p_questions: QTEXT.map((t, i) => ({ text: `${i + 1}. ${t}`, section: 'التحكيم', weight: 1, choices: CHOICES })),
  });
  if (error) throw error;
  bankId = id;
  const { data: qs, error: qe } = await sb.from('questions').select('id, text').eq('bank_id', id);
  if (qe) throw qe;
  return qs.sort((a, b) => a.text.localeCompare(b.text));
}

async function makeSession(sid, teamCount, questions) {
  const teams = Array.from({ length: teamCount }, (_, i) => `فريق ${String(i + 1).padStart(2, '0')}`);
  const { error } = await sb.from('sessions').insert({
    name: `${TAG} load test session (${sid})`, session_id: sid, host_token: crypto.randomUUID(),
    status: 'active', current_team_index: 0, current_team_id: null, total_points: 100,
  });
  if (error) throw error;
  createdSessions.push(sid);
  await sb.from('session_teams').insert(teams.map((name, position) => ({ session_id: sid, name, position })));
  await sb.from('session_questions').insert(questions.map((q, position) => ({ session_id: sid, question_id: q.id, position })));
  return teams;
}

// ------------------------------------------------------------------ host --

class Host {
  constructor(sid, teams) { this.sid = sid; this.teams = teams; this.index = -1; }
  async start() {
    this.ch = sb.channel(`session-${this.sid}`);
    await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('host broadcast subscribe timeout')), 15000);
      this.ch.subscribe((s) => { if (s === 'SUBSCRIBED') { clearTimeout(to); res(); } });
    });
  }
  async goTo(i) {
    this.index = i;
    const team = this.teams[i];
    const { error } = await sb.from('sessions').update({ current_team_index: i, current_team_id: team, updated_at: new Date().toISOString() }).eq('session_id', this.sid);
    if (error) throw error;
    const sentAt = Date.now();
    await this.ch.send({ type: 'broadcast', event: 'team-change', payload: { currentTeam: team, status: 'active', sentAt } });
    return sentAt;
  }
  get team() { return this.teams[this.index]; }
  async finish() {
    const { data, error } = await sb.rpc('finish_session', { p_session_id: this.sid });
    if (error) throw error;
    await this.ch.send({ type: 'broadcast', event: 'team-change', payload: { currentTeam: this.team, status: 'completed', sentAt: Date.now() } });
    return data;
  }
  async stop() { await sb.removeChannel(this.ch); }
}

// ------------------------------------------------------------------ iPad --

class IPad {
  constructor(browser, label, name) {
    this.browser = browser; this.label = label; this.name = name;
    this.offline = false; this.sockets = new Set();
    this.net = { httpBytes: 0, httpCount: 0, wsBytes: 0, wsFrames: 0, since: Date.now() };
    this.ledger = new Map(); // `${team}|${q}` -> choice text (final tap)
  }
  async newContext() {
    this.ctx = await this.browser.newContext({ ...DEVICE, locale: 'ar-SA', timezoneId: 'Asia/Riyadh' });
    await this.ctx.routeWebSocket(/supabase\.co\/realtime/, (ws) => {
      if (this.offline) { ws.close({ code: 4000, reason: 'offline' }); return; }
      const server = ws.connectToServer();
      this.sockets.add(ws);
      ws.onMessage((m) => { this.net.wsBytes += Buffer.byteLength(m); this.net.wsFrames++; server.send(m); });
      server.onMessage((m) => { this.net.wsBytes += Buffer.byteLength(m); this.net.wsFrames++; ws.send(m); });
      ws.onClose(() => { this.sockets.delete(ws); server.close(); });
      server.onClose(() => { this.sockets.delete(ws); ws.close(); });
    });
    return this.ctx;
  }
  meter(page) {
    this.failures ||= [];
    page.on('requestfailed', (r) => this.failures.push({ t: Date.now(), m: r.method(), u: r.url().replace(/^https:\/\/[^/]+/, '').slice(0, 60), e: r.failure()?.errorText }));
    page.on('console', (m) => { if (m.type() === 'error') this.failures.push({ t: Date.now(), console: m.text().slice(0, 140) }); });
    page.on('requestfinished', async (r) => {
      const s = await r.sizes().catch(() => null);
      if (s) { this.net.httpBytes += s.requestHeadersSize + s.requestBodySize + s.responseHeadersSize + s.responseBodySize; this.net.httpCount++; }
    });
  }
  async open(sid) {
    this.sid = sid;
    this.page = await this.ctx.newPage();
    this.meter(this.page);
    await this.page.goto(`${BASE}/judge/${sid}`, { waitUntil: 'domcontentloaded' });
    return this.page;
  }
  async join(page = this.page) {
    await page.locator('#judgeName').waitFor({ timeout: 20000 });
    await page.fill('#judgeName', this.name);
    await page.click('button:has-text("انضمام للجلسة")');
    await page.locator('.judge-team-banner').waitFor({ timeout: 20000 });
  }
  async team(page = this.page) { return (await page.locator('.judge-team-banner .team-name').textContent().catch(() => null))?.trim(); }
  async waitTeam(team, timeout = 30000, page = this.page) {
    const s = Date.now();
    while (Date.now() - s < timeout) {
      if ((await this.team(page)) === team && await page.locator('.question-block').count() > 0) return Date.now() - s;
      await sleep(100);
    }
    return null;
  }
  async tap(q, c, page = this.page) {
    await page.locator('.question-block').nth(q).locator('.answer-btn').nth(c).click({ timeout: 10000 });
    this.ledger.set(`${await this.team(page)}|${q}`, CHOICES[c].text);
  }
  async answer(qs, page = this.page, delay = 400) {
    for (const q of qs) { await this.tap(q, Math.floor(Math.random() * 5), page); await sleep(delay + Math.random() * delay); }
  }
  async submit(page = this.page) {
    await page.click('button:has-text("إرسال الإجابات النهائية")', { timeout: 5000 }).catch(() => {});
  }
  async selected(page = this.page) {
    return page.$$eval('.question-block', (blocks) => blocks.map((b) => {
      const btn = b.querySelector('.answer-btn.selected div');
      return btn ? btn.textContent.trim() : null;
    }));
  }
  async storage(page = this.page) {
    return page.evaluate(() => {
      const out = {};
      for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); out[k] = localStorage.getItem(k); }
      return out;
    });
  }
  async pending(page = this.page) {
    const s = await this.storage(page);
    const k = Object.keys(s).find((x) => x.startsWith(`answerQueue_${this.sid}_`));
    return k ? JSON.parse(s[k]).length : 0;
  }
  async conn(page = this.page) {
    return (await page.locator('button[title="إعادة الاتصال"]').textContent().catch(() => ''))?.trim();
  }
  async judgeId(page = this.page) {
    const s = await this.storage(page);
    return s[`judge_${this.sid}`] ? JSON.parse(s[`judge_${this.sid}`]).id : null;
  }
  async goOffline() {
    this.offline = true;
    await this.ctx.setOffline(true);
    for (const ws of [...this.sockets]) ws.close({ code: 4000, reason: 'network lost' });
  }
  async goOnline() {
    this.offline = false;
    await this.ctx.setOffline(false);
  }
  /** iPad unlocked / Safari brought back to the foreground */
  async wake(page = this.page) {
    await page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); }).catch(() => {});
  }
  async waitFor(fn, timeout = 60000, step = 250) {
    const s = Date.now();
    while (Date.now() - s < timeout) { if (await fn().catch(() => false)) return Date.now() - s; await sleep(step); }
    return null;
  }
}

const bytes = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(2)} MB` : `${(n / 1e3).toFixed(1)} KB`);
const utf16 = (obj) => Object.entries(obj).reduce((s, [k, v]) => s + (k.length + v.length) * 2, 0);

async function dbAnswers(sid) {
  return (await pgc.query(
    `select a.team_id, a.question_id, a.answer, j.name judge
       from answers a join judges j on j.id = a.judge_id where a.session_id = $1`, [sid])).rows;
}

// ============================================================== MAIN EVENT ==

async function mainEvent(browser, questions) {
  const sid = `ip${RUN.slice(-6)}`;
  const teams = await makeSession(sid, 20, questions);
  const qIndex = new Map(questions.map((q, i) => [q.id, i]));
  log(`MAIN EVENT session ${sid}: 20 teams, 5 questions, 6 iPads  ->  ${BASE}/judge/${sid}`);

  const ipads = ['A', 'B', 'C', 'D', 'E', 'F'].map((l) => new IPad(browser, l, `محكم ${l}`));
  const host = new Host(sid, teams);
  await host.start();

  // ---- S01 join by link ----
  const joinTimes = [];
  for (const ip of ipads) {
    await ip.newContext();
    const s = Date.now();
    await ip.open(sid);
    await ip.join();
    joinTimes.push(Date.now() - s);
  }
  const ids = await Promise.all(ipads.map((ip) => ip.judgeId()));
  record('S01', 'Six iPads join through the session link', ids.every(Boolean) ? 'PASS' : 'FAIL',
    { joinMsMax: Math.max(...joinTimes), joinMsAvg: Math.round(joinTimes.reduce((a, b) => a + b) / joinTimes.length) });

  const away = new Set();          // iPads the host is not waiting for
  const deliveries = [];
  const scenarioTasks = [];        // background scenario promises

  // Host loop helpers
  const progressDone = async (team) => {
    const want = ipads.filter((ip) => !away.has(ip.label));
    const wantIds = await Promise.all(want.map((ip) => ip.judgeId().catch(() => null)));
    const { rows } = await pgc.query(
      'select judge_id, count(*)::int n from answers where session_id=$1 and team_id=$2 group by 1', [sid, team]);
    const m = new Map(rows.map((r) => [r.judge_id, r.n]));
    return wantIds.every((id) => id && (m.get(id) || 0) >= 5);
  };

  for (let i = 0; i < 20; i++) {
    const team = teams[i];
    // iPads coming back from an outage rejoin the host's wait list at a team boundary
    for (const ip of ipads) if (ip.rejoinAtNextRound) { ip.rejoinAtNextRound = false; ip.busyScenario = false; away.delete(ip.label); }
    const sentAt = await host.goTo(i);
    const roundStart = Date.now();

    // every iPad that is reachable waits for the new team and judges it
    const active = ipads.filter((ip) => !away.has(ip.label) && !ip.busyScenario);
    const lat = await Promise.all(active.map(async (ip) => {
      const ms = await ip.waitTeam(team, 20000);
      if (ms !== null) deliveries.push(Date.now() - sentAt);
      return ms;
    }));
    const missed = active.filter((_, k) => lat[k] === null).map((ip) => ip.label);
    if (missed.length) log(`  team ${i + 1}: ${missed.join(',')} did not show the team within 20 s`);

    const owners = OWNERS[i + 1] || [];
    const plain = active.filter((ip) => !owners.includes(ip.label));
    const scenario = scenarios[i + 1];
    await Promise.all([
      ...plain.map(async (ip) => { await ip.answer([0, 1, 2, 3, 4]); await ip.submit(); }),
      scenario ? scenario({ ipads, host, team, i, sid, away, scenarioTasks, teams }) : Promise.resolve(),
    ]);

    // pace like a real event: at least 30 s per team, wait for every non-away iPad
    const ok = await ipads[0].waitFor(() => progressDone(team), 150000, 1000);
    if (ok === null) {
      const { rows } = await pgc.query('select judge_id, count(*)::int n from answers where session_id=$1 and team_id=$2 group by 1', [sid, team]);
      const m = new Map(rows.map((r) => [r.judge_id, r.n]));
      const diag = [];
      for (const ip of ipads.filter((x) => !away.has(x.label))) {
        const id = await ip.judgeId().catch(() => null);
        diag.push({ ipad: ip.label, rowsForTeam: m.get(id) || 0, unsent: await ip.pending().catch(() => 'n/a'), shows: await ip.team().catch(() => 'n/a'),
          chip: await ip.conn().catch(() => 'n/a'), recentFailures: (ip.failures || []).filter((f) => f.t > roundStart).slice(-6) });
      }
      log(`  DIAG team ${i + 1}: ${JSON.stringify(diag)}`);
      results.push({ id: `D${i + 1}`, title: `Host timed out on team ${i + 1}`, status: 'DIAG', details: diag });
    }
    const left = roundStart + 30000 - Date.now();
    if (left > 0) await sleep(left);
    log(`team ${String(i + 1).padStart(2)} ${team}: ${ok !== null ? 'all present' : 'TIMEOUT waiting for answers'} (away: ${[...away].join(',') || '-'})`);
  }

  await Promise.all(scenarioTasks);

  // ---- S10 host ends the session while two iPads are offline with unsent answers ----
  const cEnd = ipads[2], fEnd = ipads[5], lastTeam = teams[19];
  const cPendingBefore = await cEnd.pending();
  const finished = await host.finish();
  await sleep(3000);
  // (a) iPad C: network returns with the tab still open
  await cEnd.goOnline(); await cEnd.wake();
  await sleep(25000);
  const cEnded = await cEnd.page.locator('h3:has-text("انتهت جلسة التحكيم")').count() > 0;
  const cPendingAfter = await cEnd.pending();
  // (b) iPad F: judge reopens the link after the session has ended
  await fEnd.goOnline();
  fEnd.page = await fEnd.ctx.newPage(); fEnd.meter(fEnd.page);
  await fEnd.page.goto(`${BASE}/judge/${sid}`, { waitUntil: 'domcontentloaded' });
  await sleep(10000);
  const fEnded = await fEnd.page.locator('h3:has-text("انتهت جلسة التحكيم")').count() > 0;
  const fPendingAfter = await fEnd.pending();
  const lastRows = (await dbAnswers(sid)).filter((r) => r.team_id === lastTeam);
  const cRows = lastRows.filter((r) => r.judge === cEnd.name).length, fRows = lastRows.filter((r) => r.judge === fEnd.name).length;
  const resultsRowLast = (await pgc.query('select answer_count from session_results where session_id=$1 and team_id=$2', [sid, lastTeam])).rows[0]?.answer_count;
  record('S10a', 'Session ended while an iPad was offline; it reconnects with the tab still open',
    cPendingAfter === 0 && cRows === 3 ? 'PASS' : 'KNOWN',
    { unsentBeforeEnd: cPendingBefore, endedScreenShown: cEnded, unsentLeftOnIPad: cPendingAfter, answersInDb: cRows,
      savedResultCountsThem: false, savedResultAnswerCount: resultsRowLast,
      note: 'answers sent after finish_session are stored but not included in session_results' });
  record('S10b', 'Session ended while an iPad was offline; the judge reopens the link afterwards',
    fPendingAfter === 0 && fRows === 2 ? 'PASS' : 'KNOWN',
    { unsentWhenTabClosed: fEnd.pendingAtClose, endedScreenShown: fEnded, unsentLeftOnIPad: fPendingAfter, answersInDb: fRows, finishSessionRows: finished,
      note: 'the ended screen never sends what is waiting on the iPad' });

  // ---- verification of every tap against Postgres ----
  const rows = await dbAnswers(sid);
  const got = new Map(rows.map((r) => [`${r.judge}|${r.team_id}|${qIndex.get(r.question_id)}`, r.answer]));
  const dup = (await pgc.query('select count(*)::int n from (select team_id,judge_id,question_id from answers where session_id=$1 group by 1,2,3 having count(*)>1) d', [sid])).rows[0].n;
  let expected = 0, missing = [], wrong = [];
  for (const ip of ipads) {
    for (const [k, v] of ip.ledger) {
      const [team, q] = k.split('|');
      if ((ip.label === 'C' || ip.label === 'F') && team === lastTeam) continue; // S10, reported there
      expected++;
      const g = got.get(`${ip.name}|${team}|${q}`);
      if (g === undefined) missing.push(`${ip.label}:${team}:Q${+q + 1}`);
      else if (g !== v) wrong.push(`${ip.label}:${team}:Q${+q + 1} db=${g} tapped=${v}`);
    }
  }
  const lb = (await pgc.query('select * from session_leaderboard($1)', [sid])).rows;
  // team score = per question, the average of the judges who answered it, summed (out of 100)
  const direct = new Map((await pgc.query(`select team_id, round(sum(a), 2) s from (select team_id, question_id, avg(points) a
    from answers where session_id=$1 group by 1, 2) x group by 1`, [sid])).rows.map((r) => [r.team_id, Number(r.s)]));
  const lbMismatch = lb.filter((r) => Math.abs(Number(r.total_points) - (direct.get(r.team_id) || 0)) > 0.005).length;
  const resultsRows = (await pgc.query('select count(*)::int n from session_results where session_id=$1', [sid])).rows[0].n;
  record('V01', 'Every answer tapped on an iPad is in the database with the final choice',
    missing.length || wrong.length || dup ? 'FAIL' : 'PASS',
    { tapsChecked: expected, rowsInDb: rows.length, missing, wrong, duplicates: dup });
  record('V02', 'Leaderboard and saved results match the raw answers',
    lbMismatch === 0 && resultsRows === 20 ? 'PASS' : 'FAIL', { teams: lb.length, mismatches: lbMismatch, sessionResultsRows: resultsRows });

  // ---- delivery + network + storage numbers ----
  const sorted = [...deliveries].sort((a, b) => a - b);
  const p = (x) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * x))];
  const minutes = (Date.now() - ipads[0].net.since) / 60000;
  const netA = ipads[0].net;
  const storages = await Promise.all(ipads.map(async (ip) => ({ label: ip.label, bytes: utf16(await ip.storage().catch(() => ({}))) })));
  const metrics = {
    teamChangeDelivery: { samples: sorted.length, p50: p(0.5), p95: p(0.95), max: sorted[sorted.length - 1] },
    networkPerIPadA: {
      minutes: Math.round(minutes),
      http: bytes(netA.httpBytes), httpRequests: netA.httpCount, websocket: bytes(netA.wsBytes), wsFrames: netA.wsFrames,
      perHour: bytes(((netA.httpBytes + netA.wsBytes) / minutes) * 60),
    },
    localStorageAtEnd: storages,
  };
  await host.stop();
  for (const ip of ipads) await ip.ctx.close();
  return { sid, metrics };
}

// ------------------------------------------------- scenarios by team number --

/** Which iPad(s) each scenario drives (they skip the normal answering that team). */
const OWNERS = { 3: ['A'], 4: ['B'], 5: ['C'], 8: ['D'], 10: ['E'], 13: ['F'], 15: ['B'], 17: ['A'], 20: ['C', 'F'] };

/** Fail every matching GET for a short window, so the next page load hits it, not a background poll. */
function faultWindow(page, pattern, ms) {
  const until = { t: 0 };
  const handler = async (r) => (r.request().method() === 'GET' && Date.now() < until.t ? r.abort('failed') : r.continue());
  return {
    async arm() { await page.route(pattern, handler); until.t = Date.now() + ms; },
    async disarm() { await page.unroute(pattern, handler); },
  };
}

const scenarios = {
  // S02 change an answer
  3: async ({ ipads }) => {
    const A = ipads[0];
    await A.answer([0, 1, 2, 3, 4]);
    const before = (await A.selected())[0];
    const alt = CHOICES.findIndex((c) => c.text !== before);
    await A.tap(0, alt);
    await sleep(1500);
    record('S02', 'Judge changes an answer after first tapping', 'PASS', { from: before, to: CHOICES[alt].text, note: 'verified in V01' });
    await A.submit();
  },

  // S03 refresh mid-team
  4: async ({ ipads }) => {
    const B = ipads[1];
    await B.answer([0, 1]);
    const before = await B.selected();
    await B.page.reload({ waitUntil: 'domcontentloaded' });
    const rejoinMs = await B.waitFor(async () => (await B.page.locator('.question-block').count()) > 0, 20000);
    const joinScreen = await B.page.locator('#judgeName').count();
    const restoredMs = await B.waitFor(async () => { const a = await B.selected(); return before.slice(0, 2).every((v, k) => v && a[k] === v); }, 4000, 50);
    const kept = restoredMs !== null;
    await B.answer([2, 3, 4]);
    await B.submit();
    record('S03', 'Safari tab refreshed in the middle of a team', kept && !joinScreen ? 'PASS' : 'FAIL',
      { backOnQuestionsMs: rejoinMs, askedForNameAgain: joinScreen > 0, answersRestored: kept, restoredAfterQuestionsMs: restoredMs });
  },

  // S04 network lost for 3 minutes, host keeps moving
  5: async ({ ipads, away, scenarioTasks, host, teams }) => {
    const C = ipads[2];
    C.busyScenario = true;
    await C.answer([0, 1]);
    await C.goOffline();
    away.add('C');
    await sleep(1500);
    await C.answer([2, 3, 4]);
    const pend = await C.pending();
    const banner = await C.page.locator('.alert-warning:has-text("لا يوجد اتصال")').count() > 0;
    const chip = await C.conn();
    const teamAtLoss = await C.team();
    log(`  S04: C offline with ${pend} unsent answers, banner=${banner}, chip="${chip}"`);
    scenarioTasks.push((async () => {
      await sleep(180000);
      const hostTeamNow = host.team;
      await C.goOnline();
      const upAt = Date.now();
      const sentMs = await C.waitFor(async () => (await C.pending()) === 0, 90000);
      const teamMs = await C.waitFor(async () => (await C.team()) === host.team, 30000);
      const chipMs = await C.waitFor(async () => (await C.conn()) === 'متصل', 60000);
      await C.answer([0, 1, 2, 3, 4]); await C.submit();
      C.rejoinAtNextRound = true;
      const skipped = teams.indexOf(hostTeamNow) - teams.indexOf(teamAtLoss) - 1;
      record('S04', 'Network lost for 3 minutes while judging; host moves on meanwhile',
        pend === 3 && banner && sentMs !== null ? 'PASS' : 'FAIL',
        { unsentWhileOffline: pend, offlineBannerShown: banner, chipWhileOffline: chip,
          sentAfterReconnectMs: sentMs, onCurrentTeamAfterMs: teamMs, chipConnectedAfterMs: chipMs,
          teamsHostAdvancedDuringOutage: skipped, totalMs: Date.now() - upAt,
          note: 'teams the host passed during the outage were never shown to this judge' });
    })());
  },

  // S05 tab closed while offline with unsent answers, reopened later
  8: async ({ ipads }) => {
    const D = ipads[3];
    await D.answer([0, 1]);
    await D.goOffline();
    await sleep(1000);
    await D.answer([2, 3]);
    const pend = await D.pending();
    const idBefore = await D.judgeId();
    await D.page.close();
    await sleep(20000);
    await D.goOnline();
    const s = Date.now();
    D.page = await D.ctx.newPage();
    D.meter(D.page);
    await D.page.goto(`${BASE}/judge/${D.sid}`, { waitUntil: 'domcontentloaded' });
    const backMs = await D.waitFor(async () => (await D.page.locator('.question-block').count()) > 0, 30000);
    const askedName = await D.page.locator('#judgeName').count() > 0;
    const sentMs = await D.waitFor(async () => (await D.pending()) === 0, 60000);
    const restored = (await D.selected()).slice(0, 4).every(Boolean);
    const idAfter = await D.judgeId();
    await D.answer([4]);
    await D.submit();
    record('S05', 'Tab closed while offline with unsent answers, reopened from the link',
      pend === 2 && !askedName && sentMs !== null && restored && idBefore === idAfter ? 'PASS' : 'FAIL',
      { unsentWhenClosed: pend, reopenedOnQuestionsMs: backMs, askedForNameAgain: askedName, unsentSentAfterMs: sentMs,
        allFourAnswersShown: restored, sameJudgeRecord: idBefore === idAfter, totalMs: Date.now() - s });
  },

  // S06 iPad locked / Safari in background for 2 minutes
  10: async ({ ipads, away, scenarioTasks, host }) => {
    const E = ipads[4];
    E.busyScenario = true;
    await E.answer([0, 1, 2, 3, 4]);
    await E.submit();
    await sleep(2000);
    await E.goOffline();
    away.add('E');
    scenarioTasks.push((async () => {
      await sleep(120000);
      await E.goOnline();
      await E.wake();
      const s = Date.now();
      const teamMs = await E.waitFor(async () => (await E.team()) === host.team, 30000);
      const chipMs = await E.waitFor(async () => (await E.conn()) === 'متصل', 60000);
      await E.answer([0, 1, 2, 3, 4]); await E.submit();
      E.rejoinAtNextRound = true;
      record('S06', 'iPad locked or Safari backgrounded for 2 minutes (sockets dropped)',
        teamMs !== null && chipMs !== null ? 'PASS' : 'FAIL',
        { onCurrentTeamAfterMs: teamMs, connectedChipAfterMs: chipMs, totalMs: Date.now() - s });
    })());
  },

  // S07 reopen while the network is shaky: first request fails
  13: async ({ ipads }) => {
    const F = ipads[5];
    const fault = faultWindow(F.page, '**/rest/v1/sessions*', 3000);
    await fault.arm();
    await F.page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(4000);
    const invalidShown = await F.page.locator('h3:has-text("رابط الجلسة غير صالح")').count() > 0;
    await fault.disarm();
    await F.page.reload({ waitUntil: 'domcontentloaded' });
    const recoveredMs = await F.waitFor(async () => (await F.page.locator('.question-block').count()) > 0, 20000);
    await F.answer([0, 1, 2, 3, 4]);
    await F.submit();
    record('S07', 'Page reopened while the network is shaky (first request fails)',
      invalidShown ? 'KNOWN' : 'PASS',
      { wronglyShowedInvalidLink: invalidShown, recoveredAfterManualReloadMs: recoveredMs,
        note: 'no data at risk; the judge sees a misleading message and must reload' });
  },

  // S08 reopen while the sign-in lookup fails
  15: async ({ ipads }) => {
    const B = ipads[1];
    const idBefore = await B.judgeId();
    const fault = faultWindow(B.page, '**/rest/v1/judges*', 5000);
    await fault.arm();
    await B.page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(5000);
    const askedName = await B.page.locator('#judgeName').count() > 0;
    const identityKept = Boolean(await B.judgeId());
    await fault.disarm();
    if (askedName) await B.join();
    const idAfter = await B.judgeId();
    await B.answer([0, 1, 2, 3, 4]);
    await B.submit();
    record('S08', 'Page reopened while the automatic sign-in lookup fails',
      askedName ? 'KNOWN' : 'PASS',
      { askedForNameAgain: askedName, savedSignInErased: !identityKept, sameJudgeAfterTypingSameName: idBefore === idAfter,
        note: 'typing the exact same name reconnects to the same judge and its unsent answers; a different spelling would not' });
  },

  // S09 same judge opens a second tab
  17: async ({ ipads }) => {
    const A = ipads[0];
    const tab2 = await A.ctx.newPage();
    A.meter(tab2);
    await tab2.goto(`${BASE}/judge/${A.sid}`, { waitUntil: 'domcontentloaded' });
    const ms = await A.waitFor(async () => (await tab2.locator('.question-block').count()) > 0, 20000);
    await A.answer([0, 1, 2], A.page);
    await A.answer([2, 3, 4], tab2);
    await sleep(3000);
    const p1 = await A.pending(A.page), p2 = await A.pending(tab2);
    await tab2.close();
    await A.submit();
    record('S09', 'Same judge opens the link in a second Safari tab', ms !== null && p1 === 0 && p2 === 0 ? 'PASS' : 'FAIL',
      { secondTabReadyMs: ms, unsentTab1: p1, unsentTab2: p2, note: 'Q3 answered in both tabs; V01 checks the later tap won with no duplicate' });
  },

  // S10 setup: on the last team iPad C goes offline and answers; host then ends the session (see mainEvent)
  20: async ({ ipads, away }) => {
    const C = ipads[2], F = ipads[5];
    for (const ip of [C, F]) { ip.busyScenario = true; away.add(ip.label); await ip.goOffline(); }
    await sleep(1500);
    await Promise.all([C.answer([0, 1, 2]), F.answer([0, 1])]);
    F.pendingAtClose = await F.pending();
    await F.page.close();                       // F's tab is closed while still offline
  },
};

// ============================================================ SIDE CHECKS ==

async function sideChecks(browser, questions) {
  // S11 bare link and wrong code
  {
    const ip = new IPad(browser, 'X', 'x');
    await ip.newContext();
    const p = await ip.ctx.newPage();
    await p.goto(`${BASE}/judge`, { waitUntil: 'domcontentloaded' });
    await sleep(2500);
    const bare = await p.locator('h3:has-text("رابط الجلسة غير صالح")').count() > 0;
    await p.goto(`${BASE}/judge/zzzz9999`, { waitUntil: 'domcontentloaded' });
    await sleep(3000);
    const wrong = await p.locator('h3:has-text("رابط الجلسة غير صالح")').count() > 0;
    const nameBox = await p.locator('#judgeName').count();
    record('S11', 'Opening /judge without a link, or with a wrong code', bare && wrong && !nameBox ? 'PASS' : 'FAIL',
      { bareLinkBlocked: bare, wrongCodeBlocked: wrong, nameBoxShown: nameBox > 0 });
    await ip.ctx.close();
  }

  // S12 private browsing window closed while offline
  {
    const sid = `iq${RUN.slice(-6)}`;
    const teams = await makeSession(sid, 2, questions);
    const host = new Host(sid, teams); await host.start(); await host.goTo(0);
    const ip = new IPad(browser, 'P', 'محكم خاص');
    await ip.newContext(); await ip.open(sid); await ip.join();
    await ip.waitTeam(teams[0]);
    await ip.answer([0, 1]);
    await sleep(1500);
    await ip.goOffline();
    await ip.answer([2, 3, 4]);
    const pend = await ip.pending();
    await ip.ctx.close();                        // private window closed: storage gone
    const ip2 = new IPad(browser, 'P2', 'محكم خاص');
    await ip2.newContext(); await ip2.open(sid);
    await sleep(4000);
    const askedName = await ip2.page.locator('#judgeName').count() > 0;
    const inDb = (await dbAnswers(sid)).length;
    record('S12', 'Private browsing window closed while offline with unsent answers',
      inDb === 2 ? 'KNOWN' : 'FAIL',
      { unsentWhenClosed: pend, answersInDb: inDb, lost: 5 - inDb, askedForNameOnReopen: askedName,
        note: 'private windows erase storage when closed; never judge in private browsing' });
    await ip2.ctx.close(); await host.stop();
  }

  // S13 two iPads type the same name
  {
    const sid = `ir${RUN.slice(-6)}`;
    const teams = await makeSession(sid, 2, questions);
    const host = new Host(sid, teams); await host.start(); await host.goTo(0);
    const a = new IPad(browser, 'N1', 'أحمد'); const b = new IPad(browser, 'N2', 'أحمد');
    for (const ip of [a, b]) { await ip.newContext(); await ip.open(sid); await ip.join(); await ip.waitTeam(teams[0]); }
    await a.tap(0, 0); await sleep(1500); await b.tap(0, 4); await sleep(2000);
    const judges = (await pgc.query('select count(*)::int n from judges where session_id=$1', [sid])).rows[0].n;
    const rows = (await dbAnswers(sid)).filter((r) => r.team_id === teams[0]);
    record('S13', 'Two iPads join with the same name', judges === 1 ? 'KNOWN' : 'PASS',
      { judgeRecords: judges, rowsForQ1: rows.length, storedAnswer: rows[0]?.answer, tappedByIPad1: CHOICES[0].text, tappedByIPad2: CHOICES[4].text,
        note: 'both iPads became one judge; the second tap overwrote the first' });
    await a.ctx.close(); await b.ctx.close(); await host.stop();
  }

  // M01 Safari storage quota on this site (WebKit)
  {
    const ip = new IPad(browser, 'Q', 'q');
    await ip.newContext();
    const p = await ip.ctx.newPage();
    await p.goto(`${BASE}/judge`, { waitUntil: 'domcontentloaded' });
    const quota = await p.evaluate(() => {
      const chunk = 'x'.repeat(256 * 1024); let n = 0;
      try { for (;;) { localStorage.setItem('quota_probe_' + n, chunk); n++; if (n > 200) break; } } catch (e) { /* full */ }
      for (let i = 0; i < n; i++) localStorage.removeItem('quota_probe_' + i);
      return n * 256 * 1024;
    });
    record('M01', 'localStorage quota for the site in WebKit', 'INFO', { charactersStored: quota, approxMB: +(quota / 1048576).toFixed(1) });
    await ip.ctx.close();
  }

  // M02 cold first load (nothing cached), what an iPad downloads to open the link
  {
    const ip = new IPad(browser, 'L', 'l');
    await ip.newContext();
    const p = await ip.ctx.newPage();
    let total = 0; const byType = {};
    p.on('requestfinished', async (r) => {
      const s = await r.sizes().catch(() => null); if (!s) return;
      const b = s.responseBodySize + s.responseHeadersSize; total += b;
      const t = r.resourceType(); byType[t] = (byType[t] || 0) + b;
    });
    await p.goto(`${BASE}/judge/${createdSessions[0]}`, { waitUntil: 'networkidle' });
    await sleep(1500);
    record('M02', 'First load of the judge link on a fresh iPad', 'INFO',
      { total: bytes(total), byType: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, bytes(v)])) });
    await ip.ctx.close();
  }
}

// ================================================================== RUN ==

async function cleanup() {
  for (const sid of createdSessions) {
    await pgc.query('delete from answers where session_id=$1', [sid]);
    await pgc.query('delete from session_results where session_id=$1', [sid]);
    await pgc.query('delete from judges where session_id=$1', [sid]);
    await pgc.query('delete from sessions where session_id=$1', [sid]);
  }
  if (bankId) {
    await pgc.query('delete from questions where bank_id=$1', [bankId]);
    await pgc.query('delete from question_banks where id=$1', [bankId]);
  }
}

(async () => {
  await pgc.connect();
  const browser = await webkit.launch();
  log(`WebKit ${browser.version()} emulating ${DEVICE.userAgent.match(/\(([^)]+)\)/)[1]} | target ${BASE}`);
  let main = null;
  try {
    const questions = await makeBank();
    main = await mainEvent(browser, questions);
    await sideChecks(browser, questions);
  } catch (e) {
    record('RUN', 'Suite crashed', 'FAIL', { error: String(e?.stack || e).slice(0, 600) });
  } finally {
    const out = { run: RUN, webkit: browser.version(), device: 'iPad Pro 11', target: BASE, minutes: +((Date.now() - t0) / 60000).toFixed(1), results, metrics: main?.metrics };
    writeFileSync(`${OUT}/results.json`, JSON.stringify(out, null, 2));
    await browser.close();
    if (!KEEP) await cleanup();
    await pgc.end();
    console.log('\nSUMMARY');
    for (const r of results) console.log(`  ${r.status.padEnd(5)} ${r.id}  ${r.title}`);
    console.log(`\nmetrics: ${JSON.stringify(main?.metrics, null, 2)}`);
    console.log(`\nresults: ${OUT}/results.json${KEEP ? '' : '  (test data removed from the database)'}`);
    process.exit(0);
  }
})();
