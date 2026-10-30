import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, newIdempotencyKey } from '../api/client';
import type { Communication, CommunicationChannel, Relocation, RequestDetail, RevisionComparison } from '../api/types';
import { useApp } from '../lib/app';
import { fullTime } from '../lib/dates';
import { OrgSymbol } from './UnitSymbol';

/**
 * Administrative state of a request in plain words, keeping apart what the status alone does not say: a request
 * under review is either at its first (completeness) stage or referred onward for study; an approved request waits
 * for its administrative completion until someone with the closing right closes it.
 */
export function adminPhase(r: RequestDetail): { label: string; tone: string } {
  switch (r.status) {
    case 'DRAFT':
      return { label: 'مسودة لم تُرسل', tone: '' };
    case 'RETURNED':
      return { label: 'معاد للتصحيح', tone: 'orange' };
    case 'REJECTED':
      return { label: 'مرفوض نهائياً', tone: 'red' };
    case 'APPROVED':
      return { label: 'معتمد — بانتظار الإنجاز الإداري', tone: 'green' };
    case 'CLOSED':
      return { label: 'مغلق بعد الإنجاز الإداري', tone: 'blue' };
    default: {
      const passed = r.stages.some((s) => s.state === 'COMPLETE' || s.state === 'CARRIED');
      return { label: passed ? 'محال للدراسة والقرار' : 'قيد مراجعة الاكتمال', tone: 'orange' };
    }
  }
}

/** The request record at a glance: what, for whom, where it stands, who holds it, what happened last and what is next. */
export function RecordSummary({ r }: { r: RequestDetail }) {
  const summary = r.view === 'SUMMARY';
  const phase = adminPhase(r);
  const active = r.stages.find((s) => s.state === 'ACTIVE');
  const holders = active ? [...new Set(active.tasks.filter((t) => t.state === 'OPEN' || t.state === 'PENDING').map((t) => t.roleName + (t.orgName ? ' — ' + t.orgName : '')))] : [];
  const last = r.history.length ? r.history[r.history.length - 1] : null;
  const next =
    r.status === 'SUBMITTED'
      ? r.actions.myTasks.length
        ? 'قرارك مطلوب في «' + r.actions.myTasks[0].stageName + '»'
        : 'بانتظار ' + (holders.join('، ') || 'المرحلة التالية')
      : r.status === 'RETURNED'
        ? r.actions.canEditDraft
          ? 'صحّح الطلب وأعد تقديمه'
          : 'بانتظار تصحيح مقدم الطلب'
        : r.status === 'APPROVED'
          ? r.executionTasks.some((e) => e.status === 'OPEN')
            ? 'إكمال مهام التسليم والاستلام'
            : r.actions.canClose
              ? 'سجّل الإنجاز الإداري وأغلق الطلب'
              : 'بانتظار الإنجاز الإداري من الجهة المختصة'
          : r.status === 'DRAFT'
            ? 'استكمال المسودة وإرسالها'
            : 'لا إجراء متبقٍ؛ السجل محفوظ';
  const rows: [string, ReactNode][] = [
    ['المرجع', r.number],
    [
      'الجهة الطالبة',
      summary || !r.ownerOrg ? (
        'مقيدة'
      ) : (
        <span className="with-symbol">
          <OrgSymbol orgId={r.ownerOrg.id} size={18} />
          {r.ownerOrg.name}
        </span>
      ),
    ],
    ['المرفق / المورد', r.resources.map((x) => x.name).join('، ') || '—'],
    ['نوع الطلب', r.type.name],
    ['الحالة', phase.label],
    ['المرحلة الحالية', active ? active.name : r.status === 'SUBMITTED' ? '—' : 'لا مرحلة مفتوحة'],
    ['المسؤول الآن', holders.join('، ') || '—'],
    ['آخر إجراء', last ? last.event + ' · ' + last.actor + ' · ' + fullTime(last.at) : '—'],
    ['الإجراء التالي', next],
  ];
  return (
    <section className="record-summary" aria-label="ملخص سجل الطلب">
      {rows.map(([k, v]) => (
        <div key={k} className={k === 'الحالة' ? 'state ' + phase.tone : ''}>
          <span>{k}</span>
          <b>{v}</b>
        </div>
      ))}
    </section>
  );
}

