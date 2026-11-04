import { describe, expect, it } from 'vitest';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import { LABEL_FONT, OVERLAY_ANCHOR, buildOfflineStyle, routeShield, setBasemapMode, shownIn, type ModeTarget } from './offlineStyle';

const opts = {
  basemapUrl: 'http://127.0.0.1/map-data/basemap/uae.pmtiles',
  fontUrl: 'http://127.0.0.1/fonts/NotoSansArabic.ttf',
  hillshade: { url: 'http://127.0.0.1/map-data/hillshade.pmtiles', kind: 'raster' as const },
};

describe('offline MapLibre style', () => {
  it('is a valid style with no glyphs URL, one local font face and only local sources', () => {
    const style = buildOfflineStyle(opts);
    expect(validateStyleMin(style)).toEqual([]);
    expect(style.glyphs).toBeUndefined();
    expect(style.sprite).toBeUndefined();
    expect(style['font-faces']).toEqual({ [LABEL_FONT]: [{ url: opts.fontUrl }] });
    const urls = Object.values(style.sources).map((s) => ('url' in s ? s.url : ''));
    expect(urls).toEqual(['pmtiles://' + opts.basemapUrl, 'pmtiles://' + opts.hillshade.url]);
    for (const l of style.layers) {
      if (l.type === 'symbol') expect(l.layout?.['text-font']).toEqual([LABEL_FONT]);
    }
  });

  it('starts in the requested mode: street layers or terrain layers visible, labels in both', () => {
    for (const mode of ['street', 'terrain'] as const) {
      const style = buildOfflineStyle({ ...opts, mode });
      const vis = (id: string) => (style.layers.find((l) => l.id === id)?.layout as { visibility?: string }).visibility;
      expect(vis('land')).toBe(mode === 'street' ? 'visible' : 'none');
      expect(vis('terrain-hillshade')).toBe(mode === 'terrain' ? 'visible' : 'none');
      expect(vis('label-road')).toBe('visible');
      expect(vis(OVERLAY_ANCHOR)).toBe('none');
    }
  });

  it('switching mode touches grouped basemap layers only, never overlays', () => {
    const style = buildOfflineStyle(opts);
    const layers = [...style.layers, { id: 'stationing-site', metadata: undefined }];
    const calls: string[] = [];
    const map: ModeTarget = { getStyle: () => ({ layers }), setLayoutProperty: (id, _n, v) => calls.push(id + '=' + v) };
    setBasemapMode(map, 'terrain');
    expect(calls).toContain('terrain-hillshade=visible');
    expect(calls).toContain('road-highway=none');
    expect(calls.some((c) => c.startsWith('stationing-site'))).toBe(false);
    expect(shownIn({ id: 'stationing-site', metadata: undefined }, 'street')).toBeNull();
  });

  it('labels Arabic first or English first, never a fixed string', () => {
    const ar = buildOfflineStyle(opts).layers.find((l) => l.id === 'label-road');
    const en = buildOfflineStyle({ ...opts, labels: 'en' }).layers.find((l) => l.id === 'label-road');
    expect(JSON.stringify(ar?.layout?.['text-field' as never])).toContain('"name:ar"],["get","name"]');
    expect(JSON.stringify(en?.layout?.['text-field' as never])).toContain('"name:en"],["get","name"]');
  });

  it('has no terrain layer and no hillshade source when none is installed', () => {
    const style = buildOfflineStyle({ ...opts, hillshade: null, mode: 'terrain' });
    expect(style.sources.hillshade).toBeUndefined();
    expect(style.layers.some((l) => l.id === 'terrain-hillshade')).toBe(false);
    expect(validateStyleMin(style)).toEqual([]);
  });

  it('draws a stretchable route shield without any sprite file', () => {
    const { image, options } = routeShield();
    expect(image.data.length).toBe(image.width * image.height * 4);
    expect(options.content[2]).toBeLessThan(image.width);
    const centre = ((image.height / 2) * image.width + image.width / 2) * 4;
    expect([...image.data.slice(centre, centre + 4)]).toEqual([255, 255, 255, 255]);
  });
});
