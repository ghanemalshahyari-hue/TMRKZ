import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { isAbort } from '../../api/client';
import { Icon } from '../ui';
import { searchForest, type SearchNode, type TreeHit, type TreeItem, type TreeSource } from './tree';
import './unitTree.css';

type Props<T extends TreeItem> = {
  source: TreeSource<T>;
  /** The tree's name for assistive technology. */
  label: string;
  /** A refresh (a save, a sync): the top units and every open branch are read again; what is open stays open. */
  revision?: number;
  /** Select one: the chosen unit and what choosing it does. */
  selected?: string | null;
  onSelect?: (item: T) => void;
  /** Tick several: the ticked units and what ticking does. */
  checked?: ReadonlySet<string>;
  onCheck?: (item: T) => void;
  /** A unit that cannot be chosen or ticked, and why (shown on it). */
  disabled?: (item: T) => string | null | undefined;
  /** The ancestors (top first) of the unit to show: they are opened and the unit is brought into view. */
  trail?: string[];
  /** The unit brought into view with `trail` (default: the selected one). */
  reveal?: string | null;
  /** A single top unit opens by itself. */
  openSingleRoot?: boolean;
  /** Units open at the first drawing (e.g. a short list shown whole). */
  initialOpen?: string[];
  /** Placeholder of the tree's own search; false hides it. */
  search?: string | false;
  searchLabel?: string;
  minSearch?: number;
  /** Changing it closes every branch («طي الكل»). */
  collapseKey?: number;
  icon?: (item: T) => ReactNode;
  tags?: (item: T) => ReactNode;
  meta?: (item: T) => ReactNode;
  rowClass?: (item: T) => string | undefined;
  /** A data attribute put on each checkbox (as data-<name>="<id>"), for pages whose checks are addressed by it. */
  checkData?: string;
  empty?: ReactNode;
  testId?: string;
  className?: string;
};

/**
 * The one units tree of the application (owner, 16 Nov 2026), drawn as the access workspace's: one compact row per unit
 * (indented, never nested cards), «+ / −» to open a level (children read when first opened), the chosen unit marked, long
 * names cut with the full name on hover, an optional search that shows each result with its path and opens the tree down
 * to it, and the arrow keys (up/down to move, towards the children to open, away to close). Every page that shows the
 * organisation hierarchy uses it with its own source and what choosing does.
 */
