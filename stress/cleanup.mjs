/**
 * Removes every row a load-test run wrote to production.
 *
 *   node stress/cleanup.mjs --list          list load-test artifacts
 *   node stress/cleanup.mjs LT2609081234    delete one run (also orphans)
 *   node stress/cleanup.mjs --all           delete every LT* run
 *
 * Uses a direct Postgres connection (DATABASE_URL) so bulk deletes are one
 * statement each. Only rows carrying the LT<runid> tag / lt<runid> session id
 * are touched; real sessions, judges, teams and banks are never affected.
 */

import pg from 'pg';

try { process.loadEnvFile('.env.local'); } catch { /* env may already be exported */ }

const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const q = async (s, p) => (await c.query(s, p)).rows;

const args = process.argv.slice(2);
const LIST = args.includes('--list');
const ALL = args.includes('--all');
const TAG = args.find((a) => /^LT\d{10}$/.test(a));

async function listRuns() {
  // Tagged sessions plus orphaned judges/answers whose session row is gone
  const tags = new Set();
  for (const r of await q("select name from sessions where name like 'LT%load test session%'")) tags.add(r.name.match(/^LT\d+/)[0]);
  for (const r of await q("select distinct name from judges where name like 'LT%-judge-%'")) tags.add(r.name.match(/^LT\d+/)[0]);
  for (const r of await q("select distinct session_id from answers where session_id like 'lt%'")) tags.add('LT' + '????' + r.session_id.slice(2)); // shown for visibility
  return [...tags].filter((t) => /^LT\d{10}$/.test(t)).sort();
}

const counts = async (sid, tag) => ({
  answers: (await q('select count(*)::int n from answers where session_id=$1', [sid]))[0].n,
  judges: (await q('select count(*)::int n from judges where session_id=$1 or name like $2', [sid, `${tag}-judge-%`]))[0].n,
  results: (await q('select count(*)::int n from session_results where session_id=$1', [sid]))[0].n,
  sessions: (await q('select count(*)::int n from sessions where session_id=$1', [sid]))[0].n,
  questions: (await q('select count(*)::int n from questions where bank_id in (select id from question_banks where name like $1)', [`${tag}%`]))[0].n,
});

async function purge(tag) {
  const sid = 'lt' + tag.slice(-6);
  console.log(`\nPurging ${tag} (session ${sid})`);
  console.log('  before:', await counts(sid, tag));
  await c.query('begin');
  try {
    const del = async (label, sql, p) => console.log(`  ${label}:`.padEnd(20), (await c.query(sql, p)).rowCount, 'deleted');
    await del('answers', 'delete from answers where session_id=$1', [sid]);
    await del('session_results', 'delete from session_results where session_id=$1', [sid]);
    await del('judges', 'delete from judges where session_id=$1 or name like $2', [sid, `${tag}-judge-%`]);
    await del('sessions', 'delete from sessions where session_id=$1', [sid]); // cascades session_teams / session_questions
    await del('questions', 'delete from questions where bank_id in (select id from question_banks where name like $1)', [`${tag}%`]);
    await del('question_banks', 'delete from question_banks where name like $1', [`${tag}%`]);
    await c.query('commit');
  } catch (e) {
    await c.query('rollback');
    console.error('  FAILED, rolled back:', e.message);
  }
  console.log('  after: ', await counts(sid, tag));
}

const runs = await listRuns();
if (LIST || (!TAG && !ALL)) {
  if (!runs.length) console.log('No load-test data found in production.');
  else {
    console.log(`Found ${runs.length} load-test run(s):`);
    for (const t of runs) console.log(' ', t, JSON.stringify(await counts('lt' + t.slice(-6), t)));
    console.log('\nDelete one:  node stress/cleanup.mjs <TAG>\nDelete all:  node stress/cleanup.mjs --all');
  }
} else {
  const targets = ALL ? runs : [TAG];
  for (const t of targets) await purge(t);
  console.log('\nBaseline counts now:');
  for (const t of ['sessions', 'judges', 'answers', 'questions', 'question_banks', 'session_results']) {
    console.log(' ', t.padEnd(16), (await q(`select count(*)::int n from ${t}`))[0].n);
  }
}
await c.end();
