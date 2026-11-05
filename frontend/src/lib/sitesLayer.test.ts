import { describe, expect, it } from 'vitest';
import type { MapFeature, RestationingUnit, StationingRecord } from '../api/types';
import { canOpen, completed, deriveRequesting, firstOpen, unitsAtSite, type FlowInput } from './newRequestFlow';
import { newRequestFromSiteHash, newRequestHash, parseRestationingHash } from './restationingRoute';
import { familyOf, registeredSites, siteReferenceFeatures, sitesExtent, unitsPerSite } from './sitesLayer';

const square = (lng: number, lat: number, d = 0.002) => [[[lng, lat], [lng + d, lat], [lng + d, lat + d], [lng, lat + d], [lng, lat]]];
const site = (id: string, name: string, extra: Partial<MapFeature> = {}): MapFeature =>
  ({ siteId: id, code: id, name, kind: 'مبنى', parentId: null, view: 'FULL', lat: 25.2, lng: 55.3, boundary: null, boundaryStatus: 'NOT_REGISTERED', resources: [], requestsVisible: true, ...extra }) as unknown as MapFeature;
const rec = (orgId: string, orgName: string, siteId: string, extra: Partial<StationingRecord> = {}): StationingRecord =>
  ({ id: orgId + siteId, orgId, orgCode: orgId, orgName, siteId, siteCode: siteId, siteName: 'موقع ' + siteId, kind: 'PERMANENT', validFrom: '2026-11-04T00:00:00Z', validTo: null, plannedEnd: null, origin: 'REQUEST', requestId: null, reference: null, ...extra }) as StationingRecord;

describe('registered sites as a reference layer (owner decisions of 5 Nov 2026)', () => {
  const features = [
    site('b', 'موقع بحدود', { boundary: { version: 1, type: 'Polygon', geojson: { type: 'Polygon', coordinates: square(55.3, 25.2) }, simplified: false }, boundaryStatus: 'REGISTERED' }),
    site('m', 'موقع بعلامة فقط'),
    site('c', 'سياق', { view: 'CONTEXT' }),
    site('x', 'بلا موقع', { lat: null, lng: null }),
  ];
  const current = [rec('u1', 'وحدة أ', 'm'), rec('u2', 'وحدة ب', 'm'), rec('u3', 'وحدة ج', 'hidden'), rec('u4', 'وحدة د', 'later', { siteLocation: { lat: 25.3, lng: 55.4 } })];
  const sites = registeredSites(features, current);

  it('draws a registered boundary with ONE label, a marker otherwise, and skips context and unlocated sites', () => {
    const fc = siteReferenceFeatures(sites);
    expect(fc.features.map((f) => [f.properties.siteId, f.properties.role, f.geometry.type])).toEqual([
      ['b', 'REF_SITE', 'Polygon'],
      ['b', 'REF_LABEL', 'Point'],
      ['m', 'REF_MARKER', 'Point'],
      ['later', 'REF_MARKER', 'Point'],
    ]);
  });

  it('lists a site known only from a stationing record, and draws it as soon as the record carries its location', () => {
    expect(sites.find((s) => s.siteId === 'hidden')).toMatchObject({ name: 'موقع hidden', onMap: false });
    expect(sites.find((s) => s.siteId === 'later')).toMatchObject({ onMap: true, lat: 25.3, lng: 55.4 });
  });

  it('one map object per site: several units at a site give one marker with a small count', () => {
    const fc = siteReferenceFeatures(sites, null, unitsPerSite(current));
    const m = fc.features.filter((f) => f.properties.siteId === 'm');
    expect(m).toHaveLength(1);
    expect(m[0].properties.label).toBe('موقع بعلامة فقط · وحدتان');
  });

  it('is reference only: identity and display state, no ranking, recommendation or validity, the server\'s order', () => {
    const fc = siteReferenceFeatures(sites);
    for (const f of fc.features) expect(Object.keys(f.properties).sort()).toEqual(['label', 'name', 'related', 'role', 'selected', 'siteId']);
    expect(fc.features.map((f) => f.properties.siteId)).toEqual(['b', 'b', 'm', 'later']);
  });

  it('selects nothing by itself, and only the site the person selected', () => {
    expect(siteReferenceFeatures(sites).features.some((f) => f.properties.selected)).toBe(false);
    const sel = siteReferenceFeatures(sites, 'm').features.filter((f) => f.properties.selected);
    expect(sel.map((f) => f.properties.siteId)).toEqual(['m']);
  });

  it('gives a site its family: the site it belongs to and its sub-sites, marked with it on the map', () => {
    const tree = [
      { siteId: 'main', code: 'M', name: 'المعسكر الرئيسي', kind: '', geometry: null, lat: 25.2, lng: 55.3, parentId: null, onMap: true },
      { siteId: 'b2', code: 'B2', name: 'مبنى ٢', kind: '', geometry: null, lat: 25.2, lng: 55.3, parentId: 'main', onMap: true },
      { siteId: 'b1', code: 'B1', name: 'مبنى ١', kind: '', geometry: null, lat: 25.21, lng: 55.31, parentId: 'main', onMap: true },
      { siteId: 'other', code: 'O', name: 'موقع آخر', kind: '', geometry: null, lat: 24.4, lng: 54.4, parentId: null, onMap: true },
    ];
    const f = familyOf(tree, 'main');
    expect(f.parent).toBeNull();
    expect(f.children.map((c) => c.siteId)).toEqual(['b1', 'b2']);
    expect(familyOf(tree, 'b2').parent?.siteId).toBe('main');
    expect(familyOf(tree, 'b2').siblings.map((c) => c.siteId)).toEqual(['b1']);
    // a main site the person may not see is never named; its sub-sites still show together
    const hidden = tree.filter((t) => t.siteId !== 'main');
    expect(familyOf(hidden, 'b2').parent).toBeNull();
    expect(familyOf(hidden, 'b2').siblings.map((c) => c.siteId)).toEqual(['b1']);
    const marked = siteReferenceFeatures(tree, 'main').features.filter((x) => x.properties.related).map((x) => x.properties.siteId);
    expect(marked.sort()).toEqual(['b1', 'b2']);
    expect(siteReferenceFeatures(tree, 'other').features.some((x) => x.properties.related)).toBe(false);
  });

  it('frames what is drawn', () => {
    const e = sitesExtent(siteReferenceFeatures(registeredSites(features)))!;
    expect(e[0]).toBeCloseTo(55.3);
    expect(e[2]).toBeCloseTo(55.302);
    expect(sitesExtent({ type: 'FeatureCollection', features: [] })).toBeNull();
  });
});

