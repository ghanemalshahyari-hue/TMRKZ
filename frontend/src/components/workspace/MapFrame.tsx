import { useEffect, useState, type ReactNode } from 'react';
import type { BasemapMode } from '../map/maplibre/offlineStyle';
import type { MapView } from '../map/maplibre/terrain3d';
import { LABELS } from '../../lib/requestMap';
import { Icon } from '../ui';
// the 2D/3D switch below is styled here: a page without the terrain panel (the posture) must not lose it under the map
import './terrain3d.css';

/** «الشوارع» / «طبيعة الأرض»: the two backgrounds of the offline map (the terrain is the GLO-30 hillshade, display only). */
export function MapModeSwitcher({ mode, setMode }: { mode: BasemapMode; setMode: (m: BasemapMode) => void }) {
  return (
    <div className="tz-segment" role="group" aria-label="خلفية الخريطة">
      <button className={'chip' + (mode === 'street' ? ' active' : '')} aria-pressed={mode === 'street'} onClick={() => setMode('street')}>
        الشوارع
      </button>
      <button className={'chip' + (mode === 'terrain' ? ' active' : '')} aria-pressed={mode === 'terrain'} onClick={() => setMode('terrain')}>
        طبيعة الأرض
      </button>
    </div>
  );
}

/**
 * The floating legend: what each colour means. The move line is information only; the leg connectors carry the
 * deployment distances (never a re-stationing restriction).
 */
export function MapLegend({ bands = true, move = true, stage = 'full', fold = false }: { bands?: boolean; move?: boolean; stage?: 'sites' | 'site' | 'full'; fold?: boolean }) {
  // folded on a tablet or phone, where it would cover the map
  const [open, setOpen] = useState(() => window.innerWidth > 1180);
  // folded when the 3D view opens: the cards on the ground name every geometry and must stay clear (one click opens it)
  useEffect(() => {
    if (fold) setOpen(false);
  }, [fold]);
  // only what the map can show at this point of a request: no deployment item before the deployment step
  const site = stage !== 'sites';
  const full = stage === 'full';
  return (
    <div className={'tz-legend rs-legend' + (open ? '' : ' closed')}>
      <button className="tz-legend-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="layers" /> مفتاح الخريطة
      </button>
      <ul hidden={!open}>
        <li><i className="sw ref" /> موقع مسجّل (للمرجع فقط)</li>
        {!site && <li><i className="sw ref-selected" /> الموقع المختار</li>}
        {site && <li><i className="sw current" /> {LABELS.CURRENT}</li>}
        {site && <li><i className="sw site" /> {LABELS.SITE}</li>}
        {site && <li><i className="sw occupied" /> أرض مشغولة (وحدات أخرى)</li>}
        {full && <li><i className="sw primary" /> {LABELS.PRIMARY}</li>}
        {full && <li><i className="sw alternative" /> {LABELS.ALTERNATIVE}</li>}
        {full && bands && <li><i className="sw leg" /> مسافة الانتشار من مركز إلى مركز (مع النطاق المسموح)</li>}
        {site && move && <li><i className="sw move" /> الانتقال إلى موقع إعادة التمركز (المسافة للعلم — لا قيد)</li>}
      </ul>
    </div>
  );
}

/**
 * «2D | 3D» on the map (owner brief «TRUE OFFLINE 3D TERRAIN», §1): the flat map, or MapLibre's real terrain from the
 * installed package's elevation tiles. Without them (an older package) 3D is unavailable and says why.
 */
export function ViewSwitcher({ view, setView, available }: { view: MapView; setView: (v: MapView) => void; available: boolean }) {
  return (
    <div className="tz-view-switch" role="group" aria-label="عرض الخريطة" data-testid="view-switch" data-view={view}>
      <button className={view === '2d' ? 'on' : ''} aria-pressed={view === '2d'} onClick={() => setView('2d')}>
        2D
      </button>
      <button
        className={view === '3d' ? 'on' : ''}
        aria-pressed={view === '3d'}
        disabled={!available}
        title={available ? 'طبيعة الأرض ثلاثية الأبعاد (Copernicus GLO-30، للعرض)' : 'نموذج الارتفاع ثلاثي الأبعاد غير مثبت في حزمة الخرائط'}
        onClick={() => setView('3d')}
      >
        3D
      </button>
    </div>
  );
}

/**
 * The dark framed map of the workspace (§8): a compact toolbar (title, state, background, framing), the map, its
 * floating legend and, along the bottom, the approval strip.
 */
export function MapFrame({ title, badge, tools, mode, setMode, onFit, legend, strip, children, placing, view, setView, has3d = false }: {
  title: ReactNode;
  badge?: ReactNode;
  tools?: ReactNode;
  mode: BasemapMode;
  setMode: (m: BasemapMode) => void;
  onFit?: () => void;
  legend?: ReactNode;
  strip?: ReactNode;
  children: ReactNode;
  placing?: boolean;
  /** The 2D/3D switch, when the page offers the 3D terrain view. */
  view?: MapView;
  setView?: (v: MapView) => void;
  has3d?: boolean;
}) {
  return (
    <section className="tz-mapframe rs-map-card" aria-label="الخريطة">
      <div className="tz-maptools rs-map-tools">
        <div className="tz-maptitle">
          {title}
          {badge}
        </div>
        <div className="tz-maptools-end">
          {tools}
          {onFit && (
            <button className="tz-tool" onClick={onFit} title="إظهار كل المواقع والمناطق">
              <Icon name="target" /> <span>الحدود والمناطق</span>
            </button>
          )}
          <MapModeSwitcher mode={mode} setMode={setMode} />
        </div>
      </div>
      <div className={'tz-mapbody' + (placing ? ' rs-placing' : '') + (view === '3d' ? ' tz-view-3d' : '')}>
        {children}
        {view && setView && <ViewSwitcher view={view} setView={setView} available={has3d} />}
        {legend}
      </div>
      {strip}
    </section>
  );
}
