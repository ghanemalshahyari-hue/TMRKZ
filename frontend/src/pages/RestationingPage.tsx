import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl';
import { api } from '../api/client';
import type { Ref, RestationingChecks, RestationingListItem, RestationingRequest, RestationingState } from '../api/types';
import { Heading, Icon } from '../components/ui';
import { OfflineMapLibre, addOverlayLayer } from '../components/map/maplibre';
import { LABEL_FONT, type BasemapMode } from '../components/map/maplibre/offlineStyle';
import { useApp } from '../lib/app';
import { fullDate } from '../lib/dates';
import { formatArea } from '../lib/footprint';
import { centre, requestFeatures } from '../lib/requestMap';
import { partsOf, siteArea } from '../lib/siteGeometry';
import { HIERARCHY_CHANGED } from '../lib/stationingV3';
import { RestationingEditor } from './RestationingEditor';
import './restationing.css';

/** Request states of Model V3 §3 with the owner's wording. */
export const RS_STATE: Record<RestationingState, [string, string]> = {
  DRAFT: ['مسودة', ''],
  UNDER_REVIEW: ['قيد الاعتماد', 'orange'],
  RETURNED_FOR_CHANGES: ['معاد للتعديل', 'orange'],
  PAUSED_HIERARCHY_CHANGED: ['موقوف — تغيّر الهيكل', 'red'],
  REJECTED: ['مرفوض', 'red'],
  APPROVED_NOT_ACTIVATED: ['معتمد — بانتظار التفعيل', 'blue'],
  CANCELLATION_PENDING: ['بانتظار قرار الإلغاء', 'orange'],
  CANCELLED_BEFORE_ACTIVATION: ['أُلغي قبل التفعيل', ''],
  ACTIVATED_PERMANENT: ['مفعّل — دائم', 'green'],
  TEMPORARY_SCHEDULED: ['مؤقت مجدول', 'blue'],
  START_HELD_PENDING_CANCELLATION: ['البدء موقوف — بانتظار قرار الإلغاء', 'orange'],
  ACTIVE_TEMPORARY: ['مؤقت نافذ', 'green'],
  TEMPORARY_RETURNED: ['انتهى المؤقت — عادت الوحدات', ''],
  TEMPORARY_CANCELLED_BEFORE_START: ['أُلغي قبل البدء', ''],
  TEMPORARY_WINDOW_EXPIRED_WITHOUT_START: ['انقضت النافذة دون بدء', ''],
  EXTENSION_ACTIVATED: ['تمديد مفعّل', 'green'],
  LAPSED_NOT_ACTIVATED: ['سقط دون تفعيل', ''],
};

/** The lifecycle actions (ADR-034) with the owner's wording. */
const ACTION_KIND: Record<string, string> = {
  PRE_ACTIVATION_CANCELLATION: 'إلغاء قبل التفعيل',
  BEFORE_START_CANCELLATION: 'إلغاء التمركز المؤقت قبل بدء نفاذه',
  EARLY_RETURN: 'عودة مبكرة',
};
const ACTION_STATE: Record<string, string> = {
  REQUESTED: 'بانتظار القرار',
  APPROVED: 'قُبل',
  REJECTED: 'رُفض',
  NO_LONGER_ACTIONABLE: 'لم يعد قابلاً للقرار',
  SUPERSEDED: 'تجاوزه انتهاء المؤقت',
};

const LEG_STATUS: Record<string, string> = {
  NOT_PLACED: 'غير موضوعة',
  OK: 'ضمن النطاق',
  NEEDS_EXCEPTION: 'تحتاج استثناء مسافة',
  OUT_OF_RANGE: 'خارج النطاق',
  TERRAIN_TIE_UNRESOLVED: 'تعادل فئات أرض دون أولوية',
};

const BASEMAP = '/map-data/basemap/uae.pmtiles';
const HILLSHADE = { url: '/map-data/terrain/glo30/visualization/hillshade.pmtiles', kind: 'raster' as const };
const km = (m: number | null | undefined) => (m == null ? '—' : (m / 1000).toLocaleString('ar-AE', { maximumFractionDigits: 2 }) + ' كم');

