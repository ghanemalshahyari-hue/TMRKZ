import { useEffect, useMemo, useRef, useState } from 'react';
import type { Map as MlMap, MapMouseEvent } from 'maplibre-gl';
import { api } from '../api/client';
import type { GeoPolygon, RestationingChecks, RestationingContent, RestationingRequest, RestationingUnit, SiteGeometry } from '../api/types';
import { SiteEditor, type SiteLive } from '../components/map/maplibre';
import { useApp } from '../lib/app';
import { formatArea } from '../lib/footprint';
import { DRAW_NEW_BOUNDARY, copyableBoundary } from '../lib/stationingV3';
import { RequestMap } from './RestationingPage';

type Placing = 'site' | 'primary' | 'alternative' | null;

const square = (lng: number, lat: number, halfM: number): GeoPolygon => {
  const dLat = halfM / 110_900;
  const dLng = halfM / (111_320 * Math.cos((lat * Math.PI) / 180));
  return {
    type: 'Polygon',
    coordinates: [[[lng - dLng, lat - dLat], [lng + dLng, lat - dLat], [lng + dLng, lat + dLat], [lng - dLng, lat + dLat], [lng - dLng, lat - dLat]]],
  };
};
const centreOf = (p: GeoPolygon) => {
  const ring = p.coordinates[0].slice(0, -1);
  return { lng: ring.reduce((a, q) => a + q[0], 0) / ring.length, lat: ring.reduce((a, q) => a + q[1], 0) / ring.length };
};
/** A deployment area moved so its centre sits at (lng, lat), keeping its shape (the site itself is dragged in SiteEditor). */
const moveTo = (p: GeoPolygon, lng: number, lat: number): GeoPolygon => {
  const c = centreOf(p);
  return { type: 'Polygon', coordinates: [p.coordinates[0].map(([x, y]) => [x + lng - c.lng, y + lat - c.lat])] };
};
const isoDay = (s?: string | null) => (s ? s.slice(0, 10) : '');
const dayStart = (d: string) => (d ? new Date(d + 'T00:00:00+04:00').toISOString() : null);

/**
 * Create or edit a re-stationing request: the requesting unit, the units that move (explicit — followers never move
 * on their own), permanent or temporary, ONE proposed site (a copy of the current boundary moved on the map, or a new
 * shape), the deployment areas, and the reason. Every check is the server's (saved draft → «الفحوص»).
 */
