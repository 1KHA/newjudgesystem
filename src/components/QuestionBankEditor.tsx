import { Plus, Minus, Folder, FolderPlus, Trash2, PieChart, ClipboardList } from 'lucide-react';
import { SESSION_TOTAL_POINTS, sectionPoints } from '../lib/scoring';
import { newQuestion, newSection, type DraftChoice, type DraftQuestion, type DraftSection } from '../lib/questionBank';

/**
 * Section-based question bank builder shared by the questions page and the
 * session setup page, so a bank is built the same way in both places:
 * sections with a weight, questions, and choices with a weight.
 */

interface QuestionBankEditorProps {
  sections: DraftSection[];
  onChange: (sections: DraftSection[]) => void;
  /** Lighter section blocks when the editor sits inside another card. */
  compact?: boolean;
}

export default function QuestionBankEditor({ sections, onChange, compact = false }: QuestionBankEditorProps) {
  const updateSection = (id: number, patch: (s: DraftSection) => DraftSection) =>
    onChange(sections.map((s) => (s.id === id ? patch(s) : s)));

  const updateQuestion = (id: number, qIdx: number, patch: (q: DraftQuestion) => DraftQuestion) =>
    updateSection(id, (s) => ({ ...s, questions: s.questions.map((q, i) => (i === qIdx ? patch(q) : q)) }));

  const updateChoice = (id: number, qIdx: number, cIdx: number, patch: Partial<DraftChoice>) =>
    updateQuestion(id, qIdx, (q) => ({ ...q, choices: q.choices.map((c, i) => (i === cIdx ? { ...c, ...patch } : c)) }));

  // A new choice defaults to one above the current best, so a scale stays ordered
  const addChoice = (id: number, qIdx: number) =>
    updateQuestion(id, qIdx, (q) => ({
      ...q,
      choices: [...q.choices, { text: '', weight: q.choices.length ? Math.max(...q.choices.map((c) => c.weight)) + 1 : 1 }]
    }));

  const removeChoice = (id: number, qIdx: number) =>
    updateQuestion(id, qIdx, (q) => (q.choices.length > 2 ? { ...q, choices: q.choices.slice(0, -1) } : q));

  // Same formula as the server, keyed by section id so blank names still preview
  const bySection = new Map(sectionPoints(sections.flatMap((section) =>
    section.questions.map((_, qIdx) => ({ id: `${section.id}-${qIdx}`, section: String(section.id), weight: section.weight }))
  )).map((r) => [r.section, r]));

  return (
    <>
      {sections.length === 0 ? (
        <div className={compact ? 'panel mb-4' : 'card mb-5'}>
          <div className="empty-state">
            <ClipboardList />
            <p>لا توجد أقسام بعد. اضغط على "إضافة قسم جديد" للبدء</p>
          </div>
        </div>
      ) : (
        sections.map((section) => (
          <div key={section.id} className={compact ? 'panel mb-4' : 'card mb-5'} style={{ borderInlineStart: '4px solid var(--primary)' }}>
            <div className="card-header" style={{ flexWrap: 'wrap' }}>
              <div className="flex items-center gap-3" style={{ flex: 1, minWidth: '200px' }}>
                <div className="card-icon"><Folder /></div>
                <input
                  type="text"
                  value={section.name}
                  onChange={(e) => updateSection(section.id, (s) => ({ ...s, name: e.target.value }))}
                  placeholder="اسم القسم"
                  aria-label="اسم القسم"
                  style={{ fontSize: '16px', fontWeight: 700, background: 'var(--muted)', borderColor: 'transparent' }}
                />
              </div>
              <div className="flex items-center gap-3">
                <label htmlFor={`sw-${section.id}`} style={{ margin: 0, whiteSpace: 'nowrap' }}>وزن القسم</label>
                <input
                  id={`sw-${section.id}`}
                  type="number"
                  inputMode="decimal"
                  value={section.weight}
                  onChange={(e) => updateSection(section.id, (s) => ({ ...s, weight: parseFloat(e.target.value) || 1 }))}
                  min="0.1"
                  step="0.1"
                  title="حصة القسم من الدرجة الكاملة، توزَّع بالتساوي على أسئلته"
                  style={{ width: '80px', textAlign: 'center' }}
                />
                <button
                  className="icon-btn icon-btn--danger"
                  onClick={() => onChange(sections.filter((s) => s.id !== section.id))}
                  title="حذف القسم"
                  aria-label="حذف القسم"
                >
                  <Trash2 />
                </button>
              </div>
            </div>

            {section.questions.map((question, qIdx) => (
              <div key={qIdx} className="panel panel--muted mb-4">
                <div className="flex items-center justify-between mb-3">
                  <span className="question-block__num">{qIdx + 1}</span>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => updateSection(section.id, (s) => ({ ...s, questions: s.questions.filter((_, i) => i !== qIdx) }))}
                  >
                    <Trash2 />
                    حذف السؤال
                  </button>
                </div>

                <textarea
                  value={question.text}
                  onChange={(e) => updateQuestion(section.id, qIdx, (q) => ({ ...q, text: e.target.value }))}
                  placeholder="اكتب نص السؤال هنا..."
                  aria-label={`نص السؤال ${qIdx + 1}`}
                  style={{ minHeight: '80px', marginBottom: '12px' }}
                />

                {question.choices.map((choice, cIdx) => (
                  <div key={cIdx} className="field-row mb-2">
                    <span className="choice-chip__bullet" />
                    <input
                      type="text"
                      value={choice.text}
                      onChange={(e) => updateChoice(section.id, qIdx, cIdx, { text: e.target.value })}
                      placeholder={`خيار ${cIdx + 1}`}
                    />
                    <label htmlFor={`cw-${section.id}-${qIdx}-${cIdx}`} style={{ margin: 0, whiteSpace: 'nowrap' }}>الوزن</label>
                    <input
                      id={`cw-${section.id}-${qIdx}-${cIdx}`}
                      type="number"
                      inputMode="decimal"
                      value={choice.weight}
                      onChange={(e) => updateChoice(section.id, qIdx, cIdx, { weight: parseFloat(e.target.value) || 0 })}
                      min="0"
                      max="1000"
                      step="0.1"
                      title="الخيار الأعلى وزناً يعطي درجة السؤال كاملة"
                      style={{ width: '80px', textAlign: 'center', flex: 'none' }}
                    />
                  </div>
                ))}

                <div className="flex gap-2 mt-3" style={{ paddingTop: '12px', borderTop: '1px solid var(--border)' }}>
                  <button className="btn btn-secondary btn-sm" onClick={() => addChoice(section.id, qIdx)}>
                    <Plus />
                    إضافة خيار
                  </button>
                  {question.choices.length > 2 && (
                    <button className="btn btn-secondary btn-sm" onClick={() => removeChoice(section.id, qIdx)}>
                      <Minus />
                      إزالة آخر خيار
                    </button>
                  )}
                </div>
              </div>
            ))}

            <button
              className="btn btn-outline btn-sm btn-pill"
              onClick={() => updateSection(section.id, (s) => ({ ...s, questions: [...s.questions, newQuestion()] }))}
            >
              <Plus />
              إضافة سؤال
            </button>
          </div>
        ))
      )}

      <button className="btn btn-secondary btn-block mb-5" onClick={() => onChange([...sections, newSection(sections.length)])}>
        <FolderPlus />
        إضافة قسم جديد
      </button>

      {sections.length > 0 && (
        <div className={compact ? 'panel mb-4' : 'card mb-5'}>
          <div className="card-header">
            <div className="card-title">
              <div className="card-icon"><PieChart /></div>
              <span>توزيع النقاط</span>
            </div>
          </div>
          <div className="table-wrap">
            <table className="leaderboard-table">
              <thead>
                <tr>
                  <th>القسم</th>
                  <th className="num">الوزن</th>
                  <th className="num">عدد الأسئلة</th>
                  <th className="num">إجمالي النقاط</th>
                  <th className="num">النقاط لكل سؤال</th>
                </tr>
              </thead>
              <tbody>
                {sections.map((section) => {
                  const row = bySection.get(String(section.id));
                  return (
                    <tr key={section.id}>
                      <td>{section.name}</td>
                      <td className="num">{section.weight}</td>
                      <td className="num">{section.questions.length}</td>
                      <td className="num fw-600 text-primary">{(row?.points ?? 0).toFixed(2)}</td>
                      <td className="num">{row ? (row.points / row.questions).toFixed(2) : '0.00'}</td>
                    </tr>
                  );
                })}
                <tr style={{ background: 'var(--primary-tint)', fontWeight: 700 }}>
                  <td colSpan={3}>المجموع</td>
                  <td className="num text-primary">{SESSION_TOTAL_POINTS}</td>
                  <td className="num">—</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
