import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api, newIdempotencyKey } from '../api/client';
import type {
  Attachment,
  AvailabilityCheck,
  DraftInput,
  FormField,
  FormSchema,
  RequestDetail,
  RequestStatus,
  RequestType,
  ReservationItem,
} from '../api/types';
import { facilitySites, useApp, type WizardRequest } from '../lib/app';
import { addDays, dubaiISO, formatBytes, fullDate, fullTime, localDay, localInput, todayDubai } from '../lib/dates';
import { KIND_ICON } from '../lib/labels';
import { evaluateRule, type RuleContext } from '../lib/rules';
import { Dialog, Icon } from './ui';

type Unit = 'DAYS' | 'HOURS';
type WizardState = {
  requestId: string | null;
  version: number | null;
  status: RequestStatus | null;
  revision: number;
  origin: 'MAP' | 'LIST';
  /** The site the request was started from (its resources are offered first); null from the list. */
  siteId: string | null;
  typeCode: string;
  ownerOrgId: string;
  participantOrgIds: string[];
  infoOrgIds: string[];
  resourceIds: string[];
  subject: string;
  unit: Unit;
  start: string;
  end: string;
  permanent: boolean;
  values: Record<string, unknown>;
  targetReservationId: string | null;
  attachments: Attachment[];
  pinnedForm: { id: string; version: number; schema: FormSchema } | null;
  resubmissionReason: string;
};

const STEPS = ['الجهة والنوع', 'المرافق والفترة', 'البيانات', 'المراجعة'];
const EMPTY_FORM: { version: number; schema: FormSchema } = { version: 0, schema: { fields: [] } };

function toInput(iso: string | null, unit: Unit): string {
  if (!iso) return '';
  return unit === 'HOURS' ? localInput(iso) : localDay(iso);
}

export function fieldVisible(f: FormField, ctx: RuleContext): boolean {
  return f.visible && evaluateRule(f.visibleWhen ?? null, ctx);
}
export function fieldRequired(f: FormField, ctx: RuleContext): boolean {
  return f.required || (!!f.requiredWhen && evaluateRule(f.requiredWhen, ctx));
}

