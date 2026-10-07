/**
 * Scoring rules shared by the question and session pages.
 *
 * The database is the authority (session_question_points / answers_set_points
 * in supabase-schema.sql). These functions mirror it so the
 * admin sees the same split before saving.
 *
 *   - A session is out of SESSION_TOTAL_POINTS (100).
 *   - A section's weight is its share of the total, split equally between the
 *     section's questions.
 *   - A choice gives (its weight / the question's highest weight) of the
 *     question's points.
 *   - A team's score is, per question, the average of the judges who answered
 *     it, summed over the questions: out of 100 however many judges there are.
 */

export const SESSION_TOTAL_POINTS = 100;

export interface ScoredQuestion {
  id: string;
  section: string;
  weight: number;
}

/** Points each question is worth, keyed by question id. Mirrors session_question_points(). */
export function questionMaxPoints(questions: ScoredQuestion[], total = SESSION_TOTAL_POINTS): Map<string, number> {
  const perSection = new Map<string, number>();
  for (const q of questions) perSection.set(q.section, (perSection.get(q.section) ?? 0) + 1);
  const shares = questions.map((q) => ({ id: q.id, share: Math.max(Number(q.weight) || 0, 0) / perSection.get(q.section)! }));
  const sum = shares.reduce((s, x) => s + x.share, 0);
  return new Map(shares.map((x) => [x.id, sum > 0 ? (total * x.share) / sum : total / shares.length]));
}

/** Section totals for display, in first-appearance order. */
export function sectionPoints(questions: ScoredQuestion[], total = SESSION_TOTAL_POINTS) {
  const max = questionMaxPoints(questions, total);
  const out: { section: string; weight: number; questions: number; points: number }[] = [];
  for (const q of questions) {
    let row = out.find((r) => r.section === q.section);
    if (!row) { row = { section: q.section, weight: Number(q.weight) || 0, questions: 0, points: 0 }; out.push(row); }
    row.questions += 1;
    row.points += max.get(q.id) ?? 0;
  }
  return out;
}

export interface ChoiceInput {
  text: string;
  weight: number;
}

/**
 * Problems with one question's choices, in Arabic, empty when valid.
 * create_question_bank enforces the same rules, except the equal-weights one.
 */
export function choiceProblems(choices: ChoiceInput[]): string[] {
  const problems: string[] = [];
  if (choices.length < 2) problems.push('يحتاج خيارين على الأقل');
  const seen = new Set<string>();
  choices.forEach((c, i) => {
    const text = c.text.trim();
    if (!text) problems.push(`الخيار ${i + 1}: النص مطلوب`);
    else if (seen.has(text)) problems.push(`الخيار "${text}" مكرر`);
    seen.add(text);
    if (!Number.isFinite(c.weight) || c.weight < 0 || c.weight > 1000) problems.push(`الخيار ${i + 1}: الوزن يجب أن يكون من 0 إلى 1000`);
  });
  const weights = choices.map((c) => c.weight).filter(Number.isFinite);
  if (weights.length && Math.max(...weights) <= 0) problems.push('يجب أن يكون لخيار واحد على الأقل وزن أكبر من صفر');
  else if (choices.length > 1 && weights.length === choices.length && weights.every((w) => w === weights[0])) {
    problems.push('كل الخيارات لها الوزن نفسه، فأي إجابة ستعطي الدرجة الكاملة. اجعل وزن الخيار الأفضل أعلى');
  }
  return problems;
}
