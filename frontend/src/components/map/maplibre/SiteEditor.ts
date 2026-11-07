import type { GeoJSONSource, Map as MlMap, MapLayerMouseEvent, MapLayerTouchEvent, MapMouseEvent, Marker } from 'maplibre-gl';
import type { SiteGeometry } from '../../../api/types';
import { clickVertex, finishDraw, readout, removeLast, sideLabel, startDraw, type DrawReadout, type DrawState } from '../../../lib/drawState';
import { formatMeters } from '../../../lib/footprint';
import { bearing, destination, distanceM, type LatLng } from '../../../lib/geo';
import {
  SiteHistory,
  anchorOf,
  groupOffsets,
  moveVertex,
  partArea,
  partsOf,
  rebuildGroup,
  toGeometry,
  validateSite,
  vertexConflicts,
  type Part,
} from '../../../lib/siteGeometry';
import { OverlayPool, overlay, ownPointer } from './footprintMarkers';
import { addOverlayLayer } from './OfflineMapLibre';
import './footprintEditor.css';

/** What the panel shows about the proposed site, after every frame of a drag (final=false) and once per committed change. */
export type SiteLive = {
  geometry: SiteGeometry | null;
  parts: number;
  areaM2: number;
  partAreas: number[];
  mode: 'move' | 'vertices' | 'draw';
  /** While drawing a new boundary: vertices so far, side lengths, area and validity of the closed shape. */
  draw: DrawReadout | null;
  activePart: number | null;
  activeVertex: number | null;
  ok: boolean;
  problems: string[];
  canUndo: boolean;
  canRedo: boolean;
  /** A vertex of the copy was moved since it was loaded (the shape is then EDITED). */
  vertexEdited: boolean;
  /** While drawing: the number of vertices chosen («عدد الرؤوس»); the shape closes when it is reached. */
  target: number;
  /** While drawing: a vertex taken back can be put again. */
  canRedoDraw: boolean;
};

type Snapshot = Part[];

/** The proposal's mark when the organisation has no symbol (the retired editor's neutral pin). */
export const NEUTRAL_PIN = '<span class="stw-pin green"><i>⌖</i></span>';

// the accepted Stationing editor's colours (retired Leaflet page, approved polygon prototype of 2 Nov 2026)
const GREEN = '#1f9d55';
const GREEN_FILL = '#2bb36a';
const RED = '#c0392b';
const RED_FILL = '#e74c3c';
const NAVY = '#16324f';

/** How the edited shape is drawn and named on the map. */
export type EditorLook = { tag: string; stroke: string; fill: string; symbol: boolean };
export const SITE_LOOK: EditorLook = { tag: 'مقترح', stroke: GREEN, fill: GREEN_FILL, symbol: true };

/** The connector's arrowhead, pointing north before rotation (drawn here, no sprite file), at device pixel ratio 2. */
function arrowImage(hex: string) {
  const n = 28;
  const data = new Uint8Array(n * n * 4);
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      if (y < 3 || y > n - 4 || Math.abs(x + 0.5 - n / 2) > ((y + 1) / n) * (n / 2) * 0.85) continue;
      data.set([r, g, b, 235], (y * n + x) * 4);
    }
  return { width: n, height: n, data };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * The proposed re-stationing site on the MapLibre map (owner, 4 Nov 2026), drawn and handled as the accepted Stationing
 * footprint editor was (owner, 5 Nov 2026: «the previous Stationing map interaction is the one»): a green footprint with
 * the organisation's symbol and the «مقترح» tag at its centre, a dashed connector from the current site with the distance
 * on it, numbered white vertex handles and the length of every side while drawing or editing. Modes, one at a time:
 * - «move» (the normal journey): the whole site — every part of a MultiPolygon — is dragged as ONE rigid object from
 *   any of its parts or from its symbol; every vertex keeps its geodesic offset from the shared anchor (lib/siteGeometry);
 * - «vertices»: choose a part, then drag one of its numbered vertices; the other parts never change. No vertex is added
 *   or removed, nothing is split, merged or converted.
 * - «draw»: a NEW boundary clicked vertex by vertex (numbered, each side measured); it closes on the first vertex, a
 *   double-click, Enter or {@link finishDrawing} once it has three vertices, Backspace removes the last vertex and Esc
 *   cancels. The finished polygon becomes the site and is then moved or edited like a copy.
 * Undo, redo and reset follow the accepted engine (SiteHistory). Pointer moves are coalesced to one update per animation
 * frame and are validated cheaply (a rigid move keeps validity; a vertex move tests the two edges that changed); the full
 * rules run once the pointer is released. Nothing here talks to the server; the server re-checks everything on save.
 */
