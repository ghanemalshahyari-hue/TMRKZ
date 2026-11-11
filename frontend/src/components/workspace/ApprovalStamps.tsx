import { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, type RestationingStamp, type RestationingStamps } from '../../api/client';
import { Icon } from '../ui';
import './approvalStamps.css';

/** TNQL's inks (tnql-doc-preview.js): navy for unit operations, wine for the final approval. */
const NAVY = '#1b2f6b';
const WINE = '#7a1420';

/** Date and time in Arabic-Indic digits, UAE time, as on TNQL's stamps. */
export function stampDate(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  return {
    date: new Intl.DateTimeFormat('ar-AE-u-nu-arab', { timeZone: 'Asia/Dubai', day: 'numeric', month: 'numeric', year: 'numeric' }).format(d),
    time: new Intl.DateTimeFormat('ar-AE-u-nu-arab', { timeZone: 'Asia/Dubai', hour: '2-digit', minute: '2-digit', hour12: false }).format(d),
  };
}

const fit = (s: string | null | undefined, n: number) => (!s ? '' : s.length > n ? s.slice(0, n - 1) + '…' : s);

/** «ختم عمليات الوحدة»: a round stamp with a double rim, the main unit along the top and the approving unit along the bottom. */
export function UnitOperationsStamp({ s, mainUnit, number, size = 190 }: { s: RestationingStamp; mainUnit: string | null; number: string; size?: number }) {
  const id = useId().replace(/:/g, '');
  const { date, time } = stampDate(s.at);
  return (
    <svg className="stamp stamp-round" width={size} height={size} viewBox="0 0 200 200" role="img" aria-label={'ختم عمليات الوحدة — ' + s.name}>
      <defs>
        <path id={id + 't'} d="M 24,100 A 76,76 0 0 1 176,100" />
        <path id={id + 'b'} d="M 18,100 A 82,82 0 0 0 182,100" />
      </defs>
      <g fill="none" stroke={NAVY}>
        <circle cx="100" cy="100" r="96" strokeWidth="3" />
        <circle cx="100" cy="100" r="90" strokeWidth="1" />
        <circle cx="100" cy="100" r="67" strokeWidth="1" />
      </g>
      <g fill={NAVY} fontFamily="Arabic, Tahoma, Arial, sans-serif" textAnchor="middle" direction="rtl">
        <text fontSize="12.5" fontWeight="700">
          <textPath href={'#' + id + 't'} startOffset="50%">{fit(mainUnit, 30)}</textPath>
        </text>
        <text fontSize="11">
          <textPath href={'#' + id + 'b'} startOffset="50%">{fit(s.unit, 34)}</textPath>
        </text>
        <text x="100" y="72" fontSize="10.8" fontWeight="700">اعتماد عمليات الوحدة</text>
        <line x1="66" y1="78" x2="134" y2="78" stroke={NAVY} strokeWidth="1" />
        <text x="100" y="92" fontSize="10.5" fontWeight="700">{fit(s.name, 24)}</text>
        <text x="100" y="104" fontSize="8.8">{fit(s.position || s.role || 'معتمد عمليات الوحدة', 30)}{s.onBehalf ? ' — بالنيابة' : ''}</text>
        <text x="100" y="117" fontSize="9" direction="ltr" fontFamily="Arial, sans-serif">{number}</text>
        <text x="100" y="129" fontSize="9.5">{date}</text>
        <text x="100" y="140" fontSize="9.5">{time}</text>
      </g>
    </svg>
  );
}

