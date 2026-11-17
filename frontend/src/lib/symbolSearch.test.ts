import { describe, expect, it } from 'vitest';
import { SITE_SYMBOLS } from './siteSymbols';
import { normalizeArabic, searchSymbols, stem } from './symbolSearch';

const names = (q: string) => searchSymbols(q).map((h) => h.symbol.label);

describe('the site symbols are found by name (owner brief §10–12)', () => {
  it('a wide Arabic catalogue in the ten categories, no code shown as a name', () => {
    expect(SITE_SYMBOLS.length).toBeGreaterThanOrEqual(80);
    expect(new Set(SITE_SYMBOLS.map((s) => s.category))).toEqual(new Set(['places', 'command', 'units', 'medical', 'support', 'transport', 'maintenance', 'signals', 'security', 'facilities']));
    expect(new Set(SITE_SYMBOLS.map((s) => s.sidc)).size).toBe(SITE_SYMBOLS.length);
    expect(SITE_SYMBOLS.every((s) => /[؀-ۿ]/.test(s.label) && !/[A-Z]{4}/.test(s.label))).toBe(true);
  });

  it('normalises the Arabic letters, the article and the spaces on both sides', () => {
    expect(normalizeArabic('  إسعافٌ   الطبيّة ')).toBe('اسعاف الطبيه');
    expect(normalizeArabic('مستشفى')).toBe(normalizeArabic('مستشفي'));
    expect(stem('المدرعات')).toBe('مدرع');
    expect(stem(normalizeArabic('والدبابة'))).toBe('دباب');
  });

  it('«طبي» finds طبابة، مستشفى، إسعاف، مركز صحي and the medical facility', () => {
    const got = names('طبي');
    for (const want of ['طبابة', 'مستشفى ميداني', 'إسعاف', 'مركز صحي', 'منشأة طبية']) expect(got).toContain(want);
    // and nothing else: a synonym of two words is never matched on «وحدة» or «مركز» alone
    for (const not of ['وحدة', 'مشاة', 'مركز اتصالات', 'مركز أبحاث', 'ذخيرة', 'دبابات']) expect(got).not.toContain(not);
    expect(got.length).toBeLessThanOrEqual(10);
  });

  it('«دروع» finds مدرعات، دبابات and armour on wheels', () => {
    const got = names('دروع');
    for (const want of ['مدرعات', 'دبابات', 'مدرعات على عجلات']) expect(got).toContain(want);
    for (const not of ['طبابة', 'طائرات بدون طيار', 'مطار / قاعدة جوية']) expect(got).not.toContain(not);
  });

  it('«معسكر» finds the camp first, then the other bases', () => {
    const got = names('معسكر');
    expect(got[0]).toBe('معسكر / قاعدة');
    expect(got).toContain('مطار / قاعدة جوية');
  });

  it('forgives hamza, taa marbuta, alef maqsura, the article, a missing ending and one typo', () => {
    expect(names('اسعاف')).toContain('إسعاف');
    expect(names('طبابه')[0]).toBe('طبابة');
    expect(names('المستشفي')).toContain('مستشفى ميداني');
    expect(names('مدرع')).toContain('مدرعات');
    expect(names('صيانه')[0]).toBe('صيانة');
    expect(names('مستشقى')).toContain('مستشفى ميداني'); // one letter wrong
    expect(names('اتصلات')).toContain('إشارة واتصالات'); // one letter missing
  });

  it('every word typed must be found; a nonsense word finds nothing', () => {
    expect(names('صيانة ثقيلة')[0]).toBe('صيانة ثقيلة');
    expect(names('مشاة ميكانيكية')[0]).toBe('مشاة ميكانيكية');
    expect(names('زززز')).toEqual([]);
  });

  it('an empty search lists everything', () => {
    expect(searchSymbols('  ').length).toBe(SITE_SYMBOLS.length);
  });
});
