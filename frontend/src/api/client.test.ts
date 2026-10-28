import { describe, expect, it } from 'vitest';
import { ApiError, parseApiError } from './client';
import { parseOrgCsv } from '../lib/csv';

describe('API error parsing', () => {
  it('keeps the stable machine code and the Arabic message from the server', () => {
    const e = parseApiError(409, JSON.stringify({ code: 'RESERVATION_CONFLICT', message: 'المرفق محجوز خلال الفترة', traceId: 't-1', details: { resourceId: 'r1' } }));
    expect(e).toBeInstanceOf(ApiError);
    expect(e.code).toBe('RESERVATION_CONFLICT');
    expect(e.status).toBe(409);
    expect(e.message).toBe('المرفق محجوز خلال الفترة');
    expect(e.traceId).toBe('t-1');
    expect(e.details).toEqual({ resourceId: 'r1' });
  });

  it('falls back to a status-derived code for non-JSON proxy errors', () => {
    const e = parseApiError(502, '<html>Bad gateway</html>');
    expect(e.code).toBe('HTTP_502');
    expect(e.message.length).toBeGreaterThan(0);
  });

  it('maps a bare 401 to UNAUTHENTICATED with an Arabic message', () => {
    const e = parseApiError(401, '');
    expect(e.code).toBe('UNAUTHENTICATED');
    expect(e.message).toContain('الدخول');
  });

  it('uses a fallback message when the server omits one', () => {
    const e = parseApiError(403, JSON.stringify({ code: 'FORBIDDEN' }));
    expect(e.code).toBe('FORBIDDEN');
    expect(e.message).toContain('صلاحيات');
  });
});

describe('org structure CSV parsing', () => {
  it('skips the header and maps empty parents to null', () => {
    expect(parseOrgCsv('code,name,parentCode\nORG,المؤسسة,\nGA,الإدارة العامة,ORG\n')).toEqual([
      { code: 'ORG', name: 'المؤسسة', parentCode: null },
      { code: 'GA', name: 'الإدارة العامة', parentCode: 'ORG' },
    ]);
  });
});
