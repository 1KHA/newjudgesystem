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
import {
  ArrowRight, Users, Send, Scale, FileText, Trophy, Plus, BarChart3, HeartPulse,
  Wifi, WifiOff, RefreshCw, ChevronLeft, ChevronRight, Square, CheckCircle2, Clock, UserRound
} from 'lucide-react';
import BrandHeader from '../components/BrandHeader';
import LoadingScreen from '../components/LoadingScreen';

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

  // Connection health (shared store visible on /health page too)
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

  // Cleanup subscriptions when the component unmounts
  useEffect(() => {
    return () => {
      if (subscriptionCleanupRef.current) {
        console.log('Component unmounting, cleaning up subscriptions');
        subscriptionCleanupRef.current();
        subscriptionCleanupRef.current = null;
      }
    };
  }, []);

  // Health monitoring — detect stale connections and reconnect
  useEffect(() => {
    const healthCheck = setInterval(() => {
      if (!sessionIdRef.current) return;
      if (healthStore.isStale()) {
        console.warn('Connection appears stale (no heartbeat for 60s), reconnecting...');
        reconnectRef.current();
      }
    }, HEALTH_CHECK_INTERVAL_MS);
    return () => clearInterval(healthCheck);
  }, []);

  // Device wake detection — reconnect after sleep / tab refocus
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible' || !sessionIdRef.current) return;
      console.log('Page became visible, checking connection...');
      if (healthStore.isStale(WAKE_THRESHOLD_MS)) {
        console.log('Connection may be stale after sleep, reconnecting...');
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
    console.log('Setting up real-time subscriptions for session:', sid, 'at', new Date().toISOString());

    if (subscriptionCleanupRef.current) {
      console.log('Cleaning up old subscriptions');
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
        console.log('Judges channel status:', status, 'at', new Date().toISOString());
        healthStore.updateChannelStatus(judgesChannelName, status);
        if (status === 'SUBSCRIBED') {
          healthStore.setStatus('connected');
        } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          healthStore.setStatus('disconnected');
          if (status === 'CHANNEL_ERROR') {
            setTimeout(() => {
              console.log('Auto-retrying connection after channel error...');
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
        console.log('Answers channel status:', status, 'at', new Date().toISOString());
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
        console.log('Results channel status:', status, 'at', new Date().toISOString());
        healthStore.updateChannelStatus(resultsChannelName, status);
      });

    subscriptionCleanupRef.current = () => {
      console.log('Unsubscribing from all channels');
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

    console.log('Reconnecting subscriptions...');
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
    console.log('Reconnection complete');
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
      console.log('Questions broadcasted successfully to team:', currentTeam);
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
    return <LoadingScreen message="جاري تحميل الجلسة..." />;
  }

  const allSubmitted = judges.length > 0 && totalQuestions > 0 &&
    judges.every(j => judgeSubmissions[j.id] === totalQuestions);

  const connMeta = {
    connected: { icon: Wifi, label: 'متصل', cls: 'conn-chip--connected' },
    reconnecting: { icon: RefreshCw, label: 'إعادة الاتصال...', cls: 'conn-chip--reconnecting' },
    disconnected: { icon: WifiOff, label: 'غير متصل', cls: 'conn-chip--disconnected' }
  }[health.status];
  const ConnIcon = connMeta.icon;

  return (
    <div className="app-shell">
      <BrandHeader title="التحكم بالجلسة">
        <span className="session-badge" style={{ background: 'rgba(255,255,255,0.14)', color: '#fff' }}>
          <span>معرف الجلسة</span>
          <span className="session-badge__code">{sessionId}</span>
        </span>
        <Link to="/health" className={`conn-chip ${connMeta.cls}`} title="عرض صفحة صحة الاتصال">
          <ConnIcon className={health.status === 'reconnecting' ? 'spin' : ''} />
          {connMeta.label}
        </Link>
        <Link to="/host" className="btn btn-sm btn-pill btn-on-blue">
          <ArrowRight />
          جلساتي
        </Link>
      </BrandHeader>

      <div className="container">
        <div className="page-head">
          <div>
            <h1>التحكم بجلسة التحكيم</h1>
            <p>اختر الفريق، أرسل الأسئلة، وتابع إرسالات المحكمين في الوقت الفعلي.</p>
          </div>
        </div>

        {/* Step-by-step control guide */}
        <div className="card card--flat mb-6" style={{ padding: '14px 20px' }}>
          <div className="stepper">
            <span className="step step--active"><span className="step__num">١</span> اختر الفريق الحالي</span>
            <span className="step__arrow"><ChevronLeft /></span>
            <span className="step"><span className="step__num">٢</span> أرسل الأسئلة</span>
            <span className="step__arrow"><ChevronLeft /></span>
            <span className="step"><span className="step__num">٣</span> تابع إرسالات المحكمين</span>
            <span className="step__arrow"><ChevronLeft /></span>
            <span className="step"><span className="step__num">٤</span> انتقل للفريق التالي وكرر</span>
          </div>
        </div>

        <div className="dashboard-grid">
          {/* Current Team Card */}
          <div className="card">
            <div className="card-header">
              <div className="card-title">
                <div className="card-icon"><Users /></div>
                <span>الفريق الحالي ({currentTeamIndex + 1}/{teams.length})</span>
              </div>
            </div>
            <div className="team-display">
              <div className="team-display__label">يتم تحكيم</div>
              <div className="team-name">{currentTeam}</div>
            </div>
            {sentForTeam === currentTeam && currentTeam !== 'لا يوجد' && (
              <div className="alert alert-success mb-3">
                <CheckCircle2 />
                <span>تم إرسال {sentCount} سؤال لهذا الفريق إلى المحكمين</span>
              </div>
            )}
            <div className="btn-group">
              <button className="btn btn-secondary" onClick={handlePreviousTeam}>
                <ChevronRight />
                السابق
              </button>
              <button className="btn btn-secondary" onClick={handleNextTeam}>
                التالي
                <ChevronLeft />
              </button>
              <button className="btn btn-danger" onClick={handleEndSession}>
                <Square />
                إنهاء
              </button>
            </div>
          </div>

          {/* Send Questions Card */}
          <div className="card">
            <div className="card-header">
              <div className="card-title">
                <div className="card-icon"><Send /></div>
                <span>إرسال الأسئلة</span>
              </div>
            </div>

            {preparedQuestions.length > 0 ? (
              <>
                <p className="card-desc">
                  الأسئلة المجهزة من صفحة الإعداد ({preparedQuestions.length} سؤال) ستُرسل للفريق الحالي: <strong>{currentTeam}</strong>
                </p>
                <ol style={{ maxHeight: '220px', overflowY: 'auto', paddingInlineStart: '22px', fontSize: '14px' }}>
                  {preparedQuestions.map(q => (
                    <li key={q.id} className="mb-2">{q.text}</li>
                  ))}
                </ol>
              </>
            ) : (
              <>
                <div className="field">
                  <label htmlFor="bankSelect">بنك الأسئلة</label>
                  <select id="bankSelect" value={selectedBank} onChange={(e) => handleBankChange(e.target.value)}>
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
                </div>
              </>
            )}

            <button className="btn btn-primary btn-lg btn-block mt-3" onClick={handleSendQuestions}>
              <Send />
              إرسال {questionsToSend.length > 0 ? `(${questionsToSend.length} سؤال)` : 'الأسئلة'} إلى {currentTeam}
            </button>
          </div>

          {/* Judges Card */}
          <div className="card">
            <div className="card-header">
              <div className="card-title">
                <div className="card-icon"><Scale /></div>
                <span>المحكمون المتصلون</span>
              </div>
              <div className="flex gap-2 items-center">
                {judges.length > 0 && totalQuestions > 0 && (
                  <span className={`badge ${allSubmitted ? 'badge-success' : 'badge-warning'}`}>
                    {judges.filter(j => judgeSubmissions[j.id] === totalQuestions).length}/{judges.length} أرسلوا
                  </span>
                )}
                <button
                  className="btn btn-outline btn-sm btn-pill"
                  onClick={() => {
                    console.log('Manual refresh triggered');
                    reconnectSubscriptions();
                  }}
                  title="تحديث الاتصال"
                >
                  <RefreshCw />
                  تحديث
                </button>
              </div>
            </div>
            <ul className="list-plain">
              {judges.length === 0 ? (
                <li className="empty-state">
                  <Scale />
                  لا يوجد محكمون متصلون
                </li>
              ) : (
                judges.map(judge => {
                  const judgeAnswerCount = judgeSubmissions[judge.id] || 0;
                  const hasSubmitted = totalQuestions > 0 && judgeAnswerCount === totalQuestions;
                  const rowCls = hasSubmitted ? 'list-row--success' : (totalQuestions > 0 ? 'list-row--warning' : '');
                  const avatarCls = hasSubmitted ? 'avatar--success' : (totalQuestions > 0 ? 'avatar--warning' : '');

                  return (
                    <li key={judge.id} className={`list-row ${rowCls}`}>
                      <div className="list-row__main">
                        <span className={`avatar ${avatarCls}`}>
                          {hasSubmitted ? <CheckCircle2 /> : (totalQuestions > 0 ? <Clock /> : <UserRound />)}
                        </span>
                        <span className="fw-600">{judge.name}</span>
                      </div>
                      {totalQuestions > 0 && (
                        <span className={`badge ${hasSubmitted ? 'badge-success' : 'badge-warning'}`}>
                          {hasSubmitted ? 'تم الإرسال' : 'قيد الإجابة'}
                          <span className="mono">{judgeAnswerCount}/{totalQuestions}</span>
                        </span>
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
                <div className="card-icon"><FileText /></div>
                <span>الإجابات</span>
              </div>
            </div>
            <div className="answers-container">
              {Object.keys(answers).length === 0 ? (
                <div className="empty-state">
                  <FileText />
                  لم يتم استلام إجابات بعد
                </div>
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
          <div className="card span-2">
            <div className="card-header">
              <div className="card-title">
                <div className="card-icon"><Trophy /></div>
                <span>لوحة المتصدرين</span>
              </div>
            </div>
            <table className="leaderboard-table">
              <thead>
                <tr>
                  <th style={{ width: '56px' }}>#</th>
                  <th>الفريق</th>
                  <th className="num">إجمالي النقاط</th>
                </tr>
              </thead>
              <tbody>
                {leaderboard.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="empty-state">لا توجد نتائج بعد</td>
                  </tr>
                ) : (
                  leaderboard.map((entry, idx) => (
                    <tr key={idx}>
                      <td><span className={`rank-badge rank-badge--${idx + 1}`}>{idx + 1}</span></td>
                      <td className="fw-600">{entry.teamName}</td>
                      <td className="num fw-700 text-primary">{entry.totalPoints.toFixed(2)}</td>
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
            <Link to="/questions" className="btn btn-secondary btn-pill">
              <Plus />
              إضافة/تعديل الأسئلة
            </Link>
            <Link to="/results" className="btn btn-primary btn-pill">
              <BarChart3 />
              عرض النتائج
            </Link>
            <Link to="/health" className="btn btn-secondary btn-pill">
              <HeartPulse />
              صحة الاتصال
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