export function RestationingEditor({ requestId, onClose }: { requestId: string | null; onClose: (id?: string) => void }) {
  const app = useApp();
  const [id, setId] = useState<string | null>(requestId);
  const [loaded, setLoaded] = useState<RestationingRequest | null>(null);
  const [unit, setUnit] = useState<string>('');
  const [content, setContent] = useState<RestationingContent>({ kind: 'PERMANENT', scope: [], site: null, primary: null, alternative: null, reason: '', exceptions: {}, occupants: {} });
  const [placing, setPlacing] = useState<Placing>(null);
  const [checks, setChecks] = useState<RestationingChecks | null>(null);
  const [busy, setBusy] = useState(false);
  const placingRef = useRef<Placing>(null);
  placingRef.current = placing;
  const clickRef = useRef<(e: MapMouseEvent) => void>(() => undefined);
  // the proposed site is edited on the map by SiteEditor: one grouped move, or (advanced) one vertex of one part
  const editorRef = useRef<SiteEditor | null>(null);
  const liveListeners = useRef(new Set<(l: SiteLive) => void>());
  const [siteMode, setSiteMode] = useState<'move' | 'vertices'>('move');
  const [siteOk, setSiteOk] = useState(true);
  const contentRef = useRef(content);
  contentRef.current = content;
  const checksRef = useRef(checks);
  checksRef.current = checks;
  // only the units where the actor may request (the server's own list): no general view of the organisation needed
  const [units, setUnits] = useState<RestationingUnit[]>([]);
  useEffect(() => {
    api.restationingUnits().then(setUnits).catch(() => setUnits([]));
  }, []);

  useEffect(() => {
    if (!requestId) return;
    api.restationingRequest(requestId).then((r) => {
      setLoaded(r);
      setUnit(r.requestingUnit.id);
      setContent({ ...r.content, exceptions: r.content.exceptions ?? {}, occupants: r.content.occupants ?? {} });
      // a reopened draft is a new editing session from the saved geometry
      editorRef.current?.load(r.content.site?.geometry ?? null);
    });
    api.restationingChecks(requestId).then(setChecks);
  }, [requestId]);

  const branch = useMemo(() => {
    const i = units.findIndex((o) => o.id === unit);
    if (i < 0) return [] as RestationingUnit[];
    const out = [units[i]];
    for (let j = i + 1; j < units.length && units[j].depth > units[i].depth; j++) out.push(units[j]);
    return out;
  }, [units, unit]);

  const set = (patch: Partial<RestationingContent>) => setContent((c) => ({ ...c, ...patch }));

  /** A new site editing session: the copy, a drawn shape, or nothing (redraw chosen). Undo/redo/reset start here. */
  const loadSite = (geometry: SiteGeometry | null, copiedFrom: string | null, shape: 'COPY' | 'DRAWN') => {
    setContent((c) => ({ ...c, site: geometry ? { geometry, copiedFrom, shape } : null }));
    setSiteMode('move');
    editorRef.current?.setMode('move');
    editorRef.current?.load(geometry);
  };

  /** A committed change on the map (drop of a drag, undo, redo, reset): the content follows; a moved copy stays COPY. */
  const onSite = (live: SiteLive, final: boolean) => {
    liveListeners.current.forEach((l) => l(live));
    if (!final) return;
    setSiteOk(live.geometry == null || live.ok);
    setContent((c) => {
      if (!live.geometry) return c.site ? { ...c, site: null } : c;
      const shape = c.site?.shape === 'COPY' && live.vertexEdited ? 'EDITED' : (c.site?.shape ?? 'DRAWN');
      return { ...c, site: { geometry: live.geometry, copiedFrom: c.site?.copiedFrom ?? null, shape } };
    });
  };

  const onMap = (m: MlMap) => {
    m.on('click', (e) => clickRef.current(e));
    editorRef.current = new SiteEditor(m, { onChange: (l, f) => onSiteRef.current(l, f), maxAreaM2: () => checksRef.current?.maxFootprintAreaM2 ?? null });
    editorRef.current.load(contentRef.current.site?.geometry ?? null);
  };
  const onSiteRef = useRef(onSite);
  onSiteRef.current = onSite;
  useEffect(() => () => editorRef.current?.destroy(), []);
  // the server's maximum footprint arrives with the checks: validate the site against it
  useEffect(() => {
    editorRef.current?.refresh();
  }, [checks?.maxFootprintAreaM2]);
  const toggle = (org: string) => set({ scope: content.scope.includes(org) ? content.scope.filter((x) => x !== org) : [...content.scope, org] });

  const save = async (): Promise<string | null> => {
    if (!unit) {
      app.toast('اختر الوحدة الطالبة');
      return null;
    }
    setBusy(true);
    try {
      const r = id ? await api.editRestationing(id, content) : await api.createRestationing(unit, content);
      setId(r.id);
      setLoaded(r);
      setChecks(await api.restationingChecks(r.id));
      return r.id;
    } catch (e) {
      app.toast((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    const saved = await save();
    if (!saved) return;
    setBusy(true);
    try {
      await api.submitRestationing(saved);
      app.toast('أُرسل الطلب للاعتماد');
      onClose(saved);
    } catch (e) {
      app.toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onMapClick = (e: MapMouseEvent) => {
    const p = placingRef.current;
    if (!p) return;
    const { lng, lat } = e.lngLat;
    if (p === 'site') {
      // «رسم حدود جديدة»: a new shape where the requester clicks, then dragged or edited like a copy
      loadSite(square(lng, lat, 150), null, 'DRAWN');
      setPlacing(null);
      app.toast('رُسمت حدود جديدة — اسحبها لنقلها أو عدّل رؤوسها من «تعديل الحدود»');
      return;
    }
    setContent((c) => {
      const g = c[p] ? moveTo(c[p]!, lng, lat) : square(lng, lat, 280);
      return { ...c, [p]: g };
    });
  };

  clickRef.current = onMapClick;

  const copyCurrent = async () => {
    if (content.scope.length === 0) return app.toast('اختر الوحدات المنتقلة أولاً');
    let r = loaded;
    if (!r || r.currentSites.length === 0 || r.content.scope.join() !== content.scope.join()) {
      // the server knows where the chosen units are stationed now: save the draft, then read it back
      const saved = await save();
      if (!saved) return;
      r = await api.restationingRequest(saved);
      setLoaded(r);
    }
    const { copy: cur, message } = copyableBoundary(r.currentSites);
    if (!cur) return app.toast(message);
    loadSite(cur.geometry as SiteGeometry, cur.site.id, 'COPY');
    setPlacing(null);
    app.toast(message);
  };

  /** The requester's explicit choice to draw instead of the copy: never taken silently. */
  const redraw = () => {
    if (content.site && !window.confirm('ستُستبدل حدود الموقع المقترح الحالية برسم جديد. متابعة؟')) return;
    if (content.site) loadSite(null, null, 'DRAWN');
    setPlacing('site');
    app.toast(content.site ? 'أُلغيت الحدود السابقة بطلبك — انقر على الخريطة لرسم الحدود الجديدة' : 'انقر على الخريطة لرسم الحدود الجديدة');
  };

  const preview: RestationingRequest = {
    ...(loaded ?? {
      id: 'new', number: 'جديد', state: 'DRAFT', requestingUnit: { id: unit, name: '' }, requester: { id: '', name: '' }, units: [], currentSites: [],
      policyVersion: null, routeNo: 0, route: [], previousRoutes: [], revisions: [], returned: null, paused: null, finalApprover: null,
      can: { edit: true, submit: true, decide: false, activate: false },
    }),
    content,
  };
  const leg = (k: 'primary' | 'alternative') => checks?.legs?.find((l) => l.leg === k);

  return (
    <div className="rs-editor">
      <div className="card rs-form">
        <h2>{id ? 'تعديل ' + (loaded?.number ?? '') : 'طلب إعادة تمركز جديد'}</h2>
        <label>
          الوحدة الطالبة (المسار يبدأ منها)
          <select value={unit} disabled={!!loaded && loaded.state !== 'DRAFT'} onChange={(e) => { setUnit(e.target.value); set({ scope: [] }); }}>
            <option value="">— اختر —</option>
            {units.map((o) => (
              <option key={o.id} value={o.id}>{'  '.repeat(o.depth) + o.name}</option>
            ))}
          </select>
        </label>
        <fieldset>
          <legend>من سينتقل؟ (اختيار صريح؛ التابعون لا ينتقلون تلقائياً)</legend>
          {branch.length === 0 && <small className="muted">اختر الوحدة الطالبة أولاً.</small>}
          {branch.map((o) => (
            <label key={o.id} className="rs-check" style={{ paddingInlineStart: (o.depth - (branch[0]?.depth ?? 0)) * 16 }}>
              <input type="checkbox" checked={content.scope.includes(o.id)} onChange={() => toggle(o.id)} /> {o.name}
            </label>
          ))}
        </fieldset>
        <fieldset className="rs-inline">
          <legend>النوع</legend>
          <label><input type="radio" checked={content.kind === 'PERMANENT'} onChange={() => set({ kind: 'PERMANENT', start: null, end: null })} /> دائم</label>
          <label><input type="radio" checked={content.kind === 'TEMPORARY'} onChange={() => set({ kind: 'TEMPORARY' })} /> مؤقت</label>
          {content.kind === 'TEMPORARY' && (
            <>
              <label>من <input type="date" value={isoDay(content.start)} onChange={(e) => set({ start: dayStart(e.target.value) })} /></label>
              <label>إلى <input type="date" value={isoDay(content.end)} onChange={(e) => set({ end: dayStart(e.target.value) })} /></label>
            </>
          )}
        </fieldset>
        <fieldset>
          <legend>الموقع المقترح (موقع واحد) ومنطقتا الانتشار</legend>
          <div className="rs-tools">
            <button className="button" onClick={copyCurrent}>نسخ حدود الموقع الحالي</button>
            <button className={'button' + (placing === 'site' ? ' primary' : '')} onClick={redraw}>
              {DRAW_NEW_BOUNDARY}
            </button>
            <button className={'button' + (placing === 'primary' ? ' primary' : '')} onClick={() => setPlacing(placing === 'primary' ? null : 'primary')}>
              منطقة الانتشار الرئيسية
            </button>
            <button className={'button' + (placing === 'alternative' ? ' primary' : '')} onClick={() => setPlacing(placing === 'alternative' ? null : 'alternative')}>
              منطقة الانتشار البديلة
            </button>
          </div>
          <small className="muted">
            {placing ? 'انقر على الخريطة لوضع «' + { site: 'الموقع المقترح', primary: 'منطقة الانتشار الرئيسية', alternative: 'منطقة الانتشار البديلة' }[placing] + '»؛ النقر مجدداً ينقلها بشكلها.' : 'الموقع المقترح يُسحب على الخريطة؛ منطقتا الانتشار توضعان بالنقر. المسافة إلى الموقع الحالي للعلم فقط.'}
          </small>
          {content.site && (
            <SiteControls
              editor={editorRef}
              listeners={liveListeners}
              mode={siteMode}
              setMode={(m) => {
                setSiteMode(m);
                editorRef.current?.setMode(m);
              }}
              maxAreaM2={checks?.maxFootprintAreaM2 ?? null}
            />
          )}
          {(['primary', 'alternative'] as const).map((k) =>
            leg(k)?.status === 'NEEDS_EXCEPTION' ? (
              <label key={k}>
                سبب استثناء المسافة لـ{leg(k)?.label}
                <input value={content.exceptions?.[k] ?? ''} onChange={(e) => set({ exceptions: { ...(content.exceptions ?? {}), [k]: e.target.value } })} />
              </label>
            ) : null,
          )}
        </fieldset>
        <label>
          سبب الطلب
          <textarea value={content.reason} onChange={(e) => set({ reason: e.target.value })} />
        </label>
        <div className="rs-tools">
          <button className="button" disabled={busy} onClick={save}>حفظ المسودة والفحص</button>
          <button className="button primary" disabled={busy || !siteOk || (checks != null && !checks.ok)} onClick={submit}>إرسال للاعتماد</button>
          <button className="button" onClick={() => onClose(id ?? undefined)}>إغلاق</button>
        </div>
        {checks && (
          <div className="rs-editor-checks">
            <div className={'rs-verdict ' + (checks.ok ? 'ok' : 'no')}>{checks.ok ? 'الفحوص مستوفاة — يمكن الإرسال' : 'فحوص الخادم'}</div>
            <ul className="rs-problems">{checks.problems.map((p) => <li key={p}>{p}</li>)}</ul>
            {checks.legs?.map((l) => (
              <div key={l.leg} className={'rs-leg ' + l.status}>
                <b>{l.label}</b>: {l.distanceM != null ? (l.distanceM / 1000).toFixed(2) + ' كم' : '—'} (المسموح {(l.effectiveMinM / 1000).toFixed(1)}–{(l.effectiveMaxM / 1000).toFixed(1)} كم)
                {l.terrain && <> · الأرض: {l.terrain.controllingLabel} +{l.terrain.allowanceM} م</>}
              </div>
            ))}
            {checks.route && checks.route.length > 0 && <small className="muted">المسار: {checks.route.map((s) => s.label).join(' ← ')}</small>}
          </div>
        )}
      </div>
      <div className="card rs-map-card">
        <div className={placing ? 'rs-placing' : ''}>
          <RequestMap request={preview} checks={checks} mode="street" height={640} fitMaxZoom={11.5} hideSite fit={false} onMap={onMap} />
        </div>
      </div>
    </div>
  );
}

/**
 * The proposed site's controls and live readout: grouped move or (advanced) «تعديل الحدود», undo/redo/reset, the parts,
 * the active vertex, the area against the configured maximum and the validity — updated on every frame of a drag from
 * the editor, without re-rendering the map or the form.
 */
function SiteControls({ editor, listeners, mode, setMode, maxAreaM2 }: {
  editor: React.RefObject<SiteEditor | null>;
  listeners: React.RefObject<Set<(l: SiteLive) => void>>;
  mode: 'move' | 'vertices';
  setMode: (m: 'move' | 'vertices') => void;
  maxAreaM2: number | null;
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
  if (!live?.geometry) return null;
  const many = live.parts > 1;
  return (
    <div className="rs-site-controls">
      {many && mode === 'move' && <div className="rs-banner blue">كل أجزاء الموقع ستنتقل معاً — اسحب أي جزء ({live.parts} أجزاء)</div>}
      {mode === 'vertices' && (
        <div className="rs-banner orange">
          {many ? 'اختر جزءاً ثم اسحب رأساً من رؤوسه؛ الأجزاء الأخرى لا تتغير.' : 'اسحب رأساً من رؤوس الحدود.'} لا تُضاف رؤوس ولا تُحذف.
        </div>
      )}
      <div className="rs-tools">
        <button className={'button' + (mode === 'vertices' ? ' primary' : '')} onClick={() => setMode(mode === 'vertices' ? 'move' : 'vertices')}>
          {mode === 'vertices' ? 'إنهاء تعديل الحدود' : 'تعديل الحدود'}
        </button>
        <button className="button" disabled={!live.canUndo} onClick={() => editor.current?.undo()}>تراجع</button>
        <button className="button" disabled={!live.canRedo} onClick={() => editor.current?.redo()}>إعادة</button>
        <button className="button" onClick={() => editor.current?.reset()}>استعادة البداية</button>
      </div>
      {many && mode === 'vertices' && (
        <div className="rs-tools rs-parts">
          {live.partAreas.map((a, i) => (
            <button key={i} className={'chip' + (i === live.activePart ? ' active' : '')} onClick={() => editor.current?.selectPart(i)}>
              الجزء {i + 1} · {formatArea(a)}
            </button>
          ))}
        </div>
      )}
      <div className="rs-site-readout" data-testid="site-readout">
        <span>المساحة: {formatArea(live.areaM2)}{maxAreaM2 != null && <> من حد {formatArea(maxAreaM2)}</>}</span>
        <span>الأجزاء: {live.parts}</span>
        {mode === 'vertices' && live.activePart != null && (
          <span>
            الجزء النشط: {live.activePart + 1}
            {live.activeVertex != null && <> · الرأس {live.activeVertex + 1}</>}
          </span>
        )}
        <span className={live.ok ? 'rs-ok' : 'rs-bad'} data-testid="site-validity">{live.ok ? 'الحدود صالحة' : 'الحدود غير صالحة: ' + live.problems.join('، ')}</span>
      </div>
    </div>
  );
}
