import { useState, type ReactNode } from 'react';
import type { BasemapMode } from '../map/maplibre/offlineStyle';
import { LABELS } from '../../lib/requestMap';
import { Icon } from '../ui';

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
export function MapLegend({ bands = true, move = true, stage = 'full' }: { bands?: boolean; move?: boolean; stage?: 'sites' | 'site' | 'full' }) {
  // folded on a tablet or phone, where it would cover the map
  const [open, setOpen] = useState(() => window.innerWidth > 1180);
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
 * The dark framed map of the workspace (§8): a compact toolbar (title, state, background, framing), the map, its
 * floating legend and, along the bottom, the approval strip.
 */
export function MapFrame({ title, badge, tools, mode, setMode, onFit, legend, strip, children, placing }: {
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
      <div className={'tz-mapbody' + (placing ? ' rs-placing' : '')}>
        {children}
        {legend}
      </div>
      {strip}
    </section>
  );
}
