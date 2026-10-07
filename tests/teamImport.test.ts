import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTeamRows, parseCsv, cleanCell, trackOrder, TEAM_IMPORT_LIMITS } from '../src/lib/teamImport.ts';

test('reads Arabic headers and keeps file order', () => {
  const r = parseTeamRows([
    ['اسم الفريق', 'المسار'],
    ['فريق النور', 'الصحة'],
    ['فريق الأمل', 'التعليم'],
    ['فريق الغد', 'الصحة'],
  ]);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.teams.map((t) => [t.name, t.track, t.row]), [
    ['فريق النور', 'الصحة', 2], ['فريق الأمل', 'التعليم', 3], ['فريق الغد', 'الصحة', 4],
  ]);
  assert.deepEqual(r.tracks, [{ name: 'الصحة', count: 2 }, { name: 'التعليم', count: 1 }]);
});

test('reads English headers in any column order, ignoring extra columns', () => {
  const r = parseTeamRows([
    ['#', 'Track', 'Notes', 'Team Name'],
    [1, 'Health', 'x', 'Alpha'],
    [2, 'Energy', '', 'Beta'],
  ]);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.teams.map((t) => [t.name, t.track]), [['Alpha', 'Health'], ['Beta', 'Energy']]);
});

test('header with a colon or star still matches', () => {
  const r = parseTeamRows([['اسم الفريق:', '* المسار'], ['أ', 'ب']]);
  assert.equal(r.teams.length, 1);
});

test('no header row: column A is the name, column B the track, with a warning', () => {
  const r = parseTeamRows([['Alpha', 'Health'], ['Beta', 'Energy']]);
  assert.equal(r.teams.length, 2);
  assert.equal(r.teams[0].row, 1);
  assert.equal(r.warnings.length, 1);
});

test('missing track column is a clear error', () => {
  const r = parseTeamRows([['اسم الفريق', 'ملاحظات'], ['أ', 'x']]);
  assert.equal(r.teams.length, 0);
  assert.match(r.errors[0].message, /المسار/);
});

test('empty cells are reported with the row number users see', () => {
  const r = parseTeamRows([
    ['اسم الفريق', 'المسار'],
    ['فريق 1', 'الصحة'],
    ['', 'الصحة'],
    ['فريق 3', ''],
  ]);
  assert.equal(r.teams.length, 1);
  assert.deepEqual(r.errors.map((e) => e.row), [3, 4]);
});

test('blank rows are skipped, numbers become text', () => {
  const r = parseTeamRows([
    [null, null],
    ['اسم الفريق', 'المسار'],
    [null, ''],
    [101, 'مسار 1'],
    ['  ', null],
    [102.5, 'مسار 1'],
  ]);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.teams.map((t) => [t.name, t.row]), [['101', 4], ['102.5', 6]]);
});

test('duplicate names are rejected even with different spacing or Latin case', () => {
  const r = parseTeamRows([
    ['Team', 'Track'],
    ['Alpha  Team', 'A'],
    ['alpha team', 'B'],
    ['فريق  النور', 'A'],
    ['فريق النور', 'A'],
  ]);
  assert.equal(r.teams.length, 2);
  assert.equal(r.errors.length, 2);
  assert.match(r.errors[0].message, /السطر 2/);
});

test('invisible bidi marks and extra spaces are removed', () => {
  assert.equal(cleanCell('‏ فريق​   النور ﻿'), 'فريق النور');
  const r = parseTeamRows([['اسم الفريق', 'المسار'], ['‫فريق 1‬', '‏الصحة ']]);
  assert.deepEqual([r.teams[0].name, r.teams[0].track], ['فريق 1', 'الصحة']);
});

test('the same track typed differently becomes one track (first spelling wins)', () => {
  const r = parseTeamRows([['team', 'track'], ['a', 'Health'], ['b', 'health '], ['c', 'HEALTH']]);
  assert.deepEqual(r.tracks, [{ name: 'Health', count: 3 }]);
  assert.ok(r.teams.every((t) => t.track === 'Health'));
});

test('length limits', () => {
  const long = 'ف'.repeat(TEAM_IMPORT_LIMITS.maxNameLength + 1);
  const r = parseTeamRows([['اسم الفريق', 'المسار'], [long, 'أ'], ['ب', 'م'.repeat(TEAM_IMPORT_LIMITS.maxTrackLength + 1)]]);
  assert.equal(r.teams.length, 0);
  assert.equal(r.errors.length, 2);
});

test('too many teams is an error', () => {
  const rows: unknown[][] = [['team', 'track']];
  for (let i = 0; i <= TEAM_IMPORT_LIMITS.maxTeams; i++) rows.push([`t${i}`, 'A']);
  const r = parseTeamRows(rows);
  assert.ok(r.errors.some((e) => e.row === null && /الحد المسموح/.test(e.message)));
});

test('empty file and header-only file', () => {
  assert.match(parseTeamRows([]).errors[0].message, /فارغ/);
  assert.match(parseTeamRows([['اسم الفريق', 'المسار']]).errors[0].message, /لا توجد فرق/);
});

test('CSV: BOM, quotes, commas inside quotes, CRLF', () => {
  const rows = parseCsv('﻿اسم الفريق,المسار\r\n"فريق ""النور""",الصحة\r\n"فريق، الأمل",التعليم\r\n');
  assert.deepEqual(rows, [['اسم الفريق', 'المسار'], ['فريق "النور"', 'الصحة'], ['فريق، الأمل', 'التعليم']]);
});

test('CSV: semicolon and tab delimiters are detected', () => {
  assert.deepEqual(parseCsv('team;track\nA;B'), [['team', 'track'], ['A', 'B']]);
  assert.deepEqual(parseCsv('team\ttrack\nA\tB\n'), [['team', 'track'], ['A', 'B']]);
});

test('trackOrder keeps first-appearance order', () => {
  assert.deepEqual(trackOrder([{ track: 'B' }, { track: 'A' }, { track: 'B' }, { track: null }]), ['B', 'A', '']);
});
