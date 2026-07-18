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
import type { Team, Question, QuestionBank, Judge } from '../types';

/**
 * Guided session setup — the ONLY 3 things an admin needs before judging starts:
 *   Step 1 👥 Teams          (add + select participating teams)
 *   Step 2 ❓ Question bank   (choose bank + questions)
 *   Step 3 ⚖️ Judges          (create session → share unique judge link → watch judges join)
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

  // Live judges list once the session exists
  useEffect(() => {
    if (!sessionCreated) return;

    loadJudges(sessionId);
    const channel = supabase
      .channel(`setup-judges-${sessionId}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'judges', filter: `session_id=eq.${sessionId}` },
        () => loadJudges(sessionId)
      )
      .subscribe();

    return () => { channel.unsubscribe(); };
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
      const session = await createSession({
        name: `Session ${new Date().toISOString()}`,
        session_id: newSessionId,
        host_token: crypto.randomUUID(),
        host_id: user.id,
        teams: selectedTeams,
        total_points: 100
      });
      setSessionId(session.session_id);

      // Hand the selected questions to the control page (same-device handoff)
      const questionObjects = questions.filter(q => selectedQuestions.includes(q.id));
      sessionStorage.setItem(`controlQuestions_${session.session_id}`, JSON.stringify(questionObjects));
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

  const stepBadge = (done: boolean, active: boolean) => (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '32px',
      height: '32px',
      borderRadius: '50%',
      fontWeight: 700,
      fontSize: '16px',
      background: done ? '#10b981' : active ? 'var(--primary-color)' : '#d1d5db',
      color: 'white',
      flexShrink: 0
    }}>
      {done ? '✓' : ''}
    </span>
  );

  return (
    <div className="container">
      <div className="header">
        <h1>إعداد جلسة تحكيم جديدة</h1>
        <Link to="/host" className="btn btn-secondary" style={{ textDecoration: 'none', fontSize: '14px' }}>
          ← جلساتي
        </Link>
      </div>

      {/* Progress guide */}
      <div className="card" style={{ marginBottom: '24px', padding: '16px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', justifyContent: 'center' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600 }}>
            {stepBadge(step1Done, true)} 👥 الفرق {step1Done && `(${selectedTeams.length})`}
          </span>
          <span style={{ color: 'var(--text-secondary)' }}>←</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600 }}>
            {stepBadge(step2Done, step1Done)} ❓ الأسئلة {step2Done && `(${selectedQuestions.length})`}
          </span>
          <span style={{ color: 'var(--text-secondary)' }}>←</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600 }}>
            {stepBadge(sessionCreated, step1Done && step2Done)} ⚖️ المحكمون {sessionCreated && `(${judges.length})`}
          </span>
        </div>
      </div>

      <div className="dashboard-grid">
        {/* ============ STEP 1: TEAMS ============ */}
        <div className="card">
          <div className="card-header">
            <div className="card-title">
              <div className="card-icon">👥</div>
              <span>الخطوة 1: الفرق</span>
            </div>
            {step1Done && (
              <div style={{ background: '#10b981', color: 'white', padding: '4px 12px', borderRadius: '12px', fontSize: '12px', fontWeight: 600 }}>
                ✓ {selectedTeams.length} فريق محدد
              </div>
            )}
          </div>
          <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginTop: 0 }}>
            أضف الفرق المشاركة ثم حددها بالضغط عليها.
          </p>

          {/* Add Team Form */}
          <div style={{ marginBottom: '20px', padding: '16px', background: 'var(--secondary-light)', borderRadius: '8px' }}>
            <label style={{ display: 'block', marginBottom: '8px', fontWeight: 500 }}>➕ إضافة فريق جديد</label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                type="text"
                value={newTeamName}
                onChange={(e) => setNewTeamName(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleAddTeam()}
                placeholder="اسم الفريق"
                style={{ flex: 1, padding: '8px 12px', border: '2px solid var(--border-color)', borderRadius: '6px' }}
              />
              <button className="btn btn-success" onClick={handleAddTeam} style={{ padding: '8px 16px' }}>
                إضافة
              </button>
            </div>
          </div>

          {/* Bulk Actions */}
          <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
            <button className="btn btn-secondary" onClick={() => setSelectedTeams(teams.map(t => t.name))}
              style={{ flex: 1, fontSize: '14px', padding: '8px' }}>
              ✓ تحديد الكل
            </button>
            <button className="btn btn-secondary" onClick={() => setSelectedTeams([])}
              style={{ flex: 1, fontSize: '14px', padding: '8px' }}>
              ✕ إلغاء الكل
            </button>
          </div>

          {/* Teams Grid */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
            gap: '12px',
            maxHeight: '400px',
            overflowY: 'auto',
            padding: '4px'
          }}>
            {teams.map((team, index) => {
              const isSelected = selectedTeams.includes(team.name);
              const isEditing = editingTeamId === team.id;

              return (
                <div
                  key={team.id}
                  style={{
                    background: isSelected ? 'linear-gradient(135deg, #761814, #5a120f)' : 'white',
                    border: `2px solid ${isSelected ? '#761814' : 'var(--border-color)'}`,
                    borderRadius: '12px',
                    padding: '12px',
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                    transform: isSelected ? 'scale(1.02)' : 'scale(1)',
                    boxShadow: isSelected ? '0 4px 6px rgba(118, 24, 20, 0.2)' : 'none'
                  }}
                  onClick={() => !isEditing && toggleTeamSelection(team.name)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleTeamSelection(team.name)}
                      onClick={(e) => e.stopPropagation()}
                      style={{ width: '18px', height: '18px', cursor: 'pointer' }}
                    />
                    {isEditing ? (
                      <input
                        type="text"
                        value={editingTeamName}
                        onChange={(e) => setEditingTeamName(e.target.value)}
                        onKeyPress={(e) => {
                          if (e.key === 'Enter') handleEditTeam(team.id, editingTeamName);
                          if (e.key === 'Escape') { setEditingTeamId(null); setEditingTeamName(''); }
                        }}
                        onClick={(e) => e.stopPropagation()}
                        autoFocus
                        style={{ flex: 1, padding: '4px 8px', border: '1px solid var(--border-color)', borderRadius: '4px', fontSize: '14px' }}
                      />
                    ) : (
                      <span style={{ flex: 1, fontWeight: 600, color: isSelected ? 'white' : 'var(--text-primary)', fontSize: '14px' }}>
                        {team.name}
                      </span>
                    )}
                  </div>

                  <div style={{ display: 'flex', gap: '4px', justifyContent: 'space-between' }} onClick={(e) => e.stopPropagation()}>
                    <div style={{ display: 'flex', gap: '4px' }}>
                      <button
                        onClick={() => handleMoveTeam(index, index - 1)}
                        disabled={index === 0}
                        style={{
                          padding: '4px 8px', background: isSelected ? 'rgba(255,255,255,0.2)' : 'var(--secondary-light)',
                          border: 'none', borderRadius: '4px', cursor: index === 0 ? 'not-allowed' : 'pointer',
                          opacity: index === 0 ? 0.5 : 1, color: isSelected ? 'white' : 'var(--text-primary)', fontSize: '12px'
                        }}
                        title="تحريك لأعلى"
                      >↑</button>
                      <button
                        onClick={() => handleMoveTeam(index, index + 1)}
                        disabled={index === teams.length - 1}
                        style={{
                          padding: '4px 8px', background: isSelected ? 'rgba(255,255,255,0.2)' : 'var(--secondary-light)',
                          border: 'none', borderRadius: '4px', cursor: index === teams.length - 1 ? 'not-allowed' : 'pointer',
                          opacity: index === teams.length - 1 ? 0.5 : 1, color: isSelected ? 'white' : 'var(--text-primary)', fontSize: '12px'
                        }}
                        title="تحريك لأسفل"
                      >↓</button>
                    </div>

                    <div style={{ display: 'flex', gap: '4px' }}>
                      {isEditing ? (
                        <>
                          <button onClick={() => handleEditTeam(team.id, editingTeamName)}
                            style={{ padding: '4px 8px', background: '#10b981', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}
                            title="حفظ">✓</button>
                          <button onClick={() => { setEditingTeamId(null); setEditingTeamName(''); }}
                            style={{ padding: '4px 8px', background: '#ef4444', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}
                            title="إلغاء">✕</button>
                        </>
                      ) : (
                        <>
                          <button onClick={() => { setEditingTeamId(team.id); setEditingTeamName(team.name); }}
                            style={{ padding: '4px 8px', background: isSelected ? 'rgba(255,255,255,0.2)' : 'var(--secondary-light)', border: 'none', borderRadius: '4px', cursor: 'pointer', color: isSelected ? 'white' : 'var(--text-primary)', fontSize: '12px' }}
                            title="تعديل">✏️</button>
                          <button onClick={() => handleDeleteTeam(team.id, team.name)}
                            style={{ padding: '4px 8px', background: isSelected ? 'rgba(255,255,255,0.2)' : 'var(--secondary-light)', border: 'none', borderRadius: '4px', cursor: 'pointer', color: isSelected ? 'white' : '#ef4444', fontSize: '12px' }}
                            title="حذف">🗑️</button>
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
              <div className="card-icon">❓</div>
              <span>الخطوة 2: بنك الأسئلة</span>
            </div>
            {step2Done && (
              <div style={{ background: '#10b981', color: 'white', padding: '4px 12px', borderRadius: '12px', fontSize: '12px', fontWeight: 600 }}>
                ✓ {selectedQuestions.length} سؤال
              </div>
            )}
          </div>
          <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginTop: 0 }}>
            اختر بنك الأسئلة ثم حدد الأسئلة التي ستُرسل للمحكمين.
          </p>

          <label htmlFor="bankSelect">بنك الأسئلة:</label>
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

          <label htmlFor="questionSelect" style={{ marginTop: '12px' }}>اختر الأسئلة:</label>
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
        </div>

        {/* ============ STEP 3: JUDGES ============ */}
        <div className="card" style={{ gridColumn: 'span 2' }}>
          <div className="card-header">
            <div className="card-title">
              <div className="card-icon">⚖️</div>
              <span>الخطوة 3: المحكمون</span>
            </div>
            {sessionCreated && (
              <div style={{ background: judges.length > 0 ? '#10b981' : '#f59e0b', color: 'white', padding: '4px 12px', borderRadius: '12px', fontSize: '12px', fontWeight: 600 }}>
                {judges.length > 0 ? `✓ ${judges.length} محكم انضم` : '⏳ بانتظار المحكمين'}
              </div>
            )}
          </div>

          {!sessionCreated ? (
            <>
              <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginTop: 0 }}>
                بعد إكمال الخطوتين 1 و 2، أنشئ الجلسة للحصول على رابط خاص ترسله للمحكمين.
              </p>
              <button
                className="btn btn-primary"
                onClick={handleCreateSession}
                disabled={!step1Done || !step2Done || creating}
                style={{ width: '100%' }}
                title={!step1Done ? 'أكمل الخطوة 1 أولاً' : !step2Done ? 'أكمل الخطوة 2 أولاً' : ''}
              >
                <span>🔗</span>
                {creating ? 'جاري الإنشاء...' : 'إنشاء الجلسة ورابط المحكمين'}
              </button>
              {(!step1Done || !step2Done) && (
                <p style={{ color: '#f59e0b', fontSize: '13px', textAlign: 'center', marginBottom: 0 }}>
                  {!step1Done ? '← أكمل الخطوة 1: حدد فريقًا واحدًا على الأقل' : '← أكمل الخطوة 2: اختر سؤالًا واحدًا على الأقل'}
                </p>
              )}
            </>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '20px' }}>
              {/* Judge link panel */}
              <div style={{ padding: '16px', background: 'var(--secondary-light)', borderRadius: '12px' }}>
                <h3 style={{ marginTop: 0, fontSize: '16px' }}>🔗 رابط انضمام المحكمين</h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>
                  أرسل هذا الرابط للمحكمين — كل جلسة لها رابط خاص لا يتعارض مع الجلسات الأخرى.
                </p>
                <div style={{
                  fontFamily: 'monospace', fontSize: '13px', background: 'white', padding: '10px',
                  borderRadius: '8px', border: '2px solid var(--border-color)',
                  wordBreak: 'break-all', marginBottom: '10px', direction: 'ltr', textAlign: 'left'
                }}>
                  {judgeUrl}
                </div>
                <div style={{ textAlign: 'center', marginBottom: '10px' }}>
                  <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>كود الجلسة:</span>
                  <span style={{ fontFamily: 'monospace', fontSize: '28px', fontWeight: 700, display: 'block', letterSpacing: '2px' }}>
                    {sessionId}
                  </span>
                </div>
                <button className="btn btn-secondary" onClick={handleCopyLink} style={{ width: '100%' }}>
                  <span>{copied ? '✅' : '📋'}</span>
                  {copied ? 'تم النسخ!' : 'نسخ الرابط'}
                </button>
              </div>

              {/* Live judges list */}
              <div>
                <h3 style={{ marginTop: 0, fontSize: '16px' }}>⚖️ المحكمون المنضمون ({judges.length})</h3>
                <ul style={{ listStyle: 'none', padding: 0, margin: 0, maxHeight: '220px', overflowY: 'auto' }}>
                  {judges.length === 0 ? (
                    <li className="empty-state">بانتظار انضمام المحكمين عبر الرابط...</li>
                  ) : (
                    judges.map(judge => (
                      <li key={judge.id} style={{
                        display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 12px',
                        background: '#f0fdf4', border: '2px solid #10b981', borderRadius: '8px', marginBottom: '8px'
                      }}>
                        <span style={{ fontSize: '18px' }}>👤</span>
                        <span style={{ fontWeight: 600 }}>{judge.name}</span>
                      </li>
                    ))
                  )}
                </ul>

                <button className="btn btn-success" onClick={handleStartJudging} style={{ width: '100%', marginTop: '12px' }}>
                  <span>🚀</span>
                  بدء جلسة التحكيم {judges.length > 0 ? `(${judges.length} محكم)` : ''}
                </button>
                {judges.length === 0 && (
                  <p style={{ color: '#f59e0b', fontSize: '13px', textAlign: 'center', marginBottom: 0 }}>
                    يمكنك البدء الآن والمحكمون ينضمون لاحقًا، لكن يُفضّل انتظار انضمامهم
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
