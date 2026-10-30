import { useState } from 'react';
import type { MapFeature, RequestType, SiteDetail, SiteRequestActionCode } from '../../api/types';
import { fullDate, fullTime } from '../../lib/dates';
import { AVAILABILITY_STYLE, RESOURCE_STYLE, UNKNOWN_STYLE, type MapPeriod } from '../../lib/mapState';
import { ResourceSettings } from './ResourceSettings';
import { SiteRequestActionList, type SiteActionsState } from './SiteActionMenu';

export type SiteAction =
  | { kind: 'NEW'; action: SiteRequestActionCode; typeCode: string }
  | { kind: 'CHANGE'; reservationId: string; typeCode: string }
  | { kind: 'EDIT_BOUNDARY' }
  | { kind: 'EDIT_MARKER' }
  | { kind: 'IMPORT_BOUNDARY' }
  | { kind: 'FIT' };

const CHANGE_LABELS: Record<string, string> = {
  EXTENSION: 'تمديد الاستخدام',
  MODIFICATION: 'تعديل الفترة',
  CANCELLATION: 'إنهاء الاستخدام',
  EVACUATION: 'إخلاء وتسليم',
};

function periodText(p: MapPeriod): string {
  if (p.mode === 'OPEN') return 'من ' + fullDate(p.start) + ' — مفتوحة المدة';
  if (p.mode === 'HOURS') return p.start.replace('T', ' ') + ' ← ' + p.end.replace('T', ' ');
  return p.start + ' ← ' + p.end + ' (اليوم الأخير غير مشمول)';
}

/**
 * The selected site: where it sits in the site tree, who is responsible and who uses it in the period, its boundary
 * status and version, the state of each resource for the period, and only the actions the server allows.
 */
