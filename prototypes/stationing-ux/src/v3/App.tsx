import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FootprintEditor, type FootprintLive } from '../../../../frontend/src/components/stationing/FootprintEditor';
import L from '../../../../frontend/src/lib/leaflet';
import { areaM2, centroid, offsetsOf, rebuild, type Ring } from '../../../../frontend/src/lib/footprint';
import type { LatLng } from '../../../../frontend/src/lib/geo';
import geojsonUrl from '../../../../map-packages/regional-basemap-2026.10/basemap.geojson?url';
import namesUrl from './data/road-names.json?url';
import { vectorBasemap, type Mode } from './basemap';
import { Cards, ReasonDialog, type Ask, type Ctx, type EditorApi } from './cards';
import {
  affectedSites,
  check,
  conflictRings,
  descendants,
  legCheck,
  occupantsOf,
  orgOf,
  perform,
  personOf,
  policyAt,
  policyOfRequest,
  siteOf,
  siteOfOrg,
  type Action,
  type Request,
  type World,
} from './domain';
import { HILLS, baseWorld } from './fixtures';
import { COMPARE_AREA, COMPARE_BAND, COMPARE_SITE, comparison } from './compare';
import { bandOutline, circleRing, equivalentRadius } from './measure';
import { SCENARIOS, run, scenarioOf, type Sel, type Step } from './scenarios';

const ll = (r: Ring) => r.map((p) => [p.lat, p.lng] as L.LatLngTuple);
const short = (name: string) => name.split(' — ')[0];
const ATTRIBUTION = 'OpenFreeMap © OpenMapTiles Data from OpenStreetMap (ODbL) · أسماء الطرق: © OpenStreetMap contributors / Protomaps (ODbL، غير رسمية)';

function fromHash() {
  const code = /s=([A-Z][0-9]?)/.exec(location.hash)?.[1] ?? '';
  const sc = scenarioOf(code);
  return { sc, w: sc ? run(sc.actions) : baseWorld() };
}

