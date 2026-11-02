// Prototype A — the EXISTING engine (Leaflet 1.9.4), interaction re-architected.
// Same scene as Prototype B. Two modes you can switch live:
//   naive  — reproduces the current workspace pattern: commit state + rebuild the icon (setIcon) on EVERY
//            pointer move, and snap the marker back at the boundary (the "bounce").
//   opt    — the proposed architecture: one imperative interaction layer, rAF-coalesced, no committed-state
//            update and no server call during the gesture, text mutated in place (no setIcon), soft boundary
//            (marker follows the pointer and turns red; confirmation is blocked instead of snapping back).
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { metrics, rafThrottle } from './metrics';
import { CURRENT, OCCUPIED, RANGE_INNER, RANGE_OUTER, RULE, clampToRange, distanceM, formatKm, pointInOccupied, type Facility, type LatLng } from './data';

export type Mode = 'naive' | 'opt';
export type ProtoHandle = { destroy(): void; setMode?(m: Mode): void; onCommit(cb: (c: Commit) => void): void };
export type Commit = { at: LatLng; distanceM: number; inRange: boolean; occupied: string | null; validating: boolean; valid?: boolean };

const ll = (p: LatLng): L.LatLngExpression => [p.lat, p.lng];

export function mountProtoA(el: HTMLElement, facilities: Facility[], initialMode: Mode): ProtoHandle {
  let mode = initialMode;
  metrics.mode = mode;
  let commitCb: (c: Commit) => void = () => {};

  const map = L.map(el, { zoomControl: true, attributionControl: false, preferCanvas: true, minZoom: 9, maxZoom: 18, zoomSnap: 0.5 });
  map.setView(ll(CURRENT.at), 12);
  const canvasRenderer = L.canvas({ padding: 0.5 });

  // ---- static context, built once (never rebuilt during a drag) ----
  const ctx = L.layerGroup().addTo(map);
  // allowed range: outer ring with an inner hole
  L.polygon([RANGE_OUTER.map(ll) as L.LatLngExpression[], RANGE_INNER.map(ll) as L.LatLngExpression[]], {
    renderer: canvasRenderer, color: '#1f9d55', weight: 2, dashArray: '8 6', fillColor: '#2bb36a', fillOpacity: 0.12, interactive: false,
  }).addTo(ctx);
  L.polyline(RANGE_INNER.map(ll) as L.LatLngExpression[], { renderer: canvasRenderer, color: '#c0392b', weight: 1.4, dashArray: '4 6', interactive: false }).addTo(ctx);
  // occupied zones (red)
  for (const z of OCCUPIED) {
    L.polygon(z.ring.map(ll) as L.LatLngExpression[], { renderer: canvasRenderer, color: '#c0392b', weight: 2, fillColor: '#e74c3c', fillOpacity: 0.35, interactive: false }).addTo(ctx);
  }
  // N registered facilities as lightweight canvas dots (not DOM markers) — green free / red busy
  for (const f of facilities) {
    L.circleMarker(ll(f.at), { renderer: canvasRenderer, radius: 4, weight: 1, color: f.busy ? '#b23b36' : '#2f8f6f', fillColor: f.busy ? '#e05a54' : '#45b488', fillOpacity: 0.9, interactive: false }).addTo(ctx);
  }
  // current facility (blue), fixed
  L.marker(ll(CURRENT.at), { interactive: false, zIndexOffset: 800, icon: L.divIcon({ className: 'pA-cur', html: '<span class="pin blue">▣</span><span class="lbl">المقر الحالي</span>', iconSize: [0, 0] }) }).addTo(ctx);

  // ---- the proposal: one draggable marker + one line (the only things that move) ----
  const start = { lat: CURRENT.at.lat, lng: CURRENT.at.lng + (RULE.maxM! * 0.6) / 1000 / 85 }; // ~east, inside range
  const line = L.polyline([ll(CURRENT.at), ll(start)], { renderer: canvasRenderer, color: '#16324f', weight: 2.2, dashArray: '6 6', interactive: false }).addTo(map);
  const icon = L.divIcon({ className: 'pA-prop', html: '<span class="pin green" data-pin>⌖</span><span class="chip" data-chip></span>', iconSize: [0, 0] });
  const marker = L.marker(ll(start), { draggable: true, autoPan: true, zIndexOffset: 1200, icon, keyboard: true, title: 'الموقع المقترح — اسحب' }).addTo(map);
  // naive-mode only: a SEPARATE chip marker whose divIcon is rebuilt via setIcon on every move — this mirrors the
  // current app's distance-chip/bubble markers (StationingPanel setIcon churn). The dragged marker is never rebuilt
  // mid-gesture (the real app toggles its class only), so the drag is not destroyed.
  const naiveChip = L.marker(ll(start), { interactive: false, zIndexOffset: 1250, icon: L.divIcon({ className: 'pA-naivechip', html: '', iconSize: [0, 0] }) });

  const pinEl = () => marker.getElement()?.querySelector('[data-pin]') as HTMLElement | null;
  const chipEl = () => marker.getElement()?.querySelector('[data-chip]') as HTMLElement | null;

  function paint(p: LatLng, clamped: 'MIN' | 'MAX' | null) {
    const d = distanceM(CURRENT.at, p);
    const inRange = d >= RULE.minM && (RULE.maxM == null || d <= RULE.maxM);
    const occ = pointInOccupied(p, OCCUPIED);
    line.setLatLngs([ll(CURRENT.at), ll(p)]);
    const pin = pinEl();
    if (pin) { pin.classList.toggle('bad', !inRange || !!occ); pin.classList.toggle('ok', inRange && !occ); }
    const chip = chipEl();
    if (chip) chip.textContent = formatKm(d) + (occ ? ' · محجوز' : !inRange ? ' · خارج النطاق' : '');
    metrics.setLive({ distanceM: d, inRange, occupied: occ?.name ?? '', clamped: clamped === 'MAX' ? 'الحد الأقصى' : clamped === 'MIN' ? 'الحد الأدنى' : '' });
    return { d, inRange, occ };
  }

  // committed state (the React-equivalent). Updated on drop in opt mode; every move in naive mode.
  function commit(p: LatLng, validating: boolean) {
    const d = distanceM(CURRENT.at, p);
    const inRange = d >= RULE.minM && (RULE.maxM == null || d <= RULE.maxM);
    const occ = pointInOccupied(p, OCCUPIED);
    metrics.countHeavyUpdate();
    commitCb({ at: p, distanceM: d, inRange, occupied: occ?.name ?? null, validating });
  }

  const onMoveOpt = rafThrottle((p: LatLng) => paint(p, null));

  marker.on('dragstart', () => { metrics.beginDrag(); });
  marker.on('drag', () => {
    const raw = marker.getLatLng();
    let p: LatLng = { lat: raw.lat, lng: raw.lng };
    if (mode === 'naive') {
      // CURRENT PATTERN: snap back at the boundary (bounce), rebuild a divIcon every move, commit state every move.
      const c = clampToRange(CURRENT.at, p, RULE.minM, RULE.maxM);
      if (c.clamped) { p = c.point; marker.setLatLng(ll(p)); } // bounce (non-destructive reposition)
      const d = distanceM(CURRENT.at, p);
      const inRange = d >= RULE.minM && (RULE.maxM == null || d <= RULE.maxM);
      const occ = pointInOccupied(p, OCCUPIED);
      line.setLatLngs([ll(CURRENT.at), ll(p)]);
      const pin = pinEl();
      if (pin) { pin.classList.toggle('bad', !inRange || !!occ); pin.classList.toggle('ok', inRange && !occ); }
      naiveChip.setLatLng(ll(p));
      naiveChip.setIcon(L.divIcon({ className: 'pA-naivechip', html: `<span class="chip">${formatKm(d)}${occ ? ' · محجوز' : !inRange ? ' · خارج النطاق' : ''}</span>`, iconSize: [0, 0] })); // DOM rebuild each move
      metrics.setLive({ distanceM: d, inRange, occupied: occ?.name ?? '', clamped: c.clamped === 'MAX' ? 'الحد الأقصى' : c.clamped === 'MIN' ? 'الحد الأدنى' : '' });
      commit(p, false); // committed-state update on every pointer move
    } else {
      // OPTIMISED: soft boundary (no snap), rAF-coalesced, no commit / no icon rebuild during the gesture.
      onMoveOpt(p);
    }
  });
  marker.on('dragend', () => {
    const raw = marker.getLatLng();
    const p: LatLng = { lat: raw.lat, lng: raw.lng };
    paint(p, null);
    commit(p, true);                 // commit once, on drop
    metrics.countServerValidation(); // one authoritative validation, on drop
    window.setTimeout(() => commit(p, false), 160); // simulated server answer
    metrics.endDrag();
  });

  // first paint
  if (mode === 'naive') naiveChip.addTo(map);
  paint(start, null);
  commit(start, false);

  return {
    destroy() { map.remove(); },
    setMode(m) { mode = m; metrics.mode = m; if (m === 'naive') naiveChip.addTo(map); else naiveChip.remove(); },
    onCommit(cb) { commitCb = cb; },
  };
}
