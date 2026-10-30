import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import type { MapFeature, RequestBoundaries, RequestDetail, RequestListItem } from '../api/types';
import { DecisionDialog, type DecisionTarget } from '../components/DecisionDialog';
import { StaticMap } from '../components/map/StaticMap';
import { RequestDocument } from '../components/RequestDocument';
import { Heading, StatusPill } from '../components/ui';
import { useApp } from '../lib/app';
import { localDay } from '../lib/dates';

export function ReviewPage() {
  const app = useApp();
  const { selectedRequestId, setSelectedRequestId, revision } = app;
  const [list, setList] = useState<RequestListItem[] | null>(null);
  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const [features, setFeatures] = useState<MapFeature[]>([]);
  const [pinned, setPinned] = useState<RequestBoundaries | null>(null);
  const [decision, setDecision] = useState<DecisionTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  // the inbox follows the server: reloaded every 30 s, when the window regains focus and when an item is opened, so a
  // reviewer never acts on a state another person has already changed (the server refuses stale decisions anyway)
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    const timer = window.setInterval(bump, 30_000);
    window.addEventListener('focus', bump);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', bump);
    };
  }, []);

  useEffect(() => {
    api
      .requests({ excludeDrafts: true, size: 200 })
      .then((p) => setList(p.items))
      .catch((e: Error) => setError(e.message));
  }, [revision, tick]);

  const current = useMemo(() => list?.find((x) => x.id === selectedRequestId) ?? list?.[0], [list, selectedRequestId]);

  useEffect(() => {
    if (!current) {
      setDetail(null);
      return;
    }
    let live = true;
    api
      .request(current.id)
      .then((d) => live && setDetail(d))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [current?.id, revision, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  // the request's sites for its period, drawn with the boundary versions recorded in the revision under review
  useEffect(() => {
    if (!detail) return;
    let live = true;
    const siteIds = [...new Set(detail.resources.map((x) => x.siteId))];
    Promise.all([
      api.mapFeatures({ siteIds: siteIds.join(','), from: detail.period.start, to: detail.period.end, open: detail.period.end === null }).catch(() => null),
      api.requestBoundaries(detail.id).catch(() => null),
    ]).then(([d, b]) => {
      if (!live) return;
      setPinned(b);
      const byId = new Map((b?.boundaries ?? []).map((x) => [x.siteId, x]));
      setFeatures(
        (d?.features ?? []).map((f) => {
          const p = byId.get(f.siteId);
          if (!p || !b?.pinned) return f;
          const registered = p.type === 'Polygon' || p.type === 'MultiPolygon';
          return {
            ...f,
            boundary: registered && p.geojson && p.version != null ? { version: p.version, type: p.type as 'Polygon', geojson: p.geojson, simplified: false } : null,
            boundaryStatus: registered ? 'REGISTERED' : 'NOT_REGISTERED',
          };
        }),
      );
    });
    return () => {
      live = false;
    };
  }, [detail]);
  const changed = (pinned?.boundaries ?? []).filter((b) => b.version != null && b.currentVersion != null && b.currentVersion !== b.version);

  const submitted = list?.filter((r) => r.status === 'SUBMITTED').length ?? 0;

  return (
    <>
      <Heading
        en="REVIEW / DECISION DESK"
        title="مكتب المراجعة"
        description="البيانات، ومهام المراجعة، وسجل القرار، في مساحة واحدة."
        actions={<span className="pill orange">{submitted} طلب قيد المراجعة</span>}
      />
      {error && <div className="note red" style={{ marginBottom: 15 }}>{error}</div>}
      <div className="review-layout">
        <aside className="card inbox">
          <h3>الطلبات الواردة</h3>
          <div className="inbox-items">
            {list === null && <div className="empty">جارٍ التحميل…</div>}
            {list?.map((x) => (
              <button
                key={x.id}
                className={'inbox-item ' + (current?.id === x.id ? 'active' : '')}
                onClick={() => {
                  setSelectedRequestId(x.id);
                  setTick((t) => t + 1);
                  app.setMapDate(localDay(x.period.start));
                }}
              >
                <span className="latin">{x.number}</span>
                <b>{x.type.name}</b>
                <small>{x.ownerOrg?.name ?? 'جهة مقيدة'}</small>
                <div style={{ marginTop: 10 }}>
                  <StatusPill status={x.status} />
                </div>
              </button>
            ))}
          </div>
          <p className="micro muted" style={{ marginTop: 12 }}>
            تظهر أزرار القرار للمهام المسندة إلى دورك ونطاقك فقط؛ يُتحقق من الإسناد في الخادم وقت القرار.
          </p>
        </aside>
        <div className="stack">
          {detail ? (
            <>
              <article className="card request-document">
                <RequestDocument
                  request={detail}
                  onDecision={(task, d) => setDecision({ request: detail, task, decision: d })}
                  onChanged={(r) => r && setDetail(r)}
                />
              </article>
              <StaticMap
                className="document-map"
                features={features}
                selectedSiteId={detail.resources[0]?.siteId ?? null}
                onSelect={(id) => app.toast((features.find((f) => f.siteId === id)?.name ?? '') + ' · مرفق وارد في الطلب')}
                label="مواقع الطلب بحدودها المسجلة في المراجعة"
                caption={pinned ? (pinned.pinned ? 'الحدود كما في المراجعة ' + pinned.revision : 'الحدود الحالية — تُثبَّت عند الإرسال') : undefined}
              />
              {pinned && (
                <section className="card padding pinned-boundaries" aria-label="نسخ الحدود في الطلب">
                  <h3>نسخ الحدود {pinned.pinned ? 'المسجلة في المراجعة ' + pinned.revision : 'الحالية (مسودة)'}</h3>
                  <ul>
                    {pinned.boundaries.map((b) => (
                      <li key={b.siteId}>
                        <b>{b.siteName}</b> —{' '}
                        {b.type === 'Polygon' || b.type === 'MultiPolygon' ? 'الإصدار ' + b.version : 'حدود غير مسجلة وقت الإرسال'}
                        {b.currentVersion != null && b.version != null && b.currentVersion !== b.version && (
                          <span className="pill orange">عُدّلت حدود السجل لاحقاً (الإصدار الحالي {b.currentVersion}) — الطلب يبقى على نسخته</span>
                        )}
                      </li>
                    ))}
                  </ul>
                  {!pinned.recorded && <p className="micro muted">هذه المراجعة سابقة لتسجيل نسخ الحدود.</p>}
                  {changed.length > 0 && <p className="micro muted">المستند والقرار يعتمدان النسخة المسجلة في المراجعة، لا الإصدار الأحدث.</p>}
                </section>
              )}
            </>
          ) : (
            <section className="card empty">{list === null ? 'جارٍ التحميل…' : 'لا توجد طلبات ضمن النطاق'}</section>
          )}
        </div>
      </div>
      <DecisionDialog
        target={decision}
        onClose={() => setDecision(null)}
        onDone={(r) => {
          setDecision(null);
          setDetail(r);
        }}
      />
    </>
  );
}