export function App() {
  const init = useMemo(fromHash, []);
  const [world, setWorld] = useState<World>(init.w);
  const [actor, setActor] = useState(init.sc?.actor ?? 'p-req');
  const [sel, setSel] = useState<Sel>(init.sc?.sel ?? null);
  const [mode, setMode] = useState<Mode>(init.sc?.layer ?? 'streets');
  const [notice, setNotice] = useState<string | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [legend, setLegend] = useState(false);
  const [narrow, setNarrow] = useState(() => window.innerWidth <= 900);
  const [sheet, setSheet] = useState<'collapsed' | 'medium' | 'expanded'>('medium');
  const [live, setLive] = useState<FootprintLive | null>(null);
  const [zoom, setZoom] = useState(12);
  const mapEl = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<L.Map | null>(null);
  const base = useRef<ReturnType<typeof vectorBasemap> | null>(null);
  const editor = useRef<FootprintEditor | null>(null);
  const worldRef = useRef(world);
  worldRef.current = world;

  const editing = sel?.k === 'edit' ? sel : null;
  const req = editing ? world.requests.find((r) => r.id === editing.id) ?? null : null;
  const placing = editing && (editing.step === 'SITE' || editing.step === 'PRIMARY' || editing.step === 'ALTERNATIVE') ? editing.step : null;

  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth <= 900);
    const onHash = () => location.reload();
    window.addEventListener('resize', onResize);
    window.addEventListener('hashchange', onHash);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('hashchange', onHash);
    };
  }, []);
  useEffect(() => setSheet(placing ? 'collapsed' : 'medium'), [placing]);
  // prototype-only hook for the browser evidence
  useEffect(() => {
    (window as unknown as { __v3: unknown }).__v3 = { world, map, sel, mode, live, basemap: base.current };
  });

  // ---- the map, once ----
  useEffect(() => {
    const m = L.map(mapEl.current!, { zoomControl: false, zoomSnap: 0.25, attributionControl: true });
    const b = vectorBasemap(geojsonUrl, HILLS, ATTRIBUTION, namesUrl);
    b.layer.addTo(m);
    base.current = b;
    // the first view sits above the bottom sheet on narrow screens and beside the card on wide ones
    const sheetH = window.innerWidth <= 900 ? Math.round(mapEl.current!.clientHeight * 0.46) + 16 : 0;
    m.fitBounds(L.latLngBounds([25.15, 55.25], [25.28, 55.4]), window.innerWidth <= 900 ? { paddingTopLeft: [10, 50], paddingBottomRight: [10, sheetH] } : { paddingBottomRight: [440, 0] });
    L.control.zoom({ position: 'bottomleft', zoomInTitle: 'تكبير', zoomOutTitle: 'تصغير' }).addTo(m);
    L.control.scale({ position: 'bottomleft', imperial: false }).addTo(m);
    const z = () => setZoom(Math.round(m.getZoom()));
    m.on('zoomend', z);
    z();
    setMap(m);
    return () => void m.remove();
  }, []);
  // the layer switch changes only the basemap (§37)
  useEffect(() => base.current?.setMode(mode), [mode]);

  const act = useCallback(
    (a: Action, who = actor) => {
      const v = check(worldRef.current, who, a);
      if (!v.ok) {
        setNotice(v.reason);
        return false;
      }
      const next = perform(worldRef.current, who, a);
      worldRef.current = next;
      setWorld(next);
      setNotice(null);
      return true;
    },
    [actor],
  );
  const edit = useCallback(
    (fn: (r: Request) => Request['content']) => {
      const r = worldRef.current.requests.find((x) => x.id === (sel?.k === 'edit' ? sel.id : ''));
      if (r) act({ t: 'EDIT', req: r.id, content: fn(r) }, r.requester);
    },
    [act, sel],
  );

  // ---- the single active polygon engine: proposed site, or the deployment area being placed ----
  const hasRing = !!(req && placing && (placing === 'SITE' ? req.content.site : placing === 'PRIMARY' ? req.content.primary : req.content.alternative));
  useEffect(() => {
    if (!map || !req || !placing) return;
    const w = worldRef.current;
    const c = req.content;
    const origin = placing === 'SITE' ? centroid(siteOf(w, c.site?.copiedFrom ?? '')?.ring ?? c.site!.ring) : placing === 'PRIMARY' ? centroid(c.site!.ring) : c.primary ? centroid(c.primary) : centroid(c.site!.ring);
    const container = map.getContainer();
    container.classList.toggle('v3-deploy', placing !== 'SITE');
    if (!hasRing) {
      // deployment: one click places a simple default shape (real geometry); then drag, resize or edit it
      container.classList.add('v3-placing');
      const onClick = (e: L.LeafletMouseEvent) => {
        const ring = circleRing({ lat: e.latlng.lat, lng: e.latlng.lng }, placing === 'PRIMARY' ? 600 : 500);
        edit((r) => ({ ...r.content, [placing === 'PRIMARY' ? 'primary' : 'alternative']: ring }));
      };
      map.on('click', onClick);
      return () => {
        map.off('click', onClick);
        container.classList.remove('v3-placing', 'v3-deploy');
      };
    }
    const sym = '<span class="v3-prop-mark ' + placing.toLowerCase() + '">' + (placing === 'SITE' ? '⌂' : placing === 'PRIMARY' ? 'ر' : 'ب') + '</span>';
    const scope = c.scope;
    const ed = new FootprintEditor(map, {
      origin,
      symbolHtml: sym,
      range: () => null,
      // occupied geography blocks the proposed site AND both deployment areas (owner rule O-08)
      busy: () => conflictRings(worldRef.current, scope).map((x) => ({ name: x.name, rings: [x.ring] })),
      paused: () => false,
      onLive: (l, final) => {
        if (!final) return;
        setLive(l);
        if (!l.ring) return;
        const ring = l.ring;
        const r = worldRef.current.requests.find((x) => x.id === req.id)!;
        if (placing === 'SITE') {
          if (JSON.stringify(ring) !== JSON.stringify(r.content.site?.ring))
            edit((q) => {
              // a rigid move keeps the copied shape; any vertex change makes it «edited»; a new drawing is «drawn»
              const src = siteOf(worldRef.current, q.content.site!.copiedFrom)?.ring;
              const rigid = !!src && src.length === ring.length && Math.abs(areaM2(src) - areaM2(ring)) / areaM2(src) < 0.002;
              const shape = l.mode === 'draw' || q.content.site!.shape === 'DRAWN' ? 'DRAWN' : rigid && q.content.site!.shape === 'COPY' ? 'COPY' : 'EDITED';
              return { ...q.content, site: { ...q.content.site!, ring, shape } };
            });
        } else {
          const key = placing === 'PRIMARY' ? 'primary' : 'alternative';
          if (JSON.stringify(ring) !== JSON.stringify(r.content[key])) edit((q) => ({ ...q.content, [key]: ring }));
        }
      },
    });
    editor.current = ed;
    const ring = placing === 'SITE' ? c.site!.ring : placing === 'PRIMARY' ? c.primary! : c.alternative!;
    ed.startMove(ring, centroid(ring));
    return () => {
      ed.destroy();
      editor.current = null;
      setLive(null);
      container.classList.remove('v3-deploy', 'v3-leg-bad');
    };
    // the engine is rebuilt only when the object being edited changes, never on each edit it reports itself
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, req?.id, placing, hasRing]);

  // a deployment leg out of its permitted band colours the active shape (the engine only knows overlap and shape)
  const polNow = req ? policyOfRequest(world, req).values : policyAt(world, world.now).values;
  const legState = req && placing && placing !== 'SITE' ? legCheck(world, polNow, placing === 'PRIMARY' ? 'primary' : 'alternative', placing === 'PRIMARY' ? req.content.site?.ring ?? null : req.content.primary, placing === 'PRIMARY' ? req.content.primary : req.content.alternative) : null;
  useEffect(() => {
    map?.getContainer().classList.toggle('v3-leg-bad', legState?.status === 'OUT_OF_RANGE' || legState?.status === 'NEEDS_EXCEPTION');
    map?.getContainer().classList.toggle('v3-hide-chip', !!legState && legState.method !== 'CENTROID_TO_CENTROID');
  }, [map, legState?.status, legState?.method]);

  const editorApi: EditorApi = {
    live,
    undo: () => editor.current?.undo(),
    redo: () => editor.current?.redo(),
    reset: () => editor.current?.reset(),
    vertices: (on) => editor.current?.setEditVertices(on),
    drawNew: () => {
      editor.current?.startDraw(6);
    },
    focus: () => editor.current?.focus(),
    resize: (radius) => {
      if (!req || !placing || placing === 'SITE' || !map) return;
      const key = placing === 'PRIMARY' ? 'primary' : 'alternative';
      const ring = req.content[key];
      if (!ring) return;
      const c = centroid(ring);
      const k = radius / equivalentRadius(areaM2(ring));
      const scaled = rebuild(
        offsetsOf(ring, c).map((o) => ({ d: o.d * k, b: o.b })),
        c,
      );
      const view = { c: map.getCenter(), z: map.getZoom() };
      edit((q) => ({ ...q.content, [key]: scaled }));
      editor.current?.startMove(scaled, c);
      map.stop();
      map.setView(view.c, view.z, { animate: false });
    },
    remove: () => {
      if (!placing || placing === 'SITE') return;
      edit((q) => ({ ...q.content, [placing === 'PRIMARY' ? 'primary' : 'alternative']: null }));
    },
  };

  // ---- overlays: only what the current context needs (§34) ----
  const fitKey = JSON.stringify(sel);
  const lastFit = useRef('');
  useEffect(() => {
    if (!map) return;
    const g = L.layerGroup().addTo(map);
    const w = world;
    const bounds: L.LatLng[] = [];
    const keep = (r: Ring) => r.forEach((p) => bounds.push(L.latLng(p.lat, p.lng)));
    const tag = (at: LatLng, html: string, cls: string) =>
      L.marker([at.lat, at.lng], { interactive: false, keyboard: false, zIndexOffset: 500, icon: L.divIcon({ className: 'v3-tag-icon', html: '<span class="v3-tag ' + cls + '">' + html + '</span>', iconSize: [0, 0] }) }).addTo(g);
    const focusSite = sel?.k === 'site' ? sel.id : null;
    const orgSel = sel?.k === 'org' ? sel.id : null;
    const related = new Set<string>();
    if (orgSel) {
      const own = siteOfOrg(w, orgSel)?.id;
      if (own) related.add(own);
      for (const d of descendants(w, orgSel)) {
        const s = siteOfOrg(w, d)?.id;
        if (s) related.add(s);
      }
    }
    const r = sel?.k === 'req' ? w.requests.find((x) => x.id === sel.id) : req;
    const inScope = new Set(r ? affectedSites(w, r.content.scope).map((a) => a.site.id) : []);
    // while the proposed site is dragged, occupied sites say so on their own label (no second tag)
    const busy = new Set(r && editing?.step === 'SITE' ? conflictRings(w, r.content.scope).map((x) => x.name) : []);

    // terrain classes are visible only in the terrain mode (a dataset, not a rule)
    if (mode === 'terrain')
      for (const t of w.terrain.zones) {
        const cls = policyAt(w, w.now).values.terrainClasses.find((c) => c.code === t.code);
        L.polygon(ll(t.ring), { color: '#7a5a2b', weight: 1.4, dashArray: '2 5', fill: false, interactive: false, className: 'v3-terrain-zone' }).addTo(g);
        tag(centroid(t.ring), (cls?.label ?? t.code) + (cls?.allowanceM ? ' · +' + cls.allowanceM / 1000 + ' كم' : ''), 'terrain');
      }

    // sites: ONE map object per physical site; its occupants are listed in its card (§6)
    for (const s of w.sites) {
      if (s.state !== 'REGISTERED') continue;
      const occ = occupantsOf(w, s.id);
      const isSel = focusSite === s.id;
      const isRel = related.has(s.id) || inScope.has(s.id);
      const dim = !!(editing || sel?.k === 'req') && !isRel && !isSel;
      const showShape = zoom >= 13 || isSel || isRel;
      if (showShape)
        L.polygon(ll(s.ring), { color: isSel ? '#0f5f8c' : isRel ? '#2f6db0' : '#6d7f86', weight: isSel ? 3 : 1.6, fillOpacity: isSel ? 0.22 : 0.1, dashArray: inScope.has(s.id) ? '6 5' : undefined, className: 'v3-site-shape' })
          .on('click', () => !placing && setSel({ k: 'site', id: s.id }))
          .addTo(g);
      const label = isSel || isRel || zoom >= 13 || (!editing && !orgSel && zoom >= 12);
      L.marker([centroid(s.ring).lat, centroid(s.ring).lng], {
        keyboard: true,
        title: s.name + ' — ' + occ.length + ' وحدة',
        zIndexOffset: isSel ? 800 : 400,
        icon: L.divIcon({
          className: 'v3-pin-icon',
          html: '<div class="v3-pin' + (isSel ? ' sel' : '') + (isRel ? ' rel' : '') + (dim ? ' dim' : '') + (occ.length ? '' : ' empty') + '" data-site="' + s.id + '"><b>' + occ.length + '</b></div>' + (label || busy.has(s.name) ? '<span class="v3-pin-lbl' + (busy.has(s.name) ? ' busy' : '') + '">' + short(s.name) + (isRel && inScope.has(s.id) ? ' · الحالي' : '') + (busy.has(s.name) ? ' · مشغول ✕' : '') + '</span>' : ''),
          iconSize: [0, 0],
        }),
      })
        .on('click', () => !placing && setSel({ k: 'site', id: s.id }))
        .addTo(g);
      if (isSel || (orgSel && related.has(s.id))) keep(s.ring);
    }

    // an organisation: dotted organisational links from its site to its descendants' sites — not shared premises
    if (orgSel) {
      const from = siteOfOrg(w, orgSel);
      for (const d of descendants(w, orgSel)) {
        const to = siteOfOrg(w, d);
        if (!from || !to || to.id === from.id) continue;
        const a = centroid(from.ring);
        const b = centroid(to.ring);
        L.polyline([[a.lat, a.lng], [b.lat, b.lng]], { color: '#5b6b70', weight: 1.6, dashArray: '2 6', interactive: false }).addTo(g);
        tag({ lat: b.lat, lng: b.lng }, orgOf(w, d)!.name + ' · L' + orgOf(w, d)!.level, 'org below');
      }
    }

    // a request (editing or viewing): its geography
    if (r) {
      const c = r.content;
      const pol = policyOfRequest(w, r).values;
      const step: Step | null = editing?.step ?? null;
      for (const a of affectedSites(w, c.scope)) {
        L.polygon(ll(a.site.ring), { color: '#2f6db0', weight: 2.4, dashArray: '6 5', fillOpacity: 0.12, interactive: false }).addTo(g);
        keep(a.site.ring);
      }
      if (step === 'SITE' || step === 'PRIMARY' || step === 'ALTERNATIVE')
        for (const x of conflictRings(w, c.scope)) {
          L.polygon(ll(x.ring), { color: '#b3261e', weight: 2, fillColor: '#e53935', fillOpacity: 0.38, interactive: false, className: 'v3-conflict' }).addTo(g);
        }
      const activated = r.activation ? siteOf(w, r.activation.site) : null;
      const siteRing = activated?.ring ?? c.site?.ring ?? null;
      if (siteRing && step !== 'SITE') {
        L.polygon(ll(siteRing), { color: '#1f9d55', weight: 2.6, fillColor: '#2bb36a', fillOpacity: 0.3, interactive: false }).addTo(g);
        tag(centroid(siteRing), activated ? 'التمركز ' + (c.kind === 'TEMPORARY' ? 'المؤقت' : 'الجديد') : 'الموقع المقترح', 'prop');
        keep(siteRing);
      }
      // guidance bands: the ALLOWED distance, never the area itself (§25)
      const band = (leg: 'primary' | 'alternative', from: Ring) => {
        const l = legCheck(w, pol, leg, from, leg === 'primary' ? c.primary : c.alternative);
        const outer = bandOutline(pol[leg].method, from, l.effective.max);
        const inner = bandOutline(pol[leg].method, from, l.effective.min);
        L.polygon([ll(outer), ll(inner)], { color: '#6a3fa0', weight: 1.4, fillColor: '#8e63c7', fillOpacity: 0.13, dashArray: '8 6', interactive: false, className: 'v3-band ' + leg }).addTo(g);
        if (l.exceptionMax != null) L.polygon(ll(bandOutline(pol[leg].method, from, l.exceptionMax)), { color: '#9a6a00', weight: 1.2, dashArray: '2 6', fill: false, interactive: false }).addTo(g);
        if (l.terrain && l.terrain.cls.allowanceM) L.polygon(ll(bandOutline(pol[leg].method, from, pol[leg].maxM)), { color: '#6a3fa0', weight: 1, dashArray: '1 4', fill: false, interactive: false }).addTo(g);
        const o = outer[Math.floor(outer.length * 0.125)];
        const i = inner[Math.floor(inner.length * 0.125)];
        tag(o, 'حد ' + (leg === 'primary' ? 'الرئيسية' : 'البديلة') + ' الأقصى ' + (l.effective.max / 1000).toLocaleString('ar') + ' كم', 'band');
        tag(i, 'الحد الأدنى ' + (l.effective.min / 1000).toLocaleString('ar') + ' كم', 'band small');
        keep(outer);
      };
      if (step === 'PRIMARY' && c.site) band('primary', c.site.ring);
      if (step === 'ALTERNATIVE' && c.primary) band('alternative', c.primary);
      const areas: [Ring | null, 'primary' | 'alternative'][] = [
        [r.activation ? w.areas.find((a) => a.requestId === r.id && a.role === 'PRIMARY')?.ring ?? null : c.primary, 'primary'],
        [r.activation ? w.areas.find((a) => a.requestId === r.id && a.role === 'ALTERNATIVE')?.ring ?? null : c.alternative, 'alternative'],
      ];
      for (const [ring, role] of areas) {
        if (!ring || (step === 'PRIMARY' && role === 'primary') || (step === 'ALTERNATIVE' && role === 'alternative')) continue;
        L.polygon(ll(ring), { color: role === 'primary' ? '#6a3fa0' : '#9b6fd0', weight: 2.2, fillColor: role === 'primary' ? '#8e63c7' : '#b896e3', fillOpacity: 0.3, dashArray: role === 'alternative' ? '5 4' : undefined, interactive: false }).addTo(g);
        tag(centroid(ring), role === 'primary' ? 'منطقة الانتشار الرئيسية' : 'منطقة الانتشار البديلة', 'area ' + role);
        if (step === 'REVIEW' || sel?.k === 'req') keep(ring);
      }
      if (step === 'SITE' && c.site) keep(c.site.ring);
    }

    // the owner's open question O-04: the same two polygons measured both ways
    if (sel?.k === 'compare') {
      const k = comparison();
      L.polygon(ll(COMPARE_SITE), { color: '#1f9d55', weight: 2.6, fillColor: '#2bb36a', fillOpacity: 0.3, interactive: false }).addTo(g);
      L.polygon(ll(COMPARE_AREA), { color: '#6a3fa0', weight: 2.4, fillColor: '#8e63c7', fillOpacity: 0.28, interactive: false }).addTo(g);
      const c1 = centroid(COMPARE_SITE);
      const c2 = centroid(COMPARE_AREA);
      L.polyline([[c1.lat, c1.lng], [c2.lat, c2.lng]], { color: '#0f5f8c', weight: 3, dashArray: '8 6', interactive: false }).addTo(g);
      L.polyline([[k.near.p.lat, k.near.p.lng], [k.near.q.lat, k.near.q.lng]], { color: '#b5651d', weight: 4, interactive: false }).addTo(g);
      for (const d of [COMPARE_BAND.min, COMPARE_BAND.max]) L.polygon(ll(bandOutline('CENTROID_TO_CENTROID', COMPARE_SITE, d)), { color: '#0f5f8c', weight: 1, dashArray: '2 6', fill: false, interactive: false }).addTo(g);
      tag({ lat: (c1.lat + c2.lat) / 2 + 0.004, lng: (c1.lng + c2.lng) / 2 - 0.006 }, 'أ — من المركز إلى المركز: ' + (k.a / 1000).toLocaleString('ar', { maximumFractionDigits: 2 }) + ' كم ' + (k.aOk ? '✓' : '✕'), 'cmp a');
      tag({ lat: (k.near.p.lat + k.near.q.lat) / 2 - 0.006, lng: (k.near.p.lng + k.near.q.lng) / 2 + 0.004 }, 'ب — من أقرب حافة إلى أقرب حافة: ' + (k.b / 1000).toLocaleString('ar', { maximumFractionDigits: 2 }) + ' كم ' + (k.bOk ? '✓' : '✕'), 'cmp b');
      tag(c1, 'موقع التمركز', 'prop');
      tag(c2, 'منطقة الانتشار الرئيسية', 'area primary');
      keep(COMPARE_SITE);
      keep(COMPARE_AREA);
    }

    const key = fitKey + ':' + (r?.id ?? '') + ':' + (editing?.step ?? '');
    if (key !== lastFit.current && bounds.length) {
      lastFit.current = key;
      if (!placing || editing?.step === 'PRIMARY' || editing?.step === 'ALTERNATIVE') {
        const pad = narrow ? { paddingTopLeft: [40, 60] as L.PointTuple, paddingBottomRight: [40, 260] as L.PointTuple } : { paddingTopLeft: [60, 60] as L.PointTuple, paddingBottomRight: [480, 60] as L.PointTuple };
        map.flyToBounds(L.latLngBounds(bounds), { ...pad, maxZoom: 15, duration: 0.45 });
      }
    }
    return () => void g.remove();
  }, [map, world, sel, mode, zoom, narrow, fitKey, editing, req, placing]);

  const me = personOf(world, actor);
  const ctx: Ctx = {
    w: world,
    actor,
    me,
    sel,
    select: (s) => {
      setNotice(null);
      setSel(s);
    },
    act,
    edit,
    ask: setAsk,
    editor: editorApi,
    legState,
    notice,
    setNotice,
  };

  const scenario = init.sc;
  return (
    <div className={'v3' + (narrow ? ' narrow' : '')}>
      <header className="v3-sim" data-testid="sim">
        <span className="v3-sim-tag">نموذج معزول — بيانات وهمية</span>
        <label>
          السيناريو
          <select value={scenario?.code ?? ''} onChange={(e) => (location.hash = e.target.value ? 's=' + e.target.value : '')} data-testid="scenario">
            <option value="">— بداية نظيفة —</option>
            {SCENARIOS.map((s) => (
              <option key={s.code} value={s.code}>
                {s.code} — {s.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          الشخص (محاكاة)
          <select value={actor} onChange={(e) => setActor(e.target.value)} data-testid="actor">
            {world.people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} — {p.title}
              </option>
            ))}
          </select>
        </label>
        <span className="v3-time" data-testid="time">
          الوقت: {new Date(world.now).toLocaleDateString('ar-AE', { day: 'numeric', month: 'long', year: 'numeric' })}
        </span>
        <button type="button" className="v3-chip" onClick={() => act({ t: 'TICK', ms: 86_400_000 })}>
          +1 يوم
        </button>
        <button type="button" className="v3-chip" onClick={() => act({ t: 'TICK', ms: 7 * 86_400_000 })}>
          +7 أيام
        </button>
        <button type="button" className={'v3-chip' + (sel?.k === 'policy' ? ' on' : '')} onClick={() => setSel({ k: 'policy' })} data-testid="open-policy">
          السياسة والقرارات المفتوحة
        </button>
        <button type="button" className={'v3-chip' + (sel?.k === 'compare' ? ' on' : '')} onClick={() => setSel({ k: 'compare' })}>
          مقارنة قياس المسافة
        </button>
        <button type="button" className={'v3-chip' + (sel?.k === 'links' ? ' on' : '')} onClick={() => setSel({ k: 'links' })}>
          ربط المواقع وOracle
        </button>
      </header>
      {scenario && (
        <p className="v3-scn" data-testid="scenario-note">
          <b>{scenario.code}</b> {scenario.note}
        </p>
      )}
      <div className={'v3-ws' + (placing ? ' placing' : '')}>
        <div ref={mapEl} className="v3-map" data-testid="map" data-mode={mode} />
        <div className="v3-layers" role="radiogroup" aria-label="خلفية الخريطة" data-testid="layers">
          {(
            [
              ['streets', 'الشوارع'],
              ['terrain', 'طبيعة الأرض'],
            ] as const
          ).map(([m, label]) => (
            <button key={m} type="button" role="radio" aria-checked={mode === m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)} data-layer={m}>
              {label}
            </button>
          ))}
          <button type="button" className="v3-legend-btn" aria-expanded={legend} onClick={() => setLegend(!legend)}>
            دليل الرموز
          </button>
        </div>
        {mode === 'terrain' && <p className="v3-terrain-note">تضاريس مولّدة للتوضيح — لا للإنتاج. الإنتاج: FGIC/NSDI بإذن كتابي، أو Copernicus GLO-30 بموافقة المالك (نموذج سطح DSM).</p>}
        {mode === 'streets' && <p className="v3-terrain-note streets">أسماء الطرق: OpenStreetMap (ODbL) — ليست أسماء رسمية.</p>}
        {legend && (
          <div className="v3-legend" data-testid="legend">
            <ul>
              <li><i className="sw site" />موقع فعلي واحد (الرقم: عدد الوحدات فيه)</li>
              <li><i className="sw cur" />الموقع الحالي للوحدات المختارة</li>
              <li><i className="sw prop" />موقع إعادة التمركز المقترح</li>
              <li><i className="sw conflict" />مشغول أو غير متاح — لا يجوز التداخل</li>
              <li><i className="sw band" />نطاق المسافة المسموح (إرشاد، ليس منطقة)</li>
              <li><i className="sw areaP" />منطقة الانتشار الرئيسية</li>
              <li><i className="sw areaA" />منطقة الانتشار البديلة</li>
              <li><i className="sw org" />ارتباط تنظيمي من Oracle — ليس موقعاً مشتركاً</li>
            </ul>
          </div>
        )}
        <aside className={'v3-dock' + (narrow ? ' sheet-' + sheet : '')} data-testid="dock" data-sheet={narrow ? sheet : undefined}>
          {narrow && (
            <button type="button" className="v3-handle" aria-label="تغيير ارتفاع اللوحة" onClick={() => setSheet(sheet === 'collapsed' ? 'medium' : sheet === 'medium' ? 'expanded' : 'collapsed')}>
              <span />
            </button>
          )}
          <Cards ctx={ctx} />
        </aside>
        {notice && (
          <div className="v3-notice" role="alert" data-testid="notice">
            {notice}
            <button type="button" onClick={() => setNotice(null)} aria-label="إغلاق">
              ✕
            </button>
          </div>
        )}
      </div>
      {ask && <ReasonDialog ask={ask} onCancel={() => setAsk(null)} onConfirm={(reason) => (setAsk(null), ask.run(reason))} />}
    </div>
  );
}
