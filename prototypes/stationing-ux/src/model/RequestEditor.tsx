import { useEffect, useRef } from 'react';
import L from '../../../../frontend/src/lib/leaflet';
import { FootprintEditor } from '../../../../frontend/src/components/stationing/FootprintEditor';
import { centroid, type Ring } from '../../../../frontend/src/lib/footprint';
import { SITES, pathOf } from '../data';
import { symbolHtml, type Symbols } from '../symbols';
import { CompareTable, StateChip } from './cards';
import { comparison, formatKm, mainSiteOf, orgName, rangeText } from './compare';
import { DAY, STATE_LABEL, check, descendants, holds, type Action, type CandRole, type Request, type World } from './domain';
import { PROFILE } from './fixtures';
import { fitPadding } from './fit';

type Props = {
  world: World;
  setWorld: (f: (w: World) => World) => void;
  map: L.Map | null;
  id: string;
  actor: string;
  step: number;
  setStep: (n: number) => void;
  symbols: Symbols;
  act: (a: Action) => void;
  narrow: boolean;
  sheet: 'collapsed' | 'medium' | 'expanded';
  onClose: () => void;
};

const STEPS = ['النطاق', 'المدة', 'الموقع الرئيسي', 'الموقع البديل', 'المقارنة والإرسال'];
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const parse = (s: string) => Date.parse(s + 'T06:00:00Z');

/**
 * «طلب إعادة تمركز» in five steps. Steps 3 and 4 drive the application's own polygon engine: the primary starts from a
 * copy of the current main site, the alternative from a copy of the primary, and the engine measures the alternative from
 * the primary (never from the current site). Values come from the EXAMPLE policy profile.
 */
