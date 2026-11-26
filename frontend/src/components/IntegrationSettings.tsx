import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { DirectoryTestResult, DirectoryInspectResult, DirectoryConnectResult, IntegrationStatus, IntegrationView, OidcTestResult , AssistantView, AssistantForm, AssistantTestResult } from '../api/types';
import { useApp } from '../lib/app';
import { fullTime } from '../lib/dates';
import {
  AD_PRESET,
  SOURCE_LABEL,
  STANDARD_PRESET,
  bindDescription,
  directoryFromSaved,
  directoryProblem,
  directoryUrl,
  isIpAddress,
  oidcFromSaved,
  oidcIssuer,
  oidcProblem,
  portFor,
  type DirectoryForm,
  type OidcForm,
  type SecurityMode,
} from '../lib/integrationSettings';

/**
 * «إعدادات التكامل» (owner, 20 Nov 2026; ADR-092), as MOVER's page: the enterprise directory of the manual sign-in and the
 * Keycloak of the automatic button, entered here by whoever configures the system, tested with the values on the screen,
 * saved on the server (secrets encrypted, never shown again) and in force at once — no file on the server, no restart.
 * Nothing saved, or a section switched off: the server's .env applies, and the screen shows those values.
 */
export function IntegrationSettings() {
  const [live, setLive] = useState<IntegrationStatus | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    api.integrationStatus().then(setLive, () => setLive(null));
  }, [tick]);
  const refresh = () => setTick((t) => t + 1);
  return (
    <>
      <DirectorySection live={live?.directory ?? null} onChanged={refresh} />
      <OidcSection live={live?.oidc ?? null} onChanged={refresh} />
      <AssistantSection onChanged={refresh} />
    </>
  );
}

const LIVE: Record<'UP' | 'DOWN' | 'NOT_CONFIGURED', [string, string]> = { UP: ['يعمل', 'green'], DOWN: ['غير متصل', 'red'], NOT_CONFIGURED: ['غير مهيأ', ''] };

/** The live state of a section (ADR-094): checked when the settings open and after every save. */
function LiveBadge({ live }: { live: { state: 'UP' | 'DOWN' | 'NOT_CONFIGURED'; message: string } | null }) {
  if (!live) return <span className="pill" data-testid="live-badge">…</span>;
  const [label, tone] = LIVE[live.state];
  return <span className={'pill ' + tone} title={live.message} data-testid="live-badge" data-state={live.state}>{label}</span>;
}

function Source({ view }: { view: IntegrationView | null }) {
  if (!view) return <p className="micro muted">جارٍ التحميل…</p>;
  return (
    <p className="micro muted" style={{ margin: '6px 0 12px' }}>
      الحالة: <b>{SOURCE_LABEL[view.source] ?? view.source}</b>
      {view.updatedAt ? ' · آخر حفظ ' + fullTime(view.updatedAt) : ''}
      {!view.keyConfigured && <span className="note red" style={{ display: 'block', marginTop: 6 }}>مفتاح حماية الإعدادات (TMRKZ_HR_SETTINGS_KEY) غير مهيأ في بيئة التشغيل؛ لا يمكن حفظ كلمة مرور أو سر.</span>}
      {view.secretError && <span className="note orange" style={{ display: 'block', marginTop: 6 }}>{view.secretError}</span>}
      {view.error && <span className="note red" style={{ display: 'block', marginTop: 6 }}>{view.error}</span>}
    </p>
  );
}

function EnvRow({ env, keys }: { env: Record<string, unknown>; keys: [string, string][] }) {
  const rows = keys.filter(([k]) => env[k] != null && env[k] !== '' && env[k] !== false);
  if (!rows.length) return <p className="micro muted">لا قيم في ملف البيئة.</p>;
  return (
    <dl className="int-env">
      {rows.map(([k, label]) => (
        <div key={k}>
          <dt>{label}</dt>
          <dd dir="ltr">{String(env[k])}</dd>
        </div>
      ))}
    </dl>
  );
}

