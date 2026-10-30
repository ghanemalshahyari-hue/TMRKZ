import { useState } from 'react';
import { api, newIdempotencyKey, urls } from '../api/client';
import type { ApprovalVerification, DecisionKind, ExecutionTask, MyTask, RequestDetail, StageView } from '../api/types';
import { useApp } from '../lib/app';
import { fullDate, fullTime } from '../lib/dates';
import { RESERVATION_STATUS, SIGNATURE_DISCLAIMER, TASK_STATE } from '../lib/labels';
import { ClosureForm, CommunicationLog, RecordSummary, RevisionChangesBlock } from './RequestRecord';
import { StatusPill } from './ui';

function stageModeLabel(s: StageView): string {
  if (s.mode === 'ANY') return 'تكفي موافقة واحدة';
  return s.tasks.length > 1 ? 'مراجعات متوازية — يلزم الجميع' : 'مراجعة متسلسلة';
}

function Timeline({ stages }: { stages: StageView[] }) {
  if (!stages.length) return <p className="micro muted">تظهر مراحل المراجعة بعد تقديم الطلب.</p>;
  return (
    <div className="timeline">
      {stages.map((s, i) => {
        const complete = s.state === 'COMPLETE' || s.state === 'CARRIED';
        const active = s.state === 'ACTIVE';
        return (
          <div key={s.key} className={'timeline-item ' + (complete ? 'complete' : active ? 'active' : '')}>
            <i>{complete ? '✓' : s.state === 'SKIPPED' ? '—' : i + 1}</i>
            <div>
              <b>{s.name}</b>
              <br />
              <small>
                {stageModeLabel(s)} · {s.slaDays} يوم
                {s.state === 'SKIPPED' ? ' · لم تنطبق شروط المرحلة' : s.state === 'CARRIED' ? ' · موافقة سابقة محفوظة وفق سياسة التعديل' : ''}
              </small>
              <div className="task-chips">
                {s.tasks.map((t) => {
                  const done = t.state === 'APPROVED';
                  return (
                    <span key={t.id ?? s.key + t.roleName} className={'task-chip ' + (done ? 'done' : '')} title={t.decidedBy ? t.decidedBy + ' · ' + fullTime(t.decidedAt) : TASK_STATE[t.state]}>
                      {t.roleName}
                      {t.orgName ? ' · ' + t.orgName : ''}
                      {done ? ' ✓' : t.state !== 'OPEN' && TASK_STATE[t.state] ? ' · ' + TASK_STATE[t.state] : ''}
                    </span>
                  );
                })}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ExecutionList({ request, tasks, onChanged }: { request: RequestDetail; tasks: ExecutionTask[]; onChanged: (r?: RequestDetail) => void }) {
  const { toast } = useApp();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  if (!tasks.length) return null;
  const complete = async (t: ExecutionTask) => {
    const note = (notes[t.id] ?? '').trim();
    if (t.evidenceRequired && note.length < 5) return toast('اكتب دليل التنفيذ أو الاستلام (5 أحرف على الأقل).');
    setBusy(t.id);
    try {
      await api.completeExecution(t.id, note, newIdempotencyKey());
      toast('سُجل إكمال المهمة: ' + t.name);
      onChanged(await api.request(request.id));
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <section style={{ marginTop: 18 }}>
      <h3>مهام التنفيذ والاستلام</h3>
      <div className="timeline">
        {tasks.map((t) => (
          <div key={t.id} className={'timeline-item ' + (t.status === 'DONE' ? 'complete' : 'active')}>
            <i>{t.status === 'DONE' ? '✓' : '•'}</i>
            <div style={{ flex: 1 }}>
              <b>{t.name}</b>
              <br />
              <small>
                {t.roleName}
                {t.orgName ? ' · ' + t.orgName : ''} · المهلة {fullTime(t.dueAt)}
                {t.overdue && t.status === 'OPEN' ? ' · متأخرة' : ''}
                {t.evidenceRequired ? ' · يتطلب دليلاً' : ''}
              </small>
              {t.status === 'DONE' ? (
                <div className="micro muted">
                  {t.completedBy} · {fullTime(t.completedAt)}
                  {t.note ? ' — ' + t.note : ''}
                </div>
              ) : (
                t.canComplete && (
                  <div className="exec-complete">
                    <input
                      placeholder={t.evidenceRequired ? 'دليل التسليم أو الاستلام…' : 'ملاحظة اختيارية…'}
                      value={notes[t.id] ?? ''}
                      onChange={(e) => setNotes({ ...notes, [t.id]: e.target.value })}
                      aria-label={'ملاحظة ' + t.name}
                    />
                    <button className="button compact primary" disabled={busy === t.id} onClick={() => complete(t)}>
                      إكمال
                    </button>
                  </div>
                )
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function RequestDocument({
  request: r,
  actions = true,
  onDecision,
  onChanged,
}: {
  request: RequestDetail;
  actions?: boolean;
  onDecision?: (task: MyTask, decision: DecisionKind) => void;
  onChanged?: (r?: RequestDetail) => void;
}) {
  const app = useApp();
  const summary = r.view === 'SUMMARY';
  const reason = (r.values?.reason as string | undefined) ?? '';
  const sig = r.approvalDocument;
  const [verification, setVerification] = useState<ApprovalVerification | null>(null);
  const [verifying, setVerifying] = useState(false);

  const verify = async () => {
    setVerifying(true);
    try {
      setVerification(await api.verifyApprovalDocument(r.id));
    } catch (e) {
      app.toast((e as Error).message);
    } finally {
      setVerifying(false);
    }
  };

  return (
    <>
      <div className="document-header">
        <div>
          <span className="latin">{r.number}</span>
          <h2>{r.type.name}</h2>
          <p className="muted micro">{summary || !r.ownerOrg ? 'جهة مقيدة' : r.ownerOrg.name}</p>
        </div>
        <div className="stack" style={{ alignItems: 'end', gap: 8 }}>
          <StatusPill status={r.status} />
          <span className="micro muted">
            مراجعة {r.revision} · تدفق {r.workflowVersion?.version ?? '—'} · نموذج {r.formVersion.version}
          </span>
        </div>
      </div>
      <RecordSummary r={r} />
      <RevisionChangesBlock r={r} />
      <div className="meta-grid">
        <div>
          <dt>المرافق</dt>
          <dd>{r.resources.map((x) => x.name).join('، ') || '—'}</dd>
        </div>
        <div>
          <dt>الفترة</dt>
          <dd>
            {fullTime(r.period.start)}
            <br />
            {fullTime(r.period.end)}
          </dd>
        </div>
        <div>
          <dt>الجهات المشاركة</dt>
          <dd>{summary ? 'مقيدة' : [r.ownerOrg, ...(r.participantOrgs ?? [])].filter(Boolean).map((o) => o!.name).join('، ') || '—'}</dd>
        </div>
        <div>
          <dt>المرفقات</dt>
          <dd>
            {summary || !r.attachments ? (
              'مقيدة'
            ) : r.attachments.length ? (
              <span className="attachment-links">
                {r.attachments.map((f) =>
                  f.scanStatus === 'CLEAN' ? (
                    <a key={f.id} href={urls.attachment(f.id)} className="text-link">
                      {f.fileName}
                    </a>
                  ) : (
                    <span key={f.id} className="muted" title={f.scanDetail ?? ''}>
                      {f.fileName} ({f.scanStatus === 'PENDING' ? 'قيد الفحص' : 'مرفوض'})
                    </span>
                  ),
                )}
              </span>
            ) : (
              'دون مرفقات'
            )}
          </dd>
        </div>
      </div>
      {r.targetReservation && (
        <div className="note" style={{ marginBottom: 12 }}>
          الحجز المرتبط: {r.targetReservation.resourceName} · {fullDate(r.targetReservation.period.start)} ← {fullDate(r.targetReservation.period.end)} ·{' '}
          {RESERVATION_STATUS[r.targetReservation.status]?.[0] ?? r.targetReservation.status}
        </div>
      )}
      <div className="reason">{summary ? r.subject : reason || r.subject || 'مسودة غير مكتملة'}</div>
      {r.lastNote && !summary && (
        <div className="note orange">
          <b>آخر ملاحظة:</b> {r.lastNote}
        </div>
      )}
      <div className="document-grid">
        <section>
          <h3>المراجعات المطلوبة</h3>
          <Timeline stages={r.stages} />
        </section>
        <section>
          <h3>سجل الطلب</h3>
          <div className="timeline">
            {r.history.map((h, i) => (
              <div key={i} className="timeline-item complete">
                <i>✓</i>
                <div>
                  <b>{h.event}</b>
                  <br />
                  <small>
                    {h.actor} · {fullTime(h.at)}
                  </small>
                  {h.note && !summary && <div className="micro muted">{h.note}</div>}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
      {sig && (
        <div className="document-signoff">
          <span className="eyebrow">APPROVAL / {sig.signatureMode === 'PKI' ? 'PKI SIGNATURE' : 'INTERNAL ATTESTATION'}</span>
          <strong>{sig.signerName}</strong>
          <small>
            {sig.signerRole} · {fullTime(sig.signedAt)} · مراجعة {sig.revision}
            <br />
            {sig.signatureMode === 'PKI' ? sig.signatureLabel : SIGNATURE_DISCLAIMER}
            <br />
            <span className="latin tiny">SHA-256 {sig.sha256.slice(0, 24)}…</span>
            {sig.signatures && sig.signatures.length > 0 && (
              <>
                {sig.signatures.map((s) => (
                  <span key={s.kind} className="document-signature">
                    <br />
                    {s.kind === 'PERSON' ? 'توقيع المعتمد' : 'ختم الجهة'}: {s.subject} — صادرة من {s.issuer} ·{' '}
                    {s.indication === 'TOTAL_PASSED' ? 'تحقق ناجح عند التوقيع' : s.indication}
                  </span>
                ))}
                <br />
                <button className="button compact" disabled={verifying} onClick={verify} style={{ marginTop: 6 }}>
                  {verifying ? 'جارٍ التحقق…' : 'تحقق من التوقيع والختم الآن'}
                </button>
                {verification && (
                  <span className={'document-verification ' + (verification.passed ? 'good' : 'bad')} role="status">
                    <br />
                    {verification.passed ? '✓ التوقيع والختم صالحان الآن' : '✗ التحقق لم ينجح'}
                    {verification.signatures
                      ?.filter((x) => !x.passed)
                      .map((x) => ' · ' + (x.reason ?? x.indication))
                      .join('')}
                  </span>
                )}
              </>
            )}
            {sig.boundaryVersions && sig.boundaryVersions.length > 0 && (
              <>
                <br />
                <span className="document-boundaries">
                  نسخ الحدود في المستند:{' '}
                  {sig.boundaryVersions
                    .map((b) => b.siteCode + ' — ' + (b.type === 'Polygon' || b.type === 'MultiPolygon' ? 'الإصدار ' + b.version : 'غير مسجلة'))
                    .join('، ')}
                </span>
              </>
            )}
          </small>
        </div>
      )}
      {r.reservations.length > 0 && (
        <div className="note" style={{ marginTop: 12 }}>
          الحجوزات الناتجة:{' '}
          {r.reservations.map((x) => x.resourceName + ' (' + fullDate(x.period.start) + ' ← ' + fullDate(x.period.end) + ' · ' + (RESERVATION_STATUS[x.status]?.[0] ?? x.status) + ')').join('، ')}
        </div>
      )}
      {(r.status === 'APPROVED' || r.status === 'CLOSED') && !summary && (
        <div className="note" style={{ marginTop: 12 }}>
          جهات للعلم: {r.infoOrgs?.length ? r.infoOrgs.map((o) => o.name).join('، ') : 'لم تحدد جهات'}
        </div>
      )}
      {!summary && <ExecutionList request={r} tasks={r.executionTasks} onChanged={(x) => (onChanged?.(x), app.bump())} />}
      {!summary && <CommunicationLog r={r} canRecord={app.can('REVIEW') || app.can('APPROVE') || app.can('CLOSE')} />}
      {actions && (
        <div className="review-actions">
          {r.status === 'APPROVED' ? (
            <ClosureForm r={r} onClosed={(x) => onChanged?.(x)} />
          ) : r.status !== 'SUBMITTED' ? (
            <>
              <span className="micro muted">لا توجد مهمة مراجعة مفتوحة لهذا الطلب.</span>
              {(r.status === 'RETURNED' || r.status === 'DRAFT') && r.actions.canEditDraft && (
                <button className="button primary" onClick={() => app.openWizard({ origin: r.origin, requestId: r.id })}>
                  تعديل وإعادة تقديم
                </button>
              )}
            </>
          ) : (
            <>
              {r.actions.myTasks.map((t) => (
                <button key={t.taskId} className="button primary" onClick={() => onDecision?.(t, t.final ? 'APPROVE' : 'REFER')}>
                  {t.final ? (t.requiresSignature ? 'اعتماد وتوقيع' : 'اعتماد') : 'إحالة للدراسة'} — {t.stageName}
                </button>
              ))}
              {!r.actions.myTasks.length && <span className="micro muted">لا توجد مهمة مسندة إليك في المرحلة الحالية.</span>}
              <button className="button" disabled={!r.actions.myTasks.length} onClick={() => onDecision?.(r.actions.myTasks[0], 'RETURN')}>
                {r.actions.myTasks[0]?.final ? 'طلب تصحيح' : 'إرجاع للتصحيح'}
              </button>
              <button className="button danger" disabled={!r.actions.myTasks.length} onClick={() => onDecision?.(r.actions.myTasks[0], 'REJECT')}>
                رفض نهائي
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
}
