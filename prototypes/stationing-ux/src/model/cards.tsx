import { useState, type ReactNode } from 'react';
import { SITES, orgById, pathOf } from '../data';
import { SymbolMark, type Symbols } from '../symbols';
import { comparison, formatKm, mainSiteOf, orgName, rangeText, siteOf } from './compare';
import type { Ask } from './dialog';
import {
  CAND_LABEL,
  DAY,
  EXT_LABEL,
  FACT_LABEL,
  STATE_LABEL,
  blocking,
  check,
  clashes,
  coveredBy,
  day,
  descendants,
  when,
  permanentOf,
  person,
  roleName,
  temporaryOf,
  unitsOf,
  type Action,
  type Event,
  type Request,
  type Stationing,
  type World,
} from './domain';
import { PROFILE } from './fixtures';
import type { Sel } from './scenarios';

export type CardCtx = {
  world: World;
  actor: string;
  act: (a: Action) => void;
  ask: (a: Ask) => void;
  select: (s: Sel) => void;
  symbols: Symbols;
  showAreas: boolean;
  setShowAreas: (v: boolean) => void;
  expandTemps: boolean;
  setExpandTemps: (v: boolean) => void;
  newRequest: (org: string) => void;
};

const END_LABEL: Record<NonNullable<Stationing['endReason']>, string> = {
  EXPIRED: 'انتهى عند نهايته المعتمدة (انتقال نظام)',
  EARLY_RETURN: 'عودة مبكرة بقرار مستقل',
  SUPERSEDED_BY_EXTENSION: 'استمر بتمديد مُفعَّل',
  SUPERSEDED_BY_PERMANENT_STATIONING: 'حلّ محله تمركز دائم معتمد (انتقال ذري)',
  REPLACED_BY_ACTIVATION: 'حلّ محله تمركز دائم مُفعَّل',
};

export const who = (w: World, id: string | undefined) =>
  id === 'system' ? 'النظام' : id ? (person(w, id)?.name ?? id) + (person(w, id)?.title ? ' (' + person(w, id)!.title + ')' : '') : '—';

type ActKind = 'auth' | 'destructive' | 'primary' | 'plain';
/**
 * A guarded action: enabled only when the simulated rules allow it for the simulated person, otherwise with the reason.
 * Sensitive ones open their own reason dialog (B3) and look different from ordinary buttons.
 */
function Act({ c, a, label, kind = 'plain', dialog }: { c: CardCtx; a: Action; label: string; kind?: ActKind; dialog?: Omit<Ask, 'action'> }) {
  const probe = (dialog ? { ...a, reason: 'سبب للتحقق من الإتاحة', policyRef: 'مرجع' } : a) as Action;
  const v = check(c.world, c.actor, probe);
  const cls = kind === 'auth' ? 'md-auth' : kind === 'destructive' ? 'md-destr' : kind === 'primary' ? 'primary' : '';
  return (
    <div className="md-act">
      <button className={'ux-btn ' + cls} disabled={!v.ok} onClick={() => (dialog ? c.ask({ ...dialog, action: a }) : c.act(a))} data-act={a.t}>
        {kind === 'auth' && <span aria-hidden="true">⚑ </span>}
        {kind === 'destructive' && <span aria-hidden="true">⚠ </span>}
        {label}
      </button>
      {!v.ok && <small className="md-why">{v.reason}</small>}
    </div>
  );
}

function Head({ c, title, sub, org, onClose }: { c: CardCtx; title: ReactNode; sub?: ReactNode; org?: string; onClose: () => void }) {
  return (
    <header className="ux-card-head md-head">
      <div className="ux-with-sym">
        {org && <SymbolMark url={c.symbols.get(org)} name={orgName(org)} size={26} />}
        <div>
          <h2>{title}</h2>
          {sub && <div className="ux-crumbs">{sub}</div>}
        </div>
      </div>
      <button className="ux-x" aria-label="إغلاق" onClick={onClose}>
        ✕
      </button>
    </header>
  );
}

const stateClass = (s: string) =>
  /CANCELLED|REJECTED|LAPSED|BLOCKED|WITHOUT_START|NO_LONGER/.test(s) ? 'bad' : /PENDING|NOT_ACCEPTED|SCHEDULED|APPROVED_NOT|REQUESTED|PROPOSED/.test(s) ? 'warn' : /ACTIVE|ACTIVATED/.test(s) ? 'ok' : 'info';

export function StateChip({ state, label }: { state: string; label: string }) {
  return (
    <span className={'md-state ' + stateClass(state)} data-state={state}>
      {label}
    </span>
  );
}

/** Ordinary actions, then the binding ones in their own block. */
function Actions({ plain, binding }: { plain: ReactNode[]; binding: ReactNode[] }) {
  const p = plain.filter(Boolean);
  const b = binding.filter(Boolean);
  return (
    <>
      {p.length > 0 && <div className="ux-actions md-actions">{p}</div>}
      {b.length > 0 && (
        <div className="md-binding" role="group" aria-label="إجراءات نافذة">
          <b className="md-k">إجراءات نافذة — كل منها بسبب إلزامي وتدقيق</b>
          <div className="ux-actions">{b}</div>
        </div>
      )}
    </>
  );
}

function Events({ w, list }: { w: World; list: Event[] }) {
  const [all, setAll] = useState(false);
  return (
    <details className="md-block" open>
      <summary className="md-k">سجل التدقيق (محاكى)</summary>
      <ol className="md-events" data-testid="events">
        {(all ? list : list.slice(0, 6)).map((e, i) => (
          <li key={i}>
            <span className="ux-mono">{e.type}</span>
            <small>
              {day(e.at)} · {who(w, e.actor)} · {e.detail}
            </small>
            {e.data && (
              <small className="md-data">
                {Object.entries(e.data).map(([k, v]) => (
                  <span key={k}>
                    <span className="ux-mono">{k}</span>: {v}
                  </span>
                ))}
              </small>
            )}
          </li>
        ))}
      </ol>
      {list.length > 6 && (
        <button className="ux-link" onClick={() => setAll(!all)}>
          {all ? 'أقل' : 'كل الأحداث (' + list.length + ')'}
        </button>
      )}
    </details>
  );
}

// ---- organisation ----

