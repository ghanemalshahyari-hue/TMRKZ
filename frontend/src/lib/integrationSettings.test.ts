import { describe, expect, it } from 'vitest';
import {
  AD_PRESET,
  EMPTY_DIRECTORY,
  EMPTY_OIDC,
  bindDescription,
  directoryFromSaved,
  directoryProblem,
  directoryUrl,
  isIpAddress,
  oidcFromSaved,
  oidcIssuer,
  oidcProblem,
  portFor,
} from './integrationSettings';

const dir = (p: Partial<typeof EMPTY_DIRECTORY> = {}) => ({ ...EMPTY_DIRECTORY, server: 'dc1.example.local', baseDn: 'DC=example,DC=local', domain: 'example.local', ...p });
const kc = (p: Partial<typeof EMPTY_OIDC> = {}) => ({ ...EMPTY_OIDC, serverUrl: 'https://sso.example.local/auth', realm: 'corp', clientId: 'tmrkz', clientSecret: 's', ...p });

describe('integration settings (ADR-092)', () => {
  it('derives the directory address as MOVER does: server, port and mode', () => {
    expect(directoryUrl(dir())).toBe('ldaps://dc1.example.local:636');
    expect(directoryUrl(dir({ securityMode: 'starttls', port: 389 }))).toBe('ldap://dc1.example.local:389');
    expect(directoryUrl(dir({ server: ' DC1.Example.Local ' }))).toBe('ldaps://dc1.example.local:636');
    expect(directoryUrl(dir({ server: '' }))).toBe('');
    expect(portFor('starttls', 636)).toBe(389);
    expect(portFor('ldaps', 389)).toBe(636);
    expect(portFor('ldaps', 3269)).toBe(3269);
  });

  it('describes how a person binds: as user@domain (MOVER), or found by the service account', () => {
    expect(bindDescription(dir())).toContain('{username}@example.local');
    expect(bindDescription(dir({ domain: '', bindDn: 'CN=svc,DC=example,DC=local' }))).toContain('حساب الخدمة');
    expect(bindDescription(dir({ domain: '', bindDn: '' }))).toContain('اكتب');
  });

  it('names the first problem before a save, with the server rules', () => {
    expect(directoryProblem(dir(), false)).toBe('');
    expect(directoryProblem(dir({ server: '' }), false)).toContain('اسم خادم');
    expect(directoryProblem(dir({ server: 'bad host!' }), false)).toContain('مضيف');
    expect(directoryProblem(dir({ baseDn: '' }), false)).toContain('Base DN');
    expect(directoryProblem(dir({ domain: '', bindDn: '' }), false)).toContain('حساب خدمة');
    expect(directoryProblem(dir({ domain: '', bindDn: 'CN=svc', bindPassword: '' }), true)).toBe('');
    expect(directoryProblem(dir({ usernameAttribute: '1bad' }), false)).toContain('سمة');
    expect(directoryProblem(dir({ caCertificatesPem: '-----BEGIN PRIVATE KEY-----' }), false)).toContain('مفتاح خاص');
    expect(directoryProblem(dir({ caCertificatesPem: 'hello' }), false)).toContain('PEM');
    expect(directoryProblem(dir({ port: 70000 }), false)).toContain('المنفذ');
    expect(isIpAddress('10.1.2.3')).toBe(true);
    expect(isIpAddress('dc1.example.local')).toBe(false);
  });

  it('fills the Active Directory preset with MOVER’s attribute names', () => {
    const f = { ...dir(), ...AD_PRESET };
    expect(f.usernameAttribute).toBe('sAMAccountName');
    expect(f.uuidAttribute).toBe('objectGUID');
    expect(f.employeeNumberAttribute).toBe('MilNumber');
    expect(f.rankAttribute).toBe('MilRankName');
    expect(directoryProblem(f, false)).toBe('');
  });

  it('derives the issuer as <server>/realms/<realm> unless written out, and checks the Keycloak form', () => {
    expect(oidcIssuer(kc())).toBe('https://sso.example.local/auth/realms/corp');
    expect(oidcIssuer(kc({ serverUrl: 'https://sso.example.local/auth/' }))).toBe('https://sso.example.local/auth/realms/corp');
    expect(oidcIssuer(kc({ issuer: 'https://other/realms/x/' }))).toBe('https://other/realms/x');
    expect(oidcIssuer(kc({ realm: '' }))).toBe('');
    expect(oidcProblem(kc(), false)).toBe('');
    expect(oidcProblem(kc({ serverUrl: '' }), false)).toContain('عنوان');
    expect(oidcProblem(kc({ serverUrl: 'sso.example.local' }), false)).toContain('https://');
    expect(oidcProblem(kc({ realm: 'bad realm' }), false)).toContain('Realm');
    expect(oidcProblem(kc({ clientSecret: '' }), false)).toContain('Secret');
    expect(oidcProblem(kc({ clientSecret: '' }), true)).toBe('');
    expect(oidcProblem(kc({ internalUrl: 'keycloak:8080' }), false)).toContain('الداخلي');
  });

  it('loads what the server returned into the form, never a secret', () => {
    const d = directoryFromSaved({ server: 'dc1', port: 389, securityMode: 'starttls', enabled: false, bindPasswordSet: true } as never);
    expect(d.server).toBe('dc1');
    expect(d.port).toBe(389);
    expect(d.securityMode).toBe('starttls');
    expect(d.enabled).toBe(false);
    expect(d.bindPassword).toBe('');
    expect(directoryFromSaved(null)).toEqual(EMPTY_DIRECTORY);
    const o = oidcFromSaved({ serverUrl: 'https://sso', realm: 'r', clientId: 'c', clientSecretSet: true } as never);
    expect(o.realm).toBe('r');
    expect(o.clientSecret).toBe('');
    expect(oidcFromSaved(undefined)).toEqual(EMPTY_OIDC);
  });
});
