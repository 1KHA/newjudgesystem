/**
 * End-to-end test of team tracks on iPad (WebKit, iPad Pro 11 emulation).
 *
 * Admin uploads teams from Excel, creates a session of 4 tracks x 10 teams,
 * three judges score every team with planned scores (including a tie), the
 * host ends the session, and the top 3 per track / overall are checked
 * against the expected answer. Also: upload errors, re-upload, CSV, track
 * selection, host warnings, end-of-session drain, and request rates.
 *
 * Runs against a local build (`npm run build && npx vite preview --port 4173`)
 * using the database in .env.local. Admin pages use a one-time sign-in made
 * with the service key (no password is typed anywhere).
 *
 *   PW_DIR=<playwright install> PYTHON=<python with openpyxl> node stress/ipad-tracks.mjs
 */

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
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
const OUT = `stress/results/tracks-${RUN}`;
mkdirSync(OUT, { recursive: true });

const URL_ = process.env.VITE_SUPABASE_URL;
const sb = createClient(URL_, process.env.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const REF = new URL(URL_).hostname.split('.')[0];

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s]`, ...a);
const results = [];
const record = (id, title, ok, details) => {
  results.push({ id, title, status: ok === 'KNOWN' ? 'KNOWN' : ok ? 'PASS' : 'FAIL', details });
  log(`${(ok === 'KNOWN' ? 'KNOWN' : ok ? 'PASS' : 'FAIL').padEnd(5)} ${id} ${title} :: ${JSON.stringify(details)}`);
};
const created = { sessions: [], bankId: null };

// ------------------------------------------------------------------ plan --

const TRACKS = ['الصحة', 'التعليم', 'الاستدامة', 'التقنية'];
// Sum of the 5 answer weights (5..25) each judge gives a team, per track, in file order.
// Track 1 has a tie for 3rd place (21, 21). Overall: 25 (T1), 24 (T2), 23 (T1).
const PLAN = [
  [12, 25, 18, 21, 8, 21, 23, 5, 10, 15],
  [24, 9, 16, 20, 22, 6, 11, 14, 7, 19],
  [13, 17, 22, 8, 20, 5, 21, 10, 15, 12],
  [6, 9, 20, 19, 18, 7, 11, 14, 5, 16],
];
const CHOICES = [
  { text: 'ممتاز', weight: 5 }, { text: 'جيد جدا', weight: 4 }, { text: 'جيد', weight: 3 },
  { text: 'مقبول', weight: 2 }, { text: 'ضعيف', weight: 1 },
];
const TEAMS = TRACKS.flatMap((track, t) => PLAN[t].map((sum, k) => ({
  name: `${TAG} ${track} ${String(k + 1).padStart(2, '0')}`, track, sum,
})));
/** five answer weights (1..5) adding up to `sum` */
const weightsFor = (sum) => { const w = [1, 1, 1, 1, 1]; let left = sum - 5; for (let i = 0; i < 5 && left > 0; i++) { const add = Math.min(4, left); w[i] += add; left -= add; } return w; };
const JUDGES = 3;
const expectedTotal = (sum) => +(JUDGES * sum / 5).toFixed(2);

function expectedRanks() {
  const rank = (list) => list.map((t) => ({ ...t, rank: 1 + list.filter((o) => expectedTotal(o.sum) > expectedTotal(t.sum)).length }));
  const overall = rank(TEAMS);
  const perTrack = Object.fromEntries(TRACKS.map((tr) => [tr, rank(TEAMS.filter((t) => t.track === tr))]));
  return {
    overallTop: overall.filter((t) => t.rank <= 3).map((t) => `${t.rank}:${t.name}`).sort(),
    trackTop: Object.fromEntries(TRACKS.map((tr) => [tr, perTrack[tr].filter((t) => t.rank <= 3).map((t) => `${t.rank}:${t.name}`).sort()])),
  };
}

// ----------------------------------------------------------------- files --

function makeFiles() {
  const py = process.env.PYTHON || 'python3';
  const spec = {
    main: TEAMS.map((t) => [t.name, t.track]),
    // second upload: same teams, one moved to another track
    changed: TEAMS.map((t, i) => [t.name, i === 0 ? 'التقنية' : t.track]),
    bad: [[`${TAG} خطأ 1`, 'الصحة'], [`${TAG} خطأ 1`, 'التعليم'], [`${TAG} خطأ 2`, '']],
  };
  writeFileSync(`${OUT}/spec.json`, JSON.stringify(spec));
  execFileSync(py, ['-c', `
