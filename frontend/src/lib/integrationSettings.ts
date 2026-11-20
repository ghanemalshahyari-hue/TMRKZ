/**
 * «إعدادات التكامل» (owner, 20 Nov 2026; ADR-092): the enterprise directory and the automatic sign-in's Keycloak, described
 * on the screen as MOVER describes them. These helpers derive what the server will make of the form (the directory address,
 * how a person binds, the realm's issuer), fill the Active Directory preset, and name the first problem before a save.
 */

export type SecurityMode = 'ldaps' | 'starttls';

export type DirectoryForm = {
  enabled: boolean;
  server: string;
  port: number;
  securityMode: SecurityMode;
  domain: string;
  baseDn: string;
  bindDn: string;
  bindPassword: string;
  usernameAttribute: string;
  uuidAttribute: string;
  employeeNumberAttribute: string;
  userObjectClass: string;
  rankAttribute: string;
  positionAttribute: string;
  unitIdAttribute: string;
  unitNameAttribute: string;
  mainUnitIdAttribute: string;
  caCertificatesPem: string;
  timeoutSeconds: number;
};

export type OidcForm = {
  enabled: boolean;
  serverUrl: string;
  realm: string;
  clientId: string;
  clientSecret: string;
  internalUrl: string;
  issuer: string;
  redirectUri: string;
  caCertificatesPem: string;
};

export const EMPTY_DIRECTORY: DirectoryForm = {
  enabled: true,
  server: '',
  port: 636,
  securityMode: 'ldaps',
  domain: '',
  baseDn: '',
  bindDn: '',
  bindPassword: '',
  usernameAttribute: 'sAMAccountName',
  uuidAttribute: 'objectGUID',
  employeeNumberAttribute: 'employeeNumber',
  userObjectClass: 'user',
  rankAttribute: '',
  positionAttribute: '',
  unitIdAttribute: '',
  unitNameAttribute: '',
  mainUnitIdAttribute: '',
  caCertificatesPem: '',
  timeoutSeconds: 10,
};

export const EMPTY_OIDC: OidcForm = {
  enabled: true,
  serverUrl: '',
  realm: '',
  clientId: '',
  clientSecret: '',
  internalUrl: '',
  issuer: '',
  redirectUri: '',
  caCertificatesPem: '',
};

/** Active Directory as MOVER reads it: the login name, the stable identifier, the object class and MOVER's own attributes. */
export const AD_PRESET: Partial<DirectoryForm> = {
  usernameAttribute: 'sAMAccountName',
  uuidAttribute: 'objectGUID',
  userObjectClass: 'user',
  employeeNumberAttribute: 'MilNumber',
  rankAttribute: 'MilRankName',
  positionAttribute: 'MilOccupation',
  unitNameAttribute: 'MilCurrentUnitName',
};

/** A standard (inetOrgPerson) directory. */
export const STANDARD_PRESET: Partial<DirectoryForm> = {
  usernameAttribute: 'uid',
  uuidAttribute: 'entryUUID',
  userObjectClass: 'inetOrgPerson',
  employeeNumberAttribute: 'employeeNumber',
};

/** The port that goes with the mode, when the port still is the other mode's default. */
export function portFor(mode: SecurityMode, current: number): number {
  if (mode === 'ldaps' && (current === 389 || !current)) return 636;
  if (mode === 'starttls' && (current === 636 || !current)) return 389;
  return current;
}

/** The address the server will dial. */
export function directoryUrl(f: Pick<DirectoryForm, 'server' | 'port' | 'securityMode'>): string {
  const host = f.server.trim().toLowerCase();
  if (!host) return '';
  return (f.securityMode === 'ldaps' ? 'ldaps://' : 'ldap://') + host + ':' + (f.port || (f.securityMode === 'ldaps' ? 636 : 389));
}

/** How a person's password is checked: their own bind as user@domain (MOVER), or found first by the service account. */
export function bindDescription(f: Pick<DirectoryForm, 'domain' | 'bindDn'>): string {
  const domain = f.domain.trim();
  if (domain) return 'كل شخص يدخل بحسابه: {username}@' + domain;
  if (f.bindDn.trim()) return 'حساب الخدمة يجد السجل أولاً، ثم يُتحقق من كلمة مرور الشخص بربطه';
  return 'اكتب نطاق الدخول، أو حساب خدمة للقراءة';
}

const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252}[A-Za-z0-9])?$/;
const IP = /^\d{1,3}(\.\d{1,3}){3}$/;
const ATTR = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;

