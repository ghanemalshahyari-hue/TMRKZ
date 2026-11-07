import { describe, expect, it } from 'vitest';
import { cleanNumberText, parseNumberText } from './NumberField';

describe('typing a number', () => {
  it('takes Arabic-Indic and Persian digits and the Arabic decimal mark', () => {
    expect(cleanNumberText('٥٠٠')).toBe('500');
    expect(cleanNumberText('۲۴')).toBe('24');
    expect(cleanNumberText('٢٫٥')).toBe('2.5');
    expect(cleanNumberText('2,5')).toBe('2.5');
  });

  it('drops what is not a number and keeps one decimal point', () => {
    expect(cleanNumberText('12a b')).toBe('12');
    expect(cleanNumberText('1.2.3')).toBe('1.23');
    expect(cleanNumberText('-5')).toBe('5');
  });

  it('an empty field is no value, not zero, and a half-typed decimal still reads', () => {
    expect(parseNumberText('')).toBeNull();
    expect(parseNumberText('.')).toBeNull();
    expect(parseNumberText('0')).toBe(0);
    expect(parseNumberText('1.')).toBe(1);
  });
});
