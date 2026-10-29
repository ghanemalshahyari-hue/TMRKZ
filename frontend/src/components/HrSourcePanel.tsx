import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import type { HrCanonical, HrEntity, HrField, HrMappingVersion, HrRule, HrRun, HrSource, HrSourceInput, HrStatus, HrTestResult } from '../api/types';
import { KeyValue } from './ui';
import { useApp } from '../lib/app';
import { fullTime } from '../lib/dates';

const RUN_STATUS: Record<HrRun['status'], [string, string]> = {
  RUNNING: ['قيد التشغيل', 'blue'],
  SUCCEEDED: ['ناجح', 'green'],
  REJECTED: ['مرفوض بالحماية', 'orange'],
  FAILED: ['فشل', 'red'],
  SKIPPED: ['مؤجل', ''],
};
const ENTITY: Record<HrEntity, string> = { UNIT: 'الجهات', PERSON: 'الأشخاص' };
const TRANSFORMS = ['none', 'trim', 'upper', 'lower', 'first_non_empty'];

const EMPTY: HrSourceInput = {
  name: 'مصدر الموارد البشرية',
  enabled: false,
  hostOrUrl: '',
  port: 1521,
  serverName: '',
  nameType: 'service_name',
  username: '',
  password: '',
  unitView: '',
  personView: '',
  connectTimeoutS: 10,
  callTimeoutMs: 30000,
  dropPercent: 10,
  dropMinimum: 3,
  maxAgeHours: 720,
};

function age(minutes: number | null): string {
  if (minutes == null) return '—';
  if (minutes < 60) return minutes + ' دقيقة';
  if (minutes < 48 * 60) return Math.floor(minutes / 60) + ' ساعة';
  return Math.floor(minutes / 1440) + ' يوم';
}

/**
 * HR source administration: status of the hourly mirror, the manual refresh (same path as the schedule), the connection
 * settings (password write-only) and the column mapping (draft → discover columns → publish).
 */
