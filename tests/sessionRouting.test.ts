import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSessionParam } from '../src/lib/sessionRouting.ts';

test('returns null for missing/empty params', () => {
  assert.equal(normalizeSessionParam(undefined), null);
  assert.equal(normalizeSessionParam(null), null);
  assert.equal(normalizeSessionParam(''), null);
  assert.equal(normalizeSessionParam('   '), null);
});

test('accepts generated 8-char session ids', () => {
  assert.equal(normalizeSessionParam('a1b2c3d4'), 'a1b2c3d4');
  assert.equal(normalizeSessionParam('9f3e7b2a'), '9f3e7b2a');
});

test('accepts uuids and legacy ids with dashes/underscores', () => {
  assert.equal(
    normalizeSessionParam('3f4a9c1e-1234-5678-9abc-def012345678'),
    '3f4a9c1e-1234-5678-9abc-def012345678'
  );
  assert.equal(normalizeSessionParam('session_2025'), 'session_2025');
});

test('trims surrounding whitespace', () => {
  assert.equal(normalizeSessionParam('  a1b2c3d4  '), 'a1b2c3d4');
});

test('rejects too-short ids', () => {
  assert.equal(normalizeSessionParam('abc'), null);
  assert.equal(normalizeSessionParam('ab'), null);
});

test('rejects ids with unsafe characters', () => {
  assert.equal(normalizeSessionParam('a1b2c3d4?x=1'), null);
  assert.equal(normalizeSessionParam('a1b2/c3d4'), null);
  assert.equal(normalizeSessionParam('a1b2 c3d4'), null);
  assert.equal(normalizeSessionParam('<script>'), null);
  assert.equal(normalizeSessionParam('جلسة123'), null);
});

test('rejects over-long ids', () => {
  assert.equal(normalizeSessionParam('a'.repeat(65)), null);
});
