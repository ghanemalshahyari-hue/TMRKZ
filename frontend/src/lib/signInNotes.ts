/**
 * «إرشادات الدخول» on the sign-in page, kept by the administrator in the settings (owner, 17 Nov 2026: "I can modify it in
 * the setting … add more or remove"): a heading, a line under it, the notes in order and a footer. A note is guidance or
 * an important notice (a maintenance window, a change of procedure), may be hidden, and may show only between two dates.
 * The page shows them before anyone signs in, so they hold no personal or sensitive information.
 */
export type NoteKind = 'GUIDE' | 'NOTICE';
export type SignInNote = { id: string; kind: NoteKind; meta: string; title: string; text: string; hidden: boolean; from: string | null; to: string | null };
export type SignInBoard = { heading: string; subheading: string; footer: string; notes: SignInNote[] };

export const NOTE_KIND: Record<NoteKind, string> = { GUIDE: 'إرشاد', NOTICE: 'تنبيه مهم' };
export const LIMITS = { heading: 60, subheading: 90, meta: 40, title: 70, text: 400, notes: 8 } as const;

/** The board as the sign-in page shows it today (LoginPage), the starting point of the settings. */
export const DEFAULT_BOARD: SignInBoard = {
  heading: 'إرشادات الدخول',
  subheading: 'نظام المواقع والمرافق والإجراءات الإدارية',
  footer: 'التشغيل داخل الشبكة الداخلية فقط',
  notes: [
    { id: 'auto', kind: 'GUIDE', meta: 'الدخول الآلي', title: 'بالحساب المؤسسي', text: 'يتم عبر خدمة الدخول المؤسسية، ولا يطلب كلمة المرور إذا كنت قد سجلت الدخول فيها حديثاً.', hidden: false, from: null, to: null },
    { id: 'manual', kind: 'GUIDE', meta: 'الإدخال اليدوي', title: 'حساب محلي أو حساب مؤسسي', text: 'يتحقق Keycloak من حسابي admin وdeveloper المحليين، ويتحقق الدليل المؤسسي من باقي الحسابات. لا يحفظ النظام كلمة المرور.', hidden: false, from: null, to: null },
    { id: 'rights', kind: 'GUIDE', meta: 'الصلاحيات والحماية', title: 'الصلاحيات من جهتك', text: 'تُمنح الصلاحيات وفق انتمائك الوظيفي. يُوقف الدخول مؤقتاً بعد محاولات خاطئة متكررة.', hidden: false, from: null, to: null },
  ],
};

let seq = 0;
export const newNote = (kind: NoteKind = 'GUIDE'): SignInNote => ({ id: 'n' + Date.now().toString(36) + (seq++).toString(36), kind, meta: '', title: '', text: '', hidden: false, from: null, to: null });

/** The notes the sign-in page shows at {@code day} (yyyy-mm-dd): not hidden, inside their dates; notices first. */
export function visibleNotes(notes: readonly SignInNote[], day: string): SignInNote[] {
  const on = notes.filter((n) => !n.hidden && (!n.from || n.from <= day) && (!n.to || day <= n.to));
  return [...on.filter((n) => n.kind === 'NOTICE'), ...on.filter((n) => n.kind !== 'NOTICE')];
}

/** Moves a note up (-1) or down (+1); the list is unchanged at either end. */
export function moveNote(notes: readonly SignInNote[], id: string, by: -1 | 1): SignInNote[] {
  const i = notes.findIndex((n) => n.id === id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= notes.length) return [...notes];
  const out = [...notes];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/** What stops the board from being saved: the first problem, or empty. */
export function boardProblem(b: SignInBoard): string {
  if (!b.heading.trim()) return 'اكتب عنوان اللوحة.';
  if (b.heading.length > LIMITS.heading || b.subheading.length > LIMITS.subheading) return 'العنوان أو السطر تحته أطول من المسموح.';
  if (b.notes.length > LIMITS.notes) return `${LIMITS.notes} إرشادات على الأكثر.`;
  for (const [i, n] of b.notes.entries()) {
    const at = `الإرشاد ${i + 1}`;
    if (!n.title.trim() || !n.text.trim()) return `${at}: اكتب عنوانه ونصه.`;
    if (n.title.length > LIMITS.title || n.text.length > LIMITS.text || n.meta.length > LIMITS.meta) return `${at}: أطول من المسموح.`;
    if (n.from && n.to && n.to < n.from) return `${at}: تاريخ النهاية قبل البداية.`;
  }
  return '';
}
