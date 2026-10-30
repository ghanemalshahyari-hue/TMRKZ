import { useEffect, useRef, useState } from 'react';
import { api, newIdempotencyKey } from '../api/client';
import type { UnitSymbol as Symbol } from '../api/types';
import { approvedSymbolStandard, invalidateSymbols, renderSymbol, STANDARD_LABEL, useOrgSymbol } from '../lib/unitSymbols';

/** The renderer's SVG for a SIDC as an image (generated locally; never an uploaded SVG). */
function SymbolImage({ sidc, standard, size, alt }: { sidc: string; standard: string; size: number; alt: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    renderSymbol(sidc, standard, size)
      .then((r) => live && setSrc(r.url))
      .catch(() => live && setSrc(null));
    return () => {
      live = false;
    };
  }, [sidc, standard, size]);
  return src ? <img className="unit-symbol-img" src={src} alt={alt} title={alt} /> : <span className="unit-symbol-img placeholder" aria-hidden="true" />;
}

/**
 * Informational identity symbol of an organisation, beside (never instead of) its Arabic name. A visible organisation
 * without an approved assignment shows a generic organisation mark labelled «لم يحدد رمز الوحدة»; an organisation the
 * reader may not see shows only its name. Availability and request states are never drawn on the symbol.
 */
export function OrgSymbol({ orgId, size = 22, withText = false }: { orgId: string | null | undefined; size?: number; withText?: boolean }) {
  const s = useOrgSymbol(orgId);
  if (s.state === 'hidden') return null;
  if (s.state === 'loading') return <span className="unit-symbol" style={{ width: size, height: size }} aria-hidden="true" />;
  if (s.state === 'none')
    return (
      <span className="unit-symbol generic" style={{ width: size, height: size }} title="لم يحدد رمز الوحدة">
        <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
          <rect x="3" y="6" width="18" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="3 2" />
          <path d="M8 12h8" stroke="currentColor" strokeWidth="1.6" />
        </svg>
        <span className="sr-only">لم يحدد رمز الوحدة</span>
        {withText && <small>لم يحدد رمز الوحدة</small>}
      </span>
    );
  return (
    <span className="unit-symbol">
      <SymbolImage sidc={s.symbol.sidc} standard={s.symbol.standard} size={size} alt={'رمز الوحدة: ' + s.symbol.description} />
      {withText && <small>{s.symbol.description}</small>}
    </span>
  );
}

/** What the symbols mean and what they do not mean. */
export function SymbolLegend() {
  const standard = approvedSymbolStandard();
  return (
    <details className="symbol-legend">
      <summary>مفتاح رموز الوحدات</summary>
      <ul>
        <li>رمز هوية ثابت للجهة وفق {standard ? STANDARD_LABEL[standard] ?? standard : 'المعيار الذي تعتمده المؤسسة (لم يُحدد بعد)'}، يُعرض بجوار اسمها العربي ولا يحل محله.</li>
        <li>الإطار المستطيل الأزرق: وحدة صديقة برية؛ الأيقونة داخله وظيفة الوحدة كما أسندها مسؤول مخول، لا تُستنتج من الاسم أو المستوى الإداري.</li>
        <li>
          <span className="unit-symbol generic inline" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="16" height="16">
              <rect x="3" y="6" width="18" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="3 2" />
            </svg>
          </span>{' '}
          علامة عامة: لم يحدد رمز الوحدة بعد.
        </li>
        <li>الإتاحة وحالات الطلبات تظهر في شارات ومفتاح الخريطة المنفصلين، ولا يُعاد تلوين الرمز لمعنى إداري.</li>
        <li>الرموز معلوماتية فقط: لا تمنح صلاحية ولا تمثل موقعاً أو حدوداً.</li>
      </ul>
    </details>
  );
}

/**
 * Assignment by a configuration administrator: from the approved catalog or a SIDC typed with a live preview checked
 * by the renderer; the server checks the shape again, records the standard, a reason and the version it replaces.
 */
