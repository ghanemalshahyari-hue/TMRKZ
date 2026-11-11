import type { SupportCategory, SupportPriority, SupportStatus } from '../api/client';

/** «مركز الدعم» (ADR-053): the Arabic names the server's codes are shown with. */
export const CATEGORY_LABEL: Record<SupportCategory, string> = {
  SIGN_IN: 'الدخول والحساب',
  PERMISSIONS: 'الصلاحيات',
  REQUESTS: 'الطلبات والاعتمادات',
  MAP: 'الخريطة والمواقع',
  STATIONING: 'التمركز',
  DATA: 'بيانات غير صحيحة',
  NOTIFICATIONS: 'الإشعارات',
  PERFORMANCE: 'بطء أو تعطل',
  OTHER: 'أخرى',
};

export const PRIORITY_LABEL: Record<SupportPriority, { name: string; hint: string }> = {
  CRITICAL: { name: 'حرجة', hint: 'لا يمكن العمل إطلاقاً — خلال ساعة' },
  HIGH: { name: 'عالية', hint: 'عمل مهم متوقف — خلال 4 ساعات' },
  NORMAL: { name: 'عادية', hint: 'خلال 24 ساعة' },
  LOW: { name: 'منخفضة', hint: 'سؤال أو اقتراح — خلال 72 ساعة' },
};

export const STATUS_LABEL: Record<SupportStatus, string> = {
  OPEN: 'مفتوح',
  IN_PROGRESS: 'قيد المعالجة',
  WAITING_USER: 'بانتظار ردك',
  RESOLVED: 'تم الحل',
  CLOSED: 'مغلق',
};

/** The same status seen from «لوحة الدعم»: waiting for the user, not for the agent. */
export const STATUS_LABEL_STAFF: Record<SupportStatus, string> = { ...STATUS_LABEL, WAITING_USER: 'بانتظار المستخدم' };

export const EVENT_LABEL: Record<string, string> = {
  OPENED: 'فُتح البلاغ',
  CLAIMED: 'استُلم',
  ASSIGNED: 'أُسند',
  PRIORITY: 'غُيّرت الأولوية',
  REPLIED: 'رد الدعم',
  NOTE: 'ملاحظة داخلية',
  REQUESTER_REPLIED: 'رد المستخدم',
  RESOLVED: 'حُلّ',
  REOPENED: 'أُعيد فتحه',
  CLOSED_BY_REQUESTER: 'أغلقه المستخدم',
  CLOSED: 'أُغلق',
};

/** Only the browser's own facts go with a case, never a page's contents (the server keeps these keys only). */
export function clientInfo(): Record<string, string> {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const m = /Edg\/(\d+)/.exec(ua) ?? /Firefox\/(\d+)/.exec(ua) ?? /Chrome\/(\d+)/.exec(ua);
  const name = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : 'متصفح';
  return {
    browser: m ? `${name} ${m[1]}` : name,
    platform: typeof navigator !== 'undefined' ? navigator.platform : '',
    screen: typeof screen !== 'undefined' ? `${screen.width}x${screen.height}` : '',
    language: typeof navigator !== 'undefined' ? navigator.language : '',
    theme: typeof document !== 'undefined' ? document.documentElement.dataset.theme ?? 'auto' : '',
  };
}

/** The screen the person came from, kept by the shell (the support pages themselves are never it). */
export const LAST_VIEW_KEY = 'tmrkz.lastView';
export function lastView(): string | null {
  try {
    const v = sessionStorage.getItem(LAST_VIEW_KEY);
    return v && /^[A-Za-z]{1,40}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

export function overdue(row: { responseDue: string; firstResponseAt: string | null; status: SupportStatus }, now = Date.now()): boolean {
  return !row.firstResponseAt && (row.status === 'OPEN' || row.status === 'IN_PROGRESS') && Date.parse(row.responseDue) < now;
}

// ---- Markdown of the knowledge documents, rendered without HTML -------------------------------------------------------

export type Inline = { text: string; bold?: boolean; code?: boolean };
export type Block =
  | { kind: 'h'; level: 1 | 2 | 3; text: Inline[] }
  | { kind: 'p'; text: Inline[] }
  | { kind: 'ol' | 'ul'; items: { text: Inline[]; sub: Inline[][] }[] };

export function inline(s: string): Inline[] {
  const out: Inline[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m.index > last) out.push({ text: s.slice(last, m.index) });
    out.push(m[1] !== undefined ? { text: m[1], bold: true } : { text: m[2], code: true });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ text: s.slice(last) });
  return out;
}

/** Headings, paragraphs, numbered and bulleted lists, one nested level; anything else is text. */
export function markdown(src: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: Extract<Block, { kind: 'ol' | 'ul' }> | null = null;
  const flush = () => {
    if (para.length) blocks.push({ kind: 'p', text: inline(para.join(' ')) });
    para = [];
  };
  for (const raw of src.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    const sub = /^\s{2,}[-*]\s+(.*)$/.exec(line);
    const ol = /^\d+\.\s+(.*)$/.exec(line);
    const ul = /^[-*]\s+(.*)$/.exec(line);
    if (!line.trim()) {
      flush();
      list = null;
    } else if (h) {
      flush();
      list = null;
      blocks.push({ kind: 'h', level: h[1].length as 1 | 2 | 3, text: inline(h[2]) });
    } else if (sub && list && list.items.length) {
      list.items[list.items.length - 1].sub.push(inline(sub[1]));
    } else if (ol || ul) {
      flush();
      const kind = ol ? 'ol' : 'ul';
      if (!list || list.kind !== kind) {
        list = { kind, items: [] };
        blocks.push(list);
      }
      list.items.push({ text: inline((ol ?? ul)![1]), sub: [] });
    } else {
      list = null;
      para.push(line.trim());
    }
  }
  flush();
  return blocks;
}
