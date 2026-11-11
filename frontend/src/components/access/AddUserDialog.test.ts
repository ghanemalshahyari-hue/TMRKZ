import { describe, expect, it } from 'vitest';
import { normalLogin } from './AddUserDialog';

// the same rule as UnitMemberService.normalLogin on the server (ADR-049)
describe('normalLogin', () => {
  it('keeps a plain User ID in lower case', () => {
    expect(normalLogin('U1234567')).toBe('u1234567');
    expect(normalLogin('  ali.saeed_2 ')).toBe('ali.saeed_2');
  });
  it('drops a DOMAIN\\ prefix and an @domain suffix', () => {
    expect(normalLogin(String.raw`CORP\u1234567`)).toBe('u1234567');
    expect(normalLogin('u1234567@corp.local')).toBe('u1234567');
  });
  it('refuses what is not a directory login', () => {
    expect(normalLogin('')).toBeNull();
    expect(normalLogin('a')).toBeNull();
    expect(normalLogin('bad login!')).toBeNull();
    expect(normalLogin('محمد')).toBeNull();
    expect(normalLogin('-dash')).toBeNull();
  });
});
