import { useState, useEffect, useRef, useCallback } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../hooks/useAuth';
import {
  healthStore,
  HEALTH_CHECK_INTERVAL_MS,
  WAKE_THRESHOLD_MS
} from '../lib/connectionHealth';
import { useConnectionHealth } from '../hooks/useConnectionHealth';
import {
  getSession,
  updateSession,
  getJudgesBySession,
  getAnswersBySession,
  getQuestionBanks,
  getQuestions,
  upsertSessionResult
} from '../lib/supabaseService';
import type { Question, QuestionBank, Judge, Answer, LeaderboardEntry, AnswersByTeam, Session } from '../types';

/**
 * Session control room — everything beyond the 3 setup steps lives here:
 * team navigation, sending questions to judges, submission tracking,
 * answers, leaderboard, connection health, ending the session.
 */
export default function ControlPage() {
  const { sessionId = '' } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [session, setSession] = useState<Session | null>(null);
  const [authorized, setAuthorized] = useState<boolean | null>(null); // null = loading

  const [currentTeam, setCurrentTeam] = useState<string>('لا يوجد');
  const [currentTeamIndex, setCurrentTeamIndex] = useState<number>(0);

  // Questions prepared during setup (same-device handoff via sessionStorage)
  const [preparedQuestions, setPreparedQuestions] = useState<Question[]>([]);
  // Fallback selector (used when resuming a session without prepared questions)
  const [questionBanks, setQuestionBanks] = useState<QuestionBank[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [allQuestions, setAllQuestions] = useState<Question[]>([]);
  const [selectedBank, setSelectedBank] = useState<string>('');
  const [selectedQuestionIds, setSelectedQuestionIds] = useState<string[]>([]);

  const [sentForTeam, setSentForTeam] = useState<string>(''); // which team questions were last sent to
  const [sentCount, setSentCount] = useState<number>(0);

  const [judges, setJudges] = useState<Judge[]>([]);
  const [answers, setAnswers] = useState<AnswersByTeam>({});
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [judgeSubmissions, setJudgeSubmissions] = useState<{ [judgeId: string]: number }>({});

  // Connection health (shared store → visible on /health page too)
  const health = useConnectionHealth();
  const subscriptionCleanupRef = useRef<(() => void) | null>(null);
  const reconnectRef = useRef<() => void>(() => {});
  const sessionIdRef = useRef<string>(sessionId);
  sessionIdRef.current = sessionId;

  const teams = session?.teams ?? [];
  const questionsToSend = preparedQuestions.length > 0
    ? preparedQuestions
    : questions.filter(q => selectedQuestionIds.includes(q.id));
  const totalQuestions = sentCount > 0 ? sentCount : questionsToSend.length;

  // ---- Load + authorize ----
  useEffect(() => {
    const init = async () => {
      if (!sessionId || !user) return;
      try {
        const data = await getSession(sessionId);
        if (!data || data.host_id !== user.id) {
          alert('هذه الجلسة غير موجودة أو لا تملك صلاحية التحكم بها');
          navigate('/host', { replace: true });
          return;
        }
        if (data.current_team_id === 'completed') {
          alert('هذه الجلسة منتهية');
          navigate('/host', { replace: true });
          return;
        }
        setSession(data);
        setAuthorized(true);

        // Restore current team
        const teamFromDb = data.current_team_id && data.current_team_id !== 'completed'
          ? data.current_team_id
          : data.teams?.[0] || 'لا يوجد';
        setCurrentTeam(teamFromDb);
        setCurrentTeamIndex(Math.max(0, data.teams?.indexOf(teamFromDb) ?? 0));

        // Restore "sent" state
        if (data.current_questions && data.current_questions.length > 0) {
          setSentForTeam(teamFromDb);
          setSentCount(data.current_questions.length);
        }

        // Prepared questions from setup
        try {
          const stored = sessionStorage.getItem(`controlQuestions_${sessionId}`);
          if (stored) setPreparedQuestions(JSON.parse(stored));
        } catch { /* ignore malformed storage */ }

        subscribeToSession(sessionId);
        await loadJudges(sessionId);
        await loadAnswers(sessionId);
      } catch (error) {
        console.error('Error loading session:', error);
        alert('خطأ في تحميل الجلسة');
        navigate('/host', { replace: true });
      }
    };
    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, user]);

  // Load fallback question selector only if no prepared questions
  useEffect(() => {
    if (authorized && preparedQuestions.length === 0) {
      (async () => {
        try {
          const [banksData, questionsData] = await Promise.all([getQuestionBanks(), getQuestions()]);
          setQuestionBanks(banksData);
          setAllQuestions(questionsData);
          setQuestions(questionsData);
        } catch (error) {
          console.error('Error loading question banks:', error);
        }
      })();
    }
  }, [authorized, preparedQuestions.length]);

  // Recalculate judge submissions when team changes
  useEffect(() => {
    if (authorized && currentTeam !== 'لا يوجد') {
      loadAnswers(sessionId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTeam, totalQuestions, authorized]);

  // ✅ Cleanup subscriptions when the component unmounts
  useEffect(() => {
    return () => {
      if (subscriptionCleanupRef.current) {
        console.log('🧹 Component unmounting, cleaning up subscriptions');
        subscriptionCleanupRef.current();
        subscriptionCleanupRef.current = null;
      }
    };
  }, []);

  // ✅ Health monitoring — detect stale connections and reconnect
  useEffect(() => {
    const healthCheck = setInterval(() => {
      if (!sessionIdRef.current) return;
      if (healthStore.isStale()) {
        console.warn('⚠️ Connection appears stale (no heartbeat for 60s), reconnecting...');
        reconnectRef.current();
      }
    }, HEALTH_CHECK_INTERVAL_MS);
    return () => clearInterval(healthCheck);
  }, []);

  // ✅ Device wake detection — reconnect after sleep / tab refocus
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible' || !sessionIdRef.current) return;
      console.log('📱 Page became visible, checking connection...');
      if (healthStore.isStale(WAKE_THRESHOLD_MS)) {
        console.log('⚠️ Connection may be stale after sleep, reconnecting...');
        healthStore.setStatus('reconnecting');
        setTimeout(() => reconnectRef.current(), 1000);
      }
    };
    const handleFocus = () => {
      if (!sessionIdRef.current) return;
      if (healthStore.isStale()) reconnectRef.current();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleFocus);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleFocus);
    };
  }, []);

  // ---- Realtime subscriptions (with health wiring) ----

  const subscribeToSession = (sid: string) => {
    console.log('🔌 Setting up real-time subscriptions for session:', sid, 'at', new Date().toISOString());

    if (subscriptionCleanupRef.current) {
      console.log('🧹 Cleaning up old subscriptions');
      subscriptionCleanupRef.current();
      subscriptionCleanupRef.current = null;
    }

    healthStore.startSession(sid);

    const judgesChannelName = `judges-${sid}`;
    healthStore.registerChannel(judgesChannelName);
    const judgesChannel = supabase
      .channel(judgesChannelName)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'judges', filter: `session_id=eq.${sid}` },
        (payload) => {
          console.log('Judge change detected:', payload);
          healthStore.noteChannelEvent(judgesChannelName);
          loadJudges(sid);
        }
      )
      .subscribe((status) => {
        console.log('👥 Judges channel status:', status, 'at', new Date().toISOString());
        healthStore.updateChannelStatus(judgesChannelName, status);
        if (status === 'SUBSCRIBED') {
          healthStore.setStatus('connected');
        } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          healthStore.setStatus('disconnected');
          if (status === 'CHANNEL_ERROR') {
            setTimeout(() => {
              console.log('🔄 Auto-retrying connection after channel error...');
              reconnectRef.current();
            }, 5000);
          }
        }
      });

    const answersChannelName = `answers-${sid}`;
    healthStore.registerChannel(answersChannelName);
    const answersChannel = supabase
      .channel(answersChannelName)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'answers', filter: `session_id=eq.${sid}` },
        (payload) => {
          console.log('Answer change detected:', payload);
          healthStore.noteChannelEvent(answersChannelName);
          loadAnswers(sid);
        }
      )
      .subscribe((status) => {
        console.log('📝 Answers channel status:', status, 'at', new Date().toISOString());
        healthStore.updateChannelStatus(answersChannelName, status);
      });

    const resultsChannelName = `results-${sid}`;
    healthStore.registerChannel(resultsChannelName);
    const resultsChannel = supabase
      .channel(resultsChannelName)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'session_results', filter: `session_id=eq.${sid}` },
        (payload) => {
          console.log('Results change detected:', payload);
          healthStore.noteChannelEvent(resultsChannelName);
          loadLeaderboard(sid);
        }
      )
      .subscribe((status) => {
        console.log('🏆 Results channel status:', status, 'at', new Date().toISOString());
        healthStore.updateChannelStatus(resultsChannelName, status);
      });

    subscriptionCleanupRef.current = () => {
      console.log('🧹 Unsubscribing from all channels');
      healthStore.removeChannel(judgesChannelName);
      healthStore.removeChannel(answersChannelName);
      healthStore.removeChannel(resultsChannelName);
      judgesChannel.unsubscribe();
      answersChannel.unsubscribe();
      resultsChannel.unsubscribe();
    };
  };

  const reconnectSubscriptions = useCallback(() => {
    const currentSessionId = sessionIdRef.current;
    if (!currentSessionId) return;

    console.log('🔄 Reconnecting subscriptions...');
    healthStore.noteReconnect();
    healthStore.setStatus('reconnecting');

    if (subscriptionCleanupRef.current) {
      subscriptionCleanupRef.current();
      subscriptionCleanupRef.current = null;
    }

    subscribeToSession(currentSessionId);
    loadJudges(currentSessionId);
    loadAnswers(currentSessionId);
    loadLeaderboard(currentSessionId);

    healthStore.heartbeat();
    console.log('✅ Reconnection complete');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  reconnectRef.current = reconnectSubscriptions;

  // ---- Data loaders ----

  const loadJudges = async (sid: string) => {
    try {
      healthStore.heartbeat();
      const judgesData = await getJudgesBySession(sid);
      setJudges(judgesData);
    } catch (error) {
      console.error('Error loading judges:', error);
    }
  };

  const loadAnswers = async (sid: string) => {
    try {
      healthStore.heartbeat();
      const answersData = await getAnswersBySession(sid);
      const judgesData = await getJudgesBySession(sid);

      const judgeMap = new Map(judgesData.map(judge => [judge.id, judge.name]));

      const grouped: AnswersByTeam = {};
      answersData.forEach(answer => {
        const teamName = answer.team_id;
        if (!grouped[teamName]) grouped[teamName] = [];
        grouped[teamName].push({
          player: judgeMap.get(answer.judge_id) || answer.judge_id,
          answer: answer.answer
        });
      });
      setAnswers(grouped);

      const submissions: { [judgeId: string]: number } = {};
      answersData
        .filter(answer => answer.team_id === currentTeam)
        .forEach(answer => {
          submissions[answer.judge_id] = (submissions[answer.judge_id] || 0) + 1;
        });
      setJudgeSubmissions(submissions);

      await loadLeaderboard(sid);
    } catch (error) {
      console.error('Error loading answers:', error);
    }
  };

  const loadLeaderboard = async (sid: string) => {
    try {
      healthStore.heartbeat();
      const answersData = await getAnswersBySession(sid);

      const teamScores: { [key: string]: number } = {};
      answersData.forEach(answer => {
        teamScores[answer.team_id] = (teamScores[answer.team_id] || 0) + (answer.points || 1);
      });

      const leaderboardData = Object.entries(teamScores)
        .map(([teamName, totalPoints]) => ({ teamName, totalPoints }))
        .sort((a, b) => b.totalPoints - a.totalPoints);

      setLeaderboard(leaderboardData);
    } catch (error) {
      console.error('Error calculating leaderboard:', error);
    }
  };

  // ---- Session control actions ----

  const handlePreviousTeam = async () => {
    if (teams.length === 0) return;
    const newIndex = currentTeamIndex > 0 ? currentTeamIndex - 1 : teams.length - 1;
    setCurrentTeamIndex(newIndex);
    setCurrentTeam(teams[newIndex]);
    await updateSession(sessionId, {
      current_team_index: newIndex,
      current_team_id: teams[newIndex]
    });
  };

  const handleNextTeam = async () => {
    if (teams.length === 0) return;
    const newIndex = currentTeamIndex < teams.length - 1 ? currentTeamIndex + 1 : 0;
    setCurrentTeamIndex(newIndex);
    setCurrentTeam(teams[newIndex]);
    await updateSession(sessionId, {
      current_team_index: newIndex,
      current_team_id: teams[newIndex]
    });
  };

  const handleSendQuestions = async () => {
    if (questionsToSend.length === 0) {
      alert('يرجى اختيار سؤال واحد على الأقل');
      return;
    }
    if (currentTeam === 'لا يوجد') {
      alert('يرجى اختيار فريق أولاً');
      return;
    }

    try {
      await updateSession(sessionId, {
        current_questions: questionsToSend,
        current_team_id: currentTeam
      });

      const channel = supabase.channel(`session-${sessionId}`, {
        config: { broadcast: { self: true } }
      });
      await new Promise((resolve) => {
        channel.subscribe((status) => {
          if (status === 'SUBSCRIBED') resolve(true);
        });
      });
      await channel.send({
        type: 'broadcast',
        event: 'new-questions',
        payload: { questions: questionsToSend, currentTeam, teamId: currentTeam }
      });
      setTimeout(() => channel.unsubscribe(), 1000);

      setSentForTeam(currentTeam);
      setSentCount(questionsToSend.length);
      console.log('✅ Questions broadcasted successfully to team:', currentTeam);
    } catch (error) {
      console.error('Error sending questions:', error);
      alert('خطأ في إرسال الأسئلة');
    }
  };

  const handleEndSession = async () => {
    if (!confirm('هل أنت متأكد من إنهاء الجلسة؟ سيتم حفظ النتائج النهائية.')) return;

    try {
      const answersData = await getAnswersBySession(sessionId);

      const teamScores: { [key: string]: { answers: Answer[], totalPoints: number } } = {};
      answersData.forEach(answer => {
        if (!teamScores[answer.team_id]) {
          teamScores[answer.team_id] = { answers: [], totalPoints: 0 };
        }
        teamScores[answer.team_id].answers.push(answer);
        teamScores[answer.team_id].totalPoints += (answer.points || 1);
      });

      const savePromises = Object.entries(teamScores).map(([teamId, data]) =>
        upsertSessionResult({
          session_id: sessionId,
          team_id: teamId,
          total_points: data.totalPoints,
          details: {
            answers: data.answers.map(a => ({
              questionId: a.question_id,
              answer: a.answer,
              points: a.points || 1,
              judgeId: a.judge_id,
              timestamp: a.created_at
            }))
          }
        })
      );
      await Promise.all(savePromises);

      await updateSession(sessionId, { current_team_id: 'completed' });

      if (subscriptionCleanupRef.current) {
        subscriptionCleanupRef.current();
        subscriptionCleanupRef.current = null;
      }
      healthStore.endSession();
      sessionStorage.removeItem(`controlQuestions_${sessionId}`);

      alert(`تم إنهاء الجلسة وحفظ النتائج بنجاح!\nعدد الفرق: ${Object.keys(teamScores).length}\nإجمالي الإجابات: ${answersData.length}`);
      navigate('/host', { replace: true });
    } catch (error) {
      console.error('Error ending session:', error);
      alert('خطأ في إنهاء الجلسة: ' + (error as Error).message);
    }
  };

  const handleBankChange = (bankId: string) => {
    setSelectedBank(bankId);
    setSelectedQuestionIds([]);
    setQuestions(bankId ? allQuestions.filter(q => q.bank_id === bankId) : allQuestions);
  };

  // ---- Render ----

  if (authorized === null) {
    return (
      <div className="container">
        <div className="card" style={{ marginTop: '80px', textAlign: 'center', padding: '40px' }}>
          <div style={{ fontSize: '32px', marginBottom: '12px' }}>⏳</div>
          <div>جاري تحميل الجلسة...</div>
        </div>
      </div>
    );
  }

  const allSubmitted = judges.length > 0 && totalQuestions > 0 &&
    judges.every(j => judgeSubmissions[j.id] === totalQuestions);

  return (
    <div className="container">
      <div className="header">
        <h1>التحكم بجلسة التحكيم</h1>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
          <div className="session-badge">
            <span>معرف الجلسة:</span>
            <span>{sessionId}</span>
          </div>
          <Link
            to="/health"
            title="عرض صفحة صحة الاتصال"
            style={{
              padding: '8px 16px',
              borderRadius: '8px',
              background: health.status === 'connected' ? '#10b981' :
                          health.status === 'reconnecting' ? '#f59e0b' : '#ef4444',
              color: 'white',
              fontSize: '12px',
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              textDecoration: 'none'
            }}
          >
            <span>{health.status === 'connected' ? '🟢' : health.status === 'reconnecting' ? '🟡' : '🔴'}</span>
            <span>
              {health.status === 'connected' ? 'متصل' :
               health.status === 'reconnecting' ? 'إعادة الاتصال...' : 'غير متصل'}
            </span>
          </Link>
          <Link to="/host" className="btn btn-secondary" style={{ textDecoration: 'none', fontSize: '14px' }}>
            ← جلساتي
          </Link>
        </div>
      </div>

      {/* Step-by-step control guide */}
      <div className="card" style={{ marginBottom: '24px', padding: '14px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', justifyContent: 'center', fontSize: '14px', fontWeight: 600 }}>
          <span>١ اختر الفريق الحالي ◀▶</span>
          <span style={{ color: 'var(--text-secondary)' }}>←</span>
          <span>٢ أرسل الأسئلة 📤</span>
          <span style={{ color: 'var(--text-secondary)' }}>←</span>
          <span>٣ تابع إرسالات المحكمين ⏳</span>
          <span style={{ color: 'var(--text-secondary)' }}>←</span>
          <span>٤ انتقل للفريق التالي وكرر</span>
        </div>
      </div>

      <div className="dashboard-grid">
        {/* Current Team Card */}
        <div className="card">
          <div className="card-header">
            <div className="card-title">
              <div className="card-icon">👥</div>
              <span>الفريق الحالي ({currentTeamIndex + 1}/{teams.length})</span>
            </div>
          </div>
          <div className="team-display">
            <div className="team-name">{currentTeam}</div>
          </div>
          {sentForTeam === currentTeam && currentTeam !== 'لا يوجد' && (
            <div style={{
              background: '#f0fdf4', border: '2px solid #10b981', color: '#10b981',
              borderRadius: '8px', padding: '8px 12px', textAlign: 'center',
              fontWeight: 600, fontSize: '14px', marginBottom: '12px'
            }}>
              ✓ تم إرسال {sentCount} سؤال لهذا الفريق إلى المحكمين
            </div>
          )}
          <div className="btn-group">
            <button className="btn btn-secondary" onClick={handlePreviousTeam}>
              <span>◀</span>
              السابق
            </button>
            <button className="btn btn-secondary" onClick={handleNextTeam}>
              <span>▶</span>
              التالي
            </button>
            <button className="btn btn-danger" onClick={handleEndSession}>
              <span>✕</span>
              إنهاء
            </button>
          </div>
        </div>

        {/* Send Questions Card */}
        <div className="card">
          <div className="card-header">
            <div className="card-title">
              <div className="card-icon">📤</div>
              <span>إرسال الأسئلة</span>
            </div>
          </div>

          {preparedQuestions.length > 0 ? (
            <>
              <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginTop: 0 }}>
                الأسئلة المجهزة من صفحة الإعداد ({preparedQuestions.length} سؤال) — ستُرسل للفريق الحالي: <strong>{currentTeam}</strong>
              </p>
              <ul style={{ maxHeight: '220px', overflowY: 'auto', paddingRight: '20px', fontSize: '14px' }}>
                {preparedQuestions.map(q => (
                  <li key={q.id} style={{ marginBottom: '6px' }}>{q.text}</li>
                ))}
              </ul>
            </>
          ) : (
            <>
              <label htmlFor="bankSelect">بنك الأسئلة:</label>
              <select id="bankSelect" value={selectedBank} onChange={(e) => handleBankChange(e.target.value)}>
                <option value="">جميع الأسئلة</option>
                {questionBanks.map(bank => (
                  <option key={bank.id} value={bank.id}>{bank.name}</option>
                ))}
              </select>
              <label htmlFor="questionSelect" style={{ marginTop: '12px' }}>اختر الأسئلة:</label>
              <select
                id="questionSelect"
                multiple
                value={selectedQuestionIds}
                onChange={(e) => {
                  const selected = Array.from(e.target.selectedOptions, option => option.value);
                  setSelectedQuestionIds(selected);
                }}
              >
                {questions.map(question => (
                  <option key={question.id} value={question.id}>{question.text}</option>
                ))}
              </select>
            </>
          )}

          <button className="btn btn-success" onClick={handleSendQuestions} style={{ width: '100%', marginTop: '12px' }}>
            <span>📤</span>
            إرسال {questionsToSend.length > 0 ? `(${questionsToSend.length} سؤال)` : 'الأسئلة'} إلى {currentTeam}
          </button>
        </div>

        {/* Judges Card */}
        <div className="card">
          <div className="card-header">
            <div className="card-title">
              <div className="card-icon">⚖️</div>
              <span>المحكمون المتصلون</span>
            </div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              {judges.length > 0 && totalQuestions > 0 && (
                <div style={{
                  background: allSubmitted ? '#10b981' : '#f59e0b',
                  color: 'white',
                  padding: '4px 12px',
                  borderRadius: '12px',
                  fontSize: '12px',
                  fontWeight: 600
                }}>
                  {judges.filter(j => judgeSubmissions[j.id] === totalQuestions).length}/{judges.length} أرسلوا
                </div>
              )}
              <button
                onClick={() => {
                  console.log('🔄 Manual refresh triggered');
                  reconnectSubscriptions();
                }}
                style={{
                  padding: '6px 12px',
                  background: 'var(--primary-color)',
                  color: 'white',
                  border: 'none',
                  borderRadius: '8px',
                  cursor: 'pointer',
                  fontSize: '12px',
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px'
                }}
                title="تحديث الاتصال"
              >
                <span>🔄</span>
                <span>تحديث</span>
              </button>
            </div>
          </div>
          <ul className="judge-list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {judges.length === 0 ? (
              <li className="empty-state">لا يوجد محكمون متصلون</li>
            ) : (
              judges.map(judge => {
                const judgeAnswerCount = judgeSubmissions[judge.id] || 0;
                const hasSubmitted = totalQuestions > 0 && judgeAnswerCount === totalQuestions;

                return (
                  <li key={judge.id} style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '12px',
                    background: hasSubmitted ? '#f0fdf4' : (totalQuestions > 0 ? '#fef3c7' : 'white'),
                    borderRadius: '8px',
                    marginBottom: '8px',
                    border: `2px solid ${hasSubmitted ? '#10b981' : (totalQuestions > 0 ? '#f59e0b' : 'var(--border-color)')}`,
                    transition: 'all 0.2s'
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ fontSize: '20px' }}>
                        {hasSubmitted ? '✅' : (totalQuestions > 0 ? '⏳' : '👤')}
                      </span>
                      <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                        {judge.name}
                      </span>
                    </div>
                    {totalQuestions > 0 && (
                      <div style={{
                        fontSize: '12px',
                        color: hasSubmitted ? '#10b981' : '#f59e0b',
                        fontWeight: 600,
                        display: 'flex',
                        alignItems: 'center',
                        gap: '4px'
                      }}>
                        {hasSubmitted ? (
                          <>
                            <span>تم الإرسال</span>
                            <span style={{ background: '#10b981', color: 'white', padding: '2px 6px', borderRadius: '4px', fontSize: '11px' }}>
                              {judgeAnswerCount}/{totalQuestions}
                            </span>
                          </>
                        ) : (
                          <>
                            <span>{judgeAnswerCount}/{totalQuestions}</span>
                            <span>أسئلة</span>
                          </>
                        )}
                      </div>
                    )}
                  </li>
                );
              })
            )}
          </ul>
        </div>

        {/* Answers Card */}
        <div className="card">
          <div className="card-header">
            <div className="card-title">
              <div className="card-icon">📝</div>
              <span>الإجابات</span>
            </div>
          </div>
          <div className="answers-container">
            {Object.keys(answers).length === 0 ? (
              <div className="empty-state">لم يتم استلام إجابات بعد</div>
            ) : (
              Object.entries(answers).map(([team, teamAnswers]) => (
                <div key={team} className="answer-item">
                  <strong>{team}</strong>
                  <ul>
                    {teamAnswers.map((answer, idx) => (
                      <li key={idx}>{answer.player}: {answer.answer}</li>
                    ))}
                  </ul>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Leaderboard Card */}
        <div className="card" style={{ gridColumn: 'span 2' }}>
          <div className="card-header">
            <div className="card-title">
              <div className="card-icon">🏆</div>
              <span>لوحة المتصدرين</span>
            </div>
          </div>
          <table className="leaderboard-table">
            <thead>
              <tr>
                <th>الفريق</th>
                <th style={{ textAlign: 'left' }}>إجمالي النقاط</th>
              </tr>
            </thead>
            <tbody>
              {leaderboard.length === 0 ? (
                <tr>
                  <td colSpan={2} className="empty-state">لا توجد نتائج بعد</td>
                </tr>
              ) : (
                leaderboard.map((entry, idx) => (
                  <tr key={idx}>
                    <td>{entry.teamName}</td>
                    <td style={{ textAlign: 'left', fontWeight: 600, color: 'var(--primary-color)' }}>
                      {entry.totalPoints.toFixed(2)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Quick Actions */}
      <div className="quick-actions">
        <h3>الإجراءات السريعة</h3>
        <div className="action-links">
          <Link to="/questions" className="btn btn-success">
            <span>➕</span>
            إضافة/تعديل الأسئلة
          </Link>
          <Link to="/results" className="btn btn-primary">
            <span>📊</span>
            عرض النتائج
          </Link>
          <Link to="/health" className="btn btn-secondary">
            <span>💓</span>
            صحة الاتصال
          </Link>
        </div>
      </div>
    </div>
  );
}
