import { describe, expect, it } from 'vitest';
import { coveredText, unitCount } from './UnitsDialog';
import { cellText } from './UnitMatrix';

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

describe('how a grant reads in its matrix cell', () => {
  const grant = (over: object) => ({ all: false, targets: [], ...over }) as never;
  it('none, every unit, its own unit, or a count', () => {
    expect(cellText(undefined)).toBe('تعيين');
    expect(cellText(grant({ all: true }))).toBe('كل الوحدات');
    expect(cellText(grant({}))).toBe('وحدته');
    expect(cellText(grant({ targets: [{ kind: 'ORGANIZATION' }, { kind: 'ORGANIZATION' }] }))).toBe('وحدتان');
  });
});
