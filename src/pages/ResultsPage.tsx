import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { getAnswersBySession, getJudgesBySession } from '../lib/supabaseService';
import type { Answer, Question } from '../types';
import { ArrowRight, ClipboardList, Calendar, ChevronDown, Trophy, BarChart3, Users, Calculator } from 'lucide-react';
import BrandHeader from '../components/BrandHeader';

interface SessionData {
  session_id: string;
  name: string;
  created_at: string;
  teams: string[];
  total_points: number;
  answers: Answer[];
  judges: any[];
  questions: Map<string, Question>;
}

interface TeamResult {
  teamName: string;
  score: number;
  answers: Answer[];
}

export default function ResultsPage() {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<SessionData[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set());

  useEffect(() => {
    loadAllSessions();
  }, []);

  const loadAllSessions = async () => {
    try {
      setLoading(true);
      
      // Fetch all sessions
      const { data: sessionsData, error: sessionsError } = await supabase
        .from('sessions')
        .select('*')
        .order('created_at', { ascending: false });
      
      if (sessionsError) throw sessionsError;

      console.log('Loaded sessions:', sessionsData?.length || 0);

      // For each session, fetch answers, judges, and questions
      const sessionsWithData = await Promise.all(
        (sessionsData || []).map(async (session) => {
          const [answers, judges] = await Promise.all([
            getAnswersBySession(session.session_id),
            getJudgesBySession(session.session_id)
          ]);
          
          // Fetch questions for this session's answers
          const questionIds = [...new Set(answers.map(a => a.question_id))];
          const questionsMap = new Map<string, Question>();
          
          if (questionIds.length > 0) {
            const { data: questionsData } = await supabase
              .from('questions')
              .select('*')
              .in('id', questionIds);
            
            questionsData?.forEach(q => questionsMap.set(q.id, q));
          }
          
          console.log(`Session ${session.session_id}: ${answers.length} answers, ${judges.length} judges, ${questionsMap.size} questions`);
          
          return {
            ...session,
            answers,
            judges,
            questions: questionsMap
          };
        })
      );

      setSessions(sessionsWithData);
      
      // Auto-expand all sessions by default
      const allSessionIds = sessionsWithData.map(s => s.session_id);
      setExpandedSessions(new Set(allSessionIds));
      
      console.log('All sessions loaded and expanded');
    } catch (error) {
      console.error('Error loading sessions:', error);
      alert('خطأ في تحميل الجلسات');
    } finally {
      setLoading(false);
    }
  };

  const toggleSession = (sessionId: string) => {
    const newExpanded = new Set(expandedSessions);
    if (newExpanded.has(sessionId)) {
      newExpanded.delete(sessionId);
    } else {
      newExpanded.add(sessionId);
    }
    setExpandedSessions(newExpanded);
  };

  const calculateTeamResults = (answers: Answer[]): TeamResult[] => {
    const teamScores: { [key: string]: { score: number; answers: Answer[] } } = {};
    
    answers.forEach(answer => {
      if (!teamScores[answer.team_id]) {
        teamScores[answer.team_id] = { score: 0, answers: [] };
      }
      const points = answer.points || 1;
      teamScores[answer.team_id].score += points;
      teamScores[answer.team_id].answers.push(answer);
    });
    
    return Object.entries(teamScores)
      .map(([teamName, data]) => ({ teamName, ...data }))
      .sort((a, b) => b.score - a.score);
  };

  const getJudgeName = (judgeId: string, judges: any[]) => {
    const judge = judges.find(j => j.id === judgeId);
    return judge ? judge.name : judgeId;
  };

  const getCalculationDetails = (answer: Answer, question: Question | undefined) => {
    if (!question) {
      return {
        choiceWeight: 1,
        maxWeight: 1,
        questionWeight: 1,
        formula: 'N/A'
      };
    }

    const choices = question.choices;
    let choiceWeight = 1;
    let maxWeight = 1;

    if (choices.length > 0 && typeof choices[0] === 'object') {
      const choiceObjects = choices as Array<{text: string; weight: number}>;
      const selectedChoice = choiceObjects.find(c => c.text === answer.answer);
      choiceWeight = selectedChoice?.weight || 0;
      maxWeight = Math.max(...choiceObjects.map(c => c.weight));
    }

    const questionWeight = question.weight || 1;
    const formula = `(${choiceWeight} / ${maxWeight}) × ${questionWeight} = ${(answer.points || 1).toFixed(2)}`;

    return {
      choiceWeight,
      maxWeight,
      questionWeight,
      formula
    };
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
        <p>النتائج التفصيلية لكل جلسة مع طريقة احتساب النقاط لكل إجابة.</p>
      </div>
    </div>
  );

  if (loading) {
    return (
      <div className="app-shell">
        {header}
        <div className="container">
          {pageHead}
          <div className="card">
            <div className="loading-screen" style={{ minHeight: '200px' }}>
              <div className="spinner" />
              <div>جاري التحميل...</div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="app-shell">
        {header}
        <div className="container">
          {pageHead}
          <div className="card">
            <div className="empty-state">
              <ClipboardList />
              <h3>لا توجد نتائج متاحة</h3>
              <p>لم يتم إكمال أي جلسات بعد</p>
            </div>
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
          const teamResults = calculateTeamResults(session.answers);
          const isExpanded = expandedSessions.has(session.session_id);
          const maxScore = teamResults.length > 0 ? teamResults[0].score : 0;
          const avgScore = teamResults.length > 0
            ? teamResults.reduce((sum, t) => sum + t.score, 0) / teamResults.length
            : 0;

          return (
            <div key={session.session_id} className="card mb-5" style={{ animation: 'slideUp 0.3s ease-out' }}>
              {/* Session Header */}
              <div
                className="session-toggle"
                onClick={() => toggleSession(session.session_id)}
                role="button"
                aria-expanded={isExpanded}
                style={{ borderBottom: isExpanded ? '1px solid var(--border)' : 'none', paddingBottom: isExpanded ? '16px' : 0 }}
              >
                <div>
                  <div className="flex items-center gap-3 flex-wrap mb-2">
                    <h2 style={{ fontSize: '20px' }}>
                      {session.name || `جلسة ${session.session_id}`}
                    </h2>
                    <span className="badge badge-primary mono">{session.session_id}</span>
                  </div>
                  <div className="list-row__meta">
                    <Calendar />
                    {new Date(session.created_at).toLocaleString('ar-SA')}
                  </div>
                </div>
                <div className="session-toggle__stats">
                  <div className="session-toggle__stat">
                    <div className="stat-value">{teamResults.length}</div>
                    <div className="stat-label">فرق</div>
                  </div>
                  <div className="session-toggle__stat">
                    <div className="stat-value">{session.answers.length}</div>
                    <div className="stat-label">إجابات</div>
                  </div>
                  <span className={`icon-btn chevron ${isExpanded ? 'chevron--open' : ''}`} aria-hidden="true">
                    <ChevronDown />
                  </span>
                </div>
              </div>

              {/* Session Content (Expanded) */}
              {isExpanded && (
                <div className="mt-4">
                  {/* Top 5 Teams */}
                  {teamResults.length > 0 && (
                    <div className="top-teams">
                      <h3><Trophy /> أفضل 5 فرق</h3>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px' }}>
                        {teamResults.slice(0, 5).map((team, index) => (
                          <div key={team.teamName} className={`top-team top-team--${index + 1}`}>
                            <div className="top-team__bar" />
                            <span className={`rank-badge rank-badge--${index + 1}`}>{index + 1}</span>
                            <div className="top-team__name">{team.teamName}</div>
                            <div className="top-team__score">{team.score.toFixed(2)}</div>
                            <div className="top-team__unit">نقطة</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Statistics */}
                  <div className="panel panel--tint mb-5">
                    <h3 className="panel-title"><BarChart3 /> إحصائيات الجلسة</h3>
                    <div className="stat-grid">
                      <div className="stat-card stat-card--blue">
                        <div className="stat-value">{session.teams?.length || 0}</div>
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
                        <div className="stat-value">{session.judges.length}</div>
                        <div className="stat-label">المحكمون</div>
                      </div>
                    </div>
                  </div>

                  {/* Team Results */}
                  {teamResults.length === 0 ? (
                    <div className="empty-state">
                      <ClipboardList />
                      <p>لا توجد نتائج لهذه الجلسة</p>
                    </div>
                  ) : (
                    <div>
                      <h3 className="panel-title mb-4" style={{ fontSize: '17px' }}>
                        <Trophy /> نتائج الفرق
                      </h3>

                      {teamResults.map((team, index) => (
                        <div key={team.teamName} className="team-result">
                          <div className="team-result__head">
                            <h4>
                              <span className={`rank-badge rank-badge--${index + 1}`}>{index + 1}</span>
                              <Users size={18} className="text-secondary" />
                              {team.teamName}
                            </h4>
                            <span className="score-pill">
                              <Trophy />
                              {team.score.toFixed(2)} نقطة
                            </span>
                          </div>

                          {/* Formula Display */}
                          <div className="formula-box">
                            <div className="formula-box__title"><Calculator /> معادلة الحساب</div>
                            <div className="formula-box__body">النقاط = (وزن الخيار ÷ أقصى وزن) × وزن السؤال</div>
                          </div>

                          <div className="table-wrap">
                            <table className="leaderboard-table">
                              <thead>
                                <tr>
                                  <th>#</th>
                                  <th>المحكم</th>
                                  <th>الإجابة</th>
                                  <th className="num">وزن الخيار</th>
                                  <th className="num">أقصى وزن</th>
                                  <th className="num">وزن السؤال</th>
                                  <th>الحساب</th>
                                  <th className="num">النقاط</th>
                                  <th>الوقت</th>
                                </tr>
                              </thead>
                              <tbody>
                                {team.answers.map((answer, idx) => {
                                  const question = session.questions.get(answer.question_id);
                                  const calc = getCalculationDetails(answer, question);
                                  return (
                                    <tr key={answer.id}>
                                      <td className="text-secondary">{idx + 1}</td>
                                      <td className="fw-600">{getJudgeName(answer.judge_id, session.judges)}</td>
                                      <td>{answer.answer}</td>
                                      <td className="num text-secondary">{calc.choiceWeight}</td>
                                      <td className="num text-secondary">{calc.maxWeight}</td>
                                      <td className="num text-secondary">{calc.questionWeight}</td>
                                      <td className="mono text-xs text-secondary">{calc.formula}</td>
                                      <td className="num fw-700 text-primary" style={{ fontSize: '15px' }}>
                                        {(answer.points || 1).toFixed(2)}
                                      </td>
                                      <td className="text-xs text-secondary">
                                        {new Date(answer.created_at || '').toLocaleTimeString('ar-SA')}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      ))}
                    </div>
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
