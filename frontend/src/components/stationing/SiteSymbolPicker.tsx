import { useEffect, useState } from 'react';
import { SITE_SYMBOLS, SYMBOL_CATEGORIES, rendererStandard, searchSymbols, symbolEntry, symbolProblem } from '../../lib/siteSymbols';
import { renderSymbol } from '../../lib/unitSymbols';

/** A symbol drawn offline by the bundled milsymbol; nothing when the code cannot be drawn. */
export function SymbolArt({ sidc, size = 34 }: { sidc: string; size?: number }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    renderSymbol(sidc, rendererStandard(sidc), size)
      .then((r) => alive && setUrl(r.valid ? r.url : null))
      .catch(() => alive && setUrl(null));
    return () => {
      alive = false;
    };
  }, [sidc, size]);
  return url ? <img className="sw-symart" src={url} alt="" /> : <span className="sw-symart none" aria-hidden="true">●</span>;
}

/**
 * «رمز يظهر على الخريطة (اختياري)», as in MOVER: the symbol cards by category with a search, «بدون رمز», and a code typed by
 * hand («رمز آخر») checked by the same rule as the server. Display only: it changes no right and no rule.
 */
export function SiteSymbolPicker({ value, onChange }: { value: string | null; onChange: (sidc: string | null) => void }) {
  const [q, setQ] = useState('');
  const [raw, setRaw] = useState('');
  const hits = searchSymbols(q);
  const entry = symbolEntry(value);
  const rawProblem = raw.trim() ? symbolProblem(raw) : '';
  return (
    <div className="sw-symbols" data-testid="symbol-picker">
      <div className={'sw-symnow' + (value ? '' : ' none')} data-symbol={value ?? ''}>
        {value ? <SymbolArt sidc={value} size={44} /> : <span className="sw-symart none" aria-hidden="true">●</span>}
        <span><b>{value ? entry?.label ?? 'رمز مخصص' : 'بدون رمز'}</b><small>{value ? 'هكذا يظهر الموقع على الخريطة.' : 'يظهر بعلامة الموقع العادية.'}</small></span>
        {value && <button type="button" className="sw-link" data-act="symbol-clear" onClick={() => onChange(null)}>بدون رمز</button>}
      </div>
      <input className="sw-input" type="search" aria-label="بحث عن رمز" placeholder="ابحث: معسكر، قيادة، طبابة…" value={q} onChange={(e) => setQ(e.target.value)} />
      {SYMBOL_CATEGORIES.map((c) => {
        const list = hits.filter((s) => s.category === c.key);
        if (!list.length) return null;
        return (
          <div key={c.key} className="sw-symcat">
            <small className="sw-hint">{c.label}</small>
            <div className="sw-symgrid">
              {list.map((s) => (
                <button key={s.key} type="button" className={'sw-sym' + (value === s.sidc ? ' on' : '')} aria-pressed={value === s.sidc} data-symbol-pick={s.key} title={s.label} onClick={() => onChange(s.sidc)}>
                  <SymbolArt sidc={s.sidc} />
                  <span>{s.label}</span>
                </button>
              ))}
            </div>
          </div>
        );
      })}
      {hits.length === 0 && <p className="sw-hint">لا رمز بهذا الاسم.</p>}
      <details className="sw-more">
        <summary>رمز آخر (متقدم)</summary>
        <div className="sw-sub">
          <input className="sw-input" dir="ltr" aria-label="رمز مخصص" placeholder="SFGPIB----H---- أو 10031000001211000000" value={raw} onChange={(e) => setRaw(e.target.value.toUpperCase())} />
          {rawProblem && <small className="sw-perr">{rawProblem}</small>}
          <button type="button" className="button" disabled={!raw.trim() || !!rawProblem} onClick={() => onChange(raw.trim())}>استخدام هذا الرمز</button>
        </div>
      </details>
      <small className="sw-hint">اختياري، للعرض على الخريطة فقط؛ لا يغيّر الصلاحيات ولا أي قاعدة. {SITE_SYMBOLS.length} رمزاً بمعيار MIL-STD-2525C المتوافق مع APP-6.</small>
    </div>
  );
}