export class SiteEditor {
  private readonly map: MlMap;
  private readonly onChange: (live: SiteLive, final: boolean) => void;
  private readonly maxAreaM2: () => number | null;
  private readonly onDrawShape: ((shape: LatLng[] | null) => void) | null;
  private type: SiteGeometry['type'] = 'Polygon';
  private parts: Part[] = [];
  private mode: 'move' | 'vertices' = 'move';
  private activePart: number | null = null;
  private activeVertex: number | null = null;
  private vertexEdited = false;
  private readonly history = new SiteHistory<Snapshot>([]);
  private last: { ok: boolean; problems: string[]; areaM2: number; partAreas: number[] } = { ok: true, problems: [], areaM2: 0, partAreas: [] };
  private frame = 0;
  private dragging = false;
  private drawing: DrawState | null = null;
  private pointer: LatLng | null = null;
  private target = 4;
  private drawRedo: LatLng[] = [];
  // on-map overlays, as the retired editor's divIcons
  private symbolHtml = NEUTRAL_PIN;
  private origin: { at: LatLng; label: string | null } | null = null;
  private conflict = false;
  // what is edited: the re-stationing site («مقترح» with the organisation's symbol) or a deployment area (its own tag)
  private look: EditorLook = SITE_LOOK;
  // what the distance chip says: information only for the re-stationing move; a deployment leg's range and verdict
  private distanceLabel: ((d: number) => { text: string; tone: 'ok' | 'warn' | 'bad' | 'none' }) | null = null;
  private readonly prop: { marker: Marker; el: HTMLElement };
  private readonly dist: { marker: Marker; el: HTMLElement };
  private readonly orig: { marker: Marker; el: HTMLElement };
  private readonly shown = { prop: false, dist: false, orig: false };
  private readonly vertices: OverlayPool;
  private readonly edges: OverlayPool;
  /** The (ring, index) of each vertex handle shown in vertex mode, by handle number. */
  private handles: { ring: number; index: number }[] = [];

