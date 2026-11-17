import { useEffect, useMemo, useRef, useState } from 'react';
import { SITE_SYMBOLS, SYMBOL_CATEGORIES, rendererStandard, symbolEntry, symbolProblem, type SiteSymbol } from '../../lib/siteSymbols';
import { searchSymbols } from '../../lib/symbolSearch';
import { renderSymbol } from '../../lib/unitSymbols';
import { useApp } from '../../lib/app';
import { Icon } from '../ui';

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

const CATEGORY = Object.fromEntries(SYMBOL_CATEGORIES.map((c) => [c.key, c.label]));
// shown under «الأكثر استخداماً» until this person has chosen symbols of their own
const POPULAR = ['base', 'command_post', 'medical', 'field_hospital', 'logistics', 'signals', 'maintenance', 'transport', 'security', 'armor', 'infantry', 'engineer'];

/** This viewer's favourites, recent choices and use counts — a convenience kept in this browser only. */
function useSymbolMemory(userId: string) {
  const key = 'tmrkz-symbols:' + userId;
  const read = (): { fav: string[]; recent: string[]; uses: Record<string, number> } => {
    try {
      const v = JSON.parse(localStorage.getItem(key) ?? '{}');
      return { fav: Array.isArray(v.fav) ? v.fav : [], recent: Array.isArray(v.recent) ? v.recent : [], uses: v.uses && typeof v.uses === 'object' ? v.uses : {} };
    } catch {
      return { fav: [], recent: [], uses: {} };
    }
  };
  const [mem, setMem] = useState(read);
  const write = (next: typeof mem) => {
    setMem(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* private window: kept for this page only */
    }
  };
  return {
    mem,
    toggleFav: (k: string) => write({ ...mem, fav: mem.fav.includes(k) ? mem.fav.filter((x) => x !== k) : [k, ...mem.fav] }),
    used: (k: string) => write({ ...mem, recent: [k, ...mem.recent.filter((x) => x !== k)].slice(0, 12), uses: { ...mem.uses, [k]: (mem.uses[k] ?? 0) + 1 } }),
  };
}

type Tab = 'all' | 'popular' | 'fav' | 'recent';

/**
 * «رمز الموقع على الخريطة» (owner, 17 Nov 2026: "so the person knows that this is for a symbol"): a field that says what it is, with
 * a large preview, and a picker window — search by name (lib/symbolSearch.ts: normalised Arabic, synonyms, a typo forgiven),
 * «الأكثر استخداماً», «المفضلة», «الأخيرة», the categories, large tiles with the Arabic name. The code is never shown; a code typed
 * by hand is offered to a configuration administrator only. Display only: it changes no right and no rule.
 */
export function SiteSymbolPicker({ value, onChange }: { value: string | null; onChange: (sidc: string | null) => void }) {
  const app = useApp();
  const [open, setOpen] = useState(false);
  const entry = symbolEntry(value);
  return (
    <div className="sym-field" data-testid="symbol-field">
      <button type="button" className={'sym-preview' + (value ? '' : ' is-empty')} aria-label={value ? 'تغيير رمز الموقع على الخريطة' : 'اختيار رمز الموقع على الخريطة'} onClick={() => setOpen(true)}>
        {value ? <SymbolArt sidc={value} size={50} /> : <span className="sym-placeholder" aria-hidden="true"><Icon name="pin" /><b>+</b></span>}
      </button>
      <div className="sym-text">
        <b>{value ? entry?.label ?? 'رمز مخصص' : 'لم يُختر رمز بعد'}</b>
        <small>{value ? `${entry ? CATEGORY[entry.category] + ' · ' : ''}هكذا يظهر الموقع على الخريطة.` : 'الرمز الذي يظهر به الموقع على الخريطة. ابحث بالاسم: معسكر، طبي، دروع…'}</small>
        <span className="sym-actions">
          <button type="button" className="button compact" data-testid="symbol-choose" onClick={() => setOpen(true)}>{value ? 'تغيير الرمز' : 'اختيار رمز'}</button>
          {value && <button type="button" className="sw-link" data-act="symbol-clear" onClick={() => onChange(null)}>إزالة</button>}
        </span>
      </div>
      {open && <SymbolDialog value={value} userId={app.me.id} canCustom={app.can('CONFIGURE')} onClose={() => setOpen(false)} onPick={(s) => { onChange(s); setOpen(false); }} />}
    </div>
  );
}

