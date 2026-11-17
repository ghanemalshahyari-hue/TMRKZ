import { useEffect, useState } from 'react';
import { ToolGlyph } from './ToolGlyph';
import type { ShapeKind } from '../../lib/shapeTransform';
import type { RestationingLeg } from '../../api/types';
import type { EditorLook, SiteEditor, SiteLive } from '../map/maplibre';
import { parseCoordinates } from '../../lib/coords';
import { describeAreaDefault, type resolveAreaDefault } from '../../lib/deploymentDefault';
import { formatArea, formatMeters } from '../../lib/footprint';
import { distanceM, type LatLng } from '../../lib/geo';
import { legText } from '../../lib/requestMap';
import { anchorOf, partsOf } from '../../lib/siteGeometry';

/**
 * A deployment area is edited on the map with the site's own editor (owner, 5 Nov 2026), in its own colour and tag. Shared by
 * the request editor and «موقع جديد» of «تهيئة المواقع والتمركز» (ADR-067): one look, one set of gestures.
 */
export const AREA_LOOK: Record<'primary' | 'alternative', EditorLook> = {
  primary: { tag: 'الانتشار الرئيسي', stroke: '#d9822b', fill: '#e8963a', symbol: false },
  alternative: { tag: 'الانتشار الفرعي', stroke: '#7b4fc0', fill: '#7b4fc0', symbol: false, dashed: true },
};

/**
 * A deployment area on the map, edited exactly as the re-stationing site (owner, 5 Nov 2026): «منطقة الانتشار
 * الرئيسية» / «الفرعية», each placed by one click with the policy's initial footprint («تحديد المنطقة على الخريطة»)
 * or drawn vertex by vertex with «عدد الرؤوس» («رسم حدود المنطقة»); either way it is then dragged by its body or its
 * tag, its numbered vertices edited, ↶ ↷ إعادة الضبط, ◎ and ⇆. Its distance is measured centre to centre — the primary
 * from the new site, the alternative from the primary — with the leg's allowed range and a verdict from the server's
 * last check (the server decides on save). No range ring. {@code tabs} false: the page chooses the area itself (one step
 * per area in «موقع جديد»), so the two tabs are not drawn.
 */