  /** {@code onDrawShape}: the boundary being drawn on every pointer move, closed through the pointer once it encloses ground (null: not yet). */
  constructor(map: MlMap, options: { onChange: (live: SiteLive, final: boolean) => void; maxAreaM2: () => number | null; onDrawShape?: (shape: LatLng[] | null) => void }) {
    this.map = map;
    this.onChange = options.onChange;
    this.maxAreaM2 = options.maxAreaM2;
    this.onDrawShape = options.onDrawShape ?? null;
    map.addSource('rs-edit', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addSource('rs-edit-link', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    addOverlayLayer(map, {
      id: 'rs-edit-fill',
      type: 'fill',
      source: 'rs-edit',
      paint: { 'fill-color': ['case', ['get', 'bad'], RED_FILL, ['get', 'fill']], 'fill-opacity': 0.32 },
    }, 'top');
    // the selection's halo over 3D terrain (shown only by the 3D look of the request map)
    addOverlayLayer(map, {
      id: 'rs-edit-glow',
      type: 'line',
      source: 'rs-edit',
      layout: { visibility: 'none', 'line-join': 'round' },
      paint: { 'line-color': ['get', 'stroke'], 'line-width': 12, 'line-blur': 7, 'line-opacity': 0.5 },
    }, 'top');
    addOverlayLayer(map, {
      id: 'rs-edit-line',
      type: 'line',
      source: 'rs-edit',
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': ['case', ['get', 'bad'], RED, ['get', 'stroke']],
        'line-width': ['case', ['get', 'active'], 3.2, 2.5],
        'line-dasharray': ['case', ['get', 'bad'], ['literal', [2.8, 2]], ['literal', [1, 0]]],
      },
    }, 'top');
    // the move from the current site, for information: a dashed connector (the distance sits on it)
    addOverlayLayer(map, { id: 'rs-edit-link', type: 'line', source: 'rs-edit-link', paint: { 'line-color': NAVY, 'line-width': 2, 'line-dasharray': [3, 3] } }, 'top');
    // its direction (owner brief «TRUE OFFLINE 3D TERRAIN», §9): an arrowhead short of the edited shape's centre
    if (!map.hasImage('stw-arrow')) map.addImage('stw-arrow', arrowImage(NAVY), { pixelRatio: 2 });
    map.addSource('rs-edit-head', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    addOverlayLayer(map, {
      id: 'rs-edit-head',
      type: 'symbol',
      source: 'rs-edit-head',
      layout: { 'icon-image': 'stw-arrow', 'icon-rotate': ['get', 'rotate'], 'icon-rotation-alignment': 'map', 'icon-pitch-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true },
    }, 'top');
    map.addSource('rs-draw', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    addOverlayLayer(map, { id: 'rs-draw-fill', type: 'fill', source: 'rs-draw', filter: ['==', ['get', 'role'], 'shape'], paint: { 'fill-color': GREEN_FILL, 'fill-opacity': 0.18 } }, 'top');
    addOverlayLayer(map, { id: 'rs-draw-line', type: 'line', source: 'rs-draw', filter: ['==', ['get', 'role'], 'edges'], paint: { 'line-color': GREEN, 'line-width': 2.2, 'line-dasharray': [2.3, 2.3] } }, 'top');
    addOverlayLayer(map, { id: 'rs-draw-rubber', type: 'line', source: 'rs-draw', filter: ['==', ['get', 'role'], 'rubber'], paint: { 'line-color': GREEN, 'line-width': 1.6, 'line-opacity': 0.75, 'line-dasharray': [2.3, 2.3] } }, 'top');

    this.prop = overlay(this.propHtml(), 'stw-prop-symbol');
    this.prop.el.title = 'الموقع المقترح — اسحب الرمز أو المساحة لنقل الحدود كاملة';
    ownPointer(this.prop.el, (e) => {
      if (!this.parts.length || this.drawing) return;
      this.startBodyDrag(this.eventLngLat(e));
    });
    this.dist = overlay('<span></span>', 'stw-dist');
    this.orig = overlay('', 'stw-current');
    this.vertices = new OverlayPool(map, (i) => ({
      html: '<span class="stw-vtx">' + (i + 1) + '</span>',
      className: 'stw-vtx-wrap',
      setup: (el, n) => {
        let dragged = false;
        ownPointer(el, () => {
          dragged = false;
          if (this.drawing) return this.startDrawVertexDrag(n, () => (dragged = true));
          if (this.mode !== 'vertices' || this.activePart == null) return;
          const h = this.handles[n];
          if (h) this.startVertexDrag(this.activePart, h.ring, h.index);
        });
        // while drawing, a click on the first vertex closes the shape; a click on another vertex adds nothing
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          if (!dragged && this.drawing && n === 0 && this.drawing.vertices.length >= 3) this.finishDrawing();
        });
      },
    }));
    this.edges = new OverlayPool(map, () => ({ html: '<span class="stw-edge"></span>', className: 'stw-edge-wrap' }));

    map.on('mousedown', 'rs-edit-fill', this.onBodyDown);
    map.on('touchstart', 'rs-edit-fill', this.onBodyDown);
    map.on('mouseenter', 'rs-edit-fill', this.onEnterBody);
    map.on('mouseleave', 'rs-edit-fill', this.onLeave);
    map.on('zoomend', this.onZoomEnd);
  }

  // whether the proposal still covers the current site's mark depends on the scale
  private readonly onZoomEnd = () => {
    if (!this.dragging) this.renderOverlays();
  };

  destroy() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.endDrawing();
    this.map.off('zoomend', this.onZoomEnd);
    this.vertices.destroy();
    this.edges.destroy();
    for (const o of [this.prop, this.dist, this.orig]) o.marker.remove();
    for (const id of ['rs-draw-rubber', 'rs-draw-line', 'rs-draw-fill', 'rs-edit-head', 'rs-edit-link', 'rs-edit-line', 'rs-edit-glow', 'rs-edit-fill'])
      if (this.map.getLayer(id)) this.map.removeLayer(id);
    for (const id of ['rs-draw', 'rs-edit-head', 'rs-edit-link', 'rs-edit']) if (this.map.getSource(id)) this.map.removeSource(id);
  }

  // ---- what is shown around the site -----------------------------------------------------------------------------

  /** The organisation's symbol (an image tag), shown on the proposal and on the current site; null: the neutral pin. */
  setSymbol(html: string | null) {
    this.symbolHtml = html ?? NEUTRAL_PIN;
    this.prop.el.innerHTML = this.propHtml();
    this.orig.el.innerHTML = this.origHtml();
    this.renderOverlays();
  }

  /**
   * Where the distance is measured from (the connector and its chip): the current site while the new site is placed,
   * its centre and name; a deployment area's leg start (no tag of its own: the map already names it).
   */
  setOrigin(origin: { at: LatLng; label: string | null } | null) {
    this.origin = origin;
    this.orig.el.innerHTML = this.origHtml();
    this.renderOverlays();
  }

  /** The shape being edited: the re-stationing site, or a deployment area with its own tag and colour. */
  setLook(look: EditorLook) {
    this.look = look;
    this.prop.el.innerHTML = this.propHtml();
    this.render(false, false);
  }

  /** The distance chip's words and colour (the page knows the leg's band; the server decides on save). */
  setDistanceLabel(label: ((d: number) => { text: string; tone: 'ok' | 'warn' | 'bad' | 'none' }) | null) {
    this.distanceLabel = label;
    this.renderOverlays();
  }

  /**
   * «تحديد الموقع على الخريطة»: the whole shape — every part of a MultiPolygon, as one rigid group — moves so that its
   * centre lands on the point the user clicked (a faster drag over a long distance); one undoable change.
   */
  moveTo(p: LatLng) {
    if (!this.parts.length || this.drawing) return;
    this.history.push(this.copy(this.parts));
    this.parts = rebuildGroup(groupOffsets(this.parts, anchorOf(this.parts)), p);
    this.render(true);
  }

  /** The proposal overlaps occupied ground (the page's immediate check; the server decides): drawn red, as before. */
  setConflict(on: boolean) {
    if (this.conflict === on) return;
    this.conflict = on;
    this.render(false, false);
  }

  /** The proposal in view, close up. */
  focus() {
    const pts = this.drawing?.vertices.length ? this.drawing.vertices : this.parts.flat(2);
    if (pts.length) this.fit(pts, 0.6, 17);
  }

  /** Both locations in view: the current site and the proposal. */
  compare() {
    const pts = [...this.parts.flat(2), ...(this.origin ? [this.origin.at] : [])];
    if (pts.length) this.fit(pts, 0.25, 17);
  }

  private fit(pts: LatLng[], pad: number, maxZoom: number) {
    const lngs = pts.map((p) => p.lng);
    const lats = pts.map((p) => p.lat);
    const [w, e, s, n] = [Math.min(...lngs), Math.max(...lngs), Math.min(...lats), Math.max(...lats)];
    const dx = (e - w) * pad || 0.002;
    const dy = (n - s) * pad || 0.002;
    this.map.fitBounds([[w - dx, s - dy], [e + dx, n + dy]], { maxZoom, duration: 400, padding: { top: 50, right: 50, bottom: 170, left: 70 } });
  }

  private propHtml() {
    const tag = '<span class="lbl" style="background:' + this.look.stroke + ';border-color:' + this.look.stroke + '">' + esc(this.look.tag) + '</span>';
    return '<div class="stw-prop-sym' + (this.conflict || !this.last.ok ? ' bad' : '') + '">' + (this.look.symbol ? this.symbolHtml : '') + tag + '</div>';
  }

  private origHtml() {
    if (!this.origin?.label) return '';
    const sym = this.symbolHtml === NEUTRAL_PIN ? '<span class="stw-pin blue"><i>⌖</i></span>' : this.symbolHtml;
    return '<div class="stw-orig-sym">' + sym + '<span class="lbl">' + esc(this.origin.label) + '</span></div>';
  }

  // ---- drawing a new boundary --------------------------------------------------------------------------------------

  /**
   * Starts drawing a new boundary of {@code target} vertices (the retired editor's «عدد الرؤوس»): each map click places
   * the next numbered vertex and the shape closes when the count is reached. The current site, if any, is kept until
   * the drawing finishes; optionally centred.
   */
  startDrawing(centre?: LatLng | null, target = this.target) {
    this.endDrawing();
    this.target = Math.max(3, Math.min(20, Math.round(target)));
    this.drawing = startDraw();
    this.drawRedo = [];
    this.pointer = null;
    this.map.doubleClickZoom.disable();
    this.map.on('click', this.onDrawClick);
    this.map.on('mousemove', this.onDrawMove);
    this.map.on('dblclick', this.onDrawDouble);
    window.addEventListener('keydown', this.onDrawKey);
    this.map.getContainer().classList.add('stw-drawing');
    // as the retired editor: the map flies to the current site at its drawing scale (Leaflet zoom 14 = MapLibre 13)
    if (centre) this.map.easeTo({ center: [centre.lng, centre.lat], zoom: SiteEditor.DRAW_ZOOM, duration: 400 });
    this.renderOverlays();
    this.renderDraw();
  }

  /** The number of vertices to draw; fewer than already placed closes the shape at once (as the retired editor did). */
  setTarget(n: number) {
    this.target = Math.max(3, Math.min(20, Math.round(n)));
    if (!this.drawing) return this.emit(false, null);
    if (this.drawing.vertices.length >= this.target) {
      this.drawing = { vertices: this.drawing.vertices.slice(0, this.target) };
      this.finishDrawing();
    } else this.renderDraw();
  }

  get drawTarget(): number {
    return this.target;
  }

  /** The next vertex typed as coordinates (an optional, precise alternative to a map click). */
  addVertex(p: LatLng) {
    if (!this.drawing) return;
    this.drawing = { vertices: [...this.drawing.vertices, p] };
    this.drawRedo = [];
    this.afterVertex();
  }

  /** Removes the last vertex drawn («تراجع» while drawing). */
  undoVertex() {
    if (!this.drawing) return;
    const last = this.drawing.vertices.at(-1);
    this.drawing = removeLast(this.drawing);
    if (last) this.drawRedo.push(last);
    this.renderDraw();
  }

  /** Puts back the last vertex taken back («إعادة» while drawing). */
  redoVertex() {
    const p = this.drawRedo.pop();
    if (!this.drawing || !p) return;
    this.drawing = { vertices: [...this.drawing.vertices, p] };
    this.afterVertex();
  }

  /** «إعادة الضبط» while drawing: no vertex placed yet. */
  restartDrawing() {
    if (!this.drawing) return;
    this.drawing = startDraw();
    this.drawRedo = [];
    this.renderDraw();
  }

  private afterVertex() {
    if (this.drawing && this.drawing.vertices.length >= this.target) this.finishDrawing();
    else this.renderDraw();
  }

  /** A drawing vertex moved on the map (the retired editor's handles were draggable while drawing). */
  private startDrawVertexDrag(i: number, onMoved: () => void) {
    if (!this.drawing?.vertices[i]) return;
    this.drag(
      (p) => {
        if (!this.drawing) return;
        onMoved();
        this.drawing = { vertices: this.drawing.vertices.map((v, j) => (j === i ? p : v)) };
        this.renderDraw(false);
      },
      () => this.renderDraw(),
    );
  }

  /** Closes the shape (three vertices or more, not crossing itself): it becomes the site, a new editing session. */
  finishDrawing() {
    if (!this.drawing) return;
    const ring = finishDraw(this.drawing, this.maxAreaM2());
    if (!ring) return this.renderDraw();
    this.endDrawing();
    this.type = 'Polygon';
    this.parts = [[ring]];
    // a finished drawing keeps its numbered vertices on, as the retired editor's draw mode did
    this.mode = 'vertices';
    this.activePart = 0;
    this.activeVertex = null;
    this.vertexEdited = false;
    this.history.begin(this.copy(this.parts));
    this.render(true);
    // the closed shape in view, as the retired editor flew to it once its last vertex was placed
    this.focus();
  }

  /** Esc: the drawing is dropped; the site stays as it was before the drawing started. */
  cancelDrawing() {
    if (!this.drawing) return;
    this.endDrawing();
    this.render(true);
  }

  get isDrawing(): boolean {
    return this.drawing != null;
  }

  private endDrawing() {
    if (!this.drawing) return;
    this.drawing = null;
    this.pointer = null;
    this.map.off('click', this.onDrawClick);
    this.map.off('mousemove', this.onDrawMove);
    this.map.off('dblclick', this.onDrawDouble);
    window.removeEventListener('keydown', this.onDrawKey);
    this.map.doubleClickZoom.enable();
    this.map.getContainer().classList.remove('stw-drawing');
    (this.map.getSource('rs-draw') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: [] });
    this.vertices.clear();
    this.edges.clear();
  }

