import { useState, type FormEvent } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

export default function LoginPage() {
  const { user, loading, signIn } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Already logged in → go straight to the dashboard
  if (!loading && user) {
    return <Navigate to="/host" replace />;
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) {
      setError('يرجى إدخال البريد الإلكتروني وكلمة المرور');
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      await signIn(email.trim(), password);
      navigate('/host', { replace: true });
    } catch {
      setError('بيانات الدخول غير صحيحة، حاول مرة أخرى');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="container" style={{ maxWidth: '480px' }}>
      <div className="header">
        <h1>تسجيل دخول المشرف</h1>
      </div>

      <div className="card">
        <div className="card-header">
          <div className="card-title">
            <div className="card-icon">🔐</div>
            <span>دخول المشرفين</span>
          </div>
        </div>

        <form onSubmit={handleSubmit}>
          <label htmlFor="email">البريد الإلكتروني</label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="admin@example.com"
            autoComplete="email"
            style={{
              width: '100%',
              padding: '10px 12px',
              border: '2px solid var(--border-color)',
              borderRadius: '8px',
              marginBottom: '16px',
              boxSizing: 'border-box'
            }}
          />

          <label htmlFor="password">كلمة المرور</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            autoComplete="current-password"
            style={{
              width: '100%',
              padding: '10px 12px',
              border: '2px solid var(--border-color)',
              borderRadius: '8px',
              marginBottom: '16px',
              boxSizing: 'border-box'
            }}
          />

          {error && (
            <div style={{
              background: '#fef2f2',
              border: '1px solid #ef4444',
              color: '#ef4444',
              padding: '10px 12px',
              borderRadius: '8px',
              marginBottom: '16px',
              fontSize: '14px',
              fontWeight: 600
            }}>
              ⚠️ {error}
            </div>
          )}

          <button
            type="submit"
            className="btn btn-primary"
            disabled={submitting}
            style={{ width: '100%' }}
          >
            <span>{submitting ? '⏳' : '🚀'}</span>
            {submitting ? 'جاري الدخول...' : 'دخول'}
          </button>
        </form>
      </div>
    </div>
  );
}
