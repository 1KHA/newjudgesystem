import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight, ClipboardList, Calendar, ChevronDown, Trophy, BarChart3, Users, Calculator, Loader2
} from 'lucide-react';
import { getAllSessions, getLeaderboard, getJudgesBySession, getTeamAnswers } from '../lib/supabaseService';
import BrandHeader from '../components/BrandHeader';
import type { SessionSummary, LeaderboardEntry, TeamAnswerRow } from '../types';

interface SessionData {
  leaderboard: LeaderboardEntry[];
  judgeCount: number;
  loading: boolean;
}

/**
 * Results browser.
 *
 * Loads the session list only. A session's leaderboard (server aggregate)
 * loads when expanded, and a team's individual answers load when that team
 * is opened. Nothing here fetches raw answers for a whole session.
 */
export default function ResultsPage() {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [data, setData] = useState<Record<string, SessionData>>({});
  const [openTeam, setOpenTeam] = useState<Record<string, string | null>>({});
  const [teamRows, setTeamRows] = useState<Record<string, TeamAnswerRow[] | 'loading'>>({});

  useEffect(() => {
    (async () => {
      try {
        setSessions(await getAllSessions());
      } catch (e) {
        console.error('Error loading sessions:', e);
        setError('خطأ في تحميل الجلسات');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const loadSession = useCallback(async (sessionId: string) => {
    setData((d) => ({ ...d, [sessionId]: { leaderboard: [], judgeCount: 0, loading: true } }));
    try {
      const [leaderboard, judges] = await Promise.all([getLeaderboard(sessionId), getJudgesBySession(sessionId)]);
      setData((d) => ({ ...d, [sessionId]: { leaderboard, judgeCount: judges.length, loading: false } }));
    } catch (e) {
      console.error('Error loading session results:', e);
      setData((d) => ({ ...d, [sessionId]: { leaderboard: [], judgeCount: 0, loading: false } }));
    }
  }, []);

  const toggleSession = (sessionId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else { next.add(sessionId); if (!data[sessionId]) void loadSession(sessionId); }
      return next;
    });
  };

  const toggleTeam = async (sessionId: string, team: string) => {
    const key = `${sessionId}|${team}`;
    const isOpen = openTeam[sessionId] === team;
    setOpenTeam((o) => ({ ...o, [sessionId]: isOpen ? null : team }));
    if (!isOpen && !teamRows[key]) {
      setTeamRows((r) => ({ ...r, [key]: 'loading' }));
      try {
        const rows = await getTeamAnswers(sessionId, team);
        setTeamRows((r) => ({ ...r, [key]: rows }));
      } catch (e) {
        console.error('Error loading team answers:', e);
        setTeamRows((r) => ({ ...r, [key]: [] }));
      }
    }
  };

  const header = (
    <BrandHeader title="نتائج الجلسات">
      <button className="btn btn-sm btn-pill btn-on-blue" onClick={() => navigate('/host')}>
        <ArrowRight />
        العودة للإدارة
      </button>
    </BrandHeader>
  );

  const pageHead = (
    <div className="page-head">
      <div>
        <h1>نتائج الجلسات</h1>
        <p>اضغط على جلسة لعرض ترتيب الفرق، وعلى فريق لعرض إجابات المحكمين بالتفصيل.</p>
      </div>
    </div>
  );

  if (loading || error || sessions.length === 0) {
    return (
      <div className="app-shell">
        {header}
        <div className="container">
          {pageHead}
          <div className="card">
            {loading ? (
              <div className="loading-screen" style={{ minHeight: '200px' }}>
                <div className="spinner" />
                <div>جاري التحميل...</div>
              </div>
            ) : (
              <div className="empty-state">
                <ClipboardList />
                <h3>{error || 'لا توجد نتائج متاحة'}</h3>
                <p>{error ? 'تحقق من الاتصال وأعد المحاولة' : 'لم يتم إنشاء أي جلسات بعد'}</p>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      {header}
      <div className="container">
        {pageHead}

        {sessions.map((session) => {
          const isExpanded = expanded.has(session.session_id);
          const d = data[session.session_id];
          const lb = d?.leaderboard ?? [];
          const maxScore = lb.length ? lb[0].totalPoints : 0;
          const avgScore = lb.length ? lb.reduce((s, t) => s + t.totalPoints, 0) / lb.length : 0;
          const totalAnswers = lb.reduce((s, t) => s + t.answerCount, 0);

          return (
            <div key={session.session_id} className="card mb-5">
              <div
                className="session-toggle"
                onClick={() => toggleSession(session.session_id)}
                role="button"
                aria-expanded={isExpanded}
                style={{ borderBottom: isExpanded ? '1px solid var(--border)' : 'none', paddingBottom: isExpanded ? '16px' : 0 }}
              >
                <div>
                  <div className="flex items-center gap-3 flex-wrap mb-2">
                    <h2 style={{ fontSize: '20px' }}>{session.name || `جلسة ${session.session_id}`}</h2>
                    <span className="badge badge-primary mono">{session.session_id}</span>
                    <span className={`badge ${session.status === 'completed' ? 'badge-neutral' : 'badge-success badge-dot'}`}>
                      {session.status === 'completed' ? 'منتهية' : 'نشطة'}
                    </span>
                  </div>
                  <div className="list-row__meta">
                    <Calendar />
                    {new Date(session.created_at || '').toLocaleString('ar-SA')}
                  </div>
                </div>
                <div className="session-toggle__stats">
                  <div className="session-toggle__stat">
                    <div className="stat-value">{session.team_count}</div>
                    <div className="stat-label">فرق</div>
                  </div>
                  <span className={`icon-btn chevron ${isExpanded ? 'chevron--open' : ''}`} aria-hidden="true">
                    <ChevronDown />
                  </span>
                </div>
              </div>

              {isExpanded && (
                <div className="mt-4">
                  {!d || d.loading ? (
                    <div className="loading-screen" style={{ minHeight: '120px' }}>
                      <div className="spinner" />
                    </div>
                  ) : lb.length === 0 ? (
                    <div className="empty-state">
                      <ClipboardList />
                      <p>لا توجد نتائج لهذه الجلسة</p>
                    </div>
                  ) : (
                    <>
                      <div className="top-teams">
                        <h3><Trophy /> أفضل 5 فرق</h3>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px' }}>
                          {lb.slice(0, 5).map((team, index) => (
                            <div key={team.teamName} className={`top-team top-team--${index + 1}`}>
                              <div className="top-team__bar" />
                              <span className={`rank-badge rank-badge--${index + 1}`}>{index + 1}</span>
                              <div className="top-team__name">{team.teamName}</div>
                              <div className="top-team__score">{team.totalPoints.toFixed(2)}</div>
                              <div className="top-team__unit">نقطة</div>
                            </div>
                          ))}
                        </div>
                      </div>

                      <div className="panel panel--tint mb-5">
                        <h3 className="panel-title"><BarChart3 /> إحصائيات الجلسة</h3>
                        <div className="stat-grid">
                          <div className="stat-card stat-card--blue">
                            <div className="stat-value">{session.team_count}</div>
                            <div className="stat-label">عدد الفرق</div>
                          </div>
                          <div className="stat-card stat-card--green">
                            <div className="stat-value">{maxScore.toFixed(2)}</div>
                            <div className="stat-label">أعلى نقاط</div>
                          </div>
                          <div className="stat-card stat-card--cyan">
                            <div className="stat-value">{avgScore.toFixed(2)}</div>
                            <div className="stat-label">متوسط النقاط</div>
                          </div>
                          <div className="stat-card stat-card--yellow">
                            <div className="stat-value">{d.judgeCount}</div>
                            <div className="stat-label">المحكمون</div>
                          </div>
                          <div className="stat-card">
                            <div className="stat-value">{totalAnswers}</div>
                            <div className="stat-label">إجابات</div>
                          </div>
                        </div>
                      </div>

                      <div className="formula-box">
                        <div className="formula-box__title"><Calculator /> معادلة الحساب</div>
                        <div className="formula-box__body">النقاط = (وزن الخيار ÷ أقصى وزن) × وزن السؤال، والمجموع يُحسب على الخادم من جميع الإجابات</div>
                      </div>

                      <h3 className="panel-title mb-4" style={{ fontSize: '17px' }}>
                        <Trophy /> نتائج الفرق
                      </h3>
                      <div className="table-wrap">
                        <table className="leaderboard-table">
                          <thead>
                            <tr>
                              <th style={{ width: '56px' }}>#</th>
                              <th>الفريق</th>
                              <th className="num">الإجابات</th>
                              <th className="num">المحكمون</th>
                              <th className="num">النقاط</th>
                            </tr>
                          </thead>
                          <tbody>
                            {lb.map((team, index) => {
                              const key = `${session.session_id}|${team.teamName}`;
                              const isOpen = openTeam[session.session_id] === team.teamName;
                              const rows = teamRows[key];
                              return (
                                <>
                                  <tr
                                    key={team.teamName}
                                    onClick={() => toggleTeam(session.session_id, team.teamName)}
                                    style={{ cursor: 'pointer', background: isOpen ? 'var(--primary-tint)' : undefined }}
                                  >
                                    <td><span className={`rank-badge rank-badge--${index + 1}`}>{index + 1}</span></td>
                                    <td className="fw-600">
                                      <span className="flex items-center gap-2">
                                        <Users size={16} className="text-secondary" />
                                        {team.teamName}
                                        <ChevronDown size={14} className={`chevron ${isOpen ? 'chevron--open' : ''}`} />
                                      </span>
                                    </td>
                                    <td className="num text-secondary">{team.answerCount}</td>
                                    <td className="num text-secondary">{team.judgeCount}</td>
                                    <td className="num fw-700 text-primary">{team.totalPoints.toFixed(2)}</td>
                                  </tr>
                                  {isOpen && (
                                    <tr key={`${team.teamName}-detail`}>
                                      <td colSpan={5} style={{ padding: 0, background: 'var(--white)' }}>
                                        {rows === 'loading' || !rows ? (
                                          <div className="loading-screen" style={{ minHeight: '80px' }}>
                                            <Loader2 className="spin" />
                                          </div>
                                        ) : rows.length === 0 ? (
                                          <div className="empty-state">لا توجد إجابات لهذا الفريق</div>
                                        ) : (
                                          <div className="table-wrap" style={{ padding: '8px 16px 16px' }}>
                                            <table className="leaderboard-table">
                                              <thead>
                                                <tr>
                                                  <th>المحكم</th>
                                                  <th>السؤال</th>
                                                  <th>الإجابة</th>
                                                  <th className="num">النقاط</th>
                                                  <th>الوقت</th>
                                                </tr>
                                              </thead>
                                              <tbody>
                                                {rows.map((r) => (
                                                  <tr key={r.id}>
                                                    <td className="fw-600">{r.judgeName}</td>
                                                    <td className="text-sm">{r.questionText}</td>
                                                    <td>{r.answer}</td>
                                                    <td className="num fw-700 text-primary">{r.points.toFixed(2)}</td>
                                                    <td className="text-xs text-secondary">{new Date(r.createdAt).toLocaleTimeString('ar-SA')}</td>
                                                  </tr>
                                                ))}
                                              </tbody>
                                            </table>
                                          </div>
                                        )}
                                      </td>
                                    </tr>
                                  )}
                                </>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
