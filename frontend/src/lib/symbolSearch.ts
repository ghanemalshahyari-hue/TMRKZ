import { SITE_SYMBOLS, SYMBOL_CATEGORIES, type SiteSymbol } from './siteSymbols';

/**
 * Searching the site symbols by name (owner brief §11, 17 Nov 2026: "he doesn't know the code, he will search by name"). Not an
 * exact string match: the same Arabic normalisation on the names and on what is typed (أ/إ/آ → ا, ة → ه, ى → ي, ؤ → و, ئ → ي,
 * diacritics and tatweel removed, Arabic-Indic digits, spaces), the article and joined prefixes removed (ال، وال، بال، كال، فال،
 * لل), light endings (ات، ون، ين، ه), a dictionary of synonyms (طبي → طبابة، مستشفى، إسعاف، مركز صحي، وحدة طبية …), words
 * found from their start, and one typo forgiven in a longer word. Every word typed must be found; the best match comes first.
 */

const DIACRITICS = /[ً-ٰٟـ]/g;
const INDIC = '٠١٢٣٤٥٦٧٨٩';

export function normalizeArabic(s: string): string {
  return s
    .toLowerCase()
    .replace(DIACRITICS, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[٠-٩]/g, (d) => String(INDIC.indexOf(d)))
    .replace(/[\/\\\-–—_،,.()«»:؛;'"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const PREFIXES = ['وال', 'بال', 'كال', 'فال', 'لل', 'ال'];
const SUFFIXES = ['ات', 'ون', 'ين', 'ه'];

/** A word reduced to its stem for matching: the article and joined prefixes, then one light ending. */
export function stem(word: string): string {
  let w = word;
  for (const p of PREFIXES) {
    if (w.startsWith(p) && w.length - p.length >= 2) {
      w = w.slice(p.length);
      break;
    }
  }
  for (const s of SUFFIXES) {
    if (w.endsWith(s) && w.length - s.length >= 3) {
      w = w.slice(0, -s.length);
      break;
    }
  }
  return w;
}

const words = (s: string) => normalizeArabic(s).split(' ').filter(Boolean);

/** Words that mean the same thing here (owner brief §11, and the catalogue's own families). */
export const SYNONYMS: string[][] = [
  ['طبي', 'طبابة', 'مستشفى', 'إسعاف', 'مركز صحي', 'وحدة طبية', 'صحي', 'صحة', 'علاج', 'عيادة'],
  ['دروع', 'مدرعات', 'دبابات', 'آليات مدرعة', 'مدرعة', 'دبابة'],
  ['معسكر', 'قاعدة', 'موقع', 'منشأة', 'تمركز', 'ثكنة'],
  ['اتصالات', 'إشارة', 'لاسلكي', 'راديو', 'شبكة'],
  ['نقل', 'شاحنات', 'ناقلات', 'حركة', 'مركبات'],
  ['صيانة', 'ورشة', 'إصلاح', 'تصليح'],
  ['إمداد', 'تموين', 'لوجستيات', 'مستودع', 'مخزن', 'مخازن'],
  ['وقود', 'محروقات', 'بترول', 'ديزل', 'بنزين'],
  ['ذخيرة', 'عتاد', 'ذخائر'],
  ['مياه', 'ماء', 'تحلية'],
  ['أمن', 'حراسة', 'حماية', 'شرطة', 'انضباط'],
  ['قيادة', 'مقر', 'قائد', 'أركان', 'سيطرة'],
  ['هندسة', 'مهندسين', 'تحصين', 'ألغام'],
  ['مدفعية', 'مدافع', 'هاون', 'راجمات'],
  ['دفاع جوي', 'مضاد للطائرات', 'أرض جو'],
  ['طيران', 'طائرات', 'مروحيات', 'هليكوبتر'],
  ['استطلاع', 'استكشاف', 'مراقبة'],
  ['مشاة', 'جنود', 'راجلة'],
  ['كيميائي', 'كيماوي', 'نووي', 'إشعاعي', 'بيولوجي'],
  ['إدارة', 'إداري', 'شؤون إدارية'],
  ['مطار', 'مهبط', 'قاعدة جوية', 'مدرج'],
  ['ميناء', 'مرفأ', 'رصيف', 'بحري', 'قاعدة بحرية'],
  ['كهرباء', 'طاقة', 'مولدات'],
];

/** Damerau–Levenshtein distance, stopped early above `max`. */
function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      rowMin = Math.min(rowMin, d[i][j]);
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length][b.length];
}

/** How well one typed stem matches one indexed stem: exact, from its start, inside it. */
function wordScore(q: string, t: string): number {
  if (q === t) return 1;
  if (q.length >= 2 && t.startsWith(q)) return 0.8;
  if (q.length >= 3 && t.includes(q)) return 0.5;
  return 0;
}

/** The same, forgiving one typo in a longer word (two from seven letters): asked only when nothing matched directly. */
function typoScore(q: string, t: string): number {
  const direct = wordScore(q, t);
  if (direct || q.length < 4) return direct;
  const max = q.length >= 7 ? 2 : 1;
  return distance(q, t, max) <= max ? 0.45 : 0;
}

type Indexed = { symbol: SiteSymbol; fields: { stems: string[]; weight: number }[]; name: string };

const CATEGORY_LABEL = Object.fromEntries(SYMBOL_CATEGORIES.map((c) => [c.key, c.label]));
const INDEX: Indexed[] = SITE_SYMBOLS.map((s) => ({
  symbol: s,
  name: normalizeArabic(s.label),
  fields: [
    { stems: words(s.label).map(stem), weight: 3 },
    { stems: words(s.keywords).map(stem), weight: 2 },
    { stems: words(CATEGORY_LABEL[s.category] ?? '').map(stem), weight: 1 },
    { stems: words(s.en).map(stem), weight: 1 },
  ],
}));
const GROUPS = SYNONYMS.map((g) => g.map((term) => ({ text: term, stems: words(term).map(stem) })));

/**
 * The synonyms a typed stem stands for (a group it is a word of, exactly or from its start). A synonym of several words is
 * kept whole — «وحدة طبية», «مركز صحي» — so it never matches on «وحدة» or «مركز» alone.
 */
function synonymsOf(q: string): { text: string; stems: string[] }[] {
  const out: { text: string; stems: string[] }[] = [];
  for (const group of GROUPS) {
    if (group.some((term) => term.stems.length === 1 && strict(q, term.stems[0]) >= 0.8)) {
      for (const term of group) if (!(term.stems.length === 1 && term.stems[0] === q)) out.push(term);
    }
  }
  return out;
}

/** Exact or from the start only: what a synonym may match (no typo forgiven for a word the person did not type). */
function strict(q: string, t: string): number {
  return q === t ? 1 : q.length >= 2 && t.startsWith(q) ? 0.8 : 0;
}

function bestIn(item: Indexed, q: string, score: (q: string, t: string) => number = wordScore): number {
  let best = 0;
  for (const f of item.fields) for (const t of f.stems) best = Math.max(best, score(q, t) * f.weight);
  return best;
}

/** A synonym found in a symbol: every word of it, exactly or from its start, in the name or the keywords. */
function termIn(item: Indexed, stems: string[]): number {
  let sum = 0;
  for (const w of stems) {
    let best = 0;
    for (const f of item.fields.slice(0, 2)) for (const t of f.stems) best = Math.max(best, strict(w, t) * f.weight);
    if (!best) return 0;
    sum += best;
  }
  return sum / stems.length;
}

export type SymbolHit = { symbol: SiteSymbol; score: number; via: string | null };

/** The symbols for what was typed, best first; everything (in catalogue order) for an empty search. */
export function searchSymbols(query: string): SymbolHit[] {
  const qWords = words(query).map(stem).filter(Boolean);
  if (!qWords.length) return SITE_SYMBOLS.map((symbol) => ({ symbol, score: 0, via: null }));
  // a typo is forgiven only when the words as typed find nothing («دروع» never brings «درون», «قيادة» never «عيادة»)
  const direct = run(qWords, normalizeArabic(query), wordScore);
  return direct.length ? direct : run(qWords, normalizeArabic(query), typoScore);
}

function run(qWords: string[], phrase: string, score: (q: string, t: string) => number): SymbolHit[] {
  const hits: SymbolHit[] = [];
  for (const item of INDEX) {
    let total = 0;
    let via: string | null = null;
    let all = true;
    for (const q of qWords) {
      let s = bestIn(item, q, score);
      if (s < 1) {
        // a synonym found it: slightly below a word of its own
        for (const alt of synonymsOf(q)) {
          const a = termIn(item, alt.stems) * 0.85;
          if (a > s) {
            s = a;
            via = alt.text;
          }
        }
      }
      if (s === 0) {
        all = false;
        break;
      }
      total += s;
    }
    if (!all) continue;
    if (item.name === phrase) total += 3;
    else if (item.name.startsWith(phrase)) total += 2;
    hits.push({ symbol: item.symbol, score: total, via: via && !item.name.includes(normalizeArabic(via)) ? via : null });
  }
  return hits.sort((a, b) => b.score - a.score);
}
