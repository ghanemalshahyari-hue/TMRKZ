import type { GeoJSONSource, Map as MlMap, MapLayerMouseEvent, MapLayerTouchEvent } from 'maplibre-gl';
import type { SiteGeometry } from '../../../api/types';
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
import { addOverlayLayer } from './OfflineMapLibre';

/** What the panel shows about the proposed site, after every frame of a drag (final=false) and once per committed change. */
export type SiteLive = {
  geometry: SiteGeometry | null;
  parts: number;
  areaM2: number;
  partAreas: number[];
  mode: 'move' | 'vertices';
  activePart: number | null;
  activeVertex: number | null;
  ok: boolean;
  problems: string[];
  canUndo: boolean;
  canRedo: boolean;
  /** A vertex of the copy was moved since it was loaded (the shape is then EDITED). */
  vertexEdited: boolean;
};

type Snapshot = Part[];

/**
 * The proposed re-stationing site on the MapLibre map (owner, 4 Nov 2026). Two modes, one at a time:
 * - «move» (the normal journey): the whole site — every part of a MultiPolygon — is dragged as ONE rigid object from
 *   any of its parts, with no handles on the map; every vertex keeps its geodesic offset from the shared anchor
 *   (lib/siteGeometry, the accepted footprint engine's rule);
 * - «vertices» (advanced): choose a part, then drag one of its existing vertices; the other parts never change. No vertex
 *   is added or removed, nothing is split, merged or converted.
 * Undo, redo and reset follow the accepted engine (SiteHistory). Pointer moves are coalesced to one update per animation
 * frame and are validated cheaply (a rigid move keeps validity; a vertex move tests the two edges that changed); the full
 * rules run once the pointer is released. Mouse and touch both drive it; the server re-checks everything.
 */
export class SiteEditor {
  private readonly map: MlMap;
  private readonly onChange: (live: SiteLive, final: boolean) => void;
  private readonly maxAreaM2: () => number | null;
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

