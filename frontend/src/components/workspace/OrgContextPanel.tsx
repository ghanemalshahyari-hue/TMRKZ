import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '../../api/client';
import type { RestationingRequest, RestationingUnit } from '../../api/types';
import { useApp, type View } from '../../lib/app';
import { restriction } from '../../lib/navigation';
import { pathOf, type TreeUnit } from '../../lib/workspace';
import { flatSource } from '../tree/tree';
import { UnitTree } from '../tree/UnitTree';
import { Icon } from '../ui';
import { LinkedSitesPanel } from './LinkedSitesPanel';

export type ContextTab = 'request' | 'units' | 'sites';

/**
 * The organisation units the panel may show: the tree the server already returned to this person (organisations
 * `tree`, scoped by their rights), or else the units they may request for (`/restationing-requests/units`), or else
 * the units named by the request itself. Never a hard-coded hierarchy.
 */
function useUnits(request: RestationingRequest | null): { units: TreeUnit[]; source: string } {
  const app = useApp();
  const [requestable, setRequestable] = useState<RestationingUnit[] | null>(null);
  const { can } = app;
  const haveTree = app.orgs.length > 0;
  useEffect(() => {
    if (haveTree || !can('CREATE_RESTATIONING')) return;
    api.restationingUnits().then(setRequestable).catch(() => setRequestable([]));
  }, [haveTree, can]);
  return useMemo(() => {
    if (app.orgs.length) return { units: app.orgs.map((o) => ({ id: o.id, name: o.name, code: o.code, parentId: o.parentId })), source: 'الهيكل التنظيمي (الموارد البشرية)' };
    if (requestable?.length) return { units: requestable.map((u) => ({ id: u.id, name: u.name, code: u.code, parentId: u.parentId })), source: 'الوحدات التي يمكنك الطلب لها' };
    if (request) {
      const seen = new Map<string, TreeUnit>();
      seen.set(request.requestingUnit.id, { id: request.requestingUnit.id, name: request.requestingUnit.name, parentId: null });
      for (const u of request.units) if (!seen.has(u.id)) seen.set(u.id, { id: u.id, name: u.name, parentId: request.requestingUnit.id });
      return { units: [...seen.values()], source: 'وحدات الطلب' };
    }
    return { units: [], source: '' };
  }, [app.orgs, requestable, request]);
}

/**
 * The right context panel (§12–§14): the request's details, the organisation hierarchy (from the server's own tree,
 * the requesting unit highlighted and its branch open), the sites linked to the chosen unit, and quick links that
 * appear only with the matching right.
 */
export function OrgContextPanel({ request, tab, setTab, requestContent, unitId, setUnitId }: {
  request: RestationingRequest | null;
  tab: ContextTab;
  setTab: (t: ContextTab) => void;
  requestContent: ReactNode;
  unitId: string | null;
  setUnitId: (id: string) => void;
}) {
  const app = useApp();
  const { units, source } = useUnits(request);
  const requesting = request?.requestingUnit.id ?? app.me.primaryOrg?.id ?? null;
  // the one units tree of the application (owner, 16 Nov 2026): the requesting unit's branch open, as before
  const tree = useMemo(() => flatSource(units), [units]);
  const moving = useMemo(() => new Set(request?.content.scope ?? []), [request]);
  const path = pathOf(units, unitId ?? requesting);
  const links: { view: View; label: string; icon: string }[] = [
    { view: 'permissions', label: 'الصلاحيات', icon: 'shield' },
    { view: 'audit', label: 'سجل التدقيق', icon: 'clock' },
    { view: 'stationing', label: 'تفاصيل الموقع', icon: 'pin' },
    { view: 'org', label: 'تفاصيل الوحدة', icon: 'tree' },
  ];
  const quick = links.filter((l) => !restriction(l.view, app.can, app.summaryOnly));

  return (
    <aside className="tz-context" aria-label="سياق الطلب والوحدات">
      <div className="tz-tabs" role="tablist">
        {request && (
          <button role="tab" aria-selected={tab === 'request'} className={'tz-tab' + (tab === 'request' ? ' active' : '')} onClick={() => setTab('request')}>
            <Icon name="file" /> الطلب
          </button>
        )}
        <button role="tab" aria-selected={tab === 'units'} className={'tz-tab' + (tab === 'units' ? ' active' : '')} onClick={() => setTab('units')}>
          <Icon name="units" /> الوحدات التابعة
        </button>
        <button role="tab" aria-selected={tab === 'sites'} className={'tz-tab' + (tab === 'sites' ? ' active' : '')} onClick={() => setTab('sites')}>
          <Icon name="link" /> المواقع المرتبطة
        </button>
      </div>
      <div className="tz-context-body">
        {tab === 'request' && request && requestContent}
        {tab === 'units' && (
          <section className="tz-card tz-tree" aria-label="الهيكل التنظيمي" data-testid="org-tree">
            <div className="tz-card-head">
              <h3>الهيكل التنظيمي</h3>
              <small className="tz-muted">{source}</small>
            </div>
            <UnitTree
              source={tree}
              label="الهيكل التنظيمي"
              search={false}
              selected={unitId}
              reveal={requesting}
              trail={tree.trail(requesting)}
              openSingleRoot
              onSelect={(u) => setUnitId(u.id)}
              rowClass={(u) => (u.id === requesting ? 'requesting' : moving.has(u.id) ? 'moving' : undefined)}
              icon={(u) => <Icon name={u.childCount ? 'folder' : 'units'} />}
              tags={(u) => (u.id === requesting ? <em className="ut-tag">الطالبة</em> : moving.has(u.id) ? <em className="ut-tag moving">منتقلة</em> : null)}
              empty="لا وحدات ضمن نطاقك."
            />
          </section>
        )}
        {tab === 'sites' && (
          <>
            {path.length > 0 && (
              <p className="tz-path">
                {path.map((p, i) => (
                  <span key={p.id}>
                    {i > 0 && ' ‹ '}
                    {p.name}
                  </span>
                ))}
              </p>
            )}
            <LinkedSitesPanel unitId={unitId ?? requesting} unitName={path.at(-1)?.name ?? request?.requestingUnit.name ?? ''} request={request} />
          </>
        )}
      </div>
      {quick.length > 0 && (
        <div className="tz-quick" aria-label="روابط سريعة">
          {quick.map((l) => (
            <a key={l.view} className="tz-quick-link" href={'#' + l.view}>
              <Icon name={l.icon} />
              <span>{l.label}</span>
            </a>
          ))}
        </div>
      )}
    </aside>
  );
}
