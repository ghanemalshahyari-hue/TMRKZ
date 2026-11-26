import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '../api/client';
import type { Integration, OrgImportPreview, PolicyVersion, Settings, SystemInfo } from '../api/types';
import { Heading, Icon, KeyValue } from '../components/ui';
import { HrSourcePanel } from '../components/HrSourcePanel';
import { SignInNotesSettings } from '../components/SignInNotesSettings';
import { IntegrationSettings } from '../components/IntegrationSettings';
import { AdminLifecycle } from '../components/AdminLifecycle';
import { SiteSetupAccessSettings } from '../components/SiteSetupAccessSettings';
import { DbMigrationCenter } from '../components/DbMigrationCenter';
import { ManagementCenter } from '../components/ManagementCenter';
import { UpdateCenter } from '../components/UpdateCenter';
import { CertificateCenter } from '../components/CertificateCenter';
import { EnvImport } from '../components/EnvImport';
import { useApp } from '../lib/app';
import { STATIONING_V3_ENABLED } from '../lib/stationingV3';
import { formatBytes, fullTime } from '../lib/dates';
import { INTEGRATION_STATUS } from '../lib/labels';
import { parseOrgCsv } from '../lib/csv';

const TOGGLES: [keyof Settings, string, string][] = [
  ['multiSites', 'عدة مرافق في الطلب', 'السماح باختيار أكثر من مرفق'],
  ['multiOrgs', 'جهات مشاركة متعددة', 'إظهار اختيار الجهات المشاركة'],
  ['signatureRequired', 'التوقيع مع الاعتماد النهائي', 'إلزام توثيق المعتمد قبل تثبيت القرار والحجز'],
];

type GroupKey = 'general' | 'identity' | 'admins' | 'hr' | 'data' | 'security' | 'maintenance';
type Group = { key: GroupKey; title: string; icon: string; description: string; items: string[]; testid: string; shown: boolean };
type Tile = { key: GroupKey; title: string; value: string; note: string; tone: '' | 'green' | 'orange' | 'red' };

/** The group the person chose last (this browser only); «الكل» shows every group, as the page always did. */
function rememberedFocus(): GroupKey | 'all' {
  try {
    return (localStorage.getItem('tmrkz.settings.focus') as GroupKey | 'all' | null) ?? 'all';
  } catch {
    return 'all';
  }
}

/** One group of the page: its heading (the anchor the menu and the older tests use) and its cards. */
function SettingsSection({ group, hidden, children }: { group: Group; hidden: boolean; children: ReactNode }) {
  return (
    <section className="settings-section" id={'settings-' + group.key} hidden={hidden} aria-labelledby={'settings-h-' + group.key}>
      <header className="settings-section-head">
        <span className="settings-section-icon"><Icon name={group.icon} /></span>
        <div>
          <h2 className="settings-group" id={'settings-h-' + group.key} data-testid={group.testid}>{group.title}</h2>
          <p>{group.description}</p>
        </div>
      </header>
      <div className="settings-grid">{children}</div>
    </section>
  );
}

/**
 * «إدارة النظام» (owner, 25 Nov 2026: «more organised and better to use»): every setting in its group, a side menu with search
 * and live status (certificates, the maintenance worker), status cards that open their group, and one group at a time on demand.
 * «الكل» (the default) still shows every group in order, so nothing moved out of reach.
 */
