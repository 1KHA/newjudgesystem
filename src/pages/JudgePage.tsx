import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import {
  AlertCircle, LogIn, UserRound, CheckCircle2, Clock, Check, ListChecks, Send,
  Wifi, WifiOff, RefreshCw, CloudUpload, Link2Off
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import {
  getSessionDetail, getSession, getOrCreateJudge, getJudge, upsertAnswer,
  getJudgeAnswersForTeam, touchJudge
} from '../lib/supabaseService';
import { normalizeSessionParam } from '../lib/sessionRouting';
import { OfflineAnswerQueue, browserStorage } from '../lib/offlineQueue';
import { RealtimeManager } from '../lib/realtimeManager';
import { healthStore } from '../lib/connectionHealth';
import { useConnectionHealth } from '../hooks/useConnectionHealth';
import type { Question, SessionDetail, Session, PendingAnswer } from '../types';

/** Poll interval for team/status changes; the safety net behind the two realtime paths. */
const POLL_MS = 4_000;
/** How often queued answers are retried while any are pending. */
const QUEUE_RETRY_MS = 8_000;
/** Presence ping so the host sees "last seen". */
const PRESENCE_MS = 60_000;

interface StoredJudge { name: string; token: string; id: string }

const judgeStorageKey = (sessionId: string) => `judge_${sessionId}`;

function readStoredJudge(sessionId: string): StoredJudge | null {
  try {
    const raw = localStorage.getItem(judgeStorageKey(sessionId));
    return raw ? (JSON.parse(raw) as StoredJudge) : null;
  } catch { return null; }
}

function calculatePoints(question: Question, selectedAnswer: string): number {
  const choices = question.choices;
  let selectedWeight = 1;
  let maxWeight = 1;
  if (choices.length > 0 && typeof choices[0] === 'object') {
    const objs = choices as { text: string; weight: number }[];
    selectedWeight = objs.find((c) => c.text === selectedAnswer)?.weight ?? 0;
    maxWeight = Math.max(...objs.map((c) => c.weight));
  }
  return Number(((selectedWeight / maxWeight) * (question.weight || 1)).toFixed(2));
}

const sendPending = async (p: PendingAnswer) => {
  await upsertAnswer({
    answer: p.answer, points: p.points, question_id: p.question_id,
    team_id: p.team_id, judge_id: p.judge_id, session_id: p.session_id
  });
};

type Phase = 'loading' | 'invalid' | 'ended' | 'join' | 'judging';

export default function JudgePage() {
  const { sessionId: sessionParam } = useParams();
  const sessionId = normalizeSessionParam(sessionParam);

  const [phase, setPhase] = useState<Phase>('loading');
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [judgeName, setJudgeName] = useState('');
  const [judge, setJudge] = useState<StoredJudge | null>(null);
  const [joinError, setJoinError] = useState('');
  const [joining, setJoining] = useState(false);

  const [currentTeam, setCurrentTeam] = useState<string | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [selectedAnswers, setSelectedAnswers] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);

  const health = useConnectionHealth();
  const queueRef = useRef<OfflineAnswerQueue | null>(null);
  const managerRef = useRef<RealtimeManager | null>(null);
  const currentTeamRef = useRef<string | null>(null);
  const judgeRef = useRef<StoredJudge | null>(null);
  judgeRef.current = judge;

  // ---------------------------------------------------------- load session --

  useEffect(() => {
    if (!sessionId) { setPhase('invalid'); return; }
    let cancelled = false;
    (async () => {
      try {
        const detail = await getSessionDetail(sessionId);
        if (cancelled) return;
        if (!detail) { setPhase('invalid'); return; }
        if (detail.status === 'completed') { setPhase('ended'); return; }
        setSession(detail);
        setQuestions(detail.questions);
        setCurrentTeam(detail.current_team_id ?? null);
        currentTeamRef.current = detail.current_team_id ?? null;

        // Automatic rejoin for a judge who already joined on this device
        const stored = readStoredJudge(sessionId);
        if (stored) {
          const row = await getJudge(stored.name, stored.token).catch(() => null);
          if (!cancelled && row && row.session_id === sessionId) {
            setJudge({ ...stored, id: row.id });
            setJudgeName(stored.name);
            setPhase('judging');
            return;
          }
          localStorage.removeItem(judgeStorageKey(sessionId));
        }
        setPhase('join');
      } catch (e) {
        console.error('Error loading session:', e);
        if (!cancelled) setPhase('invalid');
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId]);

  // ----------------------------------------------------------------- join --

  const handleJoin = async () => {
    if (!sessionId || !session) return;
    const name = judgeName.trim();
    if (!name) { setJoinError('يرجى إدخال اسمك'); return; }
    setJoining(true);
    setJoinError('');
    try {
      const fresh = await getSession(sessionId);
      if (!fresh || fresh.status === 'completed') { setPhase('ended'); return; }
      const token = crypto.randomUUID();
      const row = await getOrCreateJudge({ name, judge_token: token, session_id: sessionId });
      const stored: StoredJudge = { name, token, id: row.id };
      localStorage.setItem(judgeStorageKey(sessionId), JSON.stringify(stored));
      setJudge(stored);
      setPhase('judging');
    } catch (e) {
      console.error('Error joining session:', e);
      setJoinError('تعذر الانضمام، تحقق من الاتصال وحاول مرة أخرى');
    } finally {
      setJoining(false);
    }
  };

  // ------------------------------------------------- answers for a team --

  const loadMyAnswers = useCallback(async (team: string) => {
    const j = judgeRef.current;
    if (!sessionId || !j) return;
    try {
      const rows = await getJudgeAnswersForTeam(sessionId, j.id, team);
      const map: Record<string, string> = {};
      rows.forEach((r) => { map[r.question_id] = r.answer; });
      // Anything still queued locally wins over the server copy
      queueRef.current?.peek().forEach((p) => { if (p.team_id === team) map[p.question_id] = p.answer; });
      setSelectedAnswers(map);
    } catch (e) {
      console.error('Error loading previous answers:', e);
    }
  }, [sessionId]);

  /** Single entry point for every team/status signal (broadcast, db event, poll). */
  const applySessionState = useCallback((s: Pick<Session, 'current_team_id' | 'status'>) => {
    if (s.status === 'completed') {
      setPhase('ended');
      return;
    }
    const team = s.current_team_id ?? null;
    if (team && team !== currentTeamRef.current) {
      currentTeamRef.current = team;
      setCurrentTeam(team);
      setSubmitted(false);
      setSelectedAnswers({});
      void loadMyAnswers(team);
    }
  }, [loadMyAnswers]);

  // ------------------------------------------ realtime + queue lifecycle --

  useEffect(() => {
    if (phase !== 'judging' || !sessionId || !judge) return;

    const queue = new OfflineAnswerQueue(`answerQueue_${sessionId}_${judge.id}`, browserStorage());
    queueRef.current = queue;
    setPendingCount(queue.size);
    const unsubQueue = queue.subscribe(() => setPendingCount(queue.size));
    const flush = () => queue.flush(sendPending).catch(() => undefined);

    // Poll fallback doubles as the connectivity ping
    const poll = async () => {
      const s = await getSession(sessionId);
      if (!s) throw new Error('session missing');
      applySessionState(s);
    };

    healthStore.startSession(sessionId);
    const manager = new RealtimeManager({
      client: supabase,
      ping: poll,
      onResync: () => { void poll(); void flush(); }
    });
    managerRef.current = manager;
    manager.start([
      {
        name: `session-${sessionId}`,
        configure: (ch) => ch.on('broadcast', { event: 'team-change' }, (msg) => {
          healthStore.noteChannelEvent(`session-${sessionId}`);
          const p = (msg as { payload?: { currentTeam?: string; status?: string } }).payload || {};
          applySessionState({ current_team_id: p.currentTeam ?? null, status: (p.status as Session['status']) || 'active' });
        })
      },
      {
        name: `session-row-${sessionId}`,
        configure: (ch) => ch.on('postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'sessions', filter: `session_id=eq.${sessionId}` },
          (payload) => {
            healthStore.noteChannelEvent(`session-row-${sessionId}`);
            applySessionState(payload.new as Session);
          })
      }
    ]);

    if (currentTeamRef.current) void loadMyAnswers(currentTeamRef.current);
    void flush();

    const pollTimer = setInterval(() => { poll().catch(() => undefined); }, POLL_MS);
    const queueTimer = setInterval(() => { if (queue.size > 0) void flush(); }, QUEUE_RETRY_MS);
    const presenceTimer = setInterval(() => { touchJudge(judge.id).catch(() => undefined); }, PRESENCE_MS);
    const onOnline = () => { void flush(); };
    window.addEventListener('online', onOnline);
    window.addEventListener('focus', onOnline);

    return () => {
      clearInterval(pollTimer);
      clearInterval(queueTimer);
      clearInterval(presenceTimer);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('focus', onOnline);
      unsubQueue();
      manager.stop();
      managerRef.current = null;
      queueRef.current = null;
      healthStore.endSession();
    };
  }, [phase, sessionId, judge, applySessionState, loadMyAnswers]);

  const allAnswered = questions.length > 0 && questions.every((q) => selectedAnswers[q.id]);

  // -------------------------------------------------------------- actions --

  const handleAnswerSelect = (question: Question, answer: string) => {
    const team = currentTeamRef.current;
    if (!team || !judge || !sessionId) return;
    if (selectedAnswers[question.id] === answer) return;
    setSelectedAnswers((prev) => ({ ...prev, [question.id]: answer }));
    setSubmitted(false);
    queueRef.current?.enqueue({
      session_id: sessionId, team_id: team, judge_id: judge.id,
      question_id: question.id, answer, points: calculatePoints(question, answer)
    });
    void queueRef.current?.flush(sendPending).catch(() => undefined);
  };

  const handleSubmitFinal = () => {
    if (!allAnswered) {
      const missing = questions.length - Object.keys(selectedAnswers).length;
      alert(`يرجى الإجابة على جميع الأسئلة، متبقي ${missing} سؤال`);
      return;
    }
    setSubmitted(true);
  };

  const handleRefresh = () => { void managerRef.current?.reconnectAll('manual refresh'); };

  // ---------------------------------------------------------------- views --

  if (phase === 'loading') {
    return (
      <div className="auth-page">
        <div className="auth-card text-center">
          <img src="/brand/logo.png" alt="مياهثون" className="auth-card__logo" />
          <div className="spinner" style={{ margin: '12px auto' }} />
          <p className="text-secondary">جاري تحميل الجلسة...</p>
        </div>
      </div>
    );
  }

  if (phase === 'invalid' || phase === 'ended') {
    const ended = phase === 'ended';
    return (
      <div className="auth-page">
        <div className="auth-card text-center">
          <img src="/brand/logo.png" alt="مياهثون" className="auth-card__logo" />
          <div className="empty-state">
            {ended ? <CheckCircle2 /> : <Link2Off />}
            <h3>{ended ? 'انتهت جلسة التحكيم' : 'رابط الجلسة غير صالح'}</h3>
            <p>
              {ended
                ? 'شكراً لمشاركتك. تم حفظ جميع إجاباتك.'
                : 'الانضمام للتحكيم يتم فقط عبر الرابط الخاص الذي يرسله المضيف لكل جلسة.'}
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (phase === 'join') {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <img src="/brand/logo.png" alt="مياهثون" className="auth-card__logo" />
          <h1 className="auth-card__title">الانضمام للتحكيم</h1>
          <p className="auth-card__subtitle">{session?.name || 'جلسة تحكيم'}</p>

          <div className="text-center mb-5">
            <span className="session-badge">
              <span>معرف الجلسة</span>
              <span className="session-badge__code">{sessionId}</span>
            </span>
          </div>

          {joinError && (
            <div className="alert alert-danger" role="alert">
              <AlertCircle />
              <span>{joinError}</span>
            </div>
          )}

          <div className="field">
            <label htmlFor="judgeName">اسمك</label>
            <input
              id="judgeName"
              type="text"
              value={judgeName}
              onChange={(e) => setJudgeName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
              placeholder="أدخل اسمك"
              autoComplete="name"
              maxLength={60}
              style={{ padding: '12px 14px', fontSize: '16px' }}
            />
          </div>

          <button className="btn btn-primary btn-lg btn-block" onClick={handleJoin} disabled={joining}>
            {joining ? <RefreshCw className="spin" /> : <LogIn />}
            {joining ? 'جاري الانضمام...' : 'انضمام للجلسة'}
          </button>
        </div>
      </div>
    );
  }

  // ---- judging ----
  const answeredCount = questions.filter((q) => selectedAnswers[q.id]).length;
  const online = health.status === 'connected';
  const waitingForTeam = !currentTeam;

  return (
    <div className="judge-page">
      <div className="judge-page__inner">
        <div className="judge-page__topbar">
          <img src="/brand/logo2.png" alt="مياهثون" />
          <div className="flex items-center gap-2">
            {pendingCount > 0 && (
              <span className="judge-page__judge" title="إجابات بانتظار الإرسال">
                <CloudUpload />
                {pendingCount}
              </span>
            )}
            <button
              className={`conn-chip ${online ? 'conn-chip--connected' : health.status === 'reconnecting' ? 'conn-chip--reconnecting' : 'conn-chip--disconnected'}`}
              onClick={handleRefresh}
              title="إعادة الاتصال"
              style={{ cursor: 'pointer', background: 'rgba(255,255,255,0.14)', color: '#fff', borderColor: 'rgba(255,255,255,0.25)' }}
            >
              {online ? <Wifi /> : health.status === 'reconnecting' ? <RefreshCw className="spin" /> : <WifiOff />}
              {online ? 'متصل' : health.status === 'reconnecting' ? 'إعادة الاتصال' : 'غير متصل'}
            </button>
            <span className="judge-page__judge">
              <UserRound />
              {judge?.name}
            </span>
          </div>
        </div>

        <div className="judge-card">
          <div className="judge-team-banner">
            <h2>يتم تحكيم</h2>
            <div className="team-name">{currentTeam ?? 'بانتظار المضيف'}</div>
          </div>

          {!online && (
            <div className="alert alert-warning">
              <WifiOff />
              <span>
                لا يوجد اتصال حالياً. يمكنك متابعة الإجابة، وسيتم إرسال إجاباتك تلقائياً عند عودة الاتصال
                {pendingCount > 0 ? ` (${pendingCount} بانتظار الإرسال)` : ''}.
              </span>
            </div>
          )}

          {submitted ? (
            <div className="judge-waiting">
              <div className="judge-waiting__done">
                <CheckCircle2 />
                <h2>{pendingCount > 0 ? 'جاري إرسال إجاباتك...' : 'تم إرسال إجاباتك بنجاح'}</h2>
                <p>{pendingCount > 0 ? `${pendingCount} إجابة بانتظار الاتصال` : 'شكراً لك على مشاركتك في التحكيم'}</p>
              </div>
              <div className="judge-waiting__next">
                <div className="spinner spinner--lg" style={{ margin: '0 auto' }} />
                <h3>في انتظار الفريق التالي...</h3>
                <p>سيتم عرض الفريق الجديد تلقائياً عندما ينتقل المضيف إليه</p>
              </div>
            </div>
          ) : waitingForTeam || questions.length === 0 ? (
            <div className="empty-state">
              <Clock />
              <h3>{waitingForTeam ? 'في انتظار بدء التحكيم...' : 'لا توجد أسئلة في هذه الجلسة'}</h3>
              <p>سيبدأ التحكيم فور اختيار المضيف للفريق الأول</p>
            </div>
          ) : (
            <>
              {questions.map((question, index) => (
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
                          onClick={() => handleAnswerSelect(question, choiceText)}
                          aria-pressed={isSelected}
                        >
                          <div>{choiceText}</div>
                          {typeof choice !== 'string' && (
                            <div className="answer-btn__weight">وزن: {choiceWeight}</div>
                          )}
                          {isSelected && <span className="answer-btn__check"><Check /></span>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}

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
