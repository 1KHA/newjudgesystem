import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../hooks/useAuth';
import {
  getTeams,
  getQuestionBanks,
  getQuestions,
  createSession,
  getJudgesBySession
} from '../lib/supabaseService';
import { RealtimeManager } from '../lib/realtimeManager';
import { healthStore } from '../lib/connectionHealth';
import type { Team, Question, QuestionBank, Judge } from '../types';
import {
  ArrowRight, ArrowUp, ArrowDown, Users, HelpCircle, Scale, Check, CheckCheck, X,
  Plus, Minus, Pencil, Trash2, Save, Loader2, Link2, Copy, Clock, Play, UserRound,
  AlertTriangle, ChevronLeft
} from 'lucide-react';
import BrandHeader from '../components/BrandHeader';

/**
 * Guided session setup — the ONLY 3 things an admin needs before judging starts:
 *   Step 1 Teams          (add + select participating teams)
 *   Step 2 Question bank  (choose bank + questions)
 *   Step 3 Judges         (create session, share unique judge link, watch judges join)
 * Everything else lives on the control page.
 */
export default function SetupPage() {
  const { user } = useAuth();
  const navigate = useNavigate();

  // Step 1 — teams
  const [teams, setTeams] = useState<Team[]>([]);
  const [selectedTeams, setSelectedTeams] = useState<string[]>([]);
  const [newTeamName, setNewTeamName] = useState<string>('');
  const [editingTeamId, setEditingTeamId] = useState<string | null>(null);
  const [editingTeamName, setEditingTeamName] = useState<string>('');

  // Step 2 — questions
  const [questionBanks, setQuestionBanks] = useState<QuestionBank[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [allQuestions, setAllQuestions] = useState<Question[]>([]);
  const [selectedBank, setSelectedBank] = useState<string>('');
  const [selectedQuestions, setSelectedQuestions] = useState<string[]>([]);

  // Step 2 — optional inline "create a new bank" form
  const [showBankForm, setShowBankForm] = useState(false);
  const [newBankName, setNewBankName] = useState('');
  const [newBankQuestions, setNewBankQuestions] = useState<
    { text: string; choices: { text: string; weight: number }[] }[]
  >([{ text: '', choices: [{ text: '', weight: 1 }, { text: '', weight: 1 }] }]);
  const [savingBank, setSavingBank] = useState(false);

  // Step 3 — session + judges
  const [sessionId, setSessionId] = useState<string>('');
  const [judges, setJudges] = useState<Judge[]>([]);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);

  const step1Done = selectedTeams.length > 0;
  const step2Done = selectedQuestions.length > 0;
  const sessionCreated = sessionId !== '';

  useEffect(() => {
    loadInitialData();
  }, []);

  // Live judges list once the session exists: realtime + 5s poll fallback
  useEffect(() => {
    if (!sessionCreated) return;

    loadJudges(sessionId);
    healthStore.startSession(sessionId);
    const manager = new RealtimeManager({
      client: supabase,
      ping: () => loadJudges(sessionId),
      onResync: () => loadJudges(sessionId)
    });
    manager.start([{
      name: `judges-${sessionId}`,
      configure: (ch) => ch.on('postgres_changes',
        { event: '*', schema: 'public', table: 'judges', filter: `session_id=eq.${sessionId}` },
        () => { healthStore.noteChannelEvent(`judges-${sessionId}`); loadJudges(sessionId); })
    }]);
    const poll = setInterval(() => loadJudges(sessionId), 5000);

    return () => { clearInterval(poll); manager.stop(); healthStore.endSession(); };
  }, [sessionId, sessionCreated]);

  const loadInitialData = async () => {
    try {
      const [teamsData, banksData, questionsData] = await Promise.all([
        getTeams(),
        getQuestionBanks(),
        getQuestions()
      ]);
      setTeams(teamsData);
      setQuestionBanks(banksData);
      setAllQuestions(questionsData);
      setQuestions(questionsData);
    } catch (error) {
      console.error('Error loading initial data:', error);
      alert('خطأ في تحميل البيانات');
    }
  };

  const loadJudges = async (sid: string) => {
    try {
      setJudges(await getJudgesBySession(sid));
    } catch (error) {
      console.error('Error loading judges:', error);
    }
  };

  // ---- Step 1: team management ----

  const handleAddTeam = async () => {
    if (!newTeamName.trim()) {
      alert('يرجى إدخال اسم الفريق');
      return;
    }
    if (teams.some(t => t.name === newTeamName.trim())) {
      alert('اسم الفريق موجود بالفعل');
      return;
    }
    try {
      const { error } = await supabase.from('teams').insert({ name: newTeamName.trim() });
      if (error) throw error;
      setNewTeamName('');
      await loadInitialData();
    } catch (error) {
      console.error('Error adding team:', error);
      alert('خطأ في إضافة الفريق');
    }
  };

  const handleEditTeam = async (teamId: string, newName: string) => {
    if (!newName.trim()) {
      alert('يرجى إدخال اسم الفريق');
      return;
    }
    if (teams.some(t => t.id !== teamId && t.name === newName.trim())) {
      alert('اسم الفريق موجود بالفعل');
      return;
    }
    try {
      const { error } = await supabase.from('teams').update({ name: newName.trim() }).eq('id', teamId);
      if (error) throw error;
      setEditingTeamId(null);
      setEditingTeamName('');
      await loadInitialData();
    } catch (error) {
      console.error('Error updating team:', error);
      alert('خطأ في تحديث الفريق');
    }
  };

  const handleDeleteTeam = async (teamId: string, teamName: string) => {
    if (!confirm(`هل أنت متأكد من حذف الفريق "${teamName}"؟`)) return;
    try {
      const { error } = await supabase.from('teams').delete().eq('id', teamId);
      if (error) throw error;
      setSelectedTeams(prev => prev.filter(t => t !== teamName));
      await loadInitialData();
    } catch (error) {
      console.error('Error deleting team:', error);
      alert('خطأ في حذف الفريق');
    }
  };

  const handleMoveTeam = async (fromIndex: number, toIndex: number) => {
    if (toIndex < 0 || toIndex >= teams.length) return;
    const newTeams = [...teams];
    const [movedTeam] = newTeams.splice(fromIndex, 1);
    newTeams.splice(toIndex, 0, movedTeam);
    setTeams(newTeams);
    try {
      const updates = newTeams.map((team, index) =>
        supabase.from('teams').update({ display_order: index }).eq('id', team.id)
      );
      await Promise.all(updates);
    } catch (error) {
      console.error('Error saving team order:', error);
      alert('خطأ في حفظ ترتيب الفرق');
      await loadInitialData();
    }
  };

  const toggleTeamSelection = (teamName: string) => {
    setSelectedTeams(prev =>
      prev.includes(teamName) ? prev.filter(t => t !== teamName) : [...prev, teamName]
    );
  };

  // ---- Step 2: questions ----

  const handleBankChange = (bankId: string) => {
    setSelectedBank(bankId);
    setSelectedQuestions([]);
    setQuestions(bankId ? allQuestions.filter(q => q.bank_id === bankId) : allQuestions);
  };

  // ---- Step 2 (optional): create a new question bank inline ----

  const addNewBankQuestion = () => {
    setNewBankQuestions(prev => [...prev, { text: '', choices: [{ text: '', weight: 1 }, { text: '', weight: 1 }] }]);
  };

  const removeNewBankQuestion = (index: number) => {
    setNewBankQuestions(prev => prev.filter((_, i) => i !== index));
  };

  const updateNewBankQuestionText = (index: number, text: string) => {
    setNewBankQuestions(prev => prev.map((q, i) => i === index ? { ...q, text } : q));
  };

  const updateNewBankChoiceText = (qIndex: number, cIndex: number, text: string) => {
    setNewBankQuestions(prev => prev.map((q, i) => {
      if (i !== qIndex) return q;
      const choices = q.choices.map((c, ci) => ci === cIndex ? { ...c, text } : c);
      return { ...q, choices };
    }));
  };

  const addNewBankChoice = (qIndex: number) => {
    setNewBankQuestions(prev => prev.map((q, i) =>
      i === qIndex ? { ...q, choices: [...q.choices, { text: '', weight: 1 }] } : q
    ));
  };

  const removeNewBankChoice = (qIndex: number) => {
    setNewBankQuestions(prev => prev.map((q, i) => {
      if (i !== qIndex || q.choices.length <= 1) return q;
      return { ...q, choices: q.choices.slice(0, -1) };
    }));
  };

  const resetBankForm = () => {
    setNewBankName('');
    setNewBankQuestions([{ text: '', choices: [{ text: '', weight: 1 }, { text: '', weight: 1 }] }]);
  };

  const handleCreateBank = async () => {
    if (!newBankName.trim()) {
      alert('يرجى إدخال اسم بنك الأسئلة');
      return;
    }
    const validQuestions = newBankQuestions.filter(q => q.text.trim() && q.choices.every(c => c.text.trim()));
    if (validQuestions.length === 0) {
      alert('أضف سؤالًا واحدًا على الأقل بنص وخيارات كاملة');
      return;
    }

    setSavingBank(true);
    try {
      const { data: bank, error: bankError } = await supabase
        .from('question_banks')
        .insert({ name: newBankName.trim() })
        .select()
        .single();
      if (bankError) throw bankError;

      const { data: insertedQuestions, error: questionsError } = await supabase
        .from('questions')
        .insert(validQuestions.map(q => ({
          text: q.text.trim(),
          choices: q.choices.map(c => ({ text: c.text.trim(), weight: c.weight })),
          section: 'عام',
          weight: 1,
          bank_id: bank.id
        })))
        .select();
      if (questionsError) throw questionsError;

      resetBankForm();
      setShowBankForm(false);
      await loadInitialData();
      // New bank only contains what we just inserted — select it directly
      // rather than re-deriving from `allQuestions`, which is still stale here.
      setSelectedBank(bank.id);
      setQuestions((insertedQuestions || []) as Question[]);
      setSelectedQuestions((insertedQuestions || []).map(q => q.id));
    } catch (error) {
      console.error('Error creating question bank:', error);
      alert('خطأ في إنشاء بنك الأسئلة');
    } finally {
      setSavingBank(false);
    }
  };

  // ---- Step 3: create session + judge link ----

  const handleCreateSession = async () => {
    if (!step1Done) {
      alert('الخطوة 1: اختر فريقًا واحدًا على الأقل');
      return;
    }
    if (!step2Done) {
      alert('الخطوة 2: اختر سؤالًا واحدًا على الأقل');
      return;
    }
    if (!user) return;

    setCreating(true);
    try {
      const newSessionId = crypto.randomUUID().substring(0, 8);
      // Keep the questions in the order they appear in the selected bank
      const questionIds = questions.filter(q => selectedQuestions.includes(q.id)).map(q => q.id);
      const session = await createSession({
        name: `Session ${new Date().toISOString()}`,
        session_id: newSessionId,
        host_token: crypto.randomUUID(),
        host_id: user.id,
        teams: selectedTeams,
        questionIds,
        total_points: 100
      });
      setSessionId(session.session_id);
    } catch (error) {
      console.error('Error creating session:', error);
      alert('خطأ في إنشاء الجلسة');
    } finally {
      setCreating(false);
    }
  };

  const judgeUrl = `${window.location.origin}/judge/${sessionId}`;

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(judgeUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      prompt('انسخ الرابط:', judgeUrl);
    }
  };

  const handleStartJudging = () => {
    navigate(`/host/${sessionId}/control`);
  };


  const stepClass = (done: boolean, active: boolean) =>
    `step ${done ? 'step--done' : active ? 'step--active' : ''}`;

  const stepNum = (n: number, done: boolean) => (
    <span className="step__num">{done ? <Check /> : n}</span>
  );

  return (
    <div className="app-shell">
      <BrandHeader title="إعداد جلسة جديدة">
        <Link to="/host" className="btn btn-sm btn-pill btn-on-blue">
          <ArrowRight />
          جلساتي
        </Link>
      </BrandHeader>

      <div className="container">
        <div className="page-head">
          <div>
            <h1>إعداد جلسة تحكيم جديدة</h1>
            <p>ثلاث خطوات فقط: حدد الفرق، اختر الأسئلة، ثم شارك رابط المحكمين.</p>
          </div>
        </div>

        {/* Progress guide */}
        <div className="card card--flat mb-6" style={{ padding: '14px 20px' }}>
          <div className="stepper">
            <span className={stepClass(step1Done, true)}>
              {stepNum(1, step1Done)}
              <Users size={16} />
              الفرق {step1Done && `(${selectedTeams.length})`}
            </span>
            <span className="step__arrow"><ChevronLeft /></span>
            <span className={stepClass(step2Done, step1Done)}>
              {stepNum(2, step2Done)}
              <HelpCircle size={16} />
              الأسئلة {step2Done && `(${selectedQuestions.length})`}
            </span>
            <span className="step__arrow"><ChevronLeft /></span>
            <span className={stepClass(sessionCreated, step1Done && step2Done)}>
              {stepNum(3, sessionCreated)}
              <Scale size={16} />
              المحكمون {sessionCreated && `(${judges.length})`}
            </span>
          </div>
        </div>

        <div className="dashboard-grid">
          {/* ============ STEP 1: TEAMS ============ */}
          <div className="card">
            <div className="card-header">
              <div className="card-title">
                <div className="card-icon"><Users /></div>
                <span>الخطوة 1: الفرق</span>
              </div>
              {step1Done && (
                <span className="badge badge-success">
                  <Check />
                  {selectedTeams.length} فريق محدد
                </span>
              )}
            </div>
            <p className="card-desc">أضف الفرق المشاركة ثم حددها بالضغط عليها.</p>

            {/* Add Team Form */}
            <div className="panel panel--muted mb-5">
              <label htmlFor="newTeamName">إضافة فريق جديد</label>
              <div className="field-row">
                <input
                  id="newTeamName"
                  type="text"
                  value={newTeamName}
                  onChange={(e) => setNewTeamName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAddTeam()}
                  placeholder="اسم الفريق"
                />
                <button className="btn btn-primary" onClick={handleAddTeam}>
                  <Plus />
                  إضافة
                </button>
              </div>
            </div>

            {/* Bulk Actions */}
            <div className="flex gap-2 mb-4">
              <button className="btn btn-secondary btn-sm flex-1" onClick={() => setSelectedTeams(teams.map(t => t.name))}>
                <CheckCheck />
                تحديد الكل
              </button>
              <button className="btn btn-secondary btn-sm flex-1" onClick={() => setSelectedTeams([])}>
                <X />
                إلغاء الكل
              </button>
            </div>

            {/* Teams Grid */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
                gap: '12px',
                maxHeight: '400px',
                overflowY: 'auto',
                padding: '4px'
              }}
            >
              {teams.length === 0 && (
                <div className="empty-state" style={{ gridColumn: '1 / -1' }}>
                  <Users />
                  <h3>لا توجد فرق بعد</h3>
                  <p>أضف أول فريق من الحقل أعلاه</p>
                </div>
              )}
              {teams.map((team, index) => {
                const isSelected = selectedTeams.includes(team.name);
                const isEditing = editingTeamId === team.id;

                return (
                  <div
                    key={team.id}
                    className={`team-tile ${isSelected ? 'team-tile--selected' : ''}`}
                    onClick={() => !isEditing && toggleTeamSelection(team.name)}
                  >
                    <div className="team-tile__row">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleTeamSelection(team.name)}
                        onClick={(e) => e.stopPropagation()}
                        style={{ width: '18px' }}
                      />
                      {isEditing ? (
                        <input
                          type="text"
                          value={editingTeamName}
                          onChange={(e) => setEditingTeamName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleEditTeam(team.id, editingTeamName);
                            if (e.key === 'Escape') { setEditingTeamId(null); setEditingTeamName(''); }
                          }}
                          onClick={(e) => e.stopPropagation()}
                          autoFocus
                          style={{ flex: 1, padding: '4px 8px', fontSize: '14px' }}
                        />
                      ) : (
                        <span className="team-tile__name">{team.name}</span>
                      )}
                    </div>

                    <div className="team-tile__actions" onClick={(e) => e.stopPropagation()}>
                      <div>
                        <button
                          className={`icon-btn ${isSelected ? 'icon-btn--on-primary' : ''}`}
                          onClick={() => handleMoveTeam(index, index - 1)}
                          disabled={index === 0}
                          title="تحريك لأعلى"
                          aria-label="تحريك لأعلى"
                        ><ArrowUp /></button>
                        <button
                          className={`icon-btn ${isSelected ? 'icon-btn--on-primary' : ''}`}
                          onClick={() => handleMoveTeam(index, index + 1)}
                          disabled={index === teams.length - 1}
                          title="تحريك لأسفل"
                          aria-label="تحريك لأسفل"
                        ><ArrowDown /></button>
                      </div>

                      <div>
                        {isEditing ? (
                          <>
                            <button className="icon-btn icon-btn--success" onClick={() => handleEditTeam(team.id, editingTeamName)} title="حفظ" aria-label="حفظ"><Check /></button>
                            <button className="icon-btn icon-btn--danger" onClick={() => { setEditingTeamId(null); setEditingTeamName(''); }} title="إلغاء" aria-label="إلغاء"><X /></button>
                          </>
                        ) : (
                          <>
                            <button
                              className={`icon-btn ${isSelected ? 'icon-btn--on-primary' : ''}`}
                              onClick={() => { setEditingTeamId(team.id); setEditingTeamName(team.name); }}
                              title="تعديل"
                              aria-label="تعديل"
                            ><Pencil /></button>
                            <button
                              className={`icon-btn ${isSelected ? 'icon-btn--on-primary' : 'icon-btn--danger'}`}
                              onClick={() => handleDeleteTeam(team.id, team.name)}
                              title="حذف"
                              aria-label="حذف"
                            ><Trash2 /></button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* ============ STEP 2: QUESTIONS ============ */}
          <div className="card">
            <div className="card-header">
              <div className="card-title">
                <div className="card-icon"><HelpCircle /></div>
                <span>الخطوة 2: بنك الأسئلة</span>
              </div>
              {step2Done && (
                <span className="badge badge-success">
                  <Check />
                  {selectedQuestions.length} سؤال
                </span>
              )}
            </div>
            <p className="card-desc">اختر بنك الأسئلة ثم حدد الأسئلة التي ستُرسل للمحكمين.</p>

            {/* Optional: create a new bank inline, same pattern as adding teams above */}
            <div className="panel panel--muted mb-5">
              <button
                className={`btn ${showBankForm ? 'btn-secondary' : 'btn-outline'} btn-block`}
                onClick={() => setShowBankForm(prev => !prev)}
              >
                {showBankForm ? <X /> : <Plus />}
                {showBankForm ? 'إلغاء' : 'إنشاء بنك أسئلة جديد (اختياري)'}
              </button>

              {showBankForm && (
                <div className="mt-4">
                  <div className="field">
                    <label htmlFor="newBankName">اسم بنك الأسئلة</label>
                    <input
                      id="newBankName"
                      type="text"
                      value={newBankName}
                      onChange={(e) => setNewBankName(e.target.value)}
                      placeholder="مثال: أسئلة الجولة الأولى"
                    />
                  </div>

                  {newBankQuestions.map((q, qIdx) => (
                    <div key={qIdx} className="panel mb-3">
                      <div className="field-row mb-2" style={{ alignItems: 'flex-start' }}>
                        <textarea
                          value={q.text}
                          onChange={(e) => updateNewBankQuestionText(qIdx, e.target.value)}
                          placeholder={`نص السؤال ${qIdx + 1}`}
                          style={{ minHeight: '50px' }}
                        />
                        {newBankQuestions.length > 1 && (
                          <button className="icon-btn icon-btn--danger" onClick={() => removeNewBankQuestion(qIdx)} title="حذف السؤال" aria-label="حذف السؤال">
                            <Trash2 />
                          </button>
                        )}
                      </div>
                      {q.choices.map((c, cIdx) => (
                        <div key={cIdx} className="field-row mb-2">
                          <span className="choice-chip__bullet" />
                          <input
                            type="text"
                            value={c.text}
                            onChange={(e) => updateNewBankChoiceText(qIdx, cIdx, e.target.value)}
                            placeholder={`خيار ${cIdx + 1}`}
                            style={{ padding: '6px 10px', fontSize: '13px' }}
                          />
                        </div>
                      ))}
                      <div className="flex gap-2">
                        <button className="btn btn-secondary btn-sm" onClick={() => addNewBankChoice(qIdx)}>
                          <Plus />
                          خيار
                        </button>
                        {q.choices.length > 1 && (
                          <button className="btn btn-secondary btn-sm" onClick={() => removeNewBankChoice(qIdx)}>
                            <Minus />
                            خيار
                          </button>
                        )}
                      </div>
                    </div>
                  ))}

                  <div className="flex gap-2">
                    <button className="btn btn-secondary flex-1" onClick={addNewBankQuestion}>
                      <Plus />
                      إضافة سؤال آخر
                    </button>
                    <button className="btn btn-primary flex-1" onClick={handleCreateBank} disabled={savingBank}>
                      {savingBank ? <Loader2 className="spin" /> : <Save />}
                      {savingBank ? 'جاري الحفظ...' : 'حفظ البنك'}
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="field">
              <label htmlFor="bankSelect">بنك الأسئلة</label>
              <select
                id="bankSelect"
                value={selectedBank}
                onChange={(e) => handleBankChange(e.target.value)}
              >
                <option value="">جميع الأسئلة</option>
                {questionBanks.map(bank => (
                  <option key={bank.id} value={bank.id}>{bank.name}</option>
                ))}
              </select>
            </div>

            <div className="field">
              <label htmlFor="questionSelect">اختر الأسئلة</label>
              <select
                id="questionSelect"
                multiple
                value={selectedQuestions}
                onChange={(e) => {
                  const selected = Array.from(e.target.selectedOptions, option => option.value);
                  setSelectedQuestions(selected);
                }}
              >
                {questions.map(question => (
                  <option key={question.id} value={question.id}>{question.text}</option>
                ))}
              </select>
              <p className="text-xs text-secondary mt-2">اضغط مع الاستمرار على Ctrl أو لتحديد أكثر من سؤال.</p>
            </div>
          </div>

          {/* ============ STEP 3: JUDGES ============ */}
          <div className="card span-2">
            <div className="card-header">
              <div className="card-title">
                <div className="card-icon"><Scale /></div>
                <span>الخطوة 3: المحكمون</span>
              </div>
              {sessionCreated && (
                <span className={`badge ${judges.length > 0 ? 'badge-success' : 'badge-warning'}`}>
                  {judges.length > 0 ? <Check /> : <Clock />}
                  {judges.length > 0 ? `${judges.length} محكم انضم` : 'بانتظار المحكمين'}
                </span>
              )}
            </div>

            {!sessionCreated ? (
              <>
                <p className="card-desc">
                  بعد إكمال الخطوتين 1 و 2، أنشئ الجلسة للحصول على رابط خاص ترسله للمحكمين.
                </p>
                <button
                  className="btn btn-primary btn-lg btn-block"
                  onClick={handleCreateSession}
                  disabled={!step1Done || !step2Done || creating}
                  title={!step1Done ? 'أكمل الخطوة 1 أولاً' : !step2Done ? 'أكمل الخطوة 2 أولاً' : ''}
                >
                  {creating ? <Loader2 className="spin" /> : <Link2 />}
                  {creating ? 'جاري الإنشاء...' : 'إنشاء الجلسة ورابط المحكمين'}
                </button>
                {(!step1Done || !step2Done) && (
                  <div className="alert alert-warning mt-3 mb-0">
                    <AlertTriangle />
                    <span>
                      {!step1Done ? 'أكمل الخطوة 1: حدد فريقًا واحدًا على الأقل' : 'أكمل الخطوة 2: اختر سؤالًا واحدًا على الأقل'}
                    </span>
                  </div>
                )}
              </>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '20px' }}>
                {/* Judge link panel */}
                <div className="panel panel--tint">
                  <h3 className="panel-title"><Link2 /> رابط انضمام المحكمين</h3>
                  <p className="text-sm text-secondary mb-3">
                    أرسل هذا الرابط للمحكمين. كل جلسة لها رابط خاص لا يتعارض مع الجلسات الأخرى.
                  </p>
                  <div className="link-box">{judgeUrl}</div>
                  <div className="text-center mb-3">
                    <span className="text-sm text-secondary">كود الجلسة</span>
                    <span className="session-code">{sessionId}</span>
                  </div>
                  <button className={`btn ${copied ? 'btn-success' : 'btn-primary'} btn-block`} onClick={handleCopyLink}>
                    {copied ? <Check /> : <Copy />}
                    {copied ? 'تم النسخ' : 'نسخ الرابط'}
                  </button>
                </div>

                {/* Live judges list */}
                <div>
                  <h3 className="panel-title"><Scale /> المحكمون المنضمون ({judges.length})</h3>
                  <ul className="list-plain" style={{ maxHeight: '220px', overflowY: 'auto' }}>
                    {judges.length === 0 ? (
                      <li className="empty-state">
                        <Clock />
                        بانتظار انضمام المحكمين عبر الرابط...
                      </li>
                    ) : (
                      judges.map(judge => (
                        <li key={judge.id} className="list-row list-row--success" style={{ justifyContent: 'flex-start' }}>
                          <span className="avatar avatar--success"><UserRound /></span>
                          <span className="fw-600">{judge.name}</span>
                        </li>
                      ))
                    )}
                  </ul>

                  <button className="btn btn-primary btn-lg btn-block mt-3" onClick={handleStartJudging}>
                    <Play />
                    بدء جلسة التحكيم {judges.length > 0 ? `(${judges.length} محكم)` : ''}
                  </button>
                  {judges.length === 0 && (
                    <p className="text-sm text-warning text-center mt-2 mb-0">
                      يمكنك البدء الآن والمحكمون ينضمون لاحقًا، لكن يُفضّل انتظار انضمامهم
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
