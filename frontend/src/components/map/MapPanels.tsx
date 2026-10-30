import type { Coverage, MapContext, MapPackage } from '../../api/types';
import { ADMIN_STYLE, AVAILABILITY_STYLE, UNKNOWN_STYLE, type LayerSettings, type MapMode, type StateStyle } from '../../lib/mapState';

const KIND_LABEL: Record<string, string> = {
  ROADS: 'خريطة طرق',
  AERIAL: 'صور جوية',
  FACILITY_PLAN: 'مخطط مرفق مسند جغرافياً',
};

/** Real backgrounds only: installed, licensed and active packages. A missing kind is named as missing. */
export function BackgroundPanel({
  context,
  selected,
  onSelect,
  onManage,
  preview,
}: {
  context: MapContext | null;
  selected: MapPackage | null;
  onSelect: (p: MapPackage | null) => void;
  onManage?: () => void;
  preview?: MapPackage | null;
}) {
  const list = context?.backgrounds ?? [];
  return (
    <div className="map-popover" role="dialog" aria-label="الخلفيات">
      <h3>الخلفية</h3>
      <div role="radiogroup" aria-label="اختيار الخلفية">
        {list.map((p) => (
          <label key={p.id} className="radio-row">
            <input type="radio" name="background" checked={selected?.id === p.id} onChange={() => onSelect(p)} onClick={() => onSelect(p)} />
            <span>
              <b>{p.name}</b>
              <small>
                {KIND_LABEL[p.kind] ?? p.kind} · إصدار {p.version} · {p.dataDate} · تكبير {p.minZoom ?? '?'}–{p.maxZoom ?? '?'} · {p.license}
              </small>
            </span>
          </label>
        ))}
        {preview && preview.status !== 'ACTIVE' && (
          <label className="radio-row preview">
            <input type="radio" name="background" checked={selected?.id === preview.id} onChange={() => onSelect(preview)} onClick={() => onSelect(preview)} />
            <span>
              <b>معاينة: {preview.name}</b>
              <small>حزمة قيد المراجعة — تظهر لمدير الخرائط فقط</small>
            </span>
          </label>
        )}
        <label className="radio-row">
          <input type="radio" name="background" checked={!selected} onChange={() => onSelect(null)} onClick={() => onSelect(null)} />
          <span>
            <b>دون خلفية</b>
            <small>الحدود والعلامات فقط</small>
          </span>
        </label>
      </div>
      {!list.length && <p className="micro note red">لا توجد حزمة خرائط مفعّلة.</p>}
      {context && !context.aerialInstalled && (
        <p className="micro note">
          لم تثبت حزمة صور جوية معتمدة.{' '}
          {context.canManagePackages && onManage ? (
            <button className="link-button text-link" onClick={onManage}>
              فتح مدير الخرائط
            </button>
          ) : (
            'يثبتها مدير الخرائط المخول عند توفر حزمة مرخصة.'
          )}
        </p>
      )}
      {!list.some((p) => p.kind === 'FACILITY_PLAN') && <p className="micro muted">لا يوجد مخطط مرفق مسند جغرافياً مثبت.</p>}
    </div>
  );
}