/** The proposed site as an approver reads it: type, part count, area and, once submitted, the submission holding it. */
function proposedSite(r: RestationingRequest): string {
  const g = r.content.site?.geometry;
  if (!g) return '—';
  const parts = partsOf(g);
  const held = r.state !== 'DRAFT' && r.state !== 'RETURNED_FOR_CHANGES' ? r.revisions.at(-1)?.n : undefined;
  return [g.type === 'MultiPolygon' ? 'مضلع متعدد' : 'مضلع', parts.length === 1 ? 'جزء واحد' : `${parts.length} أجزاء`,
    formatArea(siteArea(parts)), ...(held ? [`الإرسال #${held}`] : [])].join(' · ');
}

export function StatePill({ state }: { state: RestationingState }) {
  const [label, tone] = RS_STATE[state] ?? [state, ''];
  return (
    <span className={'pill ' + tone}>
      <i className="dot" />
      {label}
    </span>
  );
}

/** «إعادة التمركز»: the re-stationing requests the server lets this person see, one at a time on the offline map. */
/** The unit of a stage, shown apart from the stage's fixed label (owner, 4 Nov 2026); the exception stage acts for the requesting unit. */
function StageUnit({ unit, kind }: { unit: Ref | null; kind: string }) {
  if (unit) return <small className="rs-stage-unit">الجهة: {unit.name}</small>;
  return kind === 'EXCEPTION' ? <small className="rs-stage-unit">يقررها صاحب «اعتماد استثناء مسافة الانتشار»</small> : null;
}

export function RestationingPage() {
  const app = useApp();
  const [items, setItems] = useState<RestationingListItem[] | null>(null);
  const [selected, setSelected] = useState<string | null>(() => location.hash.split('/')[1] ?? null);
  const [editing, setEditing] = useState<{ id: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    api
      .restationingRequests()
      .then((l) => {
        setItems(l);
        setError(null);
        setSelected((s) => s ?? l[0]?.id ?? null);
      })
      .catch((e: Error) => setError(e.message));
  }, [tick, app.revision]);

  const canCreate = app.can('CREATE_RESTATIONING');
  return (
    <>
      <Heading
        en="RE-STATIONING / MODEL V3"
        title="إعادة التمركز"
        description="موقع مقترح واحد، والوحدات المنتقلة يختارها مقدم الطلب، ومسار الاعتماد يبدأ من الوحدة الطالبة ويصعد في الهيكل. التحقق على الخادم ولا توصية بمكان."
        actions={
          <button className="button primary" disabled={!canCreate} onClick={() => setEditing({ id: null })} title={canCreate ? '' : 'تحتاج صلاحية «طلب إعادة التمركز»'}>
            ＋ طلب إعادة تمركز
          </button>
        }
      />
      {error && <div className="rs-error">{error}</div>}
      {editing ? (
        <RestationingEditor
          requestId={editing.id}
          onClose={(id) => {
            setEditing(null);
            if (id) setSelected(id);
            reload();
          }}
        />
      ) : (
        <div className="rs-layout">
          <aside className="card rs-list">
            {items == null && <div className="empty">جارٍ التحميل…</div>}
            {items?.length === 0 && <div className="empty">لا توجد طلبات ضمن نطاقك.</div>}
            {items?.map((r) => (
              <button key={r.id} className={'rs-item' + (r.id === selected ? ' active' : '')} onClick={() => setSelected(r.id)}>
                <span className="rs-item-head">
                  <b>{r.number}</b>
                  <StatePill state={r.state} />
                </span>
                <span>{r.requestingUnit.name} · {r.kind === 'TEMPORARY' ? 'مؤقت' : 'دائم'} · {r.units} وحدة</span>
                {r.currentStage && <small>المرحلة الحالية: {r.currentStage}{r.currentStageUnit ? ' · ' + r.currentStageUnit : ''}</small>}
                <small>
                  {r.requester.name}
                  {r.mine ? ' (أنت)' : ''} · {fullDate(r.updatedAt)}
                </small>
              </button>
            ))}
          </aside>
          {selected ? <RequestDetail id={selected} onChanged={reload} onEdit={() => setEditing({ id: selected })} onOpen={(x) => { setSelected(x); reload(); }} /> : <div className="card empty">اختر طلباً.</div>}
        </div>
      )}
    </>
  );
}

