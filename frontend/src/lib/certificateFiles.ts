import type { CertificateInfo, ImportPreview } from '../api/client';

/** Base64 of raw bytes, in chunks (a certificate file or a .pfx is small, but never one huge apply()). */
export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export async function fileToBase64(f: Blob): Promise<string> {
  return bytesToBase64(new Uint8Array(await f.arrayBuffer()));
}

/** The badge of a certificate's validity: what it says and how loud. */
export function healthLabel(c: Pick<CertificateInfo, 'health' | 'daysLeft'>): { text: string; tone: 'ok' | 'warn' | 'bad' } {
  switch (c.health) {
    case 'EXPIRED':
      return { text: 'منتهية', tone: 'bad' };
    case 'NOT_YET_VALID':
      return { text: 'لم تبدأ بعد', tone: 'bad' };
    case 'EXPIRING':
      return { text: `تنتهي خلال ${Math.max(0, c.daysLeft)} يوماً`, tone: 'warn' };
    default:
      return { text: `سارية (${c.daysLeft} يوماً)`, tone: 'ok' };
  }
}

/** What a section of an import would still lack with the values in force and the values chosen (ADR-105). */
export function missingFields(section: ImportPreview['sections'][number], selected: Set<string>): string[] {
  if (!section.fields.some((f) => selected.has(f.path))) return [];
  return section.fields.filter((f) => f.required && f.current == null && !selected.has(f.path)).map((f) => f.label);
}

/** The sections a selection touches, each with its chosen fields in a stable order (the key a passed test is kept under). */
export function selectionKey(paths: Iterable<string>): Record<string, string> {
  const by: Record<string, string[]> = {};
  for (const p of paths) {
    const s = p.slice(0, p.indexOf('.'));
    (by[s] ??= []).push(p);
  }
  const out: Record<string, string> = {};
  for (const [s, list] of Object.entries(by)) out[s] = list.sort().join('|');
  return out;
}
