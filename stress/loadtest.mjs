/**
 * Production load / soak test (v2 schema) for the مياهثون judging platform.
 *
 * Mirrors the shipped client code paths:
 *   Host  = src/pages/ControlPage.tsx   (realtime channels + watchdog, team switch =
 *           DB update + broadcast, debounced bounded refresh, RPC leaderboard)
 *   Judge = src/pages/JudgePage.tsx     (broadcast + sessions UPDATE + 4s poll,
 *           offline answer queue with upsert replay, presence ping)
 *
 * Also injects the failures a real event has: judges going offline mid-round,
 * judges closing laptops during breaks, and verifies data integrity at the
 * end against Postgres directly.
 *
 * Everything written is tagged with a run id so cleanup.mjs can remove it.
 *
 *   node stress/loadtest.mjs --judges 50 --teams 200 --hours 12
 *   node stress/loadtest.mjs --smoke
 */

import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import { writeFileSync, mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

try { process.loadEnvFile('.env.local'); } catch { /* env may already be exported */ }

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !ANON_KEY) { console.error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY'); process.exit(1); }

// ---------------------------------------------------------------- config ----

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const SMOKE = Boolean(arg('smoke', false));

const CFG = {
  judges: Number(arg('judges', SMOKE ? 8 : 50)),
  teams: Number(arg('teams', SMOKE ? 6 : 200)),
  questionsPerTeam: Number(arg('questions', 5)),
  hours: Number(arg('hours', SMOKE ? 0.12 : 12)),
  breaks: SMOKE ? [[0.34, 0.6], [0.67, 1.0]] : [[0.34, 30], [0.67, 50]],
  sleepFraction: 0.4,        // judges that fully disconnect during a break
  offlineFraction: 0.12,     // judges that lose network for part of a round
  offlineMs: SMOKE ? [3000, 8000] : [15000, 60000],
  changeFraction: 0.15,      // answers changed after first pick (upsert path)
  socketKillFraction: 0.08,  // judges whose realtime socket is cut mid-round (poll must carry them)
  reloadFraction: 0.06,      // judges who reload the page mid-round (rejoin + resume)
  hostSocketKillEvery: SMOKE ? 3 : 25, // rounds between forced host socket drops
  answerDelayMs: SMOKE ? 120 : 900,
  smoke: SMOKE,
};

const RUN_ID = new Date().toISOString().replace(/[-:T.]/g, '').slice(2, 12);
const TAG = `LT${RUN_ID}`;
const SESSION_ID = `lt${RUN_ID.slice(-6)}`;
const OUT_DIR = `stress/results/${TAG}`;
mkdirSync(OUT_DIR, { recursive: true });

// --------------------------------------------------------------- metrics ----

const M = {
  startedAt: Date.now(), config: CFG, runId: RUN_ID, sessionId: SESSION_ID,
  rounds: [], errors: [], channelEvents: [], reconnects: [], breaks: [], notes: [],
  answerLatency: [], rpcLatency: { progress: [], leaderboard: [] },
  deliveryLatency: { broadcast: [], dbEvent: [], poll: [] }, deliveryFirstPath: { broadcast: 0, dbEvent: 0, poll: 0 },
  pollStats: { ok: 0, fail: 0, totalMs: 0 },
  answersWritten: 0, answersFailed: 0, answersQueuedOffline: 0, answersReplayed: 0,
  hostAnswerEvents: 0, hostRefreshes: 0, integrity: null,
  scenarios: { socketKills: 0, socketRecoveredMs: [], reloads: 0, reloadResumed: 0, hostSocketKills: 0, hostRecoveredMs: [] },
};
const errKey = new Map();
function recordError(where, e) {
  const code = e?.code || e?.status || e?.name || 'unknown';
  const message = String(e?.message || e).slice(0, 300);
  M.errors.push({ t: Date.now(), where, code, message });
  const k = `${where}|${code}|${message}`;
  errKey.set(k, (errKey.get(k) || 0) + 1);
  if (M.errors.length > 5000) M.errors.splice(0, 2000);
}
const pct = (arr, p) => arr.length ? Math.round([...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))]) : null;
const cap = (arr, n = 50000) => { if (arr.length > n) arr.splice(0, n / 2); };
const log = (...a) => console.log(`[${((Date.now() - M.startedAt) / 60000).toFixed(1).padStart(6)}m]`, ...a);

