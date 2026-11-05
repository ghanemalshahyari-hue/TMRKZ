import { describe, expect, it } from 'vitest';
import type { SiteGeometry, StationingRecord } from '../api/types';
import { clickVertex, finishDraw, readout, removeLast, sideLabel, startDraw } from './drawState';
import { occupiedFeatures, occupiedSites, overlapsOccupied } from './occupied';
import type { RefSite } from './sitesLayer';

const at = (lng: number, lat: number) => ({ lng, lat });
const square = (lng: number, lat: number, d = 0.002): SiteGeometry => ({ type: 'Polygon', coordinates: [[[lng, lat], [lng + d, lat], [lng + d, lat + d], [lng, lat + d], [lng, lat]]] });

describe('drawing a boundary vertex by vertex (owner correction of 5 Nov 2026)', () => {
  it('adds a vertex per click and finishes on the first vertex once there are three', () => {
    let s = startDraw();
    for (const p of [at(55.3, 25.2), at(55.303, 25.2), at(55.303, 25.203), at(55.3, 25.203)]) s = clickVertex(s, p, false).state;
    expect(s.vertices).toHaveLength(4);
    const r = readout(s);
    expect(r.count).toBe(4);
    expect(r.sides).toHaveLength(4);
    expect(r.sides[0]).toBeGreaterThan(290);
    expect(r.sides[0]).toBeLessThan(320);
    expect(r.areaM2).toBeGreaterThan(90_000);
    expect(r.ok && r.canFinish).toBe(true);
    expect(clickVertex(s, at(55.3, 25.2), true).finish).toBe(true);
    expect(finishDraw(s)).toHaveLength(4);
  });

  it('cannot finish with fewer than three vertices; a double-click adds no second vertex', () => {
    let s = clickVertex(startDraw(), at(55.3, 25.2), false).state;
    s = clickVertex(s, at(55.301, 25.2), false).state;
    expect(clickVertex(s, at(55.301, 25.2), false).state.vertices).toHaveLength(2);
    expect(clickVertex(s, at(55.3, 25.2), true).finish).toBe(false);
    expect(readout(s).canFinish).toBe(false);
    expect(finishDraw(s)).toBeNull();
  });

  it('Backspace removes the last vertex', () => {
    let s = startDraw();
    for (const p of [at(55.3, 25.2), at(55.303, 25.2), at(55.303, 25.203)]) s = clickVertex(s, p, false).state;
    expect(removeLast(s).vertices).toHaveLength(2);
  });

  it('refuses a shape that crosses itself and warns, without refusing, over the maximum area', () => {
    let bow = startDraw();
    for (const p of [at(55.3, 25.2), at(55.303, 25.203), at(55.303, 25.2), at(55.3, 25.203)]) bow = clickVertex(bow, p, false).state;
    expect(readout(bow).ok).toBe(false);
    expect(finishDraw(bow)).toBeNull();
    let big = startDraw();
    for (const p of [at(55.3, 25.2), at(55.31, 25.2), at(55.31, 25.21), at(55.3, 25.21)]) big = clickVertex(big, p, false).state;
    expect(readout(big, 500_000).ok).toBe(false);
    expect(finishDraw(big, 500_000)).toHaveLength(4);
  });

  it('writes side lengths in metres or kilometres', () => {
    expect(sideLabel(312.4)).toContain('م');
    expect(sideLabel(1240)).toContain('كم');
  });
});

describe('occupied ground while placing the new site', () => {
  const rec = (orgId: string, siteId: string, g: SiteGeometry | { type: 'Point'; coordinates: number[] } | null) =>
    ({ id: orgId, orgId, orgCode: orgId, orgName: 'وحدة ' + orgId, siteId, siteCode: siteId, siteName: 'موقع ' + siteId, kind: 'PERMANENT', validFrom: '', validTo: null, plannedEnd: null, origin: '', requestId: null, reference: null, siteGeometry: g }) as StationingRecord;
  const current = [rec('mover', 'mine', square(55.3, 25.2)), rec('other', 'shared', square(55.31, 25.2)), rec('mover2', 'shared', square(55.31, 25.2)), rec('far', 'pt', { type: 'Point', coordinates: [55.4, 25.3] })];
  const sites: RefSite[] = [];

  it('counts the sites of units other than the moving ones, not the moving units’ own site', () => {
    const occ = occupiedSites(current, sites, ['mover', 'mover2']);
    expect(occ.map((o) => o.siteId).sort()).toEqual(['pt', 'shared']);
    expect(occ.find((o) => o.siteId === 'shared')!.units).toEqual(['وحدة other']);
  });

  it('reports an overlap with a boundary or a marker, and nothing elsewhere', () => {
    const occ = occupiedSites(current, sites, ['mover']);
    expect(overlapsOccupied(square(55.311, 25.201), occ).map((o) => o.siteId)).toEqual(['shared']);
    expect(overlapsOccupied(square(55.399, 25.299), occ).map((o) => o.siteId)).toEqual(['pt']);
    expect(overlapsOccupied(square(55.5, 25.5), occ)).toEqual([]);
    expect(overlapsOccupied(null, occ)).toEqual([]);
  });

  it('draws occupied ground as red boundaries or markers with their names', () => {
    const fc = occupiedFeatures(occupiedSites(current, sites, ['mover']));
    expect(fc.features.map((f) => [f.properties!.role, f.geometry.type])).toEqual([
      ['OCC_SITE', 'Polygon'],
      ['OCC_MARKER', 'Point'],
    ]);
  });
});
