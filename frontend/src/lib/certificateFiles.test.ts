import { describe, expect, it } from 'vitest';
import type { ImportPreview } from '../api/client';
import { bytesToBase64, healthLabel, missingFields, selectionKey } from './certificateFiles';

describe('certificate files (ADR-105)', () => {
  it('encodes bytes as base64, also past one chunk', () => {
    expect(bytesToBase64(new Uint8Array([0x30, 0x82, 0xff]))).toBe('MIL/');
    const big = new Uint8Array(70000).fill(65);
    expect(atob(bytesToBase64(big)).length).toBe(70000);
  });

  it('labels validity', () => {
    expect(healthLabel({ health: 'EXPIRED', daysLeft: -3 }).tone).toBe('bad');
    expect(healthLabel({ health: 'EXPIRING', daysLeft: 9 }).text).toContain('9');
    expect(healthLabel({ health: 'VALID', daysLeft: 400 }).tone).toBe('ok');
  });
});

describe('env import selection (ADR-105)', () => {
  const section: ImportPreview['sections'][number] = {
    section: 'OIDC', label: 'Keycloak', source: 'NONE', inFile: true, missing: [],
    fields: [
      { path: 'OIDC.serverUrl', field: 'serverUrl', label: 'عنوان الخادم', secret: false, required: true, current: null, imported: 'https://k',
        status: 'NEW', warning: null, selectable: true, selectedByDefault: true },
      { path: 'OIDC.clientSecret', field: 'clientSecret', label: 'سر العميل', secret: true, required: true, current: null, imported: '••••',
        status: 'NEW', warning: 'عميل التطبيق الآخر', selectable: true, selectedByDefault: false },
      { path: 'OIDC.realm', field: 'realm', label: 'المجال', secret: false, required: true, current: 'corp', imported: 'corp',
        status: 'SAME', warning: null, selectable: false, selectedByDefault: false },
    ],
  };

  it('lists required values still missing only for a touched section', () => {
    expect(missingFields(section, new Set())).toEqual([]);
    expect(missingFields(section, new Set(['OIDC.serverUrl']))).toEqual(['سر العميل']);
    expect(missingFields(section, new Set(['OIDC.serverUrl', 'OIDC.clientSecret']))).toEqual([]);
  });

  it('keys a selection by section in a stable order', () => {
    expect(selectionKey(['OIDC.realm', 'DIRECTORY.server', 'OIDC.clientId'])).toEqual({ OIDC: 'OIDC.clientId|OIDC.realm', DIRECTORY: 'DIRECTORY.server' });
  });
});
