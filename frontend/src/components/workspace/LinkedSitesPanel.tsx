import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { RestationingRequest, SiteLinkRecord, StationingRecord } from '../../api/types';
import { fullDate } from '../../lib/dates';

/**
 * «المواقع المرتبطة» for one unit (§13): its authoritative current stationing (`/stationing/current`), its site links
 * (`/site-links`) and, when a request is open, the proposed re-stationing site. A site link is shown apart: it is an
 * association, never an occupancy or a stationing. The server returns only what this person may read.
 */
export function LinkedSitesPanel({ unitId, unitName, request }: { unitId: string | null; unitName: string; request: RestationingRequest | null }) {
  const [current, setCurrent] = useState<StationingRecord[] | null>(null);
  const [links, setLinks] = useState<SiteLinkRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!unitId) return;
    setCurrent(null);
    setLinks(null);
    setError(null);
    api.stationingCurrent(unitId).then(setCurrent).catch((e: Error) => (setCurrent([]), setError(e.message)));
    api.siteLinks(unitId).then(setLinks).catch(() => setLinks([]));
  }, [unitId]);
  const proposed = request && request.content.site && (request.content.scope.includes(unitId ?? '') || request.requestingUnit.id === unitId);
  return (
    <section className="tz-card tz-linked" aria-label="المواقع المرتبطة" data-testid="linked-sites">
      <div className="tz-card-head">
        <h3>المواقع المرتبطة</h3>
        <small className="tz-muted">{unitName}</small>
      </div>
      {!unitId && <p className="tz-muted">اختر وحدة من الهيكل.</p>}
      {error && <p className="tz-muted">{error}</p>}
      <h4>
        <i className="sw current" /> التمركز الحالي <small>(السجل المعتمد)</small>
      </h4>
      {current == null && unitId && <p className="tz-muted">جارٍ التحميل…</p>}
      {current?.length === 0 && <p className="tz-muted">لا تمركز حالي مسجّل ضمن ما تراه.</p>}
      <ul className="tz-sites">
        {current?.map((s) => (
          <li key={s.id}>
            <b>{s.siteName}</b>
            <small>
              {s.kind === 'TEMPORARY' ? 'مؤقت' : 'دائم'} · منذ {fullDate(s.validFrom)}
              {s.plannedEnd ? ` · حتى ${fullDate(s.plannedEnd)}` : ''}
              {s.reference ? ` · ${s.reference}` : ''}
            </small>
          </li>
        ))}
      </ul>
      {proposed && (
        <>
          <h4>
            <i className="sw site" /> موقع إعادة التمركز <small>(مقترح في {request!.number}، ليس تمركزاً بعد)</small>
          </h4>
          <ul className="tz-sites">
            <li>
              <b>{request!.activation?.site.name ?? 'الموقع المقترح'}</b>
              <small>{request!.content.site!.geometry.type === 'MultiPolygon' ? 'مضلع متعدد' : 'مضلع'}</small>
            </li>
          </ul>
        </>
      )}
      <h4>
        <i className="sw link" /> ارتباط بالموقع <small>(ارتباط إداري — لا يعني الإشغال ولا التمركز)</small>
      </h4>
      {links?.length === 0 && <p className="tz-muted">لا ارتباطات نشطة.</p>}
      <ul className="tz-sites">
        {links?.map((l) => (
          <li key={l.id}>
            <b>{l.siteName}</b>
            <small>
              منذ {fullDate(l.validFrom)} · {l.source}
            </small>
          </li>
        ))}
      </ul>
    </section>
  );
}
