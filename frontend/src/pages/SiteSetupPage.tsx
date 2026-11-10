import { useEffect, useMemo, useRef, useState } from 'react';
import type { GeoJSONSource, Map as MlMap, MapMouseEvent } from 'maplibre-gl';
import { Marker } from 'maplibre-gl';
import { api, type SiteOccupants } from '../api/client';
import type { RestationingRequest, SiteDetail, SiteGeometry } from '../api/types';
import { PITCH_3D, SiteEditor, addOverlayLayer, frame, installedTerrain3d, type MapView, type SiteLive } from '../components/map/maplibre';
import type { BasemapMode, Terrain3dSource } from '../components/map/maplibre/offlineStyle';
import { OrgTree } from '../components/map/BrowseTrees';
import { PointsTable } from '../components/stationing/PointsTable';
import { SiteSymbolPicker, SymbolArt } from '../components/stationing/SiteSymbolPicker';
import { Icon } from '../components/ui';
import { MapFrame, MapLegend } from '../components/workspace/MapFrame';
import { OperationalWorkspace } from '../components/workspace/OperationalWorkspace';
import { RequestMap } from '../components/workspace/RequestMap';
import { useRegisteredSites } from '../components/workspace/useRegisteredSites';
import { useApp } from '../lib/app';
import { formatIn, type FormatKey } from '../lib/coordFormats';
import { formatArea } from '../lib/footprint';
import { anchorOf, partsOf, siteArea } from '../lib/siteGeometry';
import { symbolEntry } from '../lib/siteSymbols';
import { MAIN_KINDS, cornersOf, outlineOf, rowsOf, shapeText, stepProblem, type PointRow, type Step } from '../lib/siteWizard';

const EMPTY_MAP = {
  id: 'setup', number: '', state: 'DRAFT', requestingUnit: { id: '', name: '' }, requester: { id: '', name: '' }, units: [], currentSites: [],
  content: { kind: 'PERMANENT', scope: [], site: null, primary: null, alternative: null, reason: '', exceptions: {}, occupants: {} },
  policyVersion: null, routeNo: 0, route: [], previousRoutes: [], revisions: [], returned: null, paused: null, finalApprover: null,
  can: { edit: false, submit: false, decide: false, activate: false },
} as unknown as RestationingRequest;

type Form = { name: string; code: string; kind: string; parentId: string; notes: string; reason: string; ownerId?: string };
const BLANK: Form = { name: '', code: '', kind: 'موقع', parentId: '', notes: '', reason: '' };
// «موقع جديد» as in MOVER's «المواقع» drawer (owner, 10 Nov 2026: «do the same as we did there»; MOVER owner 1 Nov 2026: simple
// enough for a child): one question per card, three steps — the data, the shape, review and save. «معسكر» by default, as there.
const NEW_SITE: Form = { ...BLANK, kind: 'معسكر', ownerId: '' };
const STEPS = ['البيانات', 'الرسم', 'الحفظ'];

/**
 * «تهيئة المواقع والتمركز»: the controlled setup of an empty installation, not a daily request (ADR-045). Each step asks a written
 * reason and is audited by the server, which also checks the right behind it: registering a site and its shape, its parent
 * site, the links of units to it (a link is not stationing) and an audited correction of authoritative stationing. It never
 * changes Oracle's hierarchy: one physical site is one object, however many units use it.
 */
