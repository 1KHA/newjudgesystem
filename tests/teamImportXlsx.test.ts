import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSheet } from 'read-excel-file/node';
import { parseTeamRows } from '../src/lib/teamImport.ts';

test('the downloadable template parses cleanly: 12 teams in 4 tracks', async () => {
  const r = parseTeamRows(await readSheet('public/templates/teams-template.xlsx'));
  assert.deepEqual(r.errors, []);
  assert.equal(r.teams.length, 12);
  assert.deepEqual(r.tracks.map((t) => [t.name, t.count]), [['الصحة', 3], ['التعليم', 3], ['الاستدامة', 3], ['التقنية', 3]]);
});

test('a messy real-world .xlsx is parsed with precise row errors', async () => {
  const rows = await readSheet('tests/fixtures/teams-messy.xlsx');
  const r = parseTeamRows(rows);
  // Row 2 is a title, not the header -> header detection must not depend on row 1
  assert.deepEqual(r.teams.map((t) => [t.name, t.track, t.row]), [
    ['Alpha', 'Health', 4],
    ['2024', 'التعليم', 6],
    ['فريق النور', 'Health', 7],
  ]);
  assert.deepEqual(r.errors.map((e) => e.row), [8, 9]);
  assert.match(r.errors[0].message, /مكرر/);
  assert.match(r.errors[1].message, /المسار فارغ/);
});
