// TMRKZ — polygon-footprint relocation preview (isolated prototype, civilian administrative GIS, fictional data).
//   Mode A: move the existing site footprint (polygon + identity symbol) as one rigid object.
//   Mode B: draw a new footprint by placing N vertices, edit vertices, then move it as one object.
// Geometry: Turf.js (geodesic distance, bearing, area, intersection, self-intersection). A footprint is translated
// RIGIDLY: every vertex keeps its geodesic distance and bearing from the footprint anchor and is rebuilt around the
// new anchor (an azimuthal-equidistant frame centred on the anchor) — not by adding lat/lng offsets.
// The approved geometry is never modified; all preview geometry lives in a dedicated temporary layer.
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import ms from 'milsymbol';
import * as turf from '@turf/turf';
import './footprint.css';
import { OCCUPIED_ZONES, RULE, SITE, SITE_FOOTPRINT, VERTEX_LIMITS, type Ring, type Zone } from './footprint-data';

type P = [number, number]; // [lng, lat]
const toLL = (c: P): L.LatLngTuple => [c[1], c[0]];
const poly = (r: Ring) => turf.polygon([r]);
const areaM2 = (r: Ring) => turf.area(poly(r));
const centroidOf = (r: Ring): P => turf.centroid(poly(r)).geometry.coordinates as P;
const distM = (a: P, b: P) => turf.distance(a, b, { units: 'meters' });
const brg = (a: P, b: P) => turf.bearing(a, b);
const dest = (a: P, m: number, b: number): P => turf.destination(a, m, b, { units: 'meters' }).geometry.coordinates as P;
const fmtM = (m: number) => (m >= 1000 ? (m / 1000).toLocaleString('ar', { maximumFractionDigits: 2, minimumFractionDigits: 2 }) + ' كم' : Math.round(m).toLocaleString('ar') + ' م');
const fmtA = (m2: number) => (m2 >= 1e6 ? (m2 / 1e6).toLocaleString('ar', { maximumFractionDigits: 3 }) + ' كم²' : Math.round(m2).toLocaleString('ar') + ' م²');
const pct = (x: number) => (Math.abs(x) < 0.0005 ? '' : x > 0 ? '+' : '−') + Math.abs(Math.abs(x) < 0.0005 ? 0 : x).toLocaleString('ar', { maximumFractionDigits: 3, minimumFractionDigits: 3 }) + '٪';

// rigid geodesic translation
type Offsets = { d: number; b: number }[];
const offsetsOf = (r: Ring, anchor: P): Offsets => r.map((v) => ({ d: distM(anchor, v), b: brg(anchor, v) }));
const rebuild = (o: Offsets, anchor: P): Ring => o.map((x) => (x.d < 1e-6 ? anchor : dest(anchor, x.d, x.b))) as Ring;
// the naive method, kept only to report how much it would distort the area
const naive = (r: Ring, from: P, to: P): Ring => r.map((v) => [v[0] + (to[0] - from[0]), v[1] + (to[1] - from[1])]) as Ring;

// ---- identity symbol (informational, same renderer as the main app) ----
const symCache = new Map<number, string>();
function sym(size: number) {
  let s = symCache.get(size);
  if (!s) { s = new (ms as unknown as { Symbol: new (s: string, o: object) => { asSVG(): string } }).Symbol(SITE.sidc, { size, standard: 'APP6' }).asSVG(); symCache.set(size, s); }
  return s;
}