export function UnitTree<T extends TreeItem>(p: Props<T>) {
  const [roots, setRoots] = useState<T[] | null>(null);
  const [kids, setKids] = useState<Record<string, T[] | 'loading'>>({});
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<TreeHit<T>[] | null>(null);
  // a search shows its results as a hierarchy (owner, 17 Nov 2026): a branch the person asks to see whole is drawn as the tree
  const [whole, setWhole] = useState<Set<string>>(new Set());
  const openRef = useRef(open);
  openRef.current = open;
  const kidsRef = useRef(kids);
  kidsRef.current = kids;
  const first = useRef(true);
  const box = useRef<HTMLDivElement | null>(null);
  const shown = useRef<string | null>(null);
  const src = useRef(p.source);
  src.current = p.source;

  // the top units, and on a refresh every open branch again (its counts may have changed)
  useEffect(() => {
    let live = true;
    p.source
      .roots()
      .then(async (r) => {
        if (!live) return;
        setRoots(r);
        setError(null);
        const ids = new Set(openRef.current);
        if (first.current && p.openSingleRoot && r.length === 1 && r[0].childCount) ids.add(r[0].id);
        if (first.current) for (const id of p.initialOpen ?? []) ids.add(id);
        first.current = false;
        const loaded = await Promise.all([...ids].map((id) => p.source.children(id).then((c) => [id, c] as const).catch(() => null)));
        if (!live) return;
        const next: Record<string, T[]> = {};
        for (const x of loaded) if (x) next[x[0]] = x[1];
        setKids(next);
        setOpen(new Set(Object.keys(next)));
      })
      .catch((e: Error) => live && (setRoots([]), setError(e.message)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.revision, p.source]);

  useEffect(() => {
    if (p.collapseKey) setOpen(new Set());
  }, [p.collapseKey]);

  const load = async (id: string) => {
    if (kidsRef.current[id]) return;
    setKids((k) => ({ ...k, [id]: 'loading' }));
    try {
      const c = await src.current.children(id);
      setKids((k) => ({ ...k, [id]: c }));
    } catch (e) {
      setKids((k) => {
        const n = { ...k };
        delete n[id];
        return n;
      });
      setError((e as Error).message);
    }
  };
  const openAll = async (ids: string[]) => {
    for (const id of ids) await load(id);
    setOpen((o) => new Set([...o, ...ids]));
  };
  const toggle = (id: string, to?: boolean) => {
    const isOpen = openRef.current.has(id);
    if (to === isOpen) return;
    if (isOpen) {
      setOpen((o) => {
        const n = new Set(o);
        n.delete(id);
        return n;
      });
    } else {
      void load(id);
      setOpen((o) => new Set([...o, id]));
    }
  };

  // the unit to show: its ancestors opened, then it is brought into view once
  const target = p.reveal ?? p.selected ?? null;
  const trailKey = p.trail?.join() ?? '';
  useEffect(() => {
    if (!target || !p.trail?.length) return;
    let live = true;
    (async () => {
      for (const id of p.trail!) {
        if (!live) return;
        await load(id);
      }
      if (live) setOpen((o) => new Set([...o, ...p.trail!]));
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, trailKey]);
  useEffect(() => {
    if (!target || shown.current === target) return;
    const el = box.current?.querySelector<HTMLElement>(`[data-node="${CSS.escape(target)}"]`);
    if (!el) return;
    shown.current = target;
    el.scrollIntoView({ block: 'nearest' });
  }, [target, kids, open, roots]);

  // the tree's own search
  const min = p.minSearch ?? 2;
  useEffect(() => {
    if (!p.source.search || q.trim().length < min) return setHits(null);
    const ctl = new AbortController();
    const t = window.setTimeout(() => {
      p.source.search!(q.trim(), ctl.signal)
        .then((r) => !ctl.signal.aborted && setHits(r))
        .catch((e) => !isAbort(e) && !ctl.signal.aborted && setHits([]));
    }, 250);
    return () => {
      window.clearTimeout(t);
      ctl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, p.source]);
  useEffect(() => setWhole(new Set()), [hits]);
  const pickHit = async (h: TreeHit<T>) => {
    if (p.onCheck) return p.onCheck(h.item);
    if (h.trail?.length) await openAll(h.trail);
    setQ('');
    shown.current = null;
    p.onSelect?.(h.item);
  };

  // arrow keys between the visible rows; «towards the children» is left in a right-to-left page
  const onKey = (item: T) => (e: KeyboardEvent<HTMLElement>) => {
    const rows = [...(box.current?.querySelectorAll<HTMLElement>('.ut-nodes .ut-focus') ?? [])];
    const i = rows.indexOf(e.currentTarget as HTMLElement);
    const rtl = box.current ? getComputedStyle(box.current).direction === 'rtl' : true;
    const inward = rtl ? 'ArrowLeft' : 'ArrowRight';
    const outward = rtl ? 'ArrowRight' : 'ArrowLeft';
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      rows[Math.min(rows.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
    } else if (e.key === inward && item.childCount) {
      e.preventDefault();
      toggle(item.id, true);
    } else if (e.key === outward) {
      e.preventDefault();
      if (openRef.current.has(item.id)) toggle(item.id, false);
      else (e.currentTarget.closest('ul[role=group]')?.closest('li')?.querySelector('.ut-focus') as HTMLElement | null)?.focus();
    }
  };

  const row = (item: T, depth: number): ReactNode => {
    const isOpen = open.has(item.id);
    const children = kids[item.id];
    const why = p.disabled?.(item) ?? null;
    const isChecked = !!p.checked?.has(item.id);
    const on = p.selected === item.id;
    const extra = p.rowClass?.(item);
    return (
      <li key={item.id} role="treeitem" aria-level={depth + 1} aria-expanded={item.childCount ? isOpen : undefined}
        aria-selected={p.onCheck ? isChecked : on} data-unit={item.id} className={extra}>
        <div className={'ut-row tree-row' + (on ? ' on active' : '') + (why ? ' off' : '')} data-node={item.id} style={{ paddingInlineStart: 4 + depth * 16 }}>
          {item.childCount ? (
            <button type="button" className="ut-twist" tabIndex={-1} aria-label={(isOpen ? 'طي ' : 'فتح ') + item.name} onClick={() => toggle(item.id)}>
              {isOpen ? '−' : '+'}
            </button>
          ) : (
            <span className="ut-twist ut-leaf" aria-hidden="true">·</span>
          )}
          {p.onCheck ? (
            <label className="ut-check" title={why ?? item.name}>
              <input type="checkbox" className="ut-focus" checked={isChecked} disabled={!!why && !isChecked} onChange={() => p.onCheck!(item)} onKeyDown={onKey(item)}
                {...(p.checkData ? { ['data-' + p.checkData]: item.id } : {})} />
              {p.icon?.(item)}
              <span className="ut-name tree-label">{item.name}</span>
            </label>
          ) : (
            <button type="button" className="ut-name ut-focus tree-label" title={why ?? item.name} aria-current={on || undefined}
              onClick={() => !why && p.onSelect?.(item)} onKeyDown={onKey(item)}>
              {p.icon?.(item)}
              <span>{item.name}</span>
            </button>
          )}
          {p.tags?.(item)}
          {p.meta && <span className="ut-meta">{p.meta(item)}</span>}
        </div>
        {isOpen && (
          <ul role="group">
            {children === 'loading' && <li className="ut-note">جارٍ التحميل…</li>}
            {Array.isArray(children) && children.map((c) => row(c, depth + 1))}
          </ul>
        )}
      </li>
    );
  };

  /**
   * A search drawn as a hierarchy: every result under its whole chain of ancestors, top first; each row chosen as in the tree;
   * «+» on any row shows that branch whole (the ordinary tree under it). A result is marked «مطابق».
   */
  const foundRow = (n: SearchNode<T>, depth: number): ReactNode => {
    const item = n.item ?? ({ id: n.id, name: n.name, childCount: 1 } as T);
    if (whole.has(n.id)) return row(item, depth);
    const why = p.disabled?.(item) ?? null;
    const isChecked = !!p.checked?.has(n.id);
    const on = p.selected === n.id;
    const showWhole = () => {
      void load(n.id);
      setOpen((o) => new Set([...o, n.id]));
      setWhole((w) => new Set([...w, n.id]));
    };
    const choose = () => (p.onCheck ? p.onCheck(item) : pickHit({ item, path: '', trail: n.trail }));
    return (
      <li key={n.id} role="treeitem" aria-level={depth + 1} aria-expanded={n.kids.length > 0 || undefined} aria-selected={p.onCheck ? isChecked : on} data-unit={n.id}>
        <div className={'ut-row tree-row' + (n.item ? ' ut-match' : ' ut-path') + (on ? ' on active' : '') + (why ? ' off' : '')} data-node={n.id} style={{ paddingInlineStart: 4 + depth * 16 }}>
          <button type="button" className="ut-twist" tabIndex={-1} title="عرض كل فروعها" aria-label={'عرض كل فروع ' + n.name} onClick={showWhole}>+</button>
          {p.onCheck ? (
            <label className="ut-check" title={why ?? n.name}>
              <input type="checkbox" className="ut-focus" checked={isChecked} disabled={!!why && !isChecked} onChange={choose} {...(p.checkData ? { ['data-' + p.checkData]: n.id } : {})} />
              {n.item && p.icon?.(item)}
              <span className="ut-name tree-label">{n.name}</span>
            </label>
          ) : (
            <button type="button" className="ut-name ut-focus tree-label" data-found={n.item ? 'match' : 'ancestor'} title={why ?? n.name} disabled={!!why} onClick={choose}>
              {n.item && p.icon?.(item)}
              <span>{n.name}</span>
            </button>
          )}
          {n.item && <span className="ut-matchtag">مطابق</span>}
        </div>
        {n.kids.length > 0 && <ul role="group">{n.kids.map((k) => foundRow(k, depth + 1))}</ul>}
      </li>
    );
  };

  return (
    <div className={'ut' + (p.className ? ' ' + p.className : '')} ref={box} data-testid={p.testId}>
      {p.search !== false && p.source.search && (
        <label className="ut-search">
          <Icon name="search" />
          <input type="search" aria-label={p.searchLabel ?? 'بحث في الوحدات'} placeholder={p.search ?? 'ابحث عن وحدة بالاسم…'} value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
      )}
      {error && <div className="ut-error" role="alert">{error}</div>}
      {hits ? (
        <ul className="ut-nodes tree ut-found" role="tree" aria-label={'نتائج البحث — ' + p.label} data-testid="tree-search-results">
          {hits.length === 0 && <li className="ut-note">لا نتائج ضمن نطاقك.</li>}
          {hits.length > 0 && <li className="ut-note ut-found-note">{hits.length === 1 ? 'نتيجة واحدة' : hits.length + ' نتائج'} في مكانها من الهيكل: اختر الوحدة نفسها، أو أعلى منها، أو افتح فروعها.</li>}
          {searchForest(hits).map((n) => foundRow(n, 0))}
        </ul>
      ) : (
        <ul className="ut-nodes tree" role="tree" aria-label={p.label}>
          {roots === null && !error && <li className="ut-note">جارٍ التحميل…</li>}
          {roots?.length === 0 && !error && <li className="ut-note">{p.empty ?? 'لا وحدات ضمن نطاقك.'}</li>}
          {roots?.map((r) => row(r, 0))}
        </ul>
      )}
    </div>
  );
}