const shown = (v: string | null) => (v == null ? '—' : /^\d{4}-\d{2}-\d{2}T/.test(v) ? fullTime(v) : v);

/** A relocation request's proposal: who moves, from where, to which drawn location (never the site register). */
export function RelocationBlock({ r }: { r: RequestDetail }) {
  const [rel, setRel] = useState<Relocation | null>(null);
  useEffect(() => {
    if (r.type.kind !== 'RELOCATION' || r.view !== 'FULL') return setRel(null);
    let live = true;
    api
      .relocation(r.id)
      .then((x) => live && setRel(x))
      .catch(() => live && setRel(null));
    return () => {
      live = false;
    };
  }, [r.id, r.type.kind, r.view, r.revision]);
  if (!rel) return null;
  return (
    <section className="relocation-block" aria-label="تفاصيل نقل المقر">
      <h3>نقل المقر</h3>
      <div className="record-summary">
        <div>
          <span>الجهة المنقولة</span>
          <b className="with-symbol">
            <OrgSymbol orgId={rel.organization.id} size={18} />
            {rel.organization.name}
            {rel.includeDescendants ? ' — مع فروعها' : ''}
          </b>
        </div>
        <div>
          <span>من الموقع</span>
          <b>{rel.fromSite.name}</b>
        </div>
        <div>
          <span>إلى الموقع المقترح</span>
          <b>{rel.proposedName}</b>
        </div>
        <div>
          <span>المساحة التقريبية</span>
          <b>{rel.areaM2 ? Math.round(rel.areaM2).toLocaleString('ar-AE') + ' م²' : 'نقطة'}</b>
        </div>
        <div>
          <span>الإحداثيات (المركز)</span>
          <b className="latin">
            {rel.centroid[0].toFixed(5)}, {rel.centroid[1].toFixed(5)}
          </b>
        </div>
        <div>
          <span>التنفيذ</span>
          <b>{rel.completedAt ? 'سُجّل تنفيذ النقل ' + fullTime(rel.completedAt) : 'لم يُسجَّل بعد'}</b>
        </div>
      </div>
      <p className="micro muted">الموقع المقترح جزء من الطلب ولا يغيّر سجل المواقع؛ يسجله مسؤول المرافق بعد القرار إن لزم.</p>
    </section>
  );
}

