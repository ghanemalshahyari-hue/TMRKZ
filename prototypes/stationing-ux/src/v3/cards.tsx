import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { FootprintLive } from '../../../../frontend/src/components/stationing/FootprintEditor';
import { areaM2, centroid, formatArea, moveRigid } from '../../../../frontend/src/lib/footprint';
import { distanceM } from '../../../../frontend/src/lib/geo';
import {
  DAY,
  activeAreas,
  affectedSites,
  ancestors,
  check,
  children,
  currentStage,
  deriveRoute,
  descendants,
  effectiveOf,
  inRequesterScope,
  linkedTo,
  occupancyAt,
  isUnder,
  occupantsOf,
  orgOf,
  permanentOf,
  personOf,
  policyAt,
  policyOfRequest,
  presetScope,
  responsibleOf,
  siteOf,
  siteOfOrg,
  stageDeciders,
  otherBranchOccupants,
  HIERARCHY_CHANGED,
  type CrossAuthority,
  validate,
  type Action,
  type Content,
  type Fact,
  type LegCheck,
  type OccupantDecision,
  type Person,
  type PolicyValues,
  type ReqState,
  type Request,
  type ScopePreset,
  type World,
} from './domain';
import { COMPARE_BAND, comparison } from './compare';
import { METHOD_LABEL, equivalentRadius, type Method } from './measure';
import type { Sel, Step } from './scenarios';

export type EditorApi = {
  live: FootprintLive | null;
  undo: () => void;
  redo: () => void;
  reset: () => void;
  vertices: (on: boolean) => void;
  drawNew: () => void;
  focus: () => void;
  resize: (radiusM: number) => void;
  remove: () => void;
};
export type Ask = { title: string; record: string; consequence: string; confirm: string; kind: 'normal' | 'auth' | 'destructive'; needsReason: boolean; run: (reason: string) => void };
export type Ctx = {
  w: World;
  actor: string;
  me: Person;
  sel: Sel;
  select: (s: Sel) => void;
  act: (a: Action, who?: string) => boolean;
  edit: (fn: (r: Request) => Content) => void;
  ask: (a: Ask) => void;
  editor: EditorApi;
  legState: LegCheck | null;
  notice: string | null;
  setNotice: (s: string | null) => void;
};

// ---- labels ----
const short = (name: string) => name.split(' — ')[0];
const km = (m: number) => (m / 1000).toLocaleString('ar', { maximumFractionDigits: 2 }) + ' كم';
const day = (t: number) => new Date(t).toLocaleDateString('ar-AE', { day: 'numeric', month: 'short', year: 'numeric' });
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const fromIso = (s: string) => Date.parse(s + 'T06:00:00Z');
export const FACT: Record<Fact, string> = { SCOPE: 'النطاق', CLASSIFICATION: 'دائم/مؤقت', DURATION: 'المدة', SITE: 'الموقع', DEPLOYMENT: 'الانتشار', AVAILABILITY: 'الإتاحة' };
const STATE: Record<ReqState, string> = {
  DRAFT: 'مسودة',
  UNDER_REVIEW: 'قيد الاعتماد',
  RETURNED_FOR_CHANGES: 'معاد للتعديل',
  PAUSED_HIERARCHY_CHANGED: 'موقوف — تغيّر الهيكل',
  REJECTED: 'مرفوض',
  APPROVED_NOT_ACTIVATED: 'معتمد — بانتظار التفعيل',
  ACTIVATED_PERMANENT: 'مفعّل — دائم',
  TEMPORARY_SCHEDULED: 'مؤقت مجدول',
  ACTIVE_TEMPORARY: 'مؤقت نافذ',
  TEMPORARY_RETURNED: 'انتهى المؤقت — عادت الوحدات',
  TEMPORARY_CANCELLED_BEFORE_START: 'أُلغي قبل البدء',
};
const LEG_STATUS: Record<LegCheck['status'], [string, string]> = {
  NOT_PLACED: ['لم تُوضع بعد', 'idle'],
  OK: ['ضمن النطاق المسموح', 'ok'],
  NEEDS_EXCEPTION: ['خارج النطاق — ممكن باستثناء معتمد', 'warn'],
  OUT_OF_RANGE: ['خارج النطاق المسموح', 'bad'],
  TERRAIN_TIE: ['تعادل فئات أرض دون ترتيب أولوية صالح — يُمنع الإرسال', 'bad'],
};
const orgName = (w: World, id: string) => orgOf(w, id)?.name ?? id;
const Lv = ({ w, id }: { w: World; id: string }) => <span className="v3-lv">L{orgOf(w, id)?.level}</span>;

function Section({ title, children, hint }: { title: string; children: ReactNode; hint?: string }) {
  return (
    <section className="v3-sec">
      <h3>{title}</h3>
      {hint && <p className="v3-hint">{hint}</p>}
      {children}
    </section>
  );
}

/** A button whose availability is the simulated server guard for the current person, with the reason when refused. */
function Act({ ctx, a, label, primary, danger, onClick }: { ctx: Ctx; a: Action; label: string; primary?: boolean; danger?: boolean; onClick?: () => void }) {
  const v = check(ctx.w, ctx.actor, a);
  return (
    <div className="v3-act">
      <button type="button" className={'v3-btn' + (primary ? ' primary' : '') + (danger ? ' danger' : '')} disabled={!v.ok} data-act={a.t} onClick={onClick ?? (() => ctx.act(a))}>
        {label}
      </button>
      {!v.ok && <small className="v3-why">{v.reason}</small>}
    </div>
  );
}

