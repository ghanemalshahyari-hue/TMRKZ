import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Integration, OrgImportPreview, PolicyVersion, Settings, SystemInfo } from '../api/types';
import { Heading, KeyValue } from '../components/ui';
import { HrSourcePanel } from '../components/HrSourcePanel';
import { useApp } from '../lib/app';
import { formatBytes, fullTime } from '../lib/dates';
import { INTEGRATION_STATUS } from '../lib/labels';
import { parseOrgCsv } from '../lib/csv';

const TOGGLES: [keyof Settings, string, string][] = [
  ['multiSites', 'عدة مرافق في الطلب', 'السماح باختيار أكثر من مرفق'],
  ['multiOrgs', 'جهات مشاركة متعددة', 'إظهار اختيار الجهات المشاركة'],
  ['signatureRequired', 'التوقيع مع الاعتماد النهائي', 'إلزام توثيق المعتمد قبل تثبيت القرار والحجز'],
];

export function SettingsPage() {
  const app = useApp();
  const [policy, setPolicy] = useState<PolicyVersion | null>(null);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [csv, setCsv] = useState('code,name,parentCode\n');
  const [preview, setPreview] = useState<OrgImportPreview | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.policy().then(setPolicy).catch((e: Error) => app.toast(e.message));
    api.integrations().then(setIntegrations).catch(() => setIntegrations([]));
    api.systemInfo().then(setInfo).catch(() => setInfo(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.revision]);

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

  const s = policy?.settings;
  return (
    <>
      <Heading
        en="CONFIGURATION / SYSTEM POLICIES"
        title="إعدادات النظام"
        description="قرارات قابلة للتهيئة، كل تغيير ينشئ إصدار سياسة جديداً مع سجل للأثر."
        actions={<span className="pill">إصدار السياسة الحالي {policy?.version ?? '—'}</span>}
      />
      <div className="settings-grid">
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
              <small>القرار D-02 مفتوح؛ لا يوصف التوثيق الداخلي بأنه توقيع بشهادة</small>
            </span>
            <select value={s?.signatureMode ?? 'INTERNAL_ATTESTATION'} disabled={!s || busy} onChange={(e) => saveSetting({ signatureMode: e.target.value as Settings['signatureMode'] })}>
              <option value="INTERNAL_ATTESTATION">توثيق داخلي</option>
              <option value="PKI">توقيع بشهادة — غير مربوط</option>
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
        <section className="card padding">
          <h2>البيئة المستهدفة</h2>
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
          <h2>التكاملات</h2>
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
        {app.can('CONFIGURE') && <HrSourcePanel />}
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
      </div>
    </>
  );
}