function RequestDetail({ id, onChanged, onEdit, onOpen }: { id: string; onChanged: () => void; onEdit: () => void; onOpen: (id: string) => void }) {
  const app = useApp();
  const [r, setR] = useState<RestationingRequest | null>(null);
  const [checks, setChecks] = useState<RestationingChecks | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<BasemapMode>('street');

  useEffect(() => {
    setR(null);
    setChecks(null);
    setReason('');
    api.restationingRequest(id).then(setR).catch((e: Error) => app.toast(e.message));
    api.restationingChecks(id).then(setChecks).catch(() => setChecks(null));
  }, [id, app]);

  const act = async (what: () => Promise<RestationingRequest>, done: string) => {
    setBusy(true);
    try {
      const next = await what();
      setR(next);
      setReason('');
      api.restationingChecks(id).then(setChecks).catch(() => undefined);
      app.toast(done);
      onChanged();
    } catch (e) {
      app.toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!r) return <div className="card empty">جارٍ التحميل…</div>;
  const c = r.content;
  const resubmit = r.state === 'RETURNED_FOR_CHANGES' || r.state === 'PAUSED_HIERARCHY_CHANGED';
  return (
    <section className="rs-detail">
      <div className="card rs-summary">
        <div className="rs-summary-head">
          <div>
            <span className="eyebrow">{r.number}</span>
            <h2>
              {c.kind === 'TEMPORARY' ? 'إعادة تمركز مؤقتة' : 'إعادة تمركز دائمة'} — {r.requestingUnit.name}
            </h2>
            <p>{c.reason}</p>
          </div>
          <StatePill state={r.state} />
        </div>
        {r.state === 'PAUSED_HIERARCHY_CHANGED' && (
          <div className="rs-banner red">
            <b>موقوف — تغيّر الهيكل:</b> {HIERARCHY_CHANGED}. المسار السابق محفوظ بقراراته، وبعد التأكيد يُعاد بناء المسار من الوحدة نفسها وتُعاد كل المراحل.
          </div>
        )}
        {r.returned && r.state === 'RETURNED_FOR_CHANGES' && (
          <div className="rs-banner orange">
            <b>أعاده {r.returned.byName}</b> ({r.returned.stageLabel}): {r.returned.reason}
          </div>
        )}
        <dl className="rs-facts">
          <div>
            <dt>الوحدات المنتقلة</dt>
            <dd>{r.units.map((u) => u.name).join('، ') || '—'}</dd>
          </div>
          <div>
            <dt>من</dt>
            <dd>{r.currentSites.map((s) => s.site.name).join('، ') || '—'}</dd>
          </div>
          <div>
            <dt>الموقع المقترح</dt>
            <dd data-testid="proposed-site">{proposedSite(r)}</dd>
          </div>
          <div>
            <dt>{c.kind === 'TEMPORARY' ? 'المدة' : 'النفاذ'}</dt>
            <dd>{c.kind === 'TEMPORARY' ? `${fullDate(c.start ?? '')} ← ${fullDate(c.end ?? '')}` : 'عند التفعيل المستقل'}</dd>
          </div>
          <div>
            <dt>نسخة السياسة</dt>
            <dd>{r.policyVersion ?? (checks?.policyVersion != null ? `${checks.policyVersion} (النافذة؛ تُقفل عند الإرسال)` : '—')}</dd>
          </div>
          <div>
            <dt>مقدم الطلب</dt>
            <dd>{r.requester.name}</dd>
          </div>
          {r.activation && (
            <div>
              <dt>التفعيل</dt>
              <dd>
                {r.activation.by.name} · {fullDate(r.activation.at)} · {r.activation.site.name}
              </dd>
            </div>
          )}
        </dl>
      </div>

      <div className="card rs-map-card">
        <div className="rs-map-tools">
          <span>الخلفية:</span>
          <button className={'chip' + (mode === 'street' ? ' active' : '')} onClick={() => setMode('street')}>الشوارع</button>
          <button className={'chip' + (mode === 'terrain' ? ' active' : '')} onClick={() => setMode('terrain')}>طبيعة الأرض</button>
          <span className="rs-legend">
            <i className="current" /> الموقع الحالي <i className="site" /> الموقع المقترح <i className="primary" /> الانتشار الرئيسية <i className="alternative" /> الانتشار البديلة <i className="band" /> النطاق المسموح (إرشاد)
          </span>
        </div>
        <RequestMap request={r} checks={checks} mode={mode} />
      </div>

      <div className="rs-columns">
        <div className="card rs-route">
          <h3>مسار الاعتماد {r.routeNo > 1 ? `(البناء ${r.routeNo})` : ''}</h3>
          {r.route.length === 0 && checks?.route && (
            <>
              <p className="muted">المسار المتوقع عند الإرسال (من الوحدة الطالبة صعوداً):</p>
              <ol className="rs-stages">
                {checks.route.map((s) => (
                  <li key={s.key}>
                    <b>{s.label}</b>
                    <StageUnit unit={s.unit} kind={s.kind} />
                    <small>يستوفي: {s.satisfies.join('، ')}</small>
                  </li>
                ))}
              </ol>
            </>
          )}
          <ol className="rs-stages">
            {r.route.map((s) => (
              <li key={s.key} className={s.mark ? 'done' : s.current ? 'current' : ''}>
                <b>{s.label}</b>
                <StageUnit unit={s.unit} kind={s.kind} />
                <small>يستوفي: {s.satisfies.join('، ')}</small>
                {s.mark && (
                  <small>
                    {s.mark === 'CARRIED' ? 'محمول من قرار سابق' : 'اعتمدها'} {s.decidedBy?.name} · {fullDate(s.decidedAt ?? '')}
                  </small>
                )}
                {s.current && <small className="rs-now">المرحلة الحالية</small>}
              </li>
            ))}
          </ol>
          {r.previousRoutes.length > 0 && (
            <details>
              <summary>المسارات السابقة المحفوظة ({r.previousRoutes.length})</summary>
              {r.previousRoutes.map((p) => (
                <ol key={p.routeNo} className="rs-stages old">
                  {p.stages.map((s) => (
                    <li key={s.key} className={s.mark ? 'done' : ''}>
                      <b>{s.label}</b>
                      <StageUnit unit={s.unit} kind={s.kind} />
                      {s.mark && <small>اعتمدها {s.decidedBy?.name}</small>}
                    </li>
                  ))}
                </ol>
              ))}
            </details>
          )}
          {r.revisions.length > 0 && (
            <details>
              <summary>الإرسالات ({r.revisions.length})</summary>
              <ul className="rs-revisions">
                {r.revisions.map((v) => (
                  <li key={v.n}>
                    #{v.n} · {v.submittedBy} · {fullDate(v.submittedAt)} · تغيّر: {v.changed.join('، ') || '—'} · أُعيد: {v.invalidated.length} · حُمل: {v.carried.length}
                    {v.reason && <div className="muted">{v.reason}</div>}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>

        <div className="card rs-checks">
          <h3>الفحوص على السياسة {checks?.policyVersion != null ? `(نسخة ${checks.policyVersion})` : ''}</h3>
          {checks == null && <div className="muted">جارٍ الفحص…</div>}
          {checks && (
            <>
              <div className={'rs-verdict ' + (checks.ok ? 'ok' : 'no')}>{checks.ok ? 'كل الفحوص مستوفاة' : 'فحوص غير مستوفاة'}</div>
              {checks.problems.length > 0 && (
                <ul className="rs-problems">
                  {checks.problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
              {checks.siteAreaM2 != null && (
                <p>
                  مساحة الموقع المقترح: <b>{Number(checks.siteAreaM2).toLocaleString('ar-AE')} م²</b> من حد{' '}
                  {Number(checks.maxFootprintAreaM2).toLocaleString('ar-AE')} م²
                </p>
              )}
              {checks.legs?.map((l) => (
                <div key={l.leg} className={'rs-leg ' + l.status}>
                  <b>{l.label}</b> — {LEG_STATUS[l.status]}
                  <div>
                    المسافة من المركز إلى المركز: <b>{km(l.distanceM)}</b> · المسموح {km(l.baseMinM)}–{km(l.baseMaxM)}
                    {l.effectiveMaxM !== l.baseMaxM ? ` ← ${km(l.effectiveMinM)}–${km(l.effectiveMaxM)} بعد إضافة الأرض` : ''}
                  </div>
                  {l.terrain && (
                    <div className="muted">
                      فئة الأرض الحاكمة: <b>{l.terrain.controllingLabel}</b> (+{km(l.terrain.allowanceM)})
                      {l.terrain.tie ? ` · تعادل ${l.terrain.tied.join('/')} حسمه ترتيب الأولوية` : ''} · النسب:{' '}
                      {l.terrain.shares
                        .filter((s) => s.percent > 0)
                        .map((s) => `${s.label} ${s.percent.toLocaleString('ar-AE', { maximumFractionDigits: 1 })}٪`)
                        .join('، ')}{' '}
                      · {l.terrain.dataset} (نموذج سطح {l.terrain.surfaceModel})
                    </div>
                  )}
                  {l.conflicts.length > 0 && <div className="rs-bad">أرض مشغولة: {l.conflicts.join('، ')}</div>}
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      <div className="card rs-actions">
        {r.can.edit && (
          <button className="button" onClick={onEdit} disabled={busy}>
            <Icon name="file" /> تعديل الطلب
          </button>
        )}
        {(r.can.submit || r.can.decide || r.can.activate) && (
          <textarea
            className="rs-reason"
            placeholder={r.can.decide ? 'سبب القرار (مطلوب للإرجاع والرفض)' : resubmit ? 'ما الذي عدّلته أو أكّدته (مطلوب)' : 'ملاحظة (اختيارية)'}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        )}
        {r.can.submit && (
          <button className="button primary" disabled={busy} onClick={() => act(() => api.submitRestationing(r.id, reason), resubmit ? 'أُعيد الإرسال' : 'أُرسل الطلب')}>
            {r.state === 'PAUSED_HIERARCHY_CHANGED' ? 'تأكيد وإعادة بناء المسار' : resubmit ? 'إعادة الإرسال' : 'إرسال للاعتماد'}
          </button>
        )}
        {r.can.decide && (
          <>
            <button className="button primary" disabled={busy} onClick={() => act(() => api.decideRestationing(r.id, 'APPROVE', reason), 'اعتُمدت المرحلة')}>
              اعتماد المرحلة
            </button>
            <button className="button" disabled={busy} onClick={() => act(() => api.decideRestationing(r.id, 'RETURN', reason), 'أُعيد الطلب للتعديل')}>
              إرجاع للتعديل
            </button>
            <button className="button danger" disabled={busy} onClick={() => act(() => api.decideRestationing(r.id, 'REJECT', reason), 'رُفض الطلب')}>
              رفض
            </button>
          </>
        )}
        {r.can.activate && (
          <button className="button primary" disabled={busy} onClick={() => act(() => api.activateRestationing(r.id, reason), r.requestKind === 'EXTENSION' ? 'فُعّل التمديد' : 'فُعّل الطلب')}>
            {r.requestKind === 'EXTENSION' ? 'تفعيل التمديد (إجراء مستقل)' : 'تفعيل (إجراء مستقل)'}
          </button>
        )}
        {!r.can.edit && !r.can.submit && !r.can.decide && !r.can.activate && !hasLifecycle(r) && (
          <span className="muted">لا إجراء لك على هذا الطلب في حالته الحالية — الخادم يقرر من يرى ويقرر.</span>
        )}
      </div>

      <Lifecycle r={r} busy={busy} act={act} onOpen={onOpen} />
    </section>
  );
}

const hasLifecycle = (r: RestationingRequest) =>
  !!(r.can.askCancellation || r.can.askStartCancellation || r.can.askEarlyReturn || r.can.askExtension || r.can.decideAction);

/**
 * The lifecycle of a request (ADR-034): ask for a cancellation, a cancellation before the start, an early return or an
 * extension; decide a pending action (another human with its own right); and the history of actions and extensions.
 * Every button follows the server's `can`; the server refuses anything else.
 */
function Lifecycle({ r, busy, act, onOpen }: { r: RestationingRequest; busy: boolean; act: (what: () => Promise<RestationingRequest>, done: string) => void; onOpen: (id: string) => void }) {
  const [why, setWhy] = useState('');
  const [end, setEnd] = useState('');
  const pending = r.actions?.find((a) => a.state === 'REQUESTED');
  const asks = r.can.askCancellation || r.can.askStartCancellation || r.can.askEarlyReturn || r.can.askExtension;
  if (!asks && !pending && !(r.actions?.length || r.extensions?.length || r.parent)) return null;
  return (
    <div className="card rs-lifecycle">
      <h3>دورة حياة الطلب</h3>
      {r.parent && (
        <p>
          تمديد للتمركز المؤقت{' '}
          <button className="link" onClick={() => onOpen(r.parent!.id)}>
            {r.parent.number}
          </button>
        </p>
      )}
      {r.effectiveEnd && r.requestKind === 'TEMPORARY' && <p className="muted">النهاية الفعالة: {fullDate(r.effectiveEnd)}</p>}
      {pending && (
        <div className="rs-banner orange">
          <b>{ACTION_KIND[pending.kind]}</b> — طلبه {pending.requestedBy} · {fullDate(pending.requestedAt)} · السبب: {pending.reason}
          {pending.heldAt && <div>أُوقف البدء في {fullDate(pending.heldAt)}: التمركز الدائم هو المعتمد حتى القرار.</div>}
        </div>
      )}
      {(asks || r.can.decideAction) && (
        <textarea className="rs-reason" placeholder="السبب (مطلوب للطلب وللرفض)" value={why} onChange={(e) => setWhy(e.target.value)} />
      )}
      <div className="rs-tools">
        {r.can.decideAction && (
          <>
            <button className="button primary" disabled={busy} onClick={() => act(() => api.decideRestationingAction(r.id, r.can.decideAction!, 'APPROVE', why), 'قُبل الإجراء')}>
              قبول {pending ? ACTION_KIND[pending.kind] : ''}
            </button>
            <button className="button danger" disabled={busy} onClick={() => act(() => api.decideRestationingAction(r.id, r.can.decideAction!, 'REJECT', why), 'رُفض الإجراء')}>
              رفض
            </button>
          </>
        )}
        {r.can.askCancellation && (
          <button className="button" disabled={busy} onClick={() => act(() => api.askRestationingCancellation(r.id, why), 'طُلب الإلغاء قبل التفعيل')}>
            طلب إلغاء قبل التفعيل
          </button>
        )}
        {r.can.askStartCancellation && (
          <button className="button" disabled={busy} onClick={() => act(() => api.askStartCancellation(r.id, why), 'طُلب إلغاء التمركز المؤقت قبل بدئه')}>
            طلب إلغاء قبل بدء النفاذ
          </button>
        )}
        {r.can.askEarlyReturn && (
          <button className="button" disabled={busy} onClick={() => act(() => api.askEarlyReturn(r.id, why), 'طُلبت العودة المبكرة')}>
            طلب عودة مبكرة
          </button>
        )}
        {r.can.askExtension && (
          <>
            <label>
              نهاية التمديد <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
            </label>
            <button
              className="button"
              disabled={busy || !end}
              onClick={() =>
                act(async () => {
                  const ext = await api.createRestationingExtension(r.id, new Date(end).toISOString(), why);
                  onOpen(ext.id);
                  return ext;
                }, 'أُعدّت مسودة التمديد — أرسلها للاعتماد')
              }
            >
              طلب تمديد
            </button>
          </>
        )}
      </div>
      {!!r.actions?.length && (
        <details open={!!pending}>
          <summary>الإجراءات ({r.actions.length})</summary>
          <ul className="rs-revisions">
            {r.actions.map((a) => (
              <li key={a.id}>
                <b>{ACTION_KIND[a.kind]}</b> · {ACTION_STATE[a.state]} — طلبه {a.requestedBy} ({fullDate(a.requestedAt)}): {a.reason}
                {a.decidedBy && <> · قرره {a.decidedBy} ({fullDate(a.decidedAt ?? '')}){a.decisionReason ? ': ' + a.decisionReason : ''}</>}
                {a.closeReason && <> · {a.closeReason}</>}
              </li>
            ))}
          </ul>
        </details>
      )}
      {!!r.extensions?.length && (
        <details>
          <summary>التمديدات ({r.extensions.length})</summary>
          <ul className="rs-revisions">
            {r.extensions.map((e) => (
              <li key={e.id}>
                <button className="link" onClick={() => onOpen(e.id)}>
                  {e.number}
                </button>{' '}
                · حتى {fullDate(e.end)} · <StatePill state={e.state} />
                {e.lapseReason && <> · {e.lapseReason}</>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** The request on the offline map: current sites, the proposed site, the deployment areas and their guidance bands. */
export function RequestMap({ request, checks, mode, height = 420, onMap, fitMaxZoom = 15, hideSite = false, fit = true }: { request: RestationingRequest; checks: RestationingChecks | null; mode: BasemapMode; height?: number; onMap?: (m: MlMap) => void; fitMaxZoom?: number; hideSite?: boolean; fit?: boolean }) {
  const [map, setMap] = useState<MlMap | null>(null);
  // the editor draws the proposed site itself while it is being edited (hideSite); the bands still follow it
  const data = useMemo(() => requestFeatures(request, checks, hideSite), [request, checks, hideSite]);
  const initial = useMemo(() => {
    const c = request.content.site?.geometry ? centre(request.content.site.geometry) : { lng: 55.3, lat: 25.2 };
    return [c.lng, c.lat] as [number, number];
  }, [request.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const fitted = useRef<string | null>(null);
  useEffect(() => {
    if (!map) return;
    (map.getSource('rs') as GeoJSONSource | undefined)?.setData(data);
    const pts = data.features.flatMap((f) =>
      f.geometry.type === 'Polygon' ? (f.geometry.coordinates[0] as [number, number][]) : f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates.flatMap((part) => part[0] as [number, number][]) : [],
    );
    // the camera follows a newly opened request once; editing it never moves the camera under the user's hand
    if (fit && pts.length && fitted.current !== request.id) {
      fitted.current = request.id;
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: 40, maxZoom: fitMaxZoom, duration: 0 });
    }
  }, [map, data]);

  return (
    <div style={{ height }}>
      <OfflineMapLibre
        basemapUrl={BASEMAP}
        hillshade={HILLSHADE}
        mode={mode}
        center={initial}
        zoom={12}
        onReady={(m) => {
          m.addSource('rs', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
          addOverlayLayer(m, { id: 'rs-band', type: 'fill', source: 'rs', filter: ['==', ['get', 'role'], 'BAND'], paint: { 'fill-color': '#2f6fd6', 'fill-opacity': 0.08 } });
          addOverlayLayer(m, { id: 'rs-band-line', type: 'line', source: 'rs', filter: ['==', ['get', 'role'], 'BAND'], paint: { 'line-color': '#2f6fd6', 'line-width': 1, 'line-dasharray': [3, 3] } });
          addOverlayLayer(m, {
            id: 'rs-fill',
            type: 'fill',
            source: 'rs',
            filter: ['!=', ['get', 'role'], 'BAND'],
            paint: {
              'fill-color': ['match', ['get', 'role'], 'CURRENT', '#8a8f98', 'SITE', '#1f8a4c', 'PRIMARY', '#d9822b', 'ALTERNATIVE', '#8e44ad', '#888'],
              'fill-opacity': 0.28,
            },
          });
          addOverlayLayer(m, {
            id: 'rs-line',
            type: 'line',
            source: 'rs',
            filter: ['!=', ['get', 'role'], 'BAND'],
            paint: {
              'line-color': ['match', ['get', 'role'], 'CURRENT', '#5b6069', 'SITE', '#13643a', 'PRIMARY', '#a8611c', 'ALTERNATIVE', '#6c3483', '#555'],
              'line-width': 2,
            },
          });
          addOverlayLayer(
            m,
            {
              id: 'rs-label',
              type: 'symbol',
              source: 'rs',
              // only the label points carry a label: one per site or area, a MultiPolygon included (requestFeatures)
              filter: ['has', 'label'],
              // labels never overlap (owner, 4 Nov 2026): each may move around its polygon; when none fits at this zoom the
              // least important waits for a closer zoom (proposed site first, then the primary, alternative, current site)
              layout: {
                'text-field': ['get', 'label'],
                'text-font': [LABEL_FONT],
                'text-size': 13,
                // one line: a mixed Arabic/Latin name («موقع RS-2026-0012 (الحالي)») must not wrap inside its number
                'text-max-width': 40,
                'text-allow-overlap': false,
                'text-variable-anchor': ['center', 'top', 'bottom', 'left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right'],
                'text-radial-offset': 0.9,
                'text-justify': 'auto',
                'text-padding': 4,
                'symbol-sort-key': ['match', ['get', 'role'], 'SITE', 0, 'PRIMARY', 1, 'ALTERNATIVE', 2, 'CURRENT', 3, 4],
              },
              paint: { 'text-color': '#1d2733', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
            },
            'top',
          );
          setMap(m);
          onMap?.(m);
        }}
      />
    </div>
  );
}