export function AreaControls({ editor, listeners, area, onArea, hasPrimary, placing, areaDefault, policyVersion, onPlace, onDraw, target, setTarget, origin, leg, checked, siteWord, tabs = true, children, shaping = null, onShape }: {
  /** A ready shape the next map click places (the toolbar, owner brief §7), and how one is chosen. */
  shaping?: ShapeKind | null;
  onShape?: (k: ShapeKind) => void;
  siteWord: string;
  editor: React.RefObject<SiteEditor | null>;
  listeners: React.RefObject<Set<(l: SiteLive) => void>>;
  area: 'primary' | 'alternative';
  onArea: (k: 'primary' | 'alternative') => void;
  hasPrimary: boolean;
  placing: boolean;
  areaDefault: ReturnType<typeof resolveAreaDefault>;
  policyVersion: { version: number; reference: string | null } | null;
  onPlace: () => void;
  onDraw: () => void;
  target: number;
  setTarget: (n: number) => void;
  origin: LatLng | null;
  /** The leg as the map shows it: the server's check of exactly this geometry, otherwise the analysis preview. */
  leg: RestationingLeg | undefined;
  /** The server's check at the last save («تحقق الخادم»). */
  checked: RestationingLeg | undefined;
  tabs?: boolean;
  children?: React.ReactNode;
}) {
  const [live, setLive] = useState<SiteLive | null>(null);
  useEffect(() => {
    const set = listeners.current;
    set.add(setLive);
    editor.current?.refresh();
    return () => {
      set.delete(setLive);
    };
  }, [editor, listeners]);
  const ed = editor.current;
  const open = live?.mode === 'draw';
  const d = open ? live?.draw ?? null : null;
  const has = !open && !!live?.geometry;
  const vertexMode = live?.mode === 'vertices';
  const anchor = has && live?.geometry ? anchorOf(partsOf(live.geometry)) : null;
  const dist = anchor && origin ? legText(distanceM(origin, anchor), leg) : null;
  const ring = has && live?.geometry && live.activePart != null ? partsOf(live.geometry)[live.activePart]?.[0] ?? null : null;
  // «تحديد» shows the Word-like frame and its handles, «تحريك» drags the whole shape, «الرؤوس» edits its vertices
  const [tool, setTool] = useState<'select' | 'move' | 'vertices'>('select');
  useEffect(() => {
    if (!ed || open) return;
    ed.setMode(tool === 'vertices' ? 'vertices' : 'move');
    ed.setShapeHandles(tool === 'select');
  }, [tool, ed, open, has]);
  return (
    <div className="rs-site-controls tz-place stw-proposal-panel" data-testid="area-controls" data-area={area}>
      {tabs && (
        <div className="stw-tabs" role="tablist" aria-label="منطقة الانتشار">
          <button role="tab" aria-selected={area === 'primary'} className={area === 'primary' ? 'on' : ''} onClick={() => onArea('primary')}>
            منطقة الانتشار الرئيسية
          </button>
          <button role="tab" aria-selected={area === 'alternative'} className={area === 'alternative' ? 'on' : ''} disabled={!hasPrimary} title={hasPrimary ? undefined : 'ضع منطقة الانتشار الرئيسية أولاً'} onClick={() => onArea('alternative')}>
            منطقة الانتشار الفرعية
          </button>
        </div>
      )}
      {/* «أدوات الرسم والتحكم (مثل Word)» (owner brief §7, reference panel 5) */}
      <div className="da-toolbar" role="toolbar" aria-label="أدوات الرسم والتحكم" data-testid={`tools-${area}`}>
        <div className="da-tgroup">
          <button type="button" className={'da-tool' + (tool === 'select' && !placing && !open && !shaping ? ' on' : '')} data-tool="select" disabled={!has} onClick={() => setTool('select')}><ToolGlyph k="select" /><span>تحديد</span></button>
          <button type="button" className={'da-tool' + (tool === 'move' && !placing && !open && !shaping ? ' on' : '')} data-tool="move" disabled={!has} onClick={() => setTool('move')}><ToolGlyph k="move" /><span>تحريك</span></button>
        </div>
        <div className="da-tgroup">
          {onShape && ([['CIRCLE', 'دائرة'], ['ELLIPSE', 'بيضاوي']] as const).map(([k, label]) => (
            <button key={k} type="button" className={'da-tool' + (shaping === k ? ' on' : '')} data-tool={k} disabled={open} onClick={() => onShape(k)}><ToolGlyph k={k} /><span>{label}</span></button>
          ))}
          <button type="button" className={'da-tool' + (placing && !shaping ? ' on' : '')} aria-pressed={placing && !shaping} aria-label="تحديد المنطقة على الخريطة" data-tool="SQUARE" disabled={!areaDefault.value || open} title="مربع بالشكل الابتدائي من السياسة، بنقرة" onClick={onPlace}><ToolGlyph k="SQUARE" /><span>مربع</span></button>
          {onShape && <button type="button" className={'da-tool' + (shaping === 'RECTANGLE' ? ' on' : '')} data-tool="RECTANGLE" disabled={open} onClick={() => onShape('RECTANGLE')}><ToolGlyph k="RECTANGLE" /><span>مستطيل</span></button>}
          <button type="button" className={'da-tool' + (open ? ' on' : '')} aria-label="رسم حدود المنطقة" data-tool="draw" onClick={onDraw}><ToolGlyph k="draw" /><span>رسم حر</span></button>
        </div>
        <div className="da-tgroup">
          <button type="button" className={'da-tool' + (vertexMode ? ' on' : '')} data-tool="vertices" disabled={!has} onClick={() => setTool(vertexMode ? 'select' : 'vertices')}><ToolGlyph k="vertices" /><span>الرؤوس</span></button>
          <button type="button" className="da-tool" data-tool="undo" disabled={open ? !d?.count : !live?.canUndo} onClick={() => (open ? ed?.undoVertex() : ed?.undo())}><ToolGlyph k="undo" /><span>تراجع</span></button>
          <button type="button" className="da-tool" data-tool="redo" disabled={open ? !live?.canRedoDraw : !live?.canRedo} onClick={() => (open ? ed?.redoVertex() : ed?.redo())}><ToolGlyph k="redo" /><span>إعادة</span></button>
          <button type="button" className="da-tool" data-tool="reset" onClick={() => (open ? ed?.restartDrawing() : ed?.reset())}><ToolGlyph k="reset" /><span>إعادة الضبط</span></button>
        </div>
      </div>
      <p className="stw-hint" data-testid="area-hint">
        {area === 'primary' ? 'تُقاس من مركز ' + siteWord + '. ' : 'تُقاس من مركز منطقة الانتشار الرئيسية. '}
        {placing
          ? 'انقر على المكان المطلوب لوضع المنطقة ثم عدّلها.'
          : open
            ? 'انقر على الخريطة لوضع الرؤوس بالترتيب.'
            : has
              ? 'اسحب المنطقة أو وسمها لنقلها كاملة، أو اسحب رأساً لتعديله.'
              : 'حدّد المنطقة بنقرة ثم عدّلها، أو ارسم حدودها.'}
      </p>
      <p className="stw-hint" data-testid="area-default">
        {areaDefault.source === 'POLICY'
          ? 'الشكل الابتدائي من سياسة التمركز' + (policyVersion ? ` (النسخة ${policyVersion.version})` : '') + ': ' + describeAreaDefault(areaDefault.value!) + (policyVersion?.reference ? ' — ' + policyVersion.reference : '')
          : 'لم يُحدَّد الشكل الابتدائي في سياسة التمركز: استخدم «رسم حدود المنطقة»'}
      </p>
      {open && (
        <div className="stw-row">
          <label className="stw-field inline">
            <span>عدد الرؤوس</span>
            <input type="number" min={3} max={20} value={target} aria-label="عدد الرؤوس" onChange={(e) => setTarget(Math.max(3, Math.min(20, Math.round(Number(e.target.value) || 3))))} />
          </label>
          <span className="stw-hint" data-testid="draw-readout" data-count={d?.count ?? 0}>
            {d?.count ?? 0} / {live?.target ?? target}
          </span>
        </div>
      )}
      <div className="stw-live stack">
        <span>المسافة {area === 'primary' ? 'من ' + siteWord : 'من المنطقة الرئيسية'}</span>
        <b className={dist ? (dist.tone === 'ok' ? 'y' : dist.tone === 'none' ? '' : 'n') : ''} data-testid="area-distance">{dist?.text ?? '—'}</b>
      </div>
      <dl className="stw-read" data-testid="area-readout">
        <dt>المساحة</dt>
        <dd>{open ? (d && d.count >= 3 ? formatArea(d.areaM2) : '—') : has ? formatArea(live!.areaM2) : '—'}</dd>
        <dt>صحة الشكل</dt>
        <dd className={(open ? !!d && d.count >= 3 && d.ok : !!live?.ok && has) ? 'y' : ''}>
          {open ? ((d?.count ?? 0) < 3 ? 'لم يكتمل الرسم' : d?.ok ? '✓ صالح' : '✕ غير صالح') : has ? (live!.ok ? '✓ صالح' : '✕ ' + live!.problems.join('، ')) : '—'}
        </dd>
        <dt>تحقق الخادم</dt>
        <dd>{checked && checked.status !== 'NOT_PLACED' ? 'عند آخر حفظ: ' + (checked.status === 'OK' ? 'ضمن النطاق' : checked.status === 'NEEDS_EXCEPTION' ? 'يتجاوز المسموح — يقرره المعتمد النهائي' : checked.status === 'OUT_OF_RANGE' ? 'خارج النطاق' : 'تعادل في طبيعة الأرض') : 'عند الحفظ'}</dd>
      </dl>
      {children}
      {vertexMode && ring && (
        <details className="stw-coords-box">
          <summary>إحداثيات الرؤوس (اختياري)</summary>
          <table className="stw-vt" aria-label="رؤوس منطقة الانتشار">
            <thead>
              <tr>
                <th>#</th>
                <th>خط العرض</th>
                <th>خط الطول</th>
                <th>الضلع التالي</th>
              </tr>
            </thead>
            <tbody>
              {ring.map((v, i) => (
                <VertexRow key={i + ':' + v.lat + ':' + v.lng} i={i} v={v} next={distanceM(v, ring[(i + 1) % ring.length])} onSet={(p) => live?.activePart != null && ed?.setVertex(live.activePart, 0, i, p)} />
              ))}
            </tbody>
          </table>
        </details>
      )}
      <div className="stw-tools">
        <button className="button" disabled={open ? !d?.count : !live?.canUndo} onClick={() => (open ? ed?.undoVertex() : ed?.undo())} title="تراجع">
          ↶ تراجع
        </button>
        <button className="button" disabled={open ? !live?.canRedoDraw : !live?.canRedo} onClick={() => (open ? ed?.redoVertex() : ed?.redo())} title="إعادة">
          ↷ إعادة
        </button>
        <button className="button" disabled={!has && !open} onClick={() => (open ? ed?.restartDrawing() : ed?.reset())}>
          إعادة الضبط
        </button>
        {has && (
          <button className={'button' + (vertexMode ? ' on' : '')} aria-pressed={vertexMode} onClick={() => ed?.setMode(vertexMode ? 'move' : 'vertices')}>
            تعديل الرؤوس
          </button>
        )}
        <button className="button" disabled={!has && !d?.count} onClick={() => ed?.focus()}>
          ◎ المنطقة
        </button>
        <button className="button" disabled={!has || !origin} onClick={() => ed?.compare()}>
          ⇆ المسافة
        </button>
      </div>
    </div>
  );
}

