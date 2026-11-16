import { useEffect, useMemo, useRef, useState } from 'react';
import { api, isAbort } from '../../api/client';
import type { OrgBranch, Ref, SiteNode } from '../../api/types';
import { Icon } from '../ui';
import type { TreeSource } from '../tree/tree';
import { UnitTree } from '../tree/UnitTree';
import { OrgSymbol, SymbolLegend } from '../UnitSymbol';
import { RowActionsButton } from './SiteActionMenu';

type Loaded<T> = Record<string, T[] | 'loading' | undefined>;

/** Debounced, cancellable search: a later query supersedes an earlier one and its late answer is ignored. */
function useSearch<T>(q: string, run: (q: string, signal: AbortSignal) => Promise<T[]>, min = 2) {
  const [hits, setHits] = useState<T[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (q.trim().length < min) {
      setHits(null);
      setError(null);
      return;
    }
    const ctl = new AbortController();
    const t = window.setTimeout(() => {
      run(q.trim(), ctl.signal)
        .then((r) => !ctl.signal.aborted && (setHits(r), setError(null)))
        .catch((e) => !isAbort(e) && !ctl.signal.aborted && (setHits(null), setError((e as Error).message)));
    }, 250);
    return () => {
      window.clearTimeout(t);
      ctl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  return { hits, error };
}

function PathLine({ path }: { path?: Ref[] }) {
  if (!path?.length) return null;
  return <small className="tree-path">{path.map((p) => p.name).join(' ‹ ')}</small>;
}

/**
 * Organisation tree loaded one level at a time (no members, no people), with search across every branch the actor
 * may see. Selecting an organisation filters the map by responsibility and use; it never infers sites from names.
 * Drawn by the one units tree of the application (owner, 16 Nov 2026).
 */
export function OrgTree({
  selectedId,
  includeSub,
  onSelect,
  onIncludeSub,
  revision,
  subOption = true,
}: {
  selectedId: string | null;
  includeSub: boolean;
  onSelect: (org: { id: string; name: string } | null) => void;
  onIncludeSub: (v: boolean) => void;
  revision: number;
  subOption?: boolean;
}) {
  const source = useMemo<TreeSource<OrgBranch>>(
    () => ({
      roots: () => api.orgRoots(),
      children: (id) => api.orgChildren(id),
      search: (q, signal) =>
        api.orgSearch(q, signal).then((r) => r.map((o) => ({ item: o, path: (o.path ?? []).map((x) => x.name).join(' ‹ '), trail: (o.path ?? []).map((x) => x.id) }))),
    }),
    [],
  );
  return (
    <div className="browse-pane">
      <UnitTree
        source={source}
        label="شجرة الجهات"
        searchLabel="البحث في الجهات"
        search="ابحث عن جهة في كل الفروع المسموحة…"
        revision={revision}
        selected={selectedId}
        onSelect={(o) => onSelect(selectedId === o.id ? null : { id: o.id, name: o.name })}
        icon={(o) => <OrgSymbol orgId={o.id} size={18} />}
        meta={(o) => (o.siteCount ? o.siteCount + ' موقع' : null)}
      />
      {selectedId && subOption && (
        <label className="check-label tree-option">
          <input type="checkbox" checked={includeSub} onChange={(e) => onIncludeSub(e.target.checked)} />
          تشمل الفروع التابعة
        </label>
      )}
      <SymbolLegend />
    </div>
  );
}

/**
 * Site tree loaded per level: main sites (no parent) at the top, then their zones and sub-sites. Ancestors outside the
 * actor's scope appear only as greyed context; they cannot be selected and carry no location or bookings.
 */
export function SiteTree({
  selectedId,
  onSelect,
  onActions,
  menuSiteId,
  revision,
  revealPath,
}: {
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Opens the site's request menu beside the row (the map's own menu and command). */
  onActions?: (id: string, name: string, el: HTMLElement, keyboard: boolean) => void;
  menuSiteId?: string | null;
  revision: number;
  revealPath?: { ids: string[]; key: number } | null;
}) {
  const [roots, setRoots] = useState<SiteNode[] | null>(null);
  const [kids, setKids] = useState<Loaded<SiteNode>>({});
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const search = useSearch<SiteNode>(q, (v, s) => api.siteSearch(v, s), 1);
  const kidsRef = useRef(kids);
  kidsRef.current = kids;

  useEffect(() => {
    setKids({});
    api
      .siteTree()
      .then((r) => (setRoots(r), setError(null)))
      .catch((e: Error) => setError(e.message));
  }, [revision]);

  const load = (id: string) => {
    if (kidsRef.current[id]) return Promise.resolve();
    setKids((k) => ({ ...k, [id]: 'loading' }));
    return api
      .siteTree(id)
      .then((r) => setKids((k) => ({ ...k, [id]: r })))
      .catch((e: Error) => (setKids((k) => ({ ...k, [id]: undefined })), setError(e.message)));
  };

  // the map selected a site: open its parents so the tree shows the same selection
  useEffect(() => {
    if (!revealPath?.ids.length) return;
    (async () => {
      for (const id of revealPath.ids) await load(id);
      setOpen((o) => new Set([...o, ...revealPath.ids]));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealPath?.key]);

  const toggle = (id: string) => {
    const next = new Set(open);
    if (next.has(id)) next.delete(id);
    else {
      next.add(id);
      void load(id);
    }
    setOpen(next);
  };

  const row = (s: SiteNode, depth: number) => {
    const isOpen = open.has(s.id);
    const children = kids[s.id];
    const context = s.view === 'CONTEXT';
    return (
      <li key={s.id} role="treeitem" aria-expanded={s.childCount ? isOpen : undefined} aria-selected={selectedId === s.id}>
        <div className={'tree-row ' + (selectedId === s.id ? 'active ' : '') + (context ? 'context' : '')} style={{ paddingInlineStart: 6 + depth * 14 }}>
          {s.childCount > 0 ? (
            <button className="tree-toggle" onClick={() => toggle(s.id)} aria-label={(isOpen ? 'طي ' : 'فتح ') + s.name}>
              {isOpen ? '▾' : '◂'}
            </button>
          ) : (
            <span className="tree-toggle" aria-hidden="true">·</span>
          )}
          {context ? (
            <span className="tree-label" title="موقع أعلى خارج نطاقك؛ يظهر للتنقل فقط">
              <b>{s.name}</b>
              <small>سياق للتنقل فقط</small>
            </span>
          ) : (
            <button className="tree-label" onClick={() => onSelect(s.id)}>
              <b>
                <span className="latin">{s.code}</span> {s.name}
              </b>
              <small>
                {s.parentId ? 'منطقة/موقع فرعي' : 'موقع رئيسي'} · {s.hasBoundary ? 'حدود مسجلة' : 'حدود غير مسجلة'}
                {s.resourceCount ? ' · ' + s.resourceCount + ' مورد' : ''}
              </small>
            </button>
          )}
          {!context && onActions && (
            <RowActionsButton name={s.name} open={menuSiteId === s.id} onOpen={(el, kb) => onActions(s.id, s.name, el, kb)} />
          )}
        </div>
        {isOpen && (
          <ul role="group">
            {children === 'loading' && <li className="tree-note">جارٍ التحميل…</li>}
            {Array.isArray(children) && children.map((c) => row(c, depth + 1))}
          </ul>
        )}
      </li>
    );
  };

  return (
    <div className="browse-pane">
      <div className="search-box">
        <Icon name="search" />
        <input placeholder="ابحث باسم الموقع أو رمزه…" aria-label="البحث في المواقع" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {error && <div className="note red micro">{error}</div>}
      {search.hits ? (
        <ul className="tree" role="listbox" aria-label="نتائج البحث في المواقع">
          {search.hits.length === 0 && <li className="tree-note">لا نتائج ضمن نطاقك.</li>}
          {search.hits.map((s) => (
            <li key={s.id} role="option" aria-selected={selectedId === s.id}>
              <button
                className="tree-hit"
                onClick={() => {
                  setQ('');
                  onSelect(s.id);
                }}
              >
                <b>
                  <span className="latin">{s.code}</span> {s.name}
                </b>
                <PathLine path={s.path} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="tree" role="tree" aria-label="شجرة المواقع">
          {roots === null && !error && <li className="tree-note">جارٍ التحميل…</li>}
          {roots?.length === 0 && <li className="tree-note">لا مواقع ضمن نطاقك.</li>}
          {roots?.map((s) => row(s, 0))}
        </ul>
      )}
    </div>
  );
}
