import { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { getSessionsByHost } from '../lib/supabaseService';
import type { Session } from '../types';

/**
 * Admin dashboard — "جلساتي".
 * Shows only the sessions owned by the logged-in admin.
 */
export default function DashboardPage() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<Session[]>([]);
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

  const isActive = (s: Session) => s.current_team_id !== 'completed';
  const activeSessions = sessions.filter(isActive);
  const pastSessions = sessions.filter(s => !isActive(s));

  const renderSessionRow = (session: Session, active: boolean) => (
    <li key={session.id} style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '12px',
      padding: '14px 16px',
      background: 'white',
      border: `2px solid ${active ? '#10b981' : 'var(--border-color)'}`,
      borderRadius: '12px',
      marginBottom: '10px',
      flexWrap: 'wrap'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <span style={{
          background: active ? '#10b981' : '#9ca3af',
          color: 'white',
          padding: '3px 10px',
          borderRadius: '10px',
          fontSize: '12px',
          fontWeight: 600
        }}>
          {active ? '🟢 نشطة' : '⚪ منتهية'}
        </span>
        <span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: '16px' }}>
          {session.session_id}
        </span>
        <span style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>
          {session.created_at ? new Date(session.created_at).toLocaleString() : ''}
        </span>
        <span style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>
          👥 {session.teams?.length ?? 0} فريق
        </span>
      </div>
      <div style={{ display: 'flex', gap: '8px' }}>
        {active && (
          <Link to={`/host/${session.session_id}/control`} className="btn btn-primary"
            style={{ textDecoration: 'none', fontSize: '13px', padding: '6px 14px' }}>
            🎛️ استئناف التحكم
          </Link>
        )}
        <Link to="/results" className="btn btn-secondary"
          style={{ textDecoration: 'none', fontSize: '13px', padding: '6px 14px' }}>
          📊 النتائج
        </Link>
      </div>
    </li>
  );

  return (
    <div className="container">
      <div className="header">
        <h1>جلساتي</h1>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>
            👤 {user?.email}
          </span>
          <button className="btn btn-secondary" onClick={handleSignOut}
            style={{ fontSize: '13px', padding: '6px 14px' }}>
            🚪 تسجيل خروج
          </button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: '24px' }}>
        <div className="card-header">
          <div className="card-title">
            <div className="card-icon">➕</div>
            <span>جلسة تحكيم جديدة</span>
          </div>
        </div>
        <p style={{ color: 'var(--text-secondary)', marginTop: 0 }}>
          أنشئ جلسة جديدة بثلاث خطوات بسيطة: الفرق ← بنك الأسئلة ← دعوة المحكمين برابط خاص.
        </p>
        <Link to="/host/new" className="btn btn-success" style={{ textDecoration: 'none', width: '100%' }}>
          <span>🚀</span>
          إنشاء جلسة جديدة
        </Link>
      </div>

      <div className="card">
        <div className="card-header">
          <div className="card-title">
            <div className="card-icon">📋</div>
            <span>الجلسات النشطة ({activeSessions.length})</span>
          </div>
        </div>
        {loading ? (
          <div className="empty-state">جاري التحميل...</div>
        ) : error ? (
          <div className="empty-state">{error}</div>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {activeSessions.length === 0 ? (
              <li className="empty-state">لا توجد جلسات نشطة — أنشئ جلسة جديدة للبدء</li>
            ) : (
              activeSessions.map(s => renderSessionRow(s, true))
            )}
          </ul>
        )}
      </div>

      {pastSessions.length > 0 && (
        <div className="card" style={{ marginTop: '24px' }}>
          <div className="card-header">
            <div className="card-title">
              <div className="card-icon">🗂️</div>
              <span>الجلسات السابقة ({pastSessions.length})</span>
            </div>
          </div>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {pastSessions.map(s => renderSessionRow(s, false))}
          </ul>
        </div>
      )}
    </div>
  );
}