export function SymbolAssignment({ orgId, orgName }: { orgId: string; orgName: string }) {
  const s = useOrgSymbol(orgId);
  const [catalog, setCatalog] = useState<{ code: string; sidc: string; name: string; standard: string; edition: string; active: boolean }[]>([]);
  const [mode, setMode] = useState<'CATALOG' | 'MANUAL'>('CATALOG');
  const [code, setCode] = useState('');
  const [sidc, setSidc] = useState('');
  const [description, setDescription] = useState('');
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<{ url: string; valid: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const key = useRef(newIdempotencyKey());
  const standard = approvedSymbolStandard();

  useEffect(() => {
    api
      .unitSymbolCatalog()
      .then((c) => setCatalog(c.filter((x) => x.active)))
      .catch(() => setCatalog([]));
  }, []);

  const chosenSidc = mode === 'CATALOG' ? catalog.find((c) => c.code === code)?.sidc ?? '' : sidc.trim();
  useEffect(() => {
    if (!/^[0-9]{20}([0-9]{10})?$/.test(chosenSidc)) return setPreview(null);
    let live = true;
    renderSymbol(chosenSidc, (standard ?? 'APP6').split('-')[0], 44)
      .then((r) => live && setPreview(r))
      .catch(() => live && setPreview(null));
    return () => {
      live = false;
    };
  }, [chosenSidc, standard]);

  const current: Symbol | null = s.state === 'set' ? s.symbol : null;
  const version = current?.version ?? 0;
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await api.assignUnitSymbol(orgId, {
        catalogCode: mode === 'CATALOG' ? code : undefined,
        sidc: mode === 'MANUAL' ? sidc.trim() : undefined,
        description: description.trim() || undefined,
        expectedVersion: version,
        reason,
      });
      invalidateSymbols([orgId]);
      setReason('');
      key.current = newIdempotencyKey();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    setError('');
    try {
      await api.removeUnitSymbol(orgId, { expectedVersion: version, reason });
      invalidateSymbols([orgId]);
      setReason('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="symbol-assignment" aria-label={'رمز الوحدة — ' + orgName}>
      <h3>رمز الوحدة (هوية معلوماتية)</h3>
      <p className="micro muted">
        المعيار المعتمد: {standard ? STANDARD_LABEL[standard] ?? standard : 'لم تحدده المؤسسة بعد — يُحدد في إعدادات النظام قبل الإسناد'} · العارض المحلي milsymbol
        3.0.4 (MIT). الإسناد إضافة محلية لا يغيّرها تحديث الموارد البشرية.
      </p>
      <div className="flex" style={{ gap: 12, alignItems: 'center' }}>
        <OrgSymbol orgId={orgId} size={44} withText />
        {current && <span className="micro muted">الإصدار {current.version} · {current.source === 'CATALOG' ? 'من الفهرس' : 'رمز مُدخل'}</span>}
      </div>
      <div className="segmented" role="radiogroup" aria-label="مصدر الرمز">
        <button role="radio" aria-checked={mode === 'CATALOG'} className={mode === 'CATALOG' ? 'active' : ''} onClick={() => setMode('CATALOG')}>
          من الفهرس المعتمد
        </button>
        <button role="radio" aria-checked={mode === 'MANUAL'} className={mode === 'MANUAL' ? 'active' : ''} onClick={() => setMode('MANUAL')}>
          إدخال رمز التعريف
        </button>
      </div>
      {mode === 'CATALOG' ? (
        <label className="field">
          <span>الرمز</span>
          <select value={code} onChange={(e) => setCode(e.target.value)}>
            <option value="">اختر…</option>
            {catalog.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </select>
          {!catalog.length && <small>الفهرس المعتمد فارغ؛ أدخل رمز التعريف مع وصفه.</small>}
        </label>
      ) : (
        <label className="field">
          <span>رمز التعريف (SIDC رقمي، 20 أو 30 رقماً)</span>
          <input dir="ltr" value={sidc} onChange={(e) => setSidc(e.target.value.replace(/\s/g, ''))} inputMode="numeric" maxLength={30} />
        </label>
      )}
      <label className="field">
        <span>الوصف العربي {mode === 'CATALOG' ? '— اختياري (يُستخدم اسم الفهرس)' : '— مطلوب'}</span>
        <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} />
      </label>
      {chosenSidc && (
        <div className="symbol-preview" role="status">
          {preview ? <img src={preview.url} alt="معاينة الرمز" /> : null}
          <span className={'micro ' + (preview?.valid ? 'ok' : 'bad')}>{preview?.valid ? 'العارض يعرف هذا الرمز' : 'رمز غير معروف للعارض أو غير مكتمل'}</span>
        </div>
      )}
      <label className="field">
        <span>سبب التغيير — مطلوب</span>
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
      </label>
      <div className="error-text" role="alert">
        {error}
      </div>
      <div className="flex">
        <button className="button primary compact" disabled={busy || !chosenSidc || (mode === 'MANUAL' && !preview?.valid)} onClick={save}>
          حفظ الرمز
        </button>
        {current && (
          <button className="button compact" disabled={busy} onClick={remove}>
            إزالة الرمز
          </button>
        )}
      </div>
    </section>
  );
}
