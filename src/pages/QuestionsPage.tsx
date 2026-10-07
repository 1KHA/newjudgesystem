import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { getQuestions, createQuestionBank } from '../lib/supabaseService';
import { SESSION_TOTAL_POINTS } from '../lib/scoring';
import type { Question } from '../types';
import { ArrowRight, Plus, Library, ClipboardList, Save } from 'lucide-react';
import BrandHeader from '../components/BrandHeader';
import QuestionBankEditor from '../components/QuestionBankEditor';
import { newSection, draftProblems, draftToBankQuestions, type DraftSection } from '../lib/questionBank';
import QuestionList from '../components/QuestionList';

export default function QuestionsPage() {
  const navigate = useNavigate();
  const [existingQuestions, setExistingQuestions] = useState<Question[]>([]);
  const [bankName, setBankName] = useState('');
  const [saving, setSaving] = useState(false);
  const [sections, setSections] = useState<DraftSection[]>(() => [newSection(0)]);
  const [loading, setLoading] = useState(true);
  const [showExisting, setShowExisting] = useState(true);

  useEffect(() => {
    loadData();
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

  const saveQuestions = async () => {
    if (sections.length === 0) {
      alert('يرجى إضافة قسم واحد على الأقل مع الأسئلة');
      return;
    }

    if (!bankName.trim()) {
      alert('يرجى إدخال اسم بنك الأسئلة');
      return;
    }

    // Validate everything before saving (the server checks again)
    const problems = draftProblems(sections);
    if (problems.length > 0) {
      alert(problems.slice(0, 12).join('\n') + (problems.length > 12 ? `\nو${problems.length - 12} ملاحظات أخرى` : ''));
      return;
    }

    setSaving(true);
    try {
      // Bank, questions and choices are saved in one transaction: all or nothing
      const questions = draftToBankQuestions(sections);
      await createQuestionBank(bankName.trim(), questions);

      alert(`تم حفظ ${questions.length} سؤال في البنك بنجاح`);

      // Reset form
      setSections([newSection(0)]);
      setBankName('');
      loadData();
    } catch (error) {
      console.error('Error saving questions:', error);
      alert(`خطأ في حفظ الأسئلة: ${(error as { message?: string }).message ?? ''}`);
    } finally {
      setSaving(false);
    }
  };

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
              <QuestionList questions={existingQuestions} />
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
                <label>الدرجة الكاملة</label>
                <div className="text-sm text-secondary" style={{ padding: '10px 0' }}>
                  {SESSION_TOTAL_POINTS} لكل محكم، ونتيجة الفريق متوسط المحكمين فلا تتجاوز {SESSION_TOTAL_POINTS}
                </div>
              </div>
            </div>

            <QuestionBankEditor sections={sections} onChange={setSections} />

            <div className="card card--flat flex justify-center">
              <button className="btn btn-primary btn-lg" onClick={saveQuestions} disabled={saving}>
                <Save />
                {saving ? 'جاري الحفظ...' : 'حفظ الأسئلة'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
