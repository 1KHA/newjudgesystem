import { useEffect, useState } from 'react';
import { useConnectionHealth } from '../hooks/useConnectionHealth';
import { STALE_THRESHOLD_MS, HEALTH_CHECK_INTERVAL_MS } from '../lib/connectionHealth';

const statusMeta = {
  connected: { color: '#10b981', icon: '🟢', label: 'متصل' },
  reconnecting: { color: '#f59e0b', icon: '🟡', label: 'إعادة الاتصال...' },
  disconnected: { color: '#ef4444', icon: '🔴', label: 'غير متصل' }
} as const;

function formatAgo(ts: number | null, now: number): string {
  if (ts === null) return '—';
  const seconds = Math.max(0, Math.floor((now - ts) / 1000));
  if (seconds < 60) return `منذ ${seconds} ثانية`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `منذ ${minutes} دقيقة`;
  return `منذ ${Math.floor(minutes / 60)} ساعة`;
}

function formatTime(ts: number | null): string {
  if (ts === null) return '—';
  return new Date(ts).toLocaleTimeString();
}

export default function HealthPage() {
  const health = useConnectionHealth();
  // Tick every second so "time since heartbeat" stays live
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const meta = statusMeta[health.status];
  const msSinceHeartbeat = health.lastHeartbeatAt === null ? null : now - health.lastHeartbeatAt;
  const isStale = msSinceHeartbeat !== null && msSinceHeartbeat > STALE_THRESHOLD_MS;
  const subscribedCount = health.channels.filter(c => c.status === 'SUBSCRIBED').length;
  const hasSession = health.sessionId !== '';

  return (
    <div className="container">
      <div className="header">
        <h1>صحة الاتصال</h1>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          <div
            style={{
              padding: '8px 16px',
              borderRadius: '8px',
              background: meta.color,
              color: 'white',
              fontSize: '12px',
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              gap: '6px'
            }}
          >
            <span>{meta.icon}</span>
            <span>{meta.label}</span>
          </div>
          <a href="/host" className="btn btn-secondary" style={{ textDecoration: 'none', fontSize: '14px' }}>
            ← لوحة التحكم
          </a>
        </div>
      </div>

      {!hasSession && (
        <div className="card" style={{ marginBottom: '24px' }}>
          <div className="empty-state">لا توجد جلسة نشطة — ابدأ جلسة من لوحة التحكم أولاً</div>
        </div>
      )}

      <div className="dashboard-grid">
        {/* Session Card */}
        <div className="card">
          <div className="card-header">
            <div className="card-title">
              <div className="card-icon">📋</div>
              <span>الجلسة</span>
            </div>
          </div>
          <table className="leaderboard-table">
            <tbody>
              <tr>
                <td>معرف الجلسة</td>
                <td style={{ textAlign: 'left', fontWeight: 600 }}>{health.sessionId || '—'}</td>
              </tr>
              <tr>
                <td>بدأت</td>
                <td style={{ textAlign: 'left' }}>{formatTime(health.sessionStartedAt)}</td>
              </tr>
              <tr>
                <td>مدة التشغيل</td>
                <td style={{ textAlign: 'left' }}>{formatAgo(health.sessionStartedAt, now)}</td>
              </tr>
              <tr>
                <td>محاولات إعادة الاتصال</td>
                <td style={{ textAlign: 'left', fontWeight: 600, color: health.reconnectCount > 0 ? '#f59e0b' : 'inherit' }}>
                  {health.reconnectCount}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Heartbeat Card */}
        <div className="card">
          <div className="card-header">
            <div className="card-title">
              <div className="card-icon">💓</div>
              <span>نبض الاتصال (Heartbeat)</span>
            </div>
            {hasSession && (
              <div style={{
                background: isStale ? '#ef4444' : '#10b981',
                color: 'white',
                padding: '4px 12px',
                borderRadius: '12px',
                fontSize: '12px',
                fontWeight: 600
              }}>
                {isStale ? '⚠️ متجمد' : '✓ حي'}
              </div>
            )}
          </div>
          <table className="leaderboard-table">
            <tbody>
              <tr>
                <td>آخر نبضة</td>
                <td style={{ textAlign: 'left' }}>{formatTime(health.lastHeartbeatAt)}</td>
              </tr>
              <tr>
                <td>منذ آخر نبضة</td>
                <td style={{ textAlign: 'left', fontWeight: 600, color: isStale ? '#ef4444' : 'inherit' }}>
                  {formatAgo(health.lastHeartbeatAt, now)}
                </td>
              </tr>
              <tr>
                <td>عتبة التجمّد</td>
                <td style={{ textAlign: 'left' }}>{STALE_THRESHOLD_MS / 1000} ثانية</td>
              </tr>
              <tr>
                <td>فحص الصحة كل</td>
                <td style={{ textAlign: 'left' }}>{HEALTH_CHECK_INTERVAL_MS / 1000} ثانية</td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Channel Pool Card */}
        <div className="card" style={{ gridColumn: 'span 2' }}>
          <div className="card-header">
            <div className="card-title">
              <div className="card-icon">🔌</div>
              <span>مجموعة القنوات (Channel Pool)</span>
            </div>
            {health.channels.length > 0 && (
              <div style={{
                background: subscribedCount === health.channels.length ? '#10b981' : '#f59e0b',
                color: 'white',
                padding: '4px 12px',
                borderRadius: '12px',
                fontSize: '12px',
                fontWeight: 600
              }}>
                {subscribedCount}/{health.channels.length} مشتركة
              </div>
            )}
          </div>
          <table className="leaderboard-table">
            <thead>
              <tr>
                <th>القناة</th>
                <th>الحالة</th>
                <th>وقت الاشتراك</th>
                <th>آخر حدث</th>
                <th style={{ textAlign: 'left' }}>عدد الأحداث</th>
              </tr>
            </thead>
            <tbody>
              {health.channels.length === 0 ? (
                <tr>
                  <td colSpan={5} className="empty-state">لا توجد قنوات نشطة</td>
                </tr>
              ) : (
                health.channels.map(channel => (
                  <tr key={channel.name}>
                    <td style={{ fontFamily: 'monospace', fontSize: '13px' }}>{channel.name}</td>
                    <td>
                      <span style={{
                        padding: '2px 8px',
                        borderRadius: '8px',
                        fontSize: '11px',
                        fontWeight: 600,
                        color: 'white',
                        background: channel.status === 'SUBSCRIBED' ? '#10b981' :
                                    channel.status === 'joining' ? '#f59e0b' : '#ef4444'
                      }}>
                        {channel.status}
                      </span>
                    </td>
                    <td>{formatTime(channel.subscribedAt)}</td>
                    <td>{formatAgo(channel.lastEventAt, now)}</td>
                    <td style={{ textAlign: 'left', fontWeight: 600 }}>{channel.eventCount}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Event Log Card */}
        <div className="card" style={{ gridColumn: 'span 2' }}>
          <div className="card-header">
            <div className="card-title">
              <div className="card-icon">📜</div>
              <span>سجل الأحداث</span>
            </div>
          </div>
          <div className="answers-container" style={{ maxHeight: '300px', overflowY: 'auto' }}>
            {health.log.length === 0 ? (
              <div className="empty-state">لا توجد أحداث بعد</div>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontFamily: 'monospace', fontSize: '13px' }}>
                {health.log.map((entry, idx) => (
                  <li key={idx} style={{
                    padding: '6px 8px',
                    borderBottom: '1px solid var(--border-color)',
                    display: 'flex',
                    gap: '12px'
                  }}>
                    <span style={{ color: 'var(--text-secondary)', flexShrink: 0 }}>
                      {new Date(entry.at).toLocaleTimeString()}
                    </span>
                    <span>{entry.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
