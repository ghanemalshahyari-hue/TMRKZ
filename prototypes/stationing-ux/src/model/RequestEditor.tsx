import { useEffect, useRef, useState } from 'react';
import L from '../../../../frontend/src/lib/leaflet';
import { FootprintEditor } from '../../../../frontend/src/components/stationing/FootprintEditor';
import { centroid, type Ring } from '../../../../frontend/src/lib/footprint';
import { SITES, pathOf } from '../data';
import { symbolHtml, type Symbols } from '../symbols';
import { AREA_LABEL, AreaPairPanel, DRAW_VERTICES, PolicyBadge, TargetSwitch, areaObstacles, pairAcceptable, useAreaEngine, type AreaTarget } from './areas';
import { CompareTable, RoutePanel, StateChip, type CardCtx } from './cards';
import { comparison, formatArea, formatKm, mainSiteOf, orgName } from './compare';
import type { Ask } from './dialog';
import {
  AREQ_LABEL,
  DAY,
  FACT_LABEL,
  STATE_LABEL,
  changedFacts,
  check,
  descendants,
  holds,
  policyAt,
  profileByVersion,
  requirementOf,
  type Action,
  type AreaRole,
  type Request,
  type World,
} from './domain';
import { fitPadding } from './fit';

type Props = {
  world: World;
  setWorld: (f: (w: World) => World) => void;
  map: L.Map | null;
  id: string;
  actor: string;
  step: number;
  setStep: (n: number) => void;
  /** What the polygon engine edits in step 3: the proposed site, or one of its deployment areas. */
  target: AreaTarget;
  setTarget: (t: AreaTarget) => void;
  symbols: Symbols;
  act: (a: Action) => void;
  ask: (a: Ask) => void;
  ctx: CardCtx;
  narrow: boolean;
  sheet: 'collapsed' | 'medium' | 'expanded';
  onClose: () => void;
};

const STEPS = ['النطاق', 'المدة', 'الموقع ومنطقتا الانتشار', 'المسار والإرسال'];
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const parse = (s: string) => Date.parse(s + 'T06:00:00Z');

/**
 * «طلب إعادة تمركز» in four steps, for ONE proposed site (owner correction of 3 Nov 2026). Step 3 drives the application's
 * own polygon engine for the site — a moved copy of the current footprint, or a newly drawn boundary — and for its
 * deployment areas. The site has no distance rule from the current stationing; its footprint must stay within the
 * administrator's maximum area. Step 4 shows the approval path derived from the hierarchy and who takes part.
 */