// ---- shell ----
const app = document.getElementById('app')!;
app.innerHTML = `
  <header class="fp-top">
    <div class="fp-brand"><span class="fp-logo">⌖</span><b>TMRKZ</b><span class="fp-sub">معاينة نقل حدود الموقع — نموذج</span></div>
    <label class="fp-date">تاريخ بدء الطلب <input id="fp-start" type="date" value="2026-12-01"></label>
  </header>
  <div class="fp-body">
    <main class="fp-mapwrap"><div id="fp-map" role="application" aria-label="الخريطة"></div>
      <div id="fp-hint" class="fp-hint" hidden></div>
      <div class="fp-legend"><b>المفتاح</b>
        <span><i class="sw orig"></i> الحدود المعتمدة (ثابتة)</span>
        <span><i class="sw prop"></i> الحدود المقترحة (معاينة)</span>
        <span><i class="sw ring"></i> النطاق المسموح من الموقع الحالي</span>
        <span><i class="sw occ"></i> منطقة محجوزة في الفترة</span>
        <span><i class="sw shared"></i> موقع مشترك مسموح</span>
        <span><i class="sw over"></i> تداخل</span>
      </div>
    </main>
    <aside id="fp-panel" class="fp-panel" aria-label="لوحة المعاينة"></aside>
  </div>`;

const map = L.map('fp-map', { zoomControl: true, attributionControl: false, minZoom: 11, maxZoom: 19, zoomSnap: 0.25 });
const canvas = L.canvas({ padding: 0.5 });
const svg = L.svg({ padding: 0.5 });

// ---- static, authoritative layers (never touched by a preview) ----
const ORIG_ANCHOR = centroidOf(SITE_FOOTPRINT);
const ORIG_AREA = areaM2(SITE_FOOTPRINT);
const zoneLayer = L.layerGroup().addTo(map);
L.polygon(SITE_FOOTPRINT.map(toLL), { renderer: svg, color: '#2f6db0', weight: 2.5, fillColor: '#4a86c8', fillOpacity: 0.22, interactive: false }).addTo(map);
L.marker(toLL(ORIG_ANCHOR), { interactive: false, zIndexOffset: 500, icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<div class="fp-sym orig"><span class="svg">${sym(32)}</span><span class="lbl">${SITE.org} · الموقع الحالي</span></div>` }) }).addTo(map);
map.fitBounds(L.latLngBounds([...SITE_FOOTPRINT, ...OCCUPIED_ZONES.flatMap((z) => z.ring)].map(toLL)), { padding: [40, 40] });

let startDate = (document.getElementById('fp-start') as HTMLInputElement).value;
const zoneActive = (z: Zone) => z.until == null || startDate < z.until;
function drawZones() {
  zoneLayer.clearLayers();
  for (const z of OCCUPIED_ZONES) {
    const act = zoneActive(z);
    const col = z.shared ? '#c77b1b' : '#c0392b';
    L.polygon(z.ring.map(toLL), { renderer: canvas, color: col, weight: 1.5, dashArray: act ? undefined : '4 5', fillColor: z.shared ? '#e6a24a' : '#e74c3c', fillOpacity: act ? 0.3 : 0.06, interactive: true })
      .bindTooltip(!act ? 'منطقة كانت محجوزة — متاحة في الفترة المختارة' : z.shared ? 'موقع مشترك مسموح لهذه الجهة' : 'منطقة محجوزة في الفترة', { sticky: true })
      .addTo(zoneLayer);
  }
}
drawZones();

// ---- the dedicated temporary preview layer ----
const pv = L.layerGroup().addTo(map);
const rangeRing = L.polygon(
  [turf.circle(ORIG_ANCHOR, RULE.maxM, { units: 'meters', steps: 96 }).geometry.coordinates[0].map((c) => toLL(c as P)), turf.circle(ORIG_ANCHOR, RULE.minM, { units: 'meters', steps: 64 }).geometry.coordinates[0].map((c) => toLL(c as P))],
  { renderer: canvas, color: '#1f9d55', weight: 1.6, dashArray: '8 6', fillColor: '#2bb36a', fillOpacity: 0.06, interactive: false },
);
const propPoly = L.polygon([], { renderer: svg, color: '#1f9d55', weight: 2.5, fillColor: '#2bb36a', fillOpacity: 0.32, bubblingMouseEvents: false, className: 'fp-prop-path' });
const drawLine = L.polyline([], { renderer: svg, color: '#1f9d55', weight: 2.2, dashArray: '5 5', interactive: false });
const overlapLayer = L.geoJSON(undefined, { style: { color: '#7d1d16', weight: 1.5, fillColor: '#b0271c', fillOpacity: 0.65, dashArray: '3 3' }, interactive: false } as L.GeoJSONOptions);
const connector = L.polyline([], { renderer: svg, color: '#16324f', weight: 2, dashArray: '6 6', interactive: false });
const distChip = L.marker([0, 0], { interactive: false, zIndexOffset: 900, icon: L.divIcon({ className: '', iconSize: [0, 0], html: '<span class="fp-chip"></span>' }) });
const propSym = L.marker([0, 0], { interactive: true, zIndexOffset: 1000, keyboard: false, icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<div class="fp-sym prop"><span class="svg">${sym(32)}</span><span class="lbl">مقترح</span></div>` }) });
let vertexMarkers: L.Marker[] = [];
let edgeLabels: L.Marker[] = [];

