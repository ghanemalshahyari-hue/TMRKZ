import { useEffect, useRef, useState } from 'react';
import { ApiError, api, newIdempotencyKey } from '../api/client';
import type { ApprovalDocument, DecisionKind, MyTask, ReasonCode, RequestDetail } from '../api/types';
import { useApp } from '../lib/app';
import { REASON_CODES, SIGNATURE_DISCLAIMER } from '../lib/labels';
import { Dialog, DialogHead } from './ui';

export type DecisionTarget = { request: RequestDetail; task: MyTask; decision: DecisionKind };

export function DecisionDialog({ target, onClose, onDone }: { target: DecisionTarget | null; onClose: () => void; onDone: (r: RequestDetail) => void }) {
  const app = useApp();
  const [note, setNote] = useState('');
  const [reasonCode, setReasonCode] = useState<ReasonCode>('INCOMPLETE_DATA');
  const [password, setPassword] = useState('');
  const [ack, setAck] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [doc, setDoc] = useState<ApprovalDocument | null>(null);
  // one key per opened decision so a retried click after a lost response replays instead of duplicating
  const key = useRef(newIdempotencyKey());

  const needsSignature = !!target && target.decision === 'APPROVE' && target.task.final && target.task.requiresSignature;
  const pki = doc?.signatureMode === 'PKI' || app.settings?.signatureMode === 'PKI';

  useEffect(() => {
    setNote('');
    setPassword('');
    setAck(false);
    setError('');
    setDoc(null);
    key.current = newIdempotencyKey();
    if (target && target.decision === 'APPROVE' && target.task.final && target.task.requiresSignature) {
      api
        .approvalDocument(target.task.taskId)
        .then(setDoc)
        .catch((e: Error) => setError(e.message));
    }
  }, [target]);

  if (!target) return <Dialog open={false} onClose={onClose} className="small-dialog">{null}</Dialog>;
  const { request: r, task, decision } = target;
  const title = decision === 'RETURN' ? 'إرجاع للتعديل' : decision === 'REJECT' ? 'رفض الطلب' : task.final ? 'اعتماد الطلب' : 'تسجيل الموافقة';

  const apply = async () => {
    const trimmed = note.trim();
    if (decision !== 'APPROVE' && trimmed.length < 5) return setError('اكتب سبباً من 5 أحرف على الأقل.');
    if (needsSignature && !pki && (!password || !ack)) return setError('أدخل كلمة المرور وأكّد الاعتماد للتوثيق الداخلي.');
    setBusy(true);
    setError('');
    try {
      const next = await api.decide(
        task.taskId,
        {
          decision,
          note: trimmed || undefined,
          reasonCode: decision === 'RETURN' ? reasonCode : undefined,
          expectedRevision: r.revision,
          signature: needsSignature ? { password, confirm: ack } : undefined,
        },
        key.current,
      );
      app.toast(
        next.status === 'APPROVED'
          ? 'اكتمل الاعتماد وثُبت الحجز في قاعدة البيانات'
          : decision === 'RETURN'
            ? 'أعيد الطلب مع الملاحظة'
            : decision === 'REJECT'
              ? 'سُجل الرفض'
              : 'سُجلت الموافقة وانتقل مسار المراجعة',
      );
      onDone(next);
      app.bump();
    } catch (e) {
      const err = e as ApiError;
      if (err.code === 'RESERVATION_CONFLICT')
        setError('تعذر تثبيت الحجز: ' + err.message + ' لم يُسجل القرار ولم يُنشأ أي حجز جزئي. يمكن إرجاع الطلب لتعديل الفترة.');
      else if (err.code === 'STALE_REVISION') setError('تغيّر الطلب منذ فتحه (' + err.message + '). أعد تحميل الطلب ثم راجع النسخة الأحدث.');
      else setError(err.message);
      // A definitive server answer consumed nothing, so allow a fresh attempt. After a network failure the
      // outcome is unknown: keep the key so a retry replays the stored result instead of deciding twice.
      if (err.status !== 0) key.current = newIdempotencyKey();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} className="small-dialog">
      <DialogHead eyebrow={'DECISION / ' + r.number} title={title} onClose={onClose} />
      <div className="dialog-content">
        <p className="micro muted" style={{ marginBottom: 12 }}>
          {task.stageName} · {task.roleName} · المراجعة {r.revision}
        </p>
        {decision === 'RETURN' && (
          <label className="field">
            <span>سبب الإرجاع</span>
            <select value={reasonCode} onChange={(e) => setReasonCode(e.target.value as ReasonCode)}>
              {REASON_CODES.map(([c, l]) => (
                <option key={c} value={c}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          <span>الملاحظة {decision === 'APPROVE' ? '— اختيارية' : '— مطلوبة'}</span>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="اكتب سبب القرار أو الملاحظة…" />
        </label>
        {needsSignature && (
          <>
            {doc && (
              <div className="wizard-summary" style={{ marginBottom: 14 }}>
                {doc.lines.map((l) => (
                  <div key={l.label} className="key-value">
                    <span>{l.label}</span>
                    <b style={{ maxWidth: '70%' }}>{l.value}</b>
                  </div>
                ))}
                <div className="key-value">
                  <span>بصمة المستند</span>
                  <b className="latin tiny" style={{ maxWidth: '70%', wordBreak: 'break-all' }}>
                    {doc.sha256}
                  </b>
                </div>
              </div>
            )}
            {pki ? (
              <div className="note orange">نمط التوقيع المهيأ «توقيع بشهادة (PKI)» غير مربوط بمزود شهادات بعد (القرار D-02). لن يُسجل اعتماد دون توقيع صحيح.</div>
            ) : (
              <>
                <label className="field">
                  <span>كلمة المرور لتأكيد هوية المعتمد</span>
                  <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
                </label>
                <label className="check-label">
                  <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                  أؤكد اعتماد المراجعة {doc?.revision ?? r.revision} كما هي معروضة
                </label>
              </>
            )}
            <div className="signature-preview">
              <span className="eyebrow">SIGNATURE / {pki ? 'PKI — NOT CONNECTED' : 'INTERNAL ATTESTATION'}</span>
              <span className="signature-name">{app.me.displayName}</span>
              <br />
              <small>{pki ? 'يتطلب مزود شهادات معتمداً.' : SIGNATURE_DISCLAIMER + '. يرتبط بالبصمة والمراجعة ووقت الخادم.'}</small>
            </div>
          </>
        )}
        <div className="error-text" role="alert">
          {error}
        </div>
      </div>
      <div className="dialog-actions">
        <button className="button primary" disabled={busy} onClick={apply}>
          {busy ? 'جارٍ التسجيل…' : 'تأكيد القرار'}
        </button>
        <button className="button" onClick={onClose}>
          إلغاء
        </button>
      </div>
    </Dialog>
  );
}
