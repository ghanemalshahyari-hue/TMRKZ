import { useEffect, useRef, useState } from 'react';
import { ApiError, api, newIdempotencyKey } from '../api/client';
import type { ApprovalDocument, DecisionKind, MyTask, ReasonCode, RequestDetail, SigningJob } from '../api/types';
import { useApp } from '../lib/app';
import { REASON_CODES, SIGNATURE_DISCLAIMER } from '../lib/labels';
import { Dialog, DialogHead } from './ui';

export type DecisionTarget = { request: RequestDetail; task: MyTask; decision: DecisionKind };

export function DecisionDialog({ target, onClose, onDone }: { target: DecisionTarget | null; onClose: () => void; onDone: (r: RequestDetail) => void }) {
  const app = useApp();
  const [note, setNote] = useState('');
  const [reasonCode, setReasonCode] = useState<ReasonCode>('INCOMPLETE_DATA');
  const [ack, setAck] = useState(false);
  const [reauth, setReauth] = useState(false);
  const [reauthPassword, setReauthPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [doc, setDoc] = useState<ApprovalDocument | null>(null);
  const [job, setJob] = useState<SigningJob | null>(null);
  // one key per opened decision so a retried click after a lost response replays instead of duplicating
  const key = useRef(newIdempotencyKey());

  const needsSignature = !!target && target.decision === 'APPROVE' && target.task.final && target.task.requiresSignature;
  const pki = doc?.signatureMode === 'PKI' || app.settings?.signatureMode === 'PKI';

  useEffect(() => {
    setNote('');
    setAck(false);
    setReauth(false);
    setError('');
    setDoc(null);
    setJob(null);
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
  const title =
    decision === 'RETURN'
      ? task.final
        ? 'طلب تصحيح قبل القرار'
        : 'إرجاع للتصحيح'
      : decision === 'REJECT'
        ? 'رفض نهائي'
        : decision === 'REFER'
          ? 'إحالة للدراسة والقرار'
          : 'اعتماد الطلب';

  // PKI: the approver's certificate and the organisation's seal sign the frozen document first; nothing is decided yet
  const sign = async () => {
    setBusy(true);
    setError('');
    try {
      setJob(await api.signTask(task.taskId, r.revision));
    } catch (e) {
      const err = e as ApiError;
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    const trimmed = note.trim();
    if ((decision === 'RETURN' || decision === 'REJECT') && trimmed.length < 5) return setError('اكتب سبباً من 5 أحرف على الأقل.');
    if (needsSignature && !pki && !ack) return setError('أكّد الاعتماد للتوثيق الداخلي.');
    if (needsSignature && pki && job?.status !== 'SIGNED') return setError('وقّع المستند بشهادتك أولاً.');
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
          signature: needsSignature ? { confirm: pki ? true : ack } : undefined,
          signingJobId: needsSignature && pki ? job?.id : undefined,
        },
        key.current,
      );
      app.toast(
        next.status === 'APPROVED'
          ? 'اكتمل الاعتماد وثُبت الحجز في قاعدة البيانات'
          : decision === 'RETURN'
            ? 'أعيد الطلب مع الملاحظة'
            : decision === 'REJECT'
              ? 'سُجل الرفض النهائي؛ يبقى السجل محفوظاً'
              : decision === 'REFER'
                ? 'أُحيل الطلب للدراسة والقرار'
                : 'سُجلت الموافقة وانتقل مسار المراجعة',
      );
      onDone(next);
      app.bump();
    } catch (e) {
      const err = e as ApiError;
      if (err.code === 'RESERVATION_CONFLICT')
        setError(
          'تعذر تثبيت الحجز: ' + err.message + ' لم يُسجل القرار ولم يُنشأ أي حجز جزئي' +
            (pki ? '، ولم يُنشر التوقيع (سُجل كتوقيع غير منشور)' : '') +
            '. يمكن إرجاع الطلب لتعديل الفترة.',
        );
      else if (err.code === 'REAUTHENTICATION_REQUIRED') setReauth(true);
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
          <span>الملاحظة {decision === 'APPROVE' || decision === 'REFER' ? '— اختيارية' : '— مطلوبة'}</span>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="اكتب سبب القرار أو الملاحظة…" />
        </label>
        {needsSignature && (
          <>
            {doc && (
              <div className="wizard-summary" style={{ marginBottom: 14 }}>
                {doc.lines.map((l) => (
                  <div key={l.label} className="key-value">
                    <span>{l.label}</span>
                    <b style={{ maxWidth: '70%', overflowWrap: 'anywhere' }}>{l.value}</b>
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
              <div className="pki-sign">
                {!job ? (
                  <>
                    <p className="micro muted">
                      يوقّع المستند أعلاه بشهادتك لدى مزود التوقيع، ثم يُختم بختم جهتك، ويُتحقق من الاثنين (سلسلة الثقة، الصلاحية، الإلغاء) قبل
                      الاعتماد. لا يُسجل قرار ولا حجز في هذه الخطوة.
                    </p>
                    <button className="button" disabled={busy || !doc} onClick={sign}>
                      {busy ? 'جارٍ التوقيع والتحقق…' : 'التوقيع بشهادتي وختم الجهة'}
                    </button>
                  </>
                ) : (
                  <ul className="test-list signature-checks">
                    {job.signatures.map((s) => (
                      <li key={s.kind} className={s.indication === 'TOTAL_PASSED' ? '' : 'bad'}>
                        <b>{s.kind === 'PERSON' ? 'توقيع المعتمد' : 'ختم الجهة'}</b> — {s.subject}
                        <div className="micro muted">
                          {s.indication === 'TOTAL_PASSED' ? 'تحقق ناجح' : s.indication + (s.subIndication ? ' / ' + s.subIndication : '')} · صادرة من {s.issuer}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : (
              <>
                {reauth && app.me.signInMethod === 'DIRECTORY' && (
                  <div className="note orange" role="alert" style={{ marginBottom: 10 }}>
                    يتطلب الاعتماد تأكيد هويتك بكلمة المرور في الدليل المؤسسي. لم يُسجل أي قرار.
                    <div className="flex" style={{ marginTop: 8, gap: 8 }}>
                      <input type="password" autoComplete="current-password" aria-label="كلمة المرور" value={reauthPassword} onChange={(e) => setReauthPassword(e.target.value)} />
                      <button
                        className="button compact"
                        disabled={!reauthPassword || busy}
                        onClick={async () => {
                          try {
                            await api.directoryReauth(reauthPassword);
                            setReauthPassword('');
                            setReauth(false);
                            await apply();
                          } catch (e) {
                            setReauthPassword('');
                            setError((e as Error).message);
                          }
                        }}
                      >
                        تأكيد الهوية والاعتماد
                      </button>
                    </div>
                  </div>
                )}
                {reauth && app.me.signInMethod !== 'DIRECTORY' && (
                  <div className="note orange" role="alert" style={{ marginBottom: 10 }}>
                    يتطلب الاعتماد تحققاً حديثاً من هويتك لدى خدمة الدخول المؤسسية. لم يُسجل أي قرار.
                    <div style={{ marginTop: 8 }}>
                      <button
                        className="button compact"
                        onClick={async () => {
                          try {
                            window.location.assign((await api.reauth('/' + window.location.hash)).redirect);
                          } catch (e) {
                            setError((e as Error).message);
                          }
                        }}
                      >
                        إعادة التحقق من الهوية
                      </button>
                    </div>
                  </div>
                )}
                <label className="check-label">
                  <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                  أؤكد اعتماد المراجعة {doc?.revision ?? r.revision} كما هي معروضة
                </label>
              </>
            )}
            <div className="signature-preview">
              <span className="eyebrow">SIGNATURE / {pki ? 'JAdES — CERTIFICATE + SEAL' : 'INTERNAL ATTESTATION'}</span>
              <span className="signature-name">{app.me.displayName}</span>
              <br />
              <small>
                {pki
                  ? job?.status === 'SIGNED'
                    ? 'موقّع ومختوم ومتحقق منه؛ يُنشر مع القرار فقط إذا ثبت الحجز.'
                    : 'توقيع رقمي بشهادة المعتمد وختم الجهة.'
                  : SIGNATURE_DISCLAIMER + '. يرتبط بالبصمة والمراجعة ووقت الخادم.'}
              </small>
            </div>
          </>
        )}
        <div className="error-text" role="alert">
          {error}
        </div>
      </div>
      <div className="dialog-actions">
        <button className="button primary" disabled={busy || (needsSignature && pki && job?.status !== 'SIGNED')} onClick={apply}>
          {busy ? 'جارٍ التسجيل…' : needsSignature && pki ? 'نشر التوقيع والاعتماد' : 'تأكيد القرار'}
        </button>
        <button className="button" onClick={onClose}>
          إلغاء
        </button>
      </div>
    </Dialog>
  );
}
