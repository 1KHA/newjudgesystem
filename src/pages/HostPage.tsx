import { useState, useEffect, useRef, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import {
  healthStore,
  HEALTH_CHECK_INTERVAL_MS,
  WAKE_THRESHOLD_MS
} from '../lib/connectionHealth';
import { useConnectionHealth } from '../hooks/useConnectionHealth';
import {
  getTeams,
  getQuestionBanks,
  getQuestions,
  createSession,
  updateSession,
  getJudgesBySession,
  getAnswersBySession,
  upsertSessionResult
} from '../lib/supabaseService';
import type { Team, Question, QuestionBank, Judge, Answer, LeaderboardEntry, AnswersByTeam } from '../types';

export default function HostPage() {
  const [sessionId, setSessionId] = useState<string>('لم تبدأ');
  const [teams, setTeams] = useState<Team[]>([]);
  const [selectedTeams, setSelectedTeams] = useState<string[]>([]);
  const [currentTeam, setCurrentTeam] = useState<string>('لا يوجد');
  const [currentTeamIndex, setCurrentTeamIndex] = useState<number>(0);
  
  const [questionBanks, setQuestionBanks] = useState<QuestionBank[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [allQuestions, setAllQuestions] = useState<Question[]>([]);
  const [selectedBank, setSelectedBank] = useState<string>('');
  const [selectedQuestions, setSelectedQuestions] = useState<string[]>([]);
  
  const [judges, setJudges] = useState<Judge[]>([]);
  const [answers, setAnswers] = useState<AnswersByTeam>({});
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [judgeSubmissions, setJudgeSubmissions] = useState<{ [judgeId: string]: number }>({});
  
  // Team management state
  const [newTeamName, setNewTeamName] = useState<string>('');
  const [editingTeamId, setEditingTeamId] = useState<string | null>(null);
  const [editingTeamName, setEditingTeamName] = useState<string>('');

  // Connection health (shared store → visible on /health page too)
  const health = useConnectionHealth();
  // Refs so intervals/listeners never hold stale closures
  const subscriptionCleanupRef = useRef<(() => void) | null>(null);
  const reconnectRef = useRef<() => void>(() => {});
  const sessionIdRef = useRef<string>(sessionId);
  sessionIdRef.current = sessionId;

  // Load initial data
  useEffect(() => {
    loadInitialData();
    checkExistingSession();
  }, []);

  // Recalculate judge submissions when team or questions change
  useEffect(() => {
    if (sessionId !== 'لم تبدأ' && currentTeam !== 'لا يوجد') {
      console.log('🔄 Recalculating submissions for team:', currentTeam);
      loadAnswers(sessionId);
    }
  }, [currentTeam, selectedQuestions.length, sessionId]);

  // ✅ Fix #1: cleanup subscriptions when the component unmounts
  useEffect(() => {
    return () => {
      if (subscriptionCleanupRef.current) {
        console.log('🧹 Component unmounting, cleaning up subscriptions');
        subscriptionCleanupRef.current();
        subscriptionCleanupRef.current = null;
      }
    };
  }, []);

  // ✅ Fix #2: health monitoring — detect stale connections and reconnect
  useEffect(() => {
    const healthCheck = setInterval(() => {
      if (sessionIdRef.current === 'لم تبدأ') return;
      if (healthStore.isStale()) {
        console.warn('⚠️ Connection appears stale (no heartbeat for 60s), reconnecting...');
        reconnectRef.current();
      }
    }, HEALTH_CHECK_INTERVAL_MS);

    return () => clearInterval(healthCheck);
  }, []);

  // ✅ Fix #3: device wake detection — reconnect after sleep / tab refocus
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      if (sessionIdRef.current === 'لم تبدأ') return;

      console.log('📱 Page became visible, checking connection...');
      if (healthStore.isStale(WAKE_THRESHOLD_MS)) {
        console.log('⚠️ Connection may be stale after sleep, reconnecting...');
        healthStore.setStatus('reconnecting');
        // Small delay to let the network stabilize after wake
        setTimeout(() => reconnectRef.current(), 1000);
      } else {
        console.log('✅ Connection appears healthy');
      }
    };

    const handleFocus = () => {
      if (sessionIdRef.current === 'لم تبدأ') return;
      console.log('🔍 Window focused, verifying connection...');
      if (healthStore.isStale()) {
        reconnectRef.current();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleFocus);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleFocus);
    };
  }, []);

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

  const checkExistingSession = async () => {
    const savedSessionId = localStorage.getItem('hostSessionId');
    const savedHostToken = localStorage.getItem('hostToken');
    
    if (savedSessionId && savedHostToken) {
      setSessionId(savedSessionId);
      subscribeToSession(savedSessionId);
      // Load initial judges
      await loadJudges(savedSessionId);
    }
  };

  const subscribeToSession = (sessionId: string) => {
    console.log('🔌 Setting up real-time subscriptions for session:', sessionId, 'at', new Date().toISOString());

    // ✅ Fix #1: clean up old subscriptions FIRST so channels never leak
    if (subscriptionCleanupRef.current) {
      console.log('🧹 Cleaning up old subscriptions');
      subscriptionCleanupRef.current();
      subscriptionCleanupRef.current = null;
    }

    healthStore.startSession(sessionId);

    // Subscribe to judges changes
    const judgesChannelName = `judges-${sessionId}`;
    healthStore.registerChannel(judgesChannelName);
    const judgesChannel = supabase
      .channel(judgesChannelName)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'judges', filter: `session_id=eq.${sessionId}` },
        (payload) => {
          console.log('Judge change detected:', payload);
          healthStore.noteChannelEvent(judgesChannelName); // ✅ Fix #4: heartbeat on activity
          loadJudges(sessionId);
        }
      )
      .subscribe((status) => {
        console.log('👥 Judges channel status:', status, 'at', new Date().toISOString());
        healthStore.updateChannelStatus(judgesChannelName, status);
        // ✅ Fix #2/#7: track connection status + auto-retry on error
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

    // Subscribe to answers changes
    const answersChannelName = `answers-${sessionId}`;
    healthStore.registerChannel(answersChannelName);
    const answersChannel = supabase
      .channel(answersChannelName)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'answers', filter: `session_id=eq.${sessionId}` },
        (payload) => {
          console.log('Answer change detected:', payload);
          healthStore.noteChannelEvent(answersChannelName); // ✅ Fix #4: heartbeat on activity
          loadAnswers(sessionId);
        }
      )
      .subscribe((status) => {
        console.log('📝 Answers channel status:', status, 'at', new Date().toISOString());
        healthStore.updateChannelStatus(answersChannelName, status);
      });

    // Subscribe to results changes
    const resultsChannelName = `results-${sessionId}`;
    healthStore.registerChannel(resultsChannelName);
    const resultsChannel = supabase
      .channel(resultsChannelName)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'session_results', filter: `session_id=eq.${sessionId}` },
        (payload) => {
          console.log('Results change detected:', payload);
          healthStore.noteChannelEvent(resultsChannelName); // ✅ Fix #4: heartbeat on activity
          loadLeaderboard(sessionId);
        }
      )
      .subscribe((status) => {
        console.log('🏆 Results channel status:', status, 'at', new Date().toISOString());
        healthStore.updateChannelStatus(resultsChannelName, status);
      });

    // ✅ Fix #1: STORE the cleanup function so old channels are always closed
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

  // ✅ Fix #2: full reconnect — close old channels, resubscribe, reload data
  const reconnectSubscriptions = useCallback(() => {
    const currentSessionId = sessionIdRef.current;
    if (currentSessionId === 'لم تبدأ') return;

    console.log('🔄 Reconnecting subscriptions...');
    healthStore.noteReconnect();
    healthStore.setStatus('reconnecting');

    if (subscriptionCleanupRef.current) {
      subscriptionCleanupRef.current();
      subscriptionCleanupRef.current = null;
    }

    subscribeToSession(currentSessionId);

    // Reload data so nothing is missed while disconnected
    loadJudges(currentSessionId);
    loadAnswers(currentSessionId);
    loadLeaderboard(currentSessionId);

    healthStore.heartbeat();
    console.log('✅ Reconnection complete');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  reconnectRef.current = reconnectSubscriptions;

  const loadJudges = async (sessionId: string) => {
    try {
      healthStore.heartbeat(); // ✅ Fix #4: heartbeat on successful data load
      const judgesData = await getJudgesBySession(sessionId);
      setJudges(judgesData);
    } catch (error) {
      console.error('Error loading judges:', error);
    }
  };

  const loadAnswers = async (sessionId: string) => {
    try {
      healthStore.heartbeat(); // ✅ Fix #4: heartbeat on successful data load
      const answersData = await getAnswersBySession(sessionId);
      const judgesData = await getJudgesBySession(sessionId);
      
      // Create a map of judge IDs to names
      const judgeMap = new Map(judgesData.map(judge => [judge.id, judge.name]));
      
      // Group answers by team
      const grouped: AnswersByTeam = {};
      answersData.forEach(answer => {
        const teamName = answer.team_id;
        if (!grouped[teamName]) {
          grouped[teamName] = [];
        }
        grouped[teamName].push({
          player: judgeMap.get(answer.judge_id) || answer.judge_id, // Use judge name or fallback to ID
          answer: answer.answer
        });
      });
      setAnswers(grouped);
      
      // Calculate judge submissions for current team
      const submissions: { [judgeId: string]: number } = {};
      answersData
        .filter(answer => answer.team_id === currentTeam)
        .forEach(answer => {
          if (!submissions[answer.judge_id]) {
            submissions[answer.judge_id] = 0;
          }
          submissions[answer.judge_id]++;
        });
      setJudgeSubmissions(submissions);
      
      console.log('Answers loaded and grouped:', grouped);
      console.log('Judge submissions for current team:', submissions);
      
      // Also update leaderboard when answers change
      await loadLeaderboard(sessionId);
    } catch (error) {
      console.error('Error loading answers:', error);
    }
  };

  const loadLeaderboard = async (sessionId: string) => {
    try {
      healthStore.heartbeat(); // ✅ Fix #4: heartbeat on successful data load
      // Always calculate from real-time answers for live sessions
      // This ensures we show weighted points as they come in
      await calculateLeaderboardFromAnswers(sessionId);
      
      console.log('Leaderboard loaded from real-time answers');
    } catch (error) {
      console.error('Error loading leaderboard:', error);
    }
  };

  const calculateLeaderboardFromAnswers = async (sessionId: string) => {
    try {
      const answersData = await getAnswersBySession(sessionId);
      
      // Calculate weighted scores per team using answer.points
      const teamScores: { [key: string]: number } = {};
      answersData.forEach(answer => {
        const teamName = answer.team_id;
        if (!teamScores[teamName]) {
          teamScores[teamName] = 0;
        }
        // Use the weighted points from the answer (calculated by judge page)
        teamScores[teamName] += (answer.points || 1);
      });
      
      // Convert to leaderboard format and sort
      const leaderboardData = Object.entries(teamScores)
        .map(([teamName, totalPoints]) => ({
          teamName,
          totalPoints
        }))
        .sort((a, b) => b.totalPoints - a.totalPoints);
      
      setLeaderboard(leaderboardData);
      console.log('Real-time leaderboard calculated with weighted points:', leaderboardData);
    } catch (error) {
      console.error('Error calculating leaderboard:', error);
    }
  };

  const handleSetTeams = async () => {
    if (selectedTeams.length === 0) {
      alert('يرجى اختيار فريق واحد على الأقل');
      return;
    }

    try {
      const newSessionId = crypto.randomUUID().substring(0, 8);
      const newHostToken = crypto.randomUUID();
      
      const session = await createSession({
        name: `Session ${new Date().toISOString()}`,
        session_id: newSessionId,
        host_token: newHostToken,
        teams: selectedTeams,
        total_points: 100
      });

      setSessionId(session.session_id);
      setCurrentTeam(selectedTeams[0]);
      setCurrentTeamIndex(0);

      localStorage.setItem('hostSessionId', session.session_id);
      localStorage.setItem('hostToken', newHostToken);

      subscribeToSession(session.session_id);
      await loadJudges(session.session_id);
      alert(`تم إنشاء الجلسة: ${session.session_id}`);
    } catch (error) {
      console.error('Error creating session:', error);
      alert('خطأ في إنشاء الجلسة');
    }
  };

  const handlePreviousTeam = async () => {
    if (selectedTeams.length === 0) return;
    
    const newIndex = currentTeamIndex > 0 ? currentTeamIndex - 1 : selectedTeams.length - 1;
    setCurrentTeamIndex(newIndex);
    setCurrentTeam(selectedTeams[newIndex]);

    if (sessionId !== 'لم تبدأ') {
      await updateSession(sessionId, {
        current_team_index: newIndex,
        current_team_id: selectedTeams[newIndex]
      });
    }
  };

  const handleNextTeam = async () => {
    if (selectedTeams.length === 0) return;
    
    const newIndex = currentTeamIndex < selectedTeams.length - 1 ? currentTeamIndex + 1 : 0;
    setCurrentTeamIndex(newIndex);
    setCurrentTeam(selectedTeams[newIndex]);

    if (sessionId !== 'لم تبدأ') {
      await updateSession(sessionId, {
        current_team_index: newIndex,
        current_team_id: selectedTeams[newIndex]
      });
    }
  };

  const handleEndSession = async () => {
    if (sessionId === 'لم تبدأ') return;
    
    if (!confirm('هل أنت متأكد من إنهاء الجلسة؟ سيتم حفظ النتائج النهائية.')) return;

    try {
      // Calculate and save final results for all teams
      const answersData = await getAnswersBySession(sessionId);
      
      // Group answers by team and calculate scores
      const teamScores: { [key: string]: { answers: Answer[], totalPoints: number } } = {};
      answersData.forEach(answer => {
        if (!teamScores[answer.team_id]) {
          teamScores[answer.team_id] = { answers: [], totalPoints: 0 };
        }
        teamScores[answer.team_id].answers.push(answer);
        teamScores[answer.team_id].totalPoints += (answer.points || 1);
      });
      
      // Save results for each team
      const savePromises = Object.entries(teamScores).map(([teamId, data]) => {
        return upsertSessionResult({
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
        });
      });
      
      await Promise.all(savePromises);
      console.log('✅ Session results saved successfully');
      
      // Mark session as completed (update with end time)
      await updateSession(sessionId, {
        current_team_id: 'completed'
      });
      
      // ✅ Clean up realtime subscriptions when the session ends
      if (subscriptionCleanupRef.current) {
        subscriptionCleanupRef.current();
        subscriptionCleanupRef.current = null;
      }
      healthStore.endSession();

      // Clear local state but DON'T delete from database
      localStorage.removeItem('hostSessionId');
      localStorage.removeItem('hostToken');
      
      setSessionId('لم تبدأ');
      setCurrentTeam('لا يوجد');
      setSelectedTeams([]);
      setJudges([]);
      setAnswers({});
      setLeaderboard([]);
      
      alert(`تم إنهاء الجلسة وحفظ النتائج بنجاح!\nعدد الفرق: ${Object.keys(teamScores).length}\nإجمالي الإجابات: ${answersData.length}`);
    } catch (error) {
      console.error('Error ending session:', error);
      alert('خطأ في إنهاء الجلسة: ' + (error as Error).message);
    }
  };

  const handleBankChange = async (bankId: string) => {
    setSelectedBank(bankId);
    
    if (bankId) {
      const bankQuestions = allQuestions.filter(q => q.bank_id === bankId);
      setQuestions(bankQuestions);
    } else {
      setQuestions(allQuestions);
    }
  };

  const handleSendQuestions = async () => {
    if (selectedQuestions.length === 0) {
      alert('يرجى اختيار سؤال واحد على الأقل');
      return;
    }

    if (sessionId === 'لم تبدأ') {
      alert('يرجى إنشاء جلسة أولاً');
      return;
    }

    if (currentTeam === 'لا يوجد') {
      alert('يرجى اختيار فريق أولاً');
      return;
    }

    try {
      const questionsToSend = questions.filter(q => selectedQuestions.includes(q.id));
      
      // Update session with BOTH questions AND current team
      await updateSession(sessionId, {
        current_questions: questionsToSend,
        current_team_id: currentTeam  // Save current team to database
      });

      console.log('✅ Session updated with questions and team:', currentTeam);

      // Broadcast to judges via Supabase Realtime
      const channel = supabase.channel(`session-${sessionId}`, {
        config: {
          broadcast: { self: true }
        }
      });
      
      // Subscribe first, then send
      await new Promise((resolve) => {
        channel.subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            resolve(true);
          }
        });
      });

      await channel.send({
        type: 'broadcast',
        event: 'new-questions',
        payload: {
          questions: questionsToSend,
          currentTeam: currentTeam,
          teamId: currentTeam
        }
      });

      console.log('✅ Questions broadcasted successfully with team:', currentTeam);
      alert('تم إرسال الأسئلة بنجاح');
      
      // Unsubscribe after sending
      setTimeout(() => {
        channel.unsubscribe();
      }, 1000);
    } catch (error) {
      console.error('Error sending questions:', error);
      alert('خطأ في إرسال الأسئلة');
    }
  };

  // Team CRUD operations
  const handleAddTeam = async () => {
    if (!newTeamName.trim()) {
      alert('يرجى إدخال اسم الفريق');
      return;
    }

    // Check for duplicate
    if (teams.some(t => t.name === newTeamName.trim())) {
      alert('اسم الفريق موجود بالفعل');
      return;
    }

    try {
      const { error } = await supabase
        .from('teams')
        .insert({ name: newTeamName.trim() });
      
      if (error) throw error;
      
      setNewTeamName('');
      await loadInitialData();
      alert('تم إضافة الفريق بنجاح');
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

    // Check for duplicate (excluding current team)
    if (teams.some(t => t.id !== teamId && t.name === newName.trim())) {
      alert('اسم الفريق موجود بالفعل');
      return;
    }

    try {
      const { error } = await supabase
        .from('teams')
        .update({ name: newName.trim() })
        .eq('id', teamId);
      
      if (error) throw error;
      
      setEditingTeamId(null);
      setEditingTeamName('');
      await loadInitialData();
      alert('تم تحديث الفريق بنجاح');
    } catch (error) {
      console.error('Error updating team:', error);
      alert('خطأ في تحديث الفريق');
    }
  };

  const handleDeleteTeam = async (teamId: string, teamName: string) => {
    if (!confirm(`هل أنت متأكد من حذف الفريق "${teamName}"؟`)) {
      return;
    }

    try {
      const { error } = await supabase
        .from('teams')
        .delete()
        .eq('id', teamId);
      
      if (error) throw error;
      
      // Remove from selected teams if present
      setSelectedTeams(prev => prev.filter(t => t !== teamName));
      
      await loadInitialData();
      alert('تم حذف الفريق بنجاح');
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
    
    // Update UI immediately
    setTeams(newTeams);
    
    // Save new order to database
    try {
      const updates = newTeams.map((team, index) => 
        supabase
          .from('teams')
          .update({ display_order: index })
          .eq('id', team.id)
      );
      
      await Promise.all(updates);
      console.log('✅ Team order saved to database');
    } catch (error) {
      console.error('Error saving team order:', error);
      alert('خطأ في حفظ ترتيب الفرق');
      // Reload to restore correct order
      await loadInitialData();
    }
  };

  const toggleTeamSelection = (teamName: string) => {
    setSelectedTeams(prev => {
      if (prev.includes(teamName)) {
        return prev.filter(t => t !== teamName);
      } else {
        return [...prev, teamName];
      }
    });
  };

  const handleSelectAll = () => {
    setSelectedTeams(teams.map(t => t.name));
  };

  const handleDeselectAll = () => {
    setSelectedTeams([]);
  };

  return (
    <div className="container">
      <div className="header">
        <h1>إدارة التحكيم</h1>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          <div className="session-badge">
            <span>معرف الجلسة:</span>
            <span>{sessionId}</span>
          </div>

          {/* ✅ Fix #5: Connection Status Indicator */}
          <a
            href="/health"
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
          </a>
        </div>
      </div>

      <div className="dashboard-grid">
        {/* Teams Card */}
        <div className="card">
          <div className="card-header">
            <div className="card-title">
              <div className="card-icon">👥</div>
              <span>إدارة الفرق</span>
            </div>
          </div>
          
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
            <button className="btn btn-secondary" onClick={handleSelectAll} style={{ flex: 1, fontSize: '14px', padding: '8px' }}>
              ✓ تحديد الكل
            </button>
            <button className="btn btn-secondary" onClick={handleDeselectAll} style={{ flex: 1, fontSize: '14px', padding: '8px' }}>
              ✕ إلغاء الكل
            </button>
          </div>

          {/* Teams Grid */}
          <div style={{ 
            display: 'grid', 
            gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', 
            gap: '12px',
            marginBottom: '20px',
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
                        style={{
                          flex: 1,
                          padding: '4px 8px',
                          border: '1px solid var(--border-color)',
                          borderRadius: '4px',
                          fontSize: '14px'
                        }}
                      />
                    ) : (
                      <span style={{
                        flex: 1,
                        fontWeight: 600,
                        color: isSelected ? 'white' : 'var(--text-primary)',
                        fontSize: '14px'
                      }}>
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
                          padding: '4px 8px',
                          background: isSelected ? 'rgba(255,255,255,0.2)' : 'var(--secondary-light)',
                          border: 'none',
                          borderRadius: '4px',
                          cursor: index === 0 ? 'not-allowed' : 'pointer',
                          opacity: index === 0 ? 0.5 : 1,
                          color: isSelected ? 'white' : 'var(--text-primary)',
                          fontSize: '12px'
                        }}
                        title="تحريك لأعلى"
                      >
                        ↑
                      </button>
                      <button
                        onClick={() => handleMoveTeam(index, index + 1)}
                        disabled={index === teams.length - 1}
                        style={{
                          padding: '4px 8px',
                          background: isSelected ? 'rgba(255,255,255,0.2)' : 'var(--secondary-light)',
                          border: 'none',
                          borderRadius: '4px',
                          cursor: index === teams.length - 1 ? 'not-allowed' : 'pointer',
                          opacity: index === teams.length - 1 ? 0.5 : 1,
                          color: isSelected ? 'white' : 'var(--text-primary)',
                          fontSize: '12px'
                        }}
                        title="تحريك لأسفل"
                      >
                        ↓
                      </button>
                    </div>
                    
                    <div style={{ display: 'flex', gap: '4px' }}>
                      {isEditing ? (
                        <>
                          <button
                            onClick={() => handleEditTeam(team.id, editingTeamName)}
                            style={{
                              padding: '4px 8px',
                              background: '#10b981',
                              color: 'white',
                              border: 'none',
                              borderRadius: '4px',
                              cursor: 'pointer',
                              fontSize: '12px'
                            }}
                            title="حفظ"
                          >
                            ✓
                          </button>
                          <button
                            onClick={() => { setEditingTeamId(null); setEditingTeamName(''); }}
                            style={{
                              padding: '4px 8px',
                              background: '#ef4444',
                              color: 'white',
                              border: 'none',
                              borderRadius: '4px',
                              cursor: 'pointer',
                              fontSize: '12px'
                            }}
                            title="إلغاء"
                          >
                            ✕
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() => { setEditingTeamId(team.id); setEditingTeamName(team.name); }}
                            style={{
                              padding: '4px 8px',
                              background: isSelected ? 'rgba(255,255,255,0.2)' : 'var(--secondary-light)',
                              border: 'none',
                              borderRadius: '4px',
                              cursor: 'pointer',
                              color: isSelected ? 'white' : 'var(--text-primary)',
                              fontSize: '12px'
                            }}
                            title="تعديل"
                          >
                            ✏️
                          </button>
                          <button
                            onClick={() => handleDeleteTeam(team.id, team.name)}
                            style={{
                              padding: '4px 8px',
                              background: isSelected ? 'rgba(255,255,255,0.2)' : 'var(--secondary-light)',
                              border: 'none',
                              borderRadius: '4px',
                              cursor: 'pointer',
                              color: isSelected ? 'white' : '#ef4444',
                              fontSize: '12px'
                            }}
                            title="حذف"
                          >
                            🗑️
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Set Teams Button */}
          <button className="btn btn-primary" onClick={handleSetTeams} style={{ width: '100%', marginBottom: '16px' }}>
            <span>✓</span>
            تعيين الفرق المحددة ({selectedTeams.length})
          </button>
          
          {/* Current Team Display */}
          <div className="team-display">
            <h3>الفريق الحالي</h3>
            <div className="team-name">{currentTeam}</div>
          </div>
          
          {/* Navigation Buttons */}
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

        {/* Questions Card */}
        <div className="card">
          <div className="card-header">
            <div className="card-title">
              <div className="card-icon">❓</div>
              <span>الأسئلة</span>
            </div>
          </div>
          <div>
            <label htmlFor="bankSelect">بنك الأسئلة:</label>
            <select
              id="bankSelect"
              value={selectedBank}
              onChange={(e) => handleBankChange(e.target.value)}
            >
              <option value="">جميع الأسئلة</option>
              {questionBanks.map(bank => (
                <option key={bank.id} value={bank.id}>
                  {bank.name}
                </option>
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
                <option key={question.id} value={question.id}>
                  {question.text}
                </option>
              ))}
            </select>
            
            <button className="btn btn-success" onClick={handleSendQuestions} style={{ width: '100%', marginTop: '12px' }}>
              <span>📤</span>
              إرسال الأسئلة المحددة
            </button>
          </div>
        </div>

        {/* Judges Card */}
        <div className="card">
          <div className="card-header">
            <div className="card-title">
              <div className="card-icon">⚖️</div>
              <span>المحكمون المتصلون</span>
            </div>
            {judges.length > 0 && selectedQuestions.length > 0 && (
              <div style={{
                background: judges.filter(j => judgeSubmissions[j.id] === selectedQuestions.length).length === judges.length 
                  ? '#10b981' 
                  : '#f59e0b',
                color: 'white',
                padding: '4px 12px',
                borderRadius: '12px',
                fontSize: '12px',
                fontWeight: 600
              }}>
                {judges.filter(j => judgeSubmissions[j.id] === selectedQuestions.length).length}/{judges.length} أرسلوا
              </div>
            )}

            {/* ✅ Fix #6: Manual Refresh Button */}
            {sessionId !== 'لم تبدأ' && (
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
            )}
          </div>
          <ul className="judge-list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {judges.length === 0 ? (
              <li className="empty-state">لا يوجد محكمون متصلون</li>
            ) : (
              judges.map(judge => {
                const judgeAnswerCount = judgeSubmissions[judge.id] || 0;
                const totalQuestions = selectedQuestions.length;
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
                            <span style={{ 
                              background: '#10b981', 
                              color: 'white', 
                              padding: '2px 6px', 
                              borderRadius: '4px',
                              fontSize: '11px'
                            }}>
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
          <a href="/questions" className="btn btn-success">
            <span>➕</span>
            إضافة/تعديل الأسئلة
          </a>
          <a href="/results" className="btn btn-primary">
            <span>📊</span>
            عرض النتائج
          </a>
          <a href="/health" className="btn btn-secondary">
            <span>💓</span>
            صحة الاتصال
          </a>
        </div>
      </div>
    </div>
  );
}