import json
from openpyxl import Workbook
spec = json.load(open('${OUT}/spec.json'))
for key in ('main', 'changed', 'bad'):
    wb = Workbook(); ws = wb.active; ws.title = 'الفرق'; ws.sheet_view.rightToLeft = True
    ws.append(['اسم الفريق', 'المسار'])
    for r in spec[key]: ws.append(r)
    wb.save('${OUT}/teams-' + key + '.xlsx')
`]);
  // CSV variant (UTF-8 with BOM, like Excel's "CSV UTF-8")
  const csvTeams = [[`${TAG} csv أ`, 'الصحة'], [`${TAG} csv "ب"`, 'التعليم'], [`${TAG} csv، ج`, 'التقنية']];
  writeFileSync(`${OUT}/teams.csv`, '﻿اسم الفريق,المسار\r\n' + csvTeams.map(([n, t]) => `"${n.replace(/"/g, '""')}",${t}`).join('\r\n') + '\r\n');
  return { csvTeams };
}

// ------------------------------------------------------------------ auth --

async function adminSession() {
  const admin = createClient(URL_, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email: ADMIN_EMAIL });
  if (error) throw error;
  const anon = createClient(URL_, process.env.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: v, error: ve } = await anon.auth.verifyOtp({ token_hash: data.properties.hashed_token, type: 'magiclink' });
  if (ve) throw ve;
  return v.session;
}

// ------------------------------------------------------------------ iPad --

async function newIPad(browser, { session } = {}) {
  const ctx = await browser.newContext({ ...DEVICE, locale: 'ar-SA', timezoneId: 'Asia/Riyadh', acceptDownloads: true });
  if (session) {
    await ctx.addInitScript(([key, value]) => { if (!localStorage.getItem(key)) localStorage.setItem(key, value); },
      [`sb-${REF}-auth-token`, JSON.stringify(session)]);
  }
  const page = await ctx.newPage();
  const net = { requests: 0, since: Date.now(), dialogs: [] };
  page.on('request', (r) => { if (r.url().includes('supabase.co')) net.requests++; });
  page.on('pageerror', (e) => log('  pageerror:', String(e).slice(0, 160)));
  return { ctx, page, net };
}

/** Dialog policy: accept everything, but record it; `nextDecision` can force one dismiss. */
function dialogs(page, net) {
  const state = { next: null };
  page.on('dialog', async (d) => {
    net.dialogs.push({ type: d.type(), message: d.message() });
    const decision = state.next; state.next = null;
    if (decision === 'dismiss') await d.dismiss(); else await d.accept();
  });
  return state;
}

const waitFor = async (fn, timeout = 30000, step = 200) => {
  const s = Date.now();
  while (Date.now() - s < timeout) { if (await fn().catch(() => false)) return Date.now() - s; await sleep(step); }
  return null;
};

// ================================================================== RUN ==