/** One vertex of the coordinates table: typed latitude and longitude, applied on Enter or when the field is left. */
export function VertexRow({ i, v, next, onSet }: { i: number; v: LatLng; next: number; onSet: (p: LatLng) => void }) {
  const [lat, setLat] = useState(v.lat.toFixed(6));
  const [lng, setLng] = useState(v.lng.toFixed(6));
  const [bad, setBad] = useState(false);
  const apply = () => {
    const r = parseCoordinates(lat, lng);
    setBad(!r.point);
    if (r.point && (r.point.lat !== v.lat || r.point.lng !== v.lng)) onSet(r.point);
  };
  const key = (e: React.KeyboardEvent) => e.key === 'Enter' && apply();
  return (
    <tr className={bad ? 'bad' : undefined}>
      <td>{i + 1}</td>
      <td><input inputMode="decimal" value={lat} aria-label={'خط عرض الرأس ' + (i + 1)} onChange={(e) => setLat(e.target.value)} onBlur={apply} onKeyDown={key} /></td>
      <td><input inputMode="decimal" value={lng} aria-label={'خط طول الرأس ' + (i + 1)} onChange={(e) => setLng(e.target.value)} onBlur={apply} onKeyDown={key} /></td>
      <td>{formatMeters(next)}</td>
    </tr>
  );
}
