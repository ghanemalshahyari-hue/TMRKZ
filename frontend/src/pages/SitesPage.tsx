import { useEffect, useMemo, useState } from 'react';
import { api, type SiteOccupants } from '../api/client';
import type { MapFeature, SiteDetail, SiteGeometry, SiteLinkRecord, StationingRecord } from '../api/types';
import { Icon } from '../components/ui';
import type { BasemapMode } from '../components/map/maplibre/offlineStyle';
import { MapFrame } from '../components/workspace/MapFrame';
import { OperationalWorkspace } from '../components/workspace/OperationalWorkspace';
import { SitesMap } from '../components/workspace/SitesMap';
import { useRegisteredSites } from '../components/workspace/useRegisteredSites';
import { useApp } from '../lib/app';
import { fullDate } from '../lib/dates';
import { formatArea } from '../lib/footprint';
import { newRequestFromSiteHash } from '../lib/restationingRoute';
import { partsOf, siteArea } from '../lib/siteGeometry';
import { registeredSites } from '../lib/sitesLayer';
import { parseStationingHash } from '../lib/stationingLink';

type Filter = 'all' | 'stationed' | 'boundary';

/**
 * «المواقع»: the registered sites workspace (owner decision of 5 Nov 2026, item 2) on the offline map — every site this
 * person may see with its boundary or marker and name, a searchable list, and the chosen site's record: kind,
 * boundary, responsible organisation, the units linked to it, the authoritative current stationing there and the
 * occupancy the server lets this person see. Re-stationing is not done here: «طلب إعادة تمركز» opens a NEW request in
 * «إعادة التمركز» with the stationed unit's context, and nothing is saved until the person acts there.
 */
export function SitesPage() {
  const registered = useRegisteredSites();
  const [mode, setMode] = useState<BasemapMode>('street');
  const [selected, setSelected] = useState<string | null>(() => parseStationingHash(location.hash).site ?? null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const select = (id: string | null) => {
    setSelected(id);
    history.replaceState(null, '', id ? '#stationing/site/' + id : '#stationing');
  };
  const stationedAt = useMemo(() => {
    const m = new Map<string, StationingRecord[]>();
    for (const c of registered.current) m.set(c.siteId, [...(m.get(c.siteId) ?? []), c]);
    return m;
  }, [registered.current]);
  const sites = useMemo(() => registered.sites.filter((s) => s.view !== 'CONTEXT'), [registered.sites]);
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return sites.filter(
      (s) =>
        (filter === 'all' || (filter === 'stationed' ? stationedAt.has(s.siteId) : !!s.boundary)) &&
        (!t || [s.name, s.code, s.kind, s.responsibleOrg?.name].some((x) => x?.toLowerCase().includes(t))),
    );
  }, [sites, q, filter, stationedAt]);
  const site = selected ? sites.find((s) => s.siteId === selected) ?? null : null;
  // counted on the sites this person can see; a stationing elsewhere is reported apart, never counted as a site here
  const stationedShown = sites.filter((s) => stationedAt.has(s.siteId)).length;
  const hidden = registered.current.filter((c) => !sites.some((s) => s.siteId === c.siteId));

  const list = (
    <section className="tz-drawer open tz-site-list" aria-label="قائمة المواقع">
      <div className="tz-drawer-head">
        <span className="tz-drawer-toggle">
          <Icon name="pin" />
          <span>المواقع</span>
          <span className="tz-chip">{registered.loaded ? sites.length : '…'}</span>
        </span>
      </div>
      <div className="tz-site-search">
        <Icon name="search" />
        <input type="search" placeholder="بحث بالاسم أو الرمز أو الجهة…" aria-label="بحث في المواقع" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="tz-filters" role="group" aria-label="تصفية المواقع">
        {(
          [
            ['all', 'الكل'],
            ['stationed', 'بها تمركز حالي'],
            ['boundary', 'بحدود مسجلة'],
          ] as [Filter, string][]
        ).map(([k, label]) => (
          <button key={k} className={'tz-filter' + (filter === k ? ' active' : '')} aria-pressed={filter === k} onClick={() => setFilter(k)}>
            {label}
          </button>
        ))}
      </div>
      <div className="rs-list" data-testid="site-list">
        {!registered.loaded && <div className="tz-muted tz-pad">جارٍ التحميل…</div>}
        {registered.loaded && shown.length === 0 && <div className="tz-muted tz-pad">لا مواقع مطابقة ضمن ما تراه.</div>}
        {shown.map((s) => {
          const here = stationedAt.get(s.siteId) ?? [];
          return (
            <button key={s.siteId} className={'rs-item tz-site-item' + (s.siteId === selected ? ' active' : '')} aria-current={s.siteId === selected} onClick={() => select(s.siteId)}>
              <span className="rs-item-head">
                <b>{s.name}</b>
                <small className="tz-code">{s.code}</small>
              </span>
              <span>
                {s.kind || '—'} · {s.boundary ? 'حدود مسجلة' : 'علامة'}
              </span>
              {here.length > 0 && <small>التمركز الحالي: {here.map((c) => c.orgName).join('، ')}</small>}
            </button>
          );
        })}
      </div>
    </section>
  );

  return (
    <OperationalWorkspace
      listRail
      railLabel="المواقع"
      contextLabel="تفاصيل الموقع"
      sheetKey={selected ?? ''}
      rail={<div className="tz-rail">{list}</div>}
      context={<SiteDetailsPanel site={site} sites={sites} stationedAt={stationedAt} stationedShown={stationedShown} hidden={hidden} />}
      centre={
        <MapFrame
          title={
            <span className="tz-mapstep">
              <Icon name="pin" />
              <b>المواقع المسجلة</b>
              <small>{registered.loaded ? `${sites.length} موقعاً ظاهراً لك · ${stationedShown} بها تمركز حالي` : 'جارٍ التحميل…'}</small>
            </span>
          }
          mode={mode}
          setMode={setMode}
          legend={
            <div className="tz-legend rs-legend">
              <ul>
                <li><i className="sw ref" /> موقع مسجّل (حدود)</li>
                <li><i className="sw ref-marker" /> موقع مسجّل (علامة)</li>
                <li><i className="sw ref-selected" /> الموقع المختار</li>
              </ul>
            </div>
          }
        >
          <SitesMap sites={registeredSites(sites)} current={registered.current} mode={mode} selectedId={selected} onSelect={select} />
        </MapFrame>
      }
    />
  );
}