// ---- state ----
type Mode = 'idle' | 'moveA' | 'drawB';
const st = {
  mode: 'idle' as Mode,
  // Mode A
  offsets: [] as Offsets, // rigid offsets of the footprint around its anchor
  anchor: ORIG_ANCHOR as P,
  // Mode B
  verts: [] as P[], // open list (not closed)
  closed: false,
  target: VERTEX_LIMITS.defaultTarget,
  // shared
  undo: [] as string[],
  redo: [] as string[],
  serverTok: 0,
  serverState: 'none' as 'none' | 'pending' | 'ok' | 'bad',
};
const ring = (): Ring | null => {
  if (st.mode === 'moveA') return rebuild(st.offsets, st.anchor);
  if (st.mode === 'drawB' && st.closed && st.verts.length >= 3) return [...st.verts, st.verts[0]] as Ring;
  return null;
};
const snapshot = () => JSON.stringify({ a: st.anchor, v: st.verts, c: st.closed, o: st.offsets });
function restore(s: string) { const x = JSON.parse(s); st.anchor = x.a; st.verts = x.v; st.closed = x.c; st.offsets = x.o; }
function pushHistory() { st.undo.push(snapshot()); if (st.undo.length > 100) st.undo.shift(); st.redo = []; }

// ---- analysis of the current proposal (pure, local; the server re-checks authoritatively) ----
type Analysis = { r: Ring; area: number; dist: number; inRange: boolean; kinks: number; overlaps: { z: Zone; m2: number; geo: GeoJSON.Feature }[]; blocking: number; sharedOverlap: number; naiveDelta: number; valid: boolean };
function analyse(r: Ring): Analysis {
  const area = areaM2(r);
  const c = centroidOf(r);
  const dist = distM(ORIG_ANCHOR, c);
  const inRange = dist >= RULE.minM && dist <= RULE.maxM;
  const kinks = turf.kinks(poly(r)).features.length;
  const p = poly(r);
  const overlaps: Analysis['overlaps'] = [];
  for (const z of OCCUPIED_ZONES) {
    if (!zoneActive(z)) continue;
    const zp = poly(z.ring);
    if (!turf.booleanIntersects(p, zp)) continue;
    const inter = kinks ? null : turf.intersect(turf.featureCollection([p, zp]));
    overlaps.push({ z, m2: inter ? turf.area(inter) : 0, geo: (inter ?? zp) as GeoJSON.Feature });
  }
  const blocking = overlaps.filter((o) => !o.z.shared).length;
  const sharedOverlap = overlaps.filter((o) => o.z.shared).length;
  let naiveDelta = 0;
  if (st.mode === 'moveA') naiveDelta = (areaM2(naive(SITE_FOOTPRINT, ORIG_ANCHOR, st.anchor)) - ORIG_AREA) / ORIG_AREA * 100;
  return { r, area, dist, inRange, kinks, overlaps, blocking, sharedOverlap, naiveDelta, valid: inRange && !kinks && blocking === 0 && area > 50 };
}