export function LayersPanel({ layers, onChange, canSeeRequests }: { layers: LayerSettings; onChange: (l: LayerSettings) => void; canSeeRequests: boolean }) {
  const set = (patch: Partial<LayerSettings>) => onChange({ ...layers, ...patch });
  return (
    <div className="map-popover" role="dialog" aria-label="الطبقات">
      <h3>الطبقات</h3>
      <label className="check-label">
        <input type="checkbox" checked={layers.sites.visible} onChange={(e) => set({ sites: { ...layers.sites, visible: e.target.checked } })} />
        حدود المواقع الرئيسية
      </label>
      <label className="range-row">
        شفافية الحدود
        <input type="range" min={0} max={0.8} step={0.05} value={layers.sites.opacity} onChange={(e) => set({ sites: { ...layers.sites, opacity: Number(e.target.value) } })} aria-label="شفافية حدود المواقع" />
      </label>
      <label className="check-label">
        <input type="checkbox" checked={layers.zones.visible} onChange={(e) => set({ zones: { ...layers.zones, visible: e.target.checked } })} />
        المناطق والمواقع الفرعية
      </label>
      <label className="range-row">
        شفافية المناطق
        <input type="range" min={0} max={0.8} step={0.05} value={layers.zones.opacity} onChange={(e) => set({ zones: { ...layers.zones, opacity: Number(e.target.value) } })} aria-label="شفافية المناطق" />
      </label>
      <label className="check-label">
        <input type="checkbox" checked={layers.zonesOnTop} onChange={(e) => set({ zonesOnTop: e.target.checked })} />
        المناطق فوق حدود المواقع (ترتيب الطبقات)
      </label>
      <label className="check-label">
        <input type="checkbox" checked={layers.markers} onChange={(e) => set({ markers: e.target.checked })} />
        علامات المواقع ذات الحدود (تبقى علامات المواقع دون حدود ظاهرة)
      </label>
      <label className="check-label">
        <input type="checkbox" checked={layers.colours} onChange={(e) => set({ colours: e.target.checked })} />
        ألوان الإتاحة أو حالة الطلبات
      </label>
      {canSeeRequests && (
        <label className="check-label">
          <input type="checkbox" checked={layers.requests} onChange={(e) => set({ requests: e.target.checked })} />
          شارات الطلبات قيد المراجعة المسموح لك برؤيتها
        </label>
      )}
      <label className="check-label">
        <input type="checkbox" checked={layers.orgSymbols} onChange={(e) => set({ orgSymbols: e.target.checked })} />
        رموز الجهات المرتبطة بالمواقع (هوية معلوماتية، بجانب العلامة)
      </label>
      <label className="range-row">
        شفافية الخلفية
        <input type="range" min={0.2} max={1} step={0.05} value={layers.backgroundOpacity} onChange={(e) => set({ backgroundOpacity: Number(e.target.value) })} aria-label="شفافية الخلفية" />
      </label>
      <p className="micro muted">أسماء المواقع أداة مستقلة في شريط الخريطة.</p>
    </div>
  );
}

export function Legend({ mode, stale }: { mode: MapMode; stale: boolean }) {
  const items: StateStyle[] =
    mode === 'availability'
      ? [AVAILABILITY_STYLE.FREE, AVAILABILITY_STYLE.PARTIAL, AVAILABILITY_STYLE.BUSY, AVAILABILITY_STYLE.NO_RESOURCES]
      : [ADMIN_STYLE.PENDING, ADMIN_STYLE.APPROVED, ADMIN_STYLE.NONE];
  return (
    <div className="map-legend" aria-label="مفتاح الألوان">
      {(stale ? [UNKNOWN_STYLE] : items).map((s) => (
        <span key={s.label} title={s.hint}>
          <i className="legend-swatch" style={{ background: s.color }} aria-hidden="true">
            {s.symbol}
          </i>
          {s.label}
        </span>
      ))}
      <span title="موقع له علامة عرض فقط دون حدود مسجلة">
        <i className="legend-swatch dashed" aria-hidden="true" />
        حدود غير مسجلة
      </span>
    </div>
  );
}

export function CoverageNote({ coverage, background }: { coverage: Coverage | null; background: MapPackage | null }) {
  if (!coverage) return null;
  const tone = coverage.status === 'FULL' || coverage.status === 'UNKNOWN' ? '' : coverage.status === 'NONE' || coverage.status === 'NO_PACKAGE' ? 'red' : 'orange';
  const text =
    coverage.message ??
    (background ? 'الخلفية: ' + background.name + ' · إصدار ' + background.version + ' · ' + background.dataDate : 'دون خلفية — الحدود والعلامات فقط');
  return (
    <div className={'map-caption coverage ' + tone} role="status" data-coverage={coverage.status}>
      {text}
    </div>
  );
}
