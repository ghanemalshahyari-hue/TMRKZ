import { describe, expect, it } from 'vitest';
import { areaM2 } from './footprint';
import { frameOf, frameSize, handleAt, readyShape, resizeBy, rotateBy } from './shapeTransform';

const C = { lat: 24.98, lng: 55.99 };
const area = (pts: { lat: number; lng: number }[]) => areaM2(pts as never);

describe('«أدوات الرسم والتحكم (مثل Word)» (owner brief §7, reference panel 5)', () => {
  it('places a circle, an ellipse, a square and a rectangle of the asked area', () => {
    for (const k of ['CIRCLE', 'ELLIPSE', 'SQUARE', 'RECTANGLE'] as const) expect(area(readyShape(C, k, 90_000)) / 90_000).toBeCloseTo(1, 1);
    const sq = frameSize(frameOf(readyShape(C, 'SQUARE', 90_000), 0)!);
    expect(sq.width).toBeCloseTo(300, -1);
    const rect = frameSize(frameOf(readyShape(C, 'RECTANGLE', 90_000), 0)!);
    expect(rect.width / rect.length).toBeCloseTo(1.6, 1);
  });

  it('a side handle changes the width alone: the square becomes a rectangle, the opposite side stays', () => {
    const sq = readyShape(C, 'SQUARE', 90_000);
    const f = frameOf(sq, 0)!;
    // handle 3 is the side at maxU (east): dragged 150 m further east
    const to = { lat: handleAt(f, 3).lat, lng: handleAt(f, 3).lng + 150 / (111_320 * Math.cos((C.lat * Math.PI) / 180)) };
    const out = resizeBy(sq, f, 3, to);
    const g = frameSize(frameOf(out, 0)!);
    expect(g.width).toBeCloseTo(450, -1);
    expect(g.length).toBeCloseTo(300, -1);
    expect(Math.min(...out.map((p) => p.lng))).toBeCloseTo(Math.min(...sq.map((p) => p.lng)), 6);
  });

  it('a corner scales evenly; a circle stretched on one side is an ellipse', () => {
    const sq = readyShape(C, 'SQUARE', 90_000);
    const f = frameOf(sq, 0)!;
    const far = handleAt(f, 4);
    const opp = handleAt(f, 0);
    const out = resizeBy(sq, f, 4, { lat: opp.lat + (far.lat - opp.lat) * 2, lng: opp.lng + (far.lng - opp.lng) * 2 });
    expect(area(out) / area(sq)).toBeCloseTo(4, 1);
    const ci = readyShape(C, 'CIRCLE', 90_000);
    const fc = frameOf(ci, 0)!;
    const el = resizeBy(ci, fc, 5, { lat: handleAt(fc, 5).lat + 200 / 110_540, lng: handleAt(fc, 5).lng });
    const s = frameSize(frameOf(el, 0)!);
    expect(s.length / s.width).toBeGreaterThan(1.5);
  });

  it('turns a shape around its centre, keeping its area; a handle never folds it over', () => {
    const rect = readyShape(C, 'RECTANGLE', 90_000);
    const turned = rotateBy(rect, C, Math.PI / 6);
    expect(area(turned) / area(rect)).toBeCloseTo(1, 2);
    const f = frameOf(rect, 0)!;
    const flat = resizeBy(rect, f, 3, handleAt(f, 7));
    expect(frameSize(frameOf(flat, 0)!).width).toBeGreaterThanOrEqual(4.9);
  });
});
