import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl';
import type { Part } from '../../../lib/siteGeometry';
import { slopeZones, type SlopeLimits, type SlopeTone, type SlopeZones } from '../../../lib/terrainRgb';
import type { DemSampler } from './terrain3d';

const SOURCE = 'rs-slope-zones';
const LAYER = 'rs-slope-zones';
/** The request's lines and everything above them stay over the colours; the shapes' own tint gives way to them. */
const BEFORE = 'rs-glow';

/** What is being placed in the request; the current site and what is already deployed are never coloured. */
export type SlopeShape = 'site' | 'primary' | 'alternative';
export type SlopeResult = { shape: SlopeShape; shares: Record<SlopeTone, number>; tone: SlopeTone | null; live: boolean };

/**
 * «الانحدار» inside the shapes being placed (owner, 6 Nov 2026; ADR-039): the ground under each, and only there, in green,
 * orange or red by the administrator's limits, following every frame of a drag, a vertex edit or a new boundary being
 * drawn, in 2D and draped in 3D. DISPLAY ONLY: computed in the browser from the 3D view's elevation tiles, nothing is sent
 * or saved, no rule reads it and it blocks nothing; the class the rules use is the server's, from the native analysis.
 */
export class SlopeInside {
  private readonly shapes = new Map<SlopeShape, { parts: Part[] | null; zones: SlopeZones | null; live: boolean; dirty: boolean }>();
  private active: SlopeShape = 'site';
  private waiting = false;
  private readonly subscribers = new Set<(r: SlopeResult) => void>();

  constructor(private readonly map: MlMap, private readonly sampler: DemSampler, private readonly limits: SlopeLimits) {
    map.addSource(SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, tolerance: 0 });
    // no antialiasing: neighbouring runs share their edges, so no hairline shows between them
    map.addLayer({ id: LAYER, type: 'fill', source: SOURCE, paint: { 'fill-color': ['get', 'colour'], 'fill-opacity': 0.72, 'fill-antialias': false } }, map.getLayer(BEFORE) ? BEFORE : undefined);
    // the edited shape's tint gives way to the colours; a problem (red) still shows over them
    if (map.getLayer('rs-edit-fill')) map.setPaintProperty('rs-edit-fill', 'fill-opacity', ['case', ['get', 'bad'], 0.32, 0]);
    if (map.getLayer('rs-draw-fill')) map.setPaintProperty('rs-draw-fill', 'fill-opacity', 0);
  }

  /** A shape now (null: none). Called on every frame of a drag: the tiles it needs are read once, then it is immediate. */
  update(shape: SlopeShape, parts: Part[] | null, live: boolean): void {
    this.shapes.set(shape, { parts, zones: this.shapes.get(shape)?.zones ?? null, live, dirty: true });
    this.render();
  }

  /** The shape the legend's sentence and shares are about: the one being edited. */
  setActive(shape: SlopeShape): void {
    this.active = shape;
    this.publish();
  }

  private render(): void {
    if (this.waiting) return; // the tiles' arrival draws the latest shapes
    const dirty = [...this.shapes.values()].filter((s) => s.dirty);
    const points = dirty.flatMap((s) => (s.parts ?? []).flatMap((p) => p[0]));
    if (!this.sampler.slopesReady(points)) {
      this.waiting = true;
      this.sampler.loadSlopes(points).finally(() => {
        this.waiting = false;
        if (this.map.getSource(SOURCE)) this.render();
      });
      return;
    }
    for (const s of dirty) {
      s.zones = s.parts ? slopeZones(s.parts, this.sampler.slopeAt, this.limits) : null;
      s.dirty = false;
    }
    const features = [...this.shapes.values()].flatMap((s) => s.zones?.zones.features ?? []);
    (this.map.getSource(SOURCE) as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features });
    this.publish();
  }

  private result(): SlopeResult {
    const s = this.shapes.get(this.active);
    return { shape: this.active, shares: s?.zones?.shares ?? { ok: 0, care: 0, risk: 0 }, tone: s?.zones?.tone ?? null, live: !!s?.live };
  }

  private publish(): void {
    const r = this.result();
    this.subscribers.forEach((f) => f(r));
  }

  subscribe(f: (r: SlopeResult) => void): () => void {
    this.subscribers.add(f);
    f(this.result());
    return () => void this.subscribers.delete(f);
  }

  destroy(): void {
    this.subscribers.clear();
    if (this.map.getLayer('rs-edit-fill')) this.map.setPaintProperty('rs-edit-fill', 'fill-opacity', 0.32);
    if (this.map.getLayer('rs-draw-fill')) this.map.setPaintProperty('rs-draw-fill', 'fill-opacity', 0.18);
    if (this.map.getLayer(LAYER)) this.map.removeLayer(LAYER);
    if (this.map.getSource(SOURCE)) this.map.removeSource(SOURCE);
  }
}
