import { describe, expect, it } from 'vitest';
import { signOutNotice } from './signOut';

describe('signOutNotice (ADR-109)', () => {
  it('says the sign-out succeeded', () => {
    expect(signOutNotice('?signed-out=1')).toEqual({ kind: 'success', text: 'تم تسجيل الخروج بنجاح' });
  });
  it('warns when the identity provider kept its session', () => {
    const notice = signOutNotice('?signed-out=1&provider-session=1');
    expect(notice?.kind).toBe('warning');
    expect(notice?.text).toContain('تعذر إنهاء جلسة مزود الهوية');
  });
  it('says nothing on an ordinary visit', () => {
    expect(signOutNotice('')).toBeNull();
    expect(signOutNotice('?mode=manual')).toBeNull();
  });
});