function makeClient() {
  return createClient(SUPABASE_URL, ANON_KEY, {
    realtime: { params: { eventsPerSecond: 10 } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ------------------------------------------------ minimal RealtimeManager ---
// Same algorithm as src/lib/realtimeManager.ts (ping + channel state watchdog).

class Channels {
  constructor(sb, who, specs, ping, onResync) {
    this.sb = sb; this.who = who; this.specs = specs; this.ping = ping; this.onResync = onResync;
    this.channels = new Map(); this.running = false; this.checking = false; this.lastHeard = Date.now();
  }
  start() {
    this.running = true;
    for (const s of this.specs) this.build(s);
    this.timer = setInterval(() => this.check('watchdog'), 15000);
  }
  stop() {
    this.running = false; clearInterval(this.timer);
    for (const ch of this.channels.values()) this.destroy(ch);
    this.channels.clear();
  }
  async destroy(ch) {
    try { await Promise.race([this.sb.removeChannel(ch), sleep(3000)]); } catch { /* socket gone */ }
    try { ch.teardown(); } catch { /* already */ }
    this.sb.realtime.channels = this.sb.realtime.channels.filter((c) => c !== ch);
  }
  build(spec) {
    const ch = spec.configure(this.sb.channel(spec.name));
    ch.subscribe((status) => {
      M.channelEvents.push({ t: Date.now(), who: this.who, channel: spec.name, status }); cap(M.channelEvents, 20000);
      if (status === 'SUBSCRIBED') this.lastHeard = Date.now();
      if (this.running && (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT')) recordError(`${this.who}:channel`, { code: status, message: spec.name });
    });
    this.channels.set(spec.name, ch);
  }
  heard() { this.lastHeard = Date.now(); }
  joined(name) { const ch = this.channels.get(name); return ch && ch.state === 'joined'; }
  async broadcast(name, event, payload) {
    const ch = this.channels.get(name);
    if (!ch || ch.state !== 'joined') return false;
    return (await ch.send({ type: 'broadcast', event, payload })) === 'ok';
  }
  async reconnectAll(reason) {
    if (!this.running) return;
    M.reconnects.push({ t: Date.now(), who: this.who, reason });
    for (const ch of this.channels.values()) await this.destroy(ch);
    this.channels.clear();
    this.sb.realtime.connect();
    for (const s of this.specs) this.build(s);
    this.lastHeard = Date.now();
    this.onResync?.(reason);
  }
  async check(reason) {
    if (!this.running || this.checking) return;
    this.checking = true;
    try {
      try { await this.ping(); this.lastHeard = Date.now(); } catch (e) { recordError(`${this.who}:ping`, e); return; }
      const broken = [...this.channels.entries()].filter(([, ch]) => ch.state === 'errored' || ch.state === 'closed');
      if (!this.sb.realtime.isConnected() || Date.now() - this.lastHeard > 60000) { await this.reconnectAll(`socket/stale (${reason})`); return; }
      if (broken.length) {
        M.reconnects.push({ t: Date.now(), who: this.who, reason: `rebuild ${broken.length} (${reason})` });
        for (const [name, ch] of broken) { await this.destroy(ch); this.channels.delete(name); this.build(this.specs.find((s) => s.name === name)); }
        this.onResync?.(reason);
      }
    } finally { this.checking = false; }
  }
}

// ================================================================== HOST ====

class Host {
  constructor() {
    this.sb = makeClient(); this.round = 0; this.refreshTimer = null; this.team = null;
  }
  start() {
    this.ch = new Channels(this.sb, 'host', [
      { name: `session-${SESSION_ID}`, configure: (c) => c.on('broadcast', { event: 'team-change' }, () => this.ch.heard()) },
      { name: `judges-${SESSION_ID}`, configure: (c) => c.on('postgres_changes', { event: '*', schema: 'public', table: 'judges', filter: `session_id=eq.${SESSION_ID}` }, () => { this.ch.heard(); }) },
      { name: `answers-${SESSION_ID}`, configure: (c) => c.on('postgres_changes', { event: '*', schema: 'public', table: 'answers', filter: `session_id=eq.${SESSION_ID}` }, () => { this.ch.heard(); M.hostAnswerEvents++; this.scheduleRefresh(); }) },
    ], async () => { const { error } = await this.sb.from('sessions').select('session_id').eq('session_id', SESSION_ID).single(); if (error) throw error; },
       () => this.refresh());
    this.ch.start();
    this.lbTimer = setInterval(() => this.leaderboard(), 30000);
  }
  stop() { clearInterval(this.lbTimer); clearTimeout(this.refreshTimer); this.ch.stop(); }
  scheduleRefresh() { clearTimeout(this.refreshTimer); this.refreshTimer = setTimeout(() => this.refresh(), 400); }
  async refresh() {
    M.hostRefreshes++;
    await Promise.all([this.progress(), this.leaderboard()]);
  }
  async progress() {
    if (!this.team) return;
    const t0 = Date.now();
    const { data, error } = await this.sb.rpc('session_team_progress', { p_session_id: SESSION_ID, p_team: this.team });
    if (error) { recordError('host:progress', error); return null; }
    M.rpcLatency.progress.push(Date.now() - t0); cap(M.rpcLatency.progress);
    return data;
  }
  async leaderboard() {
    const t0 = Date.now();
    const { data, error } = await this.sb.rpc('session_leaderboard', { p_session_id: SESSION_ID });
    if (error) { recordError('host:leaderboard', error); return null; }
    M.rpcLatency.leaderboard.push(Date.now() - t0); cap(M.rpcLatency.leaderboard);
    return data;
  }
  async killSocket() {
    M.scenarios.hostSocketKills++;
    const t0 = Date.now();
    this.sb.realtime.disconnect();
    const iv = setInterval(() => {
      if (this.ch.joined(`answers-${SESSION_ID}`) && this.ch.joined(`session-${SESSION_ID}`)) { M.scenarios.hostRecoveredMs.push(Date.now() - t0); clearInterval(iv); }
      else if (Date.now() - t0 > 120000) { recordError('host:socketNeverRecovered', new Error('host')); clearInterval(iv); }
    }, 1000);
  }
  async goToTeam(index, team) {
    this.team = team;
    const { error } = await this.sb.from('sessions').update({ current_team_index: index, current_team_id: team, updated_at: new Date().toISOString() }).eq('session_id', SESSION_ID);
    if (error) { recordError('host:setCurrentTeam', error); return { sentAt: Date.now(), broadcastOk: false }; }
    const sentAt = Date.now();
    const ok = await this.ch.broadcast(`session-${SESSION_ID}`, 'team-change', { currentTeam: team, status: 'active', sentAt }).catch(() => false);
    return { sentAt, broadcastOk: ok };
  }
  async finish() {
    const t0 = Date.now();
    const { data, error } = await this.sb.rpc('finish_session', { p_session_id: SESSION_ID });
    if (error) { recordError('host:finish', error); return null; }
    await this.ch.broadcast(`session-${SESSION_ID}`, 'team-change', { currentTeam: this.team, status: 'completed', sentAt: Date.now() }).catch(() => false);
    M.notes.push(`finish_session wrote ${data} team results in ${Date.now() - t0}ms`);
    return data;
  }
}

// ================================================================= JUDGE ====

class Judge {
  constructor(n) {
    this.n = n; this.name = `${TAG}-judge-${String(n).padStart(2, '0')}`;
    this.sb = makeClient(); this.id = null; this.token = crypto.randomUUID();
    this.team = null; this.questions = []; this.queue = []; this.offline = false; this.busy = false;
    this.connected = false; this.seen = new Map(); // team -> {at, path}
    this.roundSent = null; this.answered = new Map(); // team -> Set(questionId)
    this.abort = false;
  }
  async join() {
    try {
      const { data: ex } = await this.sb.from('judges').select('*').eq('name', this.name).eq('session_id', SESSION_ID).maybeSingle();
      if (ex) { const { data } = await this.sb.from('judges').update({ judge_token: this.token, last_seen_at: new Date().toISOString() }).eq('id', ex.id).select().single(); this.id = data.id; }
      else { const { data, error } = await this.sb.from('judges').insert({ name: this.name, judge_token: this.token, session_id: SESSION_ID, last_seen_at: new Date().toISOString() }).select().single(); if (error) throw error; this.id = data.id; }
      return true;
    } catch (e) { recordError('judge:join', e); return false; }
  }
  async loadQuestions() {
    const { data, error } = await this.sb.from('session_questions').select('position, questions(*)').eq('session_id', SESSION_ID).order('position');
    if (error) throw error;
    this.questions = data.map((r) => r.questions).filter(Boolean);
  }
  subscribe() {
    const poll = async () => {
      const t0 = Date.now();
      const { data, error } = await this.sb.from('sessions').select('current_team_id, status').eq('session_id', SESSION_ID).maybeSingle();
      M.pollStats.totalMs += Date.now() - t0;
      if (error || !data) { M.pollStats.fail++; throw error || new Error('missing'); }
      M.pollStats.ok++;
      this.apply(data.current_team_id, data.status, 'poll');
    };
    this.ch = new Channels(this.sb, `judge${this.n}`, [
      { name: `session-${SESSION_ID}`, configure: (c) => c.on('broadcast', { event: 'team-change' }, (m) => { this.ch.heard(); const p = m.payload || {}; this.apply(p.currentTeam, p.status || 'active', 'broadcast', p.sentAt); }) },
      { name: `session-row-${SESSION_ID}`, configure: (c) => c.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'sessions', filter: `session_id=eq.${SESSION_ID}` }, (p) => { this.ch.heard(); this.apply(p.new.current_team_id, p.new.status, 'dbEvent'); }) },
    ], poll, () => { poll().catch(() => {}); this.flush(); });
    this.ch.start();
    this.pollTimer = setInterval(() => poll().catch(() => {}), 4000);
    this.queueTimer = setInterval(() => this.flush(), 8000);
    this.presenceTimer = setInterval(() => this.sb.from('judges').update({ last_seen_at: new Date().toISOString() }).eq('id', this.id).then(() => {}), 60000);
    this.connected = true;
  }
  disconnect() {
    clearInterval(this.pollTimer); clearInterval(this.queueTimer); clearInterval(this.presenceTimer);
    this.ch?.stop(); this.connected = false;
  }
  async rejoin() {
    try {
      const { data, error } = await this.sb.from('judges').select('id').eq('name', this.name).eq('judge_token', this.token).single();
      if (error) throw error;
      this.id = data.id;
      M.reconnects.push({ t: Date.now(), who: `judge${this.n}`, reason: 'rejoin-after-break' });
    } catch (e) { recordError('judge:rejoin', e); }
    this.subscribe();
    await this.flush();
  }
  apply(team, status, path, sentAt) {
    if (status === 'completed') { this.ended = true; return; }
    if (!team || team === this.team) return;
    this.team = team;
    const now = Date.now();
    if (!this.seen.has(team)) {
      this.seen.set(team, { at: now, path });
      M.deliveryFirstPath[path]++;
      if (this.roundSent) M.deliveryLatency[path].push(now - this.roundSent);
    }
    this.answerAll().catch((e) => recordError('judge:answerAll', e));
  }
  points(q, text) {
    const w = (c) => (typeof c === 'string' ? 1 : c.weight);
    const max = Math.max(1, ...q.choices.map(w));
    const chosen = q.choices.find((c) => (typeof c === 'string' ? c : c.text) === text);
    return Number(((chosen ? w(chosen) : 0) / max * (q.weight || 1)).toFixed(2));
  }
  /** Cut the websocket without telling the client (like a NAT/wifi drop). The watchdog must notice. */
  async killSocket() {
    M.scenarios.socketKills++;
    const t0 = Date.now();
    this.sb.realtime.disconnect();
    const iv = setInterval(() => {
      if (this.ch?.joined(`session-${SESSION_ID}`)) { M.scenarios.socketRecoveredMs.push(Date.now() - t0); clearInterval(iv); }
      else if (Date.now() - t0 > 120000) { recordError('judge:socketNeverRecovered', new Error(`judge${this.n}`)); clearInterval(iv); }
    }, 1000);
  }
  /** Reload the page mid-round: channels torn down, state rebuilt from server + local queue, answering resumes. */
  async reload() {
    M.scenarios.reloads++;
    this.abort = true;
    this.disconnect();
    await sleep(2000 + Math.random() * 3000);
    await this.rejoin();
    this.abort = false;
    if (this.team && !(this.doneTeam === this.team)) { M.scenarios.reloadResumed++; this.answerAll().catch((e) => recordError('judge:resume', e)); }
  }
  enqueue(q, text) {
    const team = this.team;
    if (!this.answered.has(team)) this.answered.set(team, new Set());
    this.answered.get(team).add(q.id);
    const key = `${team}|${q.id}`;
    this.queue = this.queue.filter((i) => i.key !== key);
    this.queue.push({ key, session_id: SESSION_ID, team_id: team, judge_id: this.id, question_id: q.id, answer: text, points: this.points(q, text), attempts: 0 });
  }
  async flush() {
    if (this.flushing || this.offline || !this.queue.length) return;
    this.flushing = true;
    try {
      while (this.queue.length) {
        const it = this.queue[0];
        const t0 = Date.now();
        const row = { session_id: it.session_id, team_id: it.team_id, judge_id: it.judge_id, question_id: it.question_id, answer: it.answer, points: it.points, updated_at: new Date().toISOString() };
        const { error } = await this.sb.from('answers').upsert(row, { onConflict: 'session_id,team_id,judge_id,question_id' }).select('id').single();
        if (error) { it.attempts++; M.answersFailed++; recordError('judge:upsertAnswer', error); break; }
        M.answerLatency.push(Date.now() - t0); cap(M.answerLatency);
        M.answersWritten++;
        if (it.queuedOffline) M.answersReplayed++;
        this.queue.shift();
      }
    } finally { this.flushing = false; }
  }
  async answerAll() {
    if (this.busy) return;
    this.busy = true;
    const team = this.team;
    try {
      // Some judges lose their network for part of this round
      if (Math.random() < CFG.offlineFraction) {
        this.offline = true;
        const [lo, hi] = CFG.offlineMs;
        setTimeout(() => { this.offline = false; this.flush(); }, lo + Math.random() * (hi - lo));
      }
      const already = this.answered.get(team) || new Set();
      for (const q of this.questions) {
        if (this.ended || this.team !== team || this.abort) break;
        if (already.has(q.id)) continue; // resumed after a reload: keep what was answered
        await sleep(CFG.answerDelayMs * (0.5 + Math.random()));
        const pick = q.choices[Math.floor(Math.random() * q.choices.length)];
        let text = typeof pick === 'string' ? pick : pick.text;
        this.enqueue(q, text);
        if (this.offline) { this.queue[this.queue.length - 1].queuedOffline = true; M.answersQueuedOffline++; }
        await this.flush();
        if (Math.random() < CFG.changeFraction) {
          await sleep(300);
          const alt = q.choices[Math.floor(Math.random() * q.choices.length)];
          const altText = typeof alt === 'string' ? alt : alt.text;
          if (altText !== text) { this.enqueue(q, altText); if (this.offline) { this.queue[this.queue.length - 1].queuedOffline = true; M.answersQueuedOffline++; } await this.flush(); }
        }
      }
      if (!this.abort && this.team === team) this.doneTeam = team;
    } finally { this.busy = false; }
  }
}

// ================================================================= SETUP ====

async function setup(admin) {
  log(`Creating question bank + ${CFG.questionsPerTeam} questions...`);
  const { data: bank, error: be } = await admin.from('question_banks').insert({ name: `${TAG} load test bank` }).select().single();
  if (be) throw be;
  const { data: questions, error: qe } = await admin.from('questions').insert(Array.from({ length: CFG.questionsPerTeam }, (_, i) => ({
    text: `${TAG} سؤال التحكيم رقم ${i + 1}`,
    choices: [{ text: 'ممتاز', weight: 5 }, { text: 'جيد جدا', weight: 4 }, { text: 'جيد', weight: 3 }, { text: 'مقبول', weight: 2 }, { text: 'ضعيف', weight: 1 }],
    section: `${TAG} عام`, weight: 1, bank_id: bank.id,
  }))).select();
  if (qe) throw qe;
  const teams = Array.from({ length: CFG.teams }, (_, i) => `${TAG}-team-${String(i + 1).padStart(3, '0')}`);
  const { error: se } = await admin.from('sessions').insert({
    name: `${TAG} load test session`, session_id: SESSION_ID, host_token: crypto.randomUUID(), host_id: null,
    status: 'active', current_team_index: 0, current_team_id: null, total_points: 100,
  });
  if (se) throw se;
  const { error: te } = await admin.from('session_teams').insert(teams.map((name, position) => ({ session_id: SESSION_ID, name, position })));
  if (te) throw te;
  const { error: sqe } = await admin.from('session_questions').insert(questions.map((q, position) => ({ session_id: SESSION_ID, question_id: q.id, position })));
  if (sqe) throw sqe;
  log(`Session ${SESSION_ID}: ${teams.length} teams, ${questions.length} questions (session_teams / session_questions rows)`);
  return { questions, teams };
}

// ============================================================ INTEGRITY =====

async function integrityCheck(expected) {
  const out = { ok: true, checks: [] };
  const add = (name, pass, detail) => { out.checks.push({ name, pass, detail }); if (!pass) out.ok = false; };
  try {
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await c.connect();
    const q = async (s, p) => (await c.query(s, p)).rows;
    const [{ n: rows }] = await q('select count(*)::int n from answers where session_id=$1', [SESSION_ID]);
    const [{ n: distinct }] = await q('select count(*)::int n from (select distinct session_id,team_id,judge_id,question_id from answers where session_id=$1) d', [SESSION_ID]);
    add('no duplicate answers', rows === distinct, `${rows} rows, ${distinct} distinct keys`);
    add('every judge answered every question for every team', rows === expected, `${rows} rows, expected ${expected}`);
    const lb = await q('select * from session_leaderboard($1)', [SESSION_ID]);
    const direct = await q('select team_id, sum(points)::numeric(10,2) s from answers where session_id=$1 group by 1', [SESSION_ID]);
    const dm = new Map(direct.map((r) => [r.team_id, Number(r.s)]));
    const mismatch = lb.filter((r) => Math.abs(Number(r.total_points) - (dm.get(r.team_id) || 0)) > 0.005);
    add('leaderboard equals direct SQL sum for every team', mismatch.length === 0, `${lb.length} teams, ${mismatch.length} mismatches`);
    const [{ n: results }] = await q('select count(*)::int n from session_results where session_id=$1', [SESSION_ID]);
    add('session_results has one row per team', results === CFG.teams, `${results}/${CFG.teams}`);
    const [{ status }] = await q('select status from sessions where session_id=$1', [SESSION_ID]);
    add('session marked completed', status === 'completed', status);
    const [{ n: judges }] = await q('select count(*)::int n from judges where session_id=$1', [SESSION_ID]);
    add('one judge row per judge', judges === CFG.judges, `${judges}/${CFG.judges}`);
    await c.end();
  } catch (e) { add('integrity check ran', false, String(e.message || e)); }
  return out;
}

// ================================================================ REPORT ====

function snapshot(state) {
  const top = [...errKey.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, n]) => ({ count: n, key: k }));
  const lat = (a) => ({ samples: a.length, p50: pct(a, 0.5), p95: pct(a, 0.95), p99: pct(a, 0.99), max: a.length ? Math.max(...a) : null });
  return {
    state, runId: RUN_ID, sessionId: SESSION_ID, config: CFG,
    elapsedMin: Number(((Date.now() - M.startedAt) / 60000).toFixed(1)),
    roundsCompleted: M.rounds.length, roundsPlanned: CFG.teams,
    answers: { written: M.answersWritten, failed: M.answersFailed, queuedOffline: M.answersQueuedOffline, replayedAfterOffline: M.answersReplayed },
    answerLatencyMs: lat(M.answerLatency),
    teamChangeDelivery: {
      firstPath: M.deliveryFirstPath,
      broadcastMs: lat(M.deliveryLatency.broadcast), dbEventMs: lat(M.deliveryLatency.dbEvent), pollMs: lat(M.deliveryLatency.poll),
      roundsWithMissingJudges: M.rounds.filter((r) => r.delivered < r.connected).length,
    },
    host: { answerEvents: M.hostAnswerEvents, refreshes: M.hostRefreshes, progressRpcMs: lat(M.rpcLatency.progress), leaderboardRpcMs: lat(M.rpcLatency.leaderboard) },
    pollStats: { ...M.pollStats, avgMs: (M.pollStats.ok + M.pollStats.fail) ? Math.round(M.pollStats.totalMs / (M.pollStats.ok + M.pollStats.fail)) : null },
    reconnects: { total: M.reconnects.length, host: M.reconnects.filter((r) => r.who === 'host').length, judgesAfterBreak: M.reconnects.filter((r) => r.reason === 'rejoin-after-break').length },
    channelErrors: M.channelEvents.filter((c) => ['CHANNEL_ERROR', 'TIMED_OUT'].includes(c.status)).length,
    scenarios: {
      judgeSocketKills: M.scenarios.socketKills, judgeSocketRecoveredMs: lat(M.scenarios.socketRecoveredMs),
      judgeReloads: M.scenarios.reloads, judgeReloadsResumed: M.scenarios.reloadResumed,
      hostSocketKills: M.scenarios.hostSocketKills, hostSocketRecoveredMs: lat(M.scenarios.hostRecoveredMs),
    },
    breaks: M.breaks, errorsTotal: M.errors.length, topErrors: top, integrity: M.integrity, notes: M.notes,
    rssMB: Math.round(process.memoryUsage().rss / 1e6),
    lastRounds: M.rounds.slice(-5),
  };
}
function writeReport(state) {
  const snap = snapshot(state);
  writeFileSync(`${OUT_DIR}/report.json`, JSON.stringify(snap, null, 2));
  writeFileSync(`${OUT_DIR}/raw.json`, JSON.stringify({ rounds: M.rounds, errors: M.errors.slice(-1500), reconnects: M.reconnects, channelEvents: M.channelEvents.slice(-3000) }, null, 1));
  return snap;
}

// ================================================================== MAIN ====

async function main() {
  console.log('='.repeat(78));
  console.log(`LOAD TEST v2 ${TAG}  |  session=${SESSION_ID}`);
  console.log(`judges=${CFG.judges} teams=${CFG.teams} q/team=${CFG.questionsPerTeam} hours=${CFG.hours}  target=${SUPABASE_URL} (PRODUCTION)`);
  console.log('='.repeat(78));

  const admin = makeClient();
  const { questions, teams } = await setup(admin);

  const host = new Host();
  host.start();

  log(`Spawning ${CFG.judges} judges...`);
  const judges = [];
  for (let i = 1; i <= CFG.judges; i++) {
    const j = new Judge(i);
    if (await j.join()) { await j.loadQuestions(); j.subscribe(); judges.push(j); }
    await sleep(100);
  }
  await sleep(3000);
  log(`${judges.length}/${CFG.judges} judges joined; ${judges.filter((j) => j.ch.joined(`session-${SESSION_ID}`)).length} on broadcast channel`);

  const totalMs = CFG.hours * 3600_000;
  const breakMs = CFG.breaks.reduce((s, [, m]) => s + m * 60_000, 0);
  const roundBudget = Math.max(60_000, totalMs - breakMs) / CFG.teams;
  log(`Round budget: ${(roundBudget / 1000).toFixed(0)}s per team`);

  const breaksLeft = [...CFG.breaks];
  const reportTimer = setInterval(() => {
    const s = writeReport('running');
    log(`round ${s.roundsCompleted}/${CFG.teams} answers=${s.answers.written} (offline-replayed ${s.answers.replayedAfterOffline}) errs=${s.errorsTotal} reconnects=${s.reconnects.total} rss=${s.rssMB}MB lbRpc p95=${s.host.leaderboardRpcMs.p95}ms`);
  }, 60_000);

  for (let i = 0; i < teams.length; i++) {
    const team = teams[i];
    host.round = i + 1;
    const roundStart = Date.now();
    for (const j of judges) j.roundSent = roundStart;
    const before = M.answersWritten;

    const { broadcastOk } = await host.goToTeam(i, team);
    host.scheduleRefresh();

    // ---- failure injection for this round ----
    for (const j of judges) {
      if (!j.connected) continue;
      if (Math.random() < CFG.socketKillFraction) setTimeout(() => j.killSocket(), 500 + Math.random() * 4000);
      else if (Math.random() < CFG.reloadFraction) setTimeout(() => j.reload().catch((e) => recordError('judge:reload', e)), 1500 + Math.random() * 4000);
    }
    if ((i + 1) % CFG.hostSocketKillEvery === 0) setTimeout(() => host.killSocket(), 3000);

    const deadline = roundStart + roundBudget;
    while (Date.now() < deadline) {
      const done = judges.filter((j) => !j.connected || (j.doneTeam === team && !j.busy && j.queue.length === 0)).length;
      if (done >= judges.length) break;
      await sleep(1000);
    }
    const connected = judges.filter((j) => j.connected).length;
    const delivered = judges.filter((j) => j.seen.has(team)).length;
    M.rounds.push({ round: i + 1, team, delivered, connected, broadcastOk, answers: M.answersWritten - before, ms: Date.now() - roundStart });
    if (delivered < connected) log(`round ${i + 1}: team change reached ${delivered}/${connected} connected judges`);

    const left = roundStart + roundBudget - Date.now();
    if (left > 0) await sleep(left);

    const progress = (i + 1) / teams.length;
    if (breaksLeft.length && progress >= breaksLeft[0][0]) {
      const [, minutes] = breaksLeft.shift();
      log(`BREAK ${minutes} min after round ${i + 1}`);
      const sleepers = judges.filter(() => Math.random() < CFG.sleepFraction);
      sleepers.forEach((j) => j.disconnect());
      log(`  ${sleepers.length} judges closed laptops, ${judges.length - sleepers.length} stay idle-connected`);
      const bStart = Date.now();
      await sleep(minutes * 60_000);
      log('  break over, judges rejoining...');
      for (const j of sleepers) { await j.rejoin(); await sleep(80); }
      await host.ch.check('wake-after-break');
      await sleep(3000);
      const onBroadcast = judges.filter((j) => j.ch.joined(`session-${SESSION_ID}`)).length;
      M.breaks.push({ afterRound: i + 1, minutes, disconnected: sleepers.length, connectedAfter: judges.filter((j) => j.connected).length, onBroadcastAfter: onBroadcast, of: judges.length, durationMs: Date.now() - bStart });
      log(`  resumed: ${onBroadcast}/${judges.length} judges joined on broadcast channel`);
    }
  }

  log('All rounds complete: finishing session...');
  for (const j of judges) await j.flush();
  await host.finish();
  await sleep(2000);

  M.integrity = await integrityCheck(judges.length * CFG.teams * CFG.questionsPerTeam);
  clearInterval(reportTimer);
  host.stop();
  judges.forEach((j) => j.disconnect());

  const final = writeReport('finished');
  console.log('\n' + '='.repeat(78) + '\nFINAL REPORT\n' + JSON.stringify(final, null, 2) + '\n' + '='.repeat(78));
  console.log(`Full data: ${OUT_DIR}/report.json + raw.json\nCleanup:   node stress/cleanup.mjs ${TAG}`);
  process.exit(final.integrity?.ok && final.answers.failed === 0 ? 0 : 2);
}

process.on('SIGINT', () => { M.notes.push('interrupted'); const s = writeReport('interrupted'); console.log('\nInterrupted:\n' + JSON.stringify(s, null, 2)); process.exit(130); });
process.on('unhandledRejection', (e) => recordError('unhandledRejection', e));
process.on('uncaughtException', (e) => recordError('uncaughtException', e));
main().catch((e) => { recordError('main', e); writeReport('crashed'); console.error('FATAL', e); process.exit(1); });