async function main() {
  await db.connect();
  const { csvTeams } = makeFiles();
  const expected = expectedRanks();
  writeFileSync(`${OUT}/expected.json`, JSON.stringify({ expected, teams: TEAMS }, null, 2));

  // question bank used by the session (5 questions x 5 weighted choices)
  const { data: bank } = await sb.from('question_banks').insert({ name: `${TAG} أسئلة المسارات` }).select().single();
  created.bankId = bank.id;
  const { data: qs } = await sb.from('questions').insert([1, 2, 3, 4, 5].map((i) => ({
    text: `${i}. معيار التحكيم ${i}`, choices: CHOICES, section: 'التحكيم', weight: 1, bank_id: bank.id,
  }))).select();
  qs.sort((a, b) => a.text.localeCompare(b.text));

  const browser = await webkit.launch();
  log(`WebKit ${browser.version()} as iPad Pro 11 | app ${BASE}`);
  const session = await adminSession();
  const admin = await newIPad(browser, { session });
  const dlg = dialogs(admin.page, admin.net);
  const A = admin.page;

  // ---- U01 template download ----
  await A.goto(`${BASE}/host/new`);
  await A.locator('#teamsFile').waitFor({ state: 'attached', timeout: 20000 });
  const href = await A.locator('a:has-text("تحميل النموذج")').getAttribute('href');
  const tpl = await A.evaluate(async (u) => { const r = await fetch(u); return { status: r.status, type: r.headers.get('content-type'), bytes: (await r.arrayBuffer()).byteLength }; }, href);
  const [download] = await Promise.all([A.waitForEvent('download', { timeout: 10000 }).catch(() => null), A.click('a:has-text("تحميل النموذج")')]);
  record('U01', 'Template downloads from the setup page', tpl.status === 200 && tpl.bytes > 3000,
    { ...tpl, downloadFileName: download?.suggestedFilename() ?? 'no download event' });

  // ---- U02 file with errors: nothing can be saved ----
  await A.setInputFiles('#teamsFile', `${OUT}/teams-bad.xlsx`);
  await A.locator('.upload-preview').waitFor();
  await waitFor(async () => (await A.locator('.upload-preview .alert-danger').count()) > 0, 10000);
  const errText = await A.locator('.upload-preview .alert-danger').innerText();
  const saveDisabled = await A.locator('.upload-panel button:has-text("حفظ")').isDisabled();
  const badInDb = (await db.query('select count(*)::int n from teams where name like $1', [`${TAG} خطأ%`])).rows[0].n;
  record('U02', 'File with a duplicate name and a missing track is rejected with row numbers',
    /السطر 3/.test(errText) && /السطر 4/.test(errText) && saveDisabled && badInDb === 0,
    { rowsFlagged: (errText.match(/السطر \d+/g) || []), saveDisabled, writtenToDb: badInDb });
  await A.click('.upload-preview__file .icon-btn');

  // ---- U03 CSV upload ----
  await A.setInputFiles('#teamsFile', `${OUT}/teams.csv`);
  await A.locator('.upload-panel button:has-text("حفظ 3 فريق")').waitFor({ timeout: 10000 });
  await A.click('.upload-panel button:has-text("حفظ 3 فريق")');
  await A.locator('.upload-panel .alert-success').waitFor({ timeout: 15000 });
  const csvRows = (await db.query('select name, track from teams where name = any($1) order by display_order', [csvTeams.map((t) => t[0])])).rows;
  record('U03', 'CSV (UTF-8, quotes, Arabic comma) uploads with tracks', csvRows.length === 3 && csvRows.every((r, i) => r.track === csvTeams[i][1]),
    { saved: csvRows.map((r) => `${r.name.replace(TAG, '').trim()} | ${r.track}`) });
  // U03b: same names with the Latin prefix in lower case -> must update, not add twins
  writeFileSync(`${OUT}/teams-case.csv`, '\uFEFFاسم الفريق,المسار\r\n' + csvTeams.map(([n]) => `"${n.replace(TAG, TAG.toLowerCase()).replace(/"/g, '""')}",التقنية`).join('\r\n') + '\r\n');
  await A.setInputFiles('#teamsFile', `${OUT}/teams-case.csv`);
  await A.locator('.upload-panel button:has-text("حفظ 3 فريق")').waitFor({ timeout: 10000 });
  const caseLabels = await A.locator('.upload-preview__table tbody .badge').allInnerTexts();
  await A.click('.upload-panel button:has-text("حفظ 3 فريق")');
  await A.locator('.upload-panel .alert-success').waitFor({ timeout: 15000 });
  const caseRows = (await db.query('select name, track from teams where lower(name) = any($1)', [csvTeams.map((t) => t[0].toLowerCase())])).rows;
  record('U03b', 'Same names in a different Latin letter case update the existing teams (no twins)',
    caseRows.length === 3 && caseRows.every((r) => r.track === 'التقنية' && r.name.startsWith(TAG)) && caseLabels.every((l) => l === 'تحديث'),
    { rowsLabelled: [...new Set(caseLabels)], teamsInDb: caseRows.length, keptOriginalSpelling: caseRows.every((r) => r.name.startsWith(TAG)) });
  // remove the CSV teams so each track holds exactly the 10 teams of the main file
  await db.query('delete from teams where name = any($1)', [csvTeams.map((t) => t[0])]);

  // ---- U04 main Excel upload: 40 teams, 4 tracks ----
  const reqBefore = admin.net.requests;
  await A.setInputFiles('#teamsFile', `${OUT}/teams-main.xlsx`);
  await A.locator('.upload-panel button:has-text("حفظ 40 فريق")').waitFor({ timeout: 15000 });
  const summary = await A.locator('.upload-preview__summary').innerText();
  const reqAtPreview = admin.net.requests;
  await A.click('.upload-panel button:has-text("حفظ 40 فريق")');
  await A.locator('.upload-panel .alert-success').waitFor({ timeout: 15000 });
  const saved = (await db.query('select name, track, display_order from teams where name like $1 and name not like $2 order by display_order', [`${TAG} %`, `${TAG} csv%`])).rows;
  const orderOk = saved.length === 40 && saved.every((r, i) => r.name === TEAMS[i].name && r.track === TEAMS[i].track && r.display_order === i);
  const chips = await A.locator('.track-chip').allInnerTexts();
  record('U04', 'Excel upload of 40 teams in 4 tracks: preview, single save, file order kept, all selected',
    orderOk && TRACKS.every((t) => chips.some((c) => c.includes(t) && c.includes('10/10'))),
    { preview: summary.replace(/\s+/g, ' '), requestsToParseAndPreview: reqAtPreview - reqBefore, savedRows: saved.length, fileOrderKept: orderOk,
      trackChips: chips.filter((c) => TRACKS.some((t) => c.includes(t))).map((c) => c.replace(/\s+/g, ' ')) });

  // ---- U05 re-upload with a changed track: updates, no duplicates ----
  await A.setInputFiles('#teamsFile', `${OUT}/teams-changed.xlsx`);
  await A.locator('.upload-panel button:has-text("حفظ 40 فريق")').waitFor({ timeout: 15000 });
  const labels = await A.locator('.upload-preview__table tbody .badge').allInnerTexts();
  await A.click('.upload-panel button:has-text("حفظ 40 فريق")');
  await A.locator('.upload-panel .alert-success').waitFor({ timeout: 15000 });
  const after = (await db.query('select count(*)::int n, count(distinct name)::int d from teams where name like $1 and name not like $2', [`${TAG} %`, `${TAG} csv%`])).rows[0];
  const moved = (await db.query('select track from teams where name = $1', [TEAMS[0].name])).rows[0]?.track;
  record('U05', 'Re-uploading the file updates tracks instead of duplicating teams',
    after.n === 40 && after.d === 40 && moved === 'التقنية' && labels.every((l) => l === 'تحديث'),
    { rowsLabelled: [...new Set(labels)], teamsInDb: after.n, movedTeamTrack: moved });
  // put the moved team back so the planned ranking holds
  await A.setInputFiles('#teamsFile', `${OUT}/teams-main.xlsx`);
  await A.locator('.upload-panel button:has-text("حفظ 40 فريق")').waitFor({ timeout: 15000 });
  await A.click('.upload-panel button:has-text("حفظ 40 فريق")');
  await A.locator('.upload-panel .alert-success').waitFor({ timeout: 15000 });

  // ---- U06 select by track ----
  const chip = A.locator('.track-chip', { hasText: 'التقنية' });
  await chip.click();
  const afterOff = await A.locator('.step').first().innerText();
  await chip.click();
  const afterOn = await A.locator('.step').first().innerText();
  record('U06', 'Track chip deselects and reselects a whole track', /30/.test(afterOff) && /40/.test(afterOn),
    { afterDeselect: afterOff.replace(/\s+/g, ' '), afterReselect: afterOn.replace(/\s+/g, ' ') });

  // ---- U07 create the session ----
  await A.selectOption('#bankSelect', { label: bank.name });
  await sleep(500);
  await A.selectOption('#questionSelect', qs.map((q) => q.id));
  await A.click('button:has-text("إنشاء الجلسة ورابط المحكمين")');
  await A.locator('.session-code').waitFor({ timeout: 20000 });
  const sid = (await A.locator('.session-code').innerText()).trim();
  created.sessions.push(sid);
  const st = (await db.query('select name, track, position from session_teams where session_id=$1 order by position', [sid])).rows;
  record('U07', 'Session created with 40 teams, tracks copied, judging order = file order',
    st.length === 40 && st.every((r, i) => r.name === TEAMS[i].name && r.track === TEAMS[i].track),
    { sessionId: sid, sessionTeams: st.length, tracks: [...new Set(st.map((r) => r.track))] });

  // ---- judges join on 3 iPads ----
  const judges = [];
  for (let j = 0; j < JUDGES; j++) {
    const ip = await newIPad(browser);
    dialogs(ip.page, ip.net);
    await ip.page.goto(`${BASE}/judge/${sid}`);
    await ip.page.fill('#judgeName', `${TAG} محكم ${j + 1}`);
    await ip.page.click('button:has-text("انضمام للجلسة")');
    await ip.page.locator('.judge-team-banner').waitFor({ timeout: 20000 });
    judges.push(ip);
  }
  await A.click('button:has-text("بدء جلسة التحكيم")');
  await A.locator('.team-display').waitFor({ timeout: 20000 });

  const banner = async (p) => ({
    team: (await p.locator('.judge-team-banner .team-name').innerText().catch(() => '')).trim(),
    track: (await p.locator('.judge-team-banner__track b').innerText().catch(() => '')).trim(),
  });
  const judgeTeam = async (ip, idx) => {
    const w = weightsFor(TEAMS[idx].sum);
    for (let q = 0; q < 5; q++) {
      await ip.page.locator('.question-block').nth(q).locator('.answer-btn').nth(5 - w[q]).click();
    }
    await ip.page.click('button:has-text("إرسال الإجابات النهائية")').catch(() => {});
  };
  const teamRows = async (name) => (await db.query('select count(*)::int n from answers where session_id=$1 and team_id=$2', [sid, name])).rows[0].n;

  // ---- J01..J03 judge all 40 teams; check tracks on host + iPads ----
  const trackShown = { host: 0, judges: 0, checks: 0 };
  let warnedWhenUnfinished = null;
  const reqWindow = { start: 0, judgeReq0: 0 };
  for (let i = 0; i < 40; i++) {
    const t = TEAMS[i];
    // all three iPads show the team with its track
    const shown = await waitFor(async () => {
      const b = await Promise.all(judges.map((ip) => banner(ip.page)));
      return b.every((x) => x.team === t.name);
    }, 20000, 150);
    if (shown === null) log(`  team ${i + 1}: not shown on every iPad`);
    const b = await Promise.all(judges.map((ip) => banner(ip.page)));
    const hostTrack = (await A.locator('.team-display__track b').innerText().catch(() => '')).trim();
    trackShown.checks++;
    if (hostTrack === t.track) trackShown.host++;
    if (b.every((x) => x.track === t.track)) trackShown.judges++;

    if (i === 5) {
      // J02: host tries to move on while judge 3 has not finished -> warned, can stay
      await Promise.all([judgeTeam(judges[0], i), judgeTeam(judges[1], i)]);
      await waitFor(async () => (await teamRows(t.name)) === 10, 15000);
      await sleep(1500);
      dlg.next = 'dismiss';
      await A.click('button:has-text("التالي")');
      await sleep(1500);
      const msg = admin.net.dialogs.at(-1)?.message || '';
      const stayed = (await A.locator('.team-display .team-name').innerText()).trim() === t.name;
      warnedWhenUnfinished = { warned: /لم يكمل 1 من 3/.test(msg), namesJudge: msg.includes('محكم 3'), stayedOnTeam: stayed };
      await judgeTeam(judges[2], i);
    } else if (i === 39) {
      break; // last team handled by E01
    } else {
      await Promise.all(judges.map((ip) => judgeTeam(ip, i)));
    }
    if (i === 20) { reqWindow.start = Date.now(); reqWindow.judgeReq0 = judges.reduce((s, ip) => s + ip.net.requests, 0); }
    await waitFor(async () => (await teamRows(t.name)) === 15, 20000);
    // wait for the host's progress to show everyone finished, so no warning is needed
    await waitFor(async () => (await A.locator('.badge:has-text("3/3 أكملوا")').count()) > 0, 10000);
    const before = admin.net.dialogs.length;
    await A.click('button:has-text("التالي")');
    await sleep(300);
    if (admin.net.dialogs.length > before) log(`  team ${i + 1}: unexpected host dialog: ${admin.net.dialogs.at(-1).message.slice(0, 60)}`);
  }
  const judgingMinutes = (Date.now() - reqWindow.start) / 60000;
  const judgeReq = judges.reduce((s, ip) => s + ip.net.requests, 0) - reqWindow.judgeReq0;

  record('J01', 'Team name and track shown on the host and on every judge iPad', trackShown.host === trackShown.checks && trackShown.judges === trackShown.checks,
    { teamsChecked: trackShown.checks, hostCorrect: trackShown.host, allIPadsCorrect: trackShown.judges });
  record('J02', 'Host is warned before leaving a team a judge has not finished', Boolean(warnedWhenUnfinished?.warned && warnedWhenUnfinished.stayedOnTeam),
    warnedWhenUnfinished);

  // ---- J03 idle request rate with the live connection up (adaptive polling) ----
  const idleStart = judges.reduce((s, ip) => s + ip.net.requests, 0);
  await sleep(120000);
  const idlePerMin = (judges.reduce((s, ip) => s + ip.net.requests, 0) - idleStart) / JUDGES / 2;
  record('J03', 'Requests per judge iPad while waiting, live connection up', idlePerMin <= 8,
    { requestsPerMinute: +idlePerMin.toFixed(1), beforeThisChange: '≈29 per minute (6 Oct test)', duringJudging: +(judgeReq / JUDGES / judgingMinutes).toFixed(1) });

  // ---- E01 last team: judge 3 offline, host ends, answers drain afterwards ----
  const last = TEAMS[39];
  await Promise.all([judgeTeam(judges[0], 39), judgeTeam(judges[1], 39)]);
  await judges[2].ctx.setOffline(true);
  await judgeTeam(judges[2], 39);
  await sleep(1000);
  const pendingOffline = await judges[2].page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('answerQueue_')).reduce((n, k) => n + JSON.parse(localStorage.getItem(k)).length, 0));
  await waitFor(async () => (await teamRows(last.name)) === 10, 15000);
  await sleep(1500);
  const dBefore = admin.net.dialogs.length;
  await A.click('button:has-text("إنهاء")');
  await A.waitForURL(/\/results\?session=/, { timeout: 30000 });
  const endDialogs = admin.net.dialogs.slice(dBefore).map((d) => d.message.split('\n')[0].slice(0, 60));
  await judges[2].ctx.setOffline(false);
  await judges[2].page.evaluate(() => { window.dispatchEvent(new Event('online')); window.dispatchEvent(new Event('focus')); });
  const drainedMs = await waitFor(async () => (await teamRows(last.name)) === 15, 60000, 500);
  const endedShown = await judges[2].page.locator('h3:has-text("انتهت جلسة التحكيم")').count() > 0;
  record('E01', 'Session ended while a judge iPad was offline: its answers are still delivered',
    pendingOffline === 5 && drainedMs !== null && endedShown,
    { unsentWhenEnded: pendingOffline, deliveredAfterEndMs: drainedMs, endedScreenShown: endedShown, hostDialogs: endDialogs });

  // ---- R01 final results: top 3 per track and overall ----
  await A.reload();
  await A.locator(`#session-${sid} .track-podium`).waitFor({ timeout: 20000 });
  const card = A.locator(`#session-${sid}`);
  const podiumItems = async (scope) => (await scope.locator('.podium__item').evaluateAll((els) => els.map((e) => {
    const r = e.querySelector('.rank-badge')?.textContent.trim();
    const n = e.querySelector('.podium__name')?.childNodes[0]?.textContent.trim();
    return `${r}:${n}`;
  }))).sort();
  const overallUi = await podiumItems(card.locator('.track-podium__overall'));
  const trackUi = {};
  for (const tr of TRACKS) trackUi[tr] = await podiumItems(card.locator('.track-card', { has: A.locator(`.track-card__head .track-badge:text-is("${tr}")`) }));
  const overallOk = JSON.stringify(overallUi) === JSON.stringify(expected.overallTop);
  const tracksOk = TRACKS.every((tr) => JSON.stringify(trackUi[tr]) === JSON.stringify(expected.trackTop[tr]));
  const tie = trackUi['الصحة'].filter((x) => x.startsWith('3:')).length;
  record('R01', 'Results page shows the correct top 3 overall and in every track (ties share a place)', overallOk && tracksOk && tie === 2,
    { overall: overallUi.map((x) => x.replace(`${TAG} `, '')), perTrack: Object.fromEntries(TRACKS.map((tr) => [tr, trackUi[tr].map((x) => x.replace(`${TAG} `, ''))])), tiedForThirdInHealth: tie });

  // ---- R02 database: live ranking, saved results, totals ----
  const lb = (await db.query('select * from session_leaderboard($1)', [sid])).rows;
  const totalsOk = lb.every((r) => Math.abs(Number(r.total_points) - expectedTotal(TEAMS.find((t) => t.name === r.team_id).sum)) < 0.01);
  const savedResults = (await db.query('select count(*)::int n, count(track)::int tracked, count(overall_rank)::int ranked from session_results where session_id=$1', [sid])).rows[0];
  const answers = (await db.query('select count(*)::int n, count(distinct (team_id, judge_id, question_id))::int d from answers where session_id=$1', [sid])).rows[0];
  record('R02', 'Every answer stored once; totals match the plan; results saved with track and rank',
    totalsOk && answers.n === 600 && answers.d === 600 && savedResults.n === 40 && savedResults.tracked === 40 && savedResults.ranked === 40,
    { answers: answers.n, expectedAnswers: 600, duplicates: answers.n - answers.d, totalsMatchPlan: totalsOk, savedResults });

  // ---- R03 an older session without tracks still renders ----
  const old = (await db.query("select s.session_id from sessions s where s.session_id not like 'lt%' and s.session_id not like 'ip%' and not exists (select 1 from session_teams t where t.session_id = s.session_id and t.track is not null) order by created_at desc limit 1")).rows[0]?.session_id;
  if (old) {
    await A.goto(`${BASE}/results?session=${old}`);
    const okOld = await waitFor(async () => (await A.locator(`#session-${old} .track-podium, #session-${old} .empty-state`).count()) > 0, 20000);
    const trackCols = await A.locator(`#session-${old} th:has-text("المسار")`).count();
    record('R03', 'Older sessions without tracks still show results (no track columns)', okOld !== null && trackCols === 0, { session: old, trackColumns: trackCols });
  }

  await browser.close();
  return { sid };
}

