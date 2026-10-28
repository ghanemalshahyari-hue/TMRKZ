import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api/client';
import type { DemoUser, Me } from '../api/types';
import { Icon } from '../components/ui';

export function LoginPage({ onLogin }: { onLogin: (me: Me) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [demo, setDemo] = useState<DemoUser[]>([]);

  useEffect(() => {
    api
      .demoUsers()
      .then((d) => setDemo(d.enabled ? d.users : []))
      .catch(() => setDemo([]));
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!username || !password) return setError('أدخل اسم المستخدم وكلمة المرور.');
    setBusy(true);
    setError('');
    try {
      onLogin(await api.login(username.trim(), password));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-shell">
      <form className="card login-card" onSubmit={submit}>
        <div className="login-brand">
          <span className="brand-logo">
            <Icon name="map" />
          </span>
          <span>
            <strong>
              MOVER<span>.</span>
            </strong>
            <small>المواقع · المرافق · الإجراءات</small>
          </span>
        </div>
        <span className="eyebrow">SIGN IN / ENTERPRISE WORKSPACE</span>
        <h1>تسجيل الدخول</h1>
        <p className="micro muted" style={{ marginBottom: 18 }}>
          الجلسة تُدار في الخادم داخل الشبكة المعزولة، وتُقيّم الصلاحيات عند كل إجراء.
        </p>
        <label className="field">
          <span>اسم المستخدم</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus dir="ltr" />
        </label>
        <label className="field">
          <span>كلمة المرور</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" dir="ltr" />
        </label>
        <div className="error-text" role="alert">
          {error}
        </div>
        <button className="button primary full" disabled={busy}>
          {busy ? 'جارٍ التحقق…' : 'دخول'}
        </button>
        {demo.length > 0 && (
          <div className="login-demo">
            <span className="eyebrow">DEMO ACCOUNTS / FICTIONAL DATA</span>
            <p className="micro muted">حسابات تجريبية لبيانات افتراضية. كلمة المرور يحددها مشغل البيئة (MOVER_DEMO_PASSWORD).</p>
            <div className="login-demo-list">
              {demo.map((u) => (
                <button type="button" key={u.username} className={'site-row ' + (username === u.username ? 'active' : '')} onClick={() => setUsername(u.username)}>
                  <span className="latin">{u.username.slice(0, 2).toUpperCase()}</span>
                  <div>
                    <b>{u.displayName}</b>
                    <small>
                      {u.roleName} · {u.orgName}
                    </small>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
      </form>
    </div>
  );
}
