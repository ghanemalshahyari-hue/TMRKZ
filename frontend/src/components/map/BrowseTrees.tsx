import { useEffect, useRef, useState } from 'react';
import { api, isAbort } from '../../api/client';
import type { OrgBranch, Ref, SiteNode } from '../../api/types';
import { Icon } from '../ui';

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
 */
export function OrgTree({
  selectedId,
  includeSub,
  onSelect,
  onIncludeSub,
  revision,
}: {
  selectedId: string | null;
  includeSub: boolean;
  onSelect: (org: { id: string; name: string } | null) => void;
  onIncludeSub: (v: boolean) => void;
  revision: number;
}) {
  const [roots, setRoots] = useState<OrgBranch[] | null>(null);
  const [kids, setKids] = useState<Loaded<OrgBranch>>({});
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const search = useSearch<OrgBranch>(q, (v, s) => api.orgSearch(v, s));

  useEffect(() => {
    setKids({});
    api
      .orgRoots()
      .then((r) => (setRoots(r), setError(null)))
      .catch((e: Error) => setError(e.message));
  }, [revision]);

  const load = (id: string) => {
    if (kids[id]) return Promise.resolve();
    setKids((k) => ({ ...k, [id]: 'loading' }));
    return api
      .orgChildren(id)
      .then((r) => setKids((k) => ({ ...k, [id]: r })))
      .catch((e: Error) => (setKids((k) => ({ ...k, [id]: undefined })), setError(e.message)));
  };
  const toggle = (id: string) => {
    const next = new Set(open);
    if (next.has(id)) next.delete(id);
    else {
      next.add(id);
      void load(id);
    }
    setOpen(next);
  };
  /** Search result: open its path so the tree shows where it is, then select it. */
  const reveal = async (o: OrgBranch) => {
    const next = new Set(open);
    for (const p of o.path ?? []) {
      next.add(p.id);
      await load(p.id);
    }
    setOpen(next);
    setQ('');
    onSelect({ id: o.id, name: o.name });
  };

  const row = (o: OrgBranch, depth: number) => {
    const isOpen = open.has(o.id);
    const children = kids[o.id];
    return (
      <li key={o.id} role="treeitem" aria-expanded={o.childCount ? isOpen : undefined} aria-selected={selectedId === o.id}>
        <div className={'tree-row ' + (selectedId === o.id ? 'active' : '')} style={{ paddingInlineStart: 6 + depth * 14 }}>
          {o.childCount > 0 ? (
            <button className="tree-toggle" onClick={() => toggle(o.id)} aria-label={(isOpen ? 'طي ' : 'فتح ') + o.name}>
              {isOpen ? '▾' : '◂'}
            </button>
          ) : (
            <span className="tree-toggle" aria-hidden="true">·</span>
          )}
          <button className="tree-label" onClick={() => onSelect(selectedId === o.id ? null : { id: o.id, name: o.name })}>
            <b>{o.name}</b>
            <small>
              {o.siteCount ? o.siteCount + ' موقع مسؤولة عنه' : 'لا مواقع مسؤولة عنها مباشرة'}
              {o.childCount ? ' · ' + o.childCount + ' فرع' : ''}
            </small>
          </button>
        </div>
        {isOpen && (
          <ul role="group">
            {children === 'loading' && <li className="tree-note">جارٍ تحميل الفروع…</li>}
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
        <input placeholder="ابحث عن جهة في كل الفروع المسموحة…" aria-label="البحث في الجهات" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {selectedId && (
        <label className="check-label tree-option">
          <input type="checkbox" checked={includeSub} onChange={(e) => onIncludeSub(e.target.checked)} />
          تشمل الفروع التابعة
        </label>
      )}
      {error && <div className="note red micro">{error}</div>}
      {search.hits ? (
        <ul className="tree" role="listbox" aria-label="نتائج البحث في الجهات">
          {search.hits.length === 0 && <li className="tree-note">لا نتائج ضمن نطاقك.</li>}
          {search.hits.map((o) => (
            <li key={o.id} role="option" aria-selected={selectedId === o.id}>
              <button className="tree-hit" onClick={() => reveal(o)}>
                <b>{o.name}</b>
                <PathLine path={o.path} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="tree" role="tree" aria-label="شجرة الجهات">
          {roots === null && !error && <li className="tree-note">جارٍ التحميل…</li>}
          {roots?.map((o) => row(o, 0))}
        </ul>
      )}
      {search.error && <div className="note red micro">{search.error}</div>}
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
  revision,
  revealPath,
}: {
  selectedId: string | null;
  onSelect: (id: string) => void;
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