/** For the reviewer of a resubmission: each changed field with its previous and new value. */
export function RevisionChangesBlock({ r }: { r: RequestDetail }) {
  const [cmp, setCmp] = useState<RevisionComparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (r.revision < 2 || r.view !== 'FULL' || r.status === 'DRAFT') return setCmp(null);
    let live = true;
    api
      .changes(r.id, r.revision)
      .then((c) => live && (setCmp(c), setError(null)))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [r.id, r.revision, r.view, r.status]);
  if (error) return <p className="micro note red">تعذر عرض التغييرات: {error}</p>;
  if (!cmp || cmp.toRevision < 2) return null;
  return (
    <section className="revision-changes" aria-label="التغييرات منذ التقديم السابق">
      <h3>
        ما الذي تغيّر بين المراجعة {cmp.fromRevision} والمراجعة {cmp.toRevision}
      </h3>
      {cmp.reason && <p className="micro">سبب التعديل من مقدم الطلب: {cmp.reason}</p>}
      {cmp.changes.length === 0 ? (
        <p className="micro muted">لم يتغير أي حقل؛ أعيد التقديم كما هو.</p>
      ) : (
        <table className="data-table compact">
          <thead>
            <tr>
              <th>الحقل</th>
              <th>قبل</th>
              <th>بعد</th>
            </tr>
          </thead>
          <tbody>
            {cmp.changes.map((c) => (
              <tr key={c.field}>
                <td>{c.label}</td>
                <td className="before">{shown(c.before)}</td>
                <td className="after">{shown(c.after)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

const CHANNELS: [CommunicationChannel, string][] = [
  ['OFFICIAL_LETTER', 'خطاب رسمي'],
  ['INTERNAL_MAIL', 'بريد داخلي'],
  ['IN_APP', 'داخل النظام'],
  ['HAND_DELIVERY', 'تسليم باليد'],
  ['OTHER', 'قناة أخرى'],
];
const OUTCOME: Record<Communication['outcome'], string> = { APPROVED: 'الاعتماد', REJECTED: 'الرفض النهائي', RETURNED: 'الإرجاع للتصحيح', CLOSED: 'الإغلاق' };

/**
 * Who communicated a decision, to whom, when and which document version. Information recipients of the request are a
 * separate list and get no task; this log records the act of communicating.
 */
export function CommunicationLog({ r, canRecord }: { r: RequestDetail; canRecord: boolean }) {
  const app = useApp();
  const [items, setItems] = useState<Communication[] | null>(null);
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<'ORGANIZATION' | 'OTHER'>('ORGANIZATION');
  const [orgId, setOrgId] = useState(r.ownerOrg?.id ?? '');
  const [text, setText] = useState('');
  const [channel, setChannel] = useState<CommunicationChannel>('OFFICIAL_LETTER');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const key = useRef(newIdempotencyKey());
  const decided = ['APPROVED', 'REJECTED', 'RETURNED', 'CLOSED'].includes(r.status);

  useEffect(() => {
    if (r.view !== 'FULL' || !decided) return setItems(null);
    api
      .communications(r.id)
      .then(setItems)
      .catch(() => setItems(null));
  }, [r.id, r.view, r.status, decided]);

  if (r.view !== 'FULL' || !decided) return null;
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      setItems(
        await api.communicate(
          r.id,
          {
            recipientKind: kind,
            recipientOrgId: kind === 'ORGANIZATION' ? orgId : undefined,
            recipientText: kind === 'OTHER' ? text : undefined,
            channel,
            reference: reference || undefined,
            note: note || undefined,
          },
          key.current,
        ),
      );
      key.current = newIdempotencyKey();
      setOpen(false);
      setReference('');
      setNote('');
      app.toast('سُجّل إبلاغ القرار');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="communication-log" aria-label="إبلاغ القرار">
      <div className="flex spread">
        <h3>إبلاغ القرار</h3>
        {canRecord && !open && (
          <button className="button compact" onClick={() => setOpen(true)}>
            تسجيل إبلاغ
          </button>
        )}
      </div>
      {items && items.length === 0 && <p className="micro muted">لم يُسجَّل إبلاغ بعد. جهات «للعلم» قائمة منفصلة ولا تُعد إبلاغاً مسجلاً.</p>}
      <ul>
        {items?.map((c) => (
          <li key={c.id}>
            <b>
              أُبلغ {OUTCOME[c.outcome]} إلى {c.recipientOrg?.name ?? c.recipientPerson?.name ?? c.recipientText}
            </b>
            <small>
              {CHANNELS.find(([k]) => k === c.channel)?.[1]} · {fullTime(c.communicatedAt)}
              {c.reference ? ' · مرجع ' + c.reference : ''} · سجّله {c.recordedBy}
              {c.documentRevision ? ' · المستند المعتمد مراجعة ' + c.documentRevision + ' (SHA-256 ' + c.documentSha256?.slice(0, 12) + '…)' : ''}
            </small>
            {c.note && <small>{c.note}</small>}
          </li>
        ))}
      </ul>
      {open && (
        <div className="communication-form">
          <div className="segmented" role="radiogroup" aria-label="المبلَّغ">
            <button role="radio" aria-checked={kind === 'ORGANIZATION'} className={kind === 'ORGANIZATION' ? 'active' : ''} onClick={() => setKind('ORGANIZATION')}>
              جهة
            </button>
            <button role="radio" aria-checked={kind === 'OTHER'} className={kind === 'OTHER' ? 'active' : ''} onClick={() => setKind('OTHER')}>
              جهة أو شخص آخر
            </button>
          </div>
          {kind === 'ORGANIZATION' ? (
            <label className="field">
              <span>الجهة المبلَّغة</span>
              <select value={orgId} onChange={(e) => setOrgId(e.target.value)}>
                {[r.ownerOrg, ...(r.participantOrgs ?? []), ...(r.infoOrgs ?? [])]
                  .filter((o, i, a) => o && a.findIndex((x) => x?.id === o.id) === i)
                  .map((o) => (
                    <option key={o!.id} value={o!.id}>
                      {o!.name}
                    </option>
                  ))}
              </select>
            </label>
          ) : (
            <label className="field">
              <span>اسم المبلَّغ</span>
              <input value={text} onChange={(e) => setText(e.target.value)} maxLength={200} />
            </label>
          )}
          <label className="field">
            <span>القناة</span>
            <select value={channel} onChange={(e) => setChannel(e.target.value as CommunicationChannel)}>
              {CHANNELS.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>مرجع المراسلة — اختياري</span>
            <input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120} />
          </label>
          <label className="field">
            <span>ملاحظة — اختيارية</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
          </label>
          <p className="micro muted">يُسجَّل المستند المعتمد ومراجعته تلقائياً عند إبلاغ الاعتماد. السجل لا يُعدَّل بعد حفظه.</p>
          <div className="error-text" role="alert">
            {error}
          </div>
          <div className="flex">
            <button className="button primary compact" disabled={busy} onClick={save}>
              حفظ الإبلاغ
            </button>
            <button className="button compact" disabled={busy} onClick={() => (setOpen(false), setError(''))}>
              إلغاء
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/** Administrative completion: a statement of what was done (required) and an optional evidence reference. */
export function ClosureForm({ r, onClosed }: { r: RequestDetail; onClosed: (next: RequestDetail) => void }) {
  const app = useApp();
  const [statement, setStatement] = useState('');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const key = useRef(newIdempotencyKey());
  const openExecution = r.executionTasks.some((e) => e.status === 'OPEN');
  if (!r.actions.canClose)
    return (
      <p className="micro muted">
        {openExecution
          ? 'يتاح الإنجاز الإداري والإغلاق بعد إكمال مهام التسليم والاستلام.'
          : 'الاعتماد لا يغلق الطلب. الإنجاز الإداري والإغلاق لمن يملك صلاحية الإغلاق على نطاق الطلب.'}
      </p>
    );
  const close = async () => {
    if (statement.trim().length < 10) return setError('اكتب بيان الإنجاز الإداري (10 أحرف على الأقل).');
    setBusy(true);
    setError('');
    try {
      const next = await api.closeRequest(r.id, { statement: statement.trim(), reference: reference.trim() || undefined }, key.current);
      app.toast('سُجّل الإنجاز الإداري وأُغلق الطلب؛ الحجز يحتفظ بفترته المعتمدة');
      onClosed(next);
      app.bump();
    } catch (e) {
      setError((e as Error).message);
      key.current = newIdempotencyKey();
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="closure-form" aria-label="الإنجاز الإداري والإغلاق">
      <h3>الإنجاز الإداري والإغلاق</h3>
      <label className="field">
        <span>بيان الإنجاز — مطلوب</span>
        <textarea value={statement} onChange={(e) => setStatement(e.target.value)} placeholder="ما الذي نُفّذ وسُلّم، ومتى" maxLength={2000} />
      </label>
      <label className="field">
        <span>مرجع الإثبات — اختياري (محضر، خطاب)</span>
        <input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120} />
      </label>
      <div className="error-text" role="alert">
        {error}
      </div>
      <button className="button primary" disabled={busy} onClick={close}>
        تسجيل الإنجاز وإغلاق الطلب
      </button>
      <span className="micro muted"> الإغلاق لا يغيّر نهاية الحجز تلقائياً.</span>
    </section>
  );
}
