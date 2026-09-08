import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  Activity,
  HeartPulse,
  Plug,
  ScrollText,
  ClipboardList,
  Wifi,
  WifiOff,
  RefreshCw,
  AlertTriangle
} from 'lucide-react';
import { useConnectionHealth } from '../hooks/useConnectionHealth';
import { STALE_THRESHOLD_MS, HEALTH_CHECK_INTERVAL_MS } from '../lib/connectionHealth';
import BrandHeader from '../components/BrandHeader';

const statusMeta = {
  connected: { icon: Wifi, label: 'متصل', cls: 'conn-chip--connected' },
  reconnecting: { icon: RefreshCw, label: 'إعادة الاتصال...', cls: 'conn-chip--reconnecting' },
  disconnected: { icon: WifiOff, label: 'غير متصل', cls: 'conn-chip--disconnected' }
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

function channelBadge(status: string) {
  const cls = status === 'SUBSCRIBED' ? 'badge-success' : status === 'joining' ? 'badge-warning' : 'badge-danger';
  return <span className={`badge ${cls} mono`}>{status}</span>;
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
  const StatusIcon = meta.icon;
  const msSinceHeartbeat = health.lastHeartbeatAt === null ? null : now - health.lastHeartbeatAt;
  const isStale = msSinceHeartbeat !== null && msSinceHeartbeat > STALE_THRESHOLD_MS;
  const subscribedCount = health.channels.filter(c => c.status === 'SUBSCRIBED').length;
  const hasSession = health.sessionId !== '';

  return (
    <div className="app-shell">
      <BrandHeader title="صحة الاتصال">
        <span className={`conn-chip ${meta.cls}`}>
          <StatusIcon className={health.status === 'reconnecting' ? 'spin' : ''} />
          {meta.label}
        </span>
        <Link to="/host" className="btn btn-sm btn-pill btn-on-blue">
          <ArrowRight />
          لوحة التحكم
        </Link>
      </BrandHeader>

      <div className="container">
        <div className="page-head">
          <div>
            <h1>صحة الاتصال</h1>
            <p>مراقبة حيّة لقنوات الوقت الفعلي ونبض الاتصال بالجلسة الجارية.</p>
          </div>
        </div>

        {!hasSession && (
          <div className="alert alert-info">
            <Activity />
            <span>لا توجد جلسة نشطة. ابدأ جلسة من لوحة التحكم أولاً.</span>
          </div>
        )}

        <div className="dashboard-grid">
          {/* Session Card */}
          <div className="card">
            <div className="card-header">
              <div className="card-title">
                <div className="card-icon"><ClipboardList /></div>
                <span>الجلسة</span>
              </div>
            </div>
            <table className="leaderboard-table">
              <tbody>
                <tr>
                  <td>معرف الجلسة</td>
                  <td className="num fw-600 mono">{health.sessionId || '—'}</td>
                </tr>
                <tr>
                  <td>بدأت</td>
                  <td className="num">{formatTime(health.sessionStartedAt)}</td>
                </tr>
                <tr>
                  <td>مدة التشغيل</td>
                  <td className="num">{formatAgo(health.sessionStartedAt, now)}</td>
                </tr>
                <tr>
                  <td>محاولات إعادة الاتصال</td>
                  <td className={`num fw-600 ${health.reconnectCount > 0 ? 'text-warning' : ''}`}>
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
                <div className="card-icon"><HeartPulse /></div>
                <span>نبض الاتصال (Heartbeat)</span>
              </div>
              {hasSession && (
                <span className={`badge ${isStale ? 'badge-danger' : 'badge-success'}`}>
                  {isStale ? <AlertTriangle /> : <Activity />}
                  {isStale ? 'متجمد' : 'حي'}
                </span>
              )}
            </div>
            <table className="leaderboard-table">
              <tbody>
                <tr>
                  <td>آخر نبضة</td>
                  <td className="num">{formatTime(health.lastHeartbeatAt)}</td>
                </tr>
                <tr>
                  <td>منذ آخر نبضة</td>
                  <td className={`num fw-600 ${isStale ? 'text-danger' : ''}`}>
                    {formatAgo(health.lastHeartbeatAt, now)}
                  </td>
                </tr>
                <tr>
                  <td>عتبة التجمّد</td>
                  <td className="num">{STALE_THRESHOLD_MS / 1000} ثانية</td>
                </tr>
                <tr>
                  <td>فحص الصحة كل</td>
                  <td className="num">{HEALTH_CHECK_INTERVAL_MS / 1000} ثانية</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Channel Pool Card */}
          <div className="card span-2">
            <div className="card-header">
              <div className="card-title">
                <div className="card-icon"><Plug /></div>
                <span>مجموعة القنوات (Channel Pool)</span>
              </div>
              {health.channels.length > 0 && (
                <span className={`badge ${subscribedCount === health.channels.length ? 'badge-success' : 'badge-warning'}`}>
                  {subscribedCount}/{health.channels.length} مشتركة
                </span>
              )}
            </div>
            <div className="table-wrap">
              <table className="leaderboard-table">
                <thead>
                  <tr>
                    <th>القناة</th>
                    <th>الحالة</th>
                    <th>وقت الاشتراك</th>
                    <th>آخر حدث</th>
                    <th className="num">عدد الأحداث</th>
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
                        <td className="mono text-sm">{channel.name}</td>
                        <td>{channelBadge(channel.status)}</td>
                        <td>{formatTime(channel.subscribedAt)}</td>
                        <td>{formatAgo(channel.lastEventAt, now)}</td>
                        <td className="num fw-600">{channel.eventCount}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Event Log Card */}
          <div className="card span-2">
            <div className="card-header">
              <div className="card-title">
                <div className="card-icon"><ScrollText /></div>
                <span>سجل الأحداث</span>
              </div>
            </div>
            <div className="answers-container" style={{ maxHeight: '300px' }}>
              {health.log.length === 0 ? (
                <div className="empty-state">لا توجد أحداث بعد</div>
              ) : (
                <ul className="list-plain text-sm">
                  {health.log.map((entry, idx) => (
                    <li
                      key={idx}
                      style={{
                        padding: '6px 8px',
                        borderBottom: '1px solid var(--border)',
                        display: 'flex',
                        gap: '12px'
                      }}
                    >
                      <span className="text-secondary mono" style={{ flexShrink: 0 }}>
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
    </div>
  );
}