/** The first reason the directory cannot be saved (the same rules as the server), or empty. */
export function directoryProblem(f: DirectoryForm, passwordStored: boolean): string {
  if (!f.server.trim()) return 'اكتب اسم خادم الدليل.';
  if (!HOST.test(f.server.trim())) return 'اسم الخادم ليس اسم مضيف صالحاً.';
  if (!f.port || f.port < 1 || f.port > 65535) return 'المنفذ بين 1 و65535.';
  if (!f.baseDn.trim()) return 'اكتب قاعدة البحث (Base DN).';
  if (!f.domain.trim() && !(f.bindDn.trim() && (f.bindPassword || passwordStored))) return 'بلا نطاق دخول يلزم حساب خدمة: اسمه المميز وكلمة مروره.';
  for (const [k, v] of Object.entries({
    'سمة اسم الدخول': f.usernameAttribute,
    'سمة المعرّف الثابت': f.uuidAttribute,
    'سمة الرقم الوظيفي': f.employeeNumberAttribute,
    'صنف الكائن': f.userObjectClass,
  })) {
    if (!v.trim() || !ATTR.test(v.trim())) return k + ': اسم سمة غير صالح.';
  }
  for (const [k, v] of Object.entries({
    'سمة الرتبة': f.rankAttribute,
    'سمة المنصب': f.positionAttribute,
    'سمة معرّف الوحدة': f.unitIdAttribute,
    'سمة اسم الوحدة': f.unitNameAttribute,
    'سمة الوحدة الرئيسية': f.mainUnitIdAttribute,
  })) {
    if (v.trim() && !ATTR.test(v.trim())) return k + ': اسم سمة غير صالح.';
  }
  if (f.caCertificatesPem.includes('PRIVATE KEY')) return 'لُصق مفتاح خاص؛ المطلوب شهادة الجهة المصدرة فقط.';
  if (f.caCertificatesPem.trim() && !f.caCertificatesPem.includes('BEGIN CERTIFICATE')) return 'الشهادة ليست بصيغة PEM.';
  if (!f.timeoutSeconds || f.timeoutSeconds < 1 || f.timeoutSeconds > 120) return 'المهلة بين 1 و120 ثانية.';
  return '';
}

/** Whether the server is written as a bare IP address: the certificate must then name that address. */
export function isIpAddress(server: string): boolean {
  return IP.test(server.trim());
}

/** The realm's issuer the server will expect in every token: as MOVER, <server>/realms/<realm>, unless written out. */
export function oidcIssuer(f: Pick<OidcForm, 'serverUrl' | 'realm' | 'issuer'>): string {
  if (f.issuer.trim()) return f.issuer.trim().replace(/\/+$/, '');
  const server = f.serverUrl.trim().replace(/\/+$/, '');
  if (!server || !f.realm.trim()) return '';
  return server + '/realms/' + f.realm.trim();
}

const REALM = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** The first reason the Keycloak cannot be saved, or empty. */
export function oidcProblem(f: OidcForm, secretStored: boolean): string {
  const server = f.serverUrl.trim();
  if (!server) return 'اكتب عنوان خادم Keycloak.';
  if (!/^https?:\/\/[^\s/]+/.test(server)) return 'عنوان الخادم يبدأ بـ https:// (أو http:// للتجربة).';
  if (!f.realm.trim() || !REALM.test(f.realm.trim())) return 'اكتب اسم المجال (Realm).';
  if (!f.clientId.trim()) return 'اكتب معرّف العميل (Client ID).';
  if (!f.clientSecret && !secretStored) return 'اكتب سر العميل (Client Secret).';
  if (f.internalUrl.trim() && !/^https?:\/\/[^\s/]+/.test(f.internalUrl.trim())) return 'العنوان الداخلي يبدأ بـ http:// أو https://.';
  if (f.redirectUri.trim() && !/^https?:\/\/[^\s/]+/.test(f.redirectUri.trim())) return 'عنوان العودة يبدأ بـ http:// أو https://.';
  if (f.caCertificatesPem.includes('PRIVATE KEY')) return 'لُصق مفتاح خاص؛ المطلوب شهادة الجهة المصدرة فقط.';
  if (f.caCertificatesPem.trim() && !f.caCertificatesPem.includes('BEGIN CERTIFICATE')) return 'الشهادة ليست بصيغة PEM.';
  return '';
}

/** The settings as the server returned them (no secret), into the form; absent values keep the defaults. */
export function directoryFromSaved(saved: Partial<Record<keyof DirectoryForm, unknown>> | null | undefined): DirectoryForm {
  if (!saved) return { ...EMPTY_DIRECTORY };
  const out: DirectoryForm = { ...EMPTY_DIRECTORY };
  for (const key of Object.keys(EMPTY_DIRECTORY) as (keyof DirectoryForm)[]) {
    const v = saved[key];
    if (v == null) continue;
    if (key === 'enabled') out.enabled = !!v;
    else if (key === 'port' || key === 'timeoutSeconds') out[key] = Number(v);
    else if (key === 'securityMode') out.securityMode = v === 'starttls' ? 'starttls' : 'ldaps';
    else out[key] = String(v);
  }
  out.bindPassword = '';
  return out;
}

export function oidcFromSaved(saved: Partial<Record<keyof OidcForm, unknown>> | null | undefined): OidcForm {
  if (!saved) return { ...EMPTY_OIDC };
  const out: OidcForm = { ...EMPTY_OIDC };
  for (const key of Object.keys(EMPTY_OIDC) as (keyof OidcForm)[]) {
    const v = saved[key];
    if (v == null) continue;
    if (key === 'enabled') out.enabled = !!v;
    else out[key] = String(v);
  }
  out.clientSecret = '';
  return out;
}

export const SOURCE_LABEL: Record<string, string> = {
  SAVED: 'محفوظة في تمركز وسارية',
  ENV: 'من ملف البيئة (.env) على الخادم',
  NONE: 'غير مهيأة',
};
