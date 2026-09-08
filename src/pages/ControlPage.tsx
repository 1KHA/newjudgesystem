import { useState, useEffect, useRef, useCallback } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowRight, Users, Send, Scale, FileText, Trophy, Plus, BarChart3, HeartPulse,
  Wifi, WifiOff, RefreshCw, ChevronLeft, ChevronRight, Square, CheckCircle2, Clock, UserRound,
  Copy, Check, Link2
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../hooks/useAuth';
import { healthStore } from '../lib/connectionHealth';
import { useConnectionHealth } from '../hooks/useConnectionHealth';
import { RealtimeManager } from '../lib/realtimeManager';
import {
  getSessionDetail, getSession, setCurrentTeam as saveCurrentTeam, finishSession,
  getJudgesBySession, getTeamProgress, getTeamAnswers, getLeaderboard
} from '../lib/supabaseService';
import BrandHeader from '../components/BrandHeader';
import LoadingScreen from '../components/LoadingScreen';
import type { SessionDetail, Judge, JudgeProgress, TeamAnswerRow, LeaderboardEntry } from '../types';

/** Leaderboard safety refresh (cheap server aggregate). */
const LEADERBOARD_REFRESH_MS = 30_000;
/** Collapse bursts of answer events (50 judges x N questions) into one refresh. */
const ANSWER_DEBOUNCE_MS = 400;

/**
 * Session control room.
 *
 * Every query here is bounded: judges (one row per judge), per-team progress
 * and answers (judges x questions rows), and a server-side leaderboard
 * aggregate. Nothing grows with the total number of answers in the session.
 */
