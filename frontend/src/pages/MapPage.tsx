import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import type { MapFeatures, ReservationItem, Availability } from '../api/types';
import { MapView, featureColor, type MapMode } from '../components/MapView';
import { Heading, Icon, Pill, Stat } from '../components/ui';
import { facilitySites, useApp } from '../lib/app';
import { AVAILABILITY } from '../lib/labels';
import { addDays, dubaiISO, fullDate } from '../lib/dates';

export function MapPage() {
  const app = useApp();
  const { sites, mapDate, setMapDate, selectedSiteId, setSelectedSiteId, summaryOnly, revision } = app;
  const [data, setData] = useState<MapFeatures | null>(null);
  const [reservations, setReservations] = useState<ReservationItem[]>([]);
  const [mode, setMode] = useState<MapMode>('availability');
  const [orgFilter, setOrgFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<'all' | Availability>('all');
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .mapFeatures(dubaiISO(mapDate))
      .then((d) => live && (setData(d), setError(null)))
      .catch((e: Error) => live && setError(e.message));
    api
      .reservations({ status: 'ACTIVE', from: dubaiISO(mapDate), to: dubaiISO(addDays(mapDate, 1)) })
      .then((r) => live && setReservations(r))
      .catch(() => live && setReservations([]));
    return () => {
      live = false;
    };
  }, [mapDate, revision]);

  const siteById = useMemo(() => new Map(sites.map((s) => [s.id, s])), [sites]);
  const orgOptions = useMemo(() => {
    const m = new Map<string, string>();
    facilitySites(sites).forEach((s) => s.responsibleOrg && m.set(s.responsibleOrg.id, s.responsibleOrg.name));
    return [...m.entries()];
  }, [sites]);

  const features = useMemo(
    () =>
      (data?.features ?? []).filter((f) => {
        const site = siteById.get(f.siteId);
        if (orgFilter !== 'all' && site?.responsibleOrg?.id !== orgFilter) return false;
        if (statusFilter !== 'all' && f.availability !== statusFilter) return false;
        if (query && !(f.name + ' ' + (site?.responsibleOrg?.name ?? '')).includes(query)) return false;
        return true;
      }),
    [data, siteById, orgFilter, statusFilter, query],
  );

  const selected = features.find((f) => f.siteId === selectedSiteId) ?? features[0];
  useEffect(() => {
    if (selected && selected.siteId !== selectedSiteId) setSelectedSiteId(selected.siteId);
  }, [selected, selectedSiteId, setSelectedSiteId]);
  const site = selected ? siteById.get(selected.siteId) : undefined;
  const parent = site?.parentId ? siteById.get(site.parentId) : undefined;
  const a = selected ? AVAILABILITY[selected.availability] : null;
  const visibleIds = new Set(features.map((f) => f.siteId));

  return (
    <>
      <Heading
        en="FACILITIES / MAP WORKSPACE"
        title="المكان، والطلب، في سياق واحد"
        description="اختر المرفق من الخريطة، واستعرض إتاحته أو ابدأ طلباً إدارياً عليه."
        actions={
          <Pill tone="green" dot>
            {data ? 'بيانات الخادم · ' + fullDate(data.asOf) : 'جارٍ التحميل'}
          </Pill>
        }
      />
      <div className="stats">
        <Stat value={features.length} label="مرافق في نطاق العرض" icon="building" />
        <Stat value={features.filter((f) => f.availability === 'FREE').length} label="متاحة في اليوم المختار" icon="pin" />
        <Stat value={app.counts.submitted} label="طلبات قيد المراجعة" icon="file" />
        <Stat value={reservations.filter((r) => visibleIds.has(r.resource.siteId)).length} label="حجوزات معتمدة" icon="check" />
      </div>
      <div className="card filterbar">
        <label>
          الجهة
          <select value={orgFilter} onChange={(e) => setOrgFilter(e.target.value)}>
            <option value="all">جميع الجهات</option>
            {orgOptions.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          اليوم
          <input type="date" value={mapDate} onChange={(e) => e.target.value && setMapDate(e.target.value)} aria-label="تاريخ الخريطة" />
        </label>
        <label>
          الإتاحة
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as 'all' | Availability)}>
            <option value="all">الكل</option>
            <option value="FREE">متاح</option>
            <option value="PENDING">طلب معلّق</option>
            <option value="BUSY">محجوز</option>
          </select>
        </label>
        <span className="grow" />
        <span className="micro muted">الموقع دائم · الحجوزات مرتبطة بفترات</span>
      </div>
      {error && <div className="note red" style={{ marginBottom: 15 }}>{error}</div>}
      <div className="workspace">
        <MapView
          features={features}
          selectedSiteId={selected?.siteId ?? null}
          onSelect={setSelectedSiteId}
          mode={mode}
          onModeChange={setMode}
          coverageMessage={data && !data.coverage.covered ? data.coverage.message : null}
        />
        <aside className="card site-aside">
          <div className="flex spread">
            <h3>دليل المرافق</h3>
            <span className="pill">{features.length}</span>
          </div>
          <div className="search-box">
            <Icon name="search" />
            <input placeholder="ابحث عن مرفق…" aria-label="البحث في المرافق" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <div className="site-list">
            {features.length ? (
              features.map((f) => {
                const s = siteById.get(f.siteId);
                const c = featureColor(f, 'availability');
                return (
                  <button key={f.siteId} className={'site-row ' + (selected?.siteId === f.siteId ? 'active' : '')} onClick={() => setSelectedSiteId(f.siteId)}>
                    <span>{f.code}</span>
                    <div>
                      <b>{f.name}</b>
                      <small>{summaryOnly || !s?.responsibleOrg ? 'مرفق ضمن نطاق العرض' : s.responsibleOrg.name}</small>
                    </div>
                    <i className="dot" style={{ color: c.color }} title={c.label} />
                  </button>
                );
              })
            ) : (
              <div className="empty">{data ? 'لا توجد مرافق مطابقة' : 'جارٍ التحميل…'}</div>
            )}
          </div>
          <div className="site-detail">
            {selected && a ? (
              <>
                <div className="flex spread">
                  <span className="eyebrow">FACILITY / {selected.code}</span>
                  <span className={'pill ' + a.pill}>{a.label}</span>
                </div>
                <h2>{selected.name}</h2>
                <p className="muted micro">
                  {summaryOnly || !site?.responsibleOrg ? 'بيانات مختصرة' : site.responsibleOrg.name}
                  {!summaryOnly && selected.occupantOrg ? ' · الشاغل: ' + selected.occupantOrg.name : ''}
                </p>
                <dl className="meta-grid">
                  <div>
                    <dt>الموقع الرئيسي</dt>
                    <dd>{parent?.name ?? 'مجمع المؤسسة'}</dd>
                  </div>
                  <div>
                    <dt>التصنيف</dt>
                    <dd>{site?.kind ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>السعة</dt>
                    <dd>{site?.capacity != null ? site.capacity + ' شخصاً' : '—'}</dd>
                  </div>
                  <div>
                    <dt>تاريخ العرض</dt>
                    <dd>{fullDate(dubaiISO(mapDate))}</dd>
                  </div>
                </dl>
                {site && site.resources.length > 1 && (
                  <p className="micro muted" style={{ marginBottom: 10 }}>
                    موارد قابلة للحجز: {site.resources.map((r) => r.label || r.name).join('، ')}
                  </p>
                )}
                {!summaryOnly && (
                  <button className="button primary full" disabled={!app.can('CREATE')} onClick={() => app.openWizard({ origin: 'MAP', siteId: selected.siteId })}>
                    ＋ طلب على هذا المرفق
                  </button>
                )}
                <p className="micro muted" style={{ marginTop: 10 }}>
                  البرتقالي طلب معلّق؛ الحجز النهائي يبدأ بالاعتماد.
                  {selected.pendingCount > 0 ? ' طلبات معلّقة على المرفق: ' + selected.pendingCount + '.' : ''}
                </p>
              </>
            ) : (
              <p className="micro muted">غيّر التصفية لعرض المرافق.</p>
            )}
          </div>
        </aside>
      </div>
    </>
  );
}
