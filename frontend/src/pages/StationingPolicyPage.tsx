import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type {
  HierarchyLevel,
  PolicyChange,
  RoutingLevelValue,
  StationingFact,
  StationingPolicyValues,
  StationingPolicyVersion,
  TerrainDatasetView,
} from '../api/types';
import { NumberField } from '../components/NumberField';
import { TerrainExtraField, type ExtraUnit } from '../components/TerrainExtraField';
import { Heading } from '../components/ui';
import { useApp } from '../lib/app';
import { fullDate } from '../lib/dates';
import { INITIAL_SLOPE_LIMITS } from '../lib/terrainRgb';
import './restationing.css';

const FACTS: [StationingFact, string][] = [
  ['SCOPE', 'الوحدات المنتقلة'],
  ['CLASSIFICATION', 'النوع (دائم / مؤقت)'],
  ['DURATION', 'المدة'],
  ['SITE', 'الموقع المقترح'],
  ['DEPLOYMENT', 'الانتشار'],
  ['AVAILABILITY', 'الإتاحة'],
];
const AUTHORITIES: [StationingPolicyValues['crossBranch']['authorities'][number], string][] = [
  ['OTHER_UNIT', 'موافقة الوحدة المضافة'],
  ['OTHER_UNIT_PARENT', 'موافقة الجهة الأعلى للوحدة المضافة'],
  ['SITE_RESPONSIBLE', 'موافقة المسؤول عن موقع الوحدة المضافة'],
];

const DISTANCE_UNITS: ExtraUnit[] = [{ id: 'km', word: 'كم', factor: 1000 }, { id: 'm', word: 'م', factor: 1 }];
const AREA_UNITS: ExtraUnit[] = [{ id: 'km2', word: 'كم²', factor: 1_000_000 }, { id: 'm2', word: 'م²', factor: 1 }];

/** A blank starting point: the owner-approved initial slope classes (decision 2) and nothing else assumed. */
function blank(classes: StationingPolicyValues['terrainSlopeClassification']['classes'], dataset: TerrainDatasetView | undefined, levels: HierarchyLevel[]): StationingPolicyValues {
  return {
    maxFootprintAreaM2: 0,
    deploymentRequirement: null,
    primary: { minM: 0, maxM: 0, terrainApplies: false },
    alternative: { minM: 0, maxM: 0, terrainApplies: false },
    terrainSlopeClassification: { datasetCode: dataset?.code ?? '', datasetVersion: dataset?.version ?? '', classes },
    terrainAllowancesM: {},
    terrainClassPriority: [],
    terrainAppliesTo: 'MAX_ONLY',
    exception: { allowed: false, maxExtraM: 0 },
    crossBranch: { allowed: false, authorities: [], independent: false },
    routing: { startAt: 'SELF', levels: levels.map((l) => ({ level: l.level, approves: false, label: '', finalStage: false, dependsOn: [] })) },
    deploymentAreaDefault: null,
  };
}

/**
 * «سياسة التمركز»: the System Administrator's versioned Stationing policy (Model V3 §8). Every value is the
 * administrator's; the page assumes none. It starts from the version in force (or the approved initial slope classes),
 * can import values from a JSON file, checks them on the server before publishing, and shows every version with its
 * changes. Publishing is append-only, effective-dated, reasoned and audited on the server.
 */
