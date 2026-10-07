import { choiceProblems } from './scoring.ts';
import type { NewBankQuestion } from './supabaseService';
import type { Question } from '../types';

/**
 * Question bank helpers shared by the questions page and the session setup
 * page: the draft a bank is built from (sections with a weight, questions,
 * choices with a weight) and the section grouping used to show saved questions.
 */

// ---------------------------------------------------------------- drafts --

export interface DraftChoice {
  text: string;
  weight: number;
}

export interface DraftQuestion {
  text: string;
  choices: DraftChoice[];
}

export interface DraftSection {
  id: number;
  name: string;
  weight: number;
  questions: DraftQuestion[];
}

let idCounter = 0;

// Different default weights: equal weights would give every answer full marks
export const newQuestion = (): DraftQuestion => ({
  text: '',
  choices: [{ text: '', weight: 1 }, { text: '', weight: 0 }]
});

/** A fresh section; `index` is its 0-based position (used for the default name). */
export const newSection = (index: number): DraftSection => ({
  id: Date.now() + idCounter++,
  name: `القسم ${index + 1}`,
  weight: 1,
  questions: [newQuestion()]
});

/** Problems with the draft, in Arabic, empty when it can be saved (the server checks again). */
export function draftProblems(sections: DraftSection[]): string[] {
  const problems: string[] = [];
  if (!sections.some((section) => section.questions.length > 0)) problems.push('أضف سؤالاً واحداً على الأقل');
  const names = new Set<string>();
  sections.forEach((section, sIdx) => {
    const name = section.name.trim();
    if (!name) problems.push(`القسم ${sIdx + 1}: اسم القسم مطلوب`);
    // Sections are matched by name when scoring, so two sections with one name would merge
    else if (names.has(name)) problems.push(`القسم ${sIdx + 1}: اسم القسم "${name}" مكرر`);
    names.add(name);
    if (!(section.weight > 0)) problems.push(`القسم ${sIdx + 1}: الوزن يجب أن يكون أكبر من صفر`);
    section.questions.forEach((question, qIdx) => {
      const where = `القسم ${sIdx + 1}، السؤال ${qIdx + 1}`;
      if (!question.text.trim()) problems.push(`${where}: نص السؤال مطلوب`);
      choiceProblems(question.choices).forEach((p) => problems.push(`${where}: ${p}`));
    });
  });
  return problems;
}

/** The draft in the shape create_question_bank expects. */
export const draftToBankQuestions = (sections: DraftSection[]): NewBankQuestion[] =>
  sections.flatMap((section) => section.questions.map((question) => ({
    text: question.text.trim(),
    section: section.name.trim(),
    weight: section.weight,
    choices: question.choices.map((c) => ({ text: c.text.trim(), weight: c.weight }))
  })));

// ------------------------------------------------------------ grouping --

export interface QuestionSectionGroup {
  section: string;
  questions: Question[];
}

/** Questions grouped by section, sections in first-appearance order. */
export function groupBySection(questions: Question[]): QuestionSectionGroup[] {
  const groups: QuestionSectionGroup[] = [];
  for (const q of questions) {
    let group = groups.find((g) => g.section === q.section);
    if (!group) { group = { section: q.section, questions: [] }; groups.push(group); }
    group.questions.push(q);
  }
  return groups;
}

/** The order the list shows questions in (section by section). */
export const orderBySection = (questions: Question[]): Question[] =>
  groupBySection(questions).flatMap((g) => g.questions);
