import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { getQuestions } from '../lib/supabaseService';
import type { Question } from '../types';
import {
  ArrowRight, Plus, Minus, Library, ClipboardList, Folder, FolderPlus, Trash2, PieChart, Save
} from 'lucide-react';
import BrandHeader from '../components/BrandHeader';

interface Choice {
  text: string;
  weight: number;
}

interface QuestionData {
  text: string;
  choices: Choice[];
}

interface Section {
  id: number;
  name: string;
  weight: number;
  questions: QuestionData[];
}

export default function QuestionsPage() {
  const navigate = useNavigate();
  const [existingQuestions, setExistingQuestions] = useState<Question[]>([]);
  const [bankName, setBankName] = useState('');
  const [totalPoints, setTotalPoints] = useState(100);
  const [sections, setSections] = useState<Section[]>([]);
  const [loading, setLoading] = useState(true);
  const [showExisting, setShowExisting] = useState(true);

  useEffect(() => {
    loadData();
    // Initialize with one section
    addSection();
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      const questionsData = await getQuestions();
      setExistingQuestions(questionsData);
    } catch (error) {
      console.error('Error loading data:', error);
      alert('خطأ في تحميل البيانات');
    } finally {
      setLoading(false);
    }
  };

  const addSection = () => {
    const sectionId = Date.now();
    const section: Section = {
      id: sectionId,
      name: `القسم ${sections.length + 1}`,
      weight: 1,
      questions: []
    };
    setSections([...sections, section]);
  };

  const removeSection = (sectionId: number) => {
    setSections(sections.filter(s => s.id !== sectionId));
  };

  const updateSectionName = (sectionId: number, name: string) => {
    setSections(sections.map(s => s.id === sectionId ? { ...s, name } : s));
  };

  const updateSectionWeight = (sectionId: number, weight: number) => {
    setSections(sections.map(s => s.id === sectionId ? { ...s, weight } : s));
  };

  const addQuestion = (sectionId: number) => {
    setSections(sections.map(s => {
      if (s.id === sectionId) {
        return {
          ...s,
          questions: [...s.questions, {
            text: '',
            choices: [
              { text: '', weight: 1 },
              { text: '', weight: 1 }
            ]
          }]
        };
      }
      return s;
    }));
  };

  const removeQuestion = (sectionId: number, questionIndex: number) => {
    setSections(sections.map(s => {
      if (s.id === sectionId) {
        const newQuestions = [...s.questions];
        newQuestions.splice(questionIndex, 1);
        return { ...s, questions: newQuestions };
      }
      return s;
    }));
  };

  const updateQuestionText = (sectionId: number, questionIndex: number, text: string) => {
    setSections(sections.map(s => {
      if (s.id === sectionId) {
        const newQuestions = [...s.questions];
        newQuestions[questionIndex] = { ...newQuestions[questionIndex], text };
        return { ...s, questions: newQuestions };
      }
      return s;
    }));
  };

  const updateChoice = (sectionId: number, questionIndex: number, choiceIndex: number, text: string) => {
    setSections(sections.map(s => {
      if (s.id === sectionId) {
        const newQuestions = [...s.questions];
        const newChoices = [...newQuestions[questionIndex].choices];
        newChoices[choiceIndex] = { ...newChoices[choiceIndex], text };
        newQuestions[questionIndex] = { ...newQuestions[questionIndex], choices: newChoices };
        return { ...s, questions: newQuestions };
      }
      return s;
    }));
  };

  const updateChoiceWeight = (sectionId: number, questionIndex: number, choiceIndex: number, weight: number) => {
    setSections(sections.map(s => {
      if (s.id === sectionId) {
        const newQuestions = [...s.questions];
        const newChoices = [...newQuestions[questionIndex].choices];
        newChoices[choiceIndex] = { ...newChoices[choiceIndex], weight };
        newQuestions[questionIndex] = { ...newQuestions[questionIndex], choices: newChoices };
        return { ...s, questions: newQuestions };
      }
      return s;
    }));
  };

  const addChoice = (sectionId: number, questionIndex: number) => {
    setSections(sections.map(s => {
      if (s.id === sectionId) {
        const newQuestions = [...s.questions];
        newQuestions[questionIndex].choices.push({ text: '', weight: 1 });
        return { ...s, questions: newQuestions };
      }
      return s;
    }));
  };

  const removeChoice = (sectionId: number, questionIndex: number) => {
    setSections(sections.map(s => {
      if (s.id === sectionId) {
        const newQuestions = [...s.questions];
        if (newQuestions[questionIndex].choices.length > 1) {
          newQuestions[questionIndex].choices.pop();
        }
        return { ...s, questions: newQuestions };
      }
      return s;
    }));
  };

  const calculatePointsDistribution = () => {
    const totalWeight = sections.reduce((sum, section) => sum + section.weight, 0);
    return sections.map(section => {
      const sectionPoints = (section.weight / totalWeight) * totalPoints;
      const pointsPerQuestion = section.questions.length > 0 
        ? sectionPoints / section.questions.length 
        : 0;
      
      return {
        name: section.name,
        weight: section.weight,
        questionCount: section.questions.length,
        totalPoints: sectionPoints.toFixed(2),
        pointsPerQuestion: pointsPerQuestion.toFixed(2)
      };
    });
  };

  const saveQuestions = async () => {
    if (sections.length === 0) {
      alert('يرجى إضافة قسم واحد على الأقل مع الأسئلة');
      return;
    }

    if (!bankName.trim()) {
      alert('يرجى إدخال اسم بنك الأسئلة');
      return;
    }

    // Validate questions
    let hasInvalid = false;
    let errorMsg = '';

    sections.forEach((section, sIdx) => {
      section.questions.forEach((question, qIdx) => {
        if (!question.text || !question.text.trim()) {
          hasInvalid = true;
          errorMsg += `القسم ${sIdx + 1}، السؤال ${qIdx + 1}: نص السؤال مفقود.\n`;
          return;
        }
        if (!Array.isArray(question.choices) || question.choices.length < 1) {
          hasInvalid = true;
          errorMsg += `القسم ${sIdx + 1}، السؤال ${qIdx + 1}: يجب أن يحتوي على خيار واحد على الأقل.\n`;
          return;
        }
        question.choices.forEach((choice, cIdx) => {
          if (!choice.text || choice.text.trim() === '') {
            hasInvalid = true;
            errorMsg += `القسم ${sIdx + 1}، السؤال ${qIdx + 1}، الخيار ${cIdx + 1}: نص الخيار مفقود.\n`;
          }
        });
      });
    });

    if (hasInvalid) {
      alert(errorMsg);
      return;
    }

    try {
      // Create question bank
      const { data: bank, error: bankError } = await supabase
        .from('question_banks')
        .insert({ name: bankName })
        .select()
        .single();

      if (bankError) throw bankError;

      // Prepare questions for insertion with choice weights
      const questionsToInsert: Array<{
        text: string;
        choices: Array<{text: string; weight: number}>;
        section: string;
        weight: number;
        bank_id: string;
      }> = [];
      sections.forEach(section => {
        section.questions.forEach(question => {
          questionsToInsert.push({
            text: question.text,
            choices: question.choices.map(c => ({
              text: c.text,
              weight: c.weight
            })),
            section: section.name,
            weight: section.weight,
            bank_id: bank.id
          });
        });
      });

      // Insert questions
      const { error: questionsError } = await supabase
        .from('questions')
        .insert(questionsToInsert);

      if (questionsError) throw questionsError;

      alert(`تم حفظ ${questionsToInsert.length} سؤال في البنك بنجاح`);
      
      // Reset form
      setSections([]);
      setBankName('');
      addSection();
      loadData();
    } catch (error) {
      console.error('Error saving questions:', error);
      alert('خطأ في حفظ الأسئلة');
    }
  };

  const pointsDistribution = calculatePointsDistribution();

  return (
    <div className="app-shell">
      <BrandHeader title="إدارة الأسئلة">
        <button className="btn btn-sm btn-pill btn-on-blue" onClick={() => navigate('/host')}>
          <ArrowRight />
          العودة للإدارة
        </button>
      </BrandHeader>

      <div className="container">
        <div className="page-head">
          <div>
            <h1>إدارة الأسئلة</h1>
            <p>قم بإنشاء وتنظيم الأسئلة في أقسام مختلفة مع تحديد الأوزان والنقاط.</p>
          </div>
        </div>

        <div className="tabs">
          <button
            className={`btn btn-pill ${showExisting ? 'btn-secondary' : 'btn-primary'}`}
            onClick={() => setShowExisting(false)}
          >
            <Plus />
            إضافة أسئلة جديدة
          </button>
          <button
            className={`btn btn-pill ${showExisting ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setShowExisting(true)}
          >
            <Library />
            عرض الأسئلة الموجودة
          </button>
        </div>

        {showExisting ? (
          // Existing Questions View
          <div className="card">
            <div className="card-header">
              <div className="card-title">
                <div className="card-icon"><Library /></div>
                <span>الأسئلة الموجودة ({existingQuestions.length})</span>
              </div>
            </div>

            {loading ? (
              <div className="loading-screen" style={{ minHeight: '140px' }}>
                <div className="spinner" />
                <div>جاري التحميل...</div>
              </div>
            ) : existingQuestions.length === 0 ? (
              <div className="empty-state">
                <ClipboardList />
                <h3>لا توجد أسئلة</h3>
                <p>ابدأ بإضافة أسئلة جديدة</p>
              </div>
            ) : (
              <div className="flex" style={{ flexDirection: 'column', gap: '16px' }}>
                {existingQuestions.map((question, index) => (
                  <div key={question.id} className="question-block">
                    <div className="flex items-center justify-between gap-2">
                      <span className="question-block__num">{index + 1}</span>
                      <span className="badge badge-neutral">{question.section}</span>
                    </div>
                    <div className="question-block__text">{question.text}</div>

                    <div className="choice-grid">
                      {question.choices.map((choice, idx) => {
                        const choiceText = typeof choice === 'string' ? choice : choice.text;
                        const choiceWeight = typeof choice === 'string' ? 1 : choice.weight;
                        return (
                          <div key={idx} className="choice-chip">
                            <div className="flex items-center gap-2">
                              <span className="choice-chip__bullet" />
                              <span>{choiceText}</span>
                            </div>
                            {typeof choice !== 'string' && (
                              <span className="badge badge-primary">وزن: {choiceWeight}</span>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    <div className="text-xs text-secondary mt-3" style={{ paddingTop: '12px', borderTop: '1px solid var(--border)' }}>
                      <strong>القسم:</strong> {question.section} <span style={{ margin: '0 6px' }}>|</span> <strong>الوزن:</strong> {question.weight}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          // Add New Questions View
          <>
            <div className="card mb-5" style={{ display: 'flex', flexWrap: 'wrap', gap: '20px', alignItems: 'flex-end' }}>
              <div style={{ flex: 1, minWidth: '200px' }}>
                <label htmlFor="bankName">اسم بنك الأسئلة</label>
                <input
                  id="bankName"
                  type="text"
                  value={bankName}
                  onChange={(e) => setBankName(e.target.value)}
                  placeholder="أدخل اسم البنك (مطلوب)"
                />
              </div>
              <div style={{ flex: 1, minWidth: '200px' }}>
                <label htmlFor="totalPoints">إجمالي النقاط</label>
                <input
                  id="totalPoints"
                  type="number"
                  value={totalPoints}
                  onChange={(e) => setTotalPoints(parseFloat(e.target.value) || 100)}
                  min="1"
                />
              </div>
              <button className="btn btn-primary" onClick={addSection}>
                <FolderPlus />
                إضافة قسم جديد
              </button>
            </div>

            {sections.length === 0 ? (
              <div className="card mb-5">
                <div className="empty-state">
                  <ClipboardList />
                  <p>لا توجد أقسام بعد. اضغط على "إضافة قسم جديد" للبدء</p>
                </div>
              </div>
            ) : (
              sections.map((section) => (
                <div key={section.id} className="card mb-5" style={{ borderInlineStart: '4px solid var(--primary)' }}>
                  <div className="card-header" style={{ flexWrap: 'wrap' }}>
                    <div className="flex items-center gap-3" style={{ flex: 1, minWidth: '220px' }}>
                      <div className="card-icon"><Folder /></div>
                      <input
                        type="text"
                        value={section.name}
                        onChange={(e) => updateSectionName(section.id, e.target.value)}
                        placeholder="اسم القسم"
                        style={{ fontSize: '16px', fontWeight: 700, background: 'var(--muted)', borderColor: 'transparent' }}
                      />
                    </div>
                    <div className="flex items-center gap-3">
                      <label htmlFor={`sw-${section.id}`} style={{ margin: 0 }}>الوزن</label>
                      <input
                        id={`sw-${section.id}`}
                        type="number"
                        value={section.weight}
                        onChange={(e) => updateSectionWeight(section.id, parseFloat(e.target.value) || 1)}
                        min="0.1"
                        step="0.1"
                        style={{ width: '80px', textAlign: 'center' }}
                      />
                      <button className="icon-btn icon-btn--danger" onClick={() => removeSection(section.id)} title="حذف القسم" aria-label="حذف القسم">
                        <Trash2 />
                      </button>
                    </div>
                  </div>

                  {section.questions.map((question, qIdx) => (
                    <div key={qIdx} className="panel panel--muted mb-4">
                      <div className="flex items-center justify-between mb-3">
                        <span className="question-block__num">{qIdx + 1}</span>
                        <button className="btn btn-ghost btn-sm" onClick={() => removeQuestion(section.id, qIdx)}>
                          <Trash2 />
                          حذف السؤال
                        </button>
                      </div>

                      <textarea
                        value={question.text}
                        onChange={(e) => updateQuestionText(section.id, qIdx, e.target.value)}
                        placeholder="اكتب نص السؤال هنا..."
                        style={{ minHeight: '80px', marginBottom: '12px' }}
                      />

                      {question.choices.map((choice, cIdx) => (
                        <div key={cIdx} className="field-row mb-2">
                          <span className="choice-chip__bullet" />
                          <input
                            type="text"
                            value={choice.text}
                            onChange={(e) => updateChoice(section.id, qIdx, cIdx, e.target.value)}
                            placeholder={`خيار ${cIdx + 1}`}
                          />
                          <label style={{ margin: 0, whiteSpace: 'nowrap' }}>الوزن</label>
                          <input
                            type="number"
                            value={choice.weight}
                            onChange={(e) => updateChoiceWeight(section.id, qIdx, cIdx, parseFloat(e.target.value) || 0)}
                            min="0"
                            step="0.1"
                            placeholder="الوزن"
                            style={{ width: '80px', textAlign: 'center', flex: 'none' }}
                          />
                        </div>
                      ))}

                      <div className="flex gap-2 mt-3" style={{ paddingTop: '12px', borderTop: '1px solid var(--border)' }}>
                        <button className="btn btn-secondary btn-sm" onClick={() => addChoice(section.id, qIdx)}>
                          <Plus />
                          إضافة خيار
                        </button>
                        {question.choices.length > 1 && (
                          <button className="btn btn-secondary btn-sm" onClick={() => removeChoice(section.id, qIdx)}>
                            <Minus />
                            إزالة آخر خيار
                          </button>
                        )}
                      </div>
                    </div>
                  ))}

                  <button className="btn btn-outline btn-sm btn-pill" onClick={() => addQuestion(section.id)}>
                    <Plus />
                    إضافة سؤال
                  </button>
                </div>
              ))
            )}

            {sections.length > 0 && (
              <div className="card mb-5">
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
                      {pointsDistribution.map((data, idx) => (
                        <tr key={idx}>
                          <td>{data.name}</td>
                          <td className="num">{data.weight}</td>
                          <td className="num">{data.questionCount}</td>
                          <td className="num fw-600 text-primary">{data.totalPoints}</td>
                          <td className="num">{data.pointsPerQuestion}</td>
                        </tr>
                      ))}
                      <tr style={{ background: 'var(--primary-tint)', fontWeight: 700 }}>
                        <td colSpan={3}>المجموع</td>
                        <td className="num text-primary">{totalPoints}</td>
                        <td className="num">—</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="card card--flat flex justify-center">
              <button className="btn btn-primary btn-lg" onClick={saveQuestions}>
                <Save />
                حفظ الأسئلة
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
