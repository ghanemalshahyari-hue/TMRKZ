/**
 * Label strings the offline map must draw correctly: real road-name shapes (Arabic, English, mixed), route numbers,
 * punctuation and both digit systems. Fictional test strings, not official names.
 */
export type Sample = { id: string; kind: string; text: string };

export const SAMPLES: Sample[] = [
  { id: 'ar-1', kind: 'arabic', text: 'شارع الشيخ زايد' },
  { id: 'ar-2', kind: 'arabic', text: 'طريق الخيل' },
  { id: 'ar-3', kind: 'arabic', text: 'شارع الاتحاد' },
  { id: 'ar-4', kind: 'arabic', text: 'جسر القرهود' },
  { id: 'en-1', kind: 'english', text: 'Sheikh Zayed Road' },
  { id: 'en-2', kind: 'english', text: 'Al Khail Rd' },
  { id: 'mix-1', kind: 'mixed', text: 'طريق الإمارات E611' },
  { id: 'mix-2', kind: 'mixed', text: 'Al Khail Rd - شارع الخيل' },
  { id: 'route-1', kind: 'route', text: 'E 11' },
  { id: 'route-2', kind: 'route', text: 'D 94' },
  { id: 'punct-1', kind: 'punctuation', text: 'شارع (١٩)، دبي!' },
  { id: 'punct-2', kind: 'punctuation', text: '«الجميرا» - مخرج ٤٢؟' },
  { id: 'num-ar', kind: 'numerals', text: 'شارع ٢٠٢٦ / ٣١١' },
  { id: 'num-west', kind: 'numerals', text: 'شارع 2026 / 311' },
  { id: 'mirror-1', kind: 'mirroring', text: 'ط (١) «ب» [٢] {٣}' },
];

const PAIRS: Record<string, string> = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '«': '»', '»': '«' };

/** Brackets and guillemets swapped: drawn right to left, this is the picture of a double mirror. */
export const swapBrackets = (t: string) => [...t].map((c) => PAIRS[c] ?? c).join('');

const LETTER_PAIR = /(\p{L})(?=\p{L})/gu;

/** The same text with every letter kept from joining its neighbour (zero-width non-joiner): isolated letter forms. */
export const isolated = (t: string) => t.replace(LETTER_PAIR, '$1\u200C');

/** Isolated letters forced left to right in logical order: what a renderer with neither shaping nor bidi produces. */
export const forcedLtrIsolated = (t: string) => '\u202D' + isolated(t) + '\u202C';

/** Logical order forced left to right with shaping kept: right shapes, reversed order. */
export const forcedLtr = (t: string) => '\u202D' + t + '\u202C';

export const hasArabic = (t: string) => /[\u0600-\u06FF]/.test(t);

/** The paragraph direction by the first strong character (Unicode rules P2/P3), as MapLibre resolves a label. */
export function firstStrongDirection(t: string): 'rtl' | 'ltr' {
  for (const ch of t) {
    if (/[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/.test(ch)) return 'rtl';
    if (/\p{L}/u.test(ch)) return 'ltr';
  }
  return 'ltr';
}