// ---- rendering: mutate the preview layer in place; never rebuild static layers ----
function render() {
  const r = ring();
  overlapLayer.clearLayers();
  if (st.mode === 'drawB') {
    const open = st.verts.map(toLL);
    drawLine.setLatLngs(st.closed ? [] : open);
    syncVertexMarkers();
  }
  if (!r) {
    propPoly.setLatLngs([]); connector.setLatLngs([]); pv.removeLayer(propSym); pv.removeLayer(distChip);
    updateReadouts(null);
    return;
  }
  const a = analyse(r);
  propPoly.setLatLngs(r.map(toLL));
  propPoly.setStyle({ color: a.valid ? '#1f9d55' : '#c0392b', dashArray: a.valid ? undefined : '7 5' });
  for (const o of a.overlaps) if (!o.z.shared) overlapLayer.addData(o.geo);
  const c = centroidOf(r);
  if (!pv.hasLayer(propSym)) pv.addLayer(propSym);
  propSym.setLatLng(toLL(c));
  propSym.getElement()?.querySelector('.fp-sym')?.classList.toggle('bad', !a.valid);
  connector.setLatLngs([toLL(ORIG_ANCHOR), toLL(c)]);
  if (!pv.hasLayer(distChip)) pv.addLayer(distChip);
  distChip.setLatLng(toLL([(ORIG_ANCHOR[0] + c[0]) / 2, (ORIG_ANCHOR[1] + c[1]) / 2]));
  const chip = distChip.getElement()?.querySelector('.fp-chip');
  const t = fmtM(a.dist) + (a.blocking ? ' · تداخل محجوز' : !a.inRange ? ' · خارج النطاق' : a.kinks ? ' · شكل غير صالح' : '');
  if (chip && chip.textContent !== t) { chip.textContent = t; chip.classList.toggle('bad', !a.valid); }
  if (st.mode === 'drawB') syncEdgeLabels(r);
  updateReadouts(a);
}

