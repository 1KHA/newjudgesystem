import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newSection, draftProblems, draftToBankQuestions, groupBySection, orderBySection, type DraftSection
} from '../src/lib/questionBank.ts';
import type { Question } from '../src/types/index.ts';

const section = (name: string, weight: number, questions: DraftSection['questions']): DraftSection =>
  ({ ...newSection(0), name, weight, questions });

const good = (text: string) => ({ text, choices: [{ text: 'ممتاز', weight: 2 }, { text: 'ضعيف', weight: 0 }] });

test('a valid draft has no problems and keeps section weights per question', () => {
  const draft = [section(' الفكرة ', 20, [good('س1'), good('س2')]), section('الفريق', 10, [good('س3')])];
  assert.deepEqual(draftProblems(draft), []);
  const out = draftToBankQuestions(draft);
  assert.deepEqual(out.map((q) => [q.text, q.section, q.weight]), [['س1', 'الفكرة', 20], ['س2', 'الفكرة', 20], ['س3', 'الفريق', 10]]);
  assert.deepEqual(out[0].choices, [{ text: 'ممتاز', weight: 2 }, { text: 'ضعيف', weight: 0 }]);
});

test('duplicate section names are rejected (scoring groups sections by name)', () => {
  const problems = draftProblems([section('الفكرة', 20, [good('س1')]), section(' الفكرة', 10, [good('س2')])]);
  assert.ok(problems.some((p) => p.includes('مكرر')), problems.join(' | '));
});

test('missing names, zero weight, empty question and bad choices are reported', () => {
  const problems = draftProblems([
    section('', 0, [{ text: '', choices: [{ text: 'أ', weight: 1 }, { text: 'ب', weight: 1 }] }])
  ]);
  assert.ok(problems.some((p) => p.includes('اسم القسم مطلوب')));
  assert.ok(problems.some((p) => p.includes('أكبر من صفر')));
  assert.ok(problems.some((p) => p.includes('نص السؤال مطلوب')));
  assert.ok(problems.some((p) => p.includes('الوزن نفسه')));
});

test('a draft without any question is rejected', () => {
  assert.ok(draftProblems([section('الفكرة', 20, [])]).includes('أضف سؤالاً واحداً على الأقل'));
});

test('saved questions are grouped by section in first-appearance order', () => {
  const q = (id: string, sectionName: string): Question => ({ id, text: id, section: sectionName, weight: 1, choices: [] });
  const list = [q('a', 'س'), q('b', 'ص'), q('c', 'س'), q('d', 'ع'), q('e', 'ص')];
  assert.deepEqual(groupBySection(list).map((g) => [g.section, g.questions.map((x) => x.id)]), [['س', ['a', 'c']], ['ص', ['b', 'e']], ['ع', ['d']]]);
  assert.deepEqual(orderBySection(list).map((x) => x.id), ['a', 'c', 'b', 'e', 'd']);
});
