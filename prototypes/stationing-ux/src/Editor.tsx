import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import L from '../../../frontend/src/lib/leaflet';
import { FootprintEditor, type FootprintLive } from '../../../frontend/src/components/stationing/FootprintEditor';
import { parseCoordinates } from '../../../frontend/src/lib/coords';
import { areaM2, centroid, edgeLengths, formatArea, formatMeters, type Ring } from '../../../frontend/src/lib/footprint';
import { circle, distanceM, formatKm } from '../../../frontend/src/lib/geo';
import { RANGE, SITES, orgById, type Site } from './data';
import { SheetContext } from './sheet';
import { SymbolMark, type Symbols } from './symbols';

type Use = 'PERMANENT' | 'TEMPORARY' | 'WORK_AREA';
export type Draft = {
  id: string;
  siteId: string;
  orgId: string;
  ring: Ring;
  use: Use;
  level: 'MAIN' | 'BRANCH';
  start: string;
  end: string;
  name: string;
  reason: string;
  savedAt: string;
};

// drafts of the prototype live only in this browser (no server); a real draft is a relocation request on the server
const KEY = 'tmrkz.proto.stationing.drafts';
const readAll = (): Record<string, Draft> => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}');
  } catch {
    return {};
  }
};
export const loadDraft = (id: string): Draft | null => readAll()[id] ?? null;
function storeDraft(d: Draft) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...readAll(), [d.id]: d }));
  } catch {
    /* storage unavailable: the prototype keeps the draft for this session only */
  }
}

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const pct = (x: number) => (Math.abs(x) < 0.005 ? 'مطابقة للمعتمد' : (x > 0 ? '+' : '−') + Math.round(Math.abs(x) * 100) + '٪ عن المعتمد');

const proposalSymbol = (url: string | null | undefined) =>
  url ? '<img class="stw-sym-img" src="' + url + '" alt="" />' : '<span class="ux-sym generic" style="height:20px;width:28px"></span>';

/** A map tag's possible place: a point and how the tag sits against it ('' is its default side). */
type Spot = { at: L.LatLngExpression; cls: '' | 'above' | 'below' | 'east' | 'west' };
type Tag = { marker: L.Marker; spots: Spot[]; fallback: 'compact' | 'hidden' };
/** The northern, southern, eastern and western vertices of a ring. */
const extremes = (ring: Ring) => {
  const most = (f: (p: Ring[number]) => number) => ring.reduce((a, b) => (f(b) > f(a) ? b : a));
  const at = (p: Ring[number]) => [p.lat, p.lng] as L.LatLngTuple;
  return { n: at(most((p) => p.lat)), s: at(most((p) => -p.lat)), e: at(most((p) => p.lng)), w: at(most((p) => -p.lng)) };
};

/**
 * The relocation editor of the prototype: a contextual panel (a bottom sheet on tablets and phones) beside a floating
 * toolbar on the map. It drives the application's own polygon engine (FootprintEditor) unchanged. What differs is the
 * presentation: the registered site is a blue dashed outline that never changes, the proposal is green; the range is two
 * labelled rings with the allowed band shaded; no range error is shown before the proposal is first moved; the details
 * step opens only when the location is valid. Checks are local here — the real page asks the server after every drop.
 */