export default function ControlPage() {
  const { sessionId = '' } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const health = useConnectionHealth();

  const [session, setSession] = useState<SessionDetail | null>(null);
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [currentTeamIndex, setCurrentTeamIndex] = useState(0);
  const [judges, setJudges] = useState<Judge[]>([]);
  const [progress, setProgress] = useState<JudgeProgress>({});
  const [teamAnswers, setTeamAnswers] = useState<TeamAnswerRow[]>([]);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [switching, setSwitching] = useState(false);
  const [ending, setEnding] = useState(false);
  const [copied, setCopied] = useState(false);
  const [lastBroadcastOk, setLastBroadcastOk] = useState<boolean | null>(null);

  const managerRef = useRef<RealtimeManager | null>(null);
  const teamRef = useRef<string | null>(null);
  const answerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const teams = session?.teams ?? [];
  const questions = session?.questions ?? [];
  const currentTeam = teams[currentTeamIndex] ?? null;
  teamRef.current = currentTeam;

  // ---------------------------------------------------------------- loaders --

  const loadJudges = useCallback(async () => {
    try { setJudges(await getJudgesBySession(sessionId)); healthStore.heartbeat(); }
    catch (e) { console.error('Error loading judges:', e); }
  }, [sessionId]);

  const loadTeamData = useCallback(async () => {
    const team = teamRef.current;
    if (!team) return;
    try {
      const [p, a] = await Promise.all([getTeamProgress(sessionId, team), getTeamAnswers(sessionId, team)]);
      // Ignore results that arrived after the team changed
      if (teamRef.current !== team) return;
      setProgress(p);
      setTeamAnswers(a);
      healthStore.heartbeat();
    } catch (e) { console.error('Error loading team data:', e); }
  }, [sessionId]);

  const loadLeaderboard = useCallback(async () => {
    try { setLeaderboard(await getLeaderboard(sessionId)); healthStore.heartbeat(); }
    catch (e) { console.error('Error loading leaderboard:', e); }
  }, [sessionId]);

  const refreshAll = useCallback(() => {
    void loadJudges(); void loadTeamData(); void loadLeaderboard();
  }, [loadJudges, loadTeamData, loadLeaderboard]);

  const scheduleAnswerRefresh = useCallback(() => {
    if (answerTimer.current) clearTimeout(answerTimer.current);
    answerTimer.current = setTimeout(() => { void loadTeamData(); void loadLeaderboard(); }, ANSWER_DEBOUNCE_MS);
  }, [loadTeamData, loadLeaderboard]);

  // ------------------------------------------------------ load + authorize --

  useEffect(() => {
    if (!sessionId || !user) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await getSessionDetail(sessionId);
        if (cancelled) return;
        if (!data || data.host_id !== user.id) {
          alert('هذه الجلسة غير موجودة أو لا تملك صلاحية التحكم بها');
          navigate('/host', { replace: true });
          return;
        }
        if (data.status === 'completed') {
          alert('هذه الجلسة منتهية');
          navigate('/host', { replace: true });
          return;
        }
        setSession(data);
        const idx = data.current_team_id ? Math.max(0, data.teams.indexOf(data.current_team_id)) : 0;
        setCurrentTeamIndex(idx);
        setAuthorized(true);
      } catch (e) {
        console.error('Error loading session:', e);
        alert('خطأ في تحميل الجلسة');
        navigate('/host', { replace: true });
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId, user, navigate]);

  // ------------------------------------------------------- realtime wiring --

  useEffect(() => {
    if (!authorized) return;

    healthStore.startSession(sessionId);
    const manager = new RealtimeManager({
      client: supabase,
      ping: async () => {
        const s = await getSession(sessionId);
        if (!s) throw new Error('session missing');
      },
      onResync: refreshAll
    });
    managerRef.current = manager;

    manager.start([
      {
        name: `session-${sessionId}`,
        // Host joins the broadcast channel so it can send team changes on it
        configure: (ch) => ch.on('broadcast', { event: 'team-change' }, () => {
          healthStore.noteChannelEvent(`session-${sessionId}`);
        })
      },
      {
        name: `judges-${sessionId}`,
        configure: (ch) => ch.on('postgres_changes',
          { event: '*', schema: 'public', table: 'judges', filter: `session_id=eq.${sessionId}` },
          () => { healthStore.noteChannelEvent(`judges-${sessionId}`); void loadJudges(); })
      },
      {
        name: `answers-${sessionId}`,
        configure: (ch) => ch.on('postgres_changes',
          { event: '*', schema: 'public', table: 'answers', filter: `session_id=eq.${sessionId}` },
          () => { healthStore.noteChannelEvent(`answers-${sessionId}`); scheduleAnswerRefresh(); })
      }
    ]);

    refreshAll();
    const lbTimer = setInterval(() => void loadLeaderboard(), LEADERBOARD_REFRESH_MS);

    return () => {
      clearInterval(lbTimer);
      if (answerTimer.current) clearTimeout(answerTimer.current);
      manager.stop();
      managerRef.current = null;
      healthStore.endSession();
    };
  }, [authorized, sessionId, refreshAll, loadJudges, loadLeaderboard, scheduleAnswerRefresh]);

  // Team changed -> reload the bounded per-team data
  useEffect(() => {
    if (authorized && currentTeam) { setProgress({}); setTeamAnswers([]); void loadTeamData(); }
  }, [authorized, currentTeam, loadTeamData]);

  // --------------------------------------------------------------- actions --

  const announceTeam = useCallback(async (team: string, status: 'active' | 'completed' = 'active') => {
    const ok = await managerRef.current?.broadcast(`session-${sessionId}`, 'team-change', {
      currentTeam: team, status, sentAt: Date.now()
    }).catch(() => false);
    setLastBroadcastOk(Boolean(ok));
  }, [sessionId]);

  const goToTeam = async (index: number) => {
    if (!teams.length || switching) return;
    const team = teams[index];
    setSwitching(true);
    try {
      // 1. Persist: judges' database channel and poll both pick this up
      await saveCurrentTeam(sessionId, index, team);
      setCurrentTeamIndex(index);
      // 2. Broadcast: instant path for connected judges
      await announceTeam(team);
    } catch (e) {
      console.error('Error switching team:', e);
      alert('خطأ في تغيير الفريق، حاول مرة أخرى');
    } finally {
      setSwitching(false);
    }
  };

  const handlePreviousTeam = () => goToTeam(currentTeamIndex > 0 ? currentTeamIndex - 1 : teams.length - 1);
  const handleNextTeam = () => goToTeam(currentTeamIndex < teams.length - 1 ? currentTeamIndex + 1 : 0);
  const handleResend = () => currentTeam && announceTeam(currentTeam);

  const handleEndSession = async () => {
    if (!confirm('هل أنت متأكد من إنهاء الجلسة؟ سيتم حفظ النتائج النهائية.')) return;
    setEnding(true);
    try {
      const n = await finishSession(sessionId);
      await announceTeam(currentTeam ?? '', 'completed');
      alert(`تم إنهاء الجلسة وحفظ نتائج ${n} فريق بنجاح`);
      navigate('/host', { replace: true });
    } catch (e) {
      console.error('Error ending session:', e);
      alert('خطأ في إنهاء الجلسة: ' + (e as Error).message);
    } finally {
      setEnding(false);
    }
  };

  const judgeUrl = `${window.location.origin}/judge/${sessionId}`;
  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(judgeUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { prompt('انسخ الرابط:', judgeUrl); }
  };

  // ---------------------------------------------------------------- render --

  if (authorized === null) return <LoadingScreen message="جاري تحميل الجلسة..." />;

  const totalQuestions = questions.length;
  const doneJudges = judges.filter((j) => (progress[j.id]?.answered ?? 0) >= totalQuestions && totalQuestions > 0);
  const allSubmitted = judges.length > 0 && doneJudges.length === judges.length;

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
            <p>انتقل بين الفرق، وتابع إرسالات المحكمين والنتائج في الوقت الفعلي.</p>
          </div>
          <div className="page-head__actions">
            <button className={`btn btn-sm btn-pill ${copied ? 'btn-success' : 'btn-secondary'}`} onClick={handleCopyLink}>
              {copied ? <Check /> : <Copy />}
              {copied ? 'تم النسخ' : 'نسخ رابط المحكمين'}
            </button>
          </div>
        </div>

        <div className="card card--flat mb-6" style={{ padding: '14px 20px' }}>
          <div className="stepper">
            <span className="step step--active"><span className="step__num">١</span> اختر الفريق الحالي</span>
            <span className="step__arrow"><ChevronLeft /></span>
            <span className="step"><span className="step__num">٢</span> يصل الفريق للمحكمين تلقائياً</span>
            <span className="step__arrow"><ChevronLeft /></span>
            <span className="step"><span className="step__num">٣</span> تابع الإرسالات ثم انتقل للتالي</span>
          </div>
        </div>

        <div className="dashboard-grid">
          {/* Current Team */}
          <div className="card">
            <div className="card-header">
              <div className="card-title">
                <div className="card-icon"><Users /></div>
                <span>الفريق الحالي ({teams.length ? currentTeamIndex + 1 : 0}/{teams.length})</span>
              </div>
              {lastBroadcastOk === false && (
                <span className="badge badge-warning" title="الرسالة الفورية لم تصل، المحكمون سيحصلون على الفريق خلال ثوانٍ عبر المزامنة">
                  <Clock />
                  مزامنة بطيئة
                </span>
              )}
            </div>
            <div className="team-display">
              <div className="team-display__label">يتم تحكيم</div>
              <div className="team-name">{currentTeam ?? 'لا يوجد'}</div>
            </div>
            <p className="card-desc">
              {totalQuestions} سؤال لكل فريق. عند الانتقال لفريق يصل للمحكمين فوراً، ومن ينقطع اتصاله يتزامن تلقائياً.
            </p>
            <div className="btn-group">
              <button className="btn btn-secondary" onClick={handlePreviousTeam} disabled={switching}>
                <ChevronRight />
                السابق
              </button>
              <button className="btn btn-primary" onClick={handleNextTeam} disabled={switching}>
                التالي
                <ChevronLeft />
              </button>
              <button className="btn btn-outline" onClick={handleResend} disabled={!currentTeam} title="إعادة إرسال الفريق الحالي للمحكمين">
                <Send />
                إعادة إرسال
              </button>
              <button className="btn btn-danger" onClick={handleEndSession} disabled={ending}>
                <Square />
                {ending ? 'جاري الإنهاء...' : 'إنهاء'}
              </button>
            </div>
          </div>

          {/* Judges */}
          <div className="card">
            <div className="card-header">
              <div className="card-title">
                <div className="card-icon"><Scale /></div>
                <span>المحكمون ({judges.length})</span>
              </div>
              <div className="flex gap-2 items-center">
                {judges.length > 0 && totalQuestions > 0 && (
                  <span className={`badge ${allSubmitted ? 'badge-success' : 'badge-warning'}`}>
                    {doneJudges.length}/{judges.length} أكملوا
                  </span>
                )}
                <button
                  className="btn btn-outline btn-sm btn-pill"
                  onClick={() => { void managerRef.current?.reconnectAll('manual refresh'); }}
                  title="إعادة الاتصال وتحديث البيانات"
                >
                  <RefreshCw />
                  تحديث
                </button>
              </div>
            </div>
            <ul className="list-plain" style={{ maxHeight: '420px', overflowY: 'auto' }}>
              {judges.length === 0 ? (
                <li className="empty-state">
                  <Link2 />
                  <h3>لا يوجد محكمون بعد</h3>
                  <p>شارك رابط المحكمين من الزر أعلى الصفحة</p>
                </li>
              ) : (
                judges.map((judge) => {
                  const answered = progress[judge.id]?.answered ?? 0;
                  const done = totalQuestions > 0 && answered >= totalQuestions;
                  const started = answered > 0;
                  const rowCls = done ? 'list-row--success' : started ? 'list-row--warning' : '';
                  const avatarCls = done ? 'avatar--success' : started ? 'avatar--warning' : '';
                  return (
                    <li key={judge.id} className={`list-row ${rowCls}`}>
                      <div className="list-row__main">
                        <span className={`avatar ${avatarCls}`}>
                          {done ? <CheckCircle2 /> : started ? <Clock /> : <UserRound />}
                        </span>
                        <span className="fw-600">{judge.name}</span>
                      </div>
                      <span className={`badge ${done ? 'badge-success' : started ? 'badge-warning' : 'badge-neutral'}`}>
                        {done ? 'أكمل' : started ? 'قيد الإجابة' : 'لم يبدأ'}
                        <span className="mono">{answered}/{totalQuestions}</span>
                      </span>
                    </li>
                  );
                })
              )}
            </ul>
          </div>

          {/* Answers for the current team */}
          <div className="card">
            <div className="card-header">
              <div className="card-title">
                <div className="card-icon"><FileText /></div>
                <span>إجابات الفريق الحالي ({teamAnswers.length})</span>
              </div>
            </div>
            <div className="answers-container">
              {teamAnswers.length === 0 ? (
                <div className="empty-state">
                  <FileText />
                  لم يتم استلام إجابات لهذا الفريق بعد
                </div>
              ) : (
                Object.entries(
                  teamAnswers.reduce<Record<string, TeamAnswerRow[]>>((acc, r) => {
                    (acc[r.judgeName] ||= []).push(r);
                    return acc;
                  }, {})
                ).map(([judgeName, rows]) => (
                  <div key={judgeName} className="answer-item">
                    <strong>{judgeName}</strong>
                    <ul>
                      {rows.map((r) => (
                        <li key={r.id}>{r.questionText}: <span className="fw-600">{r.answer}</span> ({r.points.toFixed(2)})</li>
                      ))}
                    </ul>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Leaderboard */}
          <div className="card span-2">
            <div className="card-header">
              <div className="card-title">
                <div className="card-icon"><Trophy /></div>
                <span>لوحة المتصدرين</span>
              </div>
              <span className="text-xs text-secondary">محسوبة على الخادم من جميع الإجابات</span>
            </div>
            <div className="table-wrap" style={{ maxHeight: '480px', overflowY: 'auto' }}>
              <table className="leaderboard-table">
                <thead>
                  <tr>
                    <th style={{ width: '56px' }}>#</th>
                    <th>الفريق</th>
                    <th className="num">الإجابات</th>
                    <th className="num">المحكمون</th>
                    <th className="num">إجمالي النقاط</th>
                  </tr>
                </thead>
                <tbody>
                  {leaderboard.length === 0 ? (
                    <tr><td colSpan={5} className="empty-state">لا توجد نتائج بعد</td></tr>
                  ) : (
                    leaderboard.map((entry, idx) => (
                      <tr key={entry.teamName} style={entry.teamName === currentTeam ? { background: 'var(--primary-tint)' } : undefined}>
                        <td><span className={`rank-badge rank-badge--${idx + 1}`}>{idx + 1}</span></td>
                        <td className="fw-600">{entry.teamName}</td>
                        <td className="num text-secondary">{entry.answerCount}</td>
                        <td className="num text-secondary">{entry.judgeCount}</td>
                        <td className="num fw-700 text-primary">{entry.totalPoints.toFixed(2)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

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