function DirectorySection({ live, onChanged }: { live: IntegrationStatus['directory'] | null; onChanged: () => void }) {
  const app = useApp();
  const [view, setView] = useState<IntegrationView | null>(null);
  const [form, setForm] = useState<DirectoryForm>(directoryFromSaved(null));
  const [testLogin, setTestLogin] = useState('');
  const [testPassword, setTestPassword] = useState('');
  const [test, setTest] = useState<DirectoryTestResult | null>(null);
  const [inspect, setInspect] = useState<DirectoryInspectResult | null>(null);
  const [connected, setConnected] = useState<DirectoryConnectResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [showEnv, setShowEnv] = useState(false);

  // the mapping preview: each app field, the directory attribute it is mapped to, and the value found on the test entry
  const inspectMap: [string, keyof DirectoryForm][] = [
    ['اسم الدخول', 'usernameAttribute'],
    ['المعرّف الثابت', 'uuidAttribute'],
    ['الرقم الوظيفي / العسكري', 'employeeNumberAttribute'],
    ['الرتبة', 'rankAttribute'],
    ['المنصب', 'positionAttribute'],
    ['معرّف الوحدة', 'unitIdAttribute'],
    ['اسم الوحدة', 'unitNameAttribute'],
    ['الوحدة الرئيسية', 'mainUnitIdAttribute'],
  ];

  const load = () =>
    api.integrationDirectory().then((v) => {
      setView(v);
      setForm(directoryFromSaved(v.saved as never));
    }, (e: Error) => app.toast(e.message));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const passwordStored = !!(view?.saved && (view.saved as { bindPasswordSet?: boolean }).bindPasswordSet);
  const problem = directoryProblem(form, passwordStored);
  const set = (p: Partial<DirectoryForm>) => {
    setForm({ ...form, ...p });
    setTest(null);
    setInspect(null);
    setConnected(null);
  };
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await fn();
      if (done) app.toast(done);
    } catch (e) {
      app.toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const field = (key: keyof DirectoryForm, label: string, hint?: string, type = 'text') => (
    <label className="field">
      <span>
        {label}
        {hint ? <small className="muted"> — {hint}</small> : null}
      </span>
      <input
        type={type}
        dir="ltr"
        value={String(form[key] ?? '')}
        autoComplete={type === 'password' ? 'new-password' : 'off'}
        onChange={(e) => set({ [key]: type === 'number' ? Number(e.target.value) : e.target.value } as Partial<DirectoryForm>)}
      />
    </label>
  );

  return (
    <section className="card padding int-settings" data-testid="integration-directory" style={{ gridColumn: '1 / -1' }}>
      <div className="flex spread">
        <h2>إعدادات التكامل — الدليل المؤسسي (LDAP)</h2>
        <span className="flex" style={{ gap: 6 }}><LiveBadge live={live} /><span className="pill">{view ? SOURCE_LABEL[view.source] : '…'}</span></span>
      </div>
      <Source view={view} />
      <p className="micro muted" style={{ margin: '0 0 12px' }}>
        الدخول اليدوي: يُتحقق من اسم المستخدم وكلمة المرور بربطٍ مباشر بالدليل عبر اتصال مؤمَّن (LDAPS أو StartTLS) بشهادة الجهة المصدرة.
        التغيير يسري فور الحفظ من غير إعادة تشغيل، ويتقدم على قيم ملف البيئة.
      </p>
      <div className="form-grid">
        {field('server', 'خادم الدليل', 'الاسم الذي صدرت له الشهادة')}
        <label className="field">
          <span>وضع التأمين</span>
          <select value={form.securityMode} onChange={(e) => set({ securityMode: e.target.value as SecurityMode, port: portFor(e.target.value as SecurityMode, form.port) })}>
            <option value="ldaps">LDAPS (636)</option>
            <option value="starttls">StartTLS (389)</option>
          </select>
        </label>
        {field('port', 'المنفذ', undefined, 'number')}
        {field('domain', 'نطاق الدخول', 'يدخل كل شخص بحسابه user@domain؛ فارغاً: من DC=… في قاعدة البحث')}
        {field('baseDn', 'قاعدة البحث (Base DN)', 'مثل DC=example,DC=local')}
        {field('bindDn', 'حساب الخدمة (اختياري — لا يلزم)', 'الاسم المميز')}
        <label className="field">
          <span>كلمة مرور حساب الخدمة {passwordStored ? '(محفوظة؛ اتركها فارغة للإبقاء عليها)' : ''}</span>
          <input type="password" dir="ltr" autoComplete="new-password" value={form.bindPassword} onChange={(e) => set({ bindPassword: e.target.value })} />
        </label>
        {field('timeoutSeconds', 'المهلة (ثانية)', undefined, 'number')}
      </div>
      <p className="micro muted" style={{ margin: '4px 0 10px' }} data-testid="directory-derived">
        العنوان: <code dir="ltr">{directoryUrl(form) || '—'}</code> · {bindDescription(form)}
        {isIpAddress(form.server) ? ' · كُتب الخادم كعنوان IP: يجب أن تذكر الشهادة هذا العنوان، وإلا فاكتب اسم الخادم.' : ''}
      </p>
      <details className="int-more">
        <summary>السمات (أسماء الحقول في الدليل)</summary>
        <div className="flex" style={{ gap: 8, margin: '8px 0' }}>
          <button type="button" className="button small" onClick={() => set(AD_PRESET)}>
            Active Directory
          </button>
          <button type="button" className="button small" onClick={() => set(STANDARD_PRESET)}>
            دليل قياسي (inetOrgPerson)
          </button>
        </div>
        <div className="form-grid">
          {field('usernameAttribute', 'سمة اسم الدخول')}
          {field('uuidAttribute', 'سمة المعرّف الثابت')}
          {field('userObjectClass', 'صنف الكائن')}
          {field('employeeNumberAttribute', 'سمة الرقم الوظيفي / العسكري')}
          {field('rankAttribute', 'سمة الرتبة', 'اختياري')}
          {field('positionAttribute', 'سمة المنصب', 'اختياري')}
          {field('unitIdAttribute', 'سمة معرّف الوحدة', 'اختياري')}
          {field('unitNameAttribute', 'سمة اسم الوحدة', 'اختياري')}
          {field('mainUnitIdAttribute', 'سمة الوحدة الرئيسية', 'اختياري')}
        </div>
      </details>
      <label className="field" style={{ marginTop: 10 }}>
        <span>شهادة الجهة المصدرة (CA) بصيغة PEM — تُلصق هنا، وتُضاف إلى شهادات مجلد الخادم</span>
        <textarea dir="ltr" rows={5} spellCheck={false} value={form.caCertificatesPem} onChange={(e) => set({ caCertificatesPem: e.target.value })} placeholder="-----BEGIN CERTIFICATE-----" />
      </label>
      <label className="setting-row">
        <span>
          <b>تفعيل هذه الإعدادات</b>
          <small>معطلة: تعود القيم إلى ملف البيئة على الخادم</small>
        </span>
        <input className="toggle" type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} aria-label="تفعيل إعدادات الدليل" />
      </label>
      <div className="int-test">
        <b>اختبار الاتصال وعرض سمات مستخدم</b>
        <small className="muted">يستخدم القيم المكتوبة أعلاه كما هي، ولا يُحفظ منها شيء. مع اسم مستخدم وكلمة مرور يُجرَّب دخول ذلك الشخص نفسه. «اعرض سمات المستخدم» يقرأ سجل الدليل كاملاً لذلك المستخدم ويبيّن أي سمة تحمل كل حقل، قبل الحفظ.</small>
        <div className="form-grid">
          <label className="field"><span>اسم مستخدم للتجربة (اختياري)</span><input dir="ltr" autoComplete="off" value={testLogin} onChange={(e) => setTestLogin(e.target.value)} /></label>
          <label className="field"><span>كلمة مروره</span><input type="password" dir="ltr" autoComplete="new-password" value={testPassword} onChange={(e) => setTestPassword(e.target.value)} /></label>
        </div>
      </div>
      {problem && <p className="micro" style={{ color: 'var(--danger, #b42318)' }}>{problem}</p>}
      <div className="flex" style={{ gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
        <button className="button" disabled={busy || !!problem} onClick={() => act(async () => setTest(await api.testIntegrationDirectory(form, testLogin || undefined, testPassword || undefined)))}>
          اختبار الاتصال
        </button>
        <button className="button" disabled={busy || !!problem || !testLogin.trim()} data-testid="directory-inspect" title={!testLogin.trim() ? 'اكتب اسم مستخدم للتجربة أولاً' : undefined} onClick={() => { setConnected(null); act(async () => setInspect(await api.inspectIntegrationDirectory(form, testLogin || undefined, testPassword || undefined))); }}>
          اعرض سمات المستخدم
        </button>
        <button className="button primary" disabled={busy || !!problem} onClick={() => act(async () => { setView(await api.saveIntegrationDirectory(form)); setForm({ ...form, bindPassword: '' }); onChanged(); }, 'حُفظت إعدادات الدليل المؤسسي وسرت فوراً')}>
          حفظ
        </button>
        {view?.saved && (
          <button className="button" disabled={busy} onClick={() => act(async () => { setView(await api.clearIntegrationDirectory()); setForm(directoryFromSaved(null)); onChanged(); }, 'أُزيلت الإعدادات المحفوظة؛ تسري قيم ملف البيئة')}>
            العودة إلى إعدادات ملف البيئة
          </button>
        )}
        <button type="button" className="button small" onClick={() => setShowEnv(!showEnv)}>
          {showEnv ? 'إخفاء قيم ملف البيئة' : 'عرض قيم ملف البيئة'}
        </button>
      </div>
      {test && (
        <div className={'note ' + (test.ok ? '' : 'red')} style={{ marginTop: 10 }} data-testid="directory-test-result">
          {test.message} ({test.elapsedMs} م.ث)
          {test.dn ? <div dir="ltr" className="micro">{test.dn}{test.displayName ? ' — ' + test.displayName : ''}</div> : null}
        </div>
      )}
      {inspect && (
        <div style={{ marginTop: 10 }} data-testid="directory-inspect-result">
          <div className={'note ' + (inspect.ok ? '' : 'red')}>
            {inspect.message}{inspect.ok ? ` (${inspect.elapsedMs} م.ث)` : ''}
            {inspect.dn ? <div dir="ltr" className="micro">{inspect.dn}{inspect.displayName ? ' — ' + inspect.displayName : ''}</div> : null}
          </div>
          {inspect.ok && (
            <>
              <h3 className="int-inspect-h">المطابقة: الحقل في التطبيق ← سمة الدليل ← القيمة الفعلية</h3>
              <div className="int-attr-scroll">
                <table className="int-attr-table" data-testid="directory-inspect-map">
                  <thead><tr><th>الحقل في التطبيق</th><th>سمة الدليل</th><th>القيمة الفعلية</th></tr></thead>
                  <tbody>
                    {inspectMap.map(([label, key]) => {
                      const attrName = String(form[key] ?? '').trim();
                      const found = attrName ? inspect.attributes.find((a) => a.name.toLowerCase() === attrName.toLowerCase()) : undefined;
                      return (
                        <tr key={label}>
                          <td>{label}</td>
                          <td dir="ltr">{attrName || <span className="muted">—</span>}</td>
                          <td dir="ltr">{!attrName ? <span className="muted">غير محدد</span> : found ? found.values.join('، ') : <span className="muted">لا توجد سمة بهذا الاسم على السجل</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <details className="int-more" style={{ marginTop: 8 }}>
                <summary>كل السمات على السجل ({inspect.attributes.length})</summary>
                <div className="int-attr-scroll">
                  <table className="int-attr-table">
                    <thead><tr><th>السمة</th><th>القيمة</th></tr></thead>
                    <tbody>
                      {inspect.attributes.map((a) => (
                        <tr key={a.name}>
                          <td dir="ltr">{a.name}{a.binary ? <span className="pill" style={{ marginInlineStart: 6 }}>ثنائي</span> : null}</td>
                          <td dir="ltr">{a.values.join('، ')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
              <div className="int-connect">
                <b>اربط هذا المستخدم بالتطبيق</b>
                <small className="muted">
                  تأكد أن المطابقة أعلاه صحيحة، ثم اربطه: يُنشأ سجل الشخص ورابط الهوية (فيُعرف دخوله)، ويُوضع في وحدته — بمطابقة معرّف الوحدة،
                  وإلا باسم الوحدة (مطابقة عربية، وحدة واحدة فقط). لا تُمنح أي صلاحية. يكتب في قاعدة البيانات فعلياً.
                </small>
                <div className="flex" style={{ gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
                  <button
                    className="button primary"
                    data-testid="directory-connect"
                    disabled={busy || !testLogin.trim()}
                    onClick={() => {
                      if (!window.confirm('سيُنشأ سجل هذا المستخدم ويُربط ويُوضع في وحدته في قاعدة البيانات. متابعة؟')) return;
                      act(async () => setConnected(await api.connectIntegrationDirectory(form, testLogin || undefined, testPassword || undefined)), undefined);
                    }}
                  >
                    اربط بالتطبيق
                  </button>
                </div>
              </div>
            </>
          )}
          {connected && (
            <div className={'note ' + (connected.matchedBy === 'ID' || connected.matchedBy === 'NAME' ? '' : 'red')} style={{ marginTop: 10 }} data-testid="directory-connect-result">
              {connected.message}
              <div dir="ltr" className="micro">
                {connected.displayName}{connected.username ? ' · ' + connected.username : ''}{connected.employeeNumber ? ' · ' + connected.employeeNumber : ''}
                {connected.unitName ? ' · ' + connected.unitName : ''}
              </div>
            </div>
          )}
        </div>
      )}
      {showEnv && view && (
        <div style={{ marginTop: 10 }}>
          <EnvRow
            env={view.env}
            keys={[
              ['server', 'الخادم'],
              ['port', 'المنفذ'],
              ['securityMode', 'وضع التأمين'],
              ['domain', 'نطاق الدخول'],
              ['directBindPattern', 'نمط الربط'],
              ['baseDn', 'قاعدة البحث'],
              ['bindDn', 'حساب الخدمة'],
              ['usernameAttribute', 'سمة اسم الدخول'],
              ['uuidAttribute', 'سمة المعرّف'],
              ['employeeNumberAttribute', 'سمة الرقم'],
              ['userObjectClass', 'صنف الكائن'],
              ['caDir', 'مجلد الشهادات'],
            ]}
          />
          {view.saved && view.source === 'SAVED' && (
            <button type="button" className="button small" style={{ marginTop: 6 }} onClick={() => setForm(directoryFromSaved({ ...view.env, enabled: true } as never))}>
              نسخ قيم ملف البيئة إلى النموذج
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function OidcSection({ live, onChanged }: { live: IntegrationStatus['oidc'] | null; onChanged: () => void }) {
  const app = useApp();
  const [view, setView] = useState<IntegrationView | null>(null);
  const [form, setForm] = useState<OidcForm>(oidcFromSaved(null));
  const [test, setTest] = useState<OidcTestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [showEnv, setShowEnv] = useState(false);

  const load = () =>
    api.integrationOidc().then((v) => {
      setView(v);
      setForm(oidcFromSaved(v.saved as never));
    }, (e: Error) => app.toast(e.message));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const secretStored = !!(view?.saved && (view.saved as { clientSecretSet?: boolean }).clientSecretSet);
  const problem = oidcProblem(form, secretStored);
  const set = (p: Partial<OidcForm>) => {
    setForm({ ...form, ...p });
    setTest(null);
  };
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await fn();
      if (done) app.toast(done);
    } catch (e) {
      app.toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const field = (key: keyof OidcForm, label: string, hint?: string, type = 'text') => (
    <label className="field">
      <span>
        {label}
        {hint ? <small className="muted"> — {hint}</small> : null}
      </span>
      <input type={type} dir="ltr" value={String(form[key] ?? '')} autoComplete={type === 'password' ? 'new-password' : 'off'} onChange={(e) => set({ [key]: e.target.value } as Partial<OidcForm>)} />
    </label>
  );
  const envRedirect = view?.env && (view.env as { redirectUri?: string }).redirectUri;

  return (
    <section className="card padding int-settings" data-testid="integration-oidc" style={{ gridColumn: '1 / -1' }}>
      <div className="flex spread">
        <h2>إعدادات التكامل — الدخول الآلي (Keycloak)</h2>
        <span className="flex" style={{ gap: 6 }}><LiveBadge live={live} /><span className="pill">{view ? SOURCE_LABEL[view.source] : '…'}</span></span>
      </div>
      <Source view={view} />
      <p className="micro muted" style={{ margin: '0 0 12px' }}>
        زر «الدخول بالحساب المؤسسي» يفتح Keycloak المؤسسي الذي يُكتب هنا (الخادم، المجال، عميل تمركز وسره). حسابا المنصة
        admin وdeveloper يبقيان على Keycloak المحلي ولا يتأثران. اطلب من فريق Keycloak عميلاً سرياً بتدفق الرمز (Authorization Code + PKCE)
        وعنوان العودة المبين أدناه.
      </p>
      <div className="form-grid">
        {field('serverUrl', 'عنوان خادم Keycloak', 'الذي يفتحه المتصفح، مثل https://sso.example.local/auth')}
        {field('realm', 'المجال (Realm)')}
        {field('clientId', 'معرّف العميل (Client ID)')}
        <label className="field">
          <span>سر العميل (Client Secret) {secretStored ? '(محفوظ؛ اتركه فارغاً للإبقاء عليه)' : ''}</span>
          <input type="password" dir="ltr" autoComplete="new-password" value={form.clientSecret} onChange={(e) => set({ clientSecret: e.target.value })} />
        </label>
        {field('internalUrl', 'العنوان الداخلي', 'اختياري: عنوان الخادم من داخل الشبكة إن اختلف')}
        {field('issuer', 'المُصدر (Issuer)', 'اختياري: إن لم يكن <الخادم>/realms/<المجال>')}
        {field('redirectUri', 'عنوان العودة', envRedirect ? 'فارغ = ' + envRedirect : 'العنوان العام لتمركز + /api/v1/auth/oidc/callback')}
      </div>
      <p className="micro muted" style={{ margin: '4px 0 10px' }} data-testid="oidc-derived">
        المُصدر المتوقع في كل رمز: <code dir="ltr">{oidcIssuer(form) || '—'}</code>
      </p>
      <label className="field">
        <span>شهادة الجهة المصدرة (CA) لخادم Keycloak بصيغة PEM — إن كانت من جهة داخلية</span>
        <textarea dir="ltr" rows={4} spellCheck={false} value={form.caCertificatesPem} onChange={(e) => set({ caCertificatesPem: e.target.value })} placeholder="-----BEGIN CERTIFICATE-----" />
      </label>
      <label className="setting-row">
        <span>
          <b>تفعيل هذه الإعدادات</b>
          <small>معطلة: يعود الدخول الآلي إلى ما في ملف البيئة (Keycloak المحلي عادةً)</small>
        </span>
        <input className="toggle" type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} aria-label="تفعيل إعدادات Keycloak" />
      </label>
      {problem && <p className="micro" style={{ color: 'var(--danger, #b42318)' }}>{problem}</p>}
      <div className="flex" style={{ gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
        <button className="button" disabled={busy || !!problem} onClick={() => act(async () => setTest(await api.testIntegrationOidc(form)))}>
          اختبار الاتصال
        </button>
        <button className="button primary" disabled={busy || !!problem} onClick={() => act(async () => { setView(await api.saveIntegrationOidc(form)); setForm({ ...form, clientSecret: '' }); onChanged(); }, 'حُفظت إعدادات Keycloak وسرت فوراً')}>
          حفظ
        </button>
        {view?.saved && (
          <button className="button" disabled={busy} onClick={() => act(async () => { setView(await api.clearIntegrationOidc()); setForm(oidcFromSaved(null)); onChanged(); }, 'أُزيلت الإعدادات المحفوظة؛ تسري قيم ملف البيئة')}>
            العودة إلى إعدادات ملف البيئة
          </button>
        )}
        <button type="button" className="button small" onClick={() => setShowEnv(!showEnv)}>
          {showEnv ? 'إخفاء قيم ملف البيئة' : 'عرض قيم ملف البيئة'}
        </button>
      </div>
      {test && (
        <div className={'note ' + (test.ok ? '' : 'red')} style={{ marginTop: 10 }} data-testid="oidc-test-result">
          {test.message} ({test.elapsedMs} م.ث)
          <div dir="ltr" className="micro">redirect: {test.redirectUri}</div>
        </div>
      )}
      {showEnv && view && (
        <div style={{ marginTop: 10 }}>
          <EnvRow
            env={view.env}
            keys={[
              ['issuer', 'المُصدر'],
              ['internalUrl', 'العنوان الداخلي'],
              ['clientId', 'العميل'],
              ['redirectUri', 'عنوان العودة'],
              ['local', 'Keycloak المحلي'],
            ]}
          />
        </div>
      )}
    </section>
  );
}

/**
 * «المساعد الذكي» (ADR-056, owner 20 Nov 2026): the OpenAI-compatible server the assistant asks, saved on the server
 * ahead of TMRKZ_AI_* in .env, applied without a restart. The API key is write-only. The assistant never answers from a
 * preprogrammed template — when the model is off or unreachable, the screen says so.
 */
function AssistantSection({ onChanged }: { onChanged: () => void }) {
  const app = useApp();
  const [view, setView] = useState<AssistantView | null>(null);
  const [form, setForm] = useState<AssistantForm>({ enabled: false, baseUrl: '', model: '', apiKey: '', timeoutSeconds: 60 });
  const [keyStored, setKeyStored] = useState(false);
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<AssistantTestResult | null>(null);
  const load = async () => {
    try {
      const v = await api.integrationAssistant();
      setView(v);
      const saved = v.saved ?? null;
      setForm({
        enabled: saved?.enabled ?? v.env?.enabled ?? false,
        baseUrl: saved?.baseUrl ?? v.env?.baseUrl ?? '',
        model: saved?.model ?? v.env?.model ?? '',
        apiKey: '',
        timeoutSeconds: saved?.timeoutSeconds ?? v.env?.timeoutSeconds ?? 60,
      });
      setKeyStored(!!saved?.apiKeySet);
    } catch (e) { app.toast((e as Error).message); }
  };
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const act = async (fn: () => Promise<unknown>, msg?: string) => {
    setBusy(true);
    try { await fn(); if (msg) app.toast(msg); await load(); onChanged(); }
    catch (e) { app.toast((e as Error).message); }
    finally { setBusy(false); }
  };
  const problem = form.enabled && (!form.baseUrl.match(/^https?:\/\//) ? 'اكتب عنوان خادم النموذج (يبدأ بـ http:// أو https://).' : !form.model.trim() ? 'اكتب اسم النموذج.' : null);
  return (
    <section className="card padding int-settings" data-testid="integration-assistant" style={{ gridColumn: '1 / -1' }}>
      <div className="flex spread">
        <h2>المساعد الذكي</h2>
        <span className="pill">{view ? SOURCE_LABEL[view.source] : '…'}</span>
      </div>
      <p className="micro muted" style={{ margin: '4px 0 10px' }}>
        المساعد يُجيب فقط من الدليل المفتوح <b>OKF</b> عبر النموذج هنا؛ لا توجد إجابات مُعدّة مسبقاً. حين لا يكون النموذج متاحاً، تَظهر المراجع من الدليل فقط.
      </p>
      <label className="setting-row">
        <span><b>تفعيل المساعد</b><small>بدونه تظهر شارة «غير مُفعَّل» في زر المساعد ولا يُسأل خادم النموذج</small></span>
        <input className="toggle" type="checkbox" checked={!!form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} aria-label="تفعيل المساعد" />
      </label>
      <div className="form-grid" style={{ marginTop: 10 }}>
        <label className="field"><span>عنوان خادم النموذج</span>
          <input dir="ltr" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="http://host.docker.internal:11434/v1" /></label>
        <label className="field"><span>اسم النموذج</span>
          <input dir="ltr" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="qwen2.5:7b" /></label>
        <label className="field"><span>مفتاح API {keyStored ? '(محفوظ)' : ''}</span>
          <input type="password" dir="ltr" autoComplete="new-password" value={form.apiKey ?? ''} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder={keyStored ? '••••••••' : 'اختياري (لخوادم تحتاج توثيقاً)'} /></label>
        <label className="field"><span>مهلة الاستجابة (ثانية)</span>
          <input type="number" min={5} max={300} value={form.timeoutSeconds ?? 60} onChange={(e) => setForm({ ...form, timeoutSeconds: Number(e.target.value) })} /></label>
      </div>
      {problem && <div className="note red" style={{ marginTop: 10 }}>{problem}</div>}
      <div className="flex" style={{ gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
        <button className="button primary" disabled={busy || !!problem} onClick={() => act(() => api.saveIntegrationAssistant({ ...form, apiKey: form.apiKey?.length ? form.apiKey : undefined }), 'حُفظت إعدادات المساعد')}>حفظ</button>
        <button className="button" disabled={busy || !form.baseUrl} onClick={() => act(async () => setTest(await api.testIntegrationAssistant({ ...form, apiKey: form.apiKey?.length ? form.apiKey : undefined })))}>اختبار الاتصال</button>
        {view?.saved && <button className="button" disabled={busy} onClick={() => act(() => api.clearIntegrationAssistant(), 'أُزيلت الإعدادات المحفوظة؛ تعود قيم البيئة')}>إزالة المحفوظ</button>}
      </div>
      {test && (
        <div className={'note ' + (test.ok ? '' : 'red')} data-testid="assistant-test-result" style={{ marginTop: 10 }}>
          {test.ok ? `خادم النموذج يستجيب (${test.elapsedMs} م.ث)${test.knownModel === false ? ' — لكن النموذج المسمى غير موجود على الخادم' : ''}` : `${test.message}`}
        </div>
      )}
      {view?.env && (
        <details style={{ marginTop: 10 }}>
          <summary className="muted">قيم ملف البيئة (.env)</summary>
          <dl className="access-identity" style={{ marginTop: 6 }}>
            <div><dt className="muted">TMRKZ_AI_ENABLED</dt><dd>{String(view.env.enabled)}</dd></div>
            <div><dt className="muted">TMRKZ_AI_BASE_URL</dt><dd dir="ltr">{view.env.baseUrl}</dd></div>
            <div><dt className="muted">TMRKZ_AI_MODEL</dt><dd dir="ltr">{view.env.model}</dd></div>
            <div><dt className="muted">TMRKZ_AI_API_KEY</dt><dd>{view.env.apiKeySet ? 'محفوظ' : 'غير محفوظ'}</dd></div>
            <div><dt className="muted">TMRKZ_AI_TIMEOUT_SECONDS</dt><dd>{view.env.timeoutSeconds}</dd></div>
          </dl>
        </details>
      )}
    </section>
  );
}
