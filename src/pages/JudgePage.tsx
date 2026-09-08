import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { getOrCreateJudge, getJudge, submitAnswer, getLatestSession, getSession } from '../lib/supabaseService';
import { normalizeSessionParam } from '../lib/sessionRouting';
import type { Question } from '../types';
import { AlertCircle, LogIn, UserRound, CheckCircle2, Clock, Check, ListChecks, Send } from 'lucide-react';


export default function JudgePage() {
  // Unique session link support: /judge/:sessionId locks this device to that session
  const { sessionId: sessionParam } = useParams();
  const urlSessionId = normalizeSessionParam(sessionParam);
  const invalidLink = Boolean(sessionParam) && !urlSessionId;

  const [sessionId, setSessionId] = useState<string>('لم تبدأ');
  const [judgeName, setJudgeName] = useState<string>('');
  const [judgeId, setJudgeId] = useState<string>('');
  const [isLoggedIn, setIsLoggedIn] = useState<boolean>(false);
  
  const [currentTeam, setCurrentTeam] = useState<string>('لم يتم اختيار فريق');
  const [questions, setQuestions] = useState<Question[]>([]);
  const [selectedAnswers, setSelectedAnswers] = useState<{ [key: string]: string }>({});
  const [judgeState, setJudgeState] = useState<'judging' | 'waiting'>('judging');

  useEffect(() => {
    checkExistingSession();
    fetchTargetSessionId();
    subscribeToSessionChanges();
  }, []);

  // When opened via /judge/:sessionId, join THAT session (multi-session isolation).
  // Otherwise keep the old behavior: the most recently created session.
  const fetchTargetSessionId = async () => {
    try {
      if (urlSessionId) {
        const session = await getSession(urlSessionId);
        if (session && session.current_team_id !== 'completed') {
          setSessionId(session.session_id);
        } else {
          setSessionId('رابط غير صالح');
        }
        return;
      }
      const latestSession = await getLatestSession();
      if (latestSession) {
        setSessionId(latestSession.session_id);
      }
    } catch (error) {
      console.error('Error fetching session:', error);
    }
  };

  const subscribeToSessionChanges = () => {
    // A unique-link judge is locked to its session — skip latest-session discovery entirely
    if (urlSessionId) {
      return () => {};
    }

    console.log('Subscribing to session changes...');
    
    // Polling fallback - check for new sessions every 5 seconds
    const pollingInterval = setInterval(async () => {
      if (!isLoggedIn) {
        try {
          const latestSession = await getLatestSession();
          if (latestSession && latestSession.session_id !== sessionId) {
            setSessionId(latestSession.session_id);
            console.log('Polling: Updated to new session:', latestSession.session_id);
          }
        } catch (error) {
          console.error('Polling error:', error);
        }
      }
    }, 5000);

    // Try real-time subscription as well
    const sessionChannel = supabase
      .channel('sessions-monitor', {
        config: {
          broadcast: { self: false },
          presence: { key: '' }
        }
      })
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'sessions' },
        async (payload) => {
          console.log('Real-time: New session detected:', payload);
          
          if (!isLoggedIn) {
            const latestSession = await getLatestSession();
            if (latestSession) {
              setSessionId(latestSession.session_id);
              console.log('Real-time: Updated to new session:', latestSession.session_id);
            }
          }
        }
      )
      .subscribe((status) => {
        console.log('Session monitor status:', status);
        if (status === 'CHANNEL_ERROR') {
          console.warn('Real-time subscription failed, using polling fallback');
        }
      });

    return () => {
      clearInterval(pollingInterval);
      sessionChannel.unsubscribe();
    };
  };

  useEffect(() => {
    if (isLoggedIn && sessionId !== 'لم تبدأ') {
      const cleanup = subscribeToQuestions();
      const validationInterval = startSessionValidation();
      
      return () => {
        cleanup?.();
        clearInterval(validationInterval);
      };
    }
  }, [isLoggedIn, sessionId]);

  // Auto-save team name whenever it changes
  useEffect(() => {
    if (currentTeam !== 'لم يتم اختيار فريق' && sessionId !== 'لم تبدأ' && isLoggedIn) {
      localStorage.setItem('currentTeam', currentTeam);
      localStorage.setItem(`currentTeam_${sessionId}`, currentTeam);
      console.log('Auto-saved team name:', currentTeam);
    }
  }, [currentTeam, sessionId, isLoggedIn]);

  const startSessionValidation = () => {
    // Poll every 2 seconds to check if session still exists
    const interval = setInterval(async () => {
      if (isLoggedIn && sessionId !== 'لم تبدأ') {
        try {
          const { data, error } = await supabase
            .from('sessions')
            .select('session_id, current_team_id')
            .eq('session_id', sessionId)
            .single();
          
          // Check if session was deleted or marked as completed
          if (error || !data || data.current_team_id === 'completed') {
            console.log('Session ended or completed, logging out...');
            handleSessionEnd();
          }
        } catch (error) {
          console.error('Session validation error:', error);
          // If there's an error fetching the session, it likely doesn't exist
          handleSessionEnd();
        }
      }
    }, 2000);
    
    return interval;
  };

  const checkExistingSession = () => {
    const savedSessionId = localStorage.getItem('judgeSessionId');
    const savedJudgeName = localStorage.getItem('judgeName');
    const savedJudgeToken = localStorage.getItem('judgeToken');

    if (savedSessionId && savedJudgeName && savedJudgeToken) {
      attemptRejoin(savedSessionId, savedJudgeName, savedJudgeToken);
    }
  };

  const loadPreviousAnswers = async (judgeId: string, sessionId: string, currentTeamId: string) => {
    try {
      const { data: answers, error } = await supabase
        .from('answers')
        .select('question_id, answer')
        .eq('judge_id', judgeId)
        .eq('session_id', sessionId)
        .eq('team_id', currentTeamId);
      
      if (error) throw error;
      
      if (answers && answers.length > 0) {
        const answersMap: { [key: string]: string } = {};
        answers.forEach(a => {
          answersMap[a.question_id] = a.answer;
        });
        setSelectedAnswers(answersMap);
        console.log('Loaded previous answers:', answers.length);
      }
    } catch (error) {
      console.error('Error loading previous answers:', error);
    }
  };

  const loadCurrentQuestions = async (sessionId: string, judgeIdParam?: string) => {
    try {
      const { data: session, error } = await supabase
        .from('sessions')
        .select('current_questions, current_team_id')
        .eq('session_id', sessionId)
        .single();
      
      if (error) throw error;
      
      if (session) {
        // ALWAYS set team name first, regardless of questions
        const teamName = session.current_team_id || 'لم يتم اختيار فريق';
        if (teamName !== 'لم يتم اختيار فريق') {
          setCurrentTeam(teamName);
          // Save to both general and session-specific localStorage
          localStorage.setItem('currentTeam', teamName);
          localStorage.setItem(`currentTeam_${sessionId}`, teamName);
          console.log('Team name set and saved:', teamName);
        }
        
        // Then handle questions if they exist
        if (session.current_questions && session.current_questions.length > 0) {
          setQuestions(session.current_questions);
          console.log('Loaded current questions on rejoin:', session.current_questions.length);
          
          // Load previous answers for this team
          // Use parameter if provided, otherwise fall back to state
          const effectiveJudgeId = judgeIdParam || judgeId;
          if (effectiveJudgeId && teamName !== 'لم يتم اختيار فريق') {
            await loadPreviousAnswers(effectiveJudgeId, sessionId, teamName);
          }
        } else {
          console.log('ℹ No current questions in session yet');
        }
      }
    } catch (error) {
      console.error('Error loading current questions:', error);
    }
  };

  const attemptRejoin = async (sessionId: string, name: string, token: string) => {
    try {
      const judge = await getJudge(name, token);
      
      if (judge && judge.session_id === sessionId) {
        setSessionId(sessionId);
        setJudgeName(name);
        setJudgeId(judge.id);
        setIsLoggedIn(true);
        
        // Load current questions from session if available
        // Pass judge.id directly to avoid race condition with state update
        await loadCurrentQuestions(sessionId, judge.id);
      } else {
        // Clear invalid session
        localStorage.removeItem('judgeSessionId');
        localStorage.removeItem('judgeName');
        localStorage.removeItem('judgeToken');
      }
    } catch (error) {
      console.error('Error rejoining:', error);
      localStorage.removeItem('judgeSessionId');
      localStorage.removeItem('judgeName');
      localStorage.removeItem('judgeToken');
    }
  };

  const subscribeToQuestions = () => {
    const channel = supabase
      .channel(`session-${sessionId}`)
      .on('broadcast', { event: 'new-questions' }, (payload: any) => {
        console.log('Received questions:', payload);
        setQuestions(payload.payload.questions || []);
        
        // Only update team if payload has a valid team name
        const newTeam = payload.payload.currentTeam;
        if (newTeam && newTeam !== 'لم يتم اختيار فريق') {
          setCurrentTeam(newTeam);
          localStorage.setItem('currentTeam', newTeam);
          localStorage.setItem(`currentTeam_${sessionId}`, newTeam);
          console.log('Team updated from broadcast:', newTeam);
        } else {
          // Keep existing team - restore from localStorage if needed
          const savedTeam = localStorage.getItem(`currentTeam_${sessionId}`);
          if (savedTeam && savedTeam !== 'لم يتم اختيار فريق') {
            console.log('Broadcast had no team, restoring from localStorage:', savedTeam);
            setCurrentTeam(savedTeam);
          }
        }
        
        setSelectedAnswers({});
        // Reset to judging state when new questions arrive
        setJudgeState('judging');
      })
      .subscribe();

    // Subscribe to session end
    const sessionChannel = supabase
      .channel(`session-end-${sessionId}`)
      .on('postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'sessions', filter: `session_id=eq.${sessionId}` },
        () => {
          handleSessionEnd();
        }
      )
      .subscribe();

    return () => {
      channel.unsubscribe();
      sessionChannel.unsubscribe();
    };
  };

  const handleSessionEnd = () => {
    // Clean up session-specific data
    if (sessionId !== 'لم تبدأ') {
      localStorage.removeItem(`currentTeam_${sessionId}`);
    }
    
    localStorage.removeItem('judgeSessionId');
    localStorage.removeItem('judgeName');
    localStorage.removeItem('judgeToken');
    localStorage.removeItem('currentTeam');
    
    setSessionId('لم تبدأ');
    setIsLoggedIn(false);
    setQuestions([]);
    setCurrentTeam('لم يتم اختيار فريق');
    setSelectedAnswers({});
    
    alert('انتهت جلسة التحكيم. يرجى الانضمام لجلسة جديدة.');
  };

  const handleJoinGame = async () => {
    const name = judgeName.trim();
    if (!name) {
      alert('يرجى إدخال اسمك');
      return;
    }

    try {
      console.log('Attempting to join game...');
      
      // Join the session from the unique link, or fall back to the latest session
      const latestSession = urlSessionId
        ? await getSession(urlSessionId)
        : await getLatestSession();
      console.log('Target session:', latestSession);
      
      if (!latestSession || latestSession.current_team_id === 'completed') {
        alert(urlSessionId
          ? 'رابط الجلسة غير صالح أو الجلسة منتهية. تحقق من الرابط مع المضيف.'
          : 'لا توجد جلسة نشطة حالياً. يرجى الانتظار حتى يبدأ المضيف جلسة جديدة.');
        return;
      }

      const newJudgeToken = crypto.randomUUID();
      
      console.log('Creating judge with:', {
        name,
        session_id: latestSession.session_id
      });
      
      const judge = await getOrCreateJudge({
        name,
        judge_token: newJudgeToken,
        session_id: latestSession.session_id
      });

      console.log('Judge joined successfully:', judge);

      setJudgeId(judge.id);
      setJudgeName(name);
      setSessionId(latestSession.session_id);
      setIsLoggedIn(true);

      localStorage.setItem('judgeSessionId', latestSession.session_id);
      localStorage.setItem('judgeName', name);
      localStorage.setItem('judgeToken', newJudgeToken);

      // Show success message
      setTimeout(() => {
        alert(`مرحباً ${name}! تم الانضمام بنجاح للجلسة: ${latestSession.session_id}`);
      }, 100);
    } catch (error) {
      console.error('Error joining game:', error);
      alert('خطأ في الانضمام للجلسة');
    }
  };

  const calculatePoints = (question: Question, selectedAnswer: string): number => {
    // Find the question
    const choices = question.choices;
    
    // Handle both string[] and QuestionChoice[] formats
    let selectedWeight = 1;
    let maxWeight = 1;
    
    if (choices.length > 0 && typeof choices[0] === 'object') {
      // New format with weights
      const choiceObjects = choices as Array<{text: string; weight: number}>;
      const selectedChoice = choiceObjects.find(c => c.text === selectedAnswer);
      selectedWeight = selectedChoice?.weight || 0;
      maxWeight = Math.max(...choiceObjects.map(c => c.weight));
    } else {
      // Old format - all choices have equal weight
      selectedWeight = 1;
      maxWeight = 1;
    }
    
    // Apply the formula: points = (selectedOptionWeight / maxOptionWeight) * questionWeight
    const questionWeight = question.weight || 1;
    const points = (selectedWeight / maxWeight) * questionWeight;
    
    return Number(points.toFixed(2));
  };

  const handleAnswerSelect = async (questionId: string, answer: string) => {
    const previousAnswer = selectedAnswers[questionId];
    
    // If clicking the same answer, do nothing
    if (previousAnswer === answer) {
      console.log('ℹ Same answer selected, no change needed');
      return;
    }

    // Update local state first
    setSelectedAnswers(prev => ({
      ...prev,
      [questionId]: answer
    }));

    // Find the question to calculate points
    const question = questions.find(q => q.id === questionId);
    if (!question) {
      console.error('Question not found:', questionId);
      return;
    }

    // Calculate points using the formula
    const points = calculatePoints(question, answer);
    
    try {
      // If there was a previous answer, delete it first
      if (previousAnswer) {
        console.log(`Changing answer from "${previousAnswer}"to "${answer}"`);
        
        const { error: deleteError } = await supabase
          .from('answers')
          .delete()
          .eq('judge_id', judgeId)
          .eq('question_id', questionId)
          .eq('team_id', currentTeam)
          .eq('session_id', sessionId);
        
        if (deleteError) {
          console.error('Error deleting old answer:', deleteError);
          throw deleteError;
        }
        
        console.log('Old answer deleted');
      }

      // Submit new answer with calculated points
      await submitAnswer({
        answer,
        points,
        question_id: questionId,
        team_id: currentTeam,
        judge_id: judgeId,
        session_id: sessionId
      });
      
      console.log(`New answer submitted with points: ${points}`);
    } catch (error) {
      console.error('Error updating answer:', error);
      // Revert local state on error
      setSelectedAnswers(prev => {
        if (previousAnswer) {
          // Restore previous answer
          return { ...prev, [questionId]: previousAnswer };
        } else {
          // Remove the failed answer
          const newState = { ...prev };
          delete newState[questionId];
          return newState;
        }
      });
    }
  };

  const handleSubmitFinal = async () => {
    const totalQuestions = questions.length;
    const answeredQuestions = Object.keys(selectedAnswers).length;
    
    // Check if no questions answered
    if (answeredQuestions === 0) {
      alert('يرجى الإجابة على جميع الأسئلة');
      return;
    }
    
    // Check if all questions are answered
    if (answeredQuestions < totalQuestions) {
      const unansweredCount = totalQuestions - answeredQuestions;
      alert(`يرجى الإجابة على جميع الأسئلة\nتم الإجابة على ${answeredQuestions} من ${totalQuestions}\nمتبقي ${unansweredCount} سؤال`);
      return;
    }

    // All answers are already submitted individually
    // Transition to waiting state
    setJudgeState('waiting');
    
    console.log(`Submitted ${answeredQuestions} answers (all questions), now waiting for next team`);
  };

  const answeredCount = Object.keys(selectedAnswers).length;
  const allAnswered = questions.length > 0 && answeredCount === questions.length;

  if (!isLoggedIn) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <img src="/brand/logo.png" alt="مياهثون" className="auth-card__logo" />
          <h1 className="auth-card__title">الانضمام للتحكيم</h1>
          <p className="auth-card__subtitle">أدخل اسمك للانضمام إلى جلسة التحكيم</p>

          <div className="text-center mb-5">
            <span className="session-badge">
              <span>معرف الجلسة</span>
              <span className="session-badge__code">{sessionId}</span>
            </span>
          </div>

          {(invalidLink || sessionId === 'رابط غير صالح') && (
            <div className="alert alert-danger" role="alert">
              <AlertCircle />
              <span>رابط الجلسة غير صالح أو الجلسة منتهية. تحقق من الرابط مع المضيف.</span>
            </div>
          )}

          <div className="field">
            <label htmlFor="judgeName">اسمك</label>
            <input
              id="judgeName"
              type="text"
              value={judgeName}
              onChange={(e) => setJudgeName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleJoinGame()}
              placeholder="أدخل اسمك"
              autoComplete="name"
              maxLength={60}
              style={{ padding: '12px 14px', fontSize: '16px' }}
            />
          </div>

          <button className="btn btn-primary btn-lg btn-block" onClick={handleJoinGame}>
            <LogIn />
            انضمام للجلسة
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="judge-page">
      <div className="judge-page__inner">
        <div className="judge-page__topbar">
          <img src="/brand/logo2.png" alt="مياهثون" />
          <span className="judge-page__judge">
            <UserRound />
            {judgeName}
          </span>
        </div>

        <div className="judge-card">
          <div className="judge-team-banner">
            <h2>يتم تحكيم</h2>
            <div className="team-name">{currentTeam}</div>
          </div>

          <div id="questions-container">
            {judgeState === 'waiting' ? (
              // Waiting Screen
              <div className="judge-waiting">
                <div className="judge-waiting__done">
                  <CheckCircle2 />
                  <h2>تم إرسال إجاباتك بنجاح</h2>
                  <p>شكراً لك على مشاركتك في التحكيم</p>
                </div>

                <div className="judge-waiting__next">
                  <div className="spinner spinner--lg" style={{ margin: '0 auto' }} />
                  <h3>في انتظار الفريق التالي...</h3>
                  <p>سيتم عرض الأسئلة الجديدة تلقائياً عندما يرسلها المضيف</p>
                </div>
              </div>
            ) : questions.length === 0 ? (
              <div className="empty-state">
                <Clock />
                <h3>في انتظار الأسئلة...</h3>
                <p>ستظهر الأسئلة هنا فور إرسالها من المضيف</p>
              </div>
            ) : (
              questions.map((question, index) => (
                <div key={question.id} className="question-block">
                  <span className="question-block__num">السؤال {index + 1}</span>
                  <div className="question-block__text">{question.text}</div>

                  <div className="choice-grid">
                    {question.choices.map((choice, choiceIdx) => {
                      const choiceText = typeof choice === 'string' ? choice : choice.text;
                      const choiceWeight = typeof choice === 'string' ? 1 : choice.weight;
                      const isSelected = selectedAnswers[question.id] === choiceText;

                      return (
                        <button
                          key={choiceIdx}
                          className={`answer-btn ${isSelected ? 'selected' : ''}`}
                          onClick={() => handleAnswerSelect(question.id, choiceText)}
                          aria-pressed={isSelected}
                        >
                          <div>{choiceText}</div>
                          {typeof choice !== 'string' && (
                            <div className="answer-btn__weight">وزن: {choiceWeight}</div>
                          )}
                          {isSelected && (
                            <span className="answer-btn__check"><Check /></span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </div>

          {questions.length > 0 && judgeState === 'judging' && (
            <>
              {/* Progress Indicator */}
              <div className={`judge-progress ${allAnswered ? 'judge-progress--done' : ''}`}>
                <div className="judge-progress__label">
                  {allAnswered ? <CheckCircle2 /> : <ListChecks />}
                  {allAnswered
                    ? 'تم الإجابة على جميع الأسئلة'
                    : `تم الإجابة على ${answeredCount} من ${questions.length} أسئلة`}
                </div>
                <div className="progress">
                  <div className="progress__bar" style={{ width: `${(answeredCount / questions.length) * 100}%` }} />
                </div>
              </div>

              <button
                className="btn btn-primary btn-lg btn-block mt-4"
                onClick={handleSubmitFinal}
                style={{ opacity: allAnswered ? 1 : 0.7 }}
              >
                <Send />
                إرسال الإجابات النهائية
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