function SymbolDialog({ value, userId, canCustom, onClose, onPick }: { value: string | null; userId: string; canCustom: boolean; onClose: () => void; onPick: (sidc: string | null) => void }) {
  const [q, setQ] = useState('');
  const [tab, setTab] = useState<Tab>('all');
  const [cat, setCat] = useState<string | null>(null);
  const [raw, setRaw] = useState('');
  const memory = useSymbolMemory(userId);
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    search.current?.focus();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);
  const byKey = useMemo(() => new Map(SITE_SYMBOLS.map((s) => [s.key, s])), []);
  const searching = q.trim().length > 0;
  const hits = useMemo(() => searchSymbols(q), [q]);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const h of hits) c[h.symbol.category] = (c[h.symbol.category] ?? 0) + 1;
    return c;
  }, [hits]);
  const popular = useMemo(() => {
    const own = Object.entries(memory.mem.uses).sort((a, b) => b[1] - a[1]).map(([k]) => k);
    return [...new Set([...own, ...POPULAR])].map((k) => byKey.get(k)).filter(Boolean).slice(0, 12) as SiteSymbol[];
  }, [memory.mem.uses, byKey]);
  const list: { symbol: SiteSymbol; via: string | null }[] = searching
    ? hits.filter((h) => !cat || h.symbol.category === cat)
    : tab === 'popular' ? popular.map((symbol) => ({ symbol, via: null }))
      : tab === 'fav' ? memory.mem.fav.map((k) => byKey.get(k)).filter(Boolean).map((symbol) => ({ symbol: symbol!, via: null }))
        : tab === 'recent' ? memory.mem.recent.map((k) => byKey.get(k)).filter(Boolean).map((symbol) => ({ symbol: symbol!, via: null }))
          : SITE_SYMBOLS.filter((s) => !cat || s.category === cat).map((symbol) => ({ symbol, via: null }));
  const pick = (s: SiteSymbol) => {
    memory.used(s.key);
    onPick(s.sidc);
  };
  const rawProblem = raw.trim() ? symbolProblem(raw) : '';
  const empty = !list.length ? (searching ? `لا رمز باسم «${q.trim()}». جرّب كلمة أخرى: طبي، دروع، قيادة، صيانة…` : tab === 'fav' ? 'لا رموز مفضلة بعد: اضغط ☆ على أي رمز.' : tab === 'recent' ? 'لم تختر رموزاً بعد.' : '') : '';
  return (
    <div className="sym-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sym-dialog" role="dialog" aria-modal="true" aria-label="اختيار رمز الموقع" data-testid="symbol-dialog">
        <header className="sym-head">
          <h3>اختيار رمز الموقع</h3>
          <button type="button" className="sym-x" aria-label="إغلاق" onClick={onClose}><Icon name="close" /></button>
        </header>
        <div className="sym-search">
          <Icon name="search" />
          <input ref={search} type="search" aria-label="ابحث عن رمز بالاسم" placeholder="ابحث عن رمز بالاسم… مثال: طبي، دروع، معسكر" value={q}
            onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && list[0] && pick(list[0].symbol)} />
          {searching && <span className="sym-count" data-testid="symbol-count">{list.length} رمزاً</span>}
        </div>
        {!searching && (
          <div className="sym-tabs" role="tablist" aria-label="عرض الرموز">
            {([['all', 'الكل'], ['popular', 'الأكثر استخداماً'], ['fav', 'المفضلة'], ['recent', 'الأخيرة']] as [Tab, string][]).map(([k, l]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} className={'sym-tab' + (tab === k ? ' on' : '')} data-tab={k} onClick={() => setTab(k)}>{l}</button>
            ))}
          </div>
        )}
        <div className="sym-body">
          {(searching || tab === 'all') && (
            <nav className="sym-cats" aria-label="التصنيفات">
              <b className="sym-cats-title">التصنيفات</b>
              <button type="button" className={'sym-cat' + (!cat ? ' on' : '')} onClick={() => setCat(null)}>الكل <small>{searching ? hits.length : SITE_SYMBOLS.length}</small></button>
              {SYMBOL_CATEGORIES.map((c) => {
                const n = searching ? counts[c.key] ?? 0 : SITE_SYMBOLS.filter((s) => s.category === c.key).length;
                return <button key={c.key} type="button" className={'sym-cat' + (cat === c.key ? ' on' : '')} data-cat={c.key} disabled={!n} onClick={() => setCat(c.key)}>{c.label} <small>{n}</small></button>;
              })}
            </nav>
          )}
          <div className="sym-grid" data-testid="symbol-grid">
            {list.map(({ symbol: s, via }) => (
              <div key={s.key} className={'sym-tile' + (value === s.sidc ? ' on' : '')}>
                <button type="button" className="sym-pick" data-symbol-pick={s.key} aria-pressed={value === s.sidc} onClick={() => pick(s)}>
                  <SymbolArt sidc={s.sidc} size={40} />
                  <b>{s.label}</b>
                  <small>{via ? `يطابق «${via}»` : CATEGORY[s.category]}</small>
                </button>
                <button type="button" className={'sym-star' + (memory.mem.fav.includes(s.key) ? ' on' : '')} aria-pressed={memory.mem.fav.includes(s.key)}
                  aria-label={(memory.mem.fav.includes(s.key) ? 'إزالة من المفضلة: ' : 'إضافة إلى المفضلة: ') + s.label} onClick={() => memory.toggleFav(s.key)}>
                  {memory.mem.fav.includes(s.key) ? '★' : '☆'}
                </button>
              </div>
            ))}
            {empty && <p className="sym-empty" data-testid="symbol-empty">{empty}</p>}
          </div>
        </div>
        <footer className="sym-foot">
          <button type="button" className="sw-link" onClick={() => onPick(null)}>بدون رمز</button>
          {canCustom && (
            <details className="sw-more">
              <summary>رمز آخر بالكود (لمدير النظام)</summary>
              <div className="sw-sub">
                <input className="sw-input" dir="ltr" aria-label="رمز مخصص" placeholder="SFGPIB----H----" value={raw} onChange={(e) => setRaw(e.target.value.toUpperCase())} />
                {rawProblem && <small className="sw-perr">{rawProblem}</small>}
                <button type="button" className="button" disabled={!raw.trim() || !!rawProblem} onClick={() => onPick(raw.trim())}>استخدام هذا الرمز</button>
              </div>
            </details>
          )}
          <small className="sw-hint">{SITE_SYMBOLS.length} رمزاً، للعرض على الخريطة فقط.</small>
        </footer>
      </div>
    </div>
  );
}