export function RequestEditor({ world, setWorld, map, id, actor, step, setStep, target, setTarget, symbols, act, ask, ctx, narrow, sheet, onClose }: Props) {
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
  const drawing = step === 3 && editable;
  const [siteMode, setSiteMode] = useState<'move' | 'draw'>('move');

  // the polygon engine for the proposed site: no configured range — its distance from the current site is information
  useEffect(() => {
    if (!map || !drawing || target !== 'SITE') return;
    const req = latest.current.requests.find((x) => x.id === id)!;
    const origin = centroid(mainSiteOf(latest.current, req.org)!.ring);
    const busy = SITES.filter((s) => s.status === 'BUSY' && s.ring).map((s) => ({ name: s.name, rings: [s.ring!] }));
    const ed = new FootprintEditor(map, {
      origin,
      symbolHtml: symbolHtml(symbols.get(req.org)),
      range: () => null,
      busy: () => busy,
      paused: () => false,
      onLive: (l, final) => {
        if (final && l.ring) {
          const ring: Ring = l.ring.map((p) => ({ ...p }));
          update((x) => {
            x.proposal.ring = ring;
          });
        }
      },
    });
    const ring = req.proposal.ring;
    if (siteMode === 'draw') ed.startDraw(DRAW_VERTICES);
    else ed.startMove(ring, centroid(ring));
    map.flyToBounds(L.latLngBounds([...ring.map((p) => [p.lat, p.lng] as L.LatLngTuple), [origin.lat, origin.lng]]), {
      ...fitPadding(window.innerWidth <= 900),
      maxZoom: 15,
      duration: 0.4,
    });
    return () => ed.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, step, editable, target, siteMode]);

  // the polygon engine for one deployment area
  const vertexToggle = useAreaEngine(
    map,
    drawing && target !== 'SITE',
    step + ':' + target,
    () => {
      const w = latest.current;
      const x = w.requests.find((q) => q.id === id)!;
      const prof = profileByVersion(w, requirementOf(w, x).profile);
      const area = target as AreaRole;
      return {
        from: area === 'PRIMARY_AREA' ? x.proposal.ring : (x.proposal.areas?.PRIMARY_AREA ?? null),
        range: area === 'PRIMARY_AREA' ? prof.siteToPrimaryArea : prof.primaryAreaToAlternativeArea,
        measure: prof.measure,
        ring: x.proposal.areas?.[area],
        symbol: symbolHtml(symbols.get(x.org)),
        busy: areaObstacles(w, x.org),
      };
    },
    (ring) =>
      update((x) => {
        x.proposal.areas = { ...x.proposal.areas, [target]: ring };
      }),
  );

  // on a phone, a new sheet height re-fits the proposal so it stays visible and draggable above the sheet
  useEffect(() => {
    if (!map || !narrow || step !== 3 || target !== 'SITE') return;
    const req = latest.current.requests.find((x) => x.id === id)!;
    const ring = req.proposal.ring;
    const origin = centroid(mainSiteOf(latest.current, req.org)!.ring);
    const t = requestAnimationFrame(() =>
      map.flyToBounds(L.latLngBounds([...ring.map((p) => [p.lat, p.lng] as L.LatLngTuple), [origin.lat, origin.lng]]), { ...fitPadding(true), maxZoom: 15, duration: 0.3 }),
    );
    return () => cancelAnimationFrame(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet]);

  const units = descendants(world, r.org).filter((u) => holds(world, actor, 'CREATE', u));
  const cmp = comparison(world, r);
  const req = requirementOf(world, r);
  const required = req.areas.value === 'REQUIRED';
  const nowAreas = policyAt(world, 'stationing_areas_requirement');
  const nowMax = policyAt(world, 'max_restationing_footprint_area');
  const changedSinceDraft = !r.policy && r.createdUnder && (r.createdUnder.areas !== nowAreas.version || r.createdUnder.maxArea !== nowMax.version);
  const durationOk = r.duration.type === 'PERMANENT' || (r.duration.end !== undefined && r.duration.end > r.duration.start);
  const scopeOk = r.scope.whole || r.scope.units.length > 0;
  const siteOk = cmp.proposed.shapeOk && cmp.proposed.areaOk && cmp.proposed.conflicts.length === 0;
  const pairOk = pairAcceptable(cmp.areas, required);
  const canNext = step === 1 ? scopeOk : step === 2 ? durationOk : step === 3 ? siteOk && pairOk : false;
  const returned = r.state === 'RETURNED_FOR_CHANGES';
  const changed = changedFacts(r);
  const submit = returned ? check(world, actor, { t: 'RESUBMIT', req: id, changed, reason: 'سبب للتحقق' }) : check(world, actor, { t: 'SUBMIT', req: id });

  const readout = (
    <div className={'ux-readout ' + (siteOk ? 'ok' : 'bad')} data-testid="readout-site">
      <dl className="md-dl">
        <dt>المسافة من الموقع الحالي</dt>
        <dd>
          <b>{formatKm(cmp.proposed.fromCurrent)}</b> <small data-testid="no-site-rule">— للمعلومة فقط؛ لا قاعدة مسافة لإعادة التمركز</small>
        </dd>
        <dt>المساحة</dt>
        <dd className={cmp.proposed.areaOk ? 'good' : 'bad'} data-testid="site-area">
          {formatArea(cmp.proposed.area)} · الحد {formatArea(cmp.proposed.max)} (الإصدار {cmp.proposed.maxVersion}) {cmp.proposed.areaOk ? '✓' : '✕ تتجاوز الحد'}
        </dd>
        <dt>الشكل</dt>
        <dd className={cmp.proposed.shapeOk ? 'good' : 'bad'}>{cmp.proposed.shapeOk ? 'سليم' : 'متقاطع ذاتياً'}</dd>
        <dt>الإتاحة</dt>
        <dd className={cmp.proposed.conflicts.length ? 'bad' : 'good'}>{cmp.proposed.conflicts.length ? 'تعارض: ' + cmp.proposed.conflicts.join('، ') : 'لا تعارض'}</dd>
      </dl>
      {!cmp.proposed.areaOk && (
        <p className="md-why" data-testid="area-limit">
          المساحة تتجاوز الحد الذي هيأه مسؤول النظام؛ لا يُصغَّر الشكل تلقائياً. ارسم حدوداً جديدة أو عدّل الرؤوس.
        </p>
      )}
    </div>
  );

  // how the proposed site is set: a moved copy of the current boundary, or a newly drawn one (also in the phone's compact sheet)
  const siteModeSwitch = (
    <div className="ux-seg" role="radiogroup" aria-label="طريقة تحديد الموقع">
      <button role="radio" aria-checked={siteMode === 'move'} className={siteMode === 'move' ? 'on' : ''} onClick={() => setSiteMode('move')} data-site-mode="move">
        نقل نسخة من الحدود
      </button>
      <button role="radio" aria-checked={siteMode === 'draw'} className={siteMode === 'draw' ? 'on' : ''} onClick={() => setSiteMode('draw')} data-site-mode="draw">
        رسم حدود جديدة
      </button>
    </div>
  );
  const compact = narrow && drawing;
  const liveText = () => {
    if (target === 'SITE') return formatKm(cmp.proposed.fromCurrent) + ' من الحالي (للمعلومة) · ' + formatArea(cmp.proposed.area) + (cmp.proposed.areaOk ? ' ✓' : ' ✕ الحد') + ' · ' + (cmp.proposed.conflicts.length ? 'تعارض' : 'لا تعارض');
    const rel = target === 'PRIMARY_AREA' ? cmp.areas.siteToPrimary : cmp.areas.primaryToAlternative;
    return AREA_LABEL[target] + ': ' + (rel ? formatKm(rel.dist) + (rel.ok ? ' ✓' : ' ✕') : 'انقر الرؤوس لرسمها');
  };
  const packageText = () => {
    const a = cmp.areas;
    if (a.present === 'NONE') return required ? { ok: false, t: 'غير مرسومة — مطلوبة' } : { ok: true, t: 'بلا منطقتي انتشار — السياسة اختيارية' };
    if (a.present === 'PARTIAL') return { ok: false, t: 'إحداهما وحدها — حزمة واحدة' };
    return a.problems.length ? { ok: false, t: a.problems[0] } : { ok: true, t: 'مكتملتان وضمن قيم الملف' };
  };
  const pkg = packageText();

  return (
    <section className="ux-card md-card md-editor" aria-label="طلب إعادة تمركز">
      {compact && (
        <div className="md-compact" data-testid="compact-status">
          <div className="md-compact-row">
            <div className="md-compact-head">
              <b>
                {step}/4 {STEPS[step - 1]}
              </b>
              {target === 'SITE' && editable && (
                <button className="ux-link md-mode-toggle" onClick={() => setSiteMode(siteMode === 'move' ? 'draw' : 'move')} data-site-mode={siteMode === 'move' ? 'draw' : 'move'}>
                  {siteMode === 'move' ? '✎ رسم حدود جديدة' : '⇄ نقل نسخة من الحدود'}
                </button>
              )}
            </div>
            <span className={siteOk && pairOk ? 'good' : 'bad'} data-testid="compact-readout">
              {liveText()}
            </span>
          </div>
          <TargetSwitch target={target} setTarget={setTarget} hasPrimary={!!cmp.areas.siteToPrimary} editable={editable} compact />
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
      <div className="md-chips">
        <PolicyBadge w={world} req={req} pinned={!!r.policy} />
      </div>
      {changedSinceDraft && (
        <div className="md-alert warn" data-testid="policy-changed">
          تغيّرت سياسات التمركز منذ فتح هذه المسودة: منطقتا الانتشار الآن {AREQ_LABEL[nowAreas.value as 'REQUIRED' | 'OPTIONAL']} (الإصدار {nowAreas.version})، وحد المساحة {formatArea(nowMax.value as number)} (الإصدار{' '}
          {nowMax.version}). تُطبَّق النسخ النافذة عند الإرسال، ثم تثبت للطلب.
        </div>
      )}
      {returned && (
        <div className="md-alert warn" data-testid="returned">
          معاد للتعديل. يُفحص عند إعادة الإرسال بالإصدارات المثبَّتة له. ما تغيّر حتى الآن: {changed.length ? changed.map((f) => FACT_LABEL[f]).join('، ') : 'لا شيء'}.
        </div>
      )}
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
              ? 'الدائم يصير التمركز الحالي عند التفعيل المستقل، ويبقى السابق في التاريخ. لا عودة تلقائية؛ أي نقل لاحق بطلب جديد.'
              : 'المؤقت طبقة فوق التمركز الأصلي: لا يُنهيه، ويعود النطاق إليه عند النهاية المعتمدة بانتقال نظام مُدقَّق.'}{' '}
            سياسات التمركز نفسها للدائم والمؤقت.
          </p>
        </div>
      )}

      {step === 3 && (
        <div className="md-block" data-testid="step-site">
          <TargetSwitch target={target} setTarget={setTarget} hasPrimary={!!cmp.areas.siteToPrimary} editable={editable} />
          {target === 'SITE' && (
            <>
              {editable && siteModeSwitch}
              <p className="ux-hint">
                {siteMode === 'move'
                  ? 'اسحب المساحة المقترحة على الخريطة؛ تنتقل كاملة بشكلها. الحدود الزرقاء هي التمركز الحالي ولا تتغير.'
                  : 'انقر ' + DRAW_VERTICES + ' رؤوس على الخريطة لرسم حدود الموقع المقترح؛ تُقاس مساحتها بحد مسؤول النظام.'}
              </p>
              {readout}
            </>
          )}
          <AreaPairPanel
            check={cmp.areas}
            required={required}
            target={target}
            editable={editable}
            vertexToggle={vertexToggle}
            onClear={() => {
              setTarget('SITE');
              update((x) => void (x.proposal.areas = undefined));
            }}
          />
        </div>
      )}
      {step === 4 && (
        <div className="md-block" data-testid="step-compare">
          <div className="md-chips">
            <span className="md-tagline">{r.scope.whole ? 'الجهة كاملة' : 'جزء: ' + r.scope.units.map(orgName).join('، ')}</span>
            <span className="md-tagline">{r.duration.type === 'PERMANENT' ? 'دائم من ' + iso(r.duration.start) : 'مؤقت ' + iso(r.duration.start) + ' ← ' + iso(r.duration.end!)}</span>
          </div>
          <CompareTable w={world} r={r} />
          <RoutePanel c={ctx} r={r} />
          <ul className="md-list md-checklist" data-testid="submit-checklist">
            <li className={siteOk ? 'good' : 'bad'} data-ok={siteOk}>
              {siteOk ? '✓' : '✕'} الموقع المقترح: {cmp.proposed.areaOk ? formatArea(cmp.proposed.area) + ' ضمن الحد' : 'المساحة تتجاوز الحد ' + formatArea(cmp.proposed.max)}
              {cmp.proposed.conflicts.length ? ' · تعارض' : ''}
            </li>
            <li className={pkg.ok ? 'good' : 'bad'} data-ok={pkg.ok}>
              {pkg.ok ? '✓' : '✕'} منطقتا الانتشار: {pkg.t}
            </li>
          </ul>
          <div className="ux-actions sticky">
            {returned ? (
              <button
                className="ux-btn primary"
                disabled={!submit.ok || !siteOk || !pairOk}
                onClick={() =>
                  ask({
                    action: { t: 'RESUBMIT', req: id, changed, reason: '' },
                    title: 'إعادة إرسال الطلب',
                    record: r.number + ' · ما تغيّر: ' + (changed.length ? changed.map((f) => FACT_LABEL[f]).join('، ') : 'لا شيء'),
                    consequence: 'تُبطل قرارات المراحل التي تعتمد على ما تغيّر وتُعاد، وتُحمل غيرها (D18). يُفحص بالإصدارات المثبَّتة للطلب.',
                    kind: 'normal',
                    confirm: 'إعادة الإرسال',
                  })
                }
                data-act="RESUBMIT"
              >
                إعادة الإرسال
              </button>
            ) : (
              <button className="ux-btn primary" disabled={!submit.ok || !siteOk || !pairOk || !durationOk || !scopeOk} onClick={() => act({ t: 'SUBMIT', req: id })} data-act="SUBMIT">
                إرسال للاعتماد (محاكاة)
              </button>
            )}
          </div>
          {!submit.ok && (
            <p className="md-why" data-testid="submit-why">
              {submit.reason}
            </p>
          )}
          <p className="ux-note">
            في التطبيق: يتحقق الخادم من حد المساحة ومن علاقتي منطقتي الانتشار بملف السياسة المنشور وبطريقة قياسه، ويثبّت الإصدارات للطلب، ويشتق المسار من الهيكل. لا يتغير التمركز قبل الاعتماد والتفعيل المستقل.
          </p>
        </div>
      )}

      {step < 4 && !compact && (
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
