import { describe, expect, it } from 'vitest';
import type { SiteGeometry } from '../api/types';
import { areaM2, centroid } from './footprint';
import { distanceM, type LatLng } from './geo';
import cases from './siteGeometryCases.json';
import { SiteHistory, anchorOf, moveVertex, partsOf, siteArea, toGeometry, translate, validateSite, vertexConflicts, type Part } from './siteGeometry';

const at = (lat: number, lng: number): LatLng => ({ lat, lng });
const square = (lng: number, lat: number, d = 0.002): number[][] => [[lng, lat], [lng + d, lat], [lng + d, lat + d], [lng, lat + d], [lng, lat]];
const multi: SiteGeometry = { type: 'MultiPolygon', coordinates: [[square(55.3, 25.2)], [square(55.305, 25.2)], [square(55.3, 25.205, 0.001)]] };

describe('proposed site geometry (owner, 4 Nov 2026)', () => {
  it('gives the server’s verdict on every parity case (client/server parity)', () => {
    for (const c of cases.cases) {
      const v = validateSite(partsOf(c.geometry as SiteGeometry));
      expect(v.ok, c.name + ': ' + v.problems.join(' | ')).toBe(c.valid);
    }
  });

  it('measures the area as the server does (PostGIS geography on the WGS84 spheroid), within 0.05 %', () => {
    for (const c of cases.cases.filter((x) => 'serverAreaM2' in x)) {
      const client = siteArea(partsOf(c.geometry as SiteGeometry));
      const server = (c as { serverAreaM2: number }).serverAreaM2;
      expect(Math.abs(client - server) / server, c.name + ': ' + client + ' vs ' + server).toBeLessThan(5e-4);
    }
  });

  it('copies a MultiPolygon whole: every part in its order, the same type, shapes and areas', () => {
    const parts = partsOf(multi);
    const back = toGeometry(multi.type, parts);
    expect(back).toEqual(multi);
    expect(parts).toHaveLength(3);
  });

  it('moves every part together, rigidly: areas, shapes and the distances between parts are kept', () => {
    const before = partsOf(multi);
    const anchor = anchorOf(before);
    const moved = translate(multi, { lat: anchor.lat + 0.3, lng: anchor.lng + 0.25 });
    expect(moved.type).toBe('MultiPolygon');
    const after = partsOf(moved);
    expect(after).toHaveLength(before.length);
    before.forEach((p, i) => {
      expect(after[i][0]).toHaveLength(p[0].length);
      expect(Math.abs(areaM2(after[i][0]) - areaM2(p[0])) / areaM2(p[0])).toBeLessThan(1e-3);
      // every edge keeps its length (the shape)
      p[0].forEach((v, k) => {
        const w = p[0][(k + 1) % p[0].length];
        expect(Math.abs(distanceM(after[i][0][k], after[i][0][(k + 1) % p[0].length]) - distanceM(v, w))).toBeLessThan(0.5);
      });
    });
    // the distances between parts are kept
    for (let i = 0; i < before.length; i++) {
      for (let j = i + 1; j < before.length; j++) {
        const d0 = distanceM(centroid(before[i][0]), centroid(before[j][0]));
        const d1 = distanceM(centroid(after[i][0]), centroid(after[j][0]));
        expect(Math.abs(d1 - d0)).toBeLessThan(0.5);
      }
    }
    expect(distanceM(anchorOf(after), { lat: anchor.lat + 0.3, lng: anchor.lng + 0.25 })).toBeLessThan(1);
  });

  it('moves one vertex of one part; the other parts are untouched', () => {
    const parts = partsOf(multi);
    const edited = moveVertex(parts, 1, 0, 2, at(25.2025, 55.3075));
    expect(edited[0]).toBe(parts[0]);
    expect(edited[2]).toBe(parts[2]);
    expect(edited[1][0][2]).toEqual(at(25.2025, 55.3075));
    expect(edited[1][0][0]).toEqual(parts[1][0][0]);
    expect(siteArea(edited)).toBeGreaterThan(siteArea(parts));
  });

  it('flags an edit that crosses itself or reaches another part, and the configured maximum', () => {
    const parts = partsOf({ type: 'Polygon', coordinates: [square(55.3, 25.2)] });
    // the top-right corner pulled across the left edge: its new edge from the bottom-right corner crosses that edge
    const crossed = moveVertex(parts, 0, 0, 2, at(25.2015, 55.298));
    expect(validateSite(crossed).ok).toBe(false);
    expect(vertexConflicts(crossed, 0, 0, 2)).toBe(true);
    expect(vertexConflicts(parts, 0, 0, 2)).toBe(false);
    const big = validateSite(parts, 1000);
    expect(big.ok).toBe(false);
    expect(big.problems).toContain('المساحة تتجاوز الحد الأقصى المعتمد');
    const into = moveVertex(partsOf(multi), 0, 0, 2, at(25.2015, 55.3055));
    expect(validateSite(into).ok).toBe(false);
  });

  it('undo, redo and reset are deterministic: copy, move, edit a vertex of part 2, undo, undo, redo', () => {
    const copy = partsOf(multi);
    const h = new SiteHistory<Part[]>(copy);
    let cur = copy;
    h.push(cur);
    const movedGeom = translate(multi, { lat: 25.25, lng: 55.35 });
    cur = partsOf(movedGeom);
    const moved = cur;
    h.push(cur);
    cur = moveVertex(cur, 1, 0, 2, { lat: cur[1][0][2].lat + 0.0005, lng: cur[1][0][2].lng + 0.0005 });
    const edited = cur;
    cur = h.undo(cur)!;
    expect(cur).toBe(moved);
    cur = h.undo(cur)!;
    expect(cur).toBe(copy);
    cur = h.redo(cur)!;
    expect(cur).toBe(moved);
    cur = h.redo(cur)!;
    expect(cur).toBe(edited);
    cur = h.reset(cur);
    expect(cur).toBe(copy);
    expect(h.canUndo).toBe(true);
    expect(h.undo(cur)).toBe(edited);
  });

  it('stays immediate on a dense boundary (5,000 vertices)', () => {
    const n = 5000;
    const ring: number[][] = Array.from({ length: n }, (_, i) => {
      const t = (i / n) * 2 * Math.PI;
      const r = 0.003 * (1 + 0.05 * Math.sin(12 * t));
      return [55.3 + r * Math.cos(t), 25.2 + r * Math.sin(t)];
    });
    ring.push(ring[0]);
    const dense: SiteGeometry = { type: 'Polygon', coordinates: [ring] };
    let t0 = performance.now();
    const moved = translate(dense, { lat: 25.3, lng: 55.4 });
    const move = performance.now() - t0;
    t0 = performance.now();
    const v = validateSite(partsOf(moved));
    const validate = performance.now() - t0;
    t0 = performance.now();
    vertexConflicts(partsOf(moved), 0, 0, 10);
    const vertex = performance.now() - t0;
    expect(v.ok, v.problems.join(' | ')).toBe(true);
    expect(move).toBeLessThan(100);
    expect(validate).toBeLessThan(500);
    expect(vertex).toBeLessThan(20);
  });
});
