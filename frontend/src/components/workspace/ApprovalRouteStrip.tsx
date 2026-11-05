import type { RestationingChecks, RestationingRequest, RestationingStage } from '../../api/types';
import { fullDate } from '../../lib/dates';
import { routeStrip, type StripStatus } from '../../lib/workspace';
import { Icon } from '../ui';

const MARK: Record<StripStatus, [string, string]> = {
  done: ['✓', 'مكتملة'],
  carried: ['↺', 'محمولة من قرار سابق'],
  current: ['●', 'المرحلة الحالية'],
  upcoming: ['', 'قادمة'],
  rejected: ['✕', 'رُفض الطلب'],
  returned: ['↩', 'أعادت الطلب للتعديل'],
};

/** The unit of a stage, shown apart from its fixed label (owner, 4 Nov 2026); the exception stage acts for the requesting unit. */
function StageUnit({ unit, kind }: { unit: { name: string } | null; kind: string }) {
  if (unit) return <small className="rs-stage-unit">الجهة: {unit.name}</small>;
  return kind === 'EXCEPTION' ? <small className="rs-stage-unit">يقررها صاحب «اعتماد استثناء مسافة الانتشار»</small> : null;
}

/**
 * The approval strip along the bottom of the map (§15): the request's ACTUAL route, stage by stage — fixed label, unit,
 * status, who decided and when, the current stage — with the full history (every stage's facts, earlier routes and the
 * submissions) one click away. Nothing is assumed about which levels exist.
 */
export function ApprovalRouteStrip({ request, checks, open, setOpen }: { request: RestationingRequest; checks: RestationingChecks | null; open: boolean; setOpen: (o: boolean) => void }) {
  const { nodes, expected } = routeStrip(request, checks);
  const r = request;
  return (
    <div className={'tz-strip rs-route' + (open ? ' open' : '')}>
      <div className="tz-strip-head">
        <h3>
          <Icon name="route" /> مسار الاعتماد {r.routeNo > 1 ? `(البناء ${r.routeNo})` : ''} {expected && <small>المسار المتوقع عند الإرسال</small>}
        </h3>
        <button className="tz-tool" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'إخفاء التفاصيل' : 'السجل الكامل'} <Icon name="chevron" />
        </button>
      </div>
      <ol className="tz-steps" aria-label="مراحل الاعتماد">
        {nodes.map((n) => (
          <li key={n.key} className={'tz-step ' + n.status} aria-current={n.status === 'current' ? 'step' : undefined} title={MARK[n.status][1]}>
            <span className="tz-step-mark" aria-label={MARK[n.status][1]}>{MARK[n.status][0]}</span>
            <b>{n.label}</b>
            {n.unit && <small className="rs-stage-unit">الجهة: {n.unit}</small>}
            {n.person && <small>{n.status === 'carried' ? 'حمله' : n.key === 'requester' ? '' : 'قرره'} {n.person}</small>}
            {n.at && n.key !== 'requester' && <small className="tz-muted">{fullDate(n.at)}</small>}
            {n.status === 'current' && n.key !== 'requester' && n.key !== 'activation' && <small className="rs-now">المرحلة الحالية</small>}
            {n.note && <small className="tz-muted">{n.note}</small>}
          </li>
        ))}
      </ol>
      <div className="tz-strip-history" hidden={!open}>
        {r.route.length > 0 && (
          <ol className="rs-stages">
            {r.route.map((s) => (
              <StageItem key={s.key} s={s} />
            ))}
          </ol>
        )}
        {expected && checks?.route && (
          <ol className="rs-stages">
            {checks.route.map((s) => (
              <li key={s.key}>
                <b>{s.label}</b>
                <StageUnit unit={s.unit} kind={s.kind} />
                <small>يستوفي: {s.satisfies.join('، ')}</small>
              </li>
            ))}
          </ol>
        )}
        {r.previousRoutes.length > 0 && (
          <details>
            <summary>المسارات السابقة المحفوظة ({r.previousRoutes.length})</summary>
            {r.previousRoutes.map((p) => (
              <ol key={p.routeNo} className="rs-stages old">
                {p.stages.map((s) => (
                  <li key={s.key} className={s.mark ? 'done' : ''}>
                    <b>{s.label}</b>
                    <StageUnit unit={s.unit} kind={s.kind} />
                    {s.mark && <small>اعتمدها {s.decidedBy?.name}</small>}
                  </li>
                ))}
              </ol>
            ))}
          </details>
        )}
        {r.revisions.length > 0 && (
          <details>
            <summary>الإرسالات ({r.revisions.length})</summary>
            <ul className="rs-revisions">
              {r.revisions.map((v) => (
                <li key={v.n}>
                  #{v.n} · {v.submittedBy} · {fullDate(v.submittedAt)} · تغيّر: {v.changed.join('، ') || '—'} · أُعيد: {v.invalidated.length} · حُمل: {v.carried.length}
                  {v.reason && <div className="tz-muted">{v.reason}</div>}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}

function StageItem({ s }: { s: RestationingStage }) {
  return (
    <li className={s.mark ? 'done' : s.current ? 'current' : ''}>
      <b>{s.label}</b>
      <StageUnit unit={s.unit} kind={s.kind} />
      <small>يستوفي: {s.satisfies.join('، ')}</small>
      {s.mark && (
        <small>
          {s.mark === 'CARRIED' ? 'محمول من قرار سابق' : 'اعتمدها'} {s.decidedBy?.name} · {fullDate(s.decidedAt ?? '')}
        </small>
      )}
      {s.current && <small className="rs-now">المرحلة الحالية</small>}
    </li>
  );
}