export function SiteSetupPage() {
  const app = useApp();
  const registered = useRegisteredSites();
  const canSites = app.can('MANAGE_FACILITIES');
  const canLinks = app.can('MANAGE_SITE_LINKS');
  const canCorrect = app.can('CORRECT_STATIONING');
  const [mode, setMode] = useState<BasemapMode>('street');
  const [view, setView] = useState<MapView>('2d');
  const [terrain3d, setTerrain3d] = useState<Terrain3dSource | null | undefined>(undefined);
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<Form>(BLANK);
  const [shape, setShape] = useState<'POLYGON' | 'POINT'>('POLYGON');
  const [point, setPoint] = useState<{ lat: number; lng: number } | null>(null);
  const [geometry, setGeometry] = useState<SiteGeometry | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [occ, setOcc] = useState<SiteOccupants | null>(null);
  const [linkOrg, setLinkOrg] = useState('');
  const [linkReason, setLinkReason] = useState('');
  const [stOrg, setStOrg] = useState('');
  const [stReason, setStReason] = useState('');
  const [q, setQ] = useState('');
  const [detail, setDetail] = useState<SiteDetail | null>(null);
  const [edit, setEdit] = useState<Form>(BLANK);
  const [editingShape, setEditingShape] = useState(false);
  const [vertexMode, setVertexMode] = useState(false);
  // the «موقع جديد» wizard
  const [step, setStep] = useState<Step>(1);
  const [inside, setInside] = useState(false);
  const [otherKind, setOtherKind] = useState(false);
  const [parentQ, setParentQ] = useState('');
  const [owner, setOwner] = useState<{ id: string; name: string } | null>(null);
  const [ownerOpen, setOwnerOpen] = useState(false);
  const [wizErr, setWizErr] = useState('');
  const [made, setMade] = useState<{ id: string; name: string; code: string } | null>(null);
  // «جدول الإحداثيات»: shown on «اكتب الإحداثيات»; it follows the map and the map follows it
  const [typing, setTyping] = useState(false);
  const [rows, setRows] = useState<PointRow[]>([]);
  const [fmt, setFmt] = useState<FormatKey>('');
  const [pickRow, setPickRow] = useState<number | null>(null);
  const [drawInfo, setDrawInfo] = useState<{ count: number; canFinish: boolean } | null>(null);
  const [railQ, setRailQ] = useState('');
  const [folded, setFolded] = useState<Set<string>>(new Set());
  // the site's map symbol (V32): chosen in «موقع جديد», changed later from the site's card with a reason
  const [symbol, setSymbol] = useState<string | null>(null);
  const [symEdit, setSymEdit] = useState<string | null | undefined>(undefined);
  const [symReason, setSymReason] = useState('');
  const [fromCoords, setFromCoords] = useState(false);
  const mapRef = useRef<MlMap | null>(null);
  const editor = useRef<SiteEditor | null>(null);
  const marker = useRef<Marker | null>(null);
  const parts = useRef<SiteGeometry | null>(null);
  const placingRef = useRef(false);
  placingRef.current = placing;
  // the row a map click sets, and whether the latest shape came from the table (then the table is not rewritten from it)
  const pickRef = useRef<((p: { lat: number; lng: number }) => void) | null>(null);
  const fromTable = useRef(false);
  useEffect(() => {
    installedTerrain3d().then(setTerrain3d);
    return () => {
      editor.current?.destroy();
      marker.current?.remove();
    };
  }, []);
  // 3D looks from the side, 2D from above — also on an empty installation, where there is no site to frame (as on «الموقف»)
  useEffect(() => {
    mapRef.current?.easeTo({ pitch: view === '3d' ? PITCH_3D : 0, duration: 500 });
  }, [view]);
  const onMap = (m: MlMap) => {
    mapRef.current = m;
    m.addSource('setup-earlier', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    addOverlayLayer(m, { id: 'setup-earlier-fill', type: 'fill', source: 'setup-earlier', paint: { 'fill-color': '#2f9e6e', 'fill-opacity': 0.25 } }, 'top');
    addOverlayLayer(m, { id: 'setup-earlier-line', type: 'line', source: 'setup-earlier', paint: { 'line-color': '#2f9e6e', 'line-width': 2, 'line-dasharray': [2, 1.6] } }, 'top');
    editor.current = new SiteEditor(m, {
      onChange: (l: SiteLive, final: boolean) => {
        setDrawing(l.mode === 'draw');
        setDrawInfo(l.draw ? { count: l.draw.count, canFinish: l.draw.canFinish } : null);
        if (final) setGeometry(l.geometry ?? null);
      },
      maxAreaM2: () => null,
    });
    m.on('click', (e: MapMouseEvent) => {
      if (pickRef.current) {
        const take = pickRef.current;
        pickRef.current = null;
        take({ lat: e.lngLat.lat, lng: e.lngLat.lng });
        return;
      }
      if (!placingRef.current) return;
      setPlacing(false);
      setPoint({ lat: e.lngLat.lat, lng: e.lngLat.lng });
      marker.current?.remove();
      marker.current = new Marker({ color: '#d9822b' }).setLngLat(e.lngLat).addTo(m);
    });
  };
  const reload = () => {
    if (selected) api.siteOccupants(selected).then(setOcc).catch(() => setOcc(null));
  };
  useEffect(() => {
    setOcc(null);
    reload();
    setDetail(null);
    if (selected) {
      api.site(selected).then((d) => {
        setDetail(d);
        setEdit({ name: d.name, code: d.code, kind: d.kind, parentId: d.parentId ?? '', notes: '', reason: '' });
      }).catch(() => setDetail(null));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, app.revision]);
  useEffect(() => setSymEdit(undefined), [selected]);
  useEffect(() => {
    if (editingShape) {
      setEditingShape(false);
      editor.current?.load(null, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);
  /** The registered boundary in the map editor, its parts moving as one; the register changes only when it is saved with a reason. */
  const startShape = () => {
    const g = detail?.geometry?.geojson as unknown as SiteGeometry | undefined;
    setEditingShape(true);
    setVertexMode(false);
    editor.current?.setMode('move');
    setGeometry(g && (g.type === 'Polygon' || g.type === 'MultiPolygon') ? g : null);
    editor.current?.load(g && (g.type === 'Polygon' || g.type === 'MultiPolygon') ? g : null, true);
    if (!g || !(g.type === 'Polygon' || g.type === 'MultiPolygon')) editor.current?.startDrawing(null, 0);
  };
  const sites = useMemo(() => registered.sites.filter((s) => s.view !== 'CONTEXT'), [registered.sites]);
  const byParent = useMemo(() => {
    const m = new Map<string, typeof sites>();
    for (const s of sites) m.set(s.parentId ?? '', [...(m.get(s.parentId ?? '') ?? []), s]);
    return m;
  }, [sites]);
  const site = sites.find((s) => s.siteId === selected) ?? null;
  const orgs = useMemo(() => app.orgs.filter((o) => !q.trim() || o.name.includes(q.trim())).slice(0, 200), [app.orgs, q]);
  const startAdd = () => {
    setAdding(true);
    setSelected(null);
    setForm(NEW_SITE);
    setShape('POLYGON');
    setGeometry(null);
    setPoint(null);
    setPlacing(false);
    setStep(1);
    setInside(false);
    setOtherKind(false);
    setParentQ('');
    setOwner(null);
    setOwnerOpen(false);
    setWizErr('');
    setMade(null);
    setTyping(false);
    setRows([]);
    setPickRow(null);
    pickRef.current = null;
    setFromCoords(false);
    setSymbol(null);
    // as in MOVER, the symbol card starts folded: it is optional
    setFolded(new Set(['s2-2']));
    parts.current = null;
    showEarlier(null);
    marker.current?.remove();
    editor.current?.load(null, false);
  };
  const stopAdd = () => {
    if (drawing) editor.current?.cancelDrawing();
    setAdding(false);
    setPlacing(false);
    setPickRow(null);
    pickRef.current = null;
    setMade(null);
    editor.current?.load(null, false);
    marker.current?.remove();
    showEarlier(null);
  };
  /** «التالي» / «السابق»: forward only once the step is complete; the reason stays in the card where the person is looking. */
  const goStep = (to: Step) => {
    const problem = to > step ? stepProblem({ name: form.name, kind: form.kind, inside, parentId: form.parentId, shape, point, geometry, drawing }, to) : '';
    setWizErr(problem);
    if (problem) return;
    if (drawing) editor.current?.cancelDrawing();
    setPlacing(false);
    setPickRow(null);
    pickRef.current = null;
    setStep(to);
  };
  const choosePoint = (p: { lat: number; lng: number }, fly = true) => {
    setPoint(p);
    marker.current?.remove();
    if (mapRef.current) {
      marker.current = new Marker({ color: '#d9822b' }).setLngLat([p.lng, p.lat]).addTo(mapRef.current);
      if (fly) mapRef.current.easeTo({ center: [p.lng, p.lat], zoom: Math.max(mapRef.current.getZoom(), 13), duration: 400 });
    }
  };
  /** The table changed: its points are joined in order on the map (a point site takes its one row). */
  const applyRows = (next: PointRow[], fly = false) => {
    setRows(next);
    if (shape === 'POINT') {
      const p = next[0]?.point ?? null;
      // marked only when the point really changes, or the mark would swallow the next click on the map
      fromTable.current = p ? !point || p.lat !== point.lat || p.lng !== point.lng : !!point;
      if (p) choosePoint(p, fly);
      else {
        setPoint(null);
        marker.current?.remove();
      }
      return;
    }
    const o = outlineOf(next);
    setWizErr(o.error && next.filter((r) => r.point).length >= 3 ? o.error : '');
    if (drawing) editor.current?.cancelDrawing();
    parts.current = null;
    showEarlier(null);
    fromTable.current = !!(o.geometry || geometry);
    editor.current?.load(o.geometry, false);
    editor.current?.setMode('move');
    setVertexMode(false);
    setGeometry(o.geometry);
    setFromCoords(!!o.geometry);
    if (fly && o.geometry && mapRef.current) frame(mapRef.current, partsOf(o.geometry).flatMap((p) => p[0]), view, { maxZoom: 15, duration: 400 });
  };
  // the map drew or moved the shape: the table shows its corners (one part; several parts are edited on the map)
  useEffect(() => {
    if (!adding || shape !== 'POLYGON' || drawing) return;
    if (fromTable.current) {
      fromTable.current = false;
      return;
    }
    const c = cornersOf(geometry);
    if (c) setRows(rowsOf(c, fmt));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometry, drawing]);
  useEffect(() => {
    if (!adding || shape !== 'POINT') return;
    if (fromTable.current) {
      fromTable.current = false;
      return;
    }
    setRows(point ? rowsOf([point], fmt) : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [point]);
  /** «من الخريطة» on a row: the next click on the map is that point. */
  const pickFor = (i: number | null) => {
    setPickRow(i);
    setPlacing(false);
    if (drawing) editor.current?.cancelDrawing();
    pickRef.current = i === null ? null : (p) => {
      setPickRow(null);
      const base = shape === 'POINT' ? rows.slice(0, 1) : rows;
      const next = [...base];
      while (next.length <= i) next.push({ text: '', point: null, error: '' });
      next[i] = { text: formatIn(fmt, p.lat, p.lng), point: p, error: '' };
      applyRows(next);
    };
  };
  const pickShape = (s: 'POLYGON' | 'POINT') => {
    if (s === shape) return;
    if (drawing) editor.current?.cancelDrawing();
    setShape(s);
    setPlacing(false);
    setPickRow(null);
    pickRef.current = null;
    setRows([]);
    setGeometry(null);
    setPoint(null);
    parts.current = null;
    showEarlier(null);
    marker.current?.remove();
    editor.current?.load(null, false);
  };
  // free drawing (owner, 10 Nov 2026): as many corners as needed, closed on the first point, a double click, Enter or «إنهاء الرسم»
  const draw = () => {
    setPlacing(false);
    setPickRow(null);
    pickRef.current = null;
    setFromCoords(false);
    setWizErr('');
    parts.current = null;
    editor.current?.load(null, false);
    editor.current?.startDrawing(null, 0);
  };
  /** Another part: what is drawn so far is kept, and the new outline joins it as one MultiPolygon (it then moves as one). */
  const addPart = () => {
    if (!geometry) return;
    parts.current = geometry;
    showEarlier(geometry);
    editor.current?.load(null, false);
    // the map stays by the first part, which stays drawn while the next one is placed
    editor.current?.startDrawing(anchorOf(partsOf(geometry)), 0);
  };
  const showEarlier = (g: SiteGeometry | null) => {
    const m = mapRef.current;
    const src = m?.getSource('setup-earlier') as GeoJSONSource | undefined;
    src?.setData(g ? { type: 'Feature', geometry: g as unknown as GeoJSON.Geometry, properties: {} } : { type: 'FeatureCollection', features: [] });
  };
  useEffect(() => {
    const earlier = parts.current;
    if (!earlier || !geometry || drawing) return;
    const had = earlier.type === 'MultiPolygon' ? earlier.coordinates : [earlier.coordinates];
    const now = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
    parts.current = null;
    const merged = { type: 'MultiPolygon', coordinates: [...had, ...now] } as unknown as SiteGeometry;
    setGeometry(merged);
    editor.current?.setMode('move');
    setVertexMode(false);
    editor.current?.load(merged, false);
    showEarlier(null);
    if (mapRef.current) frame(mapRef.current, partsOf(merged).flatMap((p) => p[0]), view, { maxZoom: 15, duration: 300, padding: { top: 90, right: 90, bottom: 150, left: 90 } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometry, drawing]);
  // a finished outline moves as a whole; its vertices are edited on request, as in the request's editor
  const wasDrawing = useRef(false);
  useEffect(() => {
    if (wasDrawing.current && !drawing) {
      editor.current?.setMode('move');
      setVertexMode(false);
    }
    wasDrawing.current = drawing;
  }, [drawing]);
  const shapeTools = (
    <div className="stw-tools" data-testid="shape-tools">
      <button className="button" onClick={() => (drawing ? editor.current?.undoVertex() : editor.current?.undo())}>↶ تراجع</button>
      <button className="button" onClick={() => (drawing ? editor.current?.redoVertex() : editor.current?.redo())}>↷ إعادة</button>
      <button className="button" onClick={() => (drawing ? editor.current?.restartDrawing() : editor.current?.reset())}>إعادة الضبط</button>
      {!drawing && (
        <button className={'button' + (vertexMode ? ' on' : '')} aria-pressed={vertexMode} data-testid="vertex-toggle" onClick={() => { editor.current?.setMode(vertexMode ? 'move' : 'vertices'); setVertexMode(!vertexMode); }}>تعديل الرؤوس</button>
      )}
    </div>
  );
  const act = async (what: () => Promise<unknown>, done: string, after?: () => void) => {
    setBusy(true);
    try {
      await what();
      app.toast(done);
      app.bump();
      after?.();
      reload();
    } catch (e) {
      app.toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const save = () => {
    let saved: { id: string; name: string; code: string } | null = null;
    return act(async () => {
      const at = shape === 'POINT' ? point : geometry ? anchorOf(partsOf(geometry)) : null;
      if (!at) throw new Error('حدد الموقع على الخريطة أولاً.');
      // no code is asked: the server gives the next one (S-0001, …), ADR-048
      const site = { code: '', name: form.name.trim(), kind: form.kind.trim(), parentId: (inside && form.parentId) || null, responsibleOrgId: owner?.id ?? null, capacity: null, location: at, notes: form.notes || null, reason: form.reason, symbol };
      // one act on the server: a boundary it refuses leaves no site behind
      const s = shape === 'POLYGON' && geometry
        ? await api.createSiteWithBoundary({ site, boundary: { geometry, crs: 'EPSG:4326', expectedVersion: 0, reason: form.reason, method: fromCoords ? 'COORDINATES' : 'DRAWN' } })
        : await api.createSite(site);
      saved = { id: s.id, name: s.name, code: s.code };
    }, 'سُجل الموقع', () => {
      setMade(saved);
      editor.current?.load(null, false);
      marker.current?.remove();
      showEarlier(null);
    });
  };
  const legend = <MapLegend stage="sites" fold={view === '3d'} />;
  const tree = (parent: string, depth: number): React.ReactNode =>
    (byParent.get(parent) ?? []).map((s) => (
      <div key={s.siteId}>
        <button className={'rs-item' + (s.siteId === selected ? ' active' : '')} data-site={s.code} style={{ paddingInlineStart: 10 + depth * 16 }} onClick={() => (setAdding(false), setSelected(s.siteId))}>
          <span className="rs-item-head"><b>{s.name}</b><small className="tz-code">{s.code}</small></span>
          <small>{depth === 0 ? 'موقع رئيسي' : 'موقع فرعي'} · {s.boundary ? 'حدود مسجلة' : 'علامة'}</small>
        </button>
        {tree(s.siteId, depth + 1)}
      </div>
    ));
  const roots = sites.filter((s) => !s.parentId || !sites.some((x) => x.siteId === s.parentId));
  // the data on the left, the work on the right (owner, 10 Nov 2026): the site list, and the steps or the chosen site's card
  const listPanel = () => (
    <div className="tz-rail">
      <section className="tz-drawer open tz-site-list" aria-label="المواقع">
        <div className="tz-drawer-head">
          <span className="tz-drawer-toggle"><Icon name="pin" /><span>المواقع</span><span className="tz-chip">{sites.length}</span></span>
        </div>
        {sites.length > 0 && (
          <div className="sw-railq">
            <input className="sw-input" type="search" aria-label="بحث في المواقع" placeholder="ابحث باسم الموقع أو رمزه" value={railQ} onChange={(e) => setRailQ(e.target.value)} />
          </div>
        )}
        <div className="rs-list" data-testid="setup-tree">
          {roots.length === 0 && <div className="tz-muted tz-pad">لا مواقع بعد. ابدأ بـ«إضافة موقع».</div>}
          {railQ.trim() && sites.filter((s) => s.name.includes(railQ.trim()) || s.code.toLowerCase().includes(railQ.trim().toLowerCase())).map((s) => (
            <button key={s.siteId} className={'rs-item' + (s.siteId === selected ? ' active' : '')} data-site={s.code} onClick={() => (setAdding(false), setSelected(s.siteId))}>
              <span className="rs-item-head"><b>{s.name}</b><small className="tz-code">{s.code}</small></span>
              <small>{s.parentId ? 'موقع فرعي' : 'موقع رئيسي'} · {s.boundary ? 'حدود مسجلة' : 'علامة'}</small>
            </button>
          ))}
          {!railQ.trim() && roots.map((s) => (
            <div key={s.siteId}>
              <button className={'rs-item' + (s.siteId === selected ? ' active' : '')} data-site={s.code} onClick={() => (setAdding(false), setSelected(s.siteId))}>
                <span className="rs-item-head"><b>{s.name}</b><small className="tz-code">{s.code}</small></span>
                <small>موقع رئيسي · {s.boundary ? 'حدود مسجلة' : 'علامة'}</small>
              </button>
              {tree(s.siteId, 1)}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
  const workPanel = () => (
    <div className="tz-rail">
      <section className="tz-drawer open tz-site-work" aria-label="تهيئة الموقع">
        <div className="tz-drawer-head">
          <span className="tz-drawer-toggle"><Icon name="boundary" /><span>تهيئة الموقع</span></span>
          {canSites && <button className="button primary compact tz-new" data-testid="add-site" aria-pressed={adding && !made} disabled={adding && !made} onClick={startAdd}>＋ إضافة موقع</button>}
        </div>
        {/* «موقع جديد» right under its button, the whole height of the panel (owner, 10 Nov 2026) */}
        <div className="sw-fill" data-testid="setup-context">
          {adding ? addPanel : sitePanel ?? (
            <section className="tz-card">
              <h3>تهيئة المواقع والتمركز</h3>
              <p className="tz-muted">هذه مساحة التهيئة الأولى والتصحيح، وكل خطوة فيها تُسجَّل بسببها. اختر موقعاً من قائمة «المواقع»، أو اضغط «＋ إضافة موقع».</p>
            </section>
          )}
        </div>
      </section>
    </div>
  );
  // ---- «موقع جديد»: one question per card, as in MOVER --------------------------------------------------------------------
  // every card folds on its title and opens again (owner, 10 Nov 2026): a long list is chosen, then folded away
  const foldBtn = (key: string, label: string) => (
    // a neutral name, so a field's label is never matched by its card's fold button
    <button type="button" className="sw-fold" aria-expanded={!folded.has(key)} aria-label={folded.has(key) ? 'فتح البطاقة' : 'طي البطاقة'} title={(folded.has(key) ? 'فتح: ' : 'طي: ') + label} data-fold={key} onClick={() => setFolded((f) => { const n = new Set(f); if (!n.delete(key)) n.add(key); return n; })}>{folded.has(key) ? '◂' : '▾'}</button>
  );
  const card = (n: number, title: string, body: React.ReactNode, id?: string) => (
    <section className={'sw-q' + (folded.has('s' + step + '-' + n) ? ' folded' : '')} data-q={n} data-testid={id}>
      <h4 className="sw-qh"><span className="sw-n">{n}</span>{title}{foldBtn('s' + step + '-' + n, title)}</h4>
      {body}
    </section>
  );
  const parentSite = sites.find((s) => s.siteId === form.parentId) ?? null;
  const parentHits = sites.filter((s) => !parentQ.trim() || s.name.includes(parentQ.trim()) || s.code.toLowerCase().includes(parentQ.trim().toLowerCase())).slice(0, 30);
  const step1 = (
    <div className="sw-body">
      {card(1, 'ما اسم الموقع؟', (
        <>
          <input className="sw-input" aria-label="اسم الموقع" placeholder="مثال: المجمع الإداري الأول" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <p className="sw-hint">رمز الموقع يُعطى تلقائياً عند الحفظ.</p>
        </>
      ))}
      {card(2, 'ما نوعه؟', (
        <>
          <div className="sw-choices">
            {MAIN_KINDS.map((k) => (
              <button key={k} type="button" className={'sw-choice' + (!otherKind && form.kind === k ? ' on' : '')} aria-pressed={!otherKind && form.kind === k} data-kind={k} onClick={() => { setOtherKind(false); setForm({ ...form, kind: k }); }}>{k}</button>
            ))}
            <button type="button" className={'sw-choice' + (otherKind ? ' on' : '')} aria-pressed={otherKind} data-kind="other" onClick={() => { setOtherKind(true); setForm({ ...form, kind: MAIN_KINDS.includes(form.kind) ? '' : form.kind }); }}>نوع آخر…</button>
          </div>
          {otherKind && <input className="sw-input" aria-label="تصنيف الموقع" placeholder="اكتب النوع" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} />}
        </>
      ))}
      {card(3, 'أين يقع؟', (
        <>
          <div className="sw-choices">
            <button type="button" className={'sw-choice' + (!inside ? ' on' : '')} aria-pressed={!inside} data-testid="where-main" onClick={() => { setInside(false); setForm({ ...form, parentId: '' }); }}>موقع رئيسي</button>
            <button type="button" className={'sw-choice' + (inside ? ' on' : '')} aria-pressed={inside} data-testid="where-inside" disabled={sites.length === 0} onClick={() => setInside(true)}>داخل موقع آخر</button>
          </div>
          {sites.length === 0 && <p className="sw-hint">لا توجد مواقع مسجلة بعد، فهذا موقع رئيسي.</p>}
          {inside && (parentSite ? (
            <div className="sw-picked" data-testid="parent-picked"><span className="sw-ok">✓</span><div><b>يقع داخل «{parentSite.name}»</b><small>{parentSite.code}</small></div>
              <button type="button" className="sw-link" onClick={() => setForm({ ...form, parentId: '' })}>تغيير</button></div>
          ) : (
            <div className="sw-sub">
              <input className="sw-input" type="search" aria-label="بحث عن الموقع الأعلى" placeholder="ابحث باسم الموقع أو رمزه" value={parentQ} onChange={(e) => setParentQ(e.target.value)} />
              <ul className="sw-list">
                {parentHits.map((s) => <li key={s.siteId}><button type="button" className="sw-row" data-parent-pick={s.code} onClick={() => setForm({ ...form, parentId: s.siteId })}><b>{s.name}</b><small>{s.code}</small></button></li>)}
                {parentHits.length === 0 && <li className="sw-hint">لا نتائج.</li>}
              </ul>
            </div>
          ))}
        </>
      ))}
      {card(4, 'أي وحدة مسؤولة عنه؟', (
        owner && !ownerOpen ? (
          <div className="sw-picked" data-testid="owner-picked"><span className="sw-ok">✓</span><div><b>{owner.name}</b><small>تدير الموقع، ولا يعني ذلك أنها متمركزة فيه.</small></div>
            <button type="button" className="sw-link" onClick={() => setOwnerOpen(true)}>تغيير</button></div>
        ) : (
          // the units as their hierarchy, loaded one level at a time, with a search across every branch the person may see
          <div className="sw-sub sw-tree" data-testid="owner-tree">
            <OrgTree selectedId={owner?.id ?? null} includeSub={false} onIncludeSub={() => undefined} subOption={false} revision={app.revision}
              onSelect={(o) => { setOwner(o); setOwnerOpen(false); }} />
            <p className="sw-hint">اختياري. {owner ? <button type="button" className="sw-link" onClick={() => { setOwner(null); setOwnerOpen(false); }}>بلا وحدة مسؤولة</button> : 'بلا وحدة مسؤولة، لا يسجله إلا من يدير المرافق في كل الجهات.'}</p>
          </div>
        )
      ))}
      <details className="sw-more">
        <summary>خيارات إضافية (اختياري)</summary>
        <label className="field"><span>ملاحظات</span><textarea aria-label="ملاحظات الموقع" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
      </details>
    </div>
  );
  const poly = shape === 'POLYGON';
  const step2 = (
    <div className="sw-body">
      {card(1, poly ? 'ارسم حدود الموقع' : 'حدّد مكان الموقع', (
        <>
          <div className="sw-choices">
            <button type="button" className={'sw-choice' + (poly ? ' on' : '')} aria-pressed={poly} data-testid="shape-polygon" onClick={() => pickShape('POLYGON')}>منطقة لها حدود</button>
            <button type="button" className={'sw-choice' + (!poly ? ' on' : '')} aria-pressed={!poly} data-testid="shape-point" onClick={() => pickShape('POINT')}>نقطة واحدة</button>
          </div>
          <div className="sw-ways">
            {poly ? (
              <button type="button" className={'sw-way' + (drawing ? ' on' : '')} data-testid="draw-site" onClick={draw}>
                <Icon name="boundary" /><b>{geometry ? 'ارسمها من جديد' : 'ارسم على الخريطة'}</b><small>انقر عند كل زاوية، ثم على أول نقطة</small>
              </button>
            ) : (
              <button type="button" className={'sw-way' + (placing ? ' on' : '')} data-testid="place-point" onClick={() => { setTyping(false); setWizErr(''); setPlacing(!placing); }}>
                <Icon name="pin" /><b>{point ? 'غيّر المكان' : 'حدّد المكان على الخريطة'}</b><small>نقرة واحدة</small>
              </button>
            )}
            <button type="button" className={'sw-way' + (typing ? ' on' : '')} data-testid="type-coords" aria-pressed={typing} onClick={() => { setPlacing(false); setTyping(!typing); if (!typing && rows.length === 0) setRows(poly ? [0, 1, 2].map(() => ({ text: '', point: null, error: '' })) : [{ text: '', point: null, error: '' }]); }}>
              <Icon name="grid" /><b>اكتب الإحداثيات</b><small>جدول بنقطة في كل سطر، بأي صيغة</small>
            </button>
          </div>
          {drawing ? (
            <div className="sw-drawing">
              <p className="sw-hint">انقر على الخريطة عند كل زاوية، بقدر ما تحتاج{drawInfo ? ` — ${drawInfo.count} حتى الآن` : ''}. للإغلاق: انقر على أول نقطة، أو انقر مرتين، أو اضغط «إنهاء الرسم».</p>
              <button type="button" className="button primary" data-testid="finish-draw" disabled={!drawInfo?.canFinish} onClick={() => editor.current?.finishDrawing()}>إنهاء الرسم</button>
            </div>
          ) : placing ? <p className="sw-hint">انقر على الخريطة في مكان الموقع.</p>
            : (poly ? geometry : point) ? <p className="sw-done" data-testid="shape-done">✓ {poly ? 'تم رسم الحدود: ' + shapeText(shape, geometry) + '. اسحبها لنقلها كاملة.' : 'تم تحديد المكان.'}</p>
            : <p className="sw-hint">لم {poly ? 'تُرسم' : 'يُحدد'} بعد.</p>}
          {typing && (poly && geometry && !cornersOf(geometry)
            ? <p className="sw-hint">لهذا الموقع أكثر من جزء: تُعدّل أجزاؤه على الخريطة.</p>
            : <PointsTable rows={rows} fmt={fmt} single={!poly} picking={pickRow} onRows={(r) => applyRows(r)} onFormat={setFmt} onPick={pickFor} />)}
          {poly && (geometry || drawing) && shapeTools}
          {poly && <button type="button" className="sw-link" disabled={!geometry || drawing} data-testid="add-part" onClick={addPart}>＋ جزء آخر لهذا الموقع (يتحرك معه)</button>}
        </>
      ))}
      {card(2, 'رمز يظهر على الخريطة (اختياري)', <SiteSymbolPicker value={symbol} onChange={setSymbol} />, 'symbol-card')}
    </div>
  );
  const summary: [string, string][] = [
    ['الاسم', form.name.trim()],
    ['الرمز', 'يُعطى تلقائياً عند الحفظ'],
    ['النوع', form.kind.trim()],
    ['يقع', inside && parentSite ? `داخل «${parentSite.name}»` : 'موقع رئيسي'],
    ['الوحدة المسؤولة', owner?.name ?? 'بلا وحدة مسؤولة'],
    ['الشكل', shapeText(shape, geometry)],
    ['الرمز على الخريطة', symbol ? symbolEntry(symbol)?.label ?? symbol : 'بدون رمز'],
    ...(poly && geometry ? [['المساحة', formatArea(siteArea(partsOf(geometry)))] as [string, string]] : []),
  ];
  const step3 = (
    <div className="sw-body">
      {card(1, 'راجع ثم احفظ', (
        <dl className="sw-sum" data-testid="site-summary">{summary.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      ))}
      {card(2, 'لماذا تسجّل هذا الموقع؟', (
        <>
          <textarea className="sw-input" rows={3} aria-label="سبب تسجيل الموقع" placeholder="السبب يُحفظ في سجل التدقيق باسمك" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
          <p className="sw-hint">يُحفظ مباشرة ويظهر في قائمة المواقع وعلى الخريطة.</p>
        </>
      ))}
      <button type="button" className="sw-go" data-testid="save-site" disabled={busy || drawing || form.reason.trim().length < 5} onClick={save}>{busy ? 'جارٍ الحفظ…' : 'حفظ الموقع'}</button>
    </div>
  );
  const addPanel = (
    <section className="sw-wizard" data-testid="add-site-form" data-step={made ? 'done' : step}>
      <div className="sw-top">
        <button type="button" className="sw-back" onClick={stopAdd}>→ رجوع</button>
        <h3 className="sw-title">موقع جديد</h3>
      </div>
      {made ? (
        <div className="sw-body" data-testid="site-made">
          <p className="sw-done">✓ سُجل «{made.name}» برمز <bdi data-testid="made-code">{made.code}</bdi></p>
          <p className="sw-hint">ظهر في قائمة المواقع وعلى الخريطة. من بطاقته تُثبَّت الوحدات المتمركزة فيه وتُربط به الوحدات.</p>
          <button type="button" className="sw-go" onClick={() => { const id = made.id; stopAdd(); setSelected(id); }}>فتح بطاقة الموقع</button>
          <div className="sw-nav2">
            <button type="button" className="sw-link" onClick={startAdd}>إضافة موقع آخر</button>
            <button type="button" className="sw-link" onClick={stopAdd}>إغلاق</button>
          </div>
        </div>
      ) : (
        <>
          <ol className="sw-steps" aria-label={`الخطوة ${step} من 3`}>
            {STEPS.map((t, i) => (
              <li key={t} className={'sw-step' + (i + 1 === step ? ' on' : i + 1 < step ? ' done' : '')} aria-current={i + 1 === step ? 'step' : undefined}><b>{i + 1 < step ? '✓' : i + 1}</b><span>{t}</span></li>
            ))}
          </ol>
          {wizErr && <p className="sw-err" role="alert">{wizErr}</p>}
          {step === 1 ? step1 : step === 2 ? step2 : step3}
          <div className="sw-nav">
            {step < 3 && <button type="button" className="sw-go" data-testid="wizard-next" onClick={() => goStep((step + 1) as Step)}>التالي ←</button>}
            <div className="sw-nav2">
              {step > 1 ? <button type="button" className="sw-link" data-testid="wizard-back" onClick={() => goStep((step - 1) as Step)}>→ السابق</button> : <span />}
              <button type="button" className="sw-link sw-cancel" onClick={stopAdd}>إلغاء</button>
            </div>
          </div>
        </>
      )}
    </section>
  );
  const sitePanel = site && (
    <>
      <section className="tz-card rs-summary">
        <h2 className="tz-site-title">{site.name}</h2>
        <p className="tz-muted micro">{site.code} · موقع واحد على الخريطة، مهما تعددت الوحدات التي تستخدمه.</p>
      </section>
      {canSites && detail?.canManage && (
        <section className={'tz-card sw-fcard' + (folded.has('edit-site') ? ' folded' : '')} data-testid="edit-site">
          <h4 className="sw-fhead">تعديل بيانات الموقع{foldBtn('edit-site', 'تعديل بيانات الموقع')}</h4>
          <label className="field"><span>الاسم</span><input aria-label="اسم الموقع" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
          <label className="field"><span>التصنيف</span><input aria-label="تصنيف الموقع" value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value })} /></label>
          <label className="field"><span>الموقع الرئيسي</span>
            <select aria-label="الموقع الرئيسي" value={edit.parentId} onChange={(e) => setEdit({ ...edit, parentId: e.target.value })}>
              <option value="">— موقع رئيسي —</option>
              {sites.filter((s) => s.siteId !== site.siteId).map((s) => <option key={s.siteId} value={s.siteId}>{s.name}</option>)}
            </select>
          </label>
          <label className="field"><span>ملاحظات (تبقى كما هي إن تُركت فارغة)</span><input aria-label="ملاحظات الموقع" value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} /></label>
          <label className="field"><span>السبب (مطلوب)</span><textarea aria-label="سبب التعديل" value={edit.reason} onChange={(e) => setEdit({ ...edit, reason: e.target.value })} /></label>
          <div className="rs-tools">
            <button className="button" data-testid="save-edit" disabled={busy || editingShape || edit.reason.trim().length < 5 || !edit.name.trim()} onClick={() => act(() => api.updateSite(site.siteId, { code: edit.code, name: edit.name.trim(), kind: edit.kind.trim(), parentId: edit.parentId || null, capacity: detail.capacity, location: detail.location, notes: edit.notes.trim() || null, reason: edit.reason }), 'حُفظت بيانات الموقع', () => setEdit({ ...edit, reason: '', notes: '' }))}>حفظ البيانات</button>
            {!editingShape && <button className="button" data-testid="edit-shape" onClick={startShape}>تعديل الحدود</button>}
            {editingShape && (
              <>
                <button className="button primary" data-testid="save-shape" disabled={busy || drawing || !geometry || edit.reason.trim().length < 5} onClick={() => act(() => api.saveSiteGeometry(site.siteId, { geometry: geometry!, crs: 'EPSG:4326', expectedVersion: detail.geometryVersion ?? 0, reason: edit.reason, method: 'DRAWN' }), 'حُفظت الحدود', () => { setEditingShape(false); editor.current?.load(null, false); setEdit({ ...edit, reason: '' }); })}>حفظ الحدود</button>
                <button className="button" onClick={() => { setEditingShape(false); editor.current?.load(null, false); }}>إلغاء</button>
              </>
            )}
          </div>
          {editingShape && shapeTools}
          {editingShape && <p className="micro tz-muted">اسحب الحدود لنقلها كاملة. تُحفظ نسخة جديدة بسببها، ولا يُكتب شيء قبل الحفظ.</p>}
        </section>
      )}
      <section className={'tz-card sw-fcard' + (folded.has('site-symbol') ? ' folded' : '')} data-testid="site-symbol">
        <h4 className="sw-fhead">رمز الموقع على الخريطة{foldBtn('site-symbol', 'رمز الموقع على الخريطة')}</h4>
        <div className={'sw-symnow' + (detail?.symbol ? '' : ' none')} data-symbol={detail?.symbol?.sidc ?? ''}>
          {detail?.symbol ? <SymbolArt sidc={detail.symbol.sidc} size={40} /> : <span className="sw-symart none" aria-hidden="true">●</span>}
          <span><b>{detail?.symbol ? symbolEntry(detail.symbol.sidc)?.label ?? 'رمز مخصص' : 'بدون رمز'}</b><small>للعرض على الخريطة فقط.</small></span>
          {canSites && detail?.canManage && symEdit === undefined && <button type="button" className="sw-link" data-act="symbol-change" onClick={() => { setSymEdit(detail?.symbol?.sidc ?? null); setSymReason(''); }}>تغيير الرمز</button>}
        </div>
        {symEdit !== undefined && (
          <div className="sw-wizard">
            <SiteSymbolPicker value={symEdit} onChange={setSymEdit} />
            <label className="field"><span>السبب (مطلوب)</span><textarea aria-label="سبب تغيير الرمز" value={symReason} onChange={(e) => setSymReason(e.target.value)} /></label>
            <div className="rs-tools">
              <button className="button primary" data-testid="save-symbol" disabled={busy || symReason.trim().length < 5 || symEdit === (detail?.symbol?.sidc ?? null)} onClick={() => act(() => api.setSiteSymbol(site.siteId, { symbol: symEdit ?? null, reason: symReason }), 'حُفظ رمز الموقع', () => { setSymEdit(undefined); setSymReason(''); })}>حفظ الرمز</button>
              <button className="button" onClick={() => setSymEdit(undefined)}>إلغاء</button>
            </div>
          </div>
        )}
      </section>
      <section className={'tz-card sw-fcard' + (folded.has('stationed-here') ? ' folded' : '')} data-testid="stationed-here">
        <h4 className="sw-fhead">الوحدات المتمركزة حالياً{foldBtn('stationed-here', 'الوحدات المتمركزة حالياً')}</h4>
        {occ?.stationed.length === 0 && !occ?.otherStationed && <p className="tz-muted">لا تمركز حالي.</p>}
        <ul className="tz-sites">{occ?.stationed.map((u) => <li key={u.orgId}><b>{u.orgName}</b></li>)}</ul>
        {!!occ?.otherStationed && <p className="tz-muted" data-testid="others-here">جهة أخرى في الموقع: {occ.otherStationed}</p>}
        {canCorrect && (
          <>
            <h4 style={{ marginTop: 10 }}>تثبيت التمركز (تصحيح مُدقَّق)</h4>
            <p className="micro tz-muted">للتهيئة الأولى والتصحيح فقط: كل وحدة تُختار بنفسها، ولا ينتقل معها من يتبعها. أما الطلب العادي فيمر بالاعتمادات.</p>
            <OrgSelect q={q} setQ={setQ} orgs={orgs} value={stOrg} onChange={setStOrg} label="وحدة التمركز" />
            <label className="field"><span>السبب</span><textarea aria-label="سبب التمركز" value={stReason} onChange={(e) => setStReason(e.target.value)} /></label>
            <button className="button" data-testid="correct-stationing" disabled={busy || !stOrg || stReason.trim().length < 5} onClick={() => act(() => api.correctStationing({ organizationId: stOrg, siteId: site.siteId, reason: stReason }), 'سُجل التمركز', () => (setStOrg(''), setStReason('')))}>تثبيت</button>
          </>
        )}
      </section>
      <section className={'tz-card sw-fcard' + (folded.has('linked-here') ? ' folded' : '')} data-testid="linked-here">
        <h4 className="sw-fhead">الوحدات المرتبطة <small>(الربط ليس تمركزاً)</small>{foldBtn('linked-here', 'الوحدات المرتبطة')}</h4>
        {occ?.linked.length === 0 && <p className="tz-muted">لا ارتباطات.</p>}
        <ul className="tz-sites">
          {occ?.linked.map((l) => (
            <li key={l.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}><b>{l.orgName}</b>{canLinks && <button className="button compact" style={{ width: 'auto', flex: 'none' }} onClick={() => { const why = window.prompt('سبب إنهاء الربط'); if (why && why.trim().length >= 5) void act(() => api.endSiteLink(l.id, why), 'أُنهي الربط'); }}> إنهاء</button>}</li>
          ))}
        </ul>
        {canLinks && (
          <>
            <OrgSelect q={q} setQ={setQ} orgs={orgs} value={linkOrg} onChange={setLinkOrg} label="وحدة الربط" />
            <label className="field"><span>السبب</span><textarea aria-label="سبب الربط" value={linkReason} onChange={(e) => setLinkReason(e.target.value)} /></label>
            <button className="button" data-testid="add-link" disabled={busy || !linkOrg || linkReason.trim().length < 5} onClick={() => act(() => api.createSiteLink({ siteId: site.siteId, organizationId: linkOrg, reason: linkReason }), 'أُضيف الربط', () => (setLinkOrg(''), setLinkReason('')))}>إضافة ربط</button>
          </>
        )}
      </section>
    </>
  );
  return (
    <OperationalWorkspace
      listRail
      swapSides
      panels="siteSetup"
      railLabel="تهيئة الموقع"
      contextLabel="المواقع"
      sheetKey={(adding ? 'add' : '') + (selected ?? '')}
      rail={workPanel()}
      context={listPanel()}
      centre={
        <MapFrame title={<span className="tz-mapstep"><Icon name="map" /><b>تهيئة المواقع والتمركز</b></span>} mode={mode} setMode={setMode} view={view} setView={setView} has3d={!!terrain3d} placing={placing || drawing} legend={legend}>
          {terrain3d !== undefined && <RequestMap view={view} terrain3d={terrain3d} request={EMPTY_MAP} checks={null} mode={mode} fitMaxZoom={13} hideSite fit={false} onMap={onMap} referenceInteractive={!adding && !editingShape} fitSites pick={adding || editingShape ? null : { selectedId: selected, onPick: (id) => setSelected(id) }} focus={selected ? { siteId: selected, key: selected.length } : null} />}
        </MapFrame>
      }
    />
  );
}

function OrgSelect({ q, setQ, orgs, value, onChange, label }: { q: string; setQ: (s: string) => void; orgs: { id: string; name: string }[]; value: string; onChange: (s: string) => void; label: string }) {
  return (
    <>
      <label className="field"><span>بحث عن وحدة</span><input aria-label={'بحث ' + label} value={q} onChange={(e) => setQ(e.target.value)} /></label>
      <label className="field"><span>الوحدة</span>
        <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">— اختر —</option>
          {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      </label>
    </>
  );
}
