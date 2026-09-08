import { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Plus,
  LogOut,
  User,
  Users,
  Calendar,
  ListChecks,
  Archive,
  SlidersHorizontal,
  BarChart3,
  Inbox
} from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { getSessionsByHost } from '../lib/supabaseService';
import BrandHeader from '../components/BrandHeader';
import type { SessionSummary } from '../types';

/**
 * Admin dashboard — "جلساتي".
 * Shows only the sessions owned by the logged-in admin.
 */
export default function DashboardPage() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadSessions = useCallback(async () => {
    if (!user) return;
    try {
      const data = await getSessionsByHost(user.id);
      setSessions(data);
      setError('');
    } catch (err) {
      console.error('Error loading sessions:', err);
      setError('خطأ في تحميل الجلسات');
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const handleSignOut = async () => {
    try {
      await signOut();
      navigate('/login', { replace: true });
    } catch (err) {
      console.error('Error signing out:', err);
    }
  };

  const isActive = (s: SessionSummary) => s.status !== 'completed';
  const activeSessions = sessions.filter(isActive);
  const pastSessions = sessions.filter(s => !isActive(s));

  const renderSessionRow = (session: SessionSummary, active: boolean) => (
    <li key={session.id} className={`list-row ${active ? 'list-row--active' : ''}`}>
      <div className="list-row__main">
        <span className={`badge badge-dot ${active ? 'badge-success badge-pulse' : 'badge-neutral'}`}>
          {active ? 'نشطة' : 'منتهية'}
        </span>
        <span className="mono fw-700" style={{ fontSize: '15px' }}>
          {session.session_id}
        </span>
        <span className="list-row__meta">
          <Calendar />
          {session.created_at ? new Date(session.created_at).toLocaleString('ar-SA') : ''}
        </span>
        <span className="list-row__meta">
          <Users />
          {session.team_count} فريق
        </span>
      </div>
      <div className="list-row__actions">
        {active && (
          <Link to={`/host/${session.session_id}/control`} className="btn btn-primary btn-sm btn-pill">
            <SlidersHorizontal />
            استئناف التحكم
          </Link>
        )}
        <Link to="/results" className="btn btn-secondary btn-sm btn-pill">
          <BarChart3 />
          النتائج
        </Link>
      </div>
    </li>
  );

  return (
    <div className="app-shell">
      <BrandHeader title="جلساتي">
        <span className="brand-header__user">
          <User size={14} />
          {user?.email}
        </span>
        <button className="btn btn-sm btn-pill btn-on-blue" onClick={handleSignOut}>
          <LogOut />
          تسجيل خروج
        </button>
      </BrandHeader>

      <div className="container">
        <div className="page-head">
          <div>
            <h1>جلساتي</h1>
            <p>أنشئ جلسات التحكيم وتابع الجلسات النشطة والسابقة من مكان واحد.</p>
          </div>
          <div className="page-head__actions">
            <Link to="/host/new" className="btn btn-primary btn-pill">
              <Plus />
              إنشاء جلسة جديدة
            </Link>
          </div>
        </div>

        <div className="card mb-6">
          <div className="card-header">
            <div className="card-title">
              <div className="card-icon"><Plus /></div>
              <span>جلسة تحكيم جديدة</span>
            </div>
          </div>
          <p className="card-desc">
            أنشئ جلسة جديدة بثلاث خطوات بسيطة: الفرق، ثم بنك الأسئلة، ثم دعوة المحكمين برابط خاص.
          </p>
          <Link to="/host/new" className="btn btn-primary btn-lg btn-block">
            <Plus />
            إنشاء جلسة جديدة
          </Link>
        </div>

        <div className="card">
          <div className="card-header">
            <div className="card-title">
              <div className="card-icon"><ListChecks /></div>
              <span>الجلسات النشطة ({activeSessions.length})</span>
            </div>
          </div>
          {loading ? (
            <div className="loading-screen" style={{ minHeight: '120px' }}>
              <div className="spinner" />
              <div>جاري التحميل...</div>
            </div>
          ) : error ? (
            <div className="empty-state">{error}</div>
          ) : (
            <ul className="list-plain">
              {activeSessions.length === 0 ? (
                <li className="empty-state">
                  <Inbox />
                  <h3>لا توجد جلسات نشطة</h3>
                  <p>أنشئ جلسة جديدة للبدء</p>
                </li>
              ) : (
                activeSessions.map(s => renderSessionRow(s, true))
              )}
            </ul>
          )}
        </div>

        {pastSessions.length > 0 && (
          <div className="card mt-5">
            <div className="card-header">
              <div className="card-title">
                <div className="card-icon"><Archive /></div>
                <span>الجلسات السابقة ({pastSessions.length})</span>
              </div>
            </div>
            <ul className="list-plain">
              {pastSessions.map(s => renderSessionRow(s, false))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