export function OrgCard({ c, id }: { c: CardCtx; id: string }) {
  const w = c.world;
  const perm = permanentOf(w, id);
  const site = siteOf(w, perm?.siteId);
  const temp = temporaryOf(w, id);
  const areas = w.areas.filter((a) => a.stationingId === perm?.id && a.status === 'ACTIVE');
  const units = descendants(w, id);
  const away = units.filter((u) => temporaryOf(w, u));
  const reqs = w.requests.filter((r) => r.org === id || unitsOf(w, r).includes(id));
  const history = w.stationings
    .filter((s) => s.org === id && (s.state === 'ENDED' || s.state === 'CANCELLED_BEFORE_START' || s.state === 'WINDOW_EXPIRED_WITHOUT_START') && !s.extendsId)
    .sort((a, b) => (b.to ?? 0) - (a.to ?? 0));
  const held = temp && w.requests.find((r) => r.id === temp.requestId)?.state === 'START_HELD_PENDING_CANCELLATION';
  const covered = perm ? coveredBy(w, perm.id) : [];
  return (
    <section className="ux-card md-card" aria-label={'الجهة ' + orgName(id)}>
      <Head c={c} org={id} title={orgName(id)} sub={pathOf(id).map((o) => o.name).join(' / ') || 'الجهة العليا'} onClose={() => c.select(null)} />

      <div className="md-block perm">
        <b className="md-k">التمركز الدائم</b>
        {perm && site ? (
          <>
            <p className="md-v">
              <span className="md-swatch perm" /> المقر الرئيسي الحالي: <b>{site.name}</b>
            </p>
            <small>
              منذ {day(perm.from)} · {perm.requestId ? 'بتفعيل الطلب ' + w.requests.find((r) => r.id === perm.requestId)?.number : 'تحديد إداري للمقر الرئيسي'}
            </small>
          </>
        ) : (
          <p className="md-v">لا مقر رئيسي محدد — لا يُستنتج من أي موقع</p>
        )}
      </div>

      {temp && (
        <div className="md-block temp" data-testid="effective-temporary">
          <b className="md-k">{temp.state === 'ACTIVE' ? 'التمركز الفعلي المؤقت' : held ? 'تمركز مؤقت مُفعَّل — البدء موقوف' : 'تمركز مؤقت مُفعَّل لم يبدأ'}</b>
          <p className="md-v">
            <span className="md-swatch temp" /> {siteOf(w, temp.siteId)?.name}
          </p>
          <small>
            {day(temp.plannedStart!)} ← {day(temp.plannedEnd!)} ·{' '}
            {temp.state === 'ACTIVE' ? 'ساري؛ الدائم محفوظ ولم يُنهَ' : held ? 'بلغ البداية وطلب الإلغاء قبل البدء قيد القرار: لم يبدأ النفاذ، والتمركز الفعلي هو الدائم' : 'التمركز الفعلي حتى البداية: الدائم'}
          </small>
          {temp.state === 'ACTIVE' && temp.startRef && (
            <small data-testid="org-late-start">
              بدأ النفاذ من وقت قرار رفض الإلغاء {when(temp.from)} — لا من البداية المعتمدة {when(temp.plannedStart!)}؛ النهاية المعتمدة لم تتغير.
            </small>
          )}
          {areas.length > 0 && (
            <small className="md-note-a3" data-testid="a3-note">
              المنطقتان المرتبطتان بالتمركز الدائم تبقيان سارية: المؤقت لا يُنهي الدائم ولا منطقتيه.
            </small>
          )}
          <button className="ux-link" onClick={() => c.select({ k: 'req', id: temp.requestId! })}>
            الطلب {w.requests.find((r) => r.id === temp.requestId)?.number}
          </button>
        </div>
      )}

      {areas.length > 0 && (
        <div className="md-block">
          <button className={'ux-chip md-toggle ' + (c.showAreas ? 'on' : '')} aria-pressed={c.showAreas} onClick={() => c.setShowAreas(!c.showAreas)} data-testid="toggle-areas">
            {c.showAreas ? 'إخفاء المنطقتين المرتبطتين' : 'إظهار المنطقتين المرتبطتين (' + areas.length + ')'}
          </button>
          {c.showAreas && (
            <>
              <ul className="md-list">
                {areas.map((a) => (
                  <li key={a.id}>
                    <span className={'md-swatch ' + (a.role === 'PRIMARY_AREA' ? 'area-p' : 'area-a')} />
                    <span>
                      <b>{a.role === 'PRIMARY_AREA' ? 'المنطقة الرئيسية المرتبطة بالتمركز' : 'المنطقة البديلة المرتبطة بالتمركز'}</b>
                      <small>
                        نشطة من {day(a.validFrom)}
                        {a.validTo ? ' حتى ' + day(a.validTo) : ''} · تمنع التداخل افتراضياً ·{' '}
                        {a.provenance.kind === 'IN_APP_REQUEST'
                          ? 'اعتُمدت داخل التطبيق: ' + a.provenance.request
                          : 'قرار خارجي ' + a.provenance.reference + ' من «' + a.provenance.authority + '» بتاريخ ' + day(a.provenance.date) + ' · سجّله ' + who(w, a.provenance.registeredBy)}
                      </small>
                    </span>
                  </li>
                ))}
              </ul>
              <small data-testid="covered-scope">
                النطاق المغطى (covered_organization_scope): {covered.map(orgName).join('، ')} — حجوزاتها داخل المنطقتين لا تتعارض معهما وحدهما. غيرها، ومنها
                الوحدات غير المدرجة، يخضع للقاعدة العادية.
              </small>
            </>
          )}
        </div>
      )}

      {units.length > 0 && (
        <div className="md-block" data-testid="units">
          <b className="md-k">الوحدات التابعة ({units.length})</b>
          <small>
            في التمركز الدائم: {units.length - away.length} · في تمركز مؤقت: {away.length}
          </small>
          <ul className="md-list units">
            {units.map((u) => {
              const t = temporaryOf(w, u);
              return (
                <li key={u} className={t ? 'away' : ''}>
                  <span style={{ paddingInlineStart: (pathOf(u).length - pathOf(id).length - 1) * 14 }} />
                  <span>
                    <b>{orgName(u)}</b>
                    <small>{t ? 'تمركز مؤقت: ' + siteOf(w, t.siteId)?.name + ' حتى ' + day(t.plannedEnd!) : 'في التمركز الدائم: ' + (mainSiteOf(w, u)?.name ?? '—')}</small>
                  </span>
                  <span className={'md-badge ' + (t ? 'temp' : 'perm')}>{t ? 'مؤقت' : 'دائم'}</span>
                </li>
              );
            })}
          </ul>
          {away.length > 0 && (
            <button className={'ux-chip md-toggle ' + (c.expandTemps ? 'on' : '')} aria-pressed={c.expandTemps} onClick={() => c.setExpandTemps(!c.expandTemps)} data-testid="toggle-temps">
              {c.expandTemps ? 'إخفاء مواقع الوحدات المؤقتة' : 'إظهار مواقع الوحدات المؤقتة على الخريطة'}
            </button>
          )}
        </div>
      )}

      {history.length > 0 && (
        <details className="md-block" open data-testid="history">
          <summary className="md-k">سجل التمركز السابق ({history.length}) — لا يُحذف</summary>
          <ul className="md-list">
            {history.map((h) => (
              <li key={h.id}>
                <span className={'md-swatch ' + (h.kind === 'PERMANENT' ? 'perm' : 'temp')} />
                <span>
                  <b>
                    {h.kind === 'PERMANENT' ? 'دائم' : 'مؤقت'}: {siteOf(w, h.siteId)?.name}
                  </b>
                  <small>
                    {h.state === 'CANCELLED_BEFORE_START'
                      ? 'مُفعَّل ثم أُلغي قبل بدء النفاذ (' + day(h.plannedStart!) + ' ← ' + day(h.plannedEnd!) + ') — لم يصبح نافذاً'
                      : h.state === 'WINDOW_EXPIRED_WITHOUT_START'
                        ? 'مُفعَّل، وظل البدء موقوفاً بانتظار قرار الإلغاء حتى انقضت نافذته (' + day(h.plannedStart!) + ' ← ' + day(h.plannedEnd!) + ') — لم يصبح نافذاً'
                        : day(h.from) + ' ← ' + day(h.to!) + ' · ' + END_LABEL[h.endReason!] + (h.startRef ? ' · بدأ متأخراً بقرار؛ البداية المعتمدة ' + day(h.plannedStart!) : '')}
                  </small>
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="md-block">
        <b className="md-k">طلبات إعادة التمركز</b>
        {reqs.length === 0 && <small>لا طلبات.</small>}
        <ul className="md-list">
          {reqs.map((r) => (
            <li key={r.id}>
              <button className="md-row" onClick={() => c.select(r.state === 'DRAFT' ? { k: 'edit', id: r.id } : { k: 'req', id: r.id })}>
                <span className="ux-mono">{r.number}</span>
                <span>
                  {r.duration.type === 'PERMANENT' ? 'دائم' : 'مؤقت'} · {r.scope.whole ? 'كاملة' : 'جزء'}
                </span>
                <StateChip state={r.state} label={STATE_LABEL[r.state]} />
              </button>
            </li>
          ))}
        </ul>
        <div className="ux-actions">
          <button className="ux-btn primary" onClick={() => c.newRequest(id)}>
            ⇄ طلب إعادة تمركز
          </button>
        </div>
      </div>
    </section>
  );
}

// ---- comparison ----

export function CompareTable({ w, r }: { w: World; r: Request }) {
  const rows = comparison(w, r);
  const cell = (k: string) => rows.find((x) => x.key === k);
  const cols = ['CURRENT', 'PRIMARY', 'ALTERNATIVE'].filter((k) => cell(k));
  const cand = (k: string) => (k === 'CURRENT' ? null : r.candidates[k as 'PRIMARY' | 'ALTERNATIVE']);
  return (
    <table className="md-compare" data-testid="compare">
      <thead>
        <tr>
          <th />
          {cols.map((k) => (
            <th key={k} className={'c-' + k.toLowerCase()}>
              <span className={'md-swatch ' + (k === 'CURRENT' ? 'perm' : k === 'PRIMARY' ? 'cand-p' : 'cand-a')} /> {cell(k)!.title}
              {r.active === k && r.state !== 'DRAFT' && <em className="md-active">نشط</em>}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>الموقع</td>
          {cols.map((k) => (
            <td key={k}>{cell(k)!.name}</td>
          ))}
        </tr>
        <tr>
          <td>الحالة</td>
          {cols.map((k) => (
            <td key={k}>{cand(k) ? CAND_LABEL[cand(k)!.status] + (cand(k)!.reason ? ' — ' + cand(k)!.reason : '') : 'معتمد حالياً'}</td>
          ))}
        </tr>
        <tr>
          <td>المسافة</td>
          {cols.map((k) => (
            <td key={k}>{cell(k)!.dist !== undefined ? formatKm(cell(k)!.dist!) + ' ' + cell(k)!.from : '—'}</td>
          ))}
        </tr>
        <tr>
          <td>النطاق المهيأ</td>
          {cols.map((k) => (
            <td key={k} className={cell(k)!.range ? (cell(k)!.inRange ? 'good' : 'bad') : ''}>
              {cell(k)!.range ? rangeText(cell(k)!.range!) + (cell(k)!.inRange ? ' ✓' : ' ✕ خارج النطاق') : '—'}
            </td>
          ))}
        </tr>
        <tr>
          <td>الشكل · المساحة</td>
          {cols.map((k) => (
            <td key={k} className={cell(k)!.shapeOk ? '' : 'bad'}>
              {(cell(k)!.shapeOk ? 'سليم' : 'متقاطع') + ' · ' + cell(k)!.area}
            </td>
          ))}
        </tr>
        <tr>
          <td>الإتاحة</td>
          {cols.map((k) => (
            <td key={k} className={cell(k)!.conflicts.length ? 'bad' : ''}>
              {k === 'CURRENT' ? '—' : cell(k)!.conflicts.length ? 'تعارض: ' + cell(k)!.conflicts.join('، ') : 'لا تعارض'}
            </td>
          ))}
        </tr>
      </tbody>
      <caption>
        القيم من «{PROFILE.name}» ({PROFILE.reference}) — مثال وهمي، لا قيمة في الكود. البديل يُقاس من الرئيسي المقترح لا من المقر الحالي.
      </caption>
    </table>
  );
}

// ---- request ----

export function RequestCard({ c, id }: { c: CardCtx; id: string }) {
  const w = c.world;
  const r = w.requests.find((x) => x.id === id)!;
  const ext = w.extensions.filter((e) => e.parent === r.id);
  const ers = w.earlyReturns.filter((e) => e.request === r.id);
  const scs = w.startCancellations.filter((e) => e.request === r.id);
  const units = unitsOf(w, r);
  const stage = r.stages[r.cursor];
  const reviewing = ['SUBMITTED', 'UNDER_REVIEW_PRIMARY', 'UNDER_REVIEW_ALTERNATIVE'].includes(r.state);
  const temps = units.map((u) => w.stationings.find((s) => s.org === u && s.requestId === r.id && s.kind === 'TEMPORARY' && !s.extendsId)).filter(Boolean) as Stationing[];
  // includes the supersession of a temporary stationing recorded under the temporary request (A1)
  const events = w.events.filter((e) => e.ref === r.number || e.data?.permanentRequest === r.number || ext.some((x) => x.number === e.ref)).slice().reverse();
  const rec = r.number + ' · ' + orgName(r.org);
  const endingTemps = (r.supersedes ?? []).map((tid) => w.stationings.find((s) => s.id === tid)).filter((t) => t && t.state !== 'ENDED') as Stationing[];
  const atomic = r.duration.type === 'PERMANENT' && endingTemps.length > 0;
  const held = r.state === 'START_HELD_PENDING_CANCELLATION';
  // the authorised end: the approved one, or an activated extension's (never changed by a held start)
  const authEnd = Math.max(r.duration.end ?? 0, ...w.stationings.filter((s) => s.requestId === r.id && s.kind === 'TEMPORARY' && (s.state === 'ACTIVE' || s.state === 'SCHEDULED')).map((s) => s.plannedEnd ?? 0));
  const lateStart = temps.find((t) => t.startRef);

  const plain: ReactNode[] = [];
  const binding: ReactNode[] = [];
  if (reviewing && stage) {
    plain.push(<Act key="ap" c={c} a={{ t: 'APPROVE_STAGE', req: r.id }} label={stage.final ? 'اعتماد نهائي للمرشح ' + roleName(r.active) : 'اعتماد مرحلة «' + stage.name + '»'} kind="primary" />);
    plain.push(
      <Act key="na" c={c} a={{ t: 'NOT_ACCEPT', req: r.id, reason: '' }} label={'لم يُقبل المرشح ' + roleName(r.active)} dialog={{ title: 'المرشح ' + roleName(r.active) + ' لم يُقبل', record: rec + ' · المرشح ' + roleName(r.active), consequence: r.active === 'PRIMARY' ? 'يصير الطلب «الرئيسي لم يُقبل» وينتظر تبديلاً مخوّلاً إلى البديل أو رفضاً. لا يُستبدل أي مرشح تلقائياً.' : 'يُرفض الطلب ما لم يُعد فتح الرئيسي.', kind: 'normal', confirm: 'تسجيل «لم يُقبل»' }} />,
    );
    plain.push(<Act key="rt" c={c} a={{ t: 'RETURN', req: r.id, reason: '' }} label="إرجاع للتعديل" dialog={{ title: 'إرجاع الطلب لمقدمه', record: rec, consequence: 'يُعاد للتعديل؛ المرشح النشط لا يتغير. عند إعادة الإرسال تُبطل فقط القرارات التي تغيّرت حقائقها.', kind: 'normal', confirm: 'إرجاع' }} />);
  }
  if ((r.state === 'PRIMARY_NOT_ACCEPTED' || r.state === 'UNDER_REVIEW_ALTERNATIVE') && r.candidates.PRIMARY.status === 'NOT_ACCEPTED') {
    if (r.state === 'PRIMARY_NOT_ACCEPTED')
      binding.push(
        <Act key="sw" c={c} a={{ t: 'SWITCH', req: r.id, reason: '' }} label="تبديل المرشح النشط إلى البديل" kind="auth" dialog={{ title: 'تبديل المرشح النشط', record: rec + ' · من الرئيسي إلى البديل', consequence: 'تبدأ مراجعة البديل من «دراسة الموقع والإتاحة». تبقى القرارات التي لا تعتمد على الموقع، وتُعاد مراحل الموقع للبديل. لا تُمس هندسة الرئيسي.', kind: 'auth', confirm: 'تبديل المرشح' }} />,
      );
    binding.push(
      <Act key="ro" c={c} a={{ t: 'REOPEN', req: r.id, role: 'PRIMARY', reason: '' }} label="إعادة فتح الرئيسي للمراجعة" kind="auth" dialog={{ title: 'إعادة فتح المرشح الرئيسي', record: rec + ' · الرئيسي (لم يُقبل، غير نهائي)', consequence: 'يصير الرئيسي المرشح النشط وتُعاد مراحل الموقع له؛ يعود البديل احتياطياً إن لم يُبت فيه.', kind: 'auth', confirm: 'إعادة الفتح' }} />,
    );
  }
  if (r.state === 'APPROVED_NOT_ACTIVATED' || r.state === 'CANCELLATION_PENDING') {
    binding.push(
      <Act
        key="ac"
        c={c}
        a={{ t: 'ACTIVATE', req: r.id }}
        kind="auth"
        label={atomic ? 'تفعيل: إنهاء المؤقت وتفعيل الدائم ذرياً' : r.duration.type === 'PERMANENT' ? 'تفعيل إعادة التمركز' : 'تفعيل التمركز المؤقت'}
        dialog={{
          title: atomic ? 'تفعيل ذري: إنهاء المؤقت وتفعيل الدائم' : 'تفعيل إعادة التمركز',
          record: rec + ' · المرشح المعتمد: ' + roleName(r.active) + ' «' + r.candidates[r.active].name + '»',
          consequence: atomic
            ? 'في عملية واحدة: ينتهي التمركز المؤقت لـ' + endingTemps.length + ' وحدة (سبب: حلّ محله الدائم المعتمد)، ويُنهى الدائم السابق ومنطقتاه وتبقى في التاريخ، ويُفتح الدائم الجديد. يسقط أي تمديد غير مفعَّل. المسؤولية عن المرافق لا تتغير.'
            : r.duration.type === 'PERMANENT'
              ? 'يُنهى التمركز الدائم السابق ومنطقتاه (يبقيان في التاريخ ولا تمنعان بعد الآن)، ويُفتح الدائم الجديد. المسؤولية عن المرافق لا تتغير.'
              : 'تُفتح طبقة مؤقتة فوق الدائم، نافذة من بدايتها المعتمدة. الدائم ومنطقتاه باقية.',
          kind: 'auth',
          confirm: 'تفعيل',
        }}
      />,
    );
    if (r.state === 'APPROVED_NOT_ACTIVATED')
      plain.push(<Act key="rc" c={c} a={{ t: 'REQUEST_CANCEL', req: r.id, reason: '' }} label="طلب إلغاء قبل التفعيل" dialog={{ title: 'طلب إلغاء قبل التفعيل', record: rec, consequence: 'يصير الطلب «طلب إلغاء قيد القرار» ويُمنع التفعيل حتى يقرر طرف مستقل.', kind: 'normal', confirm: 'تقديم الطلب' }} />);
    if (r.state === 'CANCELLATION_PENDING') {
      binding.push(
        <Act key="ca" c={c} a={{ t: 'DECIDE_CANCEL', req: r.id, approve: true, reason: '' }} label="قبول الإلغاء" kind="destructive" dialog={{ title: 'قبول الإلغاء قبل التفعيل', record: rec + ' · المرشح النشط ' + roleName(r.active), consequence: 'يصير الطلب «ملغى قبل التفعيل» ويستحيل تفعيله. التمركز الحالي لا يتغير، والمرشحان والقرارات تبقى في التاريخ.', kind: 'destructive', confirm: 'قبول الإلغاء' }} />,
      );
      binding.push(
        <Act key="cr" c={c} a={{ t: 'DECIDE_CANCEL', req: r.id, approve: false, reason: '' }} label="رفض الإلغاء" kind="auth" dialog={{ title: 'رفض طلب الإلغاء', record: rec, consequence: 'يعود الطلب «معتمد — لم يُفعَّل» ويصير التفعيل متاحاً مجدداً.', kind: 'auth', confirm: 'رفض الإلغاء' }} />,
      );
    }
  }
  if (r.state === 'TEMPORARY_SCHEDULED')
    plain.push(
      <Act key="sc" c={c} a={{ t: 'REQUEST_START_CANCEL', req: r.id, reason: '' }} label="طلب إلغاء التمركز المؤقت قبل بدء النفاذ" dialog={{ title: 'طلب إلغاء التمركز المؤقت قبل بدء النفاذ', record: rec + ' · ' + (r.activation?.ref ?? ''), consequence: 'يُعرض على صاحب صلاحية مستقل. إن قُبل لا يصبح المؤقت نافذاً أبداً ويبقى الدائم. ليس «عودة مبكرة»: لم يبدأ شيء بعد.', kind: 'normal', confirm: 'تقديم الطلب' }} />,
    );
  if (r.state === 'ACTIVE_TEMPORARY' || r.state === 'TEMPORARY_SCHEDULED') plain.push(<Act key="ex" c={c} a={{ t: 'REQUEST_EXTENSION', req: r.id, newEnd: effectiveEnd(w, r) + 30 * DAY }} label="طلب تمديد 30 يوماً" />);
  if (r.state === 'ACTIVE_TEMPORARY')
    plain.push(<Act key="er" c={c} a={{ t: 'REQUEST_EARLY_RETURN', req: r.id, reason: '' }} label="طلب عودة مبكرة" dialog={{ title: 'طلب عودة مبكرة', record: rec, consequence: 'يُعرض على صاحب صلاحية DECIDE_EARLY_RETURN مستقل.', kind: 'normal', confirm: 'تقديم الطلب' }} />);

  return (
    <section className="ux-card md-card" aria-label={'الطلب ' + r.number}>
      <Head c={c} org={r.org} title={<span className="ux-mono">{r.number}</span>} sub={'إعادة تمركز · ' + orgName(r.org)} onClose={() => c.select({ k: 'org', id: r.org })} />
      <div className="md-chips">
        <span className="md-tagline">{r.duration.type === 'PERMANENT' ? 'دائم' : 'مؤقت'}</span>
        <span className="md-tagline">{r.scope.whole ? 'الجهة كاملة (' + units.length + ' وحدة)' : 'جزء: ' + units.map(orgName).join('، ')}</span>
        <StateChip state={r.state} label={STATE_LABEL[r.state]} />
      </div>
      {r.duration.type === 'TEMPORARY' && (
        <p className="md-v small">
          الفترة المعتمدة: {day(r.duration.start)} ← {day(r.duration.end!)}
          {r.activation && ' · ' + r.activation.ref}
          {r.state === 'TEMPORARY_SCHEDULED' && ' · مُفعَّل ولم يبدأ: التمركز الفعلي هو الدائم حتى البداية'}
          {r.state === 'ACTIVE_TEMPORARY' && ' · ساري: الدائم ومنطقتاه باقية تحته'}
          {r.state === 'TEMPORARY_CANCELLED_BEFORE_START' && ' · أُلغي قبل بدء النفاذ: لم يصبح نافذاً، والدائم هو المعتمد'}
          {r.state === 'TEMPORARY_WINDOW_EXPIRED_WITHOUT_START' && ' · انقضت نافذته والبدء موقوف: لم يصبح نافذاً قط، والدائم هو المعتمد'}
        </p>
      )}
      {held && (
        <div className="md-alert warn" data-testid="start-held">
          بلغ البداية المعتمدة {when(r.duration.start)} وطلب الإلغاء قبل البدء ما زال قيد القرار: <b>البدء موقوف</b>، والتمركز الفعلي هو الدائم. لا تبدؤه مهمة البدء
          المجدولة. إن رُفض الطلب يبدأ النفاذ من وقت القرار — لا بأثر رجعي — وتبقى النهاية {day(authEnd)}؛ وإن انقضت النافذة قبل القرار يُغلق دون أن يصبح نافذاً.
        </div>
      )}
      {r.state === 'TEMPORARY_WINDOW_EXPIRED_WITHOUT_START' && (
        <div className="md-alert info" data-testid="window-expired">
          انقضت نافذة النفاذ ({day(r.duration.start)} ← {day(r.duration.end!)}) والبدء موقوف بانتظار قرار الإلغاء: أُغلق السجل المؤقت «انقضت النافذة دون بدء»، وطلب الإلغاء لم
          يعد قابلاً للقرار. السجلان محفوظان في التاريخ بسببهما.
        </div>
      )}
      {lateStart && r.state === 'ACTIVE_TEMPORARY' && (
        <div className="md-alert info" data-testid="late-start">
          بداية معتمدة {when(lateStart.plannedStart!)} · بداية النفاذ الفعلية {when(lateStart.from)} (وقت قرار رفض الإلغاء، دون أثر رجعي) · النهاية {day(authEnd)} لم تتغير.
        </div>
      )}
      {atomic && r.state === 'APPROVED_NOT_ACTIVATED' && (
        <div className="md-alert info" data-testid="supersedes">
          اعتُمد والنطاق في تمركز مؤقت ساري لـ{endingTemps.length} وحدة ({endingTemps.map((t) => orgName(t.org)).join('، ')}) حتى {day(endingTemps[0].plannedEnd!)}. لا يُفعَّل فوقه:
          التفعيل ينهي المؤقت ويفعّل الدائم في عملية واحدة، أو ينتظر انتهاء المؤقت.
        </div>
      )}
      {r.state === 'CANCELLATION_PENDING' && (
        <div className="md-alert warn" data-testid="cancel-pending">
          طلب إلغاء قبل التفعيل قيد القرار — التفعيل ممنوع في الانتقال نفسه، لا بتعطيل الزر فقط.
        </div>
      )}

      <CompareTable w={w} r={r} />

      {r.cancellation && (
        <div className="md-block">
          <b className="md-k">طلب إلغاء قبل التفعيل</b>
          <small>
            طلبه {who(w, r.cancellation.by)} · السبب: {r.cancellation.reason}
            {r.cancellation.decidedBy && ' · القرار: ' + (r.cancellation.state === 'APPROVED' ? 'مقبول' : 'مرفوض') + ' من ' + who(w, r.cancellation.decidedBy) + ' — ' + r.cancellation.decision}
            {' · المرشح النشط: ' + roleName(r.active)}
          </small>
        </div>
      )}
      {scs.map((sc) => (
        <div className="md-block" key={sc.id} data-testid="start-cancellation">
          <b className="md-k">إلغاء التمركز المؤقت قبل بدء النفاذ</b>
          <StateChip
            state={sc.state}
            label={{ REQUESTED: held ? 'قيد القرار — البدء موقوف' : 'قيد القرار', APPROVED: 'مقبول — لم يصبح نافذاً', REJECTED: 'مرفوض', NO_LONGER_ACTIONABLE: 'لم يعد قابلاً للقرار' }[sc.state]}
          />
          <small>
            طلبه {who(w, sc.by)} · السبب: {sc.reason} · مرجع التفعيل {sc.activationRef} · البداية المعتمدة {when(sc.plannedStart)} · النهاية {day(sc.plannedEnd)}
            {sc.heldAt !== undefined && ' · البدء موقوف منذ ' + when(sc.heldAt)}
            {sc.decidedBy && ' · قرره ' + who(w, sc.decidedBy) + ' في ' + when(sc.decidedAt!) + ' — ' + sc.decision}
            {sc.effectiveStart !== undefined && ' · بداية النفاذ الفعلية ' + when(sc.effectiveStart)}
            {sc.state === 'NO_LONGER_ACTIONABLE' && ' · أُغلق في ' + when(sc.closedAt!) + ': ' + sc.closeReason}
          </small>
          {sc.state === 'REQUESTED' && (
            <Actions
              plain={[]}
              binding={[
                <Act
                  key="y"
                  c={c}
                  a={{ t: 'DECIDE_START_CANCEL', sc: sc.id, approve: true, reason: '' }}
                  label="قبول الإلغاء قبل البدء"
                  kind="destructive"
                  dialog={{
                    title: 'إلغاء التمركز المؤقت قبل بدء النفاذ',
                    record: rec + ' · ' + sc.activationRef + ' · ' + day(sc.plannedStart) + ' ← ' + day(sc.plannedEnd) + (held ? ' · البدء موقوف منذ ' + when(sc.heldAt!) : ''),
                    consequence: 'لن يصبح المؤقت نافذاً أبداً، ولا تفعّله مهمة البدء المجدولة. يبقى الدائم المعتمد، ويبقى السجل المؤقت في التاريخ، ويسقط أي تمديد مرتبط.',
                    kind: 'destructive',
                    confirm: 'قبول الإلغاء',
                  }}
                />,
                <Act
                  key="n"
                  c={c}
                  a={{ t: 'DECIDE_START_CANCEL', sc: sc.id, approve: false, reason: '' }}
                  label={held ? 'رفض الإلغاء وبدء النفاذ الآن' : 'رفض'}
                  kind={held ? 'auth' : 'plain'}
                  dialog={
                    held
                      ? {
                          title: 'رفض الإلغاء بعد البداية المعتمدة',
                          record: rec + ' · البداية المعتمدة ' + when(sc.plannedStart) + ' · البدء موقوف منذ ' + when(sc.heldAt!),
                          consequence: 'يبدأ النفاذ من وقت هذا القرار (' + when(w.now) + ')، لا بأثر رجعي من البداية المعتمدة. النهاية ' + day(authEnd) + ' لا تتغير إلا بتمديد مُفعَّل. تُسجل البداية المعتمدة والفعلية ووقت القرار وسببه.',
                          kind: 'auth',
                          confirm: 'رفض الإلغاء',
                        }
                      : { title: 'رفض الإلغاء قبل البدء', record: rec, consequence: 'يعود المؤقت إلى «مُفعَّل — لم يبدأ» وينفذ عند بدايته المعتمدة ' + when(sc.plannedStart) + '.', kind: 'normal', confirm: 'رفض' }
                  }
                />,
              ]}
            />
          )}
        </div>
      ))}
      {ext.map((e) => (
        <div className="md-block" key={e.id} data-testid="extension">
          <b className="md-k">
            تمديد مرتبط <span className="ux-mono">{e.number}</span>
          </b>
          <StateChip state={e.state} label={EXT_LABEL[e.state]} />
          <small>
            النهاية المطلوبة {day(e.newEnd)} · النهاية الفعالة الآن {day(effectiveEnd(w, r))} · طلبه {who(w, e.requester)}
            {e.finalApprover && ' · اعتمده ' + who(w, e.finalApprover)}
            {e.lapsedAt !== undefined && ' · سقط في ' + day(e.lapsedAt) + ': ' + e.lapseReason}
          </small>
          {e.state === 'SUBMITTED' && <Actions plain={[<Act key="a" c={c} a={{ t: 'APPROVE_EXTENSION', ext: e.id }} label="اعتماد التمديد" />]} binding={[]} />}
          {e.state === 'EXTENSION_APPROVED_NOT_ACTIVATED' && (
            <Actions
              plain={[]}
              binding={[
                <Act key="a" c={c} a={{ t: 'ACTIVATE_EXTENSION', ext: e.id }} label="تفعيل التمديد" kind="auth" dialog={{ title: 'تفعيل التمديد', record: e.number + ' · حتى ' + day(e.newEnd), consequence: 'تُفتح فترة الصلاحية الجديدة عند النهاية الأصلية. ليس نقلاً فعلياً جديداً، ولا تُعدَّل التواريخ المعتمدة الأصلية.', kind: 'auth', confirm: 'تفعيل التمديد' }} />,
              ]}
            />
          )}
        </div>
      ))}
      {ers.map((e) => (
        <div className="md-block" key={e.id} data-testid="early-return">
          <b className="md-k">طلب عودة مبكرة</b>
          <StateChip state={e.state} label={{ REQUESTED: 'قيد القرار', APPROVED: 'مقبول — نُفّذت العودة', REJECTED: 'مرفوض', SUPERSEDED: 'منتهي الأثر' }[e.state]} />
          <small>
            طلبه {who(w, e.by)} · السبب: {e.reason} · النهاية المخططة {day(e.originalEnd)}
            {e.actualEnd !== undefined && ' · النهاية الفعلية ' + day(e.actualEnd)}
            {e.decidedBy && ' · قرره ' + who(w, e.decidedBy)}
          </small>
          {e.state === 'REQUESTED' && (
            <Actions
              plain={[]}
              binding={[
                <Act key="y" c={c} a={{ t: 'DECIDE_EARLY_RETURN', er: e.id, approve: true, reason: '' }} label="قبول العودة المبكرة" kind="destructive" dialog={{ title: 'قبول العودة المبكرة', record: rec + ' · النهاية المخططة ' + day(e.originalEnd), consequence: 'ينتهي التمركز المؤقت الآن ويعود النطاق إلى تمركزه الدائم. يُسجَّل الوقت الفعلي والنهاية المخططة. يسقط أي تمديد غير مفعَّل.', kind: 'destructive', confirm: 'قبول العودة' }} />,
                <Act key="n" c={c} a={{ t: 'DECIDE_EARLY_RETURN', er: e.id, approve: false, reason: '' }} label="رفض" dialog={{ title: 'رفض العودة المبكرة', record: rec, consequence: 'يستمر المؤقت حتى نهايته المعتمدة.', kind: 'normal', confirm: 'رفض' }} />,
              ]}
            />
          )}
        </div>
      ))}

      <details className="md-block" open={reviewing || r.state === 'PRIMARY_NOT_ACCEPTED'}>
        <summary className="md-k">مراحل الاعتماد وما يعتمد عليه كل قرار</summary>
        <ol className="md-stages">
          {r.stages.map((s, i) => (
            <li key={s.key} className={(s.mark ?? '').toLowerCase() + (i === r.cursor && reviewing ? ' current' : '')}>
              <span className="md-mark">
                {s.mark === 'APPROVED' ? '✓' : s.mark === 'CARRIED' ? '↷' : s.mark === 'INVALIDATED' ? '⟲' : i === r.cursor && (reviewing || r.state === 'PRIMARY_NOT_ACCEPTED') ? '●' : '○'}
              </span>
              <span>
                <b>{s.name}</b>
                <small>
                  يعتمد على: {s.dependsOn.map((f) => FACT_LABEL[f]).join('، ')}
                  {s.mark === 'APPROVED' && ' · ' + who(w, s.by) + (s.candidate ? ' · للمرشح ' + roleName(s.candidate) : '')}
                  {s.mark === 'CARRIED' && ' · قرار سابق محمول: لا يعتمد على الموقع'}
                  {s.mark === 'INVALIDATED' && ' · أُبطل لتغيّر المرشح؛ يُعاد للبديل'}
                </small>
              </span>
            </li>
          ))}
        </ol>
      </details>

      <Actions plain={plain} binding={binding} />

      {temps.length > 0 && (
        <p className="ux-note">
          سجلات مؤقتة: {temps.length} ·{' '}
          {temps
            .map(
              (t) =>
                orgName(t.org) +
                ': ' +
                ({ ACTIVE: 'ساري', SCHEDULED: held ? 'مجدول — البدء موقوف' : 'مجدول', ENDED: 'مُغلق', CANCELLED_BEFORE_START: 'أُلغي قبل البدء', WINDOW_EXPIRED_WITHOUT_START: 'انقضت النافذة دون بدء', CURRENT: '' }[t.state] ?? ''),
            )
            .join(' · ')}
        </p>
      )}
      <Events w={w} list={events} />
    </section>
  );
}

function effectiveEnd(w: World, r: Request) {
  const segs = w.stationings.filter((s) => s.requestId === r.id && s.kind === 'TEMPORARY' && s.org === unitsOf(w, r)[0] && s.state !== 'ENDED');
  return Math.max(r.duration.end ?? 0, ...segs.filter((s) => s.state === 'ACTIVE' || !s.extendsId).map((s) => s.plannedEnd ?? 0));
}

// ---- an administrative reservation and its availability check (scenarios 20–22) ----

const RES_LABEL = { PROPOSED: 'مقترح', BLOCKED: 'ممنوع افتراضياً', EXCEPTION_REQUESTED: 'استثناء قيد القرار', ACTIVE: 'نافذ', REJECTED: 'مرفوض' } as const;

export function ReservationCard({ c, id }: { c: CardCtx; id: string }) {
  const w = c.world;
  const res = w.reservations.find((x) => x.id === id)!;
  const cl = clashes(w, res.org, res.ring, res.from, res.to, res.id);
  const b = blocking(cl);
  const rec = res.number + ' · ' + orgName(res.org) + ' · ' + res.name;
  const events = w.events.filter((e) => e.ref === res.number).slice().reverse();
  return (
    <section className="ux-card md-card" aria-label={'الحجز ' + res.number}>
      <Head c={c} org={res.org} title={<span className="ux-mono">{res.number}</span>} sub={'حجز إداري · ' + orgName(res.org) + ' · ' + res.name} onClose={() => c.select(null)} />
      <div className="md-chips">
        <span className="md-tagline">
          {day(res.from)} ← {day(res.to)}
        </span>
        <StateChip state={res.state} label={RES_LABEL[res.state]} />
      </div>
      <div className="md-block" data-testid="availability">
        <b className="md-k">فحص الإتاحة: تداخل في المكان والزمن</b>
        {cl.length === 0 && <small>لا تداخل مع أي منطقة أو حجز.</small>}
        <ul className="md-list">
          {cl.map((x) => {
            const area = w.areas.find((a) => a.id === x.id);
            const scope = area ? coveredBy(w, area.stationingId) : [];
            return (
              <li key={x.id} className={x.exempt ? 'exempt' : 'clash'} data-testid={x.exempt ? 'clash-exempt' : 'clash-blocking'}>
                <span className={'md-swatch ' + (x.kind === 'AREA' ? 'area-p' : 'off')} />
                <span>
                  <b>{x.label}</b>
                  <small>
                    تداخل مكاني ✓ · تداخل زمني من {day(x.from)}
                    {x.to ? ' حتى ' + day(x.to) : ' (مفتوح)'}
                  </small>
                  {x.kind === 'AREA' && (
                    <small>
                      النطاق المغطى: {scope.map(orgName).join('، ')} —{' '}
                      {x.exempt ? (
                        <b className="good">لا يمنع: «{orgName(res.org)}» ضمن النطاق المعتمد للمنطقة؛ الفحوص الأخرى مستمرة</b>
                      ) : (
                        <b className="bad">يمنع افتراضياً: «{orgName(res.org)}» خارج النطاق المغطى{orgById.get(res.org)?.parentId && scope.includes(orgById.get(res.org)!.parentId!) ? ' (وحدة تابعة غير مدرجة صراحةً)' : ''}</b>
                      )}
                    </small>
                  )}
                  {x.kind === 'RESERVATION' && <small className="bad">يمنع: حجز نافذ لجهة أخرى</small>}
                </span>
              </li>
            );
          })}
        </ul>
        <p className={'md-verdict ' + (b.length && !(res.state === 'ACTIVE' && res.exception?.approved) ? 'bad' : 'good')} data-testid="verdict">
          {res.state === 'ACTIVE' && res.exception?.approved
            ? 'النتيجة: نافذ بموجب استثناء معتمد (' + res.exception.policyRef + ') رغم ' + b.length + ' تعارض؛ لم يُتجاوز المنع بصمت.'
            : b.length
              ? 'النتيجة: منع (BLOCK) — ' + b.length + ' تعارض. المشاركة أو الاستثناء بسياسة واعتماد مستقل فقط.'
              : 'النتيجة: لا تعارض' + (cl.some((x) => x.exempt) ? ' — الإعفاء من منطقة النطاق المغطى فقط' : '')}
        </p>
      </div>
      {res.exception && (
        <div className="md-block" data-testid="exception">
          <b className="md-k">استثناء / مشاركة</b>
          <small>
            طلبه {who(w, res.exception.requestedBy)} · السبب: {res.exception.reason} · مرجع السياسة: {res.exception.policyRef}
            {res.exception.decidedBy && ' · القرار: ' + (res.exception.approved ? 'معتمد' : 'مرفوض') + ' من ' + who(w, res.exception.decidedBy) + ' — ' + res.exception.decision}
          </small>
        </div>
      )}
      <Actions
        plain={[
          res.state === 'PROPOSED' && <Act key="cf" c={c} a={{ t: 'CONFIRM_RESERVATION', res: res.id }} label="تأكيد الحجز (فحص الإتاحة)" kind="primary" />,
          res.state === 'BLOCKED' && (
            <Act
              key="rq"
              c={c}
              a={{ t: 'REQUEST_EXCEPTION', res: res.id, reason: '', policyRef: '' }}
              label="طلب استثناء / مشاركة"
              dialog={{ title: 'طلب استثناء أو مشاركة', record: rec, consequence: 'يُعرض على صاحب صلاحية APPROVE_AVAILABILITY_EXCEPTION مستقل. لا يصير الحجز نافذاً قبل اعتماده.', kind: 'normal', confirm: 'تقديم الطلب', policyRef: true }}
            />
          ),
        ]}
        binding={[
          res.state === 'EXCEPTION_REQUESTED' && (
            <Act
              key="ya"
              c={c}
              a={{ t: 'DECIDE_EXCEPTION', res: res.id, approve: true, reason: '' }}
              label="اعتماد الاستثناء"
              kind="auth"
              dialog={{ title: 'اعتماد استثناء التداخل', record: rec + ' · مقابل: ' + b.map((x) => x.label).join('، ') + ' · مرجع السياسة ' + (res.exception?.policyRef ?? ''), consequence: 'يصير الحجز نافذاً مشاركةً مع ما يتداخل معه، بموجب السياسة المذكورة. يُسجَّل الحدث AREA_EXCEPTION_APPROVED.', kind: 'auth', confirm: 'اعتماد الاستثناء' }}
            />
          ),
          res.state === 'EXCEPTION_REQUESTED' && <Act key="na" c={c} a={{ t: 'DECIDE_EXCEPTION', res: res.id, approve: false, reason: '' }} label="رفض الاستثناء" dialog={{ title: 'رفض الاستثناء', record: rec, consequence: 'يبقى الحجز مرفوضاً؛ المنع قائم.', kind: 'normal', confirm: 'رفض' }} />,
        ]}
      />
      <Events w={w} list={events} />
    </section>
  );
}

// ---- a site whose permanent occupant is temporarily away (scenario 17) ----

export function SiteCard({ c, id }: { c: CardCtx; id: string }) {
  const w = c.world;
  const s = siteOf(w, id)!;
  const based = w.stationings.filter((x) => x.kind === 'PERMANENT' && x.state === 'CURRENT' && x.siteId === id);
  const facility = SITES.find((x) => 'site-' + x.code === id);
  const [asked, setAsked] = useState(false);
  return (
    <section className="ux-card md-card" aria-label={'الموقع ' + s.name}>
      <Head c={c} title={s.name} sub="موقع مسجل · بيانات وهمية" onClose={() => c.select(null)} />
      <div className="md-block perm">
        <b className="md-k">التمركز الدائم في هذا الموقع</b>
        <ul className="md-list">
          {based.map((b) => {
            const t = temporaryOf(w, b.org);
            return (
              <li key={b.id}>
                <SymbolMark url={c.symbols.get(b.org)} name={orgName(b.org)} />
                <span>
                  <b>{orgName(b.org)}</b>
                  <small>{t ? 'في تمركز مؤقت في «' + siteOf(w, t.siteId)?.name + '» حتى ' + day(t.plannedEnd!) + ' — التمركز الدائم هنا باقٍ' : 'هنا'}</small>
                </span>
              </li>
            );
          })}
        </ul>
      </div>
      <div className="md-alert warn" data-testid="absence-note">
        الغياب المؤقت لا يُخلي هذا الموقع ولا يتيحه ولا ينقل المسؤولية عنه. الإتاحة يحددها سجل المرفق وحجوزاته كما هي، لا التمركز.
      </div>
      <div className="md-block">
        <b className="md-k">الإتاحة من سجل المرفق (وهمي)</b>
        <small>
          {facility?.status === 'BUSY' ? 'غير متاح — حجوزات قائمة في السجل' : facility?.status === 'PARTIAL' ? 'إشغال جزئي في السجل' : 'متاح في السجل'} · الجهة المسؤولة عن المرفق:{' '}
          {facility ? orgById.get(facility.responsible)?.name : '—'}
        </small>
      </div>
      <div className="ux-actions">
        <button className="ux-btn primary" onClick={() => setAsked(true)} data-testid="facility-use">
          طلب استخدام المرفق
        </button>
      </div>
      {asked && (
        <div className="md-alert info" data-testid="facility-use-note">
          إجراء مستقل: «طلب استخدام» في التطبيق، بصلاحية مقدمه وفحص إتاحة المرفق ومسؤوليه. لا يُحاكى هنا، ولا يقرأ التمركز المؤقت لأي جهة.
        </div>
      )}
      <p className="ux-note">تعمل الآن بصفة: {who(w, c.actor)}</p>
    </section>
  );
}
