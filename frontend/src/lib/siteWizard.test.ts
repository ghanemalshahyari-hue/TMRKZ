import { describe, expect, it } from 'vitest';
import type { SiteGeometry } from '../api/types';
import { cornersOf, outlineOf, readRow, reformat, rowsOf, shapeText, stepProblem, type WizardState } from './siteWizard';

const base: WizardState = { name: 'المجمع', kind: 'معسكر', inside: false, parentId: '', shape: 'POLYGON', point: null, geometry: null, drawing: false };
const square = { type: 'Polygon', coordinates: [[[54, 24], [54.01, 24], [54.01, 24.01], [54, 24.01], [54, 24]]] } as unknown as SiteGeometry;

describe('«موقع جديد» steps', () => {
  it('needs a name and a type before the shape; no code is asked (the server gives it)', () => {
    expect(stepProblem({ ...base, name: ' ' }, 2)).toBe('اكتب اسم الموقع.');
    expect(stepProblem({ ...base, kind: '' }, 2)).toBe('اختر نوع الموقع أو اكتبه.');
    expect(stepProblem(base, 2)).toBe('');
  });
  it('«داخل موقع آخر» needs the site it lies in', () => {
    expect(stepProblem({ ...base, inside: true }, 2)).toMatch('اختر الموقع الذي يقع داخله');
    expect(stepProblem({ ...base, inside: true, parentId: 'p' }, 2)).toBe('');
  });
  it('needs the shape, finished, before the review', () => {
    expect(stepProblem(base, 3)).toBe('ارسم حدود الموقع على الخريطة أولاً.');
    expect(stepProblem({ ...base, geometry: square, drawing: true }, 3)).toMatch('أكمل الرسم');
    expect(stepProblem({ ...base, geometry: square }, 3)).toBe('');
    expect(stepProblem({ ...base, shape: 'POINT' }, 3)).toBe('حدّد مكان الموقع على الخريطة أولاً.');
    expect(stepProblem({ ...base, shape: 'POINT', point: { lat: 24, lng: 54 } }, 3)).toBe('');
  });
  it('going back is never refused', () => {
    expect(stepProblem({ ...base, name: '' }, 1)).toBe('');
  });
});

describe('«جدول الإحداثيات»', () => {
  it('reads each row in any format, and an empty row is neither a point nor an error', () => {
    expect(readRow('24.4539, 54.3773', '').point).toEqual({ lat: 24.4539, lng: 54.3773 });
    expect(readRow('40R 234125 2707001', '').point!.lat).toBeCloseTo(24.4539, 4);
    expect(readRow('40RBN3412407001', '').point!.lng).toBeCloseTo(54.3773, 4);
    expect(readRow('', '')).toEqual({ text: '', point: null, error: '' });
    expect(readRow('hello', '').error).not.toBe('');
  });
  it('joins the points in order, skipping empty rows, and says how many are still missing', () => {
    const rows = ['24, 54', '', '24, 54.01', '24.01, 54.01', '24.01, 54'].map((t) => readRow(t, ''));
    const o = outlineOf(rows);
    expect(o.error).toBe('');
    expect((o.geometry as unknown as { coordinates: number[][][] }).coordinates[0]).toEqual([[54, 24], [54.01, 24], [54.01, 24.01], [54, 24.01], [54, 24]]);
    expect(outlineOf(rows.slice(0, 3)).error).toBe('2 من 3 نقاط على الأقل.');
  });
  it('as many points as the person wants: a twelve-corner outline', () => {
    const ring = Array.from({ length: 12 }, (_, i) => ({ lat: 24 + 0.01 * Math.sin((i / 12) * 2 * Math.PI), lng: 54 + 0.01 * Math.cos((i / 12) * 2 * Math.PI) }));
    const o = outlineOf(rowsOf(ring, 'utm'));
    expect(o.error).toBe('');
    expect(shapeText('POLYGON', o.geometry)).toBe('منطقة بـ12 زوايا');
  });
  it('refuses an outline that crosses itself', () => {
    expect(outlineOf(['24, 54', '24.01, 54.01', '24, 54.01', '24.01, 54'].map((t) => readRow(t, ''))).geometry).toBeNull();
  });
  it('changing the format rewrites every row and moves no point', () => {
    const rows = rowsOf([{ lat: 24.4539, lng: 54.3773 }], 'dd');
    const utm = reformat(rows, 'utm');
    expect(utm[0].text).toBe('40R 234125 2707001');
    expect(utm[0].point).toEqual({ lat: 24.4539, lng: 54.3773 });
    const back = reformat(reformat(utm, 'mgrs'), 'dms');
    expect(back[0].point).toEqual({ lat: 24.4539, lng: 54.3773 });
    expect(back[0].text).toBe('24°27′14.04″ N, 54°22′38.28″ E');
  });
  it('the table shows the corners of one part; several parts stay on the map', () => {
    expect(cornersOf(square)).toHaveLength(4);
    const two = { type: 'MultiPolygon', coordinates: [(square as unknown as { coordinates: number[][][] }).coordinates, (square as unknown as { coordinates: number[][][] }).coordinates] } as unknown as SiteGeometry;
    expect(cornersOf(two)).toBeNull();
    expect(cornersOf(null)).toEqual([]);
  });
});

describe('«الشكل»', () => {
  it('describes a point, an area and several parts', () => {
    expect(shapeText('POINT', null)).toBe('نقطة واحدة');
    expect(shapeText('POLYGON', square)).toBe('منطقة بـ4 زوايا');
    const two = { type: 'MultiPolygon', coordinates: [(square as unknown as { coordinates: number[][][] }).coordinates, (square as unknown as { coordinates: number[][][] }).coordinates] } as unknown as SiteGeometry;
    expect(shapeText('POLYGON', two)).toBe('2 أجزاء تتحرك معاً');
  });
});

describe('site symbols (V32): the same rule as the server', () => {
  it('accepts the catalogue and APP-6D codes, refuses tactical graphics, METOC and malformed codes', async () => {
    const { SITE_SYMBOLS, symbolProblem } = await import('./siteSymbols');
    for (const s of SITE_SYMBOLS) expect(symbolProblem(s.sidc), s.key).toBe('');
    expect(symbolProblem('10031000001211000000')).toBe('');
    expect(symbolProblem('GFGPGPPK------X')).toMatch('الرسوم التكتيكية');
    expect(symbolProblem('WAS-PL----P----')).toMatch('الرسوم التكتيكية');
    expect(symbolProblem('10032500001211000000')).toMatch('الرسوم التكتيكية');
    expect(symbolProblem('hello')).toMatch('رمز غير صالح');
    expect(SITE_SYMBOLS.some((s) => s.sidc.startsWith('G'))).toBe(false);
  });
});