/** «ختم الاعتماد النهائي»: a rounded rectangle with a double border, «معتمد نهائياً» in the largest type. */
export function FinalStamp({ s, mainUnit, number, width = 250 }: { s: RestationingStamp; mainUnit: string | null; number: string; width?: number }) {
  const { date, time } = stampDate(s.at);
  return (
    <svg className="stamp stamp-rect" width={width} height={width * 0.62} viewBox="0 0 250 155" role="img" aria-label={'ختم الاعتماد النهائي — ' + s.name}>
      <g fill="none" stroke={WINE}>
        <rect x="3" y="3" width="244" height="149" rx="14" strokeWidth="3" />
        <rect x="9" y="9" width="232" height="137" rx="10" strokeWidth="1" />
      </g>
      <g fill={WINE} fontFamily="Arabic, Tahoma, Arial, sans-serif" textAnchor="middle" direction="rtl">
        <text x="125" y="28" fontSize="11" fontWeight="700">{fit(s.unit, 38)}</text>
        <text x="125" y="42" fontSize="9.5">{fit(mainUnit, 42)}</text>
        <line x1="45" y1="49" x2="205" y2="49" stroke={WINE} strokeWidth="1" />
        <text x="125" y="74" fontSize="19" fontWeight="800">معتمد نهائياً</text>
        <text x="125" y="93" fontSize="10.5" fontWeight="700">{fit(s.name, 32)}</text>
        <text x="125" y="107" fontSize="9">{fit(s.position || s.role || 'معتمد الاعتماد النهائي', 40)}{s.onBehalf ? ' — بالنيابة' : ''}</text>
        <text x="125" y="122" fontSize="9" direction="ltr" fontFamily="Arial, sans-serif">{number}</text>
        <text x="125" y="137" fontSize="9.5">{date} — {time}</text>
      </g>
    </svg>
  );
}

/**
 * The request's approval stamps, as TNQL's (owner, 11 Nov 2026; ADR-055): shown once «اعتماد عمليات الوحدة» or «الاعتماد
 * النهائي» is approved, with «طباعة سجل الاعتماد» printing the request's facts under both stamps. Visual only: the record
 * of the approval is the audit; this is not the certificate seal of ADR-020.
 */
export function ApprovalStamps({ requestId, state, title, facts }: { requestId: string; state: string; title: string; facts: [string, string][] }) {
  const [st, setSt] = useState<RestationingStamps | null>(null);
  const [printing, setPrinting] = useState(false);
  useEffect(() => {
    api.restationingStamps(requestId).then(setSt).catch(() => setSt(null));
  }, [requestId, state]);
  useEffect(() => {
    if (!printing) return;
    const done = () => setPrinting(false);
    window.addEventListener('afterprint', done);
    const t = window.setTimeout(() => window.print(), 50);
    return () => (window.clearTimeout(t), window.removeEventListener('afterprint', done));
  }, [printing]);
  if (!st || (!st.unitOperations && !st.final)) return null;
  const stamps = (
    <div className="stamps-row">
      {st.unitOperations && (
        <figure>
          <UnitOperationsStamp s={st.unitOperations} mainUnit={st.mainUnit} number={st.number} />
          <figcaption>ختم عمليات الوحدة</figcaption>
        </figure>
      )}
      {st.final && (
        <figure>
          <FinalStamp s={st.final} mainUnit={st.mainUnit} number={st.number} />
          <figcaption>ختم الاعتماد النهائي</figcaption>
        </figure>
      )}
    </div>
  );
  return (
    <>
      <section className="tz-card rs-stamps" data-testid="approval-stamps">
        <div className="flex spread">
          <h4>الأختام</h4>
          <button className="button compact" onClick={() => setPrinting(true)}>
            <Icon name="download" /> طباعة سجل الاعتماد
          </button>
        </div>
        {stamps}
        <p className="micro muted">الختم إثبات مرئي للاعتماد المسجل في سجل الإجراءات، وليس توقيعاً إلكترونياً.</p>
      </section>
      {printing &&
        createPortal(
          <div className="stamp-print" dir="rtl">
            <div className="stamp-watermark">{st.final ? 'معتمد نهائياً' : 'معتمد عمليات الوحدة'}</div>
            <header>
              <h1>سجل اعتماد الطلب</h1>
              <p>
                <span dir="ltr">{st.number}</span> · {title}
              </p>
            </header>
            <dl>
              {facts.map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
            <h2>التوقيع والختم</h2>
            {stamps}
            <footer>طُبع من تمركز · {stampDate(new Date().toISOString()).date}</footer>
          </div>,
          document.body,
        )}
    </>
  );
}