export function Cards({ ctx }: { ctx: Ctx }) {
  const s = ctx.sel;
  const body = (() => {
    if (!s) return <Home ctx={ctx} />;
    if (s.k === 'site') return <SiteCard ctx={ctx} id={s.id} />;
    if (s.k === 'org') return <OrgCard ctx={ctx} id={s.id} />;
    if (s.k === 'policy') return <PolicyCard ctx={ctx} />;
    if (s.k === 'links') return <LinksCard ctx={ctx} />;
    if (s.k === 'compare') return <CompareCard />;
    const r = ctx.w.requests.find((x) => x.id === s.id);
    if (!r) return <Home ctx={ctx} />;
    if (s.k === 'edit' && (r.state === 'DRAFT' || r.state === 'RETURNED_FOR_CHANGES' || r.state === 'PAUSED_HIERARCHY_CHANGED')) return <Wizard ctx={ctx} r={r} step={s.step} />;
    return <RequestCard ctx={ctx} r={r} />;
  })();
  return (
    <div className="v3-card" data-card={s?.k ?? 'home'}>
      {s && (
        <button type="button" className="v3-back" onClick={() => ctx.select(null)}>
          → الرئيسية
        </button>
      )}
      {body}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------

function newRequest(ctx: Ctx, anchor: string) {
  const id = 'r-new-' + (ctx.w.requests.length + 1);
  const content: Content = { kind: 'PERMANENT', start: ctx.w.now + 7 * DAY, scope: [anchor], occupants: {}, site: null, primary: null, alternative: null, exceptions: {}, reason: '' };
  if (ctx.act({ t: 'CREATE', id, content })) ctx.select({ k: 'edit', id, step: 'SCOPE' });
}

function Home({ ctx }: { ctx: Ctx }) {
  const { w } = ctx;
  const [q, setQ] = useState('');
  const roots = w.orgs.filter((o) => !o.parentId);
  const hits = q.trim()
    ? [...w.orgs.filter((o) => o.name.includes(q.trim())).map((o) => ({ k: 'org' as const, id: o.id, label: o.name, sub: 'وحدة · L' + o.level + ' · ' + short(siteOfOrg(w, o.id)?.name ?? '—') })), ...w.sites.filter((s) => s.name.includes(q.trim())).map((s) => ({ k: 'site' as const, id: s.id, label: s.name, sub: 'موقع · ' + occupantsOf(w, s.id).length + ' وحدة' }))]
    : [];
  const mine = w.requests.filter((r) => r.requester === ctx.actor || (r.state === 'UNDER_REVIEW' && stageDeciders(w, r, currentStage(r)!).some((p) => p.id === ctx.actor)) || r.state === 'APPROVED_NOT_ACTIVATED');
  return (
    <>
      <h2>مساحة التمركز</h2>
      <p className="v3-sub">اختر موقعاً على الخريطة أو وحدة من الهيكل، ثم «إعادة تمركز».</p>
      <div className="v3-search">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ابحث عن وحدة أو موقع" aria-label="بحث" data-testid="search" />
        {hits.length > 0 && (
          <ul>
            {hits.slice(0, 8).map((h) => (
              <li key={h.k + h.id}>
                <button type="button" onClick={() => ctx.select({ k: h.k, id: h.id })}>
                  <b>{h.label}</b>
                  <small>{h.sub}</small>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {mine.length > 0 && (
        <Section title="طلبات تخصك">
          <ul className="v3-list">
            {mine.map((r) => (
              <li key={r.id}>
                <button type="button" className="v3-row" onClick={() => ctx.select(r.state === 'DRAFT' || r.state === 'RETURNED_FOR_CHANGES' ? { k: 'edit', id: r.id, step: 'REVIEW' } : { k: 'req', id: r.id })}>
                  <b>{r.number}</b> <span className={'v3-state s-' + r.state}>{STATE[r.state]}</span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section title="الهيكل التنظيمي" hint={'من Oracle — ' + w.oracle.source + ' · آخر استخراج ' + day(w.oracle.extractAt) + ' · ' + w.oracle.rows + ' صفاً'}>
        <ul className="v3-tree" data-testid="org-tree">
          {roots.map((o) => (
            <TreeNode key={o.id} ctx={ctx} id={o.id} depth={0} />
          ))}
        </ul>
      </Section>
    </>
  );
}

function TreeNode({ ctx, id, depth }: { ctx: Ctx; id: string; depth: number }) {
  const { w } = ctx;
  const kids = children(w, id);
  const [open, setOpen] = useState(depth < 2);
  const site = siteOfOrg(w, id);
  return (
    <li>
      <div className="v3-tree-row">
        {kids.length ? (
          <button type="button" className="v3-tw" aria-expanded={open} aria-label={open ? 'طي' : 'توسيع'} onClick={() => setOpen(!open)}>
            {open ? '▾' : '◂'}
          </button>
        ) : (
          <span className="v3-tw" />
        )}
        <button type="button" className="v3-tree-name" onClick={() => ctx.select({ k: 'org', id })}>
          {orgName(w, id)} <Lv w={w} id={id} />
        </button>
        {site && (
          <button type="button" className="v3-site-chip" onClick={() => ctx.select({ k: 'site', id: site.id })} title={site.name}>
            {short(site.name)}
          </button>
        )}
      </div>
      {open && kids.length > 0 && (
        <ul>
          {kids.map((k) => (
            <TreeNode key={k.id} ctx={ctx} id={k.id} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** The occupants of one site as a forest: organisational nesting where it exists, separate roots where it does not. */
function occupantForest(w: World, site: string) {
  const occ = occupantsOf(w, site);
  const set = new Set(occ);
  const parentIn = (id: string) => ancestors(w, id).find((a) => set.has(a.id))?.id ?? null;
  const roots = occ.filter((o) => !parentIn(o));
  const kids = (p: string) => occ.filter((o) => parentIn(o) === p);
  return { roots, kids };
}

function SiteCard({ ctx, id }: { ctx: Ctx; id: string }) {
  const { w } = ctx;
  const s = siteOf(w, id);
  if (!s) return null;
  const { roots, kids } = occupantForest(w, id);
  const resp = responsibleOf(w, id);
  const related = roots.flatMap((r) => [r, ...descendants(w, r)]).filter((d) => siteOfOrg(w, d) && siteOfOrg(w, d)!.id !== id);
  const anchor = roots.find((r) => inRequesterScope(w, ctx.me, r)) ?? occupantsOf(w, id).find((o) => inRequesterScope(w, ctx.me, o));
  const row = (o: string, depth: number): ReactNode => {
    const st = effectiveOf(w, o);
    return (
      <li key={o}>
        <div className="v3-occ" style={{ paddingInlineStart: depth * 16 }}>
          <button type="button" className="v3-tree-name" onClick={() => ctx.select({ k: 'org', id: o })}>
            {depth > 0 && <span className="v3-branch">└</span>}
            {orgName(w, o)} <Lv w={w} id={o} />
          </button>
          {depth > 0 && !occupantsOf(w, id).includes(orgOf(w, o)?.parentId ?? '') && <small className="v3-hint">عبر {orgName(w, orgOf(w, o)!.parentId!)}</small>}
          {st?.kind === 'TEMPORARY' && <span className="v3-badge temp">مؤقت</span>}
        </div>
        {kids(o).length > 0 && <ul>{kids(o).map((k) => row(k, depth + 1))}</ul>}
      </li>
    );
  };
  return (
    <>
      <h2>{s.name}</h2>
      <p className="v3-sub">
        {s.id} · {s.source.system === 'TMRKZ' ? 'سجل موقع في TMRKZ' : 'من ' + s.source.system + ' · المعرّف الخارجي ' + (s.source as { externalId: string }).externalId}
        {s.source.system !== 'TMRKZ' && (s.source as { readOnlyGeometry: boolean }).readOnlyGeometry ? ' · الحدود للقراءة فقط' : ''}
      </p>
      <Section title={'الوحدات المتمركزة فيه (' + occupantsOf(w, id).length + ')'} hint={roots.length > 1 ? 'في الموقع جهات غير مترابطة تنظيمياً: الوجود في موقع واحد لا يعني التبعية.' : undefined}>
        <ul className="v3-occ-list" data-testid="occupants">
          {roots.map((r, i) => (
            <li key={r} className={i > 0 ? 'unrelated' : ''}>
              {i > 0 && <span className="v3-badge other">غير تابعة — {orgName(w, ancestors(w, r).slice(-2)[0]?.id ?? r)}</span>}
              <ul>{row(r, 0)}</ul>
            </li>
          ))}
        </ul>
      </Section>
      {related.length > 0 && (
        <Section title="تابعون في مواقع أخرى">
          <ul className="v3-list">
            {related.map((d) => (
              <li key={d} className="v3-rel">
                <button type="button" className="v3-site-chip" onClick={() => ctx.select({ k: 'site', id: siteOfOrg(w, d)!.id })}>
                  {short(siteOfOrg(w, d)!.name)}
                </button>
                {orgName(w, d)} <Lv w={w} id={d} />
              </li>
            ))}
          </ul>
        </Section>
      )}
      {linkedTo(w, id).length > 0 && (
        <Section title={'وحدات مرتبطة بالموقع (' + linkedTo(w, id).length + ')'} hint="ارتباط بالموقع فقط: ليس تمركزاً ولا إشغالاً، ولا يحجب الأرض (O-15).">
          <ul className="v3-list" data-testid="linked">
            {linkedTo(w, id).map((o) => (
              <li key={o} className="v3-rel">
                {orgName(w, o)} <Lv w={w} id={o} />
                <small className="v3-hint">· متمركزة في {short(siteOfOrg(w, o)?.name ?? '—')}</small>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {occupancyAt(w, id).length > 0 && (
        <Section title="إشغال معتمد (غير التمركز)" hint="سجل إشغال معتمد يحجب الأرض في فحص التداخل.">
          <ul className="v3-list" data-testid="occupancy">
            {occupancyAt(w, id).map((o) => (
              <li key={o.id}>
                {o.kind === 'RESERVATION' ? 'حجز' : 'استخدام معتمد'} · {orgName(w, o.org)} · حتى {o.to ? day(o.to) : '—'} · {o.reference}
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section title="المسؤولية عن المرفق" hint="سجل مستقل: إعادة التمركز لا تغيّره.">
        <p>{resp ? orgName(w, resp.org) : 'غير محددة'}</p>
      </Section>
      {activeAreas(w, id).length > 0 && (
        <Section title="مناطق الانتشار">
          <ul className="v3-list">
            {activeAreas(w, id).map((a) => (
              <li key={a.id}>{a.role === 'PRIMARY' ? 'الرئيسية' : 'البديلة'} · {formatArea(areaM2(a.ring))}</li>
            ))}
          </ul>
        </Section>
      )}
      <div className="v3-actions">
        <button type="button" className="v3-btn primary" disabled={!anchor} onClick={() => anchor && newRequest(ctx, anchor)} data-testid="restation">
          إعادة تمركز
        </button>
        {!anchor && <small className="v3-why">لا وحدة في نطاقك في هذا الموقع.</small>}
      </div>
    </>
  );
}

function OrgCard({ ctx, id }: { ctx: Ctx; id: string }) {
  const { w } = ctx;
  const o = orgOf(w, id);
  if (!o) return null;
  const perm = permanentOf(w, id);
  const eff = effectiveOf(w, id);
  const site = siteOfOrg(w, id);
  const co = site ? occupantsOf(w, site.id).filter((x) => x !== id) : [];
  const responsible = w.responsibilities.filter((r) => r.org === id && r.to == null).map((r) => r.site);
  const history = w.stationings.filter((s) => s.org === id && s.state === 'ENDED');
  const sub = (p: string, depth: number): ReactNode =>
    children(w, p).map((c) => (
      <li key={c.id}>
        <div className="v3-occ" style={{ paddingInlineStart: depth * 16 }}>
          <button type="button" className="v3-tree-name" onClick={() => ctx.select({ k: 'org', id: c.id })}>
            <span className="v3-branch">└</span>
            {c.name} <Lv w={w} id={c.id} />
          </button>
          {siteOfOrg(w, c.id) && (
            <button type="button" className={'v3-site-chip' + (siteOfOrg(w, c.id)!.id === site?.id ? ' same' : '')} onClick={() => ctx.select({ k: 'site', id: siteOfOrg(w, c.id)!.id })}>
              {siteOfOrg(w, c.id)!.id === site?.id ? 'معها · ' : ''}
              {short(siteOfOrg(w, c.id)!.name)}
            </button>
          )}
        </div>
        <ul>{sub(c.id, depth + 1)}</ul>
      </li>
    ));
  return (
    <>
      <p className="v3-crumbs">{[...ancestors(w, id)].reverse().map((a) => a.name).join(' ‹ ')}</p>
      <h2>
        {o.name} <Lv w={w} id={id} />
      </h2>
      <p className="v3-sub">
        Oracle {o.oracleId} · {o.code} · الهيكل من Oracle (قراءة فقط)
      </p>
      <Section title="التمركز الحالي">
        {eff?.kind === 'TEMPORARY' ? (
          <p>
            مؤقتاً في <b>{short(siteOf(w, eff.site)!.name)}</b> حتى {day(eff.plannedEnd!)} · التمركز الأصلي المحفوظ: {short(siteOf(w, perm!.site)!.name)}
          </p>
        ) : site ? (
          <p>
            <button type="button" className="v3-site-chip" onClick={() => ctx.select({ k: 'site', id: site.id })}>
              {site.name}
            </button>{' '}
            دائم منذ {day(perm!.from)}
          </p>
        ) : (
          <p>غير مسجل</p>
        )}
        {co.length > 0 && <p className="v3-hint">معها في الموقع نفسه: {co.map((c) => orgName(w, c) + (isUnder(w, c, id) ? '' : ' (غير تابعة)')).join('، ')}</p>}
      </Section>
      {children(w, id).length > 0 && (
        <Section title="الوحدات التابعة ومواقعها" hint="الارتباط التنظيمي من Oracle؛ المواقع قد تختلف.">
          <ul className="v3-occ-list" data-testid="children">
            {sub(id, 0)}
          </ul>
        </Section>
      )}
      {responsible.length > 0 && (
        <Section title="مسؤولة عن المرافق">
          <p>{responsible.map((s) => short(siteOf(w, s)!.name)).join('، ')}</p>
        </Section>
      )}
      {history.length > 0 && (
        <Section title="سجل التمركز">
          <ul className="v3-list">
            {history.map((h) => (
              <li key={h.id}>
                {short(siteOf(w, h.site)!.name)} · {h.kind === 'TEMPORARY' ? 'مؤقت' : 'دائم'} · حتى {h.to ? day(h.to) : '—'}
              </li>
            ))}
          </ul>
        </Section>
      )}
      <div className="v3-actions">
        <button type="button" className="v3-btn primary" disabled={!inRequesterScope(w, ctx.me, id)} onClick={() => newRequest(ctx, id)} data-testid="restation">
          إعادة تمركز
        </button>
        {!inRequesterScope(w, ctx.me, id) && <small className="v3-why">الوحدة خارج نطاق إنشاء الطلبات للشخص الحالي.</small>}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// The request flow: scope → type → drag the site → deployment (if required/chosen) → review → submit

const STEP_LABEL: Record<Step, string> = { SCOPE: 'من سينتقل', TYPE: 'دائم أو مؤقت', SITE: 'الموقع', PRIMARY: 'الانتشار الرئيسي', ALTERNATIVE: 'الانتشار البديل', REVIEW: 'مراجعة وإرسال' };

function Wizard({ ctx, r, step }: { ctx: Ctx; r: Request; step: Step }) {
  const { w } = ctx;
  const pol = policyOfRequest(w, r).values;
  const c = r.content;
  const [withDeploy, setWithDeploy] = useState(pol.deployment === 'REQUIRED' || !!c.primary || !!c.alternative);
  const steps: Step[] = ['SCOPE', 'TYPE', 'SITE', ...((withDeploy ? ['PRIMARY', 'ALTERNATIVE'] : ['PRIMARY']) as Step[]), 'REVIEW'];
  const go = (s: Step) => {
    // the proposed site starts as a COPY of the current footprint, at the same place (§14)
    if ((s === 'SITE' || steps.indexOf(s) > steps.indexOf('SITE')) && !c.site) {
      const from = siteOfOrg(w, c.scope[0])!;
      ctx.edit((q) => ({ ...q.content, site: { ring: from.ring.map((p) => ({ ...p })), copiedFrom: from.id, shape: 'COPY' } }));
    }
    ctx.select({ k: 'edit', id: r.id, step: s });
  };
  const i = steps.indexOf(step);
  const own = r.requester === ctx.actor;
  return (
    <>
      <h2>
        إعادة تمركز · {r.number} <span className={'v3-state s-' + r.state}>{STATE[r.state]}</span>
      </h2>
      {r.state === 'PAUSED_HIERARCHY_CHANGED' && (
        <p className="v3-returned" data-testid="paused">
          <b>{HIERARCHY_CHANGED}</b> — راجِع الطلب وأكّده؛ يُعاد بناء المسار من الوحدة الطالبة بالهيكل الجديد.
        </p>
      )}
      {r.state === 'RETURNED_FOR_CHANGES' && r.returned && (
        <p className="v3-returned" data-testid="returned">
          أعاده «{r.stages.find((s) => s.key === r.returned!.stage)?.label}»: {r.returned.reason}
          <br />
          تعديل الطلب نفسه — لا يُنشأ طلب جديد، وتبقى القرارات التي لا تتأثر بالتعديل.
        </p>
      )}
      {!own && <p className="v3-why">يعدّل الطلبَ مقدمُه ({personOf(w, r.requester).name}) فقط.</p>}
      <ol className="v3-steps" data-testid="steps">
        {steps.map((s, n) => (
          <li key={s} className={s === step ? 'on' : n < i ? 'done' : ''}>
            <button type="button" onClick={() => go(s)} aria-current={s === step ? 'step' : undefined}>
              <span>{n + 1}</span>
              {STEP_LABEL[s]}
            </button>
          </li>
        ))}
      </ol>
      {step === 'SCOPE' && <ScopeStep ctx={ctx} r={r} />}
      {step === 'TYPE' && <TypeStep ctx={ctx} r={r} />}
      {step === 'SITE' && <SiteStep ctx={ctx} r={r} />}
      {(step === 'PRIMARY' || step === 'ALTERNATIVE') && <DeployStep ctx={ctx} r={r} leg={step === 'PRIMARY' ? 'primary' : 'alternative'} withDeploy={withDeploy} setWithDeploy={setWithDeploy} />}
      {step === 'REVIEW' && <ReviewStep ctx={ctx} r={r} />}
      <div className="v3-nav">
        <button type="button" className="v3-btn" disabled={i <= 0} onClick={() => go(steps[i - 1])}>
          السابق
        </button>
        {step !== 'REVIEW' && (
          <button type="button" className="v3-btn primary" onClick={() => go(steps[i + 1])} data-testid="next">
            التالي: {STEP_LABEL[steps[i + 1]]}
          </button>
        )}
      </div>
    </>
  );
}

function ScopeStep({ ctx, r }: { ctx: Ctx; r: Request }) {
  const { w } = ctx;
  const c = r.content;
  const anchor = c.scope[0] ?? '';
  const pol = policyOfRequest(w, r).values;
  const set = (scope: string[]) => ctx.edit((q) => ({ ...q.content, scope: [...new Set(scope)] }));
  const toggle = (id: string) => set(c.scope.includes(id) ? c.scope.filter((x) => x !== id) : [...c.scope, id]);
  const presets: [ScopePreset, string][] = [
    ['UNIT_ONLY', 'الوحدة فقط'],
    ['WITH_COLOCATED', '+ الموجودون معها'],
    ['WITH_ELSEWHERE', '+ التابعون في مواقع أخرى'],
    ['WHOLE_BRANCH', 'الفرع كاملاً'],
  ];
  const branchRoot = anchor;
  const here = siteOfOrg(w, branchRoot)?.id;
  // units of another branch at the affected sites: never moved without an explicit, audited decision (O-03)
  const unrelated = otherBranchOccupants(w, r.requestingUnit, c.scope.filter((o) => c.occupants[o] !== 'INCLUDED'));
  const AUTH: Record<CrossAuthority, string> = { OTHER_UNIT: 'معتمد الوحدة نفسها', OTHER_UNIT_PARENT: 'معتمد أبيها', SITE_RESPONSIBLE: 'معتمد المسؤول عن موقعها' };
  const staying = affectedSites(w, c.scope)
    .flatMap((a) => a.staying.map((o) => [o, a.site.id] as const))
    .filter(([o]) => !unrelated.includes(o));
  const decide = (o: string, d: OccupantDecision) =>
    ctx.edit((q) => {
      const scope = d === 'INCLUDED' ? [...q.content.scope, o] : q.content.scope.filter((x) => x !== o);
      return { ...q.content, occupants: { ...q.content.occupants, [o]: d }, scope: [...new Set(scope)] };
    });
  const node = (id: string, depth: number): ReactNode => (
    <li key={id}>
      <label className="v3-check" style={{ paddingInlineStart: depth * 16 }}>
        <input type="checkbox" checked={c.scope.includes(id)} onChange={() => toggle(id)} data-org={id} />
        <span>
          {orgName(w, id)} <Lv w={w} id={id} />
        </span>
        <span className={'v3-site-chip' + (siteOfOrg(w, id)?.id === here ? ' same' : '')}>{siteOfOrg(w, id)?.id === here && id !== branchRoot ? 'معها · ' : ''}{short(siteOfOrg(w, id)?.name ?? '—')}</span>
      </label>
      <ul>{children(w, id).map((k) => node(k.id, depth + 1))}</ul>
    </li>
  );
  const sites = affectedSites(w, c.scope);
  return (
    <>
      <Section title="من سينتقل؟" hint="اختيار سريع، ثم عدّل بالنقر. لا يُنقل أي تابع تلقائياً.">
        <div className="v3-chipset" data-testid="presets">
          {presets.map(([p, label]) => {
            const v = presetScope(w, branchRoot, p);
            const on = JSON.stringify([...v].sort()) === JSON.stringify([...c.scope.filter((x) => isUnder(w, x, branchRoot))].sort());
            return (
              <button key={p} type="button" className={'v3-chip' + (on ? ' on' : '')} onClick={() => set([...v, ...c.scope.filter((x) => !isUnder(w, x, branchRoot))])} data-preset={p}>
                {label}
              </button>
            );
          })}
        </div>
        <ul className="v3-tree check" data-testid="scope-tree">
          {node(branchRoot, 0)}
        </ul>
        <p className="v3-sum" data-testid="scope-sum">
          سينتقل {c.scope.length} {c.scope.length === 1 ? 'وحدة' : 'وحدات'} من {sites.length} {sites.length === 1 ? 'موقع' : 'مواقع'} إلى موقع واحد.
        </p>
      </Section>
      {unrelated.length > 0 && (
        <Section title="وحدات من فرع آخر في المواقع نفسها" hint={'لا تُنقل تلقائياً أبداً. ' + (pol.crossBranch.allowed ? 'الضم مسموح في الإعداد بموافقة: ' + pol.crossBranch.authorities.map((a) => AUTH[a]).join(' و') + '.' : 'الضم غير مسموح في الإعداد الحالي.')}>
          {unrelated.map((o) => (
            <fieldset key={o} className="v3-occ-decide" data-occupant={o}>
              <legend>
                {orgName(w, o)} <Lv w={w} id={o} /> · {short(siteOfOrg(w, o)!.name)}
              </legend>
              {(
                [
                  ['EXCLUDED', 'تبقى في موقعها'],
                  ['SEPARATE', 'تُعالج بطلب منفصل'],
                  ['INCLUDED', 'تُضم إلى هذا الطلب'],
                ] as const
              ).map(([d, label]) => (
                <label key={d} className={'v3-radio' + (d === 'INCLUDED' && !pol.crossBranch.allowed ? ' disabled' : '')}>
                  <input type="radio" name={'occ-' + o} checked={c.occupants[o] === d} disabled={d === 'INCLUDED' && !pol.crossBranch.allowed} onChange={() => decide(o, d)} />
                  {label}
                </label>
              ))}
              {!pol.crossBranch.allowed && <small className="v3-hint">«تُضم» معطلة: يفعّلها مسؤول النظام في السياسة (O-03).</small>}
              {c.occupants[o] === 'INCLUDED' && <small className="v3-hint">تُضاف إلى المسار مراحل: {pol.crossBranch.authorities.map((a) => AUTH[a]).join('، ')}. والقرار مسجل في التدقيق.</small>}
            </fieldset>
          ))}
        </Section>
      )}
      {staying.length > 0 && (
        <Section title="يبقون في مواقعهم">
          <ul className="v3-list">
            {staying.map(([o, s]) => (
              <li key={o}>
                {orgName(w, o)} · {short(siteOf(w, s)!.name)}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}

function TypeStep({ ctx, r }: { ctx: Ctx; r: Request }) {
  const c = r.content;
  const set = (p: Partial<Content>) => ctx.edit((q) => ({ ...q.content, ...p }));
  return (
    <>
      <Section title="نوع إعادة التمركز">
        <div className="v3-seg" role="radiogroup" data-testid="kind">
          {(
            [
              ['PERMANENT', 'دائم'],
              ['TEMPORARY', 'مؤقت'],
            ] as const
          ).map(([k, label]) => (
            <button key={k} type="button" role="radio" aria-checked={c.kind === k} className={c.kind === k ? 'on' : ''} onClick={() => set({ kind: k, end: k === 'TEMPORARY' ? c.end ?? c.start + 30 * DAY : undefined })} data-kind={k}>
              {label}
            </button>
          ))}
        </div>
        <p className="v3-hint">
          {c.kind === 'PERMANENT'
            ? 'يبقى التمركز الحالي نافذاً حتى الاعتماد النهائي والتفعيل المستقل، ثم يصبح الموقع الجديد هو التمركز الحالي ويُحفظ السابق في السجل.'
            : 'يُحفظ التمركز الأصلي كما هو. يبدأ المؤقت بعد اعتماده وتفعيله وحلول بدايته، وتعود الوحدات إلى تمركزها الأصلي تلقائياً عند النهاية المعتمدة ما لم يُفعَّل تمديد.'}
        </p>
        <div className="v3-dates">
          <label>
            {c.kind === 'PERMANENT' ? 'النفاذ المطلوب من' : 'من'}
            <input type="date" value={iso(c.start)} onChange={(e) => e.target.value && set({ start: fromIso(e.target.value) })} />
          </label>
          {c.kind === 'TEMPORARY' && (
            <label>
              حتى
              <input type="date" value={iso(c.end ?? c.start + 30 * DAY)} onChange={(e) => e.target.value && set({ end: fromIso(e.target.value) })} />
            </label>
          )}
        </div>
      </Section>
      <Section title="سبب الطلب">
        <textarea className="v3-text" rows={3} value={c.reason} onChange={(e) => set({ reason: e.target.value })} placeholder="مثال: تجميع الوحدات في موقع واحد" data-testid="reason" />
      </Section>
    </>
  );
}

function SiteStep({ ctx, r }: { ctx: Ctx; r: Request }) {
  const { w, editor } = ctx;
  const c = r.content;
  const pol = policyOfRequest(w, r);
  const v = validate(w, r);
  const [vertices, setVertices] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  if (!c.site) return <p className="v3-hint">…</p>;
  const area = areaM2(c.site.ring);
  const over = area > pol.values.maxFootprintAreaM2;
  const from = siteOf(w, c.site.copiedFrom);
  const dist = from ? distanceM(centroid(from.ring), centroid(c.site.ring)) : 0;
  const sources = affectedSites(w, c.scope).map((a) => a.site);
  return (
    <>
      <p className="v3-instruct" data-testid="drag-hint">
        اسحب الموقع إلى موقع إعادة التمركز الجديد
      </p>
      <p className="v3-hint">نسخة من حدود الموقع الحالي جاهزة للسحب كاملة؛ الأحمر مشغول أو غير متاح.</p>
      <div className={'v3-readout ' + (over || v.conflicts.length ? 'bad' : 'ok')} data-testid="site-readout">
        <div>
          المساحة: <b>{formatArea(area)}</b> من حد أقصى {formatArea(pol.values.maxFootprintAreaM2)} <small>(السياسة {pol.version})</small>
        </div>
        <div>{v.conflicts.length ? <b className="bad">✕ يتداخل مع: {v.conflicts.map(short).join('، ')}</b> : <span className="ok">✓ لا تداخل مع مواقع مشغولة</span>}</div>
        {over && <div className="bad">المساحة تتجاوز الحد المعتمد — لا يُرسل الطلب، ولا يُصغَّر الموقع تلقائياً.</div>}
        <div className="v3-info">
          البعد عن {from ? short(from.name) : 'الموقع الحالي'}: {km(dist)} — <small>للعلم فقط، لا قيد مسافة على إعادة التمركز</small>
        </div>
      </div>
      <div className="v3-tools">
        <button type="button" className="v3-btn" disabled={!editor.live?.canUndo} onClick={editor.undo}>
          تراجع
        </button>
        <button type="button" className="v3-btn" disabled={!editor.live?.canRedo} onClick={editor.redo}>
          إعادة
        </button>
        <button type="button" className="v3-btn" onClick={editor.reset}>
          استعادة البداية
        </button>
        <button type="button" className="v3-btn" onClick={editor.focus}>
          إظهار
        </button>
      </div>
      <details className="v3-adv" open={advanced} onToggle={(e) => setAdvanced((e.target as HTMLDetailsElement).open)}>
        <summary>تعديل عند الحاجة</summary>
        <div className="v3-tools">
          <button
            type="button"
            className={'v3-btn' + (vertices ? ' on' : '')}
            aria-pressed={vertices}
            onClick={() => {
              setVertices(!vertices);
              editor.vertices(!vertices);
            }}
            data-testid="edit-bounds"
          >
            تعديل الحدود
          </button>
          <button
            type="button"
            className="v3-btn"
            onClick={() =>
              ctx.ask({
                title: 'رسم حدود جديدة',
                record: r.number,
                consequence: 'تُستبدل نسخة الحدود الحالية برسم جديد من ستة رؤوس (يمكن التراجع).',
                confirm: 'ابدأ الرسم',
                kind: 'normal',
                needsReason: false,
                run: () => editor.drawNew(),
              })
            }
          >
            رسم حدود جديدة
          </button>
        </div>
        {sources.length > 1 && (
          <label className="v3-field">
            نسخ حدود موقع آخر
            <select
              value={c.site.copiedFrom}
              onChange={(e) => {
                const s = siteOf(w, e.target.value)!;
                ctx.edit((q) => ({ ...q.content, site: { ring: moveRigid(s.ring, centroid(q.content.site!.ring)), copiedFrom: s.id, shape: 'COPY' } }));
                ctx.select({ k: 'edit', id: r.id, step: 'REVIEW' });
                requestAnimationFrame(() => ctx.select({ k: 'edit', id: r.id, step: 'SITE' }));
              }}
            >
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {short(s.name)}
                </option>
              ))}
            </select>
          </label>
        )}
      </details>
    </>
  );
}

function legLine(l: LegCheck, version: number) {
  return (
    <ul className="v3-kv" data-testid={'band-' + l.leg}>
      <li>
        <span>النطاق الأساسي</span>
        <b>
          {km(l.base.min)} – {km(l.base.max)}
        </b>
      </li>
      <li>
        <span>طبيعة الأرض</span>
        <b>{l.terrain ? l.terrain.cls.label + (l.terrain.cls.allowanceM ? ' (+' + km(l.terrain.cls.allowanceM) + ' للحد الأقصى)' : ' (بلا تعديل)') : 'تُحدد بعد الوضع'}</b>
      </li>
      {l.terrain && (
        <li data-testid={'shares-' + l.leg}>
          <span>نسب فئات الأرض</span>
          <b>{l.terrain.shares.map((x) => x.label + ' ' + x.pct.toLocaleString('ar') + '٪').join(' · ')} — الحاكمة: الأكبر مساحة</b>
        </li>
      )}
      {l.terrain?.tie && (
        <li data-testid={'tie-' + l.leg} className={l.terrain.tieResolved ? 'tie ok' : 'tie bad'}>
          <span>تعادل</span>
          <b>
            {l.terrain.tied.join(' = ')} — قاعدة الأولوية: {l.terrain.priority.join(' > ') || '—'}
            {l.terrain.tieResolved ? ' ← فازت «' + l.terrain.cls.label + '» بإضافة +' + km(l.terrain.cls.allowanceM) : ' ← لا ترتيب صالح للفئات المتعادلة: يُمنع الإرسال'}
          </b>
        </li>
      )}
      <li>
        <span>النطاق الفعلي</span>
        <b>
          {km(l.effective.min)} – {km(l.effective.max)}
        </b>
      </li>
      {l.exceptionMax != null && (
        <li>
          <span>أقصى استثناء ممكن</span>
          <b>{km(l.exceptionMax)}</b>
        </li>
      )}
      <li>
        <span>طريقة القياس</span>
        <b>{METHOD_LABEL[l.method]}</b>
      </li>
      <li>
        <span>المصدر</span>
        <b>سياسة الإصدار {version}</b>
      </li>
    </ul>
  );
}

function DeployStep({ ctx, r, leg, withDeploy, setWithDeploy }: { ctx: Ctx; r: Request; leg: 'primary' | 'alternative'; withDeploy: boolean; setWithDeploy: (b: boolean) => void }) {
  const { w, editor } = ctx;
  const pol = policyOfRequest(w, r);
  const c = r.content;
  const v = validate(w, r);
  const l = v.legs.find((x) => x.leg === leg)!;
  const ring = c[leg];
  const [vertices, setVertices] = useState(false);
  const name = leg === 'primary' ? 'منطقة الانتشار الرئيسية' : 'منطقة الانتشار البديلة';
  if (pol.values.deployment === 'OPTIONAL' && !withDeploy)
    return (
      <Section title="الانتشار" hint="السياسة السارية: الانتشار اختياري. إن أُضيف فهو زوج كامل: الرئيسية والبديلة معاً.">
        <div className="v3-tools">
          <button type="button" className="v3-btn primary" onClick={() => setWithDeploy(true)} data-testid="add-deploy">
            إضافة منطقتي الانتشار
          </button>
          <button type="button" className="v3-btn" onClick={() => ctx.select({ k: 'edit', id: r.id, step: 'REVIEW' })}>
            بدون انتشار — إلى المراجعة
          </button>
        </div>
      </Section>
    );
  const [label, cls] = LEG_STATUS[l.status];
  const radius = ring ? Math.round(equivalentRadius(areaM2(ring))) : 0;
  return (
    <>
      <p className="v3-instruct">{ring ? 'اسحب ' + name + ' أو غيّر حجمها' : 'انقر داخل الحلقة لوضع ' + name}</p>
      <p className="v3-hint">
        الحلقة إرشاد للمسافة المسموحة {leg === 'primary' ? 'من موقع التمركز' : 'من منطقة الانتشار الرئيسية'} — ليست حدود المنطقة.
        {pol.values.deployment === 'REQUIRED' ? ' (مطلوبة في السياسة السارية)' : ''}
      </p>
      {legLine(l, pol.version)}
      <div className={'v3-readout ' + cls} data-testid={'leg-' + leg} data-status={l.status}>
        <div>
          {l.distance != null ? (
            <>
              المسافة: <b>{km(l.distance)}</b> — {label}
            </>
          ) : (
            label
          )}
        </div>
        {ring && <div>المساحة: {formatArea(areaM2(ring))}</div>}
        {v.deployConflicts[leg].length > 0 && (
          <div className="bad" data-testid={'deploy-conflict-' + leg}>
            ✕ تتداخل مع أرض مشغولة: {v.deployConflicts[leg].map(short).join('، ')} — يجب نقلها إلى أرض خالية (منع نهائي)
          </div>
        )}
      </div>
      {l.status === 'NEEDS_EXCEPTION' && (
        <Section title="طلب استثناء مسافة" hint="مسموح في السياسة حتى الحد المبين، بسبب مكتوب، ويضيف مرحلة اعتماد بصلاحية «اعتماد استثناء مسافة الانتشار».">
          <textarea className="v3-text" rows={2} value={c.exceptions[leg] ?? ''} onChange={(e) => ctx.edit((q) => ({ ...q.content, exceptions: { ...q.content.exceptions, [leg]: e.target.value } }))} placeholder="سبب الاستثناء" data-testid="exception-reason" />
        </Section>
      )}
      {ring && (
        <>
          <label className="v3-field">
            الحجم (نصف قطر مكافئ): {radius.toLocaleString('ar')} م
            <input type="range" min={150} max={2500} step={50} value={radius} onChange={(e) => editor.resize(Number(e.target.value))} data-testid="size" />
          </label>
          <div className="v3-tools">
            <button type="button" className="v3-btn" disabled={!editor.live?.canUndo} onClick={editor.undo}>
              تراجع
            </button>
            <button type="button" className="v3-btn" disabled={!editor.live?.canRedo} onClick={editor.redo}>
              إعادة
            </button>
            <button type="button" className="v3-btn" onClick={editor.remove}>
              إزالة
            </button>
          </div>
          <details className="v3-adv">
            <summary>تحرير متقدم</summary>
            <div className="v3-tools">
              <button
                type="button"
                className={'v3-btn' + (vertices ? ' on' : '')}
                aria-pressed={vertices}
                onClick={() => {
                  setVertices(!vertices);
                  editor.vertices(!vertices);
                }}
              >
                تحرير الرؤوس
              </button>
              <button type="button" className="v3-btn" onClick={editor.drawNew}>
                رسم مضلع جديد
              </button>
            </div>
          </details>
        </>
      )}
      {pol.values.deployment === 'OPTIONAL' && leg === 'primary' && (
        <button
          type="button"
          className="v3-link"
          onClick={() => {
            ctx.edit((q) => ({ ...q.content, primary: null, alternative: null, exceptions: {} }));
            setWithDeploy(false);
          }}
        >
          إزالة الانتشار من الطلب
        </button>
      )}
    </>
  );
}

function Route({ ctx, r }: { ctx: Ctx; r: Request }) {
  const { w } = ctx;
  const stages = r.stages.length ? r.stages : deriveRoute(w, r, policyOfRequest(w, r).values);
  const cur = r.state === 'UNDER_REVIEW' ? currentStage(r) : undefined;
  return (
    <ol className="v3-route" data-testid="route">
      <li className="done">
        <b>مقدم الطلب</b>
        <small>{personOf(w, r.requester).name}</small>
      </li>
      {stages.map((s) => (
        <li key={s.key} className={(s.mark ? 'done ' : '') + (cur?.key === s.key ? 'cur ' : '') + s.kind.toLowerCase()} data-stage={s.key} data-mark={s.mark ?? ''}>
          <b>{s.label}</b>
          {s.satisfies.length > 1 && <small className="v3-satisfies" data-testid="satisfies">يستوفي: {s.satisfies.join(' + ')}</small>}
          <small>
            {s.mark === 'APPROVED' ? '✓ ' + personOf(w, s.by!).name : s.mark === 'CARRIED' ? '↻ قرار سارٍ محمول: ' + personOf(w, s.by!).name : cur?.key === s.key ? 'الآن: ' + stageDeciders(w, r, s).map((p) => p.name).join('، ') : 'يعتمد على: ' + s.dependsOn.map((f) => FACT[f]).join('، ')}
          </small>
        </li>
      ))}
      <li className={r.activation ? 'done' : ''}>
        <b>التفعيل</b>
        <small>{r.activation ? '✓ ' + personOf(w, r.activation.by).name : 'طرف مستقل عن المعتمد النهائي'}</small>
      </li>
    </ol>
  );
}

function ReviewStep({ ctx, r }: { ctx: Ctx; r: Request }) {
  const { w } = ctx;
  const pol = policyOfRequest(w, r);
  const v = validate(w, r);
  const c = r.content;
  const resubmit = r.state === 'RETURNED_FOR_CHANGES' || r.state === 'PAUSED_HIERARCHY_CHANGED';
  return (
    <>
      <Section title="الوحدة الطالبة">
        <p data-testid="requesting-unit">
          {orgName(w, r.requestingUnit)} <Lv w={w} id={r.requestingUnit} /> <small className="v3-hint">— منها يبدأ مسار الاعتماد صعوداً في هيكل Oracle</small>
        </p>
      </Section>
      <Section title="الوحدات وتمركزها الحالي">
        <ul className="v3-list" data-testid="review-units">
          {affectedSites(w, c.scope).map((a) => (
            <li key={a.site.id}>
              <b>{short(a.site.name)}</b>: {a.moving.map((o) => orgName(w, o)).join('، ')}
              {a.staying.length > 0 && <small className="v3-hint"> · يبقى فيه: {a.staying.map((o) => orgName(w, o) + (c.occupants[o] ? ' (' + (c.occupants[o] === 'SEPARATE' ? 'طلب منفصل' : 'مستبعدة') + ')' : '')).join('، ')}</small>}
            </li>
          ))}
        </ul>
      </Section>
      <Section title="الطلب">
        <ul className="v3-kv">
          <li>
            <span>النوع</span>
            <b>{c.kind === 'PERMANENT' ? 'دائم' : 'مؤقت · ' + day(c.start) + ' – ' + (c.end ? day(c.end) : '—')}</b>
          </li>
          <li>
            <span>الموقع المقترح</span>
            <b>
              {c.site ? formatArea(v.area ?? 0) + ' من ' + formatArea(pol.values.maxFootprintAreaM2) + ' · ' + (c.site.shape === 'COPY' ? 'نسخة منقولة من ' + short(siteOf(w, c.site.copiedFrom)!.name) : c.site.shape === 'EDITED' ? 'حدود معدّلة' : 'حدود جديدة') : '—'}
            </b>
          </li>
          <li>
            <span>التداخل</span>
            <b>{v.conflicts.length ? v.conflicts.map(short).join('، ') : 'لا يوجد'}</b>
          </li>
          {v.legs.map((l) => (
            <li key={l.leg}>
              <span>{l.leg === 'primary' ? 'الانتشار الرئيسي' : 'الانتشار البديل'}</span>
              <b>
                {l.distance == null ? 'غير محدد' : km(l.distance) + ' · ' + LEG_STATUS[l.status][0]} · النطاق {km(l.effective.min)}–{km(l.effective.max)}
                {l.terrain ? ' · ' + l.terrain.cls.label + (l.terrain.cls.allowanceM ? ' +' + km(l.terrain.cls.allowanceM) : '') + ' (' + l.terrain.shares.map((x) => x.pct + '٪').join('/') + ')' : ''}
                {v.deployConflicts[l.leg].length ? ' · ✕ أرض مشغولة' : ''}
              </b>
            </li>
          ))}
          <li>
            <span>السياسة</span>
            <b>
              الإصدار {pol.version} · الانتشار {pol.values.deployment === 'REQUIRED' ? 'مطلوب' : 'اختياري'}
              {r.policyVersion != null ? ' · مقفلة منذ الإرسال' : ' · تُقفل عند الإرسال'}
            </b>
          </li>
        </ul>
      </Section>
      <Section title="مسار الاعتماد" hint="مشتق من هيكل Oracle وإعداد المستويات؛ لا يختاره مقدم الطلب.">
        <Route ctx={ctx} r={r} />
      </Section>
      {v.problems.length > 0 && (
        <ul className="v3-problems" data-testid="problems">
          {v.problems.map((p) => (
            <li key={p} className="bad">
              {p}
            </li>
          ))}

        </ul>
      )}
      <div className="v3-actions">
        {resubmit ? (
          <Act
            ctx={ctx}
            a={{ t: 'SUBMIT', req: r.id, reason: 'x' }}
            label="إعادة الإرسال"
            primary
            onClick={() =>
              ctx.ask({
                title: 'إعادة إرسال الطلب نفسه',
                record: r.number,
                consequence: 'تُحفظ نسخة جديدة؛ تُعاد المراحل التي يعتمد قرارها على ما تغيّر فقط، وتبقى القرارات الأخرى.',
                confirm: 'إعادة الإرسال',
                kind: 'normal',
                needsReason: true,
                run: (reason) => ctx.act({ t: 'SUBMIT', req: r.id, reason }) && ctx.select({ k: 'req', id: r.id }),
              })
            }
          />
        ) : (
          <Act ctx={ctx} a={{ t: 'SUBMIT', req: r.id }} label="إرسال الطلب" primary onClick={() => ctx.act({ t: 'SUBMIT', req: r.id }) && ctx.select({ k: 'req', id: r.id })} />
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------------

function RequestCard({ ctx, r }: { ctx: Ctx; r: Request }) {
  const { w } = ctx;
  const c = r.content;
  const [newEnd, setNewEnd] = useState(iso((c.end ?? w.now) + 14 * DAY));
  const reasonAsk = (title: string, consequence: string, confirm: string, kind: Ask['kind'], make: (reason: string) => Action) =>
    ctx.ask({ title, record: r.number, consequence, confirm, kind, needsReason: true, run: (reason) => void ctx.act(make(reason)) });
  const events = w.events.filter((e) => e.ref === r.id);
  const newSite = r.activation ? siteOf(w, r.activation.site) : null;
  const ext = r.extensions[r.extensions.length - 1];
  return (
    <>
      <h2>
        {r.number} <span className={'v3-state s-' + r.state} data-state={r.state}>{STATE[r.state]}</span>
      </h2>
      <p className="v3-sub">
        {c.kind === 'PERMANENT' ? 'إعادة تمركز دائمة' : 'إعادة تمركز مؤقتة ' + day(c.start) + ' – ' + (c.end ? day(c.end) : '—')} · {c.scope.length} وحدة · السياسة {r.policyVersion ?? '—'}
      </p>
      {r.state === 'PAUSED_HIERARCHY_CHANGED' && (
        <p className="v3-returned" data-testid="paused">
          <b>{HIERARCHY_CHANGED}</b>
          <br />
          أُوقف الطلب وأُعيد لمقدمه للتأكيد. سيُعاد بناء المسار من الوحدة الطالبة نفسها ({orgName(w, r.requestingUnit)}) بالهيكل الجديد، والمسار السابق وقراراته محفوظة أدناه.
        </p>
      )}
      {r.state === 'ACTIVATED_PERMANENT' && <p className="v3-hint">هذا الطلب أساس تاريخي للتغيير ولا يُعدّل؛ أي انتقال لاحق يحتاج طلب إعادة تمركز جديداً.</p>}
      <Section title="الوحدات">
        <ul className="v3-list">
          {c.scope.map((o) => {
            const st = w.stationings.filter((s) => s.org === o && (s.requestId === r.id || s.endReason));
            const prev = st.find((s) => s.kind === 'PERMANENT' && s.state === 'ENDED' && s.endReason === 'REPLACED_BY_ACTIVATION');
            return (
              <li key={o}>
                {orgName(w, o)} <Lv w={w} id={o} />: {short(siteOf(w, prev?.site ?? permanentOf(w, o)?.site ?? '')?.name ?? '—')}
                {newSite ? ' ← ' + newSite.id : ''} <small className="v3-hint">· الآن في {short(siteOfOrg(w, o)?.name ?? '—')}</small>
              </li>
            );
          })}
        </ul>
      </Section>
      <Section title={r.state === 'PAUSED_HIERARCHY_CHANGED' ? 'المسار قبل تغيّر الهيكل (محفوظ)' : 'مسار الاعتماد'}>
        <Route ctx={ctx} r={r} />
      </Section>
      {r.state === 'PAUSED_HIERARCHY_CHANGED' && (
        <Section title="المسار بعد التأكيد (من الوحدة الطالبة بالهيكل الجديد)" hint="للقراءة؛ يُبنى فعلياً عند إعادة التأكيد.">
          <Route ctx={ctx} r={{ ...r, state: 'DRAFT', stages: [], activation: undefined }} />
        </Section>
      )}
      <div className="v3-actions" data-testid="req-actions">
        {r.state === 'UNDER_REVIEW' && (
          <>
            <Act ctx={ctx} a={{ t: 'APPROVE', req: r.id }} label="اعتماد المرحلة" primary />
            <Act ctx={ctx} a={{ t: 'RETURN', req: r.id, reason: 'x' }} label="إرجاع للتعديل" onClick={() => reasonAsk('إرجاع الطلب للتعديل', 'يعود الطلب نفسه إلى مقدمه؛ تبقى القرارات وسجل النسخ.', 'إرجاع', 'normal', (reason) => ({ t: 'RETURN', req: r.id, reason }))} />
            <Act ctx={ctx} a={{ t: 'REJECT', req: r.id, reason: 'x' }} label="رفض" danger onClick={() => reasonAsk('رفض الطلب', 'ينتهي الطلب مرفوضاً؛ لا يتغير أي تمركز.', 'رفض', 'destructive', (reason) => ({ t: 'REJECT', req: r.id, reason }))} />
          </>
        )}
        {(r.state === 'RETURNED_FOR_CHANGES' || r.state === 'PAUSED_HIERARCHY_CHANGED') && r.requester === ctx.actor && (
          <button type="button" className="v3-btn primary" onClick={() => ctx.select({ k: 'edit', id: r.id, step: 'SITE' })}>
            تعديل الطلب نفسه
          </button>
        )}
        {r.state === 'APPROVED_NOT_ACTIVATED' && (
          <Act
            ctx={ctx}
            a={{ t: 'ACTIVATE', req: r.id }}
            label="تفعيل"
            primary
            onClick={() =>
              ctx.ask({
                title: 'تفعيل إعادة التمركز',
                record: r.number,
                consequence: c.kind === 'PERMANENT' ? 'يصبح الموقع الجديد التمركز الحالي لكل الوحدات المشمولة، ويُحفظ السابق في السجل. المسؤولية عن المرافق لا تتغير.' : 'يُسجل التمركز المؤقت فوق الأصلي المحفوظ، ويبدأ نفاذه في موعده.',
                confirm: 'تفعيل',
                kind: 'auth',
                needsReason: false,
                run: () => void ctx.act({ t: 'ACTIVATE', req: r.id }),
              })
            }
          />
        )}
        {c.kind === 'TEMPORARY' && (r.state === 'TEMPORARY_SCHEDULED' || r.state === 'ACTIVE_TEMPORARY') && (
          <>
            {!ext || ext.state === 'ACTIVATED' || ext.state === 'LAPSED_NOT_ACTIVATED' ? (
              <div className="v3-inline">
                <label>
                  نهاية جديدة
                  <input type="date" value={newEnd} onChange={(e) => setNewEnd(e.target.value)} />
                </label>
                <Act ctx={ctx} a={{ t: 'REQUEST_EXTENSION', req: r.id, newEnd: fromIso(newEnd), reason: 'x' }} label="طلب تمديد" onClick={() => reasonAsk('طلب تمديد', 'يُراجع التمديد بالمراحل التي يعتمد قرارها على المدة، ثم يُفعَّل مستقلاً.', 'إرسال', 'normal', (reason) => ({ t: 'REQUEST_EXTENSION', req: r.id, newEnd: fromIso(newEnd), reason }))} />
              </div>
            ) : null}
            {ext?.state === 'UNDER_REVIEW' && <Act ctx={ctx} a={{ t: 'APPROVE_EXTENSION', req: r.id }} label={'اعتماد التمديد (' + (ext.stages.find((s) => !s.mark)?.label ?? '') + ')'} primary />}
            {ext?.state === 'APPROVED_NOT_ACTIVATED' && <Act ctx={ctx} a={{ t: 'ACTIVATE_EXTENSION', req: r.id }} label="تفعيل التمديد" primary />}
            {r.state === 'ACTIVE_TEMPORARY' && !r.earlyReturn && <Act ctx={ctx} a={{ t: 'REQUEST_EARLY_RETURN', req: r.id, reason: 'x' }} label="طلب عودة مبكرة" onClick={() => reasonAsk('طلب عودة مبكرة', 'يقرره طرف مستقل؛ عند الموافقة تعود الوحدات فوراً إلى تمركزها الأصلي.', 'إرسال', 'normal', (reason) => ({ t: 'REQUEST_EARLY_RETURN', req: r.id, reason }))} />}
            {r.earlyReturn?.state === 'REQUESTED' && (
              <>
                <Act ctx={ctx} a={{ t: 'DECIDE_EARLY_RETURN', req: r.id, approve: true, reason: 'x' }} label="الموافقة على العودة المبكرة" onClick={() => reasonAsk('الموافقة على العودة المبكرة', 'تنتهي المرحلة المؤقتة الآن وتعود الوحدات.', 'موافقة', 'auth', (reason) => ({ t: 'DECIDE_EARLY_RETURN', req: r.id, approve: true, reason }))} />
                <Act ctx={ctx} a={{ t: 'DECIDE_EARLY_RETURN', req: r.id, approve: false, reason: 'x' }} label="رفض العودة المبكرة" onClick={() => reasonAsk('رفض العودة المبكرة', 'يستمر المؤقت حتى نهايته.', 'رفض', 'normal', (reason) => ({ t: 'DECIDE_EARLY_RETURN', req: r.id, approve: false, reason }))} />
              </>
            )}
            {r.state === 'TEMPORARY_SCHEDULED' && !r.startCancellation && <Act ctx={ctx} a={{ t: 'REQUEST_START_CANCELLATION', req: r.id, reason: 'x' }} label="طلب إلغاء قبل البدء" onClick={() => reasonAsk('طلب إلغاء قبل البدء', 'لا يصبح المؤقت نافذاً إن وُوفق عليه؛ يقرره طرف مستقل.', 'إرسال', 'normal', (reason) => ({ t: 'REQUEST_START_CANCELLATION', req: r.id, reason }))} />}
            {r.startCancellation?.state === 'REQUESTED' && <Act ctx={ctx} a={{ t: 'DECIDE_START_CANCELLATION', req: r.id, approve: true, reason: 'x' }} label="الموافقة على الإلغاء" onClick={() => reasonAsk('الموافقة على الإلغاء قبل البدء', 'يُلغى المؤقت قبل نفاذه، ويبقى التمركز الأصلي.', 'موافقة', 'auth', (reason) => ({ t: 'DECIDE_START_CANCELLATION', req: r.id, approve: true, reason }))} />}
          </>
        )}
      </div>
      {r.extensions.length > 0 && (
        <Section title="التمديد">
          <ul className="v3-list" data-testid="extensions">
            {r.extensions.map((e) => (
              <li key={e.id}>
                حتى {day(e.newEnd)} · {e.state === 'ACTIVATED' ? 'مفعّل' : e.state === 'APPROVED_NOT_ACTIVATED' ? 'معتمد بانتظار التفعيل' : e.state === 'LAPSED_NOT_ACTIVATED' ? 'سقط دون تفعيل' : 'قيد الاعتماد'} · المراحل: {e.stages.map((s) => s.label.split(' — ')[0] + (s.mark ? ' ✓' : '')).join(' ← ')}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {r.routeHistory.length > 0 && (
        <Section title="مسارات سابقة محفوظة" hint="لا تُحذف القرارات السابقة؛ تبقى في السجل مع سبب الاستبدال.">
          <ul className="v3-list" data-testid="route-history">
            {r.routeHistory.map((h, i) => (
              <li key={i}>
                {day(h.at)} · {h.reason}: {h.stages.map((s) => s.label.split(' — ')[1] + (s.mark ? ' ✓ ' + personOf(w, s.by!).name : '')).join(' ← ')}
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section title="النسخ" hint="الطلب نفسه عبر كل الإرجاعات؛ لكل إرسال نسخة كاملة.">
        <ol className="v3-revs" data-testid="revisions">
          {r.revisions.map((v) => (
            <li key={v.n}>
              <b>النسخة {v.n}</b> · {day(v.at)} · {personOf(w, v.by).name}
              {v.n > 1 && (
                <div>
                  تغيّر: {v.changed.map((f) => FACT[f]).join('، ') || 'لا شيء'}
                  {v.reason ? ' — ' + v.reason : ''}
                  <br />
                  أُعيد: {v.invalidated.length ? v.invalidated.map((k) => r.stages.find((s) => s.key === k)?.label.split(' — ')[0]).join('، ') : '—'} · حُمل: {v.carried.length ? v.carried.map((k) => r.stages.find((s) => s.key === k)?.label.split(' — ')[0]).join('، ') : '—'}
                </div>
              )}
            </li>
          ))}
        </ol>
      </Section>
      <Section title="سجل التدقيق">
        <ul className="v3-log" data-testid="events">
          {events.map((e, i) => (
            <li key={i}>
              <code>{e.type}</code> {day(e.at)} · {e.by === 'system' ? 'النظام' : w.people.find((p) => p.id === e.by)?.name ?? e.by} · {e.detail}
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------------

/** The owner's decisions and the points still open (docs/STATIONING_MODEL_V3_AR.md §13). */
export const DECISIONS: [string, 'OWNER' | 'OPEN', string][] = [
  ['O-02', 'OWNER', 'ربط الموقع بالوحدة ليس تمركزاً، ولا يصير تمركزاً تلقائياً؛ والتمركز لا يغيّر المسؤولية عن المرفق.'],
  ['O-03', 'OWNER', 'وحدة من فرع آخر لا تُنقل تلقائياً أبداً؛ الضم وموافقاته (واحدة أو أكثر) من الإعداد، وكل ضم صريح ومُدقَّق.'],
  ['O-05', 'OWNER', 'فئة الأرض الحاكمة هي الأكبر مساحة من المنطقة، وتُعرض النسب.'],
  ['O-06', 'OWNER', 'إضافة طبيعة الأرض تمد الحد الأقصى فقط؛ الأدنى ثابت (5–8 + 2 = 5–10).'],
  ['O-07', 'OWNER', 'المسار يبدأ من الوحدة الطالبة ويصعد في هيكل Oracle.'],
  ['O-08', 'OWNER', 'منطقة انتشار فوق أرض مشغولة: منع نهائي.'],
  ['O-09', 'OWNER', 'المرحلة الأولى معتمد الوحدة الطالبة افتراضياً، وقابلة للتهيئة.'],
  ['O-10', 'OWNER', 'تغيّر هيكل الوحدة الطالبة أثناء الطلب: يُوقف ويُعاد للتأكيد، ثم يُعاد بناء المسار من الوحدة نفسها، والسابق محفوظ.'],
  ['O-04', 'OWNER', 'مسافة الانتشار تُقاس من مركز الهندسة إلى مركز الهندسة، للعلاقتين.'],
  ['O-13', 'OWNER', 'التسمية الظاهرة: «منطقة الانتشار البديلة».'],
  ['O-10b', 'OWNER', 'بعد إعادة بناء المسار تُعاد كل المراحل، والقرارات السابقة في السجل فقط.'],
  ['O-14', 'OWNER', 'تفعيل إعادة التمركز الدائمة لا يمس روابط المواقع؛ الروابط تُدار مستقلة.'],
  ['O-03b', 'OWNER', 'مرحلة قائمة على المسار تستوفي أكثر من شرط للسلطة نفسها، ويُسجل ما استوفته؛ وإن طلب الإعداد الاستقلال فمرحلة مستقلة بإنسان مختلف.'],
  ['O-15', 'OWNER', 'الربط وحده لا يعني الإشغال؛ الإشغال من سجلات معتمدة فقط (تمركز، استخدام معتمد، حجز).'],
  ['O-16', 'OWNER', 'تغيّر الهيكل بعد الاعتماد وقبل التفعيل: التفعيل ممنوع، ويُوقف الطلب ويُعاد، ويُعاد بناء المسار والاعتمادات.'],
  ['O-01', 'OWNER', 'من Oracle إلى TMRKZ: الوحدات والهيكل. ومن TMRKZ: واجهة قراءة وتغذية أحداث (outbox) غير متزامنة. لا كتابة في هيكل Oracle.'],
  ['O-11', 'OWNER', 'التضاريس: FGIC/NSDI بإذن كتابي فقط؛ وإلا Copernicus GLO-30 بموافقة المالك (DSM لا أرض عارية)؛ المولّد للنموذج فقط.'],
  ['O-12', 'OWNER', 'الشوارع: PMTiles محلية وأسماء OSM حيث يجوز، بخطوط وglyphs محلية، وإسناد ODbL، ولا تُقدَّم كأسماء رسمية.'],
  ['O-05b', 'OWNER', 'تعادل الفئات في أكبر مساحة: تحكم الفئة المتعادلة الأعلى في ترتيب الأولوية الذي يهيئه المسؤول (terrain_class_priority)؛ دون ترتيب صالح لها يُمنع الإرسال.'],
];

function PolicyCard({ ctx }: { ctx: Ctx }) {
  const { w } = ctx;
  const cur = policyAt(w, w.now);
  const [v, setV] = useState<PolicyValues>(() => structuredClone(cur.values));
  const [reason, setReason] = useState('');
  const [from, setFrom] = useState(iso(w.now));
  const [reference, setReference] = useState('');
  const admin = ctx.me.perms.includes('ADMIN_POLICY');
  useEffect(() => setV(structuredClone(cur.values)), [cur.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const num = (label: string, value: number, set: (n: number) => void, unit: string, step = 0.1) => (
    <label className="v3-field inline">
      {label}
      <input type="number" step={step} value={value} disabled={!admin} onChange={(e) => set(Number(e.target.value))} />
      <small>{unit}</small>
    </label>
  );
  const leg = (k: 'primary' | 'alternative', title: string) => (
    <fieldset className="v3-fs">
      <legend>{title}</legend>
      {num('من', v[k].minM / 1000, (n) => setV({ ...v, [k]: { ...v[k], minM: n * 1000 } }), 'كم')}
      {num('إلى', v[k].maxM / 1000, (n) => setV({ ...v, [k]: { ...v[k], maxM: n * 1000 } }), 'كم')}
      <label className="v3-field inline">
        القياس <span className="v3-open-tag owner">O-04: مركز ← مركز</span>
        <select value={v[k].method} disabled={!admin} onChange={(e) => setV({ ...v, [k]: { ...v[k], method: e.target.value as Method } })}>
          {Object.entries(METHOD_LABEL).map(([m, l]) => (
            <option key={m} value={m}>
              {l}
            </option>
          ))}
        </select>
      </label>
      <label className="v3-check">
        <input type="checkbox" checked={v[k].terrain} disabled={!admin} onChange={(e) => setV({ ...v, [k]: { ...v[k], terrain: e.target.checked } })} />
        تطبيق تعديل طبيعة الأرض
      </label>
    </fieldset>
  );
  const sw = <K extends keyof PolicyValues>(key: K, code: string, label: string, opts: [PolicyValues[K], string][]) => (
    <label className="v3-field">
      {label} <span className="v3-open-tag">{code}</span>
      <select value={String(v[key])} disabled={!admin} onChange={(e) => setV({ ...v, [key]: opts.find((o) => String(o[0]) === e.target.value)![0] })}>
        {opts.map(([o, l]) => (
          <option key={String(o)} value={String(o)}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <>
      <h2>السياسة والإعداد</h2>
      <p className="v3-sub">
        السارية: الإصدار {cur.version} ({cur.reference}) منذ {day(cur.effectiveFrom)} — {cur.reason}
      </p>
      {!admin && <p className="v3-why">التعديل لمسؤول النظام؛ اختر «ليلى العامري» في شريط المحاكاة.</p>}
      <div data-testid="policy-form">
        <Section title="الموقع والانتشار">
          {num('الحد الأقصى لمساحة موقع إعادة التمركز', v.maxFootprintAreaM2 / 1e6, (n) => setV({ ...v, maxFootprintAreaM2: n * 1e6 }), 'كم²', 0.01)}
          <div className="v3-seg" role="radiogroup" aria-label="الانتشار">
            {(
              [
                ['REQUIRED', 'الانتشار مطلوب'],
                ['OPTIONAL', 'الانتشار اختياري'],
              ] as const
            ).map(([d, l]) => (
              <button key={d} type="button" role="radio" aria-checked={v.deployment === d} className={v.deployment === d ? 'on' : ''} disabled={!admin} onClick={() => setV({ ...v, deployment: d })} data-deploy={d}>
                {l}
              </button>
            ))}
          </div>
          {leg('primary', 'من موقع التمركز إلى منطقة الانتشار الرئيسية')}
          {leg('alternative', 'من الرئيسية إلى منطقة الانتشار البديلة')}
        </Section>
        <Section title="طبيعة الأرض" hint="الفئات من مجموعة بيانات الأرض المعتمدة؛ المسؤول يحدد الإضافة لكل فئة. لا يقترح النظام مواقع.">
          {v.terrainClasses.map((c, i) => num(c.label + ' (' + c.code + ')', c.allowanceM / 1000, (n) => setV({ ...v, terrainClasses: v.terrainClasses.map((x, j) => (j === i ? { ...x, allowanceM: n * 1000 } : x)) }), '+ كم'))}
          {sw('terrainResolution', 'O-05', 'منطقة تمس عدة فئات', [
            ['LARGEST_AREA', 'الفئة الأكبر مساحة (قرار المالك)'],
            ['AREA_CENTRE', 'فئة مركزها (تغيير صريح من المسؤول)'],
            ['MOST_DEMANDING_TOUCHED', 'أصعب فئة تمسها (تغيير صريح من المسؤول)'],
          ])}
          <fieldset className="v3-fs" data-testid="terrain-tie">
            <legend>
              ترتيب أولوية الفئات عند التعادل (terrain_class_priority) <span className="v3-open-tag owner">O-05b</span>
            </legend>
            <ol className="v3-prio">
              {v.terrainPriority.map((code, i) => (
                <li key={code}>
                  <b>{v.terrainClasses.find((c) => c.code === code)?.label ?? code}</b> <code>{code}</code>
                  <button type="button" className="v3-mini" disabled={!admin || i === 0} onClick={() => setV({ ...v, terrainPriority: v.terrainPriority.map((x, j) => (j === i - 1 ? code : j === i ? v.terrainPriority[i - 1] : x)) })} aria-label="أعلى">
                    ▲
                  </button>
                  <button type="button" className="v3-mini" disabled={!admin || i === v.terrainPriority.length - 1} onClick={() => setV({ ...v, terrainPriority: v.terrainPriority.map((x, j) => (j === i + 1 ? code : j === i ? v.terrainPriority[i + 1] : x)) })} aria-label="أدنى">
                    ▼
                  </button>
                  <button type="button" className="v3-mini" disabled={!admin} onClick={() => setV({ ...v, terrainPriority: v.terrainPriority.filter((x) => x !== code) })} aria-label="إزالة">
                    ✕
                  </button>
                </li>
              ))}
            </ol>
            {v.terrainClasses.filter((c) => !v.terrainPriority.includes(c.code)).map((c) => (
              <button key={c.code} type="button" className="v3-chip" disabled={!admin} onClick={() => setV({ ...v, terrainPriority: [...v.terrainPriority, c.code] })}>
                + {c.label}
              </button>
            ))}
            <small className="v3-hint">الأكبر مساحة تحكم؛ عند التعادل تحكم الفئة الأعلى ترتيباً بين المتعادلة. فئة متعادلة خارج الترتيب: يُمنع الإرسال. لا عشوائية، ولا اختيار آلي للأكثر تقييداً أو الأكبر إضافة.</small>
          </fieldset>
          {sw('terrainAppliesTo', 'O-06', 'أثر الإضافة', [
            ['MAX_ONLY', 'تمد الحد الأقصى فقط (قرار المالك)'],
            ['MIN_AND_MAX', 'تزيح النطاق كله (تغيير صريح من المسؤول)'],
          ])}
        </Section>
        <Section title="الاستثناء">
          <label className="v3-check">
            <input type="checkbox" checked={v.exception.allowed} disabled={!admin} onChange={(e) => setV({ ...v, exception: { ...v.exception, allowed: e.target.checked } })} />
            يسمح باستثناء مسافة بسبب واعتماد بصلاحية
          </label>
          {num('أقصى زيادة باستثناء', v.exception.maxExtraM / 1000, (n) => setV({ ...v, exception: { ...v.exception, maxExtraM: n * 1000 } }), 'كم')}
        </Section>
        <Section title="الجهات والمسار">
          <fieldset className="v3-fs" data-testid="cross-branch">
            <legend>
              ضم وحدة من فرع آخر <span className="v3-open-tag owner">O-03</span>
            </legend>
            <label className="v3-check">
              <input type="checkbox" checked={v.crossBranch.allowed} disabled={!admin} onChange={(e) => setV({ ...v, crossBranch: { ...v.crossBranch, allowed: e.target.checked } })} />
              مسموح بقرار صريح مُدقَّق (لا يحدث تلقائياً أبداً)
            </label>
            {(
              [
                ['OTHER_UNIT', 'موافقة معتمد الوحدة نفسها'],
                ['OTHER_UNIT_PARENT', 'موافقة معتمد أبيها'],
                ['SITE_RESPONSIBLE', 'موافقة معتمد المسؤول عن موقعها'],
              ] as const
            ).map(([a, l]) => (
              <label key={a} className="v3-check">
                <input
                  type="checkbox"
                  checked={v.crossBranch.authorities.includes(a)}
                  disabled={!admin || !v.crossBranch.allowed}
                  onChange={(e) => setV({ ...v, crossBranch: { ...v.crossBranch, authorities: e.target.checked ? [...v.crossBranch.authorities, a] : v.crossBranch.authorities.filter((x) => x !== a) } })}
                />
                {l}
              </label>
            ))}
            <label className="v3-check" data-testid="cross-independent">
              <input type="checkbox" checked={v.crossBranch.independent} disabled={!admin || !v.crossBranch.allowed} onChange={(e) => setV({ ...v, crossBranch: { ...v.crossBranch, independent: e.target.checked } })} />
              موافقات مستقلة: مرحلة منفصلة لكل شرط، بإنسان مختلف، حتى لو كانت السلطة نفسها على المسار <span className="v3-open-tag owner">O-03b</span>
            </label>
            {!v.crossBranch.independent && <small className="v3-hint">دون الاستقلال: مرحلة قائمة للسلطة نفسها تستوفي الشرط، ويُسجل في المسار والسجل ما استوفته.</small>}
          </fieldset>
          <p className="v3-hint">
            منطقة انتشار فوق أرض مشغولة: <b>منع نهائي</b> (O-08) — ليس إعداداً. المسار يبدأ من <b>الوحدة الطالبة</b> صعوداً (O-07).
          </p>
          <label className="v3-field">
            المرحلة الأولى <span className="v3-open-tag">O-09</span>
            <select value={v.routing.startAt} disabled={!admin} onChange={(e) => setV({ ...v, routing: { ...v.routing, startAt: e.target.value as 'SELF' | 'PARENT' } })}>
              <option value="SELF">معتمد الوحدة الطالبة (الافتراضي)</option>
              <option value="PARENT">معتمد أبيها المباشر</option>
            </select>
          </label>
          <label className="v3-field">
            بعد تغيّر الهيكل وإعادة التأكيد <span className="v3-open-tag">O-10b</span>
            <select value={v.routing.afterHierarchyChange} disabled={!admin} onChange={(e) => setV({ ...v, routing: { ...v.routing, afterHierarchyChange: e.target.value as PolicyValues['routing']['afterHierarchyChange'] } })}>
              <option value="RESTART_ALL">تُعاد كل المراحل (قرار المالك)</option>
              <option value="CARRY_SAME_UNIT_STAGES">تُحمل قرارات المراحل التي بقيت وحدتها (تغيير صريح من المسؤول)</option>
            </select>
          </label>
          <table className="v3-table">
            <thead>
              <tr>
                <th>مستوى Oracle</th>
                <th>يعتمد</th>
                <th>تسمية المرحلة</th>
                <th>يعتمد قراره على</th>
              </tr>
            </thead>
            <tbody>
              {v.routing.levels.map((l, i) => (
                <tr key={l.level}>
                  <td>L{l.level}</td>
                  <td>
                    <input type="checkbox" checked={l.approve} disabled={!admin || l.final} onChange={(e) => setV({ ...v, routing: { ...v.routing, levels: v.routing.levels.map((x, j) => (j === i ? { ...x, approve: e.target.checked } : x)) } })} aria-label={'L' + l.level + ' يعتمد'} />
                  </td>
                  <td>{l.label}</td>
                  <td>{l.final ? 'كل الحقائق' : l.dependsOn.map((f) => FACT[f]).join('، ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
        {admin && (
          <Section title="نشر نسخة جديدة" hint="النسخة الجديدة لا تغيّر الطلبات المرسلة: كل طلب مقفل على نسخة إرساله.">
            <label className="v3-field">
              سارية من
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="مرجع السياسة (إلزامي)، مثل POL-STN-2026-03" data-testid="policy-reference" />
            <textarea className="v3-text" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="سبب التغيير (إلزامي)" data-testid="policy-reason" />
            <Act ctx={ctx} a={{ t: 'PUBLISH_POLICY', values: v, effectiveFrom: fromIso(from), reason, reference }} label="نشر" primary onClick={() => ctx.act({ t: 'PUBLISH_POLICY', values: v, effectiveFrom: fromIso(from), reason, reference }) && setReason('')} />
          </Section>
        )}
      </div>
      <Section title="الإصدارات">
        <ul className="v3-list" data-testid="policy-versions">
          {[...w.policies].reverse().map((p) => (
            <li key={p.version}>
              <b>الإصدار {p.version}</b> · {p.reference} · من {day(p.effectiveFrom)} · {personOf(w, p.author).name} · {p.reason}
            </li>
          ))}
        </ul>
      </Section>
      <Section title="قرارات المالك" hint={DECISIONS.some(([, st]) => st === 'OPEN') ? 'المفتوح لا يُنفذ في الإنتاج قبل جواب المالك.' : 'لا قرار مفتوح: كل قرارات نموذج التمركز V3 محسومة من المالك.'}>
        <ul className="v3-open-list" data-testid="open-decisions">
          {DECISIONS.map(([k, st, t]) => (
            <li key={k} className={st === 'OWNER' ? 'owner' : 'open'}>
              <span className={'v3-open-tag' + (st === 'OWNER' ? ' owner' : '')}>{k}</span> {st === 'OWNER' ? 'قرار المالك: ' : 'مفتوح: '}
              {t}
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}

function LinksCard({ ctx }: { ctx: Ctx }) {
  const { w } = ctx;
  const [org, setOrg] = useState('u903');
  const [site, setSite] = useState('SITE-0101');
  const [rsite, setRsite] = useState('SITE-0103');
  const [rorg, setRorg] = useState('u1000');
  const linkEvents = w.events.filter((e) => ['SITE_LINKED', 'SITE_UNLINKED', 'STATIONING_CORRECTED', 'FACILITY_RESPONSIBILITY_SET', 'ORACLE_SYNC_APPLIED', 'REQUEST_PAUSED_HIERARCHY_CHANGED'].includes(e.type));
  const reasonAsk = (title: string, consequence: string, make: (reason: string) => Action) => ctx.ask({ title, record: 'ربط المواقع', consequence, confirm: 'تنفيذ', kind: 'auth', needsReason: true, run: (reason) => void ctx.act(make(reason)) });
  return (
    <>
      <h2>ربط المواقع والهيكل</h2>
      <p className="v3-sub">الوحدات من Oracle (قراءة فقط)؛ المواقع وروابطها سجلات TMRKZ أو نظام مواقع خارجي — كل منهما مستقل.</p>
      <Section title="مزامنة Oracle (بيئة اختبار)" hint={w.oracle.source}>
        <p>
          آخر استخراج: {day(w.oracle.extractAt)} · {w.oracle.rows} صف
        </p>
        <button
          type="button"
          className="v3-btn"
          onClick={() => ctx.act({ t: 'ORACLE_SYNC', rows: [{ oracleId: '902', parentOracleId: '801', level: 9, name: 'شعبة المستودعات' }] }, 'oracle')}
          data-testid="oracle-sync"
        >
          محاكاة: Oracle ينقل شعبة المستودعات تحت قسم الخدمات العامة
        </button>
        <p className="v3-hint">بعدها: الشعبة ما زالت في {short(siteOfOrg(w, 'u902')?.name ?? '—')} — تغيّر الأب في الهيكل لا يعيد كتابة روابط المواقع.</p>
      </Section>
      <Section title="المواقع">
        <table className="v3-table" data-testid="sites-table">
          <thead>
            <tr>
              <th>الموقع</th>
              <th>المصدر</th>
              <th>متمركزة</th>
              <th>مرتبطة</th>
              <th>المسؤول عن المرفق</th>
            </tr>
          </thead>
          <tbody>
            {w.sites.map((s) => (
              <tr key={s.id}>
                <td>
                  <button type="button" className="v3-link" onClick={() => ctx.select({ k: 'site', id: s.id })}>
                    {short(s.name)}
                  </button>
                  <small> {s.id}</small>
                </td>
                <td>{s.source.system === 'TMRKZ' ? 'TMRKZ' : s.source.system + ' (' + (s.source as { externalId: string }).externalId + ')'}</td>
                <td>{occupantsOf(w, s.id).map((o) => orgOf(w, o)?.code).join('، ') || '—'}</td>
                <td>{linkedTo(w, s.id).map((o) => orgOf(w, o)?.code).join('، ') || '—'}</td>
                <td>{orgOf(w, responsibleOf(w, s.id)?.org ?? '')?.code ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      <Section title="ربط وحدة بموقع" hint="ارتباط فقط — لا يجعل الوحدة متمركزة في الموقع (O-02). بصلاحية «إدارة ربط المواقع» وسبب.">
        <div className="v3-inline">
          <select value={org} onChange={(e) => setOrg(e.target.value)} aria-label="الوحدة">
            {w.orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          <select value={site} onChange={(e) => setSite(e.target.value)} aria-label="الموقع">
            {w.sites.map((s) => (
              <option key={s.id} value={s.id}>
                {short(s.name)}
              </option>
            ))}
          </select>
          <Act ctx={ctx} a={{ t: 'LINK_SITE', org, site, reason: 'x' }} label="ربط" onClick={() => reasonAsk('ربط وحدة بموقع', 'يُسجَّل ارتباط بين الوحدة والموقع. التمركز لا يتغير.', (reason) => ({ t: 'LINK_SITE', org, site, reason }))} />
          <Act ctx={ctx} a={{ t: 'UNLINK_SITE', org, site, reason: 'x' }} label="فك الربط" onClick={() => reasonAsk('فك ربط وحدة بموقع', 'ينتهي الارتباط ويبقى في السجل. التمركز لا يتغير.', (reason) => ({ t: 'UNLINK_SITE', org, site, reason }))} />
        </div>
      </Section>
      <Section title="تصحيح تمركز (بيانات)" hint="تصحيح سجل تمركز خاطئ بصلاحيته الخاصة وسبب — الانتقال الفعلي يكون بطلب إعادة تمركز.">
        <div className="v3-inline">
          <Act ctx={ctx} a={{ t: 'CORRECT_STATIONING', org, site, reason: 'x' }} label={'تصحيح تمركز ' + orgName(w, org) + ' إلى ' + short(siteOf(w, site)?.name ?? '')} onClick={() => reasonAsk('تصحيح سجل تمركز', 'ينتهي التمركز الحالي بسبب «تصحيح» ويُنشأ سجل جديد؛ الاثنان في السجل.', (reason) => ({ t: 'CORRECT_STATIONING', org, site, reason }))} />
        </div>
      </Section>
      <Section title="المسؤولية عن المرفق" hint="إجراء مستقل بصلاحيته؛ لا يغيّر التمركز.">
        <div className="v3-inline">
          <select value={rsite} onChange={(e) => setRsite(e.target.value)} aria-label="الموقع">
            {w.sites.map((s) => (
              <option key={s.id} value={s.id}>
                {short(s.name)}
              </option>
            ))}
          </select>
          <select value={rorg} onChange={(e) => setRorg(e.target.value)} aria-label="الجهة">
            {w.orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          <Act ctx={ctx} a={{ t: 'SET_RESPONSIBILITY', site: rsite, org: rorg, reason: 'x' }} label="تعيين" onClick={() => reasonAsk('تعيين المسؤولية عن المرفق', 'تنتهي المسؤولية الحالية وتبدأ الجديدة؛ لا تتغير أي وحدة متمركزة.', (reason) => ({ t: 'SET_RESPONSIBILITY', site: rsite, org: rorg, reason }))} />
        </div>
      </Section>
      <Section title="التغذية الصادرة (outbox)" hint="عقد O-01: أحداث التغييرات المعتمدة لمن يستهلكها (واجهة قراءة أو تغذية أحداث)، غير متزامنة؛ لا كتابة في Oracle.">
        {w.outbox.length === 0 ? (
          <p className="v3-hint">لا أحداث بعد — تظهر عند تفعيل تمركز أو بدء مؤقت أو انتهائه أو تغيير ربط.</p>
        ) : (
          <table className="v3-table" data-testid="outbox">
            <thead>
              <tr>
                <th>#</th>
                <th>النوع</th>
                <th>الوحدة (معرّف Oracle)</th>
                <th>الموقع</th>
                <th>نافذ من</th>
                <th>المرجع</th>
              </tr>
            </thead>
            <tbody>
              {w.outbox.slice(-12).map((e) => (
                <tr key={e.id}>
                  <td>{e.seq}</td>
                  <td>
                    <code>{e.type}</code>
                  </td>
                  <td>
                    {e.orgExternalId} · {e.orgCode}
                  </td>
                  <td>
                    {e.siteId}
                    {e.siteExternalId ? ' / ' + e.siteExternalId : ''}
                  </td>
                  <td>{day(e.effectiveAt)}</td>
                  <td>
                    {e.auditRef} · {e.sourceVersion}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
      {linkEvents.length > 0 && (
        <Section title="السجل">
          <ul className="v3-log" data-testid="link-events">
            {linkEvents.map((e, i) => (
              <li key={i}>
                <code>{e.type}</code> {e.detail}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}

export function ReasonDialog({ ask, onCancel, onConfirm }: { ask: Ask; onCancel: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  const first = useRef<HTMLTextAreaElement>(null);
  const ok = !ask.needsReason || reason.trim().length >= 5;
  useEffect(() => {
    first.current?.focus();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onCancel]);
  return (
    <div className="v3-modal" onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div className={'v3-dialog ' + ask.kind} role="dialog" aria-modal="true" aria-labelledby="v3-dlg" data-testid="dialog">
        <h3 id="v3-dlg">{ask.title}</h3>
        <p className="v3-sub">{ask.record}</p>
        <p>{ask.consequence}</p>
        {ask.needsReason && <textarea ref={first} className="v3-text" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="السبب (إلزامي)" data-testid="dialog-reason" />}
        <div className="v3-tools">
          <button type="button" className="v3-btn" onClick={onCancel}>
            إلغاء
          </button>
          <button type="button" className={'v3-btn ' + (ask.kind === 'destructive' ? 'danger' : 'primary')} disabled={!ok} onClick={() => onConfirm(reason.trim())} data-testid="dialog-confirm">
            {ask.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The owner's remaining question (O-04): the same two polygons measured both ways, against the same example band. */
function CompareCard() {
  const k = comparison();
  const km2 = (m: number) => (m / 1000).toLocaleString('ar', { maximumFractionDigits: 2 }) + ' كم';
  return (
    <>
      <h2>طريقة قياس مسافة الانتشار (O-04)</h2>
      <p className="v3-sub">الموقع والمنطقة نفسهما على الخريطة، والنطاق المثال نفسه {km2(COMPARE_BAND.min)} – {km2(COMPARE_BAND.max)}. المقارنة التي عُرضت على المالك.</p>
      <div className="v3-cmp" data-testid="compare">
        <div className={'v3-readout ' + (k.aOk ? 'ok' : 'bad')}>
          <b>أ — من مركز الموقع إلى مركز المنطقة</b>
          <div>
            {km2(k.a)} → {k.aOk ? 'ضمن النطاق ✓' : 'خارج النطاق ✕'}
          </div>
          <small>الخط المتقطع الأزرق. لا يتأثر بحجم المنطقة: تكبيرها لا يقرّبها.</small>
        </div>
        <div className={'v3-readout ' + (k.bOk ? 'ok' : 'bad')}>
          <b>ب — من أقرب حافة إلى أقرب حافة</b>
          <div>
            {km2(k.b)} → {k.bOk ? 'ضمن النطاق ✓' : 'خارج النطاق ✕'}
          </div>
          <small>الخط البني المتصل. منطقة أكبر تقترب حافتها فتقصر المسافة.</small>
        </div>
      </div>
      <p className="v3-hint">
        الفرق هنا {km2(k.a - k.b)}: يساوي تقريباً نصف عرض الموقع ونصف قطر المنطقة. الطريقة نفسها تطبق على العلاقتين (الموقع ← الرئيسية، والرئيسية ← البديلة) ما لم يقرر المالك غير ذلك. الخادم يدعم اليوم الطريقتين في قواعد الموقع (CENTER وEDGE).
      </p>
      <p className="v3-open" data-testid="owner-decision">قرار المالك (3 نوفمبر 2026): <b>أ — من المركز إلى المركز</b>، للعلاقتين.</p>
    </>
  );
}