  private readonly onDrawClick = (e: MapMouseEvent) => {
    if (!this.drawing) return;
    const first = this.drawing.vertices[0];
    let onFirst = false;
    if (first && this.drawing.vertices.length >= 3) {
      const p = this.map.project([first.lng, first.lat]);
      onFirst = Math.hypot(p.x - e.point.x, p.y - e.point.y) <= 12;
    }
    const r = clickVertex(this.drawing, { lat: e.lngLat.lat, lng: e.lngLat.lng }, onFirst);
    if (r.state !== this.drawing) this.drawRedo = [];
    this.drawing = r.state;
    // the shape closes on the first vertex, or by itself once the chosen number of vertices is placed
    if (r.finish) this.finishDrawing();
    else this.afterVertex();
  };

  private readonly onDrawMove = (e: MapMouseEvent) => {
    if (!this.drawing) return;
    this.pointer = { lat: e.lngLat.lat, lng: e.lngLat.lng };
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.renderDraw(false);
    });
  };

  private readonly onDrawDouble = (e: MapMouseEvent) => {
    e.preventDefault();
    this.finishDrawing();
  };

  private readonly onDrawKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.key === 'Enter') this.finishDrawing();
    else if (e.key === 'Backspace') {
      e.preventDefault();
      this.undoVertex();
    } else if (e.key === 'Escape') this.cancelDrawing();
  };

  /** The drawing on the map as the retired editor drew it: numbered vertices, each side measured, the open line dashed. */
  private renderDraw(emit = true) {
    if (!this.drawing) return;
    const v = this.drawing.vertices;
    const ll = (p: LatLng) => [p.lng, p.lat];
    const features: GeoJSON.Feature[] = [];
    const r = readout(this.drawing, this.maxAreaM2());
    if (v.length >= 3) features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[...v, v[0]].map(ll)] }, properties: { role: 'shape' } });
    if (v.length >= 2) features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: v.map(ll) }, properties: { role: 'edges' } });
    if (this.pointer && v.length >= 1) {
      const rubber = v.length >= 2 ? [v.at(-1)!, this.pointer, v[0]] : [v[0], this.pointer];
      features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: rubber.map(ll) }, properties: { role: 'rubber' } });
    }
    (this.map.getSource('rs-draw') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features });
    const closable = v.length >= 3;
    this.vertices.sync(v.length, (i) => v[i], (el, i) => {
      const s = el.firstElementChild as HTMLElement;
      s.className = 'stw-vtx' + (i === 0 ? ' first' + (closable ? ' closable' : '') : ' static');
      s.title = i === 0 && closable ? 'انقر هنا لإغلاق الحدود' : 'الرأس ' + (i + 1);
    });
    const sides = v.length >= 3 ? r.sides : v.length === 2 ? [distanceM(v[0], v[1])] : [];
    this.edges.sync(
      sides.length,
      (i) => {
        const a = v[i];
        const b = v[(i + 1) % v.length];
        return { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
      },
      (el, i) => this.text(el.firstElementChild as HTMLElement, sideLabel(sides[i])),
    );
    if (emit) this.emit(false, r);
    const open = this.pointer ? [...v, this.pointer] : v;
    this.onDrawShape?.(open.length >= 3 ? open : null);
  }

  /** A new editing session (a copy, a drawn shape or a saved draft): history starts here; nothing → nothing to edit. */
  load(geometry: SiteGeometry | null, fly = true) {
    this.type = geometry?.type ?? 'Polygon';
    this.parts = geometry ? partsOf(geometry) : [];
    this.activePart = this.parts.length ? 0 : null;
    this.activeVertex = null;
    this.vertexEdited = false;
    this.history.begin(this.copy(this.parts));
    this.render(true);
    // the site being edited in view, close enough to grab a part or a vertex (the accepted engine flies to the copy too)
    if (fly && this.parts.length) {
      const a = anchorOf(this.parts);
      this.map.jumpTo({ center: [a.lng, a.lat], zoom: SiteEditor.ZOOM });
    }
  }

  /** The zoom an editing session opens at: a site of a few hundred metres is large, its surroundings still visible. */
  static readonly ZOOM = 15;

  /** The zoom a new drawing starts at (the retired editor's Leaflet zoom 14: 8.7 m a pixel here). */
  static readonly DRAW_ZOOM = 13;

  /** The full rules again without a change (e.g. the server's maximum footprint became known). */
  refresh() {
    this.render(true);
  }

  setMode(mode: 'move' | 'vertices') {
    this.mode = mode;
    this.activeVertex = null;
    if (mode === 'vertices' && this.activePart == null && this.parts.length) this.activePart = 0;
    // presentation only: not a committed geometry change
    this.render(false, false);
  }

  selectPart(i: number) {
    if (!this.parts[i]) return;
    this.activePart = i;
    this.activeVertex = null;
    this.render(false, false);
  }

  /** One vertex set from the coordinates table (an optional, precise alternative to dragging it). */
  setVertex(part: number, ring: number, index: number, p: LatLng) {
    if (!this.parts[part]?.[ring]?.[index]) return;
    this.history.push(this.copy(this.parts));
    this.parts = moveVertex(this.parts, part, ring, index, p);
    this.vertexEdited = true;
    this.activeVertex = ring === 0 ? index : null;
    this.render(true);
  }

  undo() {
    const s = this.history.undo(this.copy(this.parts));
    if (s) this.restore(s);
  }

  redo() {
    const s = this.history.redo(this.copy(this.parts));
    if (s) this.restore(s);
  }

  /** Back to where this session began (the copy, the drawn shape or the saved draft); undoable. */
  reset() {
    this.restore(this.history.reset(this.copy(this.parts)));
  }

  // ---- pointer handling ----------------------------------------------------------------------------------------

  private readonly onEnterBody = () => {
    if (!this.dragging && !this.drawing) this.map.getCanvas().style.cursor = this.mode === 'move' ? 'move' : 'pointer';
  };
  private readonly onLeave = () => {
    if (!this.dragging) this.map.getCanvas().style.cursor = '';
  };

  private eventLngLat(e: PointerEvent): LatLng {
    const r = this.map.getCanvas().getBoundingClientRect();
    const ll = this.map.unproject([e.clientX - r.left, e.clientY - r.top]);
    return { lat: ll.lat, lng: ll.lng };
  }

  /** Move mode: the whole site follows the pointer as one rigid object. Vertex mode: a press on a part selects it. */
  private readonly onBodyDown = (e: MapLayerMouseEvent | MapLayerTouchEvent) => {
    if (!this.parts.length || this.drawing) return;
    // vertex mode: a press on another part chooses it; on the active part (or the only one) the whole site still moves,
    // as the retired editor let the body be dragged while its vertices were shown
    if (this.mode === 'vertices') {
      const part = e.features?.[0]?.properties?.part;
      if (typeof part === 'number' && part !== this.activePart && this.parts.length > 1) return this.selectPart(part);
    }
    if ('originalEvent' in e && e.originalEvent instanceof MouseEvent && e.originalEvent.button !== 0) return;
    e.preventDefault();
    this.startBodyDrag({ lat: e.lngLat.lat, lng: e.lngLat.lng });
  };

  private startBodyDrag(grab: LatLng) {
    const before = this.copy(this.parts);
    const base = anchorOf(this.parts);
    const offs = groupOffsets(this.parts, base);
    let moved = false;
    this.drag(
      (p) => {
        if (!moved) {
          this.history.push(before);
          moved = true;
        }
        const d = distanceM(grab, p);
        this.parts = rebuildGroup(offs, d < 0.01 ? base : destination(base, bearing(grab, p), d));
        // a rigid move keeps the validity and areas; only the occupied-ground check (and the server's) can change
        this.render(false, false);
      },
      () => this.render(true),
    );
  }

  /** Vertex mode: one existing vertex of the active part follows the pointer; the other parts are untouched. */
  private startVertexDrag(part: number, ring: number, index: number) {
    this.activeVertex = index;
    const before = this.copy(this.parts);
    let moved = false;
    this.render(false, false);
    this.drag(
      (p) => {
        if (!moved) {
          this.history.push(before);
          moved = true;
          this.vertexEdited = true;
        }
        this.parts = moveVertex(this.parts, part, ring, index, p);
        const areas = this.parts.map((pt, i) => (i === part ? partArea(pt) : this.last.partAreas[i] ?? partArea(pt)));
        const bad = vertexConflicts(this.parts, part, ring, index);
        this.last = { ...this.last, ok: !bad && this.last.ok, problems: bad ? ['حدود متقاطعة أو متداخلة'] : this.last.problems, partAreas: areas, areaM2: areas.reduce((s, a) => s + a, 0) };
        this.render(false, false);
      },
      () => this.render(true),
    );
  }

  /**
   * A drag of the site or of a vertex: the map does not pan meanwhile; updates are coalesced to animation frames. The
   * pointer is followed at window level (mouse, touch and pen alike), so a drag ends wherever the pointer is released —
   * over a map overlay or outside the map — exactly as the accepted footprint engine does.
   */
  private drag(onMove: (p: LatLng) => void, onEnd: () => void) {
    this.dragging = true;
    const canvas = this.map.getCanvas();
    canvas.style.cursor = 'grabbing';
    document.body.classList.add('stw-dragging');
    let pending: LatLng | null = null;
    const move = (ev: PointerEvent) => {
      pending = this.eventLngLat(ev);
      if (this.frame) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        if (pending) onMove(pending);
      });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (this.frame) {
        cancelAnimationFrame(this.frame);
        this.frame = 0;
        if (pending) onMove(pending);
      }
      this.dragging = false;
      canvas.style.cursor = '';
      document.body.classList.remove('stw-dragging');
      onEnd();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  // ---- state ---------------------------------------------------------------------------------------------------

  private copy(parts: Part[]): Part[] {
    return parts.map((p) => p.map((r) => r.map((v) => ({ ...v }))));
  }

  private restore(s: Snapshot) {
    this.parts = this.copy(s);
    if (this.activePart != null && this.activePart >= this.parts.length) this.activePart = this.parts.length ? 0 : null;
    this.activeVertex = null;
    this.render(true);
  }

  /** {@code validate}: run the full rules (on a committed change); otherwise keep the last result (cheap frames). */
  private render(final: boolean, validate = final) {
    if (validate) {
      const v = this.parts.length ? validateSite(this.parts, this.maxAreaM2()) : { ok: false, problems: [], areaM2: 0, partAreas: [] };
      this.last = { ok: v.ok, problems: v.problems, areaM2: v.areaM2, partAreas: v.partAreas };
    }
    const bad = !this.last.ok || this.conflict;
    const site = this.map.getSource('rs-edit') as GeoJSONSource | undefined;
    site?.setData({
      type: 'FeatureCollection',
      features: this.parts.map((p, i) => ({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: p.map((r) => [...r, r[0]].map((v) => [v.lng, v.lat])) },
        properties: { part: i, active: this.mode === 'vertices' && i === this.activePart, bad, stroke: this.look.stroke, fill: this.look.fill },
      })),
    });
    this.renderOverlays();
    this.emit(final, null);
  }

  /** The symbol and «مقترح», the connector and its distance, the vertex handles and side lengths (vertex mode). */
  private renderOverlays() {
    const show = (k: keyof typeof this.shown, o: { marker: Marker }, at: LatLng | null) => {
      if (at) {
        o.marker.setLngLat([at.lng, at.lat]);
        if (!this.shown[k]) o.marker.addTo(this.map);
      } else if (this.shown[k]) o.marker.remove();
      this.shown[k] = !!at;
    };
    show('orig', this.orig, this.origin?.label ? this.origin.at : null);
    const anchor = this.parts.length && !this.drawing ? anchorOf(this.parts) : null;
    // the copy still on the current site: the current site keeps its name tag, the proposal's symbol is the one shown
    if (this.origin) {
      const a = anchor ? this.map.project([anchor.lng, anchor.lat]) : null;
      const o = this.map.project([this.origin.at.lng, this.origin.at.lat]);
      this.orig.el.classList.toggle('near', !!a && Math.hypot(a.x - o.x, a.y - o.y) < 70);
    }
    show('prop', this.prop, anchor);
    this.prop.el.firstElementChild?.classList.toggle('bad', !this.last.ok || this.conflict);
    const d = anchor && this.origin ? distanceM(this.origin.at, anchor) : 0;
    const link = this.map.getSource('rs-edit-link') as GeoJSONSource | undefined;
    const head = this.map.getSource('rs-edit-head') as GeoJSONSource | undefined;
    if (anchor && this.origin && d >= 1) {
      const o = this.origin.at;
      link?.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[o.lng, o.lat], [anchor.lng, anchor.lat]] }, properties: {} });
      const b = bearing(o, anchor);
      const h = destination(o, b, d * 0.9);
      head?.setData({ type: 'Feature', geometry: { type: 'Point', coordinates: [h.lng, h.lat] }, properties: { rotate: b } });
      show('dist', this.dist, { lat: (o.lat + anchor.lat) / 2, lng: (o.lng + anchor.lng) / 2 });
      const label = this.distanceLabel ? this.distanceLabel(d) : { text: formatMeters(d), tone: 'none' as const };
      this.text(this.dist.el.firstElementChild as HTMLElement, label.text);
      this.dist.el.classList.toggle('y', label.tone === 'ok');
      this.dist.el.classList.toggle('w', label.tone === 'warn');
      this.dist.el.classList.toggle('n', label.tone === 'bad');
    } else {
      link?.setData({ type: 'FeatureCollection', features: [] });
      head?.setData({ type: 'FeatureCollection', features: [] });
      show('dist', this.dist, null);
    }
    if (this.drawing) return;
    const part = this.mode === 'vertices' && this.activePart != null ? this.parts[this.activePart] : null;
    if (!part) {
      this.handles = [];
      this.vertices.clear();
      this.edges.clear();
      return;
    }
    this.handles = part.flatMap((r, ring) => r.map((_, index) => ({ ring, index })));
    const vertexAt = (h: { ring: number; index: number }) => part[h.ring][h.index];
    this.vertices.sync(this.handles.length, (i) => vertexAt(this.handles[i]), (el, i) => {
      const h = this.handles[i];
      const s = el.firstElementChild as HTMLElement;
      s.className = 'stw-vtx' + (h.ring === 0 && h.index === this.activeVertex ? ' on' : '');
      this.text(s, String(h.index + 1));
      s.title = 'الرأس ' + (h.index + 1) + (h.ring > 0 ? ' (فراغ داخلي)' : '');
    });
    const sides = part.flatMap((r) => r.map((a, i) => [a, r[(i + 1) % r.length]] as const));
    this.edges.sync(
      sides.length,
      (i) => ({ lat: (sides[i][0].lat + sides[i][1].lat) / 2, lng: (sides[i][0].lng + sides[i][1].lng) / 2 }),
      (el, i) => this.text(el.firstElementChild as HTMLElement, formatMeters(distanceM(sides[i][0], sides[i][1]))),
    );
  }

  private text(el: HTMLElement | null, t: string) {
    if (el && el.textContent !== t) el.textContent = t;
  }

  private emit(final: boolean, draw: DrawReadout | null) {
    this.onChange(
      {
        geometry: this.parts.length ? toGeometry(this.type, this.parts) : null,
        parts: this.parts.length,
        areaM2: this.last.areaM2,
        partAreas: this.last.partAreas,
        mode: this.drawing ? 'draw' : this.mode,
        // any refresh while drawing carries the drawing's readout too
        draw: this.drawing ? (draw ?? readout(this.drawing, this.maxAreaM2())) : null,
        activePart: this.activePart,
        activeVertex: this.activeVertex,
        ok: this.last.ok,
        problems: this.last.problems,
        canUndo: this.history.canUndo,
        canRedo: this.history.canRedo,
        vertexEdited: this.vertexEdited,
        target: this.target,
        canRedoDraw: this.drawRedo.length > 0,
      },
      final,
    );
  }
}