export function SiteDetailPanel({
  site,
  feature,
  loading,
  error,
  period,
  selectedResources,
  onToggleResource,
  onAction,
  actions,
  canCreate,
  requestTypes,
  onClose,
}: {
  site: SiteDetail | null;
  feature: MapFeature | null;
  loading: boolean;
  error: string | null;
  period: MapPeriod;
  selectedResources: string[];
  onToggleResource: (id: string, on: boolean) => void;
  onAction: (a: SiteAction) => void;
  /** The same server-decided request actions as the on-map menu. */
  actions: SiteActionsState | null;
  canCreate: boolean;
  requestTypes: RequestType[];
  onClose: () => void;
}) {
  const [settings, setSettings] = useState(false);
  if (!site) {
    return (
      <aside className="card map-detail" aria-live="polite">
        <p className="micro muted">{loading ? 'جارٍ تحميل الموقع…' : error ?? 'اختر موقعاً من الخريطة أو من شجرة المواقع لعرض تفاصيله.'}</p>
      </aside>
    );
  }
  const st = feature ? AVAILABILITY_STYLE[feature.availability] : UNKNOWN_STYLE;
  const changeTypes = requestTypes.filter((t) => t.requiresTargetReservation);
  const active = site.occupancy.filter((o) => o.status === 'ACTIVE');
  const full = site.view === 'FULL';
  const resources = feature?.resources ?? [];
  const selectedParents = resources.filter((r) => selectedResources.includes(r.id) && resources.some((c) => c.parentResourceId === r.id));

  return (
    <aside className="card map-detail" aria-live="polite" aria-label={'تفاصيل ' + site.name}>
      <div className="flex spread">
        <span className="eyebrow">{site.parentId ? 'ZONE' : 'MAIN SITE'} / {site.code}</span>
        <button className="icon-button" onClick={onClose} aria-label="إغلاق التفاصيل">
          ✕
        </button>
      </div>
      <h2>{site.name}</h2>
      <p className="micro muted detail-path">
        {site.path.length ? site.path.map((p) => p.name).join(' ‹ ') + ' ‹ ' : ''}
        <b>{site.name}</b> · {site.parentId ? 'منطقة أو موقع فرعي' : 'موقع رئيسي'} · {site.kind}
      </p>

      <div className={'state-banner ' + (error ? 'neutral' : st.pill)} role="status">
        <span className="state-symbol" aria-hidden="true">
          {error ? '?' : st.symbol}
        </span>
        <div>
          <b>{error ? UNKNOWN_STYLE.label : loading ? 'جارٍ تحديث الإتاحة…' : st.label}</b>
          <small>{error ? 'لم تُحدَّث الإتاحة؛ لا تُعرض نتيجة سابقة على أنها حديثة. ' + error : periodText(period) + ' · ' + st.hint}</small>
        </div>
      </div>

      <div className="detail-request">
        <SiteRequestActionList state={actions} onChoose={(action, typeCode) => onAction({ kind: 'NEW', action, typeCode })} />
        {selectedResources.length > 0 && (
          <p className="micro muted selected-resources">
            الموارد المختارة تنتقل إلى النموذج: {resources.filter((r) => selectedResources.includes(r.id)).map((r) => r.name).join('، ')}
          </p>
        )}
      </div>

      <dl className="meta-grid">
        <div>
          <dt>الجهة المسؤولة</dt>
          <dd>{full ? site.responsibleOrg?.name ?? '—' : 'محجوبة في العرض المختصر'}</dd>
        </div>
        <div>
          <dt>الجهات الشاغلة في الفترة</dt>
          <dd>{full ? (feature?.occupants?.length ? feature.occupants.map((o) => o.name).join('، ') : 'لا يوجد') : 'محجوبة'}</dd>
        </div>
        <div>
          <dt>الحدود</dt>
          <dd>
            {site.boundaryStatus === 'REGISTERED' && site.geometry ? (
              <>
                مسجلة · الإصدار {site.geometry.version} · {site.geometry.type === 'MultiPolygon' ? 'عدة أجزاء' : 'مضلع'}
              </>
            ) : (
              <span className="no-boundary-text">حدود الموقع غير مسجلة</span>
            )}
          </dd>
        </div>
        <div>
          <dt>المصدر</dt>
          <dd>{site.boundaryStatus === 'REGISTERED' ? site.geometry?.source + ' · ' + fullDate(site.geometry?.validFrom) : 'العلامة موقع عرض فقط'}</dd>
        </div>
      </dl>

      <h3 className="detail-h">الموارد للفترة المختارة</h3>
      {resources.length === 0 && <p className="micro muted">{loading ? 'جارٍ التحميل…' : 'لا موارد قابلة للطلب في هذا الموقع.'}</p>}
      <ul className="resource-list">
        {resources.map((r) => {
          const rs = error ? UNKNOWN_STYLE : RESOURCE_STYLE[r.state];
          const child = !!r.parentResourceId;
          return (
            <li key={r.id} className={child ? 'child' : ''}>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={selectedResources.includes(r.id)}
                  onChange={(e) => onToggleResource(r.id, e.target.checked)}
                  aria-label={'اختيار ' + r.label}
                />
                <span className="grow">
                  {child ? '↳ ' : ''}
                  {r.name}
                  <small>
                    {r.policy === 'SHARED' ? 'مشترك' : 'حصري'}
                    {r.handoverMinutes ? ' · تسليم ' + r.handoverMinutes + ' د' : ''}
                    {r.pending ? ' · ⏳ طلب قيد المراجعة' : ''}
                    {r.reason ? ' · ' + r.reason : ''}
                  </small>
                </span>
                <span className={'pill ' + rs.pill}>
                  {rs.symbol} {rs.label}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      {selectedParents.length > 0 && (
        <p className="micro note">
          اختيار «{selectedParents.map((r) => r.name).join('، ')}» يحجز المورد كاملاً ويمنع موارده الفرعية خلال الفترة وفق سياسة المورد المهيأة؛
          الموارد الفرعية لا تُضاف تلقائياً إلى الطلب.
        </p>
      )}

      <div className="detail-actions">
        <button className="button compact" onClick={() => onAction({ kind: 'FIT' })}>
          ملاءمة الموقع على الخريطة
        </button>
        {site.canManage && (
          <>
            <button className="button compact" onClick={() => onAction({ kind: 'EDIT_MARKER' })}>
              {site.location ? 'تحرير سجل الموقع — نقل العلامة' : 'تحرير سجل الموقع — تحديد العلامة'}
            </button>
            <button className="button compact" onClick={() => onAction({ kind: 'EDIT_BOUNDARY' })}>
              تحرير سجل الموقع — الحدود
            </button>
            <button className="button compact ghost" onClick={() => onAction({ kind: 'IMPORT_BOUNDARY' })}>
              استيراد حدود لهذا الموقع
            </button>
            <button className="button compact ghost" onClick={() => setSettings(true)}>
              إعداد الموارد وعلاقاتها
            </button>
          </>
        )}
        {settings && <ResourceSettings site={site} onClose={() => setSettings(false)} />}
      </div>

      {full && canCreate && active.length > 0 && changeTypes.length > 0 && (
        <>
          <h3 className="detail-h">استخدام قائم</h3>
          <ul className="usage-list">
            {active.slice(0, 8).map((o) => (
              <li key={o.reservationId}>
                <span>
                  <b>{o.resourceName}</b>
                  <small>
                    {o.org?.name ?? ''} · {fullTime(o.period.start)} ← {o.period.end ? fullTime(o.period.end) : 'مفتوحة'}
                  </small>
                </span>
                <span className="usage-actions">
                  {changeTypes
                    .filter((t) => t.kind !== 'EXTENSION' || o.period.end)
                    .map((t) => (
                      <button key={t.code} className="button compact ghost" onClick={() => onAction({ kind: 'CHANGE', reservationId: o.reservationId, typeCode: t.code })}>
                        {CHANGE_LABELS[t.kind] ?? t.name}
                      </button>
                    ))}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="micro muted" style={{ marginTop: 10 }}>
        المعاينة لا تمنح حجزاً؛ يُعاد التحقق من الموارد والفترة والسياسة عند الاعتماد النهائي.
      </p>
    </aside>
  );
}