export function SettingsPage() {
  const app = useApp();
  const [policy, setPolicy] = useState<PolicyVersion | null>(null);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [csv, setCsv] = useState('code,name,parentCode\n');
  const [preview, setPreview] = useState<OrgImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [focus, setFocus] = useState<GroupKey | 'all'>(rememberedFocus);
  const [query, setQuery] = useState('');
  const [certs, setCerts] = useState<{ expired: number; expiring: number } | null>(null);
  const [worker, setWorker] = useState<boolean | null>(null);
  const [admins, setAdmins] = useState<number | null>(null);
  const configure = app.can('CONFIGURE');
  const global = configure && app.can('MANAGE_ACCESS');

  useEffect(() => {
    api.policy().then(setPolicy).catch((e: Error) => app.toast(e.message));
    api.integrations().then(setIntegrations).catch(() => setIntegrations([]));
    api.systemInfo().then(setInfo).catch(() => setInfo(null));
    if (configure) api.listAdministrators().then((a) => setAdmins(a.filter((x) => x.effective).length)).catch(() => setAdmins(null));
    if (global) {
      api.certificates().then((c) => setCerts(c.summary)).catch(() => setCerts(null));
      api.updatesOverview().then((u) => setWorker(u.worker.alive)).catch(() => setWorker(null));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.revision]);
  useEffect(() => {
    try {
      localStorage.setItem('tmrkz.settings.focus', focus);
    } catch {
      /* storage unavailable: the choice lasts for this visit */
    }
  }, [focus]);

  const saveSetting = async (patch: Partial<Settings>) => {
    if (!policy) return;
    setBusy(true);
    try {
      const draft = await api.draftPolicy({ ...policy.settings, ...patch });
      if (draft.errors?.length) {
        app.toast(draft.errors.map((e) => e.message).join('؛ '));
        return;
      }
      const published = await api.publishPolicy(draft.id);
      setPolicy(published);
      app.toast('نُشر إصدار السياسة ' + published.version + '؛ يطبق على الطلبات المقدمة بعده');
      app.bump();
    } catch (e) {
      app.toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const runPreview = async () => {
    const rows = parseOrgCsv(csv);
    if (!rows.length) return app.toast('الصق صفوف الهيكل أولاً');
    try {
      setPreview(await api.previewOrgImport(rows));
    } catch (e) {
      app.toast((e as Error).message);
    }
  };

  const commit = async () => {
    if (!preview?.valid) return;
    try {
      await api.commitOrgImport(preview.runId);
      app.toast('طُبق استيراد الهيكل وسُجل في سجل التكامل');
      setPreview(null);
      app.bump();
    } catch (e) {
      app.toast((e as Error).message);
    }
  };

  const groups: Group[] = useMemo(() => [
    { key: 'general', title: 'السياسات والبيئة', icon: 'filter', description: 'سياسات الطلب، صلاحيات تحديد المواقع، البيئة المستهدفة وحالة التكاملات.',
      items: ['سياسات الطلب', 'التوقيع', 'المرفقات', 'رموز الوحدات', 'تحديد مواقع التمركز', 'سياسة التمركز', 'التضاريس', 'البيئة', 'التكاملات'], testid: 'settings-group-policies', shown: true },
    { key: 'identity', title: 'الهوية والدخول', icon: 'user', description: 'رسائل شاشة الدخول، الدليل المؤسسي وKeycloak والمساعد، واستيراد ملف إعدادات من تطبيق متوافق.',
      items: ['ملاحظات الدخول', 'إعدادات التكامل', 'الدليل المؤسسي', 'LDAP', 'Keycloak', 'المساعد الذكي', 'استيراد ملف إعدادات', '.env'],
      testid: 'settings-group-identity', shown: true },
    { key: 'admins', title: 'مديرو النظام', icon: 'shield', description: 'من يملك تهيئة النظام وإدارة الصلاحيات كاملة؛ الإضافة بهوية متحقق منها وبسبب مسجل.',
      items: ['مديرو النظام', 'مدير جديد', 'سحب الصلاحية'], testid: 'settings-group-admins', shown: configure },
    { key: 'hr', title: 'مصدر الموارد البشرية', icon: 'units', description: 'الاتصال بـOracle للقراءة فقط، تعيين الأعمدة، والمزامنة كل ساعة.',
      items: ['Oracle', 'الموارد البشرية', 'المزامنة', 'تعيين الأعمدة'], testid: 'settings-group-hr', shown: configure },
    { key: 'data', title: 'ترحيل البيانات', icon: 'download', description: 'استيراد الهيكل التنظيمي من ملف، ومركز ترحيل قاعدة البيانات.',
      items: ['استيراد الهيكل التنظيمي', 'ترحيل قاعدة البيانات', 'CSV'], testid: 'settings-group-migration', shown: true },
    { key: 'security', title: 'الشهادات', icon: 'lock', description: 'شهادة https وثقة الدليل وKeycloak: فحص ومعاينة وتطبيق صريح واستعادة.',
      items: ['الشهادات', 'https', 'TLS', 'CA', 'PFX'], testid: 'settings-group-security', shown: global },
    { key: 'maintenance', title: 'الصيانة والتحديث', icon: 'reset', description: 'مركز إدارة النظام، ومركز التحديث من المتصفح بإصدارات موقعة.',
      items: ['مركز إدارة النظام', 'مركز التحديث', 'تحديث', 'الرجوع إلى الإصدار السابق'], testid: 'settings-group-management', shown: configure },
  ], [configure, global]);
  const visible = groups.filter((g) => g.shown);
  const q = query.trim().toLowerCase();
  const matches = (g: Group) => !q || [g.title, g.description, ...g.items].some((t) => t.toLowerCase().includes(q));
  const show = (key: GroupKey) => {
    const g = groups.find((x) => x.key === key)!;
    return g.shown && matches(g) && (q !== '' || focus === 'all' || focus === key);
  };
  const open = (key: GroupKey | 'all') => {
    setFocus(key);
    setQuery('');
    window.requestAnimationFrame(() => document.getElementById(key === 'all' ? 'settings-top' : 'settings-' + key)?.scrollIntoView({ block: 'start' }));
  };
  const byKey = (k: GroupKey) => groups.find((g) => g.key === k)!;
  const connected = integrations.filter((i) => i.status !== 'NOT_CONNECTED').length;
  const tiles: Tile[] = [
    { key: 'general', title: 'سياسة الطلب', value: 'الإصدار ' + (policy?.version ?? '—'), note: policy?.publishedAt ? 'نُشر ' + fullTime(policy.publishedAt) : '', tone: '' },
    { key: 'general', title: 'التكاملات', value: integrations.length ? connected + ' من ' + integrations.length + ' تعمل' : '—', note: 'مدمجة أو باستيراد ملف',
      tone: !integrations.length ? '' : connected < integrations.length ? 'orange' : 'green' },
  ];
  if (configure) {
    tiles.push({ key: 'admins', title: 'مديرو النظام', value: admins == null ? '—' : admins + ' فعّال', note: 'لا يُسحب آخر مدير فعّال',
      tone: admins === 1 ? 'orange' : '' });
  }
  if (global) {
    tiles.push({ key: 'security', title: 'الشهادات', value: !certs ? '—' : certs.expired ? certs.expired + ' منتهية' : certs.expiring ? certs.expiring + ' تنتهي قريباً' : 'سارية',
      note: 'https والدليل وKeycloak', tone: !certs ? '' : certs.expired ? 'red' : certs.expiring ? 'orange' : 'green' });
    tiles.push({ key: 'maintenance', title: 'مركز التحديث', value: worker == null ? '—' : worker ? 'عامل الصيانة يعمل' : 'عامل الصيانة متوقف',
      note: 'تحديث من المتصفح', tone: worker == null ? '' : worker ? 'green' : 'red' });
  }
  const badge = (key: GroupKey) => {
    if (key === 'security' && certs && (certs.expired || certs.expiring)) {
      return <span className={'pill ' + (certs.expired ? 'red' : 'orange')}>{certs.expired || certs.expiring}</span>;
    }
    if (key === 'maintenance' && worker === false) return <span className="pill red">!</span>;
    return null;
  };

  const s = policy?.settings;
  return (
    <>
      <div id="settings-top" />
      <Heading
        en="CONFIGURATION / SYSTEM POLICIES"
        title="إعدادات النظام"
        description="كل إعداد في مجموعته: اختر مجموعة من القائمة لتعرضها وحدها، أو «الكل». كل تغيير في السياسة ينشئ إصداراً جديداً مع سجل للأثر."
        actions={<span className="pill">إصدار السياسة الحالي {policy?.version ?? '—'}</span>}
      />
      <div className="settings-layout" data-focus={q ? 'search' : focus}>
        <nav className="card settings-nav" aria-label="مجموعات الإعدادات" data-testid="settings-nav">
          <label className="settings-search">
            <Icon name="search" />
            <input type="search" value={query} placeholder="ابحث في الإعدادات…" aria-label="ابحث في الإعدادات" onChange={(e) => setQuery(e.target.value)}
              data-testid="settings-search" />
          </label>
          <button type="button" className={'settings-nav-item' + (focus === 'all' && !q ? ' active' : '')} aria-current={focus === 'all' && !q ? 'true' : undefined}
            onClick={() => open('all')} data-testid="settings-nav-all">
            <Icon name="grid" />
            <span>الكل<small>كل المجموعات في صفحة واحدة</small></span>
          </button>
          {visible.map((g) => (
            <button type="button" key={g.key} className={'settings-nav-item' + (focus === g.key && !q ? ' active' : '') + (q && !matches(g) ? ' dim' : '')}
              aria-current={focus === g.key && !q ? 'true' : undefined} onClick={() => open(g.key)} data-testid={'settings-nav-' + g.key}>
              <Icon name={g.icon} />
              <span>{g.title}<small>{g.items.slice(0, 3).join(' · ')}</small></span>
              {badge(g.key)}
            </button>
          ))}
          {q && !visible.some(matches) && <p className="micro muted">لا مجموعة تطابق «{query.trim()}».</p>}
        </nav>
        <div className="settings-content">
          {focus === 'all' && !q && (
            <div className="settings-overview" data-testid="settings-overview">
              {tiles.map((t) => (
                <button type="button" key={t.title} className={'card settings-tile ' + t.tone} onClick={() => open(t.key)}>
                  <Icon name={byKey(t.key).icon} />
                  <span><small>{t.title}</small><b>{t.value}</b>{t.note && <em>{t.note}</em>}</span>
                </button>
              ))}
            </div>
          )}
          <SettingsSection group={byKey('general')} hidden={!show('general')}>
            <SiteSetupAccessSettings />
            <section className="card padding">
              <h2>سياسات الطلب</h2>
              {TOGGLES.map(([key, title, desc]) => (
                <label className="setting-row" key={key}>
                  <span>
                    <b>{title}</b>
                    <small>{desc}</small>
                  </span>
                  <input className="toggle" type="checkbox" checked={!!s?.[key]} disabled={!s || busy} onChange={(e) => saveSetting({ [key]: e.target.checked })} aria-label={title} />
                </label>
              ))}
              <label className="setting-row">
                <span>
                  <b>وحدة الفترة الافتراضية</b>
                  <small>يمكن تغييرها أثناء الطلب</small>
                </span>
                <select value={s?.defaultUnit ?? 'DAYS'} disabled={!s || busy} onChange={(e) => saveSetting({ defaultUnit: e.target.value as Settings['defaultUnit'] })}>
                  <option value="DAYS">أيام</option>
                  <option value="HOURS">ساعات</option>
                </select>
              </label>
              <label className="setting-row">
                <span>
                  <b>نمط التوقيع</b>
                  <small>التوقيع بالشهادة يتطلب مزود توقيع مربوطاً (حالته في التكاملات)؛ لا يوصف التوثيق الداخلي بأنه توقيع بشهادة</small>
                </span>
                <select value={s?.signatureMode ?? 'INTERNAL_ATTESTATION'} disabled={!s || busy} onChange={(e) => saveSetting({ signatureMode: e.target.value as Settings['signatureMode'] })}>
                  <option value="INTERNAL_ATTESTATION">توثيق داخلي</option>
                  <option value="PKI">توقيع بشهادة المعتمد وختم الجهة (PKI)</option>
                </select>
              </label>
              <label className="setting-row">
                <span>
                  <b>معيار رموز الوحدات</b>
                  <small>المعيار والإصدار المعتمدان لرموز هوية الجهات (عرض معلوماتي)؛ دون اختيار لا يُسند رمز</small>
                </span>
                <select
                  value={s?.unitSymbolStandard ?? ''}
                  disabled={!s || busy}
                  onChange={(e) => saveSetting({ unitSymbolStandard: e.target.value || null })}
                  aria-label="معيار رموز الوحدات"
                >
                  <option value="">لم يُحدد</option>
                  <option value="APP6-D">STANAG APP-6 D</option>
                  <option value="APP6-E">STANAG APP-6 E</option>
                  <option value="2525-D">MIL-STD-2525 D</option>
                  <option value="2525-E">MIL-STD-2525 E</option>
                </select>
              </label>
              <div className="setting-row">
                <span>
                  <b>المرفقات</b>
                  <small>{s ? 'الحد ' + formatBytes(s.attachmentMaxBytes) + ' · ' + s.allowedAttachmentTypes.join('، ') : '—'}</small>
                </span>
              </div>
              {policy?.publishedAt && (
                <p className="micro muted" style={{ marginTop: 10 }}>
                  آخر نشر {fullTime(policy.publishedAt)}
                  {policy.publishedBy ? ' · ' + policy.publishedBy : ''}
                </p>
              )}
            </section>
            {STATIONING_V3_ENABLED && configure && (
              <section className="card padding" data-testid="settings-terrain-link">
                <h2>سياسة التمركز والتضاريس</h2>
                <p className="micro muted" style={{ margin: '0 0 10px' }}>
                  قواعد التمركز وإعادة التمركز: المسافات والتضاريس (المسموح وغير المسموح)، مراحل الاعتماد، وتجاوز المسافة وإضافة وحدة من فرع آخر — تُحرَّر في صفحتها.
                </p>
                <button type="button" className="button" data-testid="settings-open-stationing-policy" onClick={() => app.navigate('stationingPolicy')}>
                  فتح سياسة التمركز
                </button>
              </section>
            )}
            <section className="card padding">
              <h2>البيئة المستهدفة <span className="pill">قراءة فقط</span></h2>
              <KeyValue k="النشر" v="Docker داخل شبكة معزولة" />
              <KeyValue k="اللغة والاتجاه" v="عربي / RTL" />
              <KeyValue k="المنطقة الزمنية" v={info?.timezone ?? s?.timezone ?? 'Asia/Dubai'} />
              <KeyValue k="هدف حجم السجلات" v="7,000 جهة / 200,000 شخص" />
              <KeyValue k="إصدار النظام" v={info?.version ?? '—'} />
              <KeyValue k="وقت الخادم" v={info ? fullTime(info.serverTime) : '—'} />
              <KeyValue k="قاعدة البيانات" v={info?.database === 'UP' ? 'متصلة' : info?.database ?? '—'} />
              <KeyValue k="إشعارات بانتظار المعالجة" v={info?.outboxPending ?? '—'} />
              <KeyValue k="حزم الخرائط المثبتة" v={info?.mapPackages ?? '—'} />
              <p className="micro muted" style={{ marginTop: 13 }}>
                الأعداد المستهدفة أهداف للمواصفات، وليست نتيجة اختبار أداء معتمد (القرار D-03).
              </p>
            </section>
            <section className="card padding">
              <h2>التكاملات <span className="pill">قراءة فقط</span></h2>
              {integrations.map((i) => {
                const [label, tone] = INTEGRATION_STATUS[i.status] ?? [i.status, ''];
                return (
                  <div className="key-value" key={i.code}>
                    <span>
                      {i.name}
                      <br />
                      <small className="muted">{i.description}</small>
                    </span>
                    <b>
                      <span className={'pill ' + tone}>{label}</span>
                    </b>
                  </div>
                );
              })}
              {!integrations.length && <p className="micro muted">لا توجد تكاملات مسجلة.</p>}
              <p className="micro muted" style={{ marginTop: 10 }}>
                «غير مربوط» يعني أن الواجهة والعقد جاهزان دون اتصال فعلي؛ لا يعرض النظام اتصالاً وهمياً ناجحاً.
              </p>
            </section>
          </SettingsSection>
          <SettingsSection group={byKey('identity')} hidden={!show('identity')}>
            <SignInNotesSettings />
            {configure && <IntegrationSettings />}
            {configure && <EnvImport />}
          </SettingsSection>
          {configure && (
            <SettingsSection group={byKey('admins')} hidden={!show('admins')}>
              <AdminLifecycle />
            </SettingsSection>
          )}
          {configure && (
            <SettingsSection group={byKey('hr')} hidden={!show('hr')}>
              <HrSourcePanel />
            </SettingsSection>
          )}
          <SettingsSection group={byKey('data')} hidden={!show('data')}>
            <section className="card padding">
              <h2>استيراد الهيكل التنظيمي</h2>
              <p className="micro muted" style={{ margin: '12px 0' }}>
                الصق صفوفاً بصيغة <span className="latin">code,name,parentCode</span>. يُعرض تقرير التحقق (الدورات والمعرفات المتعارضة) قبل أي حفظ.
              </p>
              <textarea value={csv} onChange={(e) => (setCsv(e.target.value), setPreview(null))} style={{ width: '100%', minHeight: 120, direction: 'ltr' }} aria-label="صفوف الهيكل" />
              <div className="flex" style={{ gap: 10, marginTop: 10 }}>
                <button className="button" onClick={runPreview}>
                  معاينة التحقق
                </button>
                <button className="button primary" onClick={commit} disabled={!preview?.valid}>
                  تطبيق الاستيراد
                </button>
              </div>
              {preview && (
                <div className={'note ' + (preview.valid ? '' : 'red')} style={{ marginTop: 12 }}>
                  {preview.valid ? 'التحقق ناجح' : 'التحقق فشل — لن يُحفظ شيء'} · إنشاء {preview.summary.create} · تحديث {preview.summary.update} · دون تغيير {preview.summary.unchanged}
                  {preview.errors.map((e, i) => (
                    <div key={i}>
                      صف {e.row} · <span className="latin tiny">{e.code}</span> · {e.message}
                    </div>
                  ))}
                </div>
              )}
            </section>
            {configure && <DbMigrationCenter />}
          </SettingsSection>
          {global && (
            <SettingsSection group={byKey('security')} hidden={!show('security')}>
              <CertificateCenter />
            </SettingsSection>
          )}
          {configure && (
            <SettingsSection group={byKey('maintenance')} hidden={!show('maintenance')}>
              <ManagementCenter />
              {global && <UpdateCenter />}
            </SettingsSection>
          )}
        </div>
      </div>
    </>
  );
}