async function cleanup() {
  for (const sid of created.sessions) {
    await db.query('delete from answers where session_id=$1', [sid]);
    await db.query('delete from session_results where session_id=$1', [sid]);
    await db.query('delete from judges where session_id=$1', [sid]);
    await db.query('delete from sessions where session_id=$1', [sid]);
  }
  const t = await db.query('delete from teams where name like $1', [`${TAG} %`]);
  if (created.bankId) {
    await db.query('delete from questions where bank_id=$1', [created.bankId]);
    await db.query('delete from question_banks where id=$1', [created.bankId]);
  }
  log(`cleanup: ${created.sessions.length} session(s), ${t.rowCount} team(s) removed`);
}

main()
  .catch((e) => record('RUN', 'Suite crashed', false, { error: String(e?.stack || e).slice(0, 700) }))
  .finally(async () => {
    writeFileSync(`${OUT}/results.json`, JSON.stringify({ run: RUN, base: BASE, minutes: +((Date.now() - t0) / 60000).toFixed(1), results }, null, 2));
    if (!process.argv.includes('--keep')) await cleanup().catch((e) => log('cleanup failed', e.message));
    await db.end();
    console.log('\nSUMMARY');
    for (const r of results) console.log(`  ${r.status.padEnd(5)} ${r.id}  ${r.title}`);
    process.exit(results.some((r) => r.status === 'FAIL') ? 2 : 0);
  });