/** The chosen site's record; without a selection, what the page holds. Every list is the server's, scoped to the person. */
function SiteDetailsPanel({ site, sites, stationedAt, stationedShown, hidden }: {
  site: MapFeature | null;
  sites: MapFeature[];
  stationedAt: Map<string, StationingRecord[]>;
  stationedShown: number;
  hidden: StationingRecord[];
}) {
  const app = useApp();
  const [detail, setDetail] = useState<SiteDetail | null>(null);
  const [current, setCurrent] = useState<StationingRecord[] | null>(null);
  const [links, setLinks] = useState<SiteLinkRecord[] | null>(null);
  const [occupants, setOccupants] = useState<SiteOccupants | null>(null);
  const [error, setError] = useState<string | null>(null);
  const id = site?.siteId ?? null;
  useEffect(() => {
    setDetail(null);
    setCurrent(null);
    setLinks(null);
    setError(null);
    if (!id) return;
    api.site(id).then(setDetail).catch((e: Error) => setError(e.message));
    api.stationingCurrent(undefined, id).then(setCurrent).catch(() => setCurrent([]));
    api.siteLinks(undefined, id).then(setLinks).catch(() => setLinks([]));
    api.siteOccupants(id).then(setOccupants).catch(() => setOccupants(null));
  }, [id]);
  const canRequest = app.can('CREATE_RESTATIONING');

  if (!site) {
    const withBoundary = sites.filter((s) => s.boundary).length;
    return (
      <aside className="tz-context" aria-label="تفاصيل الموقع">
        <div className="tz-context-body">
          <section className="tz-card">
            <div className="tz-card-head">
              <h3>سجل المواقع</h3>
            </div>
            <dl className="rs-facts">
              <div>
                <dt>المواقع الظاهرة لك</dt>
                <dd>{sites.length}</dd>
              </div>
              <div>
                <dt>بحدود مسجلة</dt>
                <dd>{withBoundary}</dd>
              </div>
              <div>
                <dt>بها تمركز حالي</dt>
                <dd>{stationedShown}</dd>
              </div>
            </dl>
            <p className="tz-muted">اختر موقعاً من القائمة أو من الخريطة لعرض بياناته.</p>
            {hidden.length > 0 && (
              <p className="tz-muted" data-testid="hidden-stationing">
                {hidden.length} سجل تمركز حالي في مواقع لا يعرضها لك سجل المواقع: {hidden.map((c) => `${c.orgName} (${c.siteName})`).join('، ')}.
              </p>
            )}
          </section>
        </div>
      </aside>
    );
  }

  const g = detail?.geometry?.geojson;
  const area = g && (g.type === 'Polygon' || g.type === 'MultiPolygon') ? siteArea(partsOf(g as unknown as SiteGeometry)) : null;
  const here = current ?? stationedAt.get(site.siteId) ?? [];
  return (
    <aside className="tz-context" aria-label="تفاصيل الموقع">
      <div className="tz-context-body" data-testid="site-details">
        <section className="tz-card rs-summary">
          <h2 className="tz-site-title">{site.name}</h2>
          {detail?.path && detail.path.length > 0 && <p className="tz-path">{detail.path.map((p) => p.name).join(' ‹ ')}</p>}
          {error && <p className="rs-error">{error}</p>}
          <dl className="rs-facts">
            <div>
              <dt>الرمز</dt>
              <dd>{site.code}</dd>
            </div>
            <div>
              <dt>النوع</dt>
              <dd>{site.kind || '—'}</dd>
            </div>
            <div>
              <dt>الجهة المسؤولة</dt>
              <dd>{detail?.responsibleOrg?.name ?? site.responsibleOrg?.name ?? '—'}</dd>
            </div>
            <div>
              <dt>الحالة</dt>
              <dd>{detail ? (detail.status === 'ACTIVE' ? 'نشط' : 'متقاعد') : '…'}</dd>
            </div>
            <div>
              <dt>الحدود</dt>
              <dd>
                {detail?.geometry
                  ? `${detail.geometry.type === 'MultiPolygon' ? 'مضلع متعدد' : detail.geometry.type === 'Polygon' ? 'مضلع' : 'نقطة'} · الإصدار ${detail.geometry.version}`
                  : site.boundary
                    ? 'حدود مسجلة'
                    : 'علامة موقع فقط'}
              </dd>
            </div>
            {area != null && (
              <div>
                <dt>المساحة</dt>
                <dd>{formatArea(area)}</dd>
              </div>
            )}
            {detail?.geometry && (
              <div>
                <dt>مصدر الحدود</dt>
                <dd>
                  {detail.geometry.source} · منذ {fullDate(detail.geometry.validFrom)}
                </dd>
              </div>
            )}
          </dl>
        </section>

        <section className="tz-card" aria-label="التمركز الحالي في الموقع" data-testid="site-stationing">
          <h4>
            <i className="sw current" /> التمركز الحالي <small>(السجل المعتمد)</small>
          </h4>
          {canRequest && here.length > 0 && (
            <a className="button compact tz-request-link" href={newRequestFromSiteHash(site.siteId)} title="يفتح «إعادة التمركز» على هذا الموقع موقعاً حالياً؛ تختار أنت من ينتقل، ولا يُحفظ شيء حتى تتصرف">
              <Icon name="map" /> طلب إعادة تمركز من هذا الموقع
            </a>
          )}
          {current == null && <p className="tz-muted">جارٍ التحميل…</p>}
          {current != null && here.length === 0 && <p className="tz-muted">لا تمركز حالي مسجّل ضمن ما تراه.</p>}
          {!!occupants?.otherStationed && <p className="tz-muted" data-testid="others-at-site">جهة أخرى في الموقع: {occupants.otherStationed}</p>}
          <ul className="tz-sites">
            {here.map((c) => (
              <li key={c.id}>
                <b>{c.orgName}</b>
                <small>
                  {c.kind === 'TEMPORARY' ? 'مؤقت' : 'دائم'} · منذ {fullDate(c.validFrom)}
                  {c.plannedEnd ? ` · حتى ${fullDate(c.plannedEnd)}` : ''}
                  {c.reference ? ` · ${c.reference}` : ''}
                </small>
              </li>
            ))}
          </ul>
        </section>

        <section className="tz-card" aria-label="الوحدات المرتبطة بالموقع">
          <h4>
            <i className="sw link" /> الوحدات المرتبطة <small>(ارتباط إداري — لا يعني الإشغال ولا التمركز)</small>
          </h4>
          {links == null && <p className="tz-muted">جارٍ التحميل…</p>}
          {links?.length === 0 && <p className="tz-muted">لا ارتباطات نشطة.</p>}
          <ul className="tz-sites">
            {links?.map((l) => (
              <li key={l.id}>
                <b>{l.orgName}</b>
                <small>
                  منذ {fullDate(l.validFrom)} · {l.source}
                </small>
              </li>
            ))}
          </ul>
        </section>

        <section className="tz-card" aria-label="الإشغال والحجوزات">
          <h4>
            <Icon name="clock" /> الإشغال والحجوزات
          </h4>
          {detail == null && !error && <p className="tz-muted">جارٍ التحميل…</p>}
          {detail && detail.occupancy.length === 0 && <p className="tz-muted">لا إشغال أو حجز ظاهر لك.</p>}
          <ul className="tz-sites">
            {detail?.occupancy.map((o) => (
              <li key={o.reservationId}>
                <b>{o.resourceName}</b>
                <small>
                  {o.org?.name ?? '—'} · {fullDate(o.period.start)}
                  {o.period.end ? ` ← ${fullDate(o.period.end)}` : ' · دائم'} · {o.status}
                </small>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </aside>
  );
}