export function RequestWizard({
  request,
  update,
  onUpdateHandled,
  onClose,
}: {
  request: WizardRequest | null;
  update?: (WizardRequest & { key: number }) | null;
  onUpdateHandled?: () => void;
  onClose: () => void;
}) {
  const app = useApp();
  const { requestTypes, sites, orgs, me, settings } = app;
  const [w, setW] = useState<WizardState | null>(null);
  const [step, setStep] = useState(1);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reservations, setReservations] = useState<ReservationItem[]>([]);
  const [check, setCheck] = useState<AvailabilityCheck | null>(null);
  const [uploading, setUploading] = useState(false);
  const submitKey = useRef(newIdempotencyKey());
  const [minimized, setMinimized] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState<WizardRequest | null>(null);
  const [showOthers, setShowOthers] = useState(false);

  const facilities = useMemo(() => facilitySites(sites), [sites]);
  const resourceOptions = useMemo(
    () =>
      facilities.flatMap((s) =>
        s.resources.map((r) => ({ resource: r, site: s, label: r.parentResourceId || s.resources.length > 1 ? r.label || s.name + ' — ' + r.name : s.name })),
      ),
    [facilities],
  );

  const creatableOrgs = useMemo(() => {
    const createGrants = me.grants.filter((g) => g.permissions.includes('CREATE'));
    if (createGrants.some((g) => g.scope === 'ALL' || g.scope === 'SITE')) return orgs;
    const roots = new Set(createGrants.map((g) => g.organization?.id).filter(Boolean) as string[]);
    const out: typeof orgs = [];
    let inside = -1;
    for (const o of orgs) {
      if (inside >= 0 && o.depth <= inside) inside = -1;
      if (roots.has(o.id) && inside < 0) inside = o.depth;
      if (inside >= 0) out.push(o);
    }
    return out.length ? out : orgs;
  }, [me.grants, orgs]);

  // initialise on open
  useEffect(() => {
    if (!request) {
      setW(null);
      return;
    }
    setStep(1);
    setError('');
    setCheck(null);
    setMinimized(false);
    setExpanded(false);
    setPending(null);
    setShowOthers(false);
    submitKey.current = newIdempotencyKey();
    const defaultOrg = (me.primaryOrg && creatableOrgs.find((o) => o.id === me.primaryOrg!.id)?.id) || creatableOrgs[0]?.id || '';
    if (request.requestId) {
      api
        .request(request.requestId)
        .then((d) => setW(fromDetail(d)))
        .catch((e: Error) => {
          app.toast(e.message);
          onClose();
        });
      return;
    }
    const site = request.siteId ? sites.find((s) => s.id === request.siteId) : undefined;
    const pf = request.prefill;
    // the type is the one the person chose (site menu or list); the wizard never picks one silently
    const typeCode = request.typeCode && requestTypes.some((t) => t.code === request.typeCode) ? request.typeCode : '';
    const unit: Unit = pf?.unit ?? settings?.defaultUnit ?? 'DAYS';
    const startDay = addDays(todayDubai(), 1);
    const prefOrg = pf?.ownerOrgId && creatableOrgs.some((o) => o.id === pf.ownerOrgId) ? pf.ownerOrgId : defaultOrg;
    setW({
      requestId: null,
      version: null,
      status: null,
      revision: 0,
      origin: request.origin,
      siteId: request.siteId ?? null,
      typeCode,
      ownerOrgId: prefOrg,
      participantOrgIds: [],
      infoOrgIds: [],
      // only an unambiguous resource is preselected; with several the person chooses in step 2
      resourceIds: pf?.resourceIds?.length ? pf.resourceIds : site && site.resources.length === 1 ? [site.resources[0].id] : [],
      subject: '',
      unit,
      start: pf?.start ?? (unit === 'HOURS' ? startDay + 'T09:00' : startDay),
      end: pf?.permanent ? '' : pf?.end ?? (unit === 'HOURS' ? addDays(startDay, 2) + 'T17:00' : addDays(startDay, 2)),
      permanent: !!pf?.permanent,
      values: {},
      targetReservationId: request.targetReservationId ?? null,
      attachments: [],
      pinnedForm: null,
      resubmissionReason: '',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  useEffect(() => {
    if (!update || !w) return;
    setPending(update);
    setMinimized(false);
    onUpdateHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [update?.key]);

  const type: RequestType | undefined = requestTypes.find((t) => t.code === w?.typeCode);

  useEffect(() => {
    if (type?.requiresTargetReservation && !reservations.length)
      api
        .reservations({ status: 'ACTIVE' })
        .then(setReservations)
        .catch(() => setReservations([]));
  }, [type?.requiresTargetReservation, reservations.length]);

  function fromDetail(d: RequestDetail): WizardState {
    const unit: Unit = d.unit;
    return {
      requestId: d.id,
      version: d.version,
      status: d.status,
      revision: d.revision,
      origin: d.origin,
      siteId: null,
      typeCode: d.type.code,
      ownerOrgId: d.ownerOrg?.id ?? '',
      participantOrgIds: (d.participantOrgs ?? []).map((o) => o.id),
      infoOrgIds: (d.infoOrgs ?? []).map((o) => o.id),
      resourceIds: d.resources.map((r) => r.id),
      subject: d.subject ?? '',
      unit,
      start: toInput(d.period.start, unit),
      end: toInput(d.period.end, unit),
      permanent: d.period.end === null && d.type.kind === 'NEW_RESERVATION',
      values: { ...(d.values ?? {}) },
      targetReservationId: d.targetReservation?.id ?? null,
      attachments: d.attachments ?? [],
      pinnedForm: d.formVersion.schema ? { id: d.formVersion.id, version: d.formVersion.version, schema: d.formVersion.schema } : null,
      resubmissionReason: '',
    };
  }

  const set = (patch: Partial<WizardState>) => setW((cur) => (cur ? { ...cur, ...patch } : cur));
  const orgName = (id: string) => orgs.find((o) => o.id === id)?.name ?? '—';
  const form: { version: number; schema: FormSchema } = w?.pinnedForm ?? type?.formVersion ?? EMPTY_FORM;

  // autofill (reference values; the server re-reads authoritative sources)
  useAutofill(w, form.schema, set, me.displayName, orgName(w?.ownerOrgId ?? ''));

  if (!request || !w) return <Dialog open={false} onClose={onClose} className="large-dialog">{null}</Dialog>;

  const kind = type?.kind ?? 'NEW_RESERVATION';
  const multiSites = (type?.multiSites ?? true) && (settings?.multiSites ?? true);
  const multiOrgs = (type?.multiOrgs ?? true) && (settings?.multiOrgs ?? true);
  const target = reservations.find((r) => r.id === w.targetReservationId);
  const resourceLabel = (id: string) => resourceOptions.find((o) => o.resource.id === id)?.label ?? id;
  const focusSite = w.siteId ? facilities.find((s) => s.id === w.siteId) : undefined;
  const focusOptions = focusSite ? resourceOptions.filter((o) => o.site.id === focusSite.id) : [];
  const otherOptions = focusSite ? resourceOptions.filter((o) => o.site.id !== focusSite.id) : resourceOptions;
  const othersOpen = !focusSite || showOthers || w.resourceIds.some((id) => otherOptions.some((o) => o.resource.id === id));
  const periodText = w.start
    ? w.start.replace('T', ' ') + ' ← ' + (w.permanent ? 'مفتوحة المدة' : w.end ? w.end.replace('T', ' ') + ' (غير مشمولة)' : '—')
    : '—';

  const startISO = w.start ? dubaiISO(w.start) : null;
  const endISO = w.permanent || !w.end ? null : dubaiISO(w.end);
  const durationMs = startISO && endISO ? new Date(endISO).getTime() - new Date(startISO).getTime() : 0;
  const ruleCtx: RuleContext = {
    values: w.values,
    facts: {
      resourceCount: w.resourceIds.length,
      durationDays: durationMs / 86400000,
      durationHours: durationMs / 3600000,
      participantCount: w.participantOrgIds.length,
      requestType: w.typeCode,
    },
  };
  const visibleFields = form.schema.fields.filter((f) => fieldVisible(f, ruleCtx));

  const periodLabels =
    kind === 'EXTENSION'
      ? ['بداية الحجز الحالي', 'النهاية الجديدة — غير مشمولة']
      : kind === 'CANCELLATION'
        ? ['تاريخ سريان الإلغاء', 'غير مستخدم في الإلغاء']
        : kind === 'EVACUATION'
          ? ['تاريخ التسليم المخطط', 'غير مستخدم في الإخلاء']
          : ['بداية الاستخدام', 'نهاية الاستخدام — غير مشمولة'];
  const needsEnd = kind === 'NEW_RESERVATION' ? !w.permanent : kind === 'EXTENSION' || kind === 'MODIFICATION';

  function validate(upTo: number): string {
    if (upTo >= 1) {
      if (!w!.ownerOrgId) return 'اختر الجهة الطالبة.';
      if (!type) return 'اختر نوع الطلب.';
      if (type?.requiresTargetReservation && !w!.targetReservationId) return 'اختر الحجز المعتمد المرتبط بالطلب.';
    }
    if (upTo >= 2) {
      if (!w!.resourceIds.length) return focusSite ? 'اختر المورد المطلوب من موارد «' + focusSite.name + '».' : 'اختر مرفقاً واحداً على الأقل.';
      if (!multiSites && w!.resourceIds.length > 1) return 'الإعداد الحالي يسمح بمرفق واحد فقط.';
      if (!w!.start || (needsEnd && !w!.end)) return 'حدد بداية الفترة ونهايتها.';
      if (needsEnd && endISO && startISO && new Date(endISO) <= new Date(startISO)) return 'نهاية الفترة يجب أن تكون بعد بدايتها.';
      if (target) {
        if (w!.resourceIds.length !== 1 || w!.resourceIds[0] !== target.resource.id) return 'حدد المرفق نفسه الموجود في الحجز المرتبط.';
        if (kind === 'EXTENSION' && endISO && target.period.end && new Date(endISO) <= new Date(target.period.end))
          return 'التمديد يحتاج نهاية بعد نهاية الحجز الأصلي.';
      }
    }
    if (upTo >= 3) {
      for (const f of visibleFields) {
        const v = w!.values[f.id];
        const required = fieldRequired(f, ruleCtx);
        if (f.kind === 'files') {
          const n = w!.attachments.filter((a) => a.fieldId === f.id && a.scanStatus !== 'REJECTED').length;
          if (required && !n) return 'الحقل «' + f.label + '» مطلوب.';
          continue;
        }
        const empty = v === undefined || v === null || String(v).trim() === '';
        if (required && empty) return 'الحقل «' + f.label + '» مطلوب.';
        if (empty) continue;
        if (f.kind === 'number') {
          const n = Number(v);
          if (!Number.isFinite(n) || n <= 0) return 'أدخل قيمة موجبة لحقل «' + f.label + '».';
          if (f.min != null && n < f.min) return 'قيمة «' + f.label + '» أقل من الحد الأدنى ' + f.min + '.';
          if (f.max != null && n > f.max) return 'قيمة «' + f.label + '» أكبر من الحد الأعلى ' + f.max + '.';
        }
        const len = String(v).trim().length;
        if (f.minLength != null && len < f.minLength) return 'الحقل «' + f.label + '» يحتاج ' + f.minLength + ' أحرف على الأقل.';
        if (f.maxLength != null && len > f.maxLength) return 'الحقل «' + f.label + '» يتجاوز ' + f.maxLength + ' حرفاً.';
      }
      const reasonField = visibleFields.find((f) => f.id === 'reason');
      if (reasonField && fieldRequired(reasonField, ruleCtx) && String(w!.values.reason ?? '').trim().length < 10) return 'اكتب مبرراً لا يقل عن 10 أحرف.';
    }
    if (upTo >= 4 && w!.status === 'RETURNED' && w!.resubmissionReason.trim().length < 5) return 'اكتب سبب التعديل قبل إعادة التقديم (5 أحرف على الأقل).';
    return '';
  }

  function draftInput(): DraftInput {
    const fileFields = new Set(form.schema.fields.filter((f) => f.kind === 'files').map((f) => f.id));
    const values: Record<string, unknown> = {};
    Object.entries(w!.values).forEach(([k, v]) => {
      if (!fileFields.has(k)) values[k] = v;
    });
    return {
      origin: w!.origin,
      ownerOrgId: w!.ownerOrgId || undefined,
      resourceIds: w!.resourceIds,
      participantOrgIds: w!.participantOrgIds,
      infoOrgIds: w!.infoOrgIds,
      subject: w!.subject || (type?.name ?? '') + ' — ' + w!.resourceIds.map(resourceLabel).join('، '),
      unit: w!.unit,
      period: startISO ? { start: startISO, end: endISO } : undefined,
      values,
      targetReservationId: w!.targetReservationId,
    };
  }

  async function save(): Promise<RequestDetail> {
    const input = draftInput();
    const d = w!.requestId
      ? await api.updateDraft(w!.requestId, { ...input, expectedVersion: w!.version ?? 0 })
      : await api.createRequest({ ...input, typeCode: w!.typeCode });
    set({ requestId: d.id, version: d.version, status: d.status, revision: d.revision, attachments: d.attachments ?? w!.attachments });
    return d;
  }

  function explain(e: unknown): string {
    const err = e as ApiError;
    if (err.code === 'STALE_REVISION') return 'عُدّل الطلب من جلسة أخرى بعد فتحه. أغلق النافذة وأعد تحميل الطلب ثم أعد المحاولة.';
    return err.message ?? String(e);
  }

  async function saveDraft() {
    setBusy(true);
    setError('');
    try {
      await save();
      app.toast('حُفظت المسودة في الخادم');
      app.bump();
      onClose();
      if (request?.layout !== 'drawer') location.hash = 'requests';
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    const v = validate(4);
    if (v) return setError(v);
    setBusy(true);
    setError('');
    try {
      const d = await save();
      const submitted = await api.submit(d.id, d.version, w!.status === 'RETURNED' ? w!.resubmissionReason.trim() : undefined, submitKey.current);
      app.toast('أُرسل الطلب ' + submitted.number + ' للمراجعة — لم ينشأ حجز نهائي');
      app.setSelectedRequestId(submitted.id);
      app.bump();
      onClose();
      if (request?.layout !== 'drawer') location.hash = 'requests';
    } catch (e) {
      setError(explain(e));
      if ((e as ApiError).status !== 0) submitKey.current = newIdempotencyKey();
    } finally {
      setBusy(false);
    }
  }

  function next(delta: number) {
    if (delta < 0) {
      setError('');
      setStep((s) => Math.max(1, s - 1));
      return;
    }
    const v = validate(step);
    if (v) return setError(v);
    setError('');
    if (step === 4) return void submit();
    setStep(step + 1);
  }

  async function upload(fieldId: string, files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    setError('');
    try {
      const d = w!.requestId ? null : await save();
      const id = w!.requestId ?? d!.id;
      const added: Attachment[] = [];
      for (const file of Array.from(files)) {
        try {
          added.push(await api.uploadAttachment(id, fieldId, file));
        } catch (e) {
          setError(file.name + ': ' + explain(e));
        }
      }
      const fresh = await api.request(id);
      set({ attachments: fresh.attachments ?? [...w!.attachments, ...added], version: fresh.version });
      const rejected = added.filter((a) => a.scanStatus === 'REJECTED');
      if (rejected.length) setError('رُفض ملف بعد الفحص: ' + rejected.map((a) => a.fileName + (a.scanDetail ? ' (' + a.scanDetail + ')' : '')).join('، '));
    } catch (e) {
      setError(explain(e));
    } finally {
      setUploading(false);
    }
  }

  async function checkAvailability() {
    if (!startISO) return;
    try {
      setCheck(
        await api.availabilityCheck({
          resourceIds: w!.resourceIds,
          start: startISO,
          end: endISO,
          excludeReservationId: w!.targetReservationId,
        }),
      );
    } catch (e) {
      setError(explain(e));
    }
  }

  function changeUnit(unit: Unit) {
    const s = (w!.start || addDays(todayDubai(), 1)).slice(0, 10);
    const e = (w!.end || addDays(s, 2)).slice(0, 10);
    set(unit === 'HOURS' ? { unit, start: s + 'T09:00', end: e + 'T17:00' } : { unit, start: s, end: e });
  }

  function toggleResource(id: string, checked: boolean) {
    setCheck(null);
    if (checked) set({ resourceIds: multiSites ? [...new Set([...w!.resourceIds, id])] : [id] });
    else set({ resourceIds: w!.resourceIds.filter((x) => x !== id) });
  }

  function renderField(f: FormField) {
    const v = w!.values[f.id];
    const required = fieldRequired(f, ruleCtx);
    const star = required ? <span style={{ color: '#c99758' }}> *</span> : null;
    const onValue = (value: unknown) => set({ values: { ...w!.values, [f.id]: value } });
    let control;
    if (f.kind === 'textarea')
      control = <textarea value={String(v ?? '')} placeholder={f.label} onChange={(e) => onValue(e.target.value)} maxLength={f.maxLength} />;
    else if (f.kind === 'files') {
      const files = w!.attachments.filter((a) => a.fieldId === f.id);
      control = (
        <>
          <input type="file" multiple disabled={uploading} onChange={(e) => upload(f.id, e.target.files)} />
          <small>
            تُرفع الملفات إلى الخادم وتُفحص قبل إتاحتها
            {settings ? ' · الحد ' + formatBytes(settings.attachmentMaxBytes) : ''}
            {uploading ? ' · جارٍ الرفع…' : ''}
          </small>
          {files.map((a) => (
            <small key={a.id} className="attachment-row">
              {a.fileName} · {formatBytes(a.size)} · إصدار {a.version} ·{' '}
              <b className={a.scanStatus === 'CLEAN' ? 'ok' : a.scanStatus === 'REJECTED' ? 'bad' : ''}>
                {a.scanStatus === 'CLEAN' ? 'سليم' : a.scanStatus === 'REJECTED' ? 'مرفوض' + (a.scanDetail ? ' — ' + a.scanDetail : '') : 'قيد الفحص'}
              </b>
            </small>
          ))}
        </>
      );
    } else if (f.kind === 'select')
      control = (
        <select value={String(v ?? '')} onChange={(e) => onValue(e.target.value)}>
          <option value="">اختر…</option>
          {(f.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    else
      control = (
        <input
          type={f.kind === 'number' ? 'number' : f.kind === 'date' ? 'date' : 'text'}
          value={String(v ?? '')}
          min={f.kind === 'number' ? f.min ?? 1 : undefined}
          max={f.kind === 'number' ? f.max : undefined}
          maxLength={f.kind === 'text' ? f.maxLength : undefined}
          onChange={(e) => onValue(f.kind === 'number' && e.target.value !== '' ? Number(e.target.value) : e.target.value)}
        />
      );
    return (
      <label className="field" key={f.id}>
        <span>
          {f.label}
          {star}
        </span>
        {control}
      </label>
    );
  }

  let content;
  if (step === 1)
    content = (
      <>
        <div className="wizard-title">
          <h3>الجهة ونوع الخدمة</h3>
          <p>اختر الطلب الإداري الذي يحتاجه فريقك.</p>
        </div>
        <label className="field">
          <span>الجهة الطالبة</span>
          <select value={w.ownerOrgId} onChange={(e) => set({ ownerOrgId: e.target.value, participantOrgIds: w.participantOrgIds.filter((x) => x !== e.target.value) })}>
            {creatableOrgs.map((o) => (
              <option key={o.id} value={o.id}>
                {' '.repeat(o.depth * 2) + o.name}
              </option>
            ))}
          </select>
        </label>
        {multiOrgs && (
          <label className="field">
            <span>جهات مشاركة — اختياري</span>
            <select
              multiple
              size={2}
              value={w.participantOrgIds}
              onChange={(e) => set({ participantOrgIds: Array.from(e.target.selectedOptions).map((o) => o.value) })}
            >
              {orgs
                .filter((o) => o.id !== w.ownerOrgId)
                .map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
            </select>
            <small>يمكن اختيار عدة جهات.</small>
          </label>
        )}
        <div className="type-grid">
          {requestTypes.map((t) => (
            <button
              key={t.code}
              className={'type-button ' + (t.code === w.typeCode ? 'active' : '')}
              disabled={!!w.requestId}
              onClick={() => set({ typeCode: t.code, targetReservationId: null, pinnedForm: null })}
            >
              <Icon name={KIND_ICON[t.kind]} />
              {t.name}
            </button>
          ))}
        </div>
        <label className="field">
          <span>عنوان الطلب</span>
          <input value={w.subject} onChange={(e) => set({ subject: e.target.value })} placeholder="مثال: استخدام مركز الخدمات لاستقبال الموظفين" />
        </label>
        {type?.requiresTargetReservation && (
          <label className="field">
            <span>الحجز المعتمد المرتبط</span>
            <select
              value={w.targetReservationId ?? ''}
              onChange={(e) => {
                const r = reservations.find((x) => x.id === e.target.value);
                set({
                  targetReservationId: e.target.value || null,
                  resourceIds: r ? [r.resource.id] : w.resourceIds,
                  start: r ? toInput(r.period.start, w.unit) : w.start,
                  end: r ? toInput(r.period.end, w.unit) : w.end,
                });
              }}
            >
              <option value="">اختر حجزاً قائماً…</option>
              {reservations.map((r) => (
                <option key={r.id} value={r.id}>
                  {(r.requestNumber ?? r.id.slice(0, 8)) + ' — ' + r.resource.name + ' · ' + fullDate(r.period.start) + ' ← ' + fullDate(r.period.end)}
                </option>
              ))}
            </select>
          </label>
        )}
      </>
    );
  else if (step === 2) {
    const pick = ({ resource, site, label }: (typeof resourceOptions)[number]) => (
      <label className="site-pick" key={resource.id}>
        <input type="checkbox" checked={w.resourceIds.includes(resource.id)} onChange={(e) => toggleResource(resource.id, e.target.checked)} />
        <span>
          {label}
          <small>
            {resource.parentResourceId ? resource.kind : site.kind}
            {resource.policy === 'SHARED' ? ' · مشترك' : ''}
            {resource.parentResourceId ? ' · مورد فرعي' : focusSite && focusOptions.length > 1 ? ' · المورد الرئيسي' : ''}
          </small>
        </span>
      </label>
    );
    const focusChosen = w.resourceIds.some((id) => focusOptions.some((o) => o.resource.id === id));
    content = (
      <>
        <div className="wizard-title">
          <h3>المرافق والفترة</h3>
          <p>المرفق ثابت في السجل، والحجز مرتبط بفترة مستقلة.</p>
        </div>
        {focusSite && (
          <>
            <h4 className="pick-head">موارد «{focusSite.name}»</h4>
            {focusOptions.length > 1 && !focusChosen && (
              <p className="micro note orange">في هذا الموقع {focusOptions.length} موارد؛ اختر المطلوب منها. اختيار المورد الرئيسي يطلبه كاملاً وفق سياسته المهيأة.</p>
            )}
            <div className="site-pick-grid">{focusOptions.map(pick)}</div>
            {multiSites && otherOptions.length > 0 && (
              <button type="button" className="link-button text-link pick-more" onClick={() => setShowOthers((v) => !v)} aria-expanded={othersOpen}>
                {othersOpen ? 'إخفاء مرافق المواقع الأخرى' : 'إضافة مرافق من مواقع أخرى (' + otherOptions.length + ')'}
              </button>
            )}
          </>
        )}
        {othersOpen && (multiSites || !focusSite) && <div className="site-pick-grid">{otherOptions.map(pick)}</div>}
        <div className="selected-count">
          {w.resourceIds.length} مرفق محدد · {multiSites ? 'اختيار متعدد مفعّل' : 'مرفق واحد فقط'}
        </div>
        <label className="field">
          <span>وحدة الفترة</span>
          <select value={w.unit} onChange={(e) => changeUnit(e.target.value as Unit)}>
            <option value="DAYS">بالأيام</option>
            <option value="HOURS">بالساعات</option>
          </select>
        </label>
        <div className="row">
          <label className="field">
            <span>{periodLabels[0]}</span>
            <input type={w.unit === 'HOURS' ? 'datetime-local' : 'date'} value={w.start} onChange={(e) => (setCheck(null), set({ start: e.target.value }))} />
          </label>
          <label className="field">
            <span>{periodLabels[1]}</span>
            <input
              type={w.unit === 'HOURS' ? 'datetime-local' : 'date'}
              value={w.permanent ? '' : w.end}
              disabled={!needsEnd}
              onChange={(e) => (setCheck(null), set({ end: e.target.value }))}
            />
          </label>
        </div>
        {kind === 'NEW_RESERVATION' && type?.openEndAllowed !== false && (
          <label className="check-label">
            <input type="checkbox" checked={w.permanent} onChange={(e) => set({ permanent: e.target.checked })} />
            استخدام دائم — فترة مفتوحة النهاية بقرار موثق
          </label>
        )}
        <p className="micro muted">الأوقات حسب الإمارات. نهاية الفترة حد غير مشمول؛ حجز 1 إلى 4 نوفمبر ينتهي عند بداية يوم 4.</p>
        <div className="flex" style={{ marginTop: 12, gap: 10, flexWrap: 'wrap' }}>
          <button className="button compact" onClick={checkAvailability} disabled={!w.resourceIds.length || !w.start}>
            فحص الإتاحة — معاينة
          </button>
          {check && (
            <span className={'pill ' + (check.available ? 'green' : 'red')}>
              {check.available ? 'متاح حالياً' : 'متعارض: ' + check.conflicts.map((c) => c.resourceName).join('، ')}
              {check.pendingRequests ? ' · طلبات معلّقة: ' + check.pendingRequests : ''}
            </span>
          )}
        </div>
        {check && <p className="micro muted" style={{ marginTop: 6 }}>{check.note}</p>}
        <div className="note orange" style={{ marginTop: 15 }}>
          الحجز النهائي لا ينشأ عند إرسال الطلب. يظهر الطلب بالبرتقالي أثناء المراجعة، ويُعاد فحص الإتاحة ذرياً عند الاعتماد.
        </div>
      </>
    );
  } else if (step === 3)
    content = (
      <>
        <div className="wizard-title">
          <h3>تفاصيل النموذج</h3>
          <p>هذه الحقول تأتي من إصدار النموذج الخاص بنوع الطلب.</p>
        </div>
        {visibleFields.map(renderField)}
        <span className="pill">إصدار النموذج {form.version}</span>
      </>
    );
  else
    content = (
      <>
        <div className="wizard-title">
          <h3>راجع الطلب قبل الإرسال</h3>
          <p>لا يُنشأ حجز نهائي قبل اكتمال الاعتماد.</p>
        </div>
        <div className="wizard-summary">
          {(
            [
              ['نوع الطلب', type?.name ?? w.typeCode],
              ['الموقع', focusSite?.name ?? request.prefill?.siteName ?? '—'],
              ['الجهة', orgName(w.ownerOrgId)],
              ['المرافق', w.resourceIds.map(resourceLabel).join('، ')],
              ['الفترة', fullTime(startISO) + ' ← ' + (endISO ? fullTime(endISO) : needsEnd ? '—' : 'دون نهاية')],
              ['المبرر', String(w.values.reason ?? '')],
              ['الإصدارات', 'النموذج ' + form.version + ' / التدفق ' + (type?.workflowVersion?.version ?? '—')],
              ['نسخ الحدود', 'تُثبَّت نسخ حدود المواقع السارية عند الإرسال، ويراجعها أصحاب القرار كما هي'],
            ] as [string, string][]
          ).map(([k, v]) => (
            <div className="key-value" key={k}>
              <span>{k}</span>
              <b style={{ maxWidth: '70%' }}>{v}</b>
            </div>
          ))}
        </div>
        <h3 style={{ margin: '15px 0 9px' }}>جهات للعلم بعد الاعتماد</h3>
        <div className="flex" style={{ flexWrap: 'wrap' }}>
          {orgs.map((o) => (
            <label className="check-label" key={o.id}>
              <input
                type="checkbox"
                checked={w.infoOrgIds.includes(o.id)}
                onChange={(e) => set({ infoOrgIds: e.target.checked ? [...w.infoOrgIds, o.id] : w.infoOrgIds.filter((x) => x !== o.id) })}
              />
              {o.name}
            </label>
          ))}
        </div>
        <p className="micro muted">الإشعار للعلم لا يمنح حق الاطلاع على المرفقات تلقائياً.</p>
        {w.status === 'RETURNED' && (
          <label className="field" style={{ marginTop: 12 }}>
            <span>سبب التعديل وإعادة التقديم</span>
            <textarea value={w.resubmissionReason} onChange={(e) => set({ resubmissionReason: e.target.value })} placeholder="ما الذي تغيّر بعد الإرجاع؟" />
          </label>
        )}
        <div className="note" style={{ marginTop: 18 }}>
          مسار الطلب: {type?.workflowVersion?.stages.map((s) => s.name).join(' ← ') || 'لم يُنشر تدفق لهذا النوع بعد'}
        </div>
      </>
    );

  const pendingDiff: [string, string, string][] = [];
  const pendingSite = !!pending?.siteId && pending.siteId !== w.siteId;
  if (pending?.prefill) {
    const pf = pending.prefill;
    if (pendingSite) pendingDiff.push(['الموقع', focusSite?.name ?? '—', pf.siteName ?? '—']);
    if (pending.typeCode && pending.typeCode !== w.typeCode && !w.requestId)
      pendingDiff.push(['نوع الطلب', type?.name ?? '—', requestTypes.find((t) => t.code === pending.typeCode)?.name ?? pending.typeCode]);
    if (pf.ownerOrgId && pf.ownerOrgId !== w.ownerOrgId && creatableOrgs.some((o) => o.id === pf.ownerOrgId))
      pendingDiff.push(['الجهة', orgName(w.ownerOrgId), orgName(pf.ownerOrgId)]);
    const nextRes = pf.resourceIds ?? [];
    if (nextRes.join(',') !== w.resourceIds.join(','))
      pendingDiff.push(['الموارد', w.resourceIds.map(resourceLabel).join('، ') || '—', nextRes.map(resourceLabel).join('، ') || '—']);
    const nextPeriod = (pf.start ?? '') + ' ← ' + (pf.permanent ? 'مفتوحة' : pf.end ?? '');
    const curPeriod = w.start + ' ← ' + (w.permanent ? 'مفتوحة' : w.end);
    if (nextPeriod !== curPeriod) pendingDiff.push(['الفترة', curPeriod, nextPeriod]);
  }
  const applyPending = () => {
    const pf = pending?.prefill;
    if (pf) {
      setCheck(null);
      const typeChange = !!pending?.typeCode && pending.typeCode !== w.typeCode && !w.requestId;
      set({
        siteId: pending?.siteId ?? w.siteId,
        typeCode: typeChange ? pending!.typeCode! : w.typeCode,
        pinnedForm: typeChange ? null : w.pinnedForm,
        ownerOrgId: pf.ownerOrgId && creatableOrgs.some((o) => o.id === pf.ownerOrgId) ? pf.ownerOrgId : w.ownerOrgId,
        // a different site replaces the resources (none chosen yet stays none); the same site keeps the draft's choice
        resourceIds: pendingSite ? pf.resourceIds ?? [] : pf.resourceIds?.length ? pf.resourceIds : w.resourceIds,
        unit: pf.unit ?? w.unit,
        start: pf.start ?? w.start,
        end: pf.permanent ? '' : pf.end ?? w.end,
        permanent: !!pf.permanent,
      });
    }
    setPending(null);
  };
  const banner = pending && (
    <div className="note orange selection-change" role="alertdialog" aria-label="تغيير الاختيار من الخريطة">
      <b>تغيّر اختيارك على الخريطة. أثره على هذه المسودة غير المحفوظة:</b>
      {pendingDiff.length ? (
        <ul>
          {pendingDiff.map(([k, a, b]) => (
            <li key={k}>
              {k}: {a} ← <b>{b}</b>
            </li>
          ))}
        </ul>
      ) : (
        <p>لا فرق عن المسودة الحالية.</p>
      )}
      <div className="flex">
        <button className="button compact primary" onClick={applyPending} disabled={!pendingDiff.length}>
          تطبيق على المسودة
        </button>
        <button className="button compact" onClick={() => setPending(null)}>
          إبقاء المسودة كما هي
        </button>
      </div>
    </div>
  );

  const drawer = request.layout === 'drawer' && !expanded;
  if (drawer && minimized)
    return (
      <div className="request-drawer minimized" role="region" aria-label="طلب قيد الإعداد">
        <span>
          <b>طلب قيد الإعداد</b>
          <small>
            {w.resourceIds.map(resourceLabel).join('، ') || 'دون موارد'} · {w.start} ← {w.permanent ? 'مفتوحة' : w.end}
          </small>
        </span>
        <button className="button compact primary" onClick={() => setMinimized(false)}>
          متابعة الطلب
        </button>
      </div>
    );

  const body = (
    <>
      <div className="dialog-head">
        <div>
          <span className="eyebrow">NEW / ADMINISTRATIVE REQUEST</span>
          <h2>{w.requestId && w.status !== 'DRAFT' ? 'تعديل وإعادة تقديم' : w.requestId ? 'استكمال مسودة' : 'طلب إداري جديد'}</h2>
          <small>{w.requestId ? 'مراجعة ' + w.revision + ' · تحفظ في قاعدة بيانات الخادم' : 'يحفظ في قاعدة بيانات الخادم عند المسودة أو الإرسال'}</small>
        </div>
        <span className="drawer-buttons">
          {request.layout === 'drawer' && (
            <>
              <button className="button compact ghost" onClick={() => (setExpanded((v) => !v), setMinimized(false))}>
                {expanded ? 'عرض بجوار الخريطة' : 'توسيع النموذج'}
              </button>
              {!expanded && (
                <button className="button compact ghost" onClick={() => setMinimized(true)}>
                  تصغير والعودة للخريطة
                </button>
              )}
            </>
          )}
          <button className="icon-button" onClick={onClose} aria-label="إغلاق الطلب دون حفظ">
            <Icon name="close" />
          </button>
        </span>
      </div>
      {banner}
      <div className="wizard-context" aria-label="ملخص الاختيار">
        <span>
          <small>الموقع</small>
          <b>{focusSite?.name ?? request.prefill?.siteName ?? (w.resourceIds.length ? 'من القائمة' : '—')}</b>
        </span>
        <span>
          <small>نوع الطلب</small>
          <b>{type?.name ?? 'لم يُختر بعد'}</b>
        </span>
        <span>
          <small>الموارد</small>
          <b>{w.resourceIds.length ? w.resourceIds.map(resourceLabel).join('، ') : 'لم تُختر بعد'}</b>
        </span>
        <span>
          <small>الفترة</small>
          <b>{periodText}</b>
        </span>
      </div>
      <div className="wizard-steps">
        {STEPS.map((n, i) => (
          <div key={n} className={'wizard-step ' + (step === i + 1 ? 'active' : step > i + 1 ? 'done' : '')}>
            <i>{i + 1}</i>
            {n}
          </div>
        ))}
      </div>
      <div className="dialog-content wizard-content">
        {content}
        <div className="error-text" id="wizardError" role="alert">
          {error}
        </div>
      </div>
      <div className="dialog-actions">
        <button className="button" onClick={() => next(-1)} disabled={step === 1 || busy}>
          السابق
        </button>
        <button className="button ghost" onClick={saveDraft} disabled={busy}>
          حفظ مسودة
        </button>
        <span className="grow" />
        <button className="button primary" onClick={() => next(1)} disabled={busy || uploading}>
          {busy ? 'جارٍ الحفظ…' : step === 4 ? 'إرسال الطلب' : 'التالي ←'}
        </button>
      </div>
    </>
  );
  if (drawer)
    return (
      <aside className="request-drawer" role="dialog" aria-modal="false" aria-label="طلب إداري من الخريطة">
        {body}
      </aside>
    );
  return (
    <Dialog open onClose={onClose} className="large-dialog">
      {body}
    </Dialog>
  );
}

/** Pre-fills autofill fields once when they are still empty. */
function useAutofill(
  w: WizardState | null,
  schema: FormSchema,
  set: (p: Partial<WizardState>) => void,
  userName: string,
  ownerOrgName: string,
) {
  useEffect(() => {
    if (!w) return;
    const patch: Record<string, unknown> = {};
    for (const f of schema.fields) {
      if (!f.autofill) continue;
      const cur = w.values[f.id];
      if (cur !== undefined && cur !== '') continue;
      patch[f.id] = f.autofill === 'CURRENT_USER_NAME' ? userName : ownerOrgName;
    }
    if (Object.keys(patch).length) set({ values: { ...w.values, ...patch } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w?.typeCode, w?.ownerOrgId, schema]);
}