// vertex markers (Mode B): reused, numbered, draggable
function syncVertexMarkers() {
  while (vertexMarkers.length > st.verts.length) pv.removeLayer(vertexMarkers.pop()!);
  st.verts.forEach((v, i) => {
    let m = vertexMarkers[i];
    if (!m) {
      m = L.marker(toLL(v), { draggable: true, zIndexOffset: 1200, icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<span class="fp-vtx">${i + 1}</span>` }) }).addTo(pv);
      let f = 0;
      m.on('dragstart', () => pushHistory());
      m.on('drag', () => { if (f) return; f = requestAnimationFrame(() => { f = 0; const l = m.getLatLng(); st.verts[i] = [l.lng, l.lat]; render(); }); });
      m.on('dragend', () => { const l = m.getLatLng(); st.verts[i] = [l.lng, l.lat]; render(); afterPlacement(); });
      vertexMarkers[i] = m;
    } else {
      const cur = m.getLatLng();
      if (cur.lat !== v[1] || cur.lng !== v[0]) m.setLatLng(toLL(v));
    }
  });
}
function syncEdgeLabels(r: Ring) {
  const n = r.length - 1;
  while (edgeLabels.length > n) pv.removeLayer(edgeLabels.pop()!);
  for (let i = 0; i < n; i++) {
    const a = r[i], b = r[i + 1];
    const mid = toLL([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
    let m = edgeLabels[i];
    if (!m) { m = L.marker(mid, { interactive: false, zIndexOffset: 700, icon: L.divIcon({ className: '', iconSize: [0, 0], html: '<span class="fp-edge"></span>' }) }).addTo(pv); edgeLabels[i] = m; }
    else m.setLatLng(mid);
    const s = m.getElement()?.querySelector('.fp-edge');
    const t = fmtM(distM(a, b));
    if (s && s.textContent !== t) s.textContent = t;
  }
}

// ---- whole-footprint drag (rigid), from the polygon body or its symbol; the map never pans meanwhile ----
function startBodyDrag(ev: MouseEvent | PointerEvent) {
  if (st.mode === 'drawB' && !st.closed) return;
  ev.preventDefault(); ev.stopPropagation();
  map.dragging.disable();
  pushHistory();
  if (st.mode === 'drawB') { const r = ring()!; st.anchor = centroidOf(r); st.offsets = offsetsOf(r, st.anchor); }
  const grab = map.mouseEventToLatLng(ev as MouseEvent);
  const g: P = [grab.lng, grab.lat];
  const base = st.anchor;
  let pending: P | null = null, frame = 0;
  document.body.classList.add('fp-dragging');
  const move = (e: PointerEvent | MouseEvent) => {
    const l = map.mouseEventToLatLng(e as MouseEvent); pending = [l.lng, l.lat];
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0; if (!pending) return;
      const d = distM(g, pending);
      st.anchor = d < 0.01 ? base : dest(base, d, brg(g, pending));
      if (st.mode === 'drawB') st.verts = rebuild(st.offsets, st.anchor).slice(0, -1) as P[];
      render();
    });
  };
  const up = () => {
    document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up);
    if (frame) cancelAnimationFrame(frame);
    document.body.classList.remove('fp-dragging');
    map.dragging.enable();
    render(); afterPlacement();
  };
  document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
}
propPoly.on('mousedown', (e: L.LeafletMouseEvent) => startBodyDrag(e.originalEvent));
propSym.on('mousedown', (e: L.LeafletMouseEvent) => startBodyDrag(e.originalEvent));

// ---- Mode B: place vertices by clicking the map ----
map.on('click', (e: L.LeafletMouseEvent) => {
  if (st.mode !== 'drawB' || st.closed) return;
  addVertex([e.latlng.lng, e.latlng.lat]);
});
function addVertex(p: P) {
  pushHistory();
  st.verts.push(p);
  if (st.verts.length >= st.target) st.closed = true;
  render();
  if (st.closed) { focusShape(); afterPlacement(); }
}
// once a new footprint is closed, bring it to a scale where its body, symbol and vertex handles are separable
function focusShape() {
  const r = ring();
  if (r) map.flyToBounds(L.latLngBounds(r.map(toLL)), { padding: [140, 140], maxZoom: 17, duration: 0.5 });
}

// ---- simulated server-authoritative check after placement (the preview stays responsive while pending) ----
function afterPlacement() {
  const r = ring();
  if (!r) return;
  const tok = ++st.serverTok;
  st.serverState = 'pending';
  updateServer();
  window.setTimeout(() => {
    if (tok !== st.serverTok) return; // superseded by a newer placement
    st.serverState = analyse(r).valid ? 'ok' : 'bad';
    updateServer();
  }, 450);
}

// ---- modes ----
function enterMoveA() {
  resetPreview();
  st.mode = 'moveA'; st.anchor = ORIG_ANCHOR; st.offsets = offsetsOf(SITE_FOOTPRINT, ORIG_ANCHOR);
  pv.addLayer(rangeRing); pv.addLayer(propPoly); pv.addLayer(overlapLayer); pv.addLayer(connector);
  map.flyToBounds(rangeRing.getBounds(), { padding: [30, 30], duration: 0.6 });
  showHint('اسحب المساحة الخضراء (أو رمزها) لنقل الحدود كاملة — الشكل والمساحة ثابتان · Esc للإلغاء · Ctrl+Z للتراجع');
  buildPanel(); render();
}
function enterDrawB() {
  resetPreview();
  st.mode = 'drawB'; st.verts = []; st.closed = false;
  pv.addLayer(rangeRing); pv.addLayer(propPoly); pv.addLayer(drawLine); pv.addLayer(overlapLayer); pv.addLayer(connector);
  document.getElementById('fp-map')!.classList.add('fp-drawing');
  showHint(`انقر على الخريطة لوضع ${st.target} رؤوس — أو أدخل الإحداثيات · Esc للإلغاء`);
  buildPanel(); render();
}
function resetPreview() {
  pv.clearLayers(); vertexMarkers = []; edgeLabels = [];
  st.undo = []; st.redo = []; st.serverTok++; st.serverState = 'none';
  document.getElementById('fp-map')!.classList.remove('fp-drawing');
}
function cancelAll() { resetPreview(); st.mode = 'idle'; st.verts = []; st.closed = false; st.anchor = ORIG_ANCHOR; hideHint(); buildPanel(); }
function undo() { const s = st.undo.pop(); if (!s) return; st.redo.push(snapshot()); restore(s); render(); afterPlacement(); }
function redo() { const s = st.redo.pop(); if (!s) return; st.undo.push(snapshot()); restore(s); render(); afterPlacement(); }
function resetShape() {
  if (st.mode === 'moveA') { pushHistory(); st.anchor = ORIG_ANCHOR; }
  else if (st.mode === 'drawB') { pushHistory(); st.verts = []; st.closed = false; }
  render(); st.serverTok++; st.serverState = 'none'; updateServer();
}

// ---- panel (built once per mode; readouts updated in place) ----
const panel = document.getElementById('fp-panel')!;
const $ = (id: string) => document.getElementById(id);
function buildPanel() {
  const head = `<div class="fp-site"><span class="svg">${sym(30)}</span><span><b>${SITE.name}</b><small>${SITE.org} · المساحة المعتمدة ${fmtA(ORIG_AREA)}</small></span></div>`;
  const tabs = `<div class="fp-tabs" role="tablist">
      <button role="tab" class="${st.mode === 'moveA' ? 'on' : ''}" id="fp-tA">أ · اقتراح تغيير الموقع</button>
      <button role="tab" class="${st.mode === 'drawB' ? 'on' : ''}" id="fp-tB">ب · رسم حدود جديدة</button></div>`;
  let body = '';
  if (st.mode === 'idle') body = `<p class="fp-muted">اختر «اقتراح تغيير الموقع» لنقل حدود الموقع كاملة، أو «رسم حدود جديدة» لتحديد موقع مقترح برؤوس.</p>`;
  if (st.mode === 'drawB') body += `<div class="fp-row"><label>عدد الرؤوس <input id="fp-n" type="number" min="${VERTEX_LIMITS.min}" max="${VERTEX_LIMITS.max}" value="${st.target}"></label>
      <span class="fp-muted small">بين ${VERTEX_LIMITS.min} و${VERTEX_LIMITS.max}</span></div>
      <div class="fp-row coords"><input id="fp-lat" placeholder="خط العرض" inputmode="decimal"><input id="fp-lng" placeholder="خط الطول" inputmode="decimal"><button class="fp-btn sm" id="fp-add">إضافة رأس</button></div>
      <p id="fp-coord-err" class="fp-err" hidden></p>`;
  if (st.mode !== 'idle') body += `
      <dl class="fp-read" id="fp-read"></dl>
      <div id="fp-why" class="fp-why" hidden></div>
      <div id="fp-server" class="fp-server"></div>
      ${st.mode === 'drawB' ? '<table class="fp-vt"><thead><tr><th>#</th><th>خط العرض</th><th>خط الطول</th><th>الضلع التالي</th></tr></thead><tbody id="fp-vt"></tbody></table>' : ''}
      <div class="fp-tools"><button class="fp-btn sm" id="fp-undo">↶ تراجع</button><button class="fp-btn sm" id="fp-redo">↷ إعادة</button><button class="fp-btn sm" id="fp-reset">إعادة الضبط</button></div>
      <div class="fp-actions"><button class="fp-btn primary" id="fp-ok" disabled>اعتماد المعاينة كمقترح</button><button class="fp-btn" id="fp-cancel">إلغاء</button></div>
      <p class="fp-foot">المعاينة مؤقتة: لا تتغير إحداثيات الموقع ولا حدوده المعتمدة. يعيد الخادم فحص المسافة والإشغال والصلاحيات بعد الوضع وعند الحفظ والإرسال والاعتماد.</p>`;
  panel.innerHTML = head + tabs + body;
  $('fp-tA')!.onclick = enterMoveA;
  $('fp-tB')!.onclick = enterDrawB;
  $('fp-undo') && ($('fp-undo')!.onclick = undo);
  $('fp-redo') && ($('fp-redo')!.onclick = redo);
  $('fp-reset') && ($('fp-reset')!.onclick = resetShape);
  $('fp-cancel') && ($('fp-cancel')!.onclick = cancelAll);
  $('fp-ok') && ($('fp-ok')!.onclick = () => { toast('حُفظت المعاينة كمقترح (نموذج فقط — لا يُكتب شيء).'); cancelAll(); });
  const n = $('fp-n') as HTMLInputElement | null;
  if (n) n.onchange = () => { const v = Math.max(VERTEX_LIMITS.min, Math.min(VERTEX_LIMITS.max, Math.round(Number(n.value) || VERTEX_LIMITS.defaultTarget))); n.value = String(v); st.target = v; if (st.verts.length >= v && !st.closed) { st.closed = true; render(); focusShape(); afterPlacement(); } render(); };
  const add = $('fp-add');
  if (add) add.onclick = () => {
    const lat = Number(($('fp-lat') as HTMLInputElement).value), lng = Number(($('fp-lng') as HTMLInputElement).value);
    const err = $('fp-coord-err')!;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) { err.textContent = 'أدخل خط عرض بين −90 و90 وخط طول بين −180 و180.'; err.hidden = false; return; }
    if (st.closed) { err.textContent = 'اكتمل عدد الرؤوس؛ عدّل رأساً بسحبه أو زِد العدد.'; err.hidden = false; return; }
    err.hidden = true; addVertex([lng, lat]);
  };
}
function updateReadouts(a: Analysis | null) {
  const read = $('fp-read');
  if (!read) return;
  const ok = $('fp-ok') as HTMLButtonElement | null;
  if (!a) {
    read.innerHTML = st.mode === 'drawB' ? `<dt>الرؤوس</dt><dd>${st.verts.length} / ${st.target}</dd>` : '';
    $('fp-why')!.hidden = true;
    if (ok) ok.disabled = true;
    if (st.mode === 'drawB') renderVertexTable(null);
    return;
  }
  const dA = (a.area - ORIG_AREA) / ORIG_AREA * 100;
  const rows: [string, string, string?][] = [
    ['المسافة من الموقع الحالي', fmtM(a.dist), a.inRange ? 'y' : 'n'],
    ['النطاق المسموح', fmtM(RULE.minM) + ' – ' + fmtM(RULE.maxM)],
    ['المساحة المعتمدة', fmtA(ORIG_AREA)],
    ['المساحة المقترحة', fmtA(a.area)],
    ['الفرق في المساحة', pct(dA), st.mode === 'moveA' ? (Math.abs(dA) < 0.01 ? 'y' : 'n') : undefined],
    ['صحة الشكل', a.kinks ? '✕ أضلاع متقاطعة' : '✓ صالح', a.kinks ? 'n' : 'y'],
    ['الإشغال', a.blocking ? '✕ تداخل مع ' + a.blocking + ' منطقة محجوزة' : a.sharedOverlap ? '◐ داخل موقع مشترك مسموح' : '✓ لا تداخل', a.blocking ? 'n' : 'y'],
  ];
  if (st.mode === 'drawB') rows.unshift(['الرؤوس', `${st.verts.length} / ${st.target}`]);
  if (a.overlaps.length) rows.push(['مساحة التداخل', fmtA(a.overlaps.filter((o) => !o.z.shared).reduce((s, o) => s + o.m2, 0))]);
  if (st.mode === 'moveA') rows.push(['لو نُقل بإضافة فروق الإحداثيات', 'فرق المساحة ' + pct(a.naiveDelta), 'muted']);
  read.innerHTML = rows.map(([k, v, c]) => `<dt>${k}</dt><dd class="${c ?? ''}">${v}</dd>`).join('');
  const why = $('fp-why')!;
  const reasons: string[] = [];
  if (!a.inRange) reasons.push(a.dist < RULE.minM ? 'الموقع المقترح أقرب من الحد الأدنى (' + fmtM(RULE.minM) + ').' : 'الموقع المقترح أبعد من الحد الأقصى (' + fmtM(RULE.maxM) + ').');
  if (a.blocking) reasons.push('الحدود المقترحة تتداخل مع منطقة محجوزة في الفترة المختارة (مظللة بالأحمر الداكن).');
  if (a.kinks) reasons.push('بعض الأضلاع تتقاطع؛ اسحب الرؤوس لتصحيح الشكل.');
  if (a.sharedOverlap && !a.blocking) reasons.push('تنبيه: الحدود داخل موقع مشترك مسموح لهذه الجهة — يُسمح بها مع المراجعة.');
  why.innerHTML = reasons.map((r) => '<span>' + r + '</span>').join('');
  why.hidden = reasons.length === 0;
  why.classList.toggle('warn', a.valid);
  if (ok) ok.disabled = !(a.valid && st.serverState === 'ok');
  if (st.mode === 'drawB') renderVertexTable(a.r);
}
function renderVertexTable(r: Ring | null) {
  const tb = $('fp-vt');
  if (!tb) return;
  const vs = r ? r.slice(0, -1) : st.verts;
  tb.innerHTML = vs.map((v, i) => {
    const nx = r ? r[i + 1] : st.verts[i + 1];
    return `<tr><td>${i + 1}</td><td>${v[1].toFixed(6)}</td><td>${v[0].toFixed(6)}</td><td>${nx ? fmtM(distM(v, nx)) : '—'}</td></tr>`;
  }).join('');
}
function updateServer() {
  const el = $('fp-server');
  if (!el) return;
  el.className = 'fp-server ' + st.serverState;
  el.textContent = st.serverState === 'pending' ? '⏳ جارٍ التحقق من الخادم (محاكاة)…' : st.serverState === 'ok' ? '✓ تحقق الخادم: صالح (محاكاة)' : st.serverState === 'bad' ? '✕ تحقق الخادم: غير صالح (محاكاة)' : '';
  const r = ring();
  const ok = $('fp-ok') as HTMLButtonElement | null;
  if (ok) ok.disabled = !(r && analyse(r).valid && st.serverState === 'ok');
}

// ---- hint, toast, keyboard, date ----
const hint = document.getElementById('fp-hint')!;
function showHint(t: string) { hint.textContent = t; hint.hidden = false; }
function hideHint() { hint.hidden = true; }
let toastT = 0;
function toast(t: string) { let el = document.getElementById('fp-toast'); if (!el) { el = document.createElement('div'); el.id = 'fp-toast'; el.className = 'fp-toast'; document.body.appendChild(el); } el.textContent = t; el.classList.add('show'); clearTimeout(toastT); toastT = window.setTimeout(() => el!.classList.remove('show'), 3200); }
window.addEventListener('keydown', (e) => {
  const tag = (e.target as HTMLElement).tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (e.key === 'Escape' && st.mode !== 'idle') { e.preventDefault(); cancelAll(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
});
(document.getElementById('fp-start') as HTMLInputElement).onchange = (e) => { startDate = (e.target as HTMLInputElement).value; drawZones(); render(); afterPlacement(); };

buildPanel();
// diagnostics surface for the automated walkthrough (geometry only)
(window as unknown as { __fp: unknown }).__fp = {
  state: () => { const r = ring(); const a = r ? analyse(r) : null; return { mode: st.mode, verts: st.verts.length, closed: st.closed, server: st.serverState, area: a?.area, origArea: ORIG_AREA, dist: a?.dist, valid: a?.valid, blocking: a?.blocking, kinks: a?.kinks, naiveDelta: a?.naiveDelta }; },
  origRing: () => SITE_FOOTPRINT,
  anchor: ORIG_ANCHOR,
  dest: (lng: number, lat: number, m: number, b: number) => dest([lng, lat], m, b),
  pt: (lng: number, lat: number) => { const p = map.latLngToContainerPoint([lat, lng]); const r = document.getElementById('fp-map')!.getBoundingClientRect(); return { x: r.left + p.x, y: r.top + p.y }; },
  zoom: (z: number) => map.setZoom(z, { animate: false }),
  view: (lng: number, lat: number, z: number) => map.setView([lat, lng], z, { animate: false }),
  getZoom: () => map.getZoom(),
};
