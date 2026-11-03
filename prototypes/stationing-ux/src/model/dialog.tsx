import { useEffect, useRef, useState } from 'react';
import { person, type Action, type World } from './domain';

/**
 * A sensitive action's own confirmation (owner brief B3): what is done, to which record, with which consequence, by whom
 * (simulated), and a mandatory reason — plus a policy reference for an availability exception. Nothing happens until the
 * reason is given and the action confirmed.
 */
export type Ask = {
  action: Action;
  title: string;
  record: string;
  consequence: string;
  kind: 'auth' | 'destructive' | 'normal';
  confirm: string;
  policyRef?: boolean;
};

export function ActionDialog({ ask, world, actor, onCancel, onConfirm }: { ask: Ask; world: World; actor: string; onCancel: () => void; onConfirm: (reason: string, policyRef: string) => void }) {
  const [reason, setReason] = useState('');
  const [policy, setPolicy] = useState('');
  const first = useRef<HTMLTextAreaElement>(null);
  const me = person(world, actor);
  const ok = reason.trim().length >= 10 && (!ask.policyRef || policy.trim().length >= 3);
  useEffect(() => {
    first.current?.focus();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onCancel]);
  return (
    <div className="md-modal" onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div className={'md-dialog ' + ask.kind} role="dialog" aria-modal="true" aria-labelledby="md-dlg-title" data-testid="action-dialog" data-action={ask.action.t}>
        <header>
          <span className="md-dialog-kind">{ask.kind === 'auth' ? '⚑ إجراء نافذ' : ask.kind === 'destructive' ? '⚠ إجراء لا يُعكس' : 'إجراء مُدقَّق'}</span>
          <h3 id="md-dlg-title">{ask.title}</h3>
        </header>
        <dl className="md-dl">
          <dt>السجل المتأثر</dt>
          <dd data-testid="dialog-record">{ask.record}</dd>
          <dt>الأثر</dt>
          <dd data-testid="dialog-consequence">{ask.consequence}</dd>
          <dt>تنفذه بصفة</dt>
          <dd data-testid="dialog-actor">
            {me?.name} — {me?.title} <em className="md-sim-mark">محاكاة</em>
          </dd>
        </dl>
        <label className="md-field">
          السبب (إلزامي، 10 أحرف على الأقل)
          <textarea ref={first} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} data-testid="dialog-reason" />
        </label>
        {ask.policyRef && (
          <label className="md-field">
            مرجع السياسة التي تجيز المشاركة أو الاستثناء (إلزامي)
            <input value={policy} onChange={(e) => setPolicy(e.target.value)} data-testid="dialog-policy" />
          </label>
        )}
        <p className="ux-note">يُسجَّل الإجراء وسببه وصفتك في سجل التدقيق.</p>
        <div className="md-dialog-actions">
          <button className="ux-btn" onClick={onCancel}>
            تراجع
          </button>
          <button className={'ux-btn ' + (ask.kind === 'destructive' ? 'danger' : 'primary')} disabled={!ok} onClick={() => onConfirm(reason.trim(), policy.trim())} data-testid="dialog-confirm">
            {ask.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
