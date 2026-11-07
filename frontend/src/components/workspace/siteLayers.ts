import { Popup, type GeoJSONSource, type Map as MlMap, type MapMouseEvent } from 'maplibre-gl';
import { addOverlayLayer } from '../map/maplibre';
import { LABEL_FONT } from '../map/maplibre/offlineStyle';
import type { SiteRefProps } from '../../lib/sitesLayer';

/** Reference colours: neutral slate, amber when the person selects a site (never the proposed site's teal). */
export const REF_COLOUR = '#2f4f6f';
export const REF_SELECTED = '#c98a1a';
/** The selected site's family (the site it belongs to, its sub-sites): outlined in the selection colour, slate inside. */
export const REF_RELATED = '#e3b04b';
/** The layers a click or the pointer can pick a single site on (a group bubble zooms in instead). */
export const REF_LAYERS = ['ref-fill', 'ref-marker', 'ref-dot', 'ref-label', 'ref-pt', 'ref-pt-label'];
/** Zoomed out to this level or further, sites close together on screen are drawn as one bubble «n مواقع». */
export const GROUP_UP_TO_ZOOM = 10;

const sel = (on: unknown, off: unknown) => ['case', ['get', 'selected'], on, off];
const rel = (on: unknown, off: unknown) => ['case', ['coalesce', ['get', 'related'], false], on, off];
/** Larger and outlined in the selection colour while the pointer is over the site (feature state, per site id). */
const hov = (on: unknown, off: unknown) => ['case', ['boolean', ['feature-state', 'hover'], false], on, off];
const markerPaint = {
  'circle-radius': sel(14, hov(13, rel(12, 11))),
  'circle-color': sel(REF_SELECTED, REF_COLOUR),
  'circle-stroke-color': sel('#ffe2a8', hov('#ffd27a', rel(REF_RELATED, '#ffffff'))),
  'circle-stroke-width': sel(4, hov(4, rel(3.5, 2.5))),
} as never;

/** A name on the map stands on a small white plate, always readable over roads and boundaries (stretched to the text). */
export const LABEL_PILL = 'tz-label-pill';
export const labelPillLayout = {
  'icon-image': LABEL_PILL,
  'icon-text-fit': 'both' as const,
  'icon-text-fit-padding': [1, 4, 1, 4] as [number, number, number, number],
  'icon-allow-overlap': false,
};
const SITE_GLYPH = 'tz-site-glyph';

const canvas2d = (w: number, h: number) => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c.getContext('2d')!;
};

/** The plate: rounded, white, a thin slate border and a soft edge; only its middle stretches. At pixel ratio 2. */
function addLabelPill(m: MlMap): void {
  if (m.hasImage(LABEL_PILL)) return;
  const n = 32;
  const r = 8;
  const g = canvas2d(n, n);
  g.beginPath();
  g.roundRect(2, 2, n - 4, n - 4, r);
  g.fillStyle = 'rgba(255, 255, 255, 0.96)';
  g.shadowColor = 'rgba(15, 35, 55, 0.28)';
  g.shadowBlur = 3;
  g.fill();
  g.shadowBlur = 0;
  g.lineWidth = 1.5;
  g.strokeStyle = 'rgba(47, 79, 111, 0.45)';
  g.stroke();
  const edge = r + 2;
  m.addImage(LABEL_PILL, g.getImageData(0, 0, n, n), { pixelRatio: 2, stretchX: [[edge, n - edge]], stretchY: [[edge, n - edge]], content: [edge, edge, n - edge, n - edge] });
}

/** The symbol of a site: a white location pin, drawn here (no sprite file), standing on the site's round marker. */
function addSiteGlyph(m: MlMap): void {
  if (m.hasImage(SITE_GLYPH)) return;
  const n = 40;
  const g = canvas2d(n, n);
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.arc(20, 15, 10.5, Math.PI * 0.84, Math.PI * 0.16);
  g.lineTo(20, 36);
  g.closePath();
  g.fill();
  g.globalCompositeOperation = 'destination-out';
  g.beginPath();
  g.arc(20, 15, 4.2, 0, Math.PI * 2);
  g.fill();
  m.addImage(SITE_GLYPH, g.getImageData(0, 0, n, n), { pixelRatio: 2 });
}

const glyphLayout = { 'icon-image': SITE_GLYPH, 'icon-size': sel(1.15, 0.95), 'icon-allow-overlap': true, 'icon-ignore-placement': true } as never;
const nameLayout = {
  // the name, and under it what kind of site it is here and how many units are stationed there: one object per site
  'text-field': ['format', ['get', 'name'], {}, ['case', ['==', ['coalesce', ['get', 'sub'], ''], ''], '', ['concat', '\n', ['get', 'sub']]], { 'font-scale': 0.82, 'text-color': '#4f6377' }],
  'text-font': [LABEL_FONT],
  'text-size': sel(14, 13),
  'text-line-height': 1.25,
  'text-max-width': 30,
  // around the marker, wherever there is room; names never pile on each other
  'text-variable-anchor': ['top', 'bottom', 'right', 'left'],
  'text-radial-offset': 1.6,
  'text-justify': 'auto',
  'text-allow-overlap': false,
  'text-optional': true,
  'symbol-sort-key': sel(0, 1),
  ...labelPillLayout,
} as never;
const namePaint = { 'text-color': sel('#7a4f00', '#14304d') } as never;