export function Editor({
  map,
  site,
  orgId,
  symbols,
  draft,
  narrow,
  onClose,
  onSaved,
}: {
  map: L.Map | null;
  site: Site;
  orgId: string;
  symbols: Symbols;
  draft: Draft | null;
  narrow: boolean;
  onClose: (message?: string) => void;
  onSaved: (d: Draft) => void;
}) {
  const org = orgById.get(orgId)!;
  const origin = useMemo(() => (site.ring ? centroid(site.ring) : { lat: site.lat, lng: site.lng }), [site]);
  const originalArea = site.ring ? areaM2(site.ring) : null;
  const [phase, setPhase] = useState<'map' | 'details'>('map');
  const [mode, setMode] = useState<'move' | 'draw'>(draft ? 'draw' : 'move');
  const [live, setLive] = useState<FootprintLive | null>(null);
  const [target, setTarget] = useState(draft ? draft.ring.length : 5);
  const [editVerts, setEditVerts] = useState(false);
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [coordError, setCoordError] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [use, setUse] = useState<Use>(draft?.use ?? 'PERMANENT');
  const [level, setLevel] = useState<'MAIN' | 'BRANCH'>(draft?.level ?? 'BRANCH');
  const [start, setStart] = useState(draft?.start ?? day(14));
  const [end, setEnd] = useState(draft?.end ?? day(104));
  const [name, setName] = useState(draft?.name ?? '');
  const [reason, setReason] = useState(draft?.reason ?? '');
  const [formError, setFormError] = useState('');
  const editorRef = useRef<FootprintEditor | null>(null);
  const movedRef = useRef(!!draft);
  const pausedRef = useRef(false);
  pausedRef.current = phase !== 'map';
  const distRef = useRef<HTMLElement>(null);
  const declutterRef = useRef<() => void>(() => undefined);
  const setSheet = useContext(SheetContext);
  const symbolUrl = symbols.get(orgId);

  const busy = useMemo(() => SITES.filter((s) => s.status === 'BUSY' && s.ring && s.id !== site.id).map((s) => ({ name: s.name, rings: [s.ring!] })), [site.id]);

  // the polygon engine, as in the application
  useEffect(() => {
    if (!map) return;
    const startAt = origin;
    const ed = new FootprintEditor(map, {
      origin,
      symbolHtml: proposalSymbol(symbolUrl),
      range: () => (movedRef.current ? RANGE : null),
      busy: () => busy,
      paused: () => pausedRef.current,
      onLive: (l, final) => {
        if (distRef.current) distRef.current.textContent = l.anchor && movedRef.current ? formatMeters(l.dist) : '—';
        if (!final) return;
        if (!movedRef.current && (l.mode === 'draw' ? l.closed : !!l.anchor && distanceM(l.anchor, startAt) > 3)) {
          movedRef.current = true;
          ed.refresh(); // the range applies from now on
          return;
        }
        setLive(l);
      },
    });
    editorRef.current = ed;
    if (draft) ed.startDraw(draft.ring.length, draft.ring);
    else ed.startMove(site.ring, origin);
    // a reopened draft is shown at a size where its vertices separate; otherwise, on tablets and phones, the lowered
    // sheet covers the bottom of the map: the proposal moves above it
    const lift = draft ? window.setTimeout(() => focusProposal(draft.ring), 520) : narrow ? window.setTimeout(() => map.panBy([0, 90]), 520) : 0;
    return () => {
      window.clearTimeout(lift);
      ed.destroy();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map]);

  // symbols are rendered once the page has loaded: a draft reopened from its address may start before its symbol exists
  const shownSymbol = useRef(symbolUrl);
  useEffect(() => {
    if (!editorRef.current || shownSymbol.current === symbolUrl) return;
    shownSymbol.current = symbolUrl;
    editorRef.current.setSymbol(proposalSymbol(symbolUrl));
  }, [symbolUrl]);

  // the registered site (blue, never changes), the allowed distance as two labelled rings, occupied sites in red
  useEffect(() => {
    if (!map) return;
    const g = L.layerGroup().addTo(map);
    const outer = circle(origin, RANGE.max);
    const inner = circle(origin, RANGE.min);
    L.polygon([outer, inner], { interactive: false, stroke: false, fillColor: '#21886b', fillOpacity: 0.06 }).addTo(g);
    L.polygon(inner, { interactive: false, color: '#c5625f', weight: 1.6, dashArray: '6 6', fill: false }).addTo(g);
    L.polygon(outer, { interactive: false, color: '#21886b', weight: 1.6, dashArray: '6 6', fill: false }).addTo(g);
    // every tag has spots to try in order; one that collides everywhere shrinks (occupied sites) or hides (ring names)
    const tags: Tag[] = [];
    const tag = (spots: Spot[], html: string, fallback: Tag['fallback'], zIndexOffset = 0) =>
      tags.push({ marker: L.marker(spots[0].at, { interactive: false, keyboard: false, zIndexOffset, icon: L.divIcon({ className: 'ux-pin-icon', html, iconSize: [0, 0] }) }).addTo(g), spots, fallback });
    const quarters = (ring: L.LatLngExpression[]): Spot[] => [0, 0.25, 0.5, 0.75].map((f) => ({ at: ring[Math.floor(ring.length * f)], cls: '' }));
    if (site.ring) {
      L.polygon(site.ring.map((p) => [p.lat, p.lng] as L.LatLngTuple), { interactive: false, className: 'ux-orig' }).addTo(g);
      const x = extremes(site.ring);
      tag([{ at: x.n, cls: '' }, { at: x.s, cls: 'below' }, { at: x.e, cls: 'east' }, { at: x.w, cls: 'west' }], '<span class="ux-orig-tag">المعتمد · ' + esc(site.name) + '</span>', 'hidden', 600);
    } else L.circleMarker([site.lat, site.lng], { radius: 7, weight: 3, color: '#2f6db0', fillColor: '#fff', fillOpacity: 1, interactive: false }).addTo(g);
    tag(quarters(inner), '<span class="ux-ring-tag min">أقرب مسافة مسموحة ' + formatKm(RANGE.min) + '</span>', 'hidden');
    tag(quarters(outer), '<span class="ux-ring-tag max">أبعد مسافة مسموحة ' + formatKm(RANGE.max) + '</span>', 'hidden');
    for (const s of SITES) {
      if (s.id === site.id) continue;
      if (s.status === 'BUSY' && s.ring) {
        L.polygon(s.ring.map((p) => [p.lat, p.lng] as L.LatLngTuple), { interactive: false, className: 'ux-busy' }).addTo(g);
        const x = extremes(s.ring);
        tag([{ at: [s.lat, s.lng], cls: '' }, { at: x.n, cls: 'above' }, { at: x.s, cls: 'below' }], '<span class="ux-busy-tag" title="محجوز">⊘<b> محجوز</b></span>', 'compact');
      } else
        L.circleMarker([s.lat, s.lng], { radius: 4, weight: 1, color: '#8a999d', fillColor: '#fff', fillOpacity: 1, interactive: false }).addTo(g);
    }
    declutterRef.current = () => {
      const box = (e: Element) => e.getBoundingClientRect();
      const hit = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      // the engine's proposal symbol, distance badge and edge lengths stay where the engine puts them; a tag behind the
      // editor panel, the toolbar, the map controls or the sheet counts as covered
      const panels = map.getContainer().closest('.ux')?.querySelectorAll('.ux-overlay') ?? [];
      const placed = [...map.getContainer().querySelectorAll('.stw-prop-sym, .stw-dist span, .stw-edge'), ...panels].map(box).filter((r) => r.width > 0);
      for (const t of tags) {
        const el = t.marker.getElement()?.firstElementChild as HTMLElement | null | undefined;
        if (!el) continue;
        el.classList.remove('compact', 'hidden');
        const spot = t.spots.find((s) => {
          t.marker.setLatLng(s.at);
          el.dataset.at = s.cls;
          const r = box(el);
          return !placed.some((p) => hit(p, r));
        });
        if (!spot) {
          t.marker.setLatLng(t.spots[0].at);
          el.dataset.at = t.spots[0].cls;
          el.classList.add(t.fallback);
        }
        if (spot || t.fallback === 'compact') placed.push(box(el));
      }
    };
    const run = () => declutterRef.current();
    map.on('zoomend moveend', run);
    const first = window.setTimeout(run, 600);
    return () => {
      window.clearTimeout(first);
      map.off('zoomend moveend', run);
      declutterRef.current = () => undefined;
      g.remove();
    };
  }, [map, site, origin]);
  // after each finished move or edit the tags make room for the proposal again
  useEffect(() => declutterRef.current(), [live]);
  // the engine draws a "0 m" distance badge under the untouched copy; it means nothing before the first move
  const moved = movedRef.current;
  useEffect(() => {
    const el = map?.getContainer();
    el?.classList.toggle('ux-unmoved', !moved);
    return () => el?.classList.remove('ux-unmoved');
  }, [map, moved]);

  // undo / redo from the keyboard on the map step
  useEffect(() => {
    if (phase !== 'map') return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 'z' && !e.shiftKey) (e.preventDefault(), editorRef.current?.undo());
      else if ((e.ctrlKey || e.metaKey) && (k === 'y' || (k === 'z' && e.shiftKey))) (e.preventDefault(), editorRef.current?.redo());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase]);

  const ed = editorRef.current;
  const ring = live?.ring ?? null;
  const area = ring ? areaM2(ring) : null;
  const inRange = !!live && live.inRange;
  const valid = moved && !!live?.anchor && inRange && live.kinks === 0 && live.overlaps.length === 0 && (mode === 'move' || !!live.closed);
  const distanceText = !moved ? 'حرّك النسخة الخضراء لتبدأ القياس' : !live?.anchor ? 'ضع الرؤوس على الخريطة' : live.inRange ? 'ضمن المسموح (' + formatKm(RANGE.min) + ' – ' + formatKm(RANGE.max) + ')' : live.dist < RANGE.min ? 'أقرب من ' + formatKm(RANGE.min) : 'أبعد من ' + formatKm(RANGE.max);
  const barPos = live?.anchor && moved ? Math.min(100, (live.dist / (RANGE.max * 1.2)) * 100) : null;

  // the engine's own focus() does not know the toolbar, the editor panel or the sheet over the map: fit into what is free
  function focusProposal(ring?: Ring | null) {
    const r = ring ?? live?.ring;
    if (!map || !r?.length) return void editorRef.current?.focus();
    const box = map.getContainer().getBoundingClientRect();
    const ux = map.getContainer().closest<HTMLElement>('.ux');
    const bar = ux?.querySelector('.ux-edit-tools')?.getBoundingClientRect();
    const dock = ux?.querySelector('.ux-dock:not(.sheet)')?.getBoundingClientRect();
    const sheet = ux ? parseFloat(getComputedStyle(ux).getPropertyValue('--sheet')) || 0 : 0;
    map.flyToBounds(L.latLngBounds(r.map((p) => [p.lat, p.lng] as L.LatLngTuple)), {
      paddingTopLeft: [dock ? dock.right - box.left + 24 : 24, bar ? bar.bottom - box.top + 16 : 24],
      paddingBottomRight: [24, sheet + 24],
      maxZoom: 17,
      duration: 0.4,
    });
  }

  const switchMode = (m: 'move' | 'draw') => {
    if (!ed || m === mode) return;
    setSheet('peek'); // the map is where the next step happens
    setMode(m);
    setEditVerts(m === 'draw');
    movedRef.current = false;
    if (m === 'move') ed.startMove(site.ring, origin);
    else ed.startDraw(target);
  };

  const addVertex = () => {
    const r = parseCoordinates(lat, lng);
    if (!r.point) return setCoordError(r.error);
    setCoordError('');
    ed?.addVertex(r.point);
    setLat('');
    setLng('');
  };

  const save = (submit: boolean) => {
    if (name.trim().length < 2) return setFormError('اكتب اسماً للموقع المقترح.');
    if (submit && reason.trim().length < 10) return setFormError('اكتب مبرر الطلب (10 أحرف على الأقل).');
    if (!ring) return setFormError('حدد الحدود المقترحة على الخريطة.');
    setFormError('');
    if (submit) return onClose('نموذج أولي: لا يُرسل شيء إلى الخادم. في الصفحة الفعلية يُرسل الطلب للاعتماد ولا يتغير الموقع المعتمد.');
    const d: Draft = { id: draft?.id ?? Math.random().toString(36).slice(2, 10), siteId: site.id, orgId, ring, use, level, start, end, name: name.trim(), reason: reason.trim(), savedAt: new Date().toISOString() };
    storeDraft(d);
    onSaved(d);
  };

  const tools =
    phase === 'map' && ed
      ? createPortal(
          <div className="ux-edit-tools ux-overlay" role="toolbar" aria-label="أدوات المقترح">
            <button onClick={() => ed.undo()} disabled={!live?.canUndo} aria-label="تراجع" title="تراجع (Ctrl+Z)">
              ↶ <span>تراجع</span>
            </button>
            <button onClick={() => ed.redo()} disabled={!live?.canRedo} aria-label="إعادة" title="إعادة (Ctrl+Y)">
              ↷ <span>إعادة</span>
            </button>
            <button onClick={() => ed.reset()} aria-label="العودة إلى البداية" title="العودة إلى البداية">
              ⟲ <span>البداية</span>
            </button>
            {mode === 'move' && (
              <button
                className={editVerts ? 'on' : ''}
                aria-pressed={editVerts}
                aria-label="تعديل الزوايا"
                title="تعديل الزوايا"
                onClick={() => {
                  ed.setEditVertices(!editVerts);
                  setEditVerts(!editVerts);
                }}
              >
                ✎ <span>تعديل الزوايا</span>
              </button>
            )}
            <button onClick={() => ed.compare(site.ring)} aria-label="مقارنة الموقعين" title="عرض الموقعين معاً">
              ⇆ <span>مقارنة</span>
            </button>
            <button onClick={() => focusProposal()} aria-label="التكبير على المقترح" title="التكبير على المقترح">
              ◎ <span>المقترح</span>
            </button>
          </div>,
          document.querySelector('.ux')!,
        )
      : null;

  return (
    <section className="ux-card ux-editor" aria-label={'طلب تمركز ' + org.name}>
      {tools}
      {/* on a phone or tablet the head stays at the top of the sheet: the live status replaces the steps there */}
      <header className="ux-card-head">
        {narrow && phase === 'map' ? (
          <p className={'ux-compact ' + (!moved ? 'idle' : valid ? 'ok' : 'bad')} role="status">
            <b>{live?.anchor && moved ? formatMeters(live.dist) : '—'}</b> {distanceText}
            {area != null && originalArea ? ' · ' + pct((area - originalArea) / originalArea) : ''}
          </p>
        ) : (
          <span className="ux-steps" aria-label="خطوات الطلب">
            <b className={phase === 'map' ? 'on' : 'done'}>١ الموقع على الخريطة</b>
            <b className={phase === 'details' ? 'on' : ''}>٢ التفاصيل</b>
          </span>
        )}
        <button className="ux-x" onClick={() => setConfirmCancel(true)} aria-label="إلغاء المقترح">
          ✕
        </button>
      </header>
      <h2 className="ux-with-sym">
        <SymbolMark url={symbolUrl} name={org.name} size={24} /> تمركز «{org.name}»
      </h2>
      <p className="ux-sub">من «{site.name}» · لا يتغير الموقع المعتمد قبل الاعتماد</p>

      {confirmCancel && (
        <div className="ux-confirm" role="alertdialog" aria-label="تأكيد الإلغاء">
          <p>إلغاء المقترح؟ لا يُحفظ شيء ولا يتغير أي موقع.</p>
          <div className="ux-actions">
            <button className="ux-btn danger" onClick={() => onClose()}>
              نعم، إلغاء
            </button>
            <button className="ux-btn" onClick={() => setConfirmCancel(false)} autoFocus>
              متابعة التعديل
            </button>
          </div>
        </div>
      )}

      {phase === 'map' ? (
        <>
          <div className="ux-seg" role="tablist" aria-label="طريقة تحديد الموقع">
            <button role="tab" aria-selected={mode === 'move'} className={mode === 'move' ? 'on' : ''} onClick={() => switchMode('move')}>
              نقل الحدود الحالية
            </button>
            <button role="tab" aria-selected={mode === 'draw'} className={mode === 'draw' ? 'on' : ''} onClick={() => switchMode('draw')}>
              رسم حدود جديدة
            </button>
          </div>
          <p className="ux-hint">
            {mode === 'move'
              ? 'اسحب المساحة الخضراء أو رمزها إلى الموقع المقترح؛ تنتقل كاملة بشكلها ومساحتها. الحدود الزرقاء المتقطعة هي الموقع المعتمد.'
              : 'انقر على الخريطة لوضع ' + target + ' رؤوس بالترتيب، أو أدخل إحداثيات كل رأس أدناه. تُسحب الرؤوس لتعديلها.'}
          </p>

          <div className={'ux-readout ' + (!moved ? 'idle' : valid ? 'ok' : 'bad')} aria-live="polite">
            <div className="ux-dist">
              <span>المسافة من الموقع المعتمد</span>
              <b ref={distRef}>{live?.anchor && moved ? formatMeters(live.dist) : '—'}</b>
              <small>{distanceText}</small>
            </div>
            <div className="ux-bar" aria-hidden="true">
              <i className="band" style={{ insetInlineStart: (RANGE.min / (RANGE.max * 1.2)) * 100 + '%', width: ((RANGE.max - RANGE.min) / (RANGE.max * 1.2)) * 100 + '%' }} />
              {barPos != null && <i className="mark" style={{ insetInlineStart: barPos + '%' }} />}
            </div>
            <dl>
              <dt>المساحة</dt>
              <dd>{area != null ? formatArea(area) + (originalArea ? ' · ' + pct((area - originalArea) / originalArea) : '') : mode === 'draw' ? (live?.vertices ?? 0) + ' / ' + target + ' رؤوس' : '—'}</dd>
              <dt>الشكل</dt>
              <dd className={live?.kinks ? 'n' : ''}>{!ring ? 'لم يكتمل' : live?.kinks ? 'أضلاع متقاطعة' : 'صالح'}</dd>
              <dt>الإشغال</dt>
              <dd className={live?.overlaps.length ? 'n' : ''}>{live?.overlaps.length ? 'يتداخل مع: ' + live.overlaps.join('، ') : 'لا تداخل مع مواقع محجوزة'}</dd>
            </dl>
          </div>

          <ul className="ux-key" aria-label="مفتاح المقترح">
            <li>
              <i className="k-orig" /> المعتمد (لا يتغير)
            </li>
            <li>
              <i className="k-prop" /> المقترح
            </li>
            <li>
              <i className="k-ring" /> حدود المسافة المسموحة
            </li>
            <li>
              <i className="k-busy" /> موقع محجوز
            </li>
          </ul>

          {mode === 'draw' && (
            <>
              <label className="ux-field inline">
                عدد الرؤوس
                <input
                  type="number"
                  min={3}
                  max={20}
                  value={target}
                  aria-label="عدد الرؤوس"
                  onChange={(e) => {
                    const n = Math.max(3, Math.min(20, Number(e.target.value) || 3));
                    setTarget(n);
                    ed?.setTarget(n);
                  }}
                />
              </label>
              <details className="ux-more">
                <summary>إدخال رأس بالإحداثيات</summary>
                <div className="ux-coords">
                  <input value={lat} onChange={(e) => setLat(e.target.value)} placeholder="خط العرض" aria-label="خط عرض الرأس" inputMode="decimal" />
                  <input value={lng} onChange={(e) => setLng(e.target.value)} placeholder="خط الطول" aria-label="خط طول الرأس" inputMode="decimal" />
                  <button className="ux-btn" onClick={addVertex} disabled={!!live?.closed}>
                    إضافة رأس
                  </button>
                </div>
                {coordError && <p className="ux-error">{coordError}</p>}
              </details>
            </>
          )}
          {(mode === 'draw' || editVerts) && ring && (
            <details className="ux-more">
              <summary>أطوال الأضلاع ({ring.length})</summary>
              <ol className="ux-edges">
                {edgeLengths(ring).map((m, i) => (
                  <li key={i}>
                    {i + 1}→{((i + 1) % ring.length) + 1}: {formatMeters(m)}
                  </li>
                ))}
              </ol>
            </details>
          )}
          <p className="ux-note">نموذج أولي: التحقق هنا محلي؛ الصفحة الفعلية تتحقق من الخادم بعد كل إفلات.</p>
          <div className="ux-actions sticky">
            <button
              className="ux-btn primary"
              disabled={!valid}
              onClick={() => {
                setSheet('full');
                setPhase('details');
              }}
            >
              التالي: التفاصيل
            </button>
          </div>
        </>
      ) : (
        <div className="ux-details">
          <dl className="ux-summary">
            <dt>المسافة</dt>
            <dd>{live ? formatMeters(live.dist) : '—'}</dd>
            <dt>المساحة</dt>
            <dd>{area != null ? formatArea(area) : '—'}</dd>
          </dl>
          <fieldset className="ux-chipset">
            <legend>نوع التمركز</legend>
            {(
              [
                ['PERMANENT', 'مقر دائم'],
                ['TEMPORARY', 'مقر مؤقت'],
                ['WORK_AREA', 'منطقة عمل مؤقتة'],
              ] as [Use, string][]
            ).map(([v, l]) => (
              <button key={v} className={'ux-chip ' + (use === v ? 'on' : '')} aria-pressed={use === v} onClick={() => setUse(v)}>
                {l}
              </button>
            ))}
          </fieldset>
          {use !== 'WORK_AREA' && (
            <fieldset className="ux-chipset">
              <legend>المستوى</legend>
              <button className={'ux-chip ' + (level === 'MAIN' ? 'on' : '')} aria-pressed={level === 'MAIN'} onClick={() => setLevel('MAIN')}>
                مقر رئيسي
              </button>
              <button className={'ux-chip ' + (level === 'BRANCH' ? 'on' : '')} aria-pressed={level === 'BRANCH'} onClick={() => setLevel('BRANCH')}>
                مقر فرعي
              </button>
            </fieldset>
          )}
          <div className="ux-dates">
            <label className="ux-field">
              {use === 'PERMANENT' ? 'تاريخ التفعيل المطلوب' : 'من'}
              <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
            </label>
            {use !== 'PERMANENT' && (
              <label className="ux-field">
                إلى
                <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
              </label>
            )}
          </div>
          <label className="ux-field">
            اسم الموقع المقترح
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="مثال: المبنى الإداري الجديد" />
          </label>
          <label className="ux-field">
            مبرر الطلب
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="لماذا يلزم هذا التمركز؟" rows={3} />
          </label>
          {formError && <p className="ux-error">{formError}</p>}
          <div className="ux-actions sticky">
            <button className="ux-btn primary" onClick={() => save(false)}>
              حفظ كمسودة
            </button>
            <button className="ux-btn" onClick={() => save(true)}>
              إرسال للاعتماد
            </button>
            <button
              className="ux-link"
              onClick={() => {
                setSheet('peek');
                setPhase('map');
              }}
            >
              → العودة إلى الخريطة
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