export function RequestEditor({ world, setWorld, map, id, actor, step, setStep, symbols, act, narrow, sheet, onClose }: Props) {
  const r = world.requests.find((x) => x.id === id)!;
  const latest = useRef(world);
  latest.current = world;
  const update = (f: (r: Request) => void) =>
    setWorld((w) => {
      const c = structuredClone(w);
      f(c.requests.find((x) => x.id === id)!);
      return c;
    });
  const cur = mainSiteOf(world, r.org)!;
  const editable = r.state === 'DRAFT' || r.state === 'RETURNED_FOR_CHANGES';

  // the polygon engine for the candidate of steps 3 and 4
  useEffect(() => {
    if (!map || (step !== 3 && step !== 4) || !editable) return;
    const role: CandRole = step === 3 ? 'PRIMARY' : 'ALTERNATIVE';
    const req = latest.current.requests.find((x) => x.id === id)!;
    const origin = step === 3 ? centroid(mainSiteOf(latest.current, req.org)!.ring) : centroid(req.candidates.PRIMARY.ring);
    const range = step === 3 ? PROFILE.currentToPrimary : PROFILE.primaryToAlternative;
    const busy = SITES.filter((s) => s.status === 'BUSY' && s.ring).map((s) => ({ name: s.name, rings: [s.ring!] }));
    const ed = new FootprintEditor(map, {
      origin,
      symbolHtml: symbolHtml(symbols.get(req.org)),
      range: () => range,
      busy: () => busy,
      paused: () => false,
      onLive: (l, final) => {
        if (final && l.ring) {
          const ring: Ring = l.ring.map((p) => ({ ...p }));
          update((x) => {
            x.candidates[role].ring = ring;
          });
        }
      },
    });
    const ring = req.candidates[role].ring;
    ed.startMove(ring, centroid(ring));
    map.flyToBounds(L.latLngBounds([...ring.map((p) => [p.lat, p.lng] as L.LatLngTuple), [origin.lat, origin.lng]]), {
      ...fitPadding(window.innerWidth <= 900),
      maxZoom: 15,
      duration: 0.4,
    });
    return () => ed.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, step, editable]);

  // on a phone, a new sheet height re-fits the proposal so it stays visible and draggable above the sheet
  useEffect(() => {
    if (!map || !narrow || (step !== 3 && step !== 4)) return;
    const req = latest.current.requests.find((x) => x.id === id)!;
    const ring = req.candidates[step === 3 ? 'PRIMARY' : 'ALTERNATIVE'].ring;
    const origin = step === 3 ? centroid(mainSiteOf(latest.current, req.org)!.ring) : centroid(req.candidates.PRIMARY.ring);
    const t = requestAnimationFrame(() =>
      map.flyToBounds(L.latLngBounds([...ring.map((p) => [p.lat, p.lng] as L.LatLngTuple), [origin.lat, origin.lng]]), { ...fitPadding(true), maxZoom: 15, duration: 0.3 }),
    );
    return () => cancelAnimationFrame(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet]);

  const units = descendants(world, r.org).filter((u) => holds(world, actor, 'CREATE', u));
  const rows = comparison(world, r);
  const row = (k: string) => rows.find((x) => x.key === k)!;
  const durationOk = r.duration.type === 'PERMANENT' || (r.duration.end !== undefined && r.duration.end > r.duration.start);
  const scopeOk = r.scope.whole || r.scope.units.length > 0;
  const candOk = (k: 'PRIMARY' | 'ALTERNATIVE') => row(k) && row(k).inRange && row(k).shapeOk && row(k).conflicts.length === 0;
  const canNext = step === 1 ? scopeOk : step === 2 ? durationOk : step === 3 ? candOk('PRIMARY') : step === 4 ? candOk('ALTERNATIVE') : false;
  const submit = check(world, actor, { t: 'SUBMIT', req: id });

  const readout = (k: 'PRIMARY' | 'ALTERNATIVE') => {
    const x = row(k);
    const ok = candOk(k);
    return (
      <div className={'ux-readout ' + (ok ? 'ok' : 'bad')} data-testid={'readout-' + k.toLowerCase()}>
        <dl className="md-dl">
          <dt>{k === 'PRIMARY' ? 'المسافة من المقر الرئيسي الحالي' : 'المسافة من الموقع الرئيسي المقترح'}</dt>
          <dd>
            <b>{formatKm(x.dist!)}</b>
          </dd>
          <dt>النطاق المهيأ ({PROFILE.name})</dt>
          <dd className={x.inRange ? 'good' : 'bad'}>
            {rangeText(x.range!)} {x.inRange ? '✓ ضمن النطاق' : '✕ خارج النطاق'}
          </dd>
          <dt>الشكل</dt>
          <dd className={x.shapeOk ? 'good' : 'bad'}>{x.shapeOk ? 'سليم' : 'متقاطع ذاتياً'} · {x.area}</dd>
          <dt>الإتاحة</dt>
          <dd className={x.conflicts.length ? 'bad' : 'good'}>{x.conflicts.length ? 'تعارض: ' + x.conflicts.join('، ') : 'لا تعارض'}</dd>
        </dl>
        {k === 'ALTERNATIVE' && <p className="ux-note">لا تُقاس المسافة الثانية من المقر الحالي.</p>}
      </div>
    );
  };

  const drawing = (step === 3 || step === 4) && editable;
  const compact = narrow && drawing;
  const live = drawing ? row(step === 3 ? 'PRIMARY' : 'ALTERNATIVE') : null;

  return (
    <section className="ux-card md-card md-editor" aria-label="طلب إعادة تمركز">
      {compact && live && (
        <div className="md-compact" data-testid="compact-status">
          <div className="md-compact-row">
            <b>
              {step}/5 {STEPS[step - 1]}
            </b>
            <span className={candOk(step === 3 ? 'PRIMARY' : 'ALTERNATIVE') ? 'good' : 'bad'} data-testid="compact-readout">
              {formatKm(live.dist!)} {step === 3 ? 'من الحالي' : 'من الرئيسي'} · المهيأ {rangeText(live.range!)} {live.inRange ? '✓' : '✕'} · {live.shapeOk ? 'سليم' : 'متقاطع'} ·{' '}
              {live.conflicts.length ? 'تعارض' : 'لا تعارض'}
            </span>
          </div>
          <div className="md-compact-actions">
            <button className="ux-btn" onClick={() => setStep(step - 1)}>
              السابق
            </button>
            <button className="ux-btn primary" disabled={!canNext} onClick={() => setStep(step + 1)} data-testid="next">
              التالي: {STEPS[step]}
            </button>
          </div>
        </div>
      )}
      <header className="ux-card-head md-head">
        <div>
          <h2>طلب إعادة تمركز — {orgName(r.org)}</h2>
          <div className="ux-crumbs">
            <span className="ux-mono">{r.number}</span> · <StateChip state={r.state} label={STATE_LABEL[r.state]} /> · من «{cur.name}»
          </div>
        </div>
        <button className="ux-x" aria-label="إغلاق" onClick={onClose}>
          ✕
        </button>
      </header>
      <nav className="ux-steps md-steps" aria-label="خطوات الطلب">
        {STEPS.map((s, i) => (
          <button key={s} className={i + 1 === step ? 'on' : i + 1 < step ? 'done' : ''} onClick={() => setStep(i + 1)} aria-current={i + 1 === step ? 'step' : undefined}>
            {i + 1} {s}
          </button>
        ))}
      </nav>

      {step === 1 && (
        <div className="md-block" data-testid="step-scope">
          <div className="ux-seg" role="radiogroup" aria-label="نطاق الطلب">
            <button role="radio" aria-checked={r.scope.whole} className={r.scope.whole ? 'on' : ''} disabled={!editable} onClick={() => update((x) => void (x.scope = { whole: true, units: [] }))}>
              الجهة كاملة
            </button>
            <button role="radio" aria-checked={!r.scope.whole} className={!r.scope.whole ? 'on' : ''} disabled={!editable} onClick={() => update((x) => void (x.scope = { whole: false, units: x.scope.units }))}>
              جزء من الجهة
            </button>
          </div>
          {r.scope.whole ? (
            <p className="ux-hint">
              يشمل الطلب «{orgName(r.org)}» و{descendants(world, r.org).length} وحدة تابعة.
            </p>
          ) : (
            <>
              <p className="ux-hint">اختر الوحدات المشمولة. يعرض الهيكل ما تسمح به صلاحياتك فقط؛ الباقي يبقى في تمركزه.</p>
              <ul className="md-list units">
                {units.map((u) => (
                  <li key={u}>
                    <label className="md-check" style={{ paddingInlineStart: (pathOf(u).length - pathOf(r.org).length - 1) * 16 }}>
                      <input
                        type="checkbox"
                        disabled={!editable}
                        checked={r.scope.units.includes(u)}
                        onChange={(e) => update((x) => void (x.scope.units = e.target.checked ? [...x.scope.units, u] : x.scope.units.filter((y) => y !== u)))}
                      />
                      {orgName(u)}
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {step === 2 && (
        <div className="md-block" data-testid="step-duration">
          <div className="ux-seg" role="radiogroup" aria-label="المدة">
            <button role="radio" aria-checked={r.duration.type === 'PERMANENT'} className={r.duration.type === 'PERMANENT' ? 'on' : ''} disabled={!editable} onClick={() => update((x) => void (x.duration = { type: 'PERMANENT', start: x.duration.start }))}>
              دائم
            </button>
            <button
              role="radio"
              aria-checked={r.duration.type === 'TEMPORARY'}
              className={r.duration.type === 'TEMPORARY' ? 'on' : ''}
              disabled={!editable}
              onClick={() => update((x) => void (x.duration = { type: 'TEMPORARY', start: x.duration.start, end: x.duration.end ?? x.duration.start + 60 * DAY }))}
            >
              مؤقت
            </button>
          </div>
          <div className="md-dates">
            <label>
              البداية
              <input type="date" value={iso(r.duration.start)} disabled={!editable} onChange={(e) => update((x) => void (x.duration.start = parse(e.target.value)))} />
            </label>
            {r.duration.type === 'TEMPORARY' && (
              <label>
                النهاية (إلزامية)
                <input type="date" value={iso(r.duration.end!)} disabled={!editable} onChange={(e) => update((x) => void (x.duration.end = parse(e.target.value)))} />
              </label>
            )}
          </div>
          {!durationOk && <p className="md-why">النهاية بعد البداية إلزامياً؛ لا مؤقت مفتوح.</p>}
          <p className="ux-hint">
            {r.duration.type === 'PERMANENT'
              ? 'الدائم يحل محل التمركز الدائم عند التفعيل المستقل، لا قبله.'
              : 'المؤقت طبقة فوق الدائم: لا يُنهيه، ويعود النطاق إليه عند النهاية بانتقال نظام مُدقَّق.'}
          </p>
        </div>
      )}

      {step === 3 && (
        <div className="md-block" data-testid="step-primary">
          <p className="ux-hint">اسحب المساحة المقترحة على الخريطة؛ تنتقل كاملة بشكلها. الحدود الزرقاء هي التمركز الحالي ولا تتغير.</p>
          {readout('PRIMARY')}
        </div>
      )}
      {step === 4 && (
        <div className="md-block" data-testid="step-alternative">
          <p className="ux-hint">الموقع البديل احتياطي في الطلب نفسه، يُراجَع إن لم يُقبل الرئيسي. يبدأ من نسخة من الرئيسي؛ اسحبه إلى موضعه.</p>
          {readout('ALTERNATIVE')}
        </div>
      )}
      {step === 5 && (
        <div className="md-block" data-testid="step-compare">
          <div className="md-chips">
            <span className="md-tagline">{r.scope.whole ? 'الجهة كاملة' : 'جزء: ' + r.scope.units.map(orgName).join('، ')}</span>
            <span className="md-tagline">{r.duration.type === 'PERMANENT' ? 'دائم من ' + iso(r.duration.start) : 'مؤقت ' + iso(r.duration.start) + ' ← ' + iso(r.duration.end!)}</span>
          </div>
          <CompareTable w={world} r={r} />
          <div className="ux-actions sticky">
            <button className="ux-btn primary" disabled={!submit.ok || !candOk('PRIMARY') || !candOk('ALTERNATIVE') || !durationOk || !scopeOk} onClick={() => act({ t: 'SUBMIT', req: id })} data-act="SUBMIT">
              إرسال للاعتماد (محاكاة)
            </button>
          </div>
          {!submit.ok && <p className="md-why">{submit.reason}</p>}
          <p className="ux-note">في التطبيق: يتحقق الخادم من كل علاقة بملف السياسة المنشور، ويبدأ سير العمل. لا يتغير التمركز قبل الاعتماد والتفعيل المستقل.</p>
        </div>
      )}

      {step < 5 && !compact && (
        <div className="ux-actions sticky">
          {step > 1 && (
            <button className="ux-btn" onClick={() => setStep(step - 1)}>
              السابق
            </button>
          )}
          <button className="ux-btn primary" disabled={!canNext} onClick={() => setStep(step + 1)} data-testid="next">
            التالي: {STEPS[step]}
          </button>
        </div>
      )}
    </section>
  );
}