/**
 * The registered sites' layers (owner decision of 5 Nov 2026, item 4; map-first review of 5 Nov): a faint fill and a
 * dashed outline for a registered boundary, and one symbol and one name per site. Zoomed out (up to
 * GROUP_UP_TO_ZOOM) sites that would cover each other are one bubble «n مواقع» — a click zooms in — so every name on
 * the map can be read; a site alone keeps its marker and name. Added BEFORE a page's own overlays, so a request's
 * fills and outlines draw above them; markers, names and groups sit above the basemap's own labels (a road shield never
 * covers a site). Reference only.
 */
export function addSiteLayers(m: MlMap): void {
  addLabelPill(m);
  addSiteGlyph(m);
  m.addSource('ref-sites', { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, promoteId: 'siteId' });
  m.addSource('ref-points', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
    cluster: true,
    clusterRadius: 48,
    clusterMaxZoom: GROUP_UP_TO_ZOOM,
    promoteId: 'siteId',
  });
  const role = (r: SiteRefProps['role']) => ['==', ['get', 'role'], r] as ['==', ['get', string], string];
  addOverlayLayer(m, { id: 'ref-fill', type: 'fill', source: 'ref-sites', filter: role('REF_SITE'), paint: { 'fill-color': sel(REF_SELECTED, REF_COLOUR) as never, 'fill-opacity': sel(0.28, 0.16) as never } });
  addOverlayLayer(m, {
    id: 'ref-line',
    type: 'line',
    source: 'ref-sites',
    filter: role('REF_SITE'),
    paint: { 'line-color': sel(REF_SELECTED, hov(REF_SELECTED, rel(REF_RELATED, REF_COLOUR))) as never, 'line-width': sel(3.4, hov(3, rel(2.8, 2.2))) as never, 'line-dasharray': [3, 1.2] },
  });
  // zoomed out: groups and single sites from the clustered points
  addOverlayLayer(m, {
    id: 'ref-cluster',
    type: 'circle',
    source: 'ref-points',
    filter: ['has', 'point_count'],
    maxzoom: GROUP_UP_TO_ZOOM + 1,
    paint: {
      'circle-radius': ['step', ['get', 'point_count'], 22, 5, 26, 20, 32],
      'circle-color': REF_COLOUR,
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 3,
    },
  }, 'top');
  addOverlayLayer(m, {
    id: 'ref-cluster-count',
    type: 'symbol',
    source: 'ref-points',
    filter: ['has', 'point_count'],
    maxzoom: GROUP_UP_TO_ZOOM + 1,
    layout: {
      'text-field': ['concat', ['to-string', ['get', 'point_count']], '\nمواقع'],
      'text-font': [LABEL_FONT],
      'text-size': 13,
      'text-line-height': 1.05,
      'text-allow-overlap': true,
    },
    paint: { 'text-color': '#ffffff' },
  }, 'top');
  addOverlayLayer(m, { id: 'ref-pt', type: 'circle', source: 'ref-points', filter: ['!', ['has', 'point_count']], maxzoom: GROUP_UP_TO_ZOOM + 1, paint: markerPaint }, 'top');
  addOverlayLayer(m, { id: 'ref-pt-label', type: 'symbol', source: 'ref-points', filter: ['!', ['has', 'point_count']], maxzoom: GROUP_UP_TO_ZOOM + 1, layout: nameLayout, paint: namePaint }, 'top');
  // zoomed in: every site on its own
  addOverlayLayer(m, { id: 'ref-marker', type: 'circle', source: 'ref-sites', filter: role('REF_MARKER'), minzoom: GROUP_UP_TO_ZOOM + 1, paint: markerPaint }, 'top');
  // a site with a boundary keeps its symbol at every zoom, at its label point
  addOverlayLayer(m, { id: 'ref-dot', type: 'circle', source: 'ref-sites', filter: role('REF_LABEL'), minzoom: GROUP_UP_TO_ZOOM + 1, paint: markerPaint }, 'top');
  addOverlayLayer(m, { id: 'ref-pt-glyph', type: 'symbol', source: 'ref-points', filter: ['!', ['has', 'point_count']], maxzoom: GROUP_UP_TO_ZOOM + 1, layout: glyphLayout }, 'top');
  addOverlayLayer(m, { id: 'ref-glyph', type: 'symbol', source: 'ref-sites', filter: ['in', ['get', 'role'], ['literal', ['REF_LABEL', 'REF_MARKER']]], minzoom: GROUP_UP_TO_ZOOM + 1, layout: glyphLayout }, 'top');
  addOverlayLayer(m, {
    id: 'ref-label',
    type: 'symbol',
    source: 'ref-sites',
    filter: ['in', ['get', 'role'], ['literal', ['REF_LABEL', 'REF_MARKER']]],
    minzoom: GROUP_UP_TO_ZOOM + 1,
    layout: nameLayout,
    paint: namePaint,
  }, 'top');
}

