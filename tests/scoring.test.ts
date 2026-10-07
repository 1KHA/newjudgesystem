import { test } from 'node:test';
import assert from 'node:assert/strict';
import { questionMaxPoints, sectionPoints, choiceProblems, SESSION_TOTAL_POINTS } from '../src/lib/scoring.ts';

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const sum = (m: Map<string, number>) => [...m.values()].reduce((s, v) => s + v, 0);

// Shape of the real bank: 3 sections weighted 20 / 25 / 10 with 3 / 2 / 2 questions
const bank = [
  ...[1, 2, 3].map((i) => ({ id: `idea${i}`, section: 'الفكرة والابتكار', weight: 20 })),
  ...[1, 2].map((i) => ({ id: `market${i}`, section: 'السوق والفرصة', weight: 25 })),
  ...[1, 2].map((i) => ({ id: `team${i}`, section: 'الفريق والتنفيذ', weight: 10 })),
];

test('a session is out of 100: question points add up to exactly 100', () => {
  close(sum(questionMaxPoints(bank)), SESSION_TOTAL_POINTS);
});

test('section weight is the section share, split equally between its questions', () => {
  const split = sectionPoints(bank);
  assert.deepEqual(split.map((r) => [r.section, r.questions, r.points.toFixed(2)]), [
    ['الفكرة والابتكار', 3, '36.36'],
    ['السوق والفرصة', 2, '45.45'],
    ['الفريق والتنفيذ', 2, '18.18'],
  ]);
  close(questionMaxPoints(bank).get('idea1')!, (100 * 20) / 55 / 3);
});

test('more questions in a section does not give the section more weight', () => {
  const twice = [...bank, { id: 'idea4', section: 'الفكرة والابتكار', weight: 20 }];
  assert.equal(sectionPoints(twice)[0].points.toFixed(2), '36.36');
  close(sum(questionMaxPoints(twice)), 100);
});

test('one section: equal points per question', () => {
  const m = questionMaxPoints([1, 2, 3, 4].map((i) => ({ id: `q${i}`, section: 'عام', weight: 1 })));
  for (const v of m.values()) close(v, 25);
});

test('zero weights fall back to equal points', () => {
  const m = questionMaxPoints([{ id: 'a', section: 'x', weight: 0 }, { id: 'b', section: 'y', weight: 0 }]);
  close(m.get('a')!, 50);
  close(m.get('b')!, 50);
});

test('choice rules', () => {
  const scale = [1, 2, 3, 4, 5].map((n) => ({ text: String(n), weight: n }));
  assert.deepEqual(choiceProblems(scale), []);
  assert.deepEqual(choiceProblems([{ text: 'نعم', weight: 1 }, { text: 'لا', weight: 0 }]), []);
  assert.match(choiceProblems([{ text: 'a', weight: 1 }]).join(), /خيارين/);
  assert.match(choiceProblems([{ text: 'a', weight: 2 }, { text: 'a ', weight: 1 }]).join(), /مكرر/);
  assert.match(choiceProblems([{ text: 'a', weight: 0 }, { text: 'b', weight: 0 }]).join(), /أكبر من صفر/);
  assert.match(choiceProblems([{ text: 'a', weight: 1 }, { text: 'b', weight: 1 }]).join(), /الوزن نفسه/);
  assert.match(choiceProblems([{ text: 'a', weight: -1 }, { text: 'b', weight: 1 }]).join(), /من 0 إلى 1000/);
  assert.match(choiceProblems([{ text: ' ', weight: 2 }, { text: 'b', weight: 1 }]).join(), /النص مطلوب/);
});
