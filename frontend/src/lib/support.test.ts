import { describe, expect, it } from 'vitest';
import type { Permission } from '../api/types';
import { restriction, setSupportSeat } from './navigation';
import { inline, markdown, overdue } from './support';

// «دليل تمركز» documents (ADR-054) are rendered from this structure, never as HTML
describe('knowledge Markdown', () => {
  it('reads headings, numbered steps with a nested list, bullets and paragraphs', () => {
    const b = markdown('# عنوان\n\nفقرة **مهمة** هنا.\n\n1. أولاً\n   - فرع\n2. ثانياً\n\n- نقطة');
    expect(b.map((x) => x.kind)).toEqual(['h', 'p', 'ol', 'ul']);
    expect(b[1]).toEqual({ kind: 'p', text: [{ text: 'فقرة ' }, { text: 'مهمة', bold: true }, { text: ' هنا.' }] });
    expect(b[2].kind === 'ol' && b[2].items[0].sub[0]).toEqual([{ text: 'فرع' }]);
    expect(b[2].kind === 'ol' && b[2].items.length).toBe(2);
  });
  it('keeps markup-like text as text', () => {
    expect(inline('<script>alert(1)</script> و `code`')).toEqual([{ text: '<script>alert(1)</script> و ' }, { text: 'code', code: true }]);
  });
});

// «مركز الدعم» (ADR-053)
describe('support', () => {
  const now = Date.parse('2026-11-11T10:00:00Z');
  it('a case is late only while nobody has answered past its response time', () => {
    expect(overdue({ responseDue: '2026-11-11T09:00:00Z', firstResponseAt: null, status: 'OPEN' }, now)).toBe(true);
    expect(overdue({ responseDue: '2026-11-11T09:00:00Z', firstResponseAt: '2026-11-11T08:30:00Z', status: 'IN_PROGRESS' }, now)).toBe(false);
    expect(overdue({ responseDue: '2026-11-11T11:00:00Z', firstResponseAt: null, status: 'OPEN' }, now)).toBe(false);
    expect(overdue({ responseDue: '2026-11-11T09:00:00Z', firstResponseAt: null, status: 'WAITING_USER' }, now)).toBe(false);
  });
  it('the support centre is everyone\'s; the console a seat holder\'s or a configuration administrator\'s', () => {
    const none = (_p: Permission) => false;
    const configure = (p: Permission) => p === 'CONFIGURE';
    setSupportSeat(null);
    expect(restriction('support', none, false)).toBe(false);
    expect(restriction('support', none, true)).toBe(false);
    expect(restriction('supportConsole', none, false)).toBe(true);
    expect(restriction('supportConsole', configure, false)).toBe(false);
    setSupportSeat('AGENT');
    expect(restriction('supportConsole', none, false)).toBe(false);
    setSupportSeat(null);
  });
});
