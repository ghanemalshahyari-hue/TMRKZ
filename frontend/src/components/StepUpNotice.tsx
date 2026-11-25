import { useState } from 'react';
import { api } from '../api/client';
import { useApp } from '../lib/app';

/**
 * A decision that needs a recent sign-in (applying an update or a certificate, rolling back, restoring) and the session is older:
 * confirm the identity here, then the action runs again (ADR-105; the same rule and the same two ways as «الاعتماد» in
 * DecisionDialog). With the directory: the person's own directory password. Otherwise the identity provider is asked again —
 * the page returns here and `resume` names what to reopen (kept in this tab only).
 */
export function StepUpNotice({ onConfirmed, resume, onCancel }: { onConfirmed: () => Promise<void>; resume: string; onCancel: () => void }) {
  const app = useApp();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const directory = app.me.signInMethod === 'DIRECTORY';
  return (
    <div className="note orange" role="alert" data-testid="stepup-notice" style={{ margin: '10px 0' }}>
      {directory
        ? 'هذا القرار يتطلب تأكيد هويتك بكلمة مرورك في الدليل المؤسسي (مرت أكثر من خمس دقائق على دخولك). لم يتغير شيء.'
        : 'هذا القرار يتطلب تحققاً حديثاً من هويتك لدى خدمة الدخول (مرت أكثر من خمس دقائق على دخولك). لم يتغير شيء.'}
      <div className="flex" style={{ marginTop: 8, gap: 8, flexWrap: 'wrap' }}>
        {directory && (
          <input type="password" autoComplete="current-password" aria-label="كلمة المرور" value={password} onChange={(e) => setPassword(e.target.value)} />
        )}
        <button
          className="button compact"
          disabled={busy || (directory && !password)}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              if (directory) {
                await api.directoryReauth(password);
                setPassword('');
                await onConfirmed();
              } else {
                sessionStorage.setItem('tmrkz-resume', resume);
                window.location.assign((await api.reauth('/' + window.location.hash)).redirect);
              }
            } catch (e) {
              setPassword('');
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {directory ? 'تأكيد الهوية والمتابعة' : 'إعادة التحقق من الهوية'}
        </button>
        <button className="button compact" onClick={onCancel}>إلغاء</button>
      </div>
      {error && <p className="micro">{error}</p>}
    </div>
  );
}

/** What a page asked to reopen after the identity provider sent the person back (read once). */
export function takeResume(prefix: string): string | null {
  const v = sessionStorage.getItem('tmrkz-resume');
  if (!v || !v.startsWith(prefix)) return null;
  sessionStorage.removeItem('tmrkz-resume');
  return v.slice(prefix.length);
}
