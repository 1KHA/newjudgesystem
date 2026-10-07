import { Folder } from 'lucide-react';
import type { Question } from '../types';
import { groupBySection } from '../lib/questionBank';

/**
 * Read-only view of saved questions, grouped by section, shared by the
 * questions page and the session setup page: section weight, every choice
 * and its weight. With `onToggle` each card gets a checkbox for picking the
 * questions of a session.
 */

interface QuestionListProps {
  questions: Question[];
  /** Selection mode: ids of the picked questions. */
  selectedIds?: readonly string[];
  onToggle?: (questionId: string) => void;
  /** Points each picked question is worth in the session. */
  points?: ReadonlyMap<string, number>;
}

export default function QuestionList({ questions, selectedIds, onToggle, points }: QuestionListProps) {
  const selectable = onToggle != null;
  let number = 0;

  return (
    <>
      {groupBySection(questions).map((group) => {
        const weights = [...new Set(group.questions.map((q) => q.weight))];
        return (
          <div key={group.section} className="question-section">
            <div className="question-section__head">
              <div className="card-icon"><Folder /></div>
              <span className="question-section__name">{group.section}</span>
              <span className="badge badge-primary">وزن القسم: {weights.join('، ')}</span>
              <span className="text-xs text-secondary">
                {group.questions.length} {group.questions.length === 1 ? 'سؤال' : 'أسئلة'}
              </span>
            </div>

            {group.questions.map((question) => {
              number += 1;
              const selected = selectedIds?.includes(question.id) ?? false;
              const qPoints = selected ? points?.get(question.id) : undefined;
              const className = `question-block${selectable ? ' question-block--selectable' : ''}${selected ? ' question-block--selected' : ''}`;
              return (
                <div key={question.id} className={className} onClick={selectable ? () => onToggle(question.id) : undefined}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      {selectable && (
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => onToggle(question.id)}
                          onClick={(e) => e.stopPropagation()}
                          aria-label={`اختيار السؤال ${number}`}
                        />
                      )}
                      <span className="question-block__num">{number}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {qPoints != null && <span className="badge badge-success">{qPoints.toFixed(2)} درجة</span>}
                      <span className="badge badge-neutral">{question.section}</span>
                    </div>
                  </div>
                  <div className="question-block__text">{question.text}</div>

                  <div className="choice-grid">
                    {question.choices.map((choice) => (
                      <div key={choice.id} className="choice-chip">
                        <div className="flex items-center gap-2">
                          <span className="choice-chip__bullet" />
                          <span>{choice.text}</span>
                        </div>
                        <span className="badge badge-primary">وزن: {choice.weight}</span>
                      </div>
                    ))}
                  </div>

                  <div className="text-xs text-secondary mt-3" style={{ paddingTop: '12px', borderTop: '1px solid var(--border)' }}>
                    <strong>القسم:</strong> {question.section} <span style={{ margin: '0 6px' }}>|</span> <strong>وزن القسم:</strong> {question.weight}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
    </>
  );
}
