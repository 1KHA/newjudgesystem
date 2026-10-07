import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../hooks/useAuth';
import {
  getTeams,
  getQuestionBanks,
  getQuestions,
  createQuestionBank,
  createSession,
  getJudgesBySession
} from '../lib/supabaseService';
import { RealtimeManager } from '../lib/realtimeManager';
import { healthStore } from '../lib/connectionHealth';
import { trackOrder } from '../lib/teamImport';
import { SESSION_TOTAL_POINTS, questionMaxPoints, sectionPoints } from '../lib/scoring';
import TeamUploadPanel from '../components/TeamUploadPanel';
import QuestionBankEditor from '../components/QuestionBankEditor';
import { newSection, draftProblems, draftToBankQuestions, orderBySection, type DraftSection } from '../lib/questionBank';
import QuestionList from '../components/QuestionList';
import type { Team, Question, QuestionBank, Judge, SessionTeam } from '../types';
import {
  ArrowRight, ArrowUp, ArrowDown, Users, HelpCircle, Scale, Check, CheckCheck, X,
  Plus, Pencil, Trash2, Save, Loader2, Link2, Copy, Clock, Play, UserRound,
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
  const [newTeamTrack, setNewTeamTrack] = useState<string>('');
  const [editingTeamId, setEditingTeamId] = useState<string | null>(null);
  const [editingTeamName, setEditingTeamName] = useState<string>('');
  const [editingTeamTrack, setEditingTeamTrack] = useState<string>('');

  // Step 2 — questions
  const [questionBanks, setQuestionBanks] = useState<QuestionBank[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [allQuestions, setAllQuestions] = useState<Question[]>([]);
  const [selectedBank, setSelectedBank] = useState<string>('');
  const [selectedQuestions, setSelectedQuestions] = useState<string[]>([]);

  // Step 2 — optional inline "create a new bank" form
  const [showBankForm, setShowBankForm] = useState(false);
  const [newBankName, setNewBankName] = useState('');
  const [newBankSections, setNewBankSections] = useState<DraftSection[]>(() => [newSection(0)]);
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
        (payload) => {
          healthStore.noteChannelEvent(`judges-${sessionId}`);
          // Presence pings are UPDATEs: patch locally instead of refetching the whole list
          if (payload.eventType === 'UPDATE') {
            const row = payload.new as Judge;
            setJudges((prev) => prev.map((j) => (j.id === row.id ? { ...j, ...row } : j)));
          } else {
            loadJudges(sessionId);
          }
        })
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
    const name = newTeamName.replace(/\s+/g, ' ').trim();
    if (!name) {
      alert('يرجى إدخال اسم الفريق');
      return;
    }
    if (teams.some(t => t.name.toLowerCase() === name.toLowerCase())) {
      alert('اسم الفريق موجود بالفعل');
      return;
    }
    try {
      const track = newTeamTrack.replace(/\s+/g, ' ').trim() || null;
      const { error } = await supabase.from('teams').insert({ name, track, display_order: teams.length });
      if (error) throw error;
      setNewTeamName('');
      await loadInitialData();
    } catch (error) {
      console.error('Error adding team:', error);
      alert('خطأ في إضافة الفريق');
    }
  };

  const handleEditTeam = async (teamId: string, newName: string, newTrack: string) => {
    const name = newName.replace(/\s+/g, ' ').trim();
    if (!name) {
      alert('يرجى إدخال اسم الفريق');
      return;
    }
    if (teams.some(t => t.id !== teamId && t.name.toLowerCase() === name.toLowerCase())) {
      alert('اسم الفريق موجود بالفعل');
      return;
    }
    const oldName = teams.find(t => t.id === teamId)?.name;
    try {
      const track = newTrack.replace(/\s+/g, ' ').trim() || null;
      const { error } = await supabase.from('teams').update({ name, track }).eq('id', teamId);
      if (error) throw error;
      setEditingTeamId(null);
      setEditingTeamName('');
      setEditingTeamTrack('');
      if (oldName && oldName !== name) {
        setSelectedTeams(prev => prev.map(t => (t === oldName ? name : t)));
      }
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
      // One request for the whole new order (was one request per team)
      const { error } = await supabase.from('teams').upsert(
        newTeams.map((team, index) => ({ id: team.id, name: team.name, track: team.track ?? null, display_order: index }))
      );
      if (error) throw error;
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

  /** Tracks in list order ('' = teams without a track). */
  const tracks = trackOrder(teams);
  const namedTracks = tracks.filter(Boolean);
  const teamsInTrack = (track: string) => teams.filter(t => (t.track ?? '') === track).map(t => t.name);

  const toggleTrackSelection = (track: string) => {
    const names = teamsInTrack(track);
    const allSelected = names.every(n => selectedTeams.includes(n));
    setSelectedTeams(prev => (allSelected
      ? prev.filter(n => !names.includes(n))
      : [...prev, ...names.filter(n => !prev.includes(n))]));
  };

  const handleTeamsUploaded = async (saved: SessionTeam[]) => {
    await loadInitialData();
    setSelectedTeams(saved.map(t => t.name));
  };

  // ---- Step 2: questions ----

  const handleBankChange = (bankId: string) => {
    setSelectedBank(bankId);
    setSelectedQuestions([]);
    setQuestions(bankId ? allQuestions.filter(q => q.bank_id === bankId) : allQuestions);
  };

  // ---- Step 2 (optional): create a new question bank inline ----

  const resetBankForm = () => {
    setNewBankName('');
    setNewBankSections([newSection(0)]);
  };

  const handleCreateBank = async () => {
    if (!newBankName.trim()) {
      alert('يرجى إدخال اسم بنك الأسئلة');
      return;
    }
    // Same checks as the questions page (the server checks again)
    const problems = draftProblems(newBankSections);
    if (problems.length > 0) {
      alert(problems.slice(0, 12).join('\n') + (problems.length > 12 ? `\nو${problems.length - 12} ملاحظات أخرى` : ''));
      return;
    }

    setSavingBank(true);
    try {
      // Bank, questions and choices are saved in one transaction: all or nothing
      const bankId = await createQuestionBank(newBankName.trim(), draftToBankQuestions(newBankSections));
      const inserted = await getQuestions(bankId);

      resetBankForm();
      setShowBankForm(false);
      await loadInitialData();
      // Select the new bank and all its questions directly: `allQuestions` is still stale here
      setSelectedBank(bankId);
      setQuestions(inserted);
      setSelectedQuestions(inserted.map(q => q.id));
    } catch (error) {
      console.error('Error creating question bank:', error);
      alert(`خطأ في إنشاء بنك الأسئلة: ${(error as { message?: string }).message ?? ''}`);
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
      // Judges get the questions in the order the picker shows them (section by section)
      const questionIds = orderBySection(questions).filter(q => selectedQuestions.includes(q.id)).map(q => q.id);
      const session = await createSession({
        name: `Session ${new Date().toISOString()}`,
        session_id: newSessionId,
        host_token: crypto.randomUUID(),
        host_id: user.id,
        // Judging order = list order (file order after an upload), with each team's track
        teams: teams
          .filter(t => selectedTeams.includes(t.name))
          .map(t => ({ name: t.name, track: t.track ?? null })),
        questionIds,
        total_points: SESSION_TOTAL_POINTS
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

  // Same split the server will use for the selected questions
  const pickedQuestions = questions.filter(q => selectedQuestions.includes(q.id));
  const pointsSplit = sectionPoints(pickedQuestions);
  const pickedPoints = questionMaxPoints(pickedQuestions);
  const allPicked = questions.length > 0 && questions.every(q => selectedQuestions.includes(q.id));

  const toggleQuestion = (id: string) => {
    setSelectedQuestions(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));
  };

  const toggleAllQuestions = () => {
    setSelectedQuestions(allPicked ? [] : questions.map(q => q.id));
  };

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
            <p className="card-desc">ارفع ملف الفرق مع مساراتها، أو أضف الفرق يدوياً، ثم حددها بالضغط عليها.</p>

            {/* Upload teams + tracks from Excel */}
            <TeamUploadPanel existingNames={teams.map(t => t.name)} onSaved={handleTeamsUploaded} />

            {/* Add Team Form */}
            <div className="panel panel--muted mb-5">
              <label htmlFor="newTeamName">إضافة فريق يدوياً</label>
              <div className="field-row field-row--wrap">
                <input
                  id="newTeamName"
                  type="text"
                  value={newTeamName}
                  onChange={(e) => setNewTeamName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAddTeam()}
                  placeholder="اسم الفريق"
                />
                <input
                  id="newTeamTrack"
                  type="text"
                  list="trackOptions"
                  value={newTeamTrack}
                  onChange={(e) => setNewTeamTrack(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAddTeam()}
                  placeholder="المسار"
                  className="field-row__track"
                />
                <button className="btn btn-primary" onClick={handleAddTeam}>
                  <Plus />
                  إضافة
                </button>
              </div>
              <datalist id="trackOptions">
                {namedTracks.map(t => <option key={t} value={t} />)}
              </datalist>
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

            {/* Select by track */}
            {namedTracks.length > 0 && (
              <div className="track-chips mb-4">
                <span className="text-xs text-secondary">تحديد حسب المسار:</span>
                {tracks.map(track => {
                  const names = teamsInTrack(track);
                  const chosen = names.filter(n => selectedTeams.includes(n)).length;
                  const all = chosen === names.length;
                  return (
                    <button
                      key={track || '__none'}
                      className={`track-chip ${all ? 'track-chip--on' : chosen ? 'track-chip--some' : ''}`}
                      onClick={() => toggleTrackSelection(track)}
                    >
                      {track || 'بدون مسار'} <b>{chosen}/{names.length}</b>
                    </button>
                  );
                })}
              </div>
            )}

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
                  <p>ارفع ملف الفرق أو أضف أول فريق يدوياً</p>
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
                            if (e.key === 'Enter') handleEditTeam(team.id, editingTeamName, editingTeamTrack);
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
                    {isEditing ? (
                      <input
                        type="text"
                        list="trackOptions"
                        value={editingTeamTrack}
                        onChange={(e) => setEditingTeamTrack(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleEditTeam(team.id, editingTeamName, editingTeamTrack);
                          if (e.key === 'Escape') { setEditingTeamId(null); setEditingTeamName(''); }
                        }}
                        onClick={(e) => e.stopPropagation()}
                        placeholder="المسار"
                        className="mb-2"
                        style={{ padding: '4px 8px', fontSize: '13px' }}
                      />
                    ) : team.track ? (
                      <div className="mb-2"><span className="track-badge">{team.track}</span></div>
                    ) : null}

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
                            <button className="icon-btn icon-btn--success" onClick={() => handleEditTeam(team.id, editingTeamName, editingTeamTrack)} title="حفظ" aria-label="حفظ"><Check /></button>
                            <button className="icon-btn icon-btn--danger" onClick={() => { setEditingTeamId(null); setEditingTeamName(''); }} title="إلغاء" aria-label="إلغاء"><X /></button>
                          </>
                        ) : (
                          <>
                            <button
                              className={`icon-btn ${isSelected ? 'icon-btn--on-primary' : ''}`}
                              onClick={() => { setEditingTeamId(team.id); setEditingTeamName(team.name); setEditingTeamTrack(team.track ?? ''); }}
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

                  <QuestionBankEditor sections={newBankSections} onChange={setNewBankSections} compact />

                  <div className="flex gap-2">
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
              <div className="flex items-center justify-between gap-2 mb-2">
                <label style={{ margin: 0 }}>اختر الأسئلة</label>
                {questions.length > 0 && (
                  <button className="btn btn-ghost btn-sm" onClick={toggleAllQuestions}>
                    {allPicked ? <X /> : <CheckCheck />}
                    {allPicked ? 'إلغاء تحديد الكل' : 'تحديد الكل'}
                  </button>
                )}
              </div>
              {questions.length === 0 ? (
                <div className="empty-state">
                  <HelpCircle />
                  <p>لا توجد أسئلة في هذا البنك</p>
                </div>
              ) : (
                <div className="question-picker">
                  <QuestionList
                    questions={questions}
                    selectedIds={selectedQuestions}
                    onToggle={toggleQuestion}
                    points={pickedPoints}
                  />
                </div>
              )}
            </div>

            {pointsSplit.length > 0 && (
              <div className="panel panel--muted">
                <div className="fw-600 mb-2">توزيع الدرجة ({SESSION_TOTAL_POINTS} لكل محكم)</div>
                <ul className="points-split">
                  {pointsSplit.map((r) => (
                    <li key={r.section}>
                      <span>{r.section} <span className="text-secondary">({r.questions} {r.questions === 1 ? 'سؤال' : 'أسئلة'})</span></span>
                      <span className="fw-700">{r.points.toFixed(2)}</span>
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-secondary mt-2 mb-0">نتيجة الفريق متوسط درجات المحكمين، فلا تتجاوز {SESSION_TOTAL_POINTS} مهما كان عددهم.</p>
              </div>
            )}
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
