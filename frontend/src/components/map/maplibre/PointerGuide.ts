import type { GeoJSONSource, Map as MlMap, MapMouseEvent } from 'maplibre-gl';
import type { LatLng } from '../../../lib/geo';
import { addOverlayLayer } from './OfflineMapLibre';

let seq = 0;

/**
 * The arrow and the distance under the pointer while a shape is placed or drawn (owner, 17 Nov 2026: "when I move the
 * mouse it should show the distance, with the warning … the arrow shows from where to where"): a dashed shaft from where
 * the shape is measured to the pointer, a head at the pointer, and a chip with the text, all in the verdict's colour.
 */
export class PointerGuide {
  private readonly tip: HTMLDivElement;
  private readonly id = 'pg-pointer-' + seq++;

  constructor(private readonly map: MlMap) {
    this.tip = document.createElement('div');
    this.tip.className = 'da-hover';
    this.tip.hidden = true;
    this.tip.dataset.testid = 'pointer-distance';
    map.getContainer().appendChild(this.tip);
    map.addSource(this.id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    addOverlayLayer(map, {
      id: this.id, type: 'line', source: this.id, layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['match', ['get', 'tone'], 'ok', '#2f9e6e', 'warn', '#c98a1b', 'bad', '#c0392b', '#334155'], 'line-width': ['match', ['get', 'part'], 'shaft', 2.4, 3], 'line-dasharray': ['match', ['get', 'part'], 'shaft', ['literal', [2.4, 1.6]], ['literal', [1, 0]]] },
    }, 'top');
    map.getCanvasContainer().addEventListener('mouseleave', this.hide);
  }

  show(e: MapMouseEvent, from: LatLng, text: string, tone: 'ok' | 'warn' | 'bad' | 'none') {
    const m = this.map;
    const a = m.project([from.lng, from.lat]);
    const b = e.point;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const at = (x: number, y: number) => m.unproject([x, y]).toArray();
    const wing = (side: 1 | -1) => at(b.x - 13 * ux + side * 7 * uy, b.y - 13 * uy - side * 7 * ux);
    const end = [e.lngLat.lng, e.lngLat.lat];
    (m.getSource(this.id) as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { part: 'shaft', tone }, geometry: { type: 'LineString', coordinates: [[from.lng, from.lat], end] } },
        { type: 'Feature', properties: { part: 'head', tone }, geometry: { type: 'LineString', coordinates: [wing(1), end, wing(-1)] } },
      ],
    });
    this.tip.textContent = text;
    this.tip.className = 'da-hover is-' + tone;
    this.tip.style.transform = `translate(${Math.round(b.x + 16)}px, ${Math.round(b.y + 18)}px)`;
    this.tip.hidden = false;
  }

  readonly hide = () => {
    this.tip.hidden = true;
    (this.map.getSource(this.id) as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: [] });
  };

  destroy() {
    this.map.getCanvasContainer().removeEventListener('mouseleave', this.hide);
    this.tip.remove();
    if (this.map.getLayer(this.id)) this.map.removeLayer(this.id);
    if (this.map.getSource(this.id)) this.map.removeSource(this.id);
  }
}
