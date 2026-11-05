import type { RestationingChecks, RestationingRequest } from '../../api/types';
import { deploymentRows, movementInfo } from '../../lib/workspace';

/**
 * The live checks of a request (§18): the server's verdict and problems, then one compact row per DEPLOYMENT leg — the
 * measured distance against the locked policy range, the terrain class and allowance, the effective maximum, and the
 * exception when one is needed. The distance from the current site to the proposed re-stationing site is shown last,
 * as information: re-stationing has no distance restriction.
 */
export function DeploymentCheckCard({ request, checks, compact = false }: { request: RestationingRequest; checks: RestationingChecks | null; compact?: boolean }) {
  const rows = deploymentRows(checks);
  const moves = movementInfo(request);
  return (
    <section className={'tz-card tz-checks' + (compact ? ' compact' : '')} aria-label="الفحوص">
      <div className="tz-card-head">
        <h3>الفحوص {checks?.policyVersion != null ? <small>نسخة السياسة {checks.policyVersion}</small> : null}</h3>
        {checks && <span className={'rs-verdict ' + (checks.ok ? 'ok' : 'no')}>{checks.ok ? 'كل الفحوص مستوفاة' : 'فحوص غير مستوفاة'}</span>}
      </div>
      {checks == null && <p className="tz-muted">جارٍ الفحص…</p>}
      {checks && checks.problems.length > 0 && (
        <ul className="rs-problems">
          {checks.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {checks?.siteAreaM2 != null && (
        <p className="tz-fact-line">
          مساحة موقع إعادة التمركز: <b>{Number(checks.siteAreaM2).toLocaleString('ar-AE')} م²</b> من حد {Number(checks.maxFootprintAreaM2).toLocaleString('ar-AE')} م²
        </p>
      )}
      {rows.map((r) => (
        <div key={r.leg} className={'tz-leg rs-leg ' + r.tone} data-leg={r.leg}>
          <div className="tz-leg-head">
            <i className={'sw ' + r.leg} />
            <b>{r.title}</b>
            <span className={'tz-leg-verdict ' + r.tone}>{r.verdict}</span>
          </div>
          <dl>
            <div>
              <dt>المسافة {r.from}</dt>
              <dd>{r.distance}</dd>
            </div>
            <div>
              <dt>نطاق السياسة</dt>
              <dd>{r.range}</dd>
            </div>
            {r.terrain && (
              <div>
                <dt>طبيعة الأرض</dt>
                <dd>{r.terrain}</dd>
              </div>
            )}
            <div>
              <dt>الحد الأقصى الفعلي</dt>
              <dd>{r.effectiveMax}</dd>
            </div>
          </dl>
          {r.exception && <p className="tz-leg-note warn">تحتاج استثناء مسافة الانتشار</p>}
          {r.conflicts.length > 0 && <p className="tz-leg-note bad">أرض مشغولة: {r.conflicts.join('، ')}</p>}
        </div>
      ))}
      {moves.map((m) => (
        <p key={m.from} className="tz-move-info">
          <i className="sw move" /> المسافة من «{m.from}» إلى موقع إعادة التمركز: <b>{m.km}</b> — للعلم فقط، لا قيد على مسافة إعادة التمركز.
        </p>
      ))}
    </section>
  );
}
