import { useEffect, useState } from 'react';
import { api, isAbort } from '../../api/client';
import type { MapFeature, OrgBranch } from '../../api/types';
import { OrgSymbol } from '../UnitSymbol';

type Kids = Record<string, OrgBranch[] | 'loading' | undefined>;

/**
 * «شجرة الجهات» of the stationing workspace: loaded one level at a time from the server (only what the actor may see),
 * with search across every permitted branch and the organisational level of each row. The selected organisation lists
 * its linked sites (responsible or using them) under it; organisational parentage and site links stay separate.
 */
export function StationOrgTree({
  selectedId,
  onSelect,
  sites,
  sitesLoading,
  selectedSiteId,
  onSite,
  revision,
}: {
  selectedId: string | null;
  onSelect: (org: { id: string; name: string } | null) => void;
  sites: MapFeature[];
  sitesLoading: boolean;
  selectedSiteId: string | null;
  onSite: (f: MapFeature) => void;
  revision: number;
}) {
  const [roots, setRoots] = useState<OrgBranch[] | null>(null);
  const [kids, setKids] = useState<Kids>({});
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<OrgBranch[] | null>(null);

  useEffect(() => {
    setKids({});
    api
      .orgRoots()
      .then((r) => {
        setRoots(r);
        setError(null);
        // open the first level so the structure is visible at once
        if (r.length === 1 && r[0].childCount) {
          setOpen(new Set([r[0].id]));
          void load(r[0].id);
        }
      })
      .catch((e: Error) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision]);

  useEffect(() => {
    if (q.trim().length < 2) return setHits(null);
    const ctl = new AbortController();
    const t = window.setTimeout(() => {
      api
        .orgSearch(q.trim(), ctl.signal)
        .then((r) => !ctl.signal.aborted && setHits(r))
        .catch((e) => !isAbort(e) && setError((e as Error).message));
    }, 250);
    return () => {
      window.clearTimeout(t);
      ctl.abort();
    };
  }, [q]);

  function load(id: string) {
    if (kids[id]) return Promise.resolve();
    setKids((k) => ({ ...k, [id]: 'loading' }));
    return api
      .orgChildren(id)
      .then((r) => setKids((k) => ({ ...k, [id]: r })))
      .catch((e: Error) => (setKids((k) => ({ ...k, [id]: undefined })), setError(e.message)));
  }

  const toggle = (id: string) => {
    const next = new Set(open);
    if (next.has(id)) next.delete(id);
    else {
      next.add(id);
      void load(id);
    }
    setOpen(next);
  };

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

  const siteRows = (o: OrgBranch) => (
    <ul className="stw-site-list" aria-label={'مواقع ' + o.name}>
      {sitesLoading && <li className="stw-note">جارٍ تحميل المواقع المرتبطة…</li>}
      {!sitesLoading && sites.length === 0 && <li className="stw-note">لا مواقع مسجلة مرتبطة بهذه الجهة.</li>}
      {sites.map((f) => (
        <li key={f.siteId}>
          <button className={'stw-site-row ' + (selectedSiteId === f.siteId ? 'active' : '')} onClick={() => onSite(f)}>
            <span className="stw-pin-ico" aria-hidden="true">⌖</span>
            <span>
              <b>{f.name}</b>
              <small>
                {f.parentId ? 'موقع فرعي' : 'موقع رئيسي'}
                {(f.relations ?? []).includes('RESPONSIBLE') ? ' · مسؤولة عنه' : ''}
                {(f.relations ?? []).includes('OCCUPANT') ? ' · تستخدمه في الفترة' : ''}
              </small>
            </span>
            <i className={'stw-dot ' + f.availability} title={f.availability === 'BUSY' ? 'محجوز' : 'متاح'} />
          </button>
        </li>
      ))}
    </ul>
  );

  const row = (o: OrgBranch, depth: number) => {
    const isOpen = open.has(o.id);
    const children = kids[o.id];
    const active = selectedId === o.id;
    return (
      <li key={o.id} role="treeitem" aria-expanded={o.childCount ? isOpen : undefined} aria-selected={active}>
        <div className={'stw-tree-row ' + (active ? 'active' : '')} style={{ paddingInlineStart: 4 + depth * 16 }}>
          {o.childCount > 0 ? (
            <button className="stw-toggle" onClick={() => toggle(o.id)} aria-label={(isOpen ? 'طي ' : 'فتح ') + o.name}>
              {isOpen ? '⌄' : '‹'}
            </button>
          ) : (
            <span className="stw-toggle" aria-hidden="true" />
          )}
          <button className="stw-tree-label" onClick={() => onSelect(active ? null : { id: o.id, name: o.name })} title={'المستوى ' + depth}>
            <span className="stw-org-ico">
              <OrgSymbol orgId={o.id} size={20} />
            </span>
            <b>{o.name}</b>
            <span className="stw-level" title="المستوى التنظيمي">م{depth}</span>
          </button>
          {(o.siteCount > 0 || o.childCount > 0) && (
            <span className="stw-count" title={o.siteCount + ' موقع مسؤولة عنه · ' + o.childCount + ' فرع'}>
              {o.siteCount || o.childCount}
            </span>
          )}
        </div>
        {active && siteRows(o)}
        {isOpen && (
          <ul role="group">
            {children === 'loading' && <li className="stw-note">جارٍ تحميل الفروع…</li>}
            {Array.isArray(children) && children.map((c) => row(c, depth + 1))}
          </ul>
        )}
      </li>
    );
  };

  return (
    <aside className="stw-tree" aria-label="شجرة الجهات">
      <h2>شجرة الجهات</h2>
      <label className="stw-search">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="البحث في الجهات …" aria-label="البحث في الجهات" />
      </label>
      {error && <p className="stw-note red">{error}</p>}
      {hits ? (
        <ul className="stw-hits">
          {hits.length === 0 && <li className="stw-note">لا نتائج ضمن الجهات المسموحة.</li>}
          {hits.map((h) => (
            <li key={h.id}>
              <button onClick={() => void reveal(h)}>
                <b>{h.name}</b>
                <small>{(h.path ?? []).map((p) => p.name).join(' ‹ ') || 'المستوى الأعلى'}</small>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="stw-tree-list" role="tree" aria-label="الجهات">
          {roots === null && !error && <li className="stw-note">جارٍ التحميل…</li>}
          {roots?.map((r) => row(r, 0))}
        </ul>
      )}
    </aside>
  );
}
