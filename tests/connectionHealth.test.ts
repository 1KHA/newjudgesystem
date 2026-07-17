import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  healthStore,
  STALE_THRESHOLD_MS,
  WAKE_THRESHOLD_MS,
  HEALTH_CHECK_INTERVAL_MS
} from '../src/lib/connectionHealth.ts';

test('constants are sane', () => {
  assert.equal(STALE_THRESHOLD_MS, 60_000);
  assert.equal(WAKE_THRESHOLD_MS, 30_000);
  assert.equal(HEALTH_CHECK_INTERVAL_MS, 30_000);
});

test('startSession binds session and resets pool', () => {
  healthStore.startSession('abc123', 1000);
  const s = healthStore.getState();
  assert.equal(s.sessionId, 'abc123');
  assert.equal(s.sessionStartedAt, 1000);
  assert.equal(s.status, 'reconnecting');
  assert.equal(s.lastHeartbeatAt, 1000);
  assert.equal(s.reconnectCount, 0);
  assert.deepEqual(s.channels, []);
});

test('channel pool: register → subscribe → events', () => {
  healthStore.startSession('abc123', 1000);

  healthStore.registerChannel('judges-abc123');
  let channel = healthStore.getState().channels.find(c => c.name === 'judges-abc123');
  assert.ok(channel);
  assert.equal(channel.status, 'joining');
  assert.equal(channel.subscribedAt, null);

  healthStore.updateChannelStatus('judges-abc123', 'SUBSCRIBED', 2000);
  channel = healthStore.getState().channels.find(c => c.name === 'judges-abc123');
  assert.equal(channel?.status, 'SUBSCRIBED');
  assert.equal(channel?.subscribedAt, 2000);

  healthStore.noteChannelEvent('judges-abc123', 3000);
  healthStore.noteChannelEvent('judges-abc123', 4000);
  channel = healthStore.getState().channels.find(c => c.name === 'judges-abc123');
  assert.equal(channel?.eventCount, 2);
  assert.equal(channel?.lastEventAt, 4000);
  // Channel events also act as heartbeat
  assert.equal(healthStore.getState().lastHeartbeatAt, 4000);
});

test('re-registering a channel replaces it instead of duplicating (no pool leak)', () => {
  healthStore.startSession('abc123', 1000);
  healthStore.registerChannel('judges-abc123');
  healthStore.registerChannel('judges-abc123');
  healthStore.registerChannel('judges-abc123');
  const matches = healthStore.getState().channels.filter(c => c.name === 'judges-abc123');
  assert.equal(matches.length, 1);
});

test('removeChannel deletes from pool', () => {
  healthStore.startSession('abc123', 1000);
  healthStore.registerChannel('a');
  healthStore.registerChannel('b');
  healthStore.removeChannel('a');
  const names = healthStore.getState().channels.map(c => c.name);
  assert.deepEqual(names, ['b']);
});

test('heartbeat staleness detection', () => {
  healthStore.startSession('abc123', 10_000);
  assert.equal(healthStore.isStale(STALE_THRESHOLD_MS, 10_000), false);
  assert.equal(healthStore.isStale(STALE_THRESHOLD_MS, 10_000 + 59_999), false);
  assert.equal(healthStore.isStale(STALE_THRESHOLD_MS, 10_000 + 60_001), true);
  // Wake threshold is tighter
  assert.equal(healthStore.isStale(WAKE_THRESHOLD_MS, 10_000 + 31_000), true);
  // A heartbeat refreshes staleness
  healthStore.heartbeat(80_000);
  assert.equal(healthStore.isStale(STALE_THRESHOLD_MS, 80_001), false);
});

test('status transitions only fire on change', () => {
  healthStore.startSession('abc123', 1000);
  healthStore.setStatus('connected');
  assert.equal(healthStore.getState().status, 'connected');
  healthStore.setStatus('connected'); // no-op, should not throw or duplicate
  assert.equal(healthStore.getState().status, 'connected');
  healthStore.setStatus('disconnected');
  assert.equal(healthStore.getState().status, 'disconnected');
});

test('noteReconnect counts attempts', () => {
  healthStore.startSession('abc123', 1000);
  healthStore.noteReconnect();
  healthStore.noteReconnect();
  assert.equal(healthStore.getState().reconnectCount, 2);
});

test('endSession resets everything', () => {
  healthStore.startSession('abc123', 1000);
  healthStore.registerChannel('x');
  healthStore.noteReconnect();
  healthStore.endSession();
  const s = healthStore.getState();
  assert.equal(s.sessionId, '');
  assert.equal(s.status, 'disconnected');
  assert.equal(s.lastHeartbeatAt, null);
  assert.equal(s.reconnectCount, 0);
  assert.deepEqual(s.channels, []);
});

test('event log is capped at 50 entries', () => {
  healthStore.endSession();
  for (let i = 0; i < 80; i++) {
    healthStore.logEvent(`event ${i}`);
  }
  const log = healthStore.getState().log;
  assert.equal(log.length, 50);
  // Newest first
  assert.equal(log[0].message, 'event 79');
});

test('subscribe notifies listeners and unsubscribe stops them', () => {
  let calls = 0;
  const unsubscribe = healthStore.subscribe(() => calls++);
  healthStore.logEvent('ping');
  assert.ok(calls >= 1);
  const before = calls;
  unsubscribe();
  healthStore.logEvent('pong');
  assert.equal(calls, before);
});
