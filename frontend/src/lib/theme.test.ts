import { describe, expect, it } from 'vitest';
import { initialTheme } from './theme';

describe('the first theme', () => {
  it('a choice is kept', () => {
    expect(initialTheme('dark')).toBe('dark');
    expect(initialTheme('light')).toBe('light');
  });
  it('with no choice, the sand', () => expect(initialTheme(null)).toBe('light'));
});
