import { describe, expect, it } from 'vitest';
import { coveredText, unitCount } from './UnitsDialog';
import { cellText } from './assign';

describe('what a chosen unit covers', () => {
  it('counts units in Arabic', () => expect([1, 2, 3, 11].map(unitCount)).toEqual(['وحدة واحدة', 'وحدتان', '3 وحدات', '11 وحدة']));
  const unit = { id: '1', name: 'وحدة ب', levels: [] as number[] };
  it('the unit alone', () => expect(coveredText({ ...unit, mode: 'ONE' }, undefined)).toBe('وحدة ب فقط'));
  it('with all its levels, counting those below it', () => {
    expect(coveredText({ ...unit, mode: 'BRANCH' }, 15)).toBe('وحدة ب + 14 وحدة تابعة');
    expect(coveredText({ ...unit, mode: 'BRANCH' }, 4)).toBe('وحدة ب + 3 وحدات تابعة');
    expect(coveredText({ ...unit, mode: 'BRANCH' }, undefined)).toBe('وحدة ب وفروعها');
  });
  it('chosen levels, sorted, and asks for one when none is chosen', () => {
    expect(coveredText({ ...unit, mode: 'LEVELS', levels: [10, 9] }, 22)).toBe('المستوى 9 و10 — 22 وحدة');
    expect(coveredText({ ...unit, mode: 'LEVELS', levels: [8, 9] }, 2)).toBe('المستوى 8 و9 — وحدتان');
    expect(coveredText({ ...unit, mode: 'LEVELS' }, undefined)).toBe('اختر مستوى واحداً على الأقل');
  });
});

describe('how a grant reads in its matrix cell (anchor + mode, ADR-094 §22)', () => {
  const grant = (over: object) => ({ all: false, targets: [], ...over }) as never;
  it('none, every unit, its own unit, or a count — each with its mode', () => {
    expect(cellText(undefined)).toEqual({ anchor: 'تعيين', mode: null });
    expect(cellText(grant({ all: true }))).toEqual({ anchor: 'كل الوحدات', mode: null });
    expect(cellText(grant({}))).toEqual({ anchor: 'وحدته', mode: null });
    const multi = cellText(grant({ targets: [{ kind: 'ORGANIZATION' }, { kind: 'ORGANIZATION' }] }));
    expect(multi.anchor).toContain('2');
    expect(multi.mode).toBeNull();
  });
  it('one target reads the anchor and the mode («الوحدة وما دونها» / «هذه الوحدة فقط» / «مستويات محددة»)', () => {
    expect(cellText(grant({ targets: [{ kind: 'ORGANIZATION', name: 'جناح 1', includeDescendants: true }] })))
      .toEqual({ anchor: 'جناح 1', mode: 'الوحدة وما دونها' });
    expect(cellText(grant({ targets: [{ kind: 'ORGANIZATION', name: 'قسم 2', includeDescendants: false }] })))
      .toEqual({ anchor: 'قسم 2', mode: 'هذه الوحدة فقط' });
    expect(cellText(grant({ targets: [{ kind: 'ORGANIZATION', name: 'جناح 1', includeDescendants: true, levels: [3] }] })))
      .toEqual({ anchor: 'جناح 1', mode: 'مستويات محددة' });
  });
});

describe('«معتمد السلسلة الهرمية» in TNQL words', () => {
  it('reads «هذا المستوى فقط» and «مع جميع الوحدات التابعة (حيث لا معتمد مباشر)»', async () => {
    const { chainCoveredText } = await import('./UnitsDialog');
    expect(chainCoveredText({ id: 'a', name: 'قسم صحة 1-أ', mode: 'ONE', levels: [] }, undefined)).toBe('مستوى قسم صحة 1-أ فقط');
    expect(chainCoveredText({ id: 'a', name: 'مركز صحة واحد', mode: 'BRANCH', levels: [] }, 3)).toBe('مركز صحة واحد + 2 تابعة (حيث لا معتمد مباشر)');
  });
});