  constructor(map: MlMap, options: { onChange: (live: SiteLive, final: boolean) => void; maxAreaM2: () => number | null }) {
    this.map = map;
    this.onChange = options.onChange;
    this.maxAreaM2 = options.maxAreaM2;
    map.addSource('rs-edit', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addSource('rs-edit-vtx', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    addOverlayLayer(map, {
      id: 'rs-edit-fill',
      type: 'fill',
      source: 'rs-edit',
      paint: {
        'fill-color': ['case', ['get', 'bad'], '#e74c3c', '#1f8a4c'],
        'fill-opacity': ['case', ['get', 'active'], 0.42, 0.3],
      },
    }, 'top');
    addOverlayLayer(map, {
      id: 'rs-edit-line',
      type: 'line',
      source: 'rs-edit',
      paint: {
        'line-color': ['case', ['get', 'bad'], '#b03a2e', '#13643a'],
        'line-width': ['case', ['get', 'active'], 3.5, 2],
        'line-dasharray': ['case', ['get', 'bad'], ['literal', [3, 2]], ['literal', [1, 0]]],
      },
    }, 'top');
    addOverlayLayer(map, {
      id: 'rs-edit-vtx',
      type: 'circle',
      source: 'rs-edit-vtx',
      paint: {
        'circle-radius': ['case', ['get', 'active'], 8, 6],
        'circle-color': ['case', ['get', 'active'], '#d9822b', '#ffffff'],
        'circle-stroke-color': '#13643a',
        'circle-stroke-width': 2,
      },
    }, 'top');
    map.on('mousedown', 'rs-edit-fill', this.onBodyDown);
    map.on('touchstart', 'rs-edit-fill', this.onBodyDown);
    map.on('mousedown', 'rs-edit-vtx', this.onVertexDown);
    map.on('touchstart', 'rs-edit-vtx', this.onVertexDown);
    map.on('mouseenter', 'rs-edit-fill', this.onEnterBody);
    map.on('mouseleave', 'rs-edit-fill', this.onLeave);
    map.on('mouseenter', 'rs-edit-vtx', this.onEnterVertex);
    map.on('mouseleave', 'rs-edit-vtx', this.onLeave);
  }

  destroy() {
    if (this.frame) cancelAnimationFrame(this.frame);
    for (const id of ['rs-edit-vtx', 'rs-edit-line', 'rs-edit-fill']) if (this.map.getLayer(id)) this.map.removeLayer(id);
    for (const id of ['rs-edit-vtx', 'rs-edit']) if (this.map.getSource(id)) this.map.removeSource(id);
  }

  /** A new editing session (a copy, a drawn shape or a saved draft): history starts here; nothing → nothing to edit. */
  load(geometry: SiteGeometry | null) {
    this.type = geometry?.type ?? 'Polygon';
    this.parts = geometry ? partsOf(geometry) : [];
    this.activePart = this.parts.length ? 0 : null;
    this.activeVertex = null;
    this.vertexEdited = false;
    this.history.begin(this.copy(this.parts));
    this.render(true);
    // the site being edited in view, close enough to grab a part or a vertex (the accepted engine flies to the copy too)
    if (this.parts.length) {
      const a = anchorOf(this.parts);
      this.map.jumpTo({ center: [a.lng, a.lat], zoom: SiteEditor.ZOOM });
    }
  }

  /** The zoom an editing session opens at: a site of a few hundred metres is large, its surroundings still visible. */
  static readonly ZOOM = 15;

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
    if (!this.dragging) this.map.getCanvas().style.cursor = this.mode === 'move' ? 'move' : 'pointer';
  };
  private readonly onEnterVertex = () => {
    if (!this.dragging && this.mode === 'vertices') this.map.getCanvas().style.cursor = 'grab';
  };
  private readonly onLeave = () => {
    if (!this.dragging) this.map.getCanvas().style.cursor = '';
  };

  /** Move mode: the whole site follows the pointer as one rigid object. Vertex mode: a press on a part selects it. */
  private readonly onBodyDown = (e: MapLayerMouseEvent | MapLayerTouchEvent) => {
    if (!this.parts.length) return;
    if (this.mode === 'vertices') {
      const part = e.features?.[0]?.properties?.part;
      if (typeof part === 'number') this.selectPart(part);
      return;
    }
    if ('originalEvent' in e && e.originalEvent instanceof MouseEvent && e.originalEvent.button !== 0) return;
    e.preventDefault();
    const before = this.copy(this.parts);
    const base = anchorOf(this.parts);
    const offs = groupOffsets(this.parts, base);
    const grab: LatLng = { lat: e.lngLat.lat, lng: e.lngLat.lng };
    let moved = false;
    this.drag(
      (p) => {
        if (!moved) {
          this.history.push(before);
          moved = true;
        }
        const d = distanceM(grab, p);
        this.parts = rebuildGroup(offs, d < 0.01 ? base : destination(base, bearing(grab, p), d));
        // a rigid move keeps the validity and areas; only the occupied-ground and range checks (the server's) can change
        this.render(false, false);
      },
      () => this.render(true),
    );
  };

  /** Vertex mode: one existing vertex of the active part follows the pointer; the other parts are untouched. */
  private readonly onVertexDown = (e: MapLayerMouseEvent | MapLayerTouchEvent) => {
    if (this.mode !== 'vertices' || this.activePart == null) return;
    const f = e.features?.[0]?.properties;
    if (!f || typeof f.index !== 'number' || f.part !== this.activePart) return;
    e.preventDefault();
    const part = this.activePart;
    const ring = f.ring as number;
    const index = f.index as number;
    this.activeVertex = index;
    const before = this.copy(this.parts);
    let moved = false;
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
  };

  /**
   * A drag of the site or of a vertex: the map does not pan meanwhile; updates are coalesced to animation frames. The
   * pointer is followed at window level (mouse, touch and pen alike), so a drag ends wherever the pointer is released —
   * over a map overlay or outside the map — exactly as the accepted footprint engine does.
   */
  private drag(onMove: (p: LatLng) => void, onEnd: () => void) {
    this.dragging = true;
    const canvas = this.map.getCanvas();
    canvas.style.cursor = 'grabbing';
    let pending: LatLng | null = null;
    const move = (ev: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      const ll = this.map.unproject([ev.clientX - r.left, ev.clientY - r.top]);
      pending = { lat: ll.lat, lng: ll.lng };
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
    const bad = !this.last.ok;
    const site = this.map.getSource('rs-edit') as GeoJSONSource | undefined;
    site?.setData({
      type: 'FeatureCollection',
      features: this.parts.map((p, i) => ({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: p.map((r) => [...r, r[0]].map((v) => [v.lng, v.lat])) },
        properties: { part: i, active: this.mode === 'vertices' && i === this.activePart, bad },
      })),
    });
    const vtx = this.map.getSource('rs-edit-vtx') as GeoJSONSource | undefined;
    const p = this.mode === 'vertices' && this.activePart != null ? this.parts[this.activePart] : null;
    vtx?.setData({
      type: 'FeatureCollection',
      features: p
        ? p.flatMap((r, ring) =>
            r.map((v, index) => ({
              type: 'Feature' as const,
              geometry: { type: 'Point' as const, coordinates: [v.lng, v.lat] },
              properties: { part: this.activePart, ring, index, active: index === this.activeVertex && ring === 0 },
            })),
          )
        : [],
    });
    this.onChange(
      {
        geometry: this.parts.length ? toGeometry(this.type, this.parts) : null,
        parts: this.parts.length,
        areaM2: this.last.areaM2,
        partAreas: this.last.partAreas,
        mode: this.mode,
        activePart: this.activePart,
        activeVertex: this.activeVertex,
        ok: this.last.ok,
        problems: this.last.problems,
        canUndo: this.history.canUndo,
        canRedo: this.history.canRedo,
        vertexEdited: this.vertexEdited,
      },
      final,
    );
  }
}