export function setSiteData(m: MlMap, fc: GeoJSON.FeatureCollection): void {
  (m.getSource('ref-sites') as GeoJSONSource | undefined)?.setData(fc);
  // one point per site (its label point or its marker) for the zoomed-out groups
  const points = fc.features.filter((f) => f.properties?.role === 'REF_LABEL' || f.properties?.role === 'REF_MARKER');
  (m.getSource('ref-points') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: points });
}

const pickable = (m: MlMap) => REF_LAYERS.filter((l) => m.getLayer(l));

/**
 * A click on a registered site picks it for its information; a click on a group zooms in to it; a click elsewhere
 * closes the information. While `enabled()` is false (placing the proposed site or a deployment area) the layers take
 * no click at all and placement gets every one. Over a site the pointer turns to a hand, the site is highlighted and
 * a small tooltip shows its name and units.
 */
export function bindSiteClicks(m: MlMap, enabled: () => boolean, onPick: (siteId: string | null, here: string[]) => void): void {
  m.on('click', async (e: MapMouseEvent) => {
    if (!enabled()) return;
    const group = m.getLayer('ref-cluster') ? m.queryRenderedFeatures(e.point, { layers: ['ref-cluster'] })[0] : undefined;
    if (group) {
      // frame every site of the group, each then drawn on its own (never one left half outside the map)
      const src = m.getSource('ref-points') as GeoJSONSource;
      const leaves = await src.getClusterLeaves(group.properties?.cluster_id as number, Infinity, 0);
      const pts = leaves.map((f) => (f.geometry as GeoJSON.Point).coordinates as [number, number]);
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      const cam = m.cameraForBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: 90, maxZoom: 15 });
      m.easeTo({ center: cam?.center ?? (group.geometry as GeoJSON.Point).coordinates as [number, number], zoom: Math.max(cam?.zoom ?? 0, GROUP_UP_TO_ZOOM + 1), duration: 600 });
      return;
    }
    // every site whose marker or boundary is under the pointer: a main site and its sub-site can share one point
    const box: [[number, number], [number, number]] = [[e.point.x - 7, e.point.y - 7], [e.point.x + 7, e.point.y + 7]];
    const hit = m.queryRenderedFeatures(box, { layers: pickable(m) });
    const here = [...new Set(hit.map((f) => f.properties?.siteId as string))].filter(Boolean);
    onPick((hit[0]?.properties?.siteId as string | undefined) ?? null, here);
  });
  const tip = new Popup({ closeButton: false, closeOnClick: false, offset: 14, className: 'tz-site-tip' });
  let hovered: string | number | null = null;
  const state = (id: string | number, hover: boolean) => {
    for (const source of ['ref-sites', 'ref-points']) m.setFeatureState({ source, id }, { hover });
  };
  const setHover = (id: string | number | null) => {
    if (hovered === id) return;
    if (hovered != null) state(hovered, false);
    hovered = id;
    if (id != null) state(id, true);
  };
  // only a cursor this layer set is cleared: another tool's cursor (the site editor's move or grab) is left alone
  let pointing = false;
  const pointer = (on: boolean) => {
    if (on === pointing) return;
    pointing = on;
    m.getCanvas().style.cursor = on ? 'pointer' : '';
  };
  m.on('mousemove', (e: MapMouseEvent) => {
    if (!enabled()) {
      pointer(false);
      setHover(null);
      tip.remove();
      return;
    }
    const group = m.getLayer('ref-cluster') ? m.queryRenderedFeatures(e.point, { layers: ['ref-cluster'] })[0] : undefined;
    const hit = group ? undefined : m.queryRenderedFeatures(e.point, { layers: pickable(m) })[0];
    pointer(!!(group || hit));
    setHover((hit?.properties?.siteId as string | undefined) ?? null);
    if (group) tip.setLngLat(e.lngLat).setText(`${group.properties?.point_count} مواقع — اضغط للتكبير`).addTo(m);
    else if (hit) tip.setLngLat(e.lngLat).setText(String(hit.properties?.label ?? hit.properties?.name ?? '')).addTo(m);
    else tip.remove();
  });
  m.getCanvas().addEventListener('mouseleave', () => (setHover(null), tip.remove()));
  // a moving map has nothing under the pointer any more
  m.on('movestart', () => (setHover(null), tip.remove()));
}
