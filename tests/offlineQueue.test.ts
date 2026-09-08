import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OfflineAnswerQueue, type KeyValueStorage } from '../src/lib/offlineQueue.ts';
import type { PendingAnswer } from '../src/types/index.ts';

function memStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, v); },
    removeItem: (k) => { data.delete(k); }
  };
}

const base = { session_id: 's1', judge_id: 'j1', points: 1 };
const ans = (team: string, q: string, answer: string) => ({ ...base, team_id: team, question_id: q, answer });

test('enqueue persists to storage and a newer answer replaces the older one', () => {
  const st = memStorage();
  const q = new OfflineAnswerQueue('k', st);
  q.enqueue(ans('t1', 'q1', 'A'));
  q.enqueue(ans('t1', 'q2', 'B'));
  q.enqueue(ans('t1', 'q1', 'C')); // judge changed their mind
  assert.equal(q.size, 2);
  assert.deepEqual(q.peek().map(p => p.answer), ['B', 'C']);
  const persisted = JSON.parse(st.data.get('k')!) as PendingAnswer[];
  assert.equal(persisted.length, 2);
});

test('queue survives a reload from storage', () => {
  const st = memStorage();
  new OfflineAnswerQueue('k', st).enqueue(ans('t1', 'q1', 'A'));
  const again = new OfflineAnswerQueue('k', st);
  assert.equal(again.size, 1);
  assert.equal(again.peek()[0].answer, 'A');
});

test('flush sends in order and removes sent items', async () => {
  const st = memStorage();
  const q = new OfflineAnswerQueue('k', st);
  q.enqueue(ans('t1', 'q1', 'A'));
  q.enqueue(ans('t1', 'q2', 'B'));
  const sent: string[] = [];
  const r = await q.flush(async (p) => { sent.push(p.answer); });
  assert.deepEqual(sent, ['A', 'B']);
  assert.deepEqual(r, { sent: 2, failed: 0, remaining: 0 });
  assert.equal(st.data.has('k'), false, 'storage key removed when empty');
});

test('flush stops at the first failure and keeps the rest queued (offline)', async () => {
  const q = new OfflineAnswerQueue('k', memStorage());
  q.enqueue(ans('t1', 'q1', 'A'));
  q.enqueue(ans('t1', 'q2', 'B'));
  let calls = 0;
  const r = await q.flush(async () => { calls++; throw new Error('network down'); });
  assert.equal(calls, 1);
  assert.deepEqual(r, { sent: 0, failed: 1, remaining: 2 });
  assert.equal(q.peek()[0].attempts, 1);
});

test('backs off after repeated failures, and a new answer resets the backoff', async () => {
  const q = new OfflineAnswerQueue('k', memStorage());
  q.enqueue(ans('t1', 'q1', 'A'));
  const fail = async () => { throw new Error('x'); };
  await q.flush(fail); await q.flush(fail); await q.flush(fail);
  // now in backoff: an immediate flush is a no-op
  const r = await q.flush(async () => {});
  assert.deepEqual(r, { sent: 0, failed: 0, remaining: 1 });
  q.enqueue(ans('t1', 'q2', 'B'));
  const r2 = await q.flush(async () => {});
  assert.equal(r2.sent, 2);
});

test('concurrent flushes do not double-send', async () => {
  const q = new OfflineAnswerQueue('k', memStorage());
  q.enqueue(ans('t1', 'q1', 'A'));
  let sends = 0;
  const slow = async () => { sends++; await new Promise(r => setTimeout(r, 20)); };
  await Promise.all([q.flush(slow), q.flush(slow), q.flush(slow)]);
  assert.equal(sends, 1);
});

test('works without storage (memory only)', async () => {
  const q = new OfflineAnswerQueue('k', null);
  q.enqueue(ans('t1', 'q1', 'A'));
  assert.equal(q.size, 1);
  await q.flush(async () => {});
  assert.equal(q.size, 0);
});
