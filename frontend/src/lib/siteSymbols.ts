/**
 * «رمز يظهر على الخريطة (اختياري)» for a site (owner, 10 Nov 2026; V32, ADR-048), as in MOVER: the curated catalogue of MOVER's
 * app/symbols/catalog.json (MIL-STD-2525C, APP-6 compatible, friendly), drawn offline by the bundled milsymbol. Display only.
 * MOVER's tactical graphics and control measures (route points, checkpoints, gates, supply and fuel points: the «G…» codes)
 * are not offered — this application registers facilities and draws no operations (CLAUDE.md scope); the server refuses them.
 */
export type SiteSymbol = { key: string; label: string; category: string; sidc: string; keywords: string };

export const SYMBOL_CATEGORIES: { key: string; label: string }[] = [
  { key: 'places', label: 'مواقع' },
  { key: 'command', label: 'قيادة وسيطرة' },
  { key: 'support', label: 'دعم وإسناد' },
  { key: 'units', label: 'وحدات' },
];

export const SITE_SYMBOLS: SiteSymbol[] = [
  { key: 'base', label: 'معسكر / قاعدة', category: 'places', sidc: 'SFGPIB----H----', keywords: 'معسكر قاعدة منشأة' },
  { key: 'field_hospital', label: 'مستشفى ميداني', category: 'places', sidc: 'SFGPIXH---H----', keywords: 'مستشفى طبي منشأة طبية' },
  { key: 'command_post', label: 'قيادة', category: 'command', sidc: 'SFGPUH---------', keywords: 'مقر قيادة قائد' },
  { key: 'signals', label: 'إشارة واتصالات', category: 'command', sidc: 'SFGPUUS--------', keywords: 'اتصالات لاسلكي' },
  { key: 'medical', label: 'طبابة', category: 'support', sidc: 'SFGPUSM--------', keywords: 'إسعاف طبي عيادة' },
  { key: 'logistics', label: 'لوجستيات', category: 'support', sidc: 'SFGPUSS--------', keywords: 'إمداد تموين مستودع' },
  { key: 'transport', label: 'نقل', category: 'support', sidc: 'SFGPUST--------', keywords: 'ناقلات شاحنات' },
  { key: 'maintenance', label: 'صيانة', category: 'support', sidc: 'SFGPUSX--------', keywords: 'ورشة إصلاح' },
  { key: 'unit', label: 'وحدة', category: 'units', sidc: 'SFGPU----------', keywords: 'وحدة عامة' },
  { key: 'infantry', label: 'مشاة', category: 'units', sidc: 'SFGPUCI--------', keywords: 'مشاة' },
  { key: 'armor', label: 'مدرعات', category: 'units', sidc: 'SFGPUCA--------', keywords: 'دبابات مدرعة' },
  { key: 'artillery', label: 'مدفعية', category: 'units', sidc: 'SFGPUCF--------', keywords: 'مدفع' },
  { key: 'recon', label: 'استطلاع', category: 'units', sidc: 'SFGPUCR--------', keywords: 'استكشاف' },
  { key: 'engineer', label: 'هندسة', category: 'units', sidc: 'SFGPUCE--------', keywords: 'مهندسين' },
  { key: 'security', label: 'أمن', category: 'units', sidc: 'SFGPUCIS-------', keywords: 'حماية حراسة' },
];

const SIDC_2525C = /^[A-Z][A-Z-][A-Z-][A-Z-][A-Z0-9-]{6}[A-Z0-9-]{5}$/;
const SIDC_APP6D = /^[0-9]{20}([0-9]{10})?$/;

/** Why a typed code cannot be a site symbol ('' when it can) — the same rule as the server (SiteService.symbolStandard). */
export function symbolProblem(code: string): string {
  const c = code.trim().toUpperCase();
  if (SIDC_2525C.test(c)) return c[0] === 'G' || c[0] === 'W' ? 'الرسوم التكتيكية وإجراءات السيطرة ورموز الطقس ليست رموز مواقع في هذا النظام.' : '';
  if (SIDC_APP6D.test(c)) return ['25', '45', '46'].includes(c.slice(4, 6)) ? 'الرسوم التكتيكية وإجراءات السيطرة ورموز الطقس ليست رموز مواقع في هذا النظام.' : '';
  return 'رمز غير صالح: يُقبل رمز MIL-STD-2525C من 15 حرفاً أو رمز APP-6D من 20 رقماً.';
}

/** milsymbol's standard for a code: the letter codes are MIL-STD-2525C, the number codes APP-6D. */
export const rendererStandard = (sidc: string) => (/^[0-9]/.test(sidc) ? 'APP6' : '2525');

/** The catalogue entry of a code, for its Arabic name; null for a code typed by hand. */
export const symbolEntry = (sidc: string | null | undefined) => SITE_SYMBOLS.find((s) => s.sidc === sidc) ?? null;

/** Arabic search over names and keywords. */
export function searchSymbols(q: string): SiteSymbol[] {
  const t = q.trim();
  return t ? SITE_SYMBOLS.filter((s) => s.label.includes(t) || s.keywords.includes(t)) : SITE_SYMBOLS;
}
