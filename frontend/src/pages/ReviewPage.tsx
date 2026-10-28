import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import type { MapFeature, RequestDetail, RequestListItem } from '../api/types';
import { DecisionDialog, type DecisionTarget } from '../components/DecisionDialog';
import { MapView, type MapMode } from '../components/MapView';
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
  const [mode, setMode] = useState<MapMode>('availability');
  const [decision, setDecision] = useState<DecisionTarget | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .requests({ excludeDrafts: true, size: 200 })
      .then((p) => setList(p.items))
      .catch((e: Error) => setError(e.message));
  }, [revision]);

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
  }, [current?.id, revision]); // eslint-disable-line react-hooks/exhaustive-deps

  // map of the request's facilities on its start day (prototype sets mapDate from the request)
  useEffect(() => {
    if (!detail) return;
    const siteIds = new Set(detail.resources.map((x) => x.siteId));
    api
      .mapFeatures(detail.period.start)
      .then((d) => setFeatures(d.features.filter((f) => siteIds.has(f.siteId))))
      .catch(() => setFeatures([]));
  }, [detail]);

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
              <MapView
                className="document-map"
                features={features}
                selectedSiteId={detail.resources[0]?.siteId ?? null}
                onSelect={(id) => app.toast((features.find((f) => f.siteId === id)?.name ?? '') + ' · مرفق وارد في الطلب')}
                mode={mode}
                onModeChange={setMode}
              />
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