export function HrSourcePanel() {
  const app = useApp();
  const [status, setStatus] = useState<HrStatus | null>(null);
  const [runs, setRuns] = useState<HrRun[]>([]);
  const [source, setSource] = useState<HrSource | null>(null);
  const [form, setForm] = useState<HrSourceInput>(EMPTY);
  const [test, setTest] = useState<HrTestResult | null>(null);
  const [contract, setContract] = useState<HrCanonical[]>([]);
  const [mappings, setMappings] = useState<HrMappingVersion[]>([]);
  const [fields, setFields] = useState<HrField[]>([]);
  const [rules, setRules] = useState<Partial<Record<HrEntity, HrRule>>>({});
  const [override, setOverride] = useState('');
  const [busy, setBusy] = useState(false);

  const draft = mappings.find((m) => m.status === 'DRAFT') ?? null;
  const published = mappings.find((m) => m.status === 'PUBLISHED') ?? null;
  const editing = draft ?? published;

  const load = useCallback(async () => {
    try {
      const [st, rs, src, con, maps] = await Promise.all([api.hrStatus(), api.hrRuns(10), api.hrSource(), api.hrContract(), api.hrMappings()]);
      setStatus(st);
      setRuns(rs);
      setSource(src);
      setContract(con);
      setMappings(maps);
      if (src.exists) {
        setForm({
          name: src.name ?? EMPTY.name,
          enabled: !!src.enabled,
          hostOrUrl: src.hostOrUrl ?? '',
          port: src.port ?? 1521,
          serverName: src.serverName ?? '',
          nameType: src.nameType ?? 'service_name',
          username: src.username ?? '',
          password: '',
          unitView: src.unitView ?? '',
          personView: src.personView ?? '',
          connectTimeoutS: src.connectTimeoutS ?? 10,
          callTimeoutMs: src.callTimeoutMs ?? 30000,
          dropPercent: src.dropPercent ?? 10,
          dropMinimum: src.dropMinimum ?? 3,
          maxAgeHours: src.maxAgeHours ?? 720,
        });
      }
      const current = maps.find((m) => m.status === 'DRAFT') ?? maps.find((m) => m.status === 'PUBLISHED');
      setFields(current?.fields ?? con.filter((c) => c.required).map((c) => ({ entity: c.entity, field: c.field, column: '', transform: 'none', enabled: true })));
      setRules(current?.activeRules ?? {});
    } catch (e) {
      app.toast((e as Error).message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
  }, [load, app.revision]);

  useEffect(() => {
    if (!status?.running) return;
    const t = setTimeout(load, 3000);
    return () => clearTimeout(t);
  }, [status, load]);

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await fn();
      if (done) app.toast(done);
      await load();
    } catch (e) {
      app.toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const discovered = (entity: HrEntity) => editing?.discoveredColumns?.[entity] ?? [];
  const fieldOf = (c: HrCanonical) => fields.find((f) => f.entity === c.entity && f.field === c.field);
  const setField = (c: HrCanonical, patch: Partial<HrField>) => {
    const existing = fieldOf(c);
    const next = { ...(existing ?? { entity: c.entity, field: c.field, column: '', transform: 'none', enabled: true }), ...patch };
    setFields(existing ? fields.map((f) => (f === existing ? next : f)) : [...fields, next]);
  };
  const lastRun = status?.lastRun ?? null;
  const showOverride = lastRun?.status === 'REJECTED' && lastRun.errorCode === 'LARGE_DROP';
  const problems = useMemo(() => draft?.problems ?? [], [draft]);

  const input = (key: keyof HrSourceInput, label: string, type = 'text', ltr = true) => (
    <label className="field">
      <span>{label}</span>
      <input
        type={type}
        dir={ltr ? 'ltr' : 'rtl'}
        value={String(form[key] ?? '')}
        autoComplete={type === 'password' ? 'new-password' : 'off'}
        onChange={(e) => setForm({ ...form, [key]: type === 'number' ? Number(e.target.value) : e.target.value })}
      />
    </label>
  );

  return (
    <>
      <section className="card padding">
        <h2>مزامنة الموارد البشرية</h2>
        {!status ? (
          <p className="micro muted">جارٍ التحميل…</p>
        ) : (
          <>
            {!status.keyConfigured && <div className="note red">مفتاح حماية الإعدادات غير مهيأ في بيئة التشغيل (TMRKZ_HR_SETTINGS_KEY).</div>}
            {status.stale && status.configured && (
              <div className="note orange">بيانات المرآة أقدم من سياسة العمر ({status.maxAgeHours} ساعة) أو لم تنجح مزامنة بعد.</div>
            )}
            <KeyValue k="المصدر" v={status.sourceName ? status.sourceName + (status.enabled ? '' : ' — معطل') : 'غير مهيأ'} />
            <KeyValue k="إصدار التعيين المنشور" v={status.mappingVersion ?? '—'} />
            <KeyValue k="آخر نجاح" v={status.lastSuccessAt ? fullTime(status.lastSuccessAt) : '—'} />
            <KeyValue k="عمر البيانات" v={age(status.dataAgeMinutes)} />
            <KeyValue
              k="النسخة المنشورة"
              v={status.published ? `${status.published.activeUnits}/${status.published.units} جهة · ${status.published.activePeople}/${status.published.people} شخص` : '—'}
            />
            <KeyValue k="التشغيل التالي" v={status.nextRunAt ? fullTime(status.nextRunAt) : 'كل ' + Math.round(status.intervalSeconds / 60) + ' دقيقة'} />
            {lastRun && (
              <div className={'note ' + (lastRun.status === 'FAILED' ? 'red' : lastRun.status === 'REJECTED' ? 'orange' : '')} style={{ marginTop: 10 }}>
                آخر تشغيل: {RUN_STATUS[lastRun.status]?.[0]} · {fullTime(lastRun.startedAt)}
                {lastRun.counts?.durationMs != null ? ' · ' + Math.round(Number(lastRun.counts.durationMs) / 100) / 10 + ' ث' : ''}
                {lastRun.errorMessage ? <div>{lastRun.errorMessage}</div> : null}
              </div>
            )}
            {showOverride && (
              <label className="field" style={{ marginTop: 10 }}>
                <span>سبب قبول الانخفاض (يُسجل في التدقيق)</span>
                <input value={override} onChange={(e) => setOverride(e.target.value)} />
              </label>
            )}
            <div className="flex" style={{ gap: 10, marginTop: 12 }}>
              <button
                className="button primary"
                disabled={busy || status.running || !status.enabled || (showOverride && override.trim().length > 0 && override.trim().length < 10)}
                onClick={() => act(() => api.hrSync(showOverride && override.trim() ? override.trim() : undefined), 'بدأ التحديث؛ تظهر النتيجة هنا عند انتهائه')}
              >
                {status.running ? 'التحديث قائم…' : showOverride && override.trim() ? 'تحديث مع قبول الانخفاض' : 'تحديث الآن'}
              </button>
            </div>
            <table className="data-table" style={{ marginTop: 14 }}>
              <thead>
                <tr>
                  <th>البدء</th>
                  <th>النوع</th>
                  <th>الحالة</th>
                  <th>السجلات</th>
                  <th>ملاحظات</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td>{fullTime(r.startedAt)}</td>
                    <td>{r.trigger === 'MANUAL' ? 'يدوي' + (r.requestedBy ? ' — ' + r.requestedBy : '') : 'مجدول'}</td>
                    <td>
                      <span className={'pill ' + (RUN_STATUS[r.status]?.[1] ?? '')}>{RUN_STATUS[r.status]?.[0] ?? r.status}</span>
                    </td>
                    <td>{r.counts?.units != null ? `${r.counts.units} جهة · ${r.counts.people} شخص` : '—'}</td>
                    <td className="micro">{r.errorMessage ?? (r.issues ? r.issues + ' ملاحظة تحقق' : '')}</td>
                  </tr>
                ))}
                {!runs.length && (
                  <tr>
                    <td colSpan={5} className="muted">
                      لا توجد عمليات مزامنة بعد.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </>
        )}
      </section>

      <section className="card padding">
        <h2>إعدادات المصدر</h2>
        <p className="micro muted" style={{ margin: '8px 0 12px' }}>
          قراءة فقط عبر حساب يملك SELECT على العروض المعتمدة. كلمة المرور تُحفظ مشفرة بمفتاح TMRKZ ولا تُعرض؛ اتركها فارغة للإبقاء على الحالية.
        </p>
        {source?.settingsError && <div className="note red">{source.settingsError}</div>}
        <div className="form-grid">
          {input('name', 'اسم المصدر', 'text', false)}
          {input('hostOrUrl', 'الخادم')}
          {input('port', 'المنفذ', 'number')}
          {input('serverName', 'اسم الخدمة أو SID')}
          <label className="field">
            <span>نوع الاسم</span>
            <select value={form.nameType} onChange={(e) => setForm({ ...form, nameType: e.target.value as HrSourceInput['nameType'] })}>
              <option value="service_name">service_name</option>
              <option value="sid">sid</option>
            </select>
          </label>
          {input('username', 'اسم المستخدم')}
          <label className="field">
            <span>كلمة المرور {source?.passwordSet ? '(محفوظة)' : ''}</span>
            <input type="password" dir="ltr" autoComplete="new-password" value={form.password ?? ''} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </label>
          {input('unitView', 'عرض الجهات')}
          {input('personView', 'عرض الأشخاص')}
          {input('connectTimeoutS', 'مهلة الاتصال (ث)', 'number')}
          {input('callTimeoutMs', 'مهلة الاستعلام (م.ث)', 'number')}
          {input('dropPercent', 'حماية الانخفاض %', 'number')}
          {input('dropMinimum', 'حد أدنى للانخفاض المسموح', 'number')}
          {input('maxAgeHours', 'أقصى عمر للمرآة (ساعة)', 'number')}
        </div>
        <label className="setting-row">
          <span>
            <b>تفعيل المزامنة المجدولة</b>
            <small>كل {status ? Math.round(status.intervalSeconds / 60) : 60} دقيقة، تشغيل واحد في كل مرة</small>
          </span>
          <input className="toggle" type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} aria-label="تفعيل المزامنة" />
        </label>
        <div className="flex" style={{ gap: 10, marginTop: 12 }}>
          <button className="button primary" disabled={busy} onClick={() => act(() => api.saveHrSource(form), 'حُفظت إعدادات المصدر')}>
            حفظ الإعدادات
          </button>
          <button
            className="button"
            disabled={busy || !source?.exists}
            onClick={() =>
              act(async () => {
                setTest(await api.testHrSource());
              })
            }
          >
            اختبار الاتصال
          </button>
        </div>
        {test && (
          <div className={'note ' + (test.ok ? '' : 'red')} style={{ marginTop: 10 }}>
            {test.ok
              ? `نجح الاتصال (${test.elapsedMs} م.ث) · ${test.databaseVersion ?? ''} · أعمدة الجهات ${test.unitColumns} · أعمدة الأشخاص ${test.personColumns}`
              : `فشل الاتصال: ${test.message ?? test.failure}`}
          </div>
        )}
      </section>

      <section className="card padding" style={{ gridColumn: '1 / -1' }}>
        <div className="flex spread">
          <h2>تعيين الأعمدة</h2>
          <span className="pill">
            {draft ? 'مسودة الإصدار ' + draft.version : published ? 'الإصدار المنشور ' + published.version : 'لا يوجد تعيين'}
          </span>
        </div>
        <p className="micro muted" style={{ margin: '8px 0 12px' }}>
          الحقول ثابتة في العقد؛ يُختار لكل حقل عمود موجود فعلاً في العرض بعد اكتشاف الأعمدة. لا يُخمَّن عمود ولا يُقرأ حقل غير مطلوب.
        </p>
        {(['UNIT', 'PERSON'] as HrEntity[]).map((entity) => (
          <div key={entity} style={{ marginBottom: 14 }}>
            <h3>{ENTITY[entity]}</h3>
            <table className="data-table">
              <thead>
                <tr>
                  <th>الحقل</th>
                  <th>العمود في المصدر</th>
                  <th>التحويل</th>
                  <th>أعمدة بديلة بالترتيب</th>
                </tr>
              </thead>
              <tbody>
                {contract
                  .filter((c) => c.entity === entity)
                  .map((c) => {
                    const f = fieldOf(c);
                    const cols = discovered(entity);
                    return (
                      <tr key={c.field}>
                        <td>
                          {c.label}
                          {c.required ? ' *' : ''}
                          <br />
                          <small className="latin muted">{c.field}</small>
                        </td>
                        <td>
                          {cols.length ? (
                            <select dir="ltr" value={f?.column ?? ''} onChange={(e) => setField(c, { column: e.target.value, enabled: !!e.target.value })}>
                              <option value="">—</option>
                              {cols.map((col) => (
                                <option key={col} value={col}>
                                  {col}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <input dir="ltr" value={f?.column ?? ''} onChange={(e) => setField(c, { column: e.target.value, enabled: !!e.target.value })} />
                          )}
                        </td>
                        <td>
                          <select dir="ltr" value={f?.transform ?? 'none'} onChange={(e) => setField(c, { transform: e.target.value })}>
                            {TRANSFORMS.map((t) => (
                              <option key={t}>{t}</option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <input
                            dir="ltr"
                            disabled={f?.transform !== 'first_non_empty'}
                            value={(f?.alternates ?? []).join(', ')}
                            onChange={(e) => setField(c, { alternates: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })}
                          />
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
            <div className="flex" style={{ gap: 8, marginTop: 8, alignItems: 'end' }}>
              <label className="field">
                <span>عمود السجل النشط</span>
                <input dir="ltr" value={rules[entity]?.column ?? ''} onChange={(e) => setRules({ ...rules, [entity]: { ...(rules[entity] ?? { operator: 'EQUALS', values: [] }), column: e.target.value } })} />
              </label>
              <label className="field">
                <span>المقارنة</span>
                <select
                  value={rules[entity]?.operator ?? 'EQUALS'}
                  onChange={(e) => setRules({ ...rules, [entity]: { ...(rules[entity] ?? { column: '', values: [] }), operator: e.target.value as HrRule['operator'] } })}
                >
                  <option value="EQUALS">يساوي</option>
                  <option value="IN">ضمن</option>
                  <option value="NOT_EQUALS">لا يساوي</option>
                </select>
              </label>
              <label className="field">
                <span>القيم (مفصولة بفاصلة)</span>
                <input
                  value={(rules[entity]?.values ?? []).join(', ')}
                  onChange={(e) =>
                    setRules({ ...rules, [entity]: { ...(rules[entity] ?? { column: '', operator: 'EQUALS' }), values: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) } })
                  }
                />
              </label>
            </div>
          </div>
        ))}
        {problems.length > 0 && (
          <div className="note orange">
            {problems.map((p, i) => (
              <div key={i}>{p}</div>
            ))}
          </div>
        )}
        <div className="flex" style={{ gap: 10, marginTop: 12 }}>
          <button className="button" disabled={busy || !source?.exists} onClick={() => act(() => api.saveHrDraft(fields.filter((f) => f.column), rules), 'حُفظت المسودة')}>
            حفظ المسودة
          </button>
          <button className="button" disabled={busy || !draft} onClick={() => act(() => api.discoverHrMapping(draft!.id), 'اكتُشفت أعمدة العرضين من المصدر')}>
            اكتشاف الأعمدة
          </button>
          <button className="button primary" disabled={busy || !draft} onClick={() => act(() => api.publishHrMapping(draft!.id), 'نُشر إصدار التعيين')}>
            نشر الإصدار
          </button>
        </div>
      </section>
    </>
  );
}