export function StationingPolicyPage() {
  const app = useApp();
  const [values, setValues] = useState<StationingPolicyValues | null>(null);
  const [inForce, setInForce] = useState<StationingPolicyVersion | null>(null);
  const [history, setHistory] = useState<{ version: StationingPolicyVersion; changes: PolicyChange[] }[]>([]);
  const [levels, setLevels] = useState<HierarchyLevel[]>([]);
  const [datasets, setDatasets] = useState<TerrainDatasetView[]>([]);
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');
  const [effective, setEffective] = useState('');
  const [check, setCheck] = useState<{ ok: boolean; problems: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [distUnit, setDistUnit] = useState<'km' | 'm'>('km');
  const [areaUnit, setAreaUnit] = useState<'km2' | 'm2'>('km2');

  const load = async () => {
    const [ov, hist, lv, ds] = await Promise.all([api.stationingPolicy(), api.stationingPolicyVersions(), api.hierarchyLevels(), api.terrainDatasets()]);
    setInForce(ov.inForce);
    setHistory(hist);
    setLevels(lv);
    setDatasets(ds);
    // a version published before the single-click footprint existed may lack the key: keep it on the page as «not
    // configured» so a JSON import can still set it (the import only takes keys the page already has)
    setValues(ov.inForce ? { ...structuredClone(ov.inForce.values), deploymentAreaDefault: ov.inForce.values.deploymentAreaDefault ?? null } : blank(ov.initialSlopeClasses, ds[0], lv));
  };
  useEffect(() => {
    load().catch((e: Error) => app.toast(e.message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!values) return <div className="card empty">جارٍ التحميل…</div>;
  const set = (patch: Partial<StationingPolicyValues>) => {
    setValues({ ...values, ...patch });
    setCheck(null);
  };
  const classes = values.terrainSlopeClassification.classes;
  const slopeLimits = values.slopeDisplay ?? INITIAL_SLOPE_LIMITS;
  const setLevel = (i: number, patch: Partial<RoutingLevelValue>) =>
    set({ routing: { ...values.routing, levels: values.routing.levels.map((l, j) => (j === i ? { ...l, ...patch } : l)) } });

  const importFile = async (f: File) => {
    try {
      const raw = JSON.parse(await f.text()) as Partial<StationingPolicyValues> & { reason?: string; reference?: string; _note?: string };
      const keep = values.routing.levels;
      const next = { ...values } as Record<string, unknown>;
      for (const k of Object.keys(values) as (keyof StationingPolicyValues)[]) if (raw[k] !== undefined) next[k] = raw[k];
      const merged = next as StationingPolicyValues;
      // a file with no routing levels keeps the rows already on the page (the administrator sets them here)
      if (!raw.routing?.levels?.length) merged.routing = { startAt: raw.routing?.startAt ?? values.routing.startAt, levels: keep };
      setValues(merged);
      if (raw.reason) setReason(raw.reason);
      if (raw.reference) setReference(raw.reference);
      setNote(raw._note ?? null);
      setCheck(null);
      app.toast('استُوردت القيم من الملف — راجعها قبل الفحص والنشر');
    } catch (e) {
      app.toast('ملف غير مقروء: ' + (e as Error).message);
    }
  };

  const validate = async () => {
    setBusy(true);
    try {
      const local: string[] = [];
      if (!values.deploymentRequirement) local.push('اختر هل منطقتا الانتشار مطلوبتان أم اختياريتان');
      const r = await api.validateStationingPolicy(values);
      setCheck({ ok: r.ok && local.length === 0, problems: [...local, ...r.problems] });
    } catch (e) {
      app.toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    setBusy(true);
    try {
      const r = await api.publishStationingPolicy(values, effective ? new Date(effective).toISOString() : null, reason, reference);
      app.toast('نُشرت نسخة السياسة ' + r.version.version);
      setCheck(null);
      await load();
    } catch (e) {
      const err = e as Error & { details?: { problems?: string[] } };
      setCheck({ ok: false, problems: err.details?.problems ?? [err.message] });
    } finally {
      setBusy(false);
    }
  };

  // typed in the chosen unit; always stored in metres and square metres, as the rules read them
  const distFactor = distUnit === 'km' ? 1000 : 1;
  const distWord = distUnit === 'km' ? 'كم' : 'م';
  const toDist = (m: number) => m / distFactor;
  const fromDist = (v: number | null) => (v == null ? null : Math.round(v * distFactor));
  const areaFactor = areaUnit === 'km2' ? 1_000_000 : 1;
  const areaWord = areaUnit === 'km2' ? 'كم²' : 'م²';
  const toArea = (m: number) => m / areaFactor;
  const fromArea = (v: number | null) => Math.round((v ?? 0) * areaFactor);
  const areaDefault = values.deploymentAreaDefault ?? null;
  const metres2 = (m: number) => m.toLocaleString('ar-AE', { maximumFractionDigits: 0 }) + ' م²';
  const metres = (m: number) => m.toLocaleString('ar-AE', { maximumFractionDigits: 0 }) + ' م';

  return (
    <>
      <Heading
        en="STATIONING POLICY / SYSTEM ADMINISTRATOR"
        title="سياسة التمركز"
        description="كل قيمة هنا يحددها مسؤول النظام، ولا يفترض النظام أي قيمة. النشر نسخة جديدة بتاريخ سريان وسبب ومرجع وتدقيق، والطلب يبقى مقفلاً على نسخة إرساله."
        actions={
          <label className="button">
            استيراد قيم من ملف JSON
            <input type="file" accept="application/json,.json" hidden onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
          </label>
        }
      />
      <div className="rs-policy">
        <div className="card rs-policy-state">
          {inForce ? (
            <span>
              النسخة السارية: <b>{inForce.version}</b> منذ {fullDate(inForce.effectiveFrom)} · {inForce.createdByName} · {inForce.reference}
            </span>
          ) : (
            <span className="rs-bad">لا توجد سياسة تمركز نافذة — الطلبات لا تُرسل حتى تُنشر نسخة.</span>
          )}
          {note && <div className="rs-banner orange">{note}</div>}
        </div>

        <section className="card rs-form">
          <h3>منطقتا الانتشار والمسافات (من المركز إلى المركز)</h3>
          <fieldset className="rs-inline" data-testid="policy-units">
            <legend>وحدة الإدخال</legend>
            <label>
              المسافات
              <select aria-label="وحدة المسافات" value={distUnit} onChange={(e) => setDistUnit(e.target.value as 'km' | 'm')}>
                <option value="km">كيلومتر</option>
                <option value="m">متر</option>
              </select>
            </label>
            <label>
              المساحات
              <select aria-label="وحدة المساحات" value={areaUnit} onChange={(e) => setAreaUnit(e.target.value as 'km2' | 'm2')}>
                <option value="km2">كيلومتر مربع</option>
                <option value="m2">متر مربع</option>
              </select>
            </label>
          </fieldset>
          <fieldset className="rs-inline">
            <legend>هل منطقتا الانتشار مطلوبتان؟</legend>
            <label><input type="radio" checked={values.deploymentRequirement === 'REQUIRED'} onChange={() => set({ deploymentRequirement: 'REQUIRED' })} /> مطلوبتان (الموقع والرئيسية والبديلة)</label>
            <label><input type="radio" checked={values.deploymentRequirement === 'OPTIONAL'} onChange={() => set({ deploymentRequirement: 'OPTIONAL' })} /> اختياريتان (لا شيء أو المنطقتان معاً)</label>
          </fieldset>
          <fieldset className="rs-inline" data-testid="policy-stages">
            <legend>مراحل ما بعد التسلسل الهرمي (من يحملها يُحدَّد بالصلاحيات، لا هنا)</legend>
            {([['unitOperations', 'اعتماد عمليات الوحدة'], ['finalByPermission', 'الاعتماد النهائي مرحلة مستقلة'], ['fyiBeforeActivation', 'تحديد وحدات العلم قبل التفعيل']] as const).map(([k, label]) => (
              <label key={k}><input type="checkbox" data-stage={k} checked={!!values.approvalStages?.[k]} onChange={(e) => set({ approvalStages: { unitOperations: false, finalByPermission: false, fyiBeforeActivation: false, ...values.approvalStages, [k]: e.target.checked } })} /> {label}</label>
            ))}
          </fieldset>
          {(['primary', 'alternative'] as const).map((leg) => (
            <fieldset key={leg} className="rs-inline">
              <legend>{leg === 'primary' ? 'الموقع ← منطقة الانتشار الرئيسية' : 'الرئيسية ← منطقة الانتشار البديلة'}</legend>
              <label>من ({distWord}) <NumberField value={toDist(values[leg].minM)} onChange={(v) => set({ [leg]: { ...values[leg], minM: fromDist(v) ?? 0 } })} /></label>
              <label>إلى ({distWord}) <NumberField value={toDist(values[leg].maxM)} onChange={(v) => set({ [leg]: { ...values[leg], maxM: fromDist(v) ?? 0 } })} /></label>
              <TerrainExtraField
                on={values[leg].terrainApplies}
                extra={values[leg].terrainExtra ?? null}
                units={DISTANCE_UNITS}
                label={leg === 'primary' ? 'الرئيسية' : 'البديلة'}
                onChange={(on, terrainExtra) => set({ [leg]: { ...values[leg], terrainApplies: on, terrainExtra } })}
              />
            </fieldset>
          ))}
          <label>
            الحد الأقصى لمساحة الموقع المقترح ({areaWord})
            <NumberField label="الحد الأقصى لمساحة الموقع المقترح" value={toArea(values.maxFootprintAreaM2)} onChange={(v) => set({ maxFootprintAreaM2: fromArea(v) })} />
            {values.maxFootprintAreaM2 > 0 && (
              <span className="muted" data-testid="max-footprint-m2">
                = {metres2(values.maxFootprintAreaM2)}: لا يُقبل موقع مقترح أكبر من هذه المساحة
              </span>
            )}
          </label>
          <fieldset className="rs-inline" data-testid="footprint-terrain">
            <TerrainExtraField
              on={!!values.footprintTerrainExtra}
              extra={values.footprintTerrainExtra ?? null}
              units={AREA_UNITS}
              label="المساحة"
              onChange={(on, footprintTerrainExtra) => set({ footprintTerrainExtra: on ? footprintTerrainExtra : null })}
            />
          </fieldset>
          {/* no size is assumed: «غير محددة» until the administrator enters one; the server checks it (0 < area ≤ 25 كم²) */}
          <fieldset className="rs-inline">
            <legend>المنطقة الابتدائية لمنطقة الانتشار (عند وضعها بنقرة)</legend>
            <label><input type="checkbox" checked={!areaDefault} onChange={(e) => set({ deploymentAreaDefault: e.target.checked ? null : { shape: 'SQUARE', areaM2: 0 } })} /> غير محددة</label>
            <label>
              الشكل
              <select disabled={!areaDefault} value={areaDefault?.shape ?? 'SQUARE'} onChange={(e) => areaDefault && set({ deploymentAreaDefault: { ...areaDefault, shape: e.target.value as 'SQUARE' | 'CIRCLE' } })}>
                <option value="SQUARE">مربع</option>
                <option value="CIRCLE">دائرة</option>
              </select>
            </label>
            <label>المساحة ({areaWord}) <NumberField disabled={!areaDefault} value={areaDefault ? toArea(areaDefault.areaM2) : null} placeholder="—" onChange={(v) => areaDefault && set({ deploymentAreaDefault: { ...areaDefault, areaM2: fromArea(v) } })} /></label>
            {areaDefault && areaDefault.areaM2 > 0 && (
              <span className="muted">
                {/* the circle is drawn as a regular 16-vertex polygon of this area: its centre-to-vertex distance */}
                {areaDefault.shape === 'SQUARE' ? 'الضلع ≈ ' + metres(Math.sqrt(areaDefault.areaM2)) : 'مضلع منتظم بـ16 رأساً، نصف قطره ≈ ' + metres(Math.sqrt((2 * areaDefault.areaM2) / (16 * Math.sin(Math.PI / 8))))}
              </span>
            )}
          </fieldset>
        </section>

        <section className="card rs-form">
          <h3>طبيعة الأرض (الميل بالنسبة المئوية؛ الإضافة تمد الحد الأقصى فقط)</h3>
          <label>
            مجموعة بيانات الأرض
            <select
              value={values.terrainSlopeClassification.datasetCode + '|' + values.terrainSlopeClassification.datasetVersion}
              onChange={(e) => {
                const [code, version] = e.target.value.split('|');
                set({ terrainSlopeClassification: { ...values.terrainSlopeClassification, datasetCode: code, datasetVersion: version } });
              }}
            >
              <option value="|">— اختر —</option>
              {datasets.map((d) => (
                <option key={d.id} value={d.code + '|' + d.version}>
                  {d.code} {d.version} (نموذج سطح {d.surfaceModel})
                </option>
              ))}
            </select>
          </label>
          <table className="rs-table">
            <thead>
              <tr><th>الفئة</th><th>التسمية</th><th>من ٪</th><th>إلى ٪</th></tr>
            </thead>
            <tbody>
              {classes.map((c, i) => (
                <tr key={c.code}>
                  <td>{c.code}</td>
                  <td><input value={c.label} onChange={(e) => set({ terrainSlopeClassification: { ...values.terrainSlopeClassification, classes: classes.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) } })} /></td>
                  <td>{c.fromPct}</td>
                  <td>{c.toPct ?? '∞'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <fieldset className="rs-inline" data-testid="slope-limits">
            <legend>ألوان الانحدار على الخريطة (للعرض فقط، لا تدخل في أي قاعدة)</legend>
            <label>
              أخضر أقل من ٪
              <NumberField label="أخضر أقل من" value={slopeLimits.greenBelowPct} onChange={(v) => set({ slopeDisplay: { ...slopeLimits, greenBelowPct: v ?? 0 } })} />
            </label>
            <label>
              أحمر من ٪
              <NumberField label="أحمر من" value={slopeLimits.redFromPct} onChange={(v) => set({ slopeDisplay: { ...slopeLimits, redFromPct: v ?? 0 } })} />
            </label>
            <span className="tz-muted">بينهما برتقالي. تظهر داخل الموقع ومنطقتي الانتشار أثناء وضعها في الطلب.</span>
          </fieldset>
          <div>
            <b>ترتيب الأولوية عند تعادل أكبر مساحة (الأعلى أولاً):</b>
            <ol className="rs-priority">
              {values.terrainClassPriority.map((code, i) => (
                <li key={code}>
                  {classes.find((c) => c.code === code)?.label ?? code}
                  <button className="chip" disabled={i === 0} onClick={() => { const p = [...values.terrainClassPriority]; [p[i - 1], p[i]] = [p[i], p[i - 1]]; set({ terrainClassPriority: p }); }}>▲</button>
                  <button className="chip" onClick={() => set({ terrainClassPriority: values.terrainClassPriority.filter((x) => x !== code) })}>✕</button>
                </li>
              ))}
            </ol>
            {classes.filter((c) => !values.terrainClassPriority.includes(c.code)).map((c) => (
              <button key={c.code} className="chip" onClick={() => set({ terrainClassPriority: [...values.terrainClassPriority, c.code] })}>＋ {c.label}</button>
            ))}
          </div>
        </section>

        <section className="card rs-form">
          <h3>تجاوز المسافة المسموحة، وإضافة وحدة من فرع آخر</h3>
          <fieldset className="rs-inline">
            <legend>تجاوز مسافة الانتشار المسموحة</legend>
            <label><input type="checkbox" checked={values.exception.allowed} onChange={(e) => set({ exception: { ...values.exception, allowed: e.target.checked } })} /> مسموح، بعد موافقة منفصلة</label>
            <label>أقصى زيادة ({distWord}) <NumberField disabled={!values.exception.allowed} value={toDist(values.exception.maxExtraM)} onChange={(v) => set({ exception: { ...values.exception, maxExtraM: fromDist(v) ?? 0 } })} /></label>
          </fieldset>
          <fieldset>
            <legend>إضافة وحدة من فرع آخر إلى الطلب</legend>
            <label className="rs-check"><input type="checkbox" checked={values.crossBranch.allowed} onChange={(e) => set({ crossBranch: { ...values.crossBranch, allowed: e.target.checked } })} /> مسموح (باختيار مقدم الطلب، ولا تنتقل أي وحدة تلقائياً)</label>
            {AUTHORITIES.map(([a, label]) => (
              <label key={a} className="rs-check">
                <input
                  type="checkbox"
                  disabled={!values.crossBranch.allowed}
                  checked={values.crossBranch.authorities.includes(a)}
                  onChange={(e) => set({ crossBranch: { ...values.crossBranch, authorities: e.target.checked ? [...values.crossBranch.authorities, a] : values.crossBranch.authorities.filter((x) => x !== a) } })}
                />{' '}
                {label}
              </label>
            ))}
            <label className="rs-check"><input type="checkbox" disabled={!values.crossBranch.allowed} checked={values.crossBranch.independent} onChange={(e) => set({ crossBranch: { ...values.crossBranch, independent: e.target.checked } })} /> كل موافقة منفصلة، ومن شخص مختلف</label>
          </fieldset>
        </section>

        <section className="card rs-form">
          <h3>مسار الاعتماد (من الوحدة الطالبة صعوداً في الهيكل التنظيمي)</h3>
          <fieldset className="rs-inline">
            <legend>المرحلة الأولى</legend>
            <label><input type="radio" checked={values.routing.startAt === 'SELF'} onChange={() => set({ routing: { ...values.routing, startAt: 'SELF' } })} /> معتمد الوحدة الطالبة</label>
            <label><input type="radio" checked={values.routing.startAt === 'PARENT'} onChange={() => set({ routing: { ...values.routing, startAt: 'PARENT' } })} /> الجهة الأعلى للوحدة الطالبة</label>
          </fieldset>
          <table className="rs-table">
            <thead>
              <tr><th>المستوى</th><th>في الهيكل</th><th>يعتمد</th><th>التسمية</th><th>نهائي</th><th>تُعاد الموافقة إذا تغيّر</th><th /></tr>
            </thead>
            <tbody>
              {values.routing.levels.map((l, i) => (
                <tr key={i}>
                  <td><NumberField value={l.level} onChange={(v) => setLevel(i, { level: Math.trunc(v ?? 0) })} /></td>
                  <td className="muted">{levels.find((x) => x.level === l.level)?.examples.join('، ') ?? '—'}</td>
                  <td><input type="checkbox" checked={l.approves} onChange={(e) => setLevel(i, { approves: e.target.checked })} /></td>
                  <td><input value={l.label} placeholder="مثل: اعتماد الإدارة" onChange={(e) => setLevel(i, { label: e.target.value })} /></td>
                  <td><input type="radio" name="final" checked={l.finalStage} onChange={() => set({ routing: { ...values.routing, levels: values.routing.levels.map((x, j) => ({ ...x, finalStage: j === i })) } })} /></td>
                  <td className="rs-facts-cell">
                    {l.finalStage ? (
                      <span className="muted">أي تغيير (المرحلة النهائية)</span>
                    ) : (
                      FACTS.map(([f, label]) => (
                        <label key={f} className="rs-check">
                          <input type="checkbox" checked={l.dependsOn.includes(f)} onChange={(e) => setLevel(i, { dependsOn: e.target.checked ? [...l.dependsOn, f] : l.dependsOn.filter((x) => x !== f) })} /> {label}
                        </label>
                      ))
                    )}
                  </td>
                  <td><button className="chip" onClick={() => set({ routing: { ...values.routing, levels: values.routing.levels.filter((_, j) => j !== i) } })}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="button" onClick={() => set({ routing: { ...values.routing, levels: [...values.routing.levels, { level: 0, approves: false, label: '', finalStage: false, dependsOn: [] }] } })}>＋ مستوى</button>
          <small className="muted">المستويات في الهيكل التنظيمي: {levels.map((l) => `L${l.level} (${l.units})`).join('، ') || 'تظهر بعد استيراد الوحدات'}. المستوى بلا صف لا يعتمد؛ والمسار يقف عند المستوى النهائي.</small>
        </section>

        <section className="card rs-form">
          <h3>النشر</h3>
          <label>سبب التغيير<textarea value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          <label>المرجع<input value={reference} onChange={(e) => setReference(e.target.value)} /></label>
          <label>تاريخ السريان (فارغ = الآن)<input type="datetime-local" value={effective} onChange={(e) => setEffective(e.target.value)} /></label>
          <div className="rs-tools">
            <button className="button" disabled={busy} onClick={validate}>فحص على الخادم</button>
            <button className="button primary" disabled={busy || !check?.ok || reason.trim().length < 5} onClick={publish}>نشر نسخة جديدة</button>
          </div>
          {check && (
            <div>
              <div className={'rs-verdict ' + (check.ok ? 'ok' : 'no')}>{check.ok ? 'القيم صالحة للنشر' : 'قيم غير صالحة'}</div>
              <ul className="rs-problems">{check.problems.map((p) => <li key={p}>{p}</li>)}</ul>
            </div>
          )}
        </section>

        <section className="card rs-form">
          <h3>النسخ المنشورة</h3>
          {history.length === 0 && <span className="muted">لا نسخ بعد.</span>}
          <ul className="rs-revisions">
            {history.map((h) => (
              <li key={h.version.id}>
                <b>نسخة {h.version.version}</b> · سارية من {fullDate(h.version.effectiveFrom)} · {h.version.createdByName} · {h.version.reference} — {h.version.reason}
                {h.changes.length > 0 && <div className="muted">تغيّر: {h.changes.map((c) => c.key).join('، ')}</div>}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}
