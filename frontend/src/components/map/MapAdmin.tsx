import { useEffect, useState } from 'react';
import { api, urls } from '../../api/client';
import type { ImportJob, MapPackage } from '../../api/types';
import { formatArea } from '../../lib/mapState';
import { Dialog } from '../ui';

const CRS_OPTIONS: [string, string][] = [
  ['', 'من الملف (crs) — مطلوب إن لم يعرّفه الملف'],
  ['EPSG:4326', 'EPSG:4326 / CRS84 — خط الطول، خط العرض (GeoJSON)'],
  ['EPSG:3857', 'EPSG:3857 — Web Mercator (متر)'],
  ['EPSG:32640', 'EPSG:32640 — UTM نطاق 40 شمال (متر)'],
  ['EPSG:32639', 'EPSG:32639 — UTM نطاق 39 شمال (متر)'],
];

/**
 * Boundary import: upload → preview with a report (CRS, validity, link to site records) → authorised publish of the
 * whole file, or cancel. A file with any problem cannot be published, so nothing is ever published partially.
 */
export function ImportDialog({
  open,
  targetSite,
  onClose,
  onPublished,
}: {
  open: boolean;
  targetSite: { id: string; name: string } | null;
  onClose: () => void;
  onPublished: (job: ImportJob) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [crs, setCrs] = useState('');
  const [job, setJob] = useState<ImportJob | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setFile(null);
      setCrs('');
      setJob(null);
      setReason('');
      setError('');
      setProblems([]);
    }
  }, [open]);

  const preview = async () => {
    if (!file) return setError('اختر ملف GeoJSON أو KML.');
    setBusy(true);
    setError('');
    setProblems([]);
    try {
      setJob(await api.importBoundaries(file, crs || undefined, targetSite?.id));
    } catch (e) {
      const err = e as Error & { details?: { problems?: string[] } };
      setError(err.message);
      setProblems(err.details?.problems ?? []);
    } finally {
      setBusy(false);
    }
  };
  const publish = async () => {
    if (!job) return;
    if (reason.trim().length < 5) return setError('اكتب سبب النشر (5 أحرف على الأقل).');
    setBusy(true);
    setError('');
    try {
      const done = await api.publishImport(job.id, reason.trim());
      setJob(done);
      onPublished(done);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    if (job && (job.status === 'PREVIEWED' || job.status === 'REJECTED')) {
      try {
        await api.cancelImport(job.id);
      } catch {
        /* the job is closed anyway; nothing was published */
      }
    }
    onClose();
  };

  return (
    <Dialog open={open} onClose={cancel} className="large-dialog">
      <div className="dialog-head">
        <div>
          <span className="eyebrow">IMPORT / SITE BOUNDARIES</span>
          <h2>استيراد حدود المواقع</h2>
          <small>{targetSite ? 'لموقع «' + targetSite.name + '» (ملف بشكل واحد)' : 'كل شكل يحمل رمز الموقع site_code'}</small>
        </div>
        <button className="icon-button" onClick={cancel} aria-label="إغلاق الاستيراد">
          ✕
        </button>
      </div>
      <div className="dialog-content">
        <p className="micro muted">
          الصيغ المدعومة: GeoJSON و KML. للصيغ الأخرى (Shapefile، GeoPackage) حوّل الملف إلى GeoJSON بنظام إحداثيات صريح كما في دليل التشغيل.
          لا يُخمَّن النظام من شكل الأرقام، ولا يُنشر ملف فيه أي خطأ.
        </p>
        <div className="row">
          <label className="field">
            <span>الملف</span>
            <input type="file" accept=".geojson,.json,.kml" onChange={(e) => (setFile(e.target.files?.[0] ?? null), setJob(null))} aria-label="ملف الحدود" />
          </label>
          <label className="field">
            <span>نظام الإحداثيات المعلن</span>
            <select value={crs} onChange={(e) => (setCrs(e.target.value), setJob(null))} aria-label="نظام الإحداثيات">
              {CRS_OPTIONS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        </div>
        <button className="button" onClick={preview} disabled={busy || !file}>
          {busy && !job ? 'جارٍ الفحص…' : 'معاينة وفحص'}
        </button>
        {job && (
          <div className="import-report" role="region" aria-label="تقرير الاستيراد">
            <div className={'note ' + (job.status === 'REJECTED' ? 'red' : job.status === 'PUBLISHED' ? '' : 'orange')}>
              <b>
                {job.status === 'PREVIEWED'
                  ? 'جاهز للنشر بعد المراجعة'
                  : job.status === 'REJECTED'
                    ? 'مرفوض — لا يمكن نشر أي جزء من الملف'
                    : job.status === 'PUBLISHED'
                      ? 'نُشرت الحدود بإصدارات جديدة'
                      : 'أُلغي الاستيراد'}
              </b>
              <br />
              {job.format} · النظام: {job.effectiveCrs ?? 'غير معرّف'}
              {job.fileCrs ? ' (من الملف)' : job.declaredCrs ? ' (معلن)' : ''} · {job.axisOrder}
            </div>
            {job.fileProblems.length > 0 && (
              <ul className="problem-list">
                {job.fileProblems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>رمز الموقع</th>
                    <th>السجل المرتبط</th>
                    <th>الهندسة</th>
                    <th>المساحة</th>
                    <th>الإصدار الحالي</th>
                    <th>الفحص</th>
                  </tr>
                </thead>
                <tbody>
                  {job.features.map((f) => (
                    <tr key={f.index} className={f.problems.length ? 'bad' : ''}>
                      <td>{f.index + 1}</td>
                      <td className="latin">{f.siteCode ?? '—'}</td>
                      <td>{f.siteName ?? '—'}</td>
                      <td>
                        {f.type ?? '—'} · {f.vertices} رأس
                      </td>
                      <td>{formatArea(f.areaM2)}</td>
                      <td>{f.currentVersion ?? '—'}</td>
                      <td>{f.problems.length ? f.problems.join(' · ') : '✓ صالح'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {job.status === 'PREVIEWED' && (
              <label className="field" style={{ marginTop: 12 }}>
                <span>سبب النشر</span>
                <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="مثال: حدود معتمدة من مسح المرافق" />
              </label>
            )}
          </div>
        )}
        {problems.length > 1 && (
          <ul className="problem-list">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        <div className="error-text" role="alert">
          {error}
        </div>
      </div>
      <div className="dialog-actions">
        <button className="button ghost" onClick={cancel} disabled={busy}>
          {job?.status === 'PUBLISHED' ? 'إغلاق' : 'إلغاء دون نشر'}
        </button>
        <span className="grow" />
        <button className="button primary" onClick={publish} disabled={busy || job?.status !== 'PREVIEWED'}>
          نشر الحدود
        </button>
      </div>
    </Dialog>
  );
}

const STATUS_LABEL: Record<string, [string, string]> = {
  ACTIVE: ['مفعّلة', 'green'],
  PENDING_REVIEW: ['قيد المراجعة', 'orange'],
  DISABLED: ['معطّلة', ''],
  REJECTED: ['مرفوضة', 'red'],
  RETIRED: ['متقاعدة', ''],
};

/** Map packages for the authorised map manager: upload, review with preview on the map, activate, disable. */
export function PackageManager({ open, onClose, onChanged, onPreview }: { open: boolean; onClose: () => void; onChanged: () => void; onPreview: (p: MapPackage) => void }) {
  const [list, setList] = useState<MapPackage[] | null>(null);
  const [error, setError] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');

  const load = () =>
    api
      .mapPackages(true)
      .then(setList)
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    if (open) {
      setError('');
      setProblems([]);
      void load();
    }
  }, [open]);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError('');
    setProblems([]);
    try {
      await api.uploadMapPackage(file);
      await load();
    } catch (e) {
      const err = e as Error & { details?: { problems?: string[] } };
      setError(err.message);
      setProblems(err.details?.problems ?? []);
    } finally {
      setBusy(false);
    }
  };
  const status = async (p: MapPackage, s: 'ACTIVE' | 'DISABLED' | 'REJECTED') => {
    if (reason.trim().length < 5) return setError('اكتب سبب القرار (5 أحرف على الأقل) في الحقل أعلى القائمة.');
    setBusy(true);
    setError('');
    try {
      await api.setPackageStatus(p.code, p.version, s, reason.trim());
      setReason('');
      await load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const overlays = (list ?? []).filter((p) => p.role === 'overlay');
  return (
    <Dialog open={open} onClose={onClose} className="large-dialog">
      <div className="dialog-head">
        <div>
          <span className="eyebrow">MAP PACKAGES / LOCAL</span>
          <h2>مدير الخرائط</h2>
          <small>حزم محلية بمصدر وترخيص وتغطية وإصدار وبصمات؛ لا تنزيل من الشبكة</small>
        </div>
        <button className="icon-button" onClick={onClose} aria-label="إغلاق مدير الخرائط">
          ✕
        </button>
      </div>
      <div className="dialog-content">
        <label className="field">
          <span>رفع حزمة (ZIP يحتوي manifest.json وملف الخلفية)</span>
          <input type="file" accept=".zip" disabled={busy} onChange={(e) => upload(e.target.files?.[0])} aria-label="ملف الحزمة" />
          <small>العارض المثبت يدعم SVG وصور PNG/JPEG مسندة بحدود EPSG:4326. حزم PMTiles وMBTiles وXYZ غير مدعومة في هذا الإصدار.</small>
        </label>
        <label className="field">
          <span>سبب قرار التفعيل أو التعطيل</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="مثال: روجع الترخيص والتغطية" />
        </label>
        <div className="error-text" role="alert">
          {error}
        </div>
        {problems.length > 1 && (
          <ul className="problem-list">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>الحزمة</th>
                <th>النوع والتغطية</th>
                <th>المصدر والترخيص</th>
                <th>الحالة</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {overlays.map((p) => {
                const [label, tone] = STATUS_LABEL[p.status] ?? [p.status, ''];
                return (
                  <tr key={p.id}>
                    <td>
                      <b>{p.name}</b>
                      <br />
                      <span className="latin tiny">
                        {p.code} {p.version} · {p.format} · {p.storage === 'BUILTIN' ? 'مضمنة' : 'مرفوعة'}
                      </span>
                      {p.sha256 && (
                        <>
                          <br />
                          <span className="latin tiny muted">sha256 {p.sha256.slice(0, 16)}…</span>
                        </>
                      )}
                    </td>
                    <td className="micro">
                      {p.kind} · {p.crs.split(' ')[0]} · تكبير {p.minZoom ?? '?'}–{p.maxZoom ?? '?'}
                      <br />
                      {p.coverage.minLat.toFixed(3)}–{p.coverage.maxLat.toFixed(3)} / {p.coverage.minLng.toFixed(3)}–{p.coverage.maxLng.toFixed(3)} · {p.dataDate}
                    </td>
                    <td className="micro">
                      {p.source}
                      <br />
                      {p.license}
                    </td>
                    <td>
                      <span className={'pill ' + tone}>{label}</span>
                      {p.statusReason && <small className="micro muted"> {p.statusReason}</small>}
                    </td>
                    <td className="package-actions">
                      <button className="button compact ghost" onClick={() => onPreview(p)}>
                        معاينة على الخريطة
                      </button>
                      <a className="button compact ghost" href={urls.mapContent(p)} target="_blank" rel="noopener">
                        الملف
                      </a>
                      {(p.status === 'PENDING_REVIEW' || p.status === 'DISABLED') && (
                        <button className="button compact" disabled={busy} onClick={() => status(p, 'ACTIVE')}>
                          تفعيل
                        </button>
                      )}
                      {p.status === 'ACTIVE' && (
                        <button className="button compact" disabled={busy} onClick={() => status(p, 'DISABLED')}>
                          تعطيل
                        </button>
                      )}
                      {p.status === 'PENDING_REVIEW' && (
                        <button className="button compact danger" disabled={busy} onClick={() => status(p, 'REJECTED')}>
                          رفض
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {list === null && <p className="micro muted">جارٍ التحميل…</p>}
      </div>
    </Dialog>
  );
}