describe('map-first request flow (owner correction of 5 Nov 2026)', () => {
  const start: FlowInput = { site: false, units: 0, kind: 'PERMANENT', proposed: false, primary: false, alternative: false };

  it('opens one step at a time, in order; nothing counts as done before the current site', () => {
    expect(completed(start)).toEqual([false, false, false, false, false, false]);
    expect(firstOpen(start)).toBe(1);
    expect(canOpen(start, 2)).toBe(false);
    const site = { ...start, site: true };
    expect(firstOpen(site)).toBe(2);
    expect(canOpen(site, 3)).toBe(false);
    const units = { ...site, units: 1 };
    expect(canOpen(units, 3)).toBe(true);
    expect(canOpen(units, 4)).toBe(true); // permanent: the type is complete
    expect(canOpen(units, 5)).toBe(false); // no new site yet: no deployment step, no ring
    expect(canOpen({ ...units, proposed: true }, 5)).toBe(true);
  });

  it('asks for dates before a temporary request goes further', () => {
    const t = { ...start, site: true, units: 2, kind: 'TEMPORARY' as const };
    expect(completed(t)[2]).toBe(false);
    expect(canOpen(t, 4)).toBe(false);
    expect(canOpen({ ...t, start: '2026-12-01', end: '2026-12-31' }, 4)).toBe(true);
  });

  it('lets review report missing deployment areas instead of hiding the review', () => {
    const noAreas = { ...start, site: true, units: 1, proposed: true };
    expect(canOpen(noAreas, 6)).toBe(true);
    expect(completed(noAreas)[4]).toBe(false);
    expect(firstOpen({ ...noAreas, primary: true, alternative: true })).toBe(6);
  });

  const options: RestationingUnit[] = [
    { id: 'ss', code: 'HR-T-SS', name: 'الخدمات المشتركة', parentId: 'root', depth: 0 },
    { id: 'gs', code: 'T-SS-1', name: 'قسم الخدمات العامة', parentId: 'ss', depth: 1 },
    { id: 'tr', code: 'T-SS-2', name: 'قسم النقل', parentId: 'ss', depth: 1 },
  ];

  it('offers only the units stationed at the chosen site, each once, marking those the person may request for', () => {
    const current = [rec('tr', 'قسم النقل', '08'), rec('other', 'وحدة من فرع آخر', '08'), rec('tr', 'قسم النقل', '08'), rec('gs', 'قسم الخدمات العامة', 'RS-48')];
    expect(unitsAtSite(current, '08', options).map((u) => [u.orgName, u.requestable])).toEqual([['قسم النقل', true], ['وحدة من فرع آخر', false]]);
    expect(unitsAtSite(current, null)).toEqual([]);
  });

  it('derives the requesting unit: the parent asks for a moving unit; the unit itself when its parent is not an option', () => {
    expect(deriveRequesting(options, ['tr'])).toBe('ss');
    expect(deriveRequesting(options, ['tr', 'gs'])).toBe('ss');
    expect(deriveRequesting(options, ['ss'])).toBe('ss');
    expect(deriveRequesting(options, ['ss', 'tr'])).toBe('ss');
    expect(deriveRequesting(options, ['tr', 'elsewhere'])).toBe('ss');
    expect(deriveRequesting(options, ['elsewhere'])).toBeNull();
  });

  const ID = '3af418c5-fb73-869c-da16-7411f739b156';
  it('parses the list, one request, and a new request from a site or a unit; keeps #restationing/<id> working', () => {
    expect(parseRestationingHash('#restationing')).toEqual({ kind: 'list' });
    expect(parseRestationingHash('#restationing/' + ID)).toEqual({ kind: 'request', id: ID });
    expect(parseRestationingHash(newRequestHash(ID))).toEqual({ kind: 'new', unit: ID, site: null });
    expect(parseRestationingHash(newRequestFromSiteHash(ID))).toEqual({ kind: 'new', unit: null, site: ID });
    expect(parseRestationingHash('#restationing/new')).toEqual({ kind: 'new', unit: null, site: null });
    expect(parseRestationingHash('#restationing/new?unit=<script>')).toEqual({ kind: 'new', unit: null, site: null });
    expect(parseRestationingHash('#restationing/bad id')).toEqual({ kind: 'list' });
    expect(parseRestationingHash('#stationing/' + ID)).toEqual({ kind: 'list' });
  });
});
