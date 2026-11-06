import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import type { Ref, SiteLinkRecord, StationingRecord } from '../../api/types';
import { useApp } from '../../lib/app';
import { fullDate } from '../../lib/dates';
import { FLOW_STEPS, type FlowStep, type UnitHere } from '../../lib/newRequestFlow';
import { familyOf, type RefSite } from '../../lib/sitesLayer';
import { SiteFamily } from './SiteInfoCard';
import { pathOf } from '../../lib/workspace';
import { Icon } from '../ui';

/** «1 الموقع الحالي، 2 الوحدات، … 6 الفحص والمراجعة»: compact, a step is clickable only once it may be opened. */
export function StepTracker({ step, done, canOpen, onOpen }: { step: FlowStep; done: boolean[]; canOpen: (s: FlowStep) => boolean; onOpen: (s: FlowStep) => void }) {
  return (
    <ol className="tz-flowtrack" aria-label="خطوات الطلب">
      {FLOW_STEPS.map((label, i) => {
        const s = (i + 1) as FlowStep;
        return (
          <li key={label} className={(s === step ? 'now ' : '') + (done[i] ? 'done' : '')}>
            <button disabled={!canOpen(s)} onClick={() => onOpen(s)} aria-current={s === step ? 'step' : undefined} aria-label={`الخطوة ${s}: ${label}`}>
              <span>{done[i] && s !== step ? '✓' : s}</span>
              <small>{label}</small>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

type Hit = { siteId: string; title: string; sub: string; onMap: boolean };

/**
 * «ابحث عن موقع أو وحدة…»: a second way to the map, never around it — a site or a stationed unit; choosing a result
 * picks its site on the map (the map flies to it and shows its card). A site the map cannot draw says so.
 */
export function SiteSearch({ sites, current, onPick }: { sites: RefSite[]; current: StationingRecord[]; onPick: (siteId: string) => void }) {
  const [q, setQ] = useState('');
  const hits = useMemo<Hit[]>(() => {
    const t = q.trim().toLowerCase();
    if (t.length < 2) return [];
    const onMap = new Map(sites.map((s) => [s.siteId, s.onMap]));
    const out: Hit[] = sites
      .filter((s) => [s.name, s.code].some((x) => x?.toLowerCase().includes(t)))
      .slice(0, 6)
      .map((s) => ({ siteId: s.siteId, title: s.name, sub: s.code, onMap: s.onMap }));
    for (const c of current) {
      if (out.length >= 10 || !c.orgName.toLowerCase().includes(t) || out.some((h) => h.siteId === c.siteId && h.sub.startsWith('وحدة'))) continue;
      out.push({ siteId: c.siteId, title: c.siteName, sub: 'وحدة متمركزة: ' + c.orgName, onMap: onMap.get(c.siteId) ?? false });
    }
    return out;
  }, [q, sites, current]);
  return (
    <div className="tz-flow-search">
      <div className="tz-site-search">
        <Icon name="search" />
        <input type="search" placeholder="ابحث عن موقع أو وحدة…" aria-label="ابحث عن موقع أو وحدة" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {q.trim().length >= 2 && (
        <ul className="tz-flow-hits" role="listbox" aria-label="نتائج البحث">
          {hits.length === 0 && <li className="tz-muted">لا نتائج ضمن ما تراه.</li>}
          {hits.map((h) => (
            <li key={h.siteId + h.sub}>
              <button role="option" onClick={() => (onPick(h.siteId), setQ(''))}>
                <b>{h.title}</b>
                <small>{h.sub}{h.onMap ? '' : ' · موقع غير معروض على الخريطة'}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The card of a site picked on the map in the first step: its name, responsible organisation, the units stationed there
 * (the register), the units linked to it, and the explicit «بدء طلب إعادة تمركز من هذا الموقع». A click alone starts
 * nothing.
 */
export function SitePickCard({ site, units, fromUnit, onStart, onClose }: { site: RefSite; units: UnitHere[]; fromUnit: string | null; onStart: () => void; onClose: () => void }) {
  const [links, setLinks] = useState<SiteLinkRecord[] | null>(null);
  useEffect(() => {
    setLinks(null);
    api.siteLinks(undefined, site.siteId).then(setLinks).catch(() => setLinks([]));
  }, [site.siteId]);
  return (
    <div className="tz-site-card tz-pick-card" role="dialog" aria-label={'الموقع «' + site.name + '»'} data-testid="site-pick">
      <div className="tz-site-card-head">
        <b>{site.name}</b>
        <button className="tz-site-card-close" aria-label="إغلاق" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <dl>
        <div>
          <dt>الجهة المسؤولة</dt>
          <dd>{site.responsibleOrg?.name ?? '—'}</dd>
        </div>
        <div>
          <dt>الوحدات المتمركزة حالياً</dt>
          <dd>
            {units.length === 0 ? 'لا وحدات متمركزة ظاهرة لك' : units.map((u) => u.orgName + (u.orgId === fromUnit ? ' (الوحدة التي بدأت منها)' : '')).join('، ')}
          </dd>
        </div>
        {links && links.length > 0 && (
          <div>
            <dt>الوحدات المرتبطة (ارتباط إداري)</dt>
            <dd>{links.map((l) => l.orgName).join('، ')}</dd>
          </div>
        )}
        {!site.onMap && (
          <div>
            <dt>الخريطة</dt>
            <dd>موقع غير معروض على الخريطة</dd>
          </div>
        )}
      </dl>
      <button className="button primary tz-start" disabled={units.length === 0} onClick={onStart}>
        بدء طلب إعادة تمركز من هذا الموقع
      </button>
      {units.length === 0 && <small className="tz-muted">لا يبدأ طلب من موقع بلا وحدات متمركزة ظاهرة لك.</small>}
    </div>
  );
}

/**
 * The right panel of a request being prepared: the current site, the units stationed there (who moves marked), each
 * moving unit inside its ancestry, and the unit the request comes from (derived, shown — not asked first).
 */
export function RequestContext({ site, units, moving, requesting, fromUnit, children, first, onChoose, stack = null, sites = [], onSelect }: {
  site: RefSite | null;
  units: UnitHere[];
  moving: string[];
  requesting: Ref | null;
  fromUnit: string | null;
  children?: React.ReactNode;
  /** Shown above the site and its units (the terrain analysis while the geometry is placed). */
  first?: React.ReactNode;
  /** Step 1: the site last clicked, not yet chosen; one clear «اختيار هذا الموقع» completes the step. */
  onChoose?: () => void;
  /** Step 1: the sites that share the clicked point (a main site and its sub-site); the person says which is meant. */
  stack?: RefSite[] | null;
  /** Step 1: every site, for the picked site's family («يتبع الموقع»، «المواقع التابعة»). */
  sites?: RefSite[];
  /** Step 1: another site picked from the family or the chooser. */
  onSelect?: (siteId: string) => void;
}) {
  const app = useApp();
  const tree = useMemo(() => app.orgs.map((o) => ({ id: o.id, name: o.name, code: o.code, parentId: o.parentId })), [app.orgs]);
  if (onChoose) return <PickContext site={site} units={units} fromUnit={fromUnit} onChoose={onChoose} stack={stack} sites={sites} onSelect={onSelect} />;
  return (
    <aside className="tz-context" aria-label="سياق الطلب">
      <div className="tz-context-body" data-testid="request-context">
        {first}
        <section className="tz-card" aria-label="الموقع">
          <h4>
            <i className="sw current" /> الموقع الحالي
          </h4>
          {site ? (
            <>
              <b className="tz-ctx-title">{site.name}</b>
              <p className="tz-muted">
                {[site.code, site.kind, site.responsibleOrg ? 'الجهة المسؤولة: ' + site.responsibleOrg.name : null].filter(Boolean).join(' · ')}
                {!site.onMap && ' · موقع غير معروض على الخريطة'}
              </p>
            </>
          ) : (
            <p className="tz-muted">لم يُختر بعد — اختر موقعاً من الخريطة.</p>
          )}
        </section>
        <section className="tz-card" aria-label="الوحدات المتمركزة" data-testid="units-here">
          <h4>
            <Icon name="units" /> الوحدات المتمركزة
          </h4>
          {!site && <p className="tz-muted">تظهر بعد اختيار الموقع.</p>}
          {site && units.length === 0 && <p className="tz-muted">لا وحدات متمركزة ظاهرة لك في هذا الموقع.</p>}
          <ul className="tz-sites">
            {units.map((u) => (
              <li key={u.orgId} className={moving.includes(u.orgId) ? 'moving' : ''}>
                <b>
                  {moving.includes(u.orgId) ? '✓ ' : ''}
                  {u.orgName}
                </b>
                <small>
                  {u.kind === 'TEMPORARY' ? 'مؤقت' : 'دائم'} · منذ {fullDate(u.since)}
                  {u.orgId === fromUnit ? ' · الوحدة التي بدأت منها' : ''}
                  {!u.requestable ? ' · خارج نطاق طلبك (يقرر الخادم)' : ''}
                </small>
              </li>
            ))}
          </ul>
        </section>
        <section className="tz-card" aria-label="الهيكل التنظيمي" data-testid="moving-hierarchy">
          <h4>
            <Icon name="tree" /> الهيكل التنظيمي
          </h4>
          {moving.length === 0 && <p className="tz-muted">يظهر موقع كل وحدة منتقلة في الهيكل بعد اختيارها.</p>}
          {moving.map((id) => {
            const path = pathOf(tree, id);
            const name = units.find((u) => u.orgId === id)?.orgName ?? path.at(-1)?.name ?? id;
            return (
              <p key={id} className="tz-path tz-unit-path">
                {(path.length ? path.slice(0, -1) : []).map((p) => p.name + ' ‹ ')}
                <b>{name}</b>
              </p>
            );
          })}
          {requesting && (
            <p className="tz-requesting">
              الوحدة الطالبة (يبدأ منها مسار الاعتماد): <b>{requesting.name}</b>
            </p>
          )}
        </section>
        {children}
      </div>
    </aside>
  );
}

/**
 * The right panel of step 1: before a click a quiet empty state; after a click on a site its context — the name, the
 * responsible organisation and the units stationed there — and ONE primary «اختيار هذا الموقع». A click alone starts
 * nothing.
 */
function PickContext({ site, units, fromUnit, onChoose, stack, sites, onSelect }: {
  site: RefSite | null;
  units: UnitHere[];
  fromUnit: string | null;
  onChoose: () => void;
  stack: RefSite[] | null;
  sites: RefSite[];
  onSelect?: (siteId: string) => void;
}) {
  if (stack && stack.length > 1) {
    // as the retired «مساحة التمركز»: several sites at the clicked point, the person chooses the one meant
    return (
      <aside className="tz-context" aria-label="عدة مواقع في هذا الموضع">
        <div className="tz-context-body" data-testid="request-context">
          <section className="tz-card" data-testid="site-stack">
            <h4>
              <i className="sw current" /> عدة مواقع في هذا الموضع
            </h4>
            <p className="tz-muted">اختر الموقع المقصود.</p>
            <ul className="tz-family tz-stack">
              {stack.map((s) => (
                <li key={s.siteId}>
                  <button className="tz-stack-item" onClick={() => onSelect?.(s.siteId)}>
                    <b>{s.name}</b>
                    <small>{s.parentId ? 'موقع فرعي' : 'موقع رئيسي'}{s.code ? ' · ' + s.code : ''}</small>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </aside>
    );
  }
  const family = site ? familyOf(sites, site.siteId) : null;
  return (
    <aside className="tz-context" aria-label="الموقع الحالي">
      <div className="tz-context-body" data-testid="request-context">
        {!site ? (
          <section className="tz-card tz-pick-empty" aria-label="الموقع الحالي">
            <h4>
              <i className="sw current" /> الموقع الحالي
            </h4>
            <b className="tz-ctx-title">لم يتم اختيار موقع بعد</b>
            <p className="tz-muted">اختر موقعاً من الخريطة لعرض الوحدات المتمركزة فيه.</p>
          </section>
        ) : (
          <section className="tz-card tz-pick-site" aria-label={'الموقع «' + site.name + '»'} data-testid="site-pick">
            <h4>
              <i className="sw current" /> الموقع الحالي
            </h4>
            <b className="tz-ctx-title">{site.name}</b>
            <dl className="tz-pick-facts">
              <div>
                <dt>الجهة المسؤولة</dt>
                <dd>{site.responsibleOrg?.name ?? '—'}</dd>
              </div>
              <div>
                <dt>الوحدات المتمركزة</dt>
                <dd>
                  {units.length === 0 ? (
                    'لا وحدات متمركزة ظاهرة لك'
                  ) : (
                    <ul>
                      {units.map((u) => (
                        <li key={u.orgId}>
                          {u.orgName}
                          {u.orgId === fromUnit ? ' (الوحدة التي بدأت منها)' : ''}
                        </li>
                      ))}
                    </ul>
                  )}
                </dd>
              </div>
              {!site.onMap && (
                <div>
                  <dt>الخريطة</dt>
                  <dd>موقع غير معروض على الخريطة</dd>
                </div>
              )}
              {family && <SiteFamily family={family} onSelect={onSelect} />}
            </dl>
            <button className="button primary tz-start" disabled={units.length === 0} onClick={onChoose}>
              اختيار هذا الموقع
            </button>
            {units.length === 0 && <small className="tz-muted">لا يبدأ طلب من موقع بلا وحدات متمركزة ظاهرة لك.</small>}
          </section>
        )}
      </div>
    </aside>
  );
}
