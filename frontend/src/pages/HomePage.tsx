import { Suspense, lazy, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, type HomeCard } from '../api/client';
import type { AuditEvent, Notification, RestationingListItem, RestationingState, StationingRecord } from '../api/types';
import { BrandMark } from '../components/shell/TopNavigation';
import { Icon } from '../components/ui';
import { StatePill } from '../components/workspace/StatePill';
import { useApp } from '../lib/app';
import { fullDate, fullTime } from '../lib/dates';
import { restriction } from '../lib/navigation';
import { STATIONING_V3_ENABLED } from '../lib/stationingV3';

// the offline map is loaded on demand, as on «إعادة التمركز»
const MapOverview = lazy(() => import('../components/workspace/MapOverview'));

const REVIEW: RestationingState[] = ['UNDER_REVIEW', 'CANCELLATION_PENDING', 'START_HELD_PENDING_CANCELLATION'];
const BLOCKED: RestationingState[] = ['PAUSED_HIERARCHY_CHANGED', 'RETURNED_FOR_CHANGES', 'REJECTED'];
const DAY = 86_400_000;

function Tile({ icon, value, label, sub, tone = '', href }: { icon: string; value: ReactNode; label: string; sub?: ReactNode; tone?: string; href?: string }) {
  const body = (
    <>
      <span className={'tz-tile-icon ' + tone}>
        <Icon name={icon} />
      </span>
      <span className="tz-tile-text">
        <b>{value}</b>
        <span>{label}</span>
        {sub && <small>{sub}</small>}
      </span>
    </>
  );
  return href ? (
    <a className={'tz-tile ' + tone} href={href}>
      {body}
    </a>
  ) : (
    <div className={'tz-tile ' + tone}>{body}</div>
  );
}

/**
 * «الرئيسية»: the home dashboard in the workspace's visual language (owner brief, §21) — live counts from the
 * server (each list is asked for only with a right its endpoint accepts), the upcoming returns of temporary
 * stationings, a small map of the visible sites, and the latest notifications and audit events. Practical, no splash.
 */
export function HomePage() {
  const app = useApp();
  const canRs = STATIONING_V3_ENABLED && !restriction('restationing', app.can, app.summaryOnly);
  const canSites = !restriction('stationing', app.can, app.summaryOnly);
  const canUnits = !restriction('org', app.can, app.summaryOnly);
  const canAudit = app.can('AUDIT');
  const [requests, setRequests] = useState<RestationingListItem[] | null>(null);
  const [current, setCurrent] = useState<StationingRecord[] | null>(null);
  const [notes, setNotes] = useState<Notification[] | null>(null);
  const [audit, setAudit] = useState<AuditEvent[] | null>(null);
  const [cards, setCards] = useState<HomeCard[]>([]);
  useEffect(() => {
    api.homeCards().then(setCards).catch(() => setCards([]));
  }, [app.revision]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (canRs) api.restationingRequests().then(setRequests).catch(() => setRequests([]));
    if (STATIONING_V3_ENABLED && (app.can('VIEW') || app.can('VIEW_SUMMARY') || app.can('AUDIT'))) api.stationingCurrent().then(setCurrent).catch(() => setCurrent([]));
    else setCurrent([]);
    api.notifications().then(setNotes).catch(() => setNotes([]));
    if (canAudit) api.auditEvents(0, 6).then((p) => setAudit(p.items)).catch(() => setAudit([]));
  }, [app.revision, canRs, canAudit]); // eslint-disable-line react-hooks/exhaustive-deps

  const count = (states: RestationingState[]) => requests?.filter((r) => states.includes(r.state)).length;
  const temporary = current?.filter((c) => c.kind === 'TEMPORARY') ?? [];
  const returns = useMemo(
    () => temporary.filter((c) => c.plannedEnd && new Date(c.plannedEnd).getTime() - Date.now() < 30 * DAY).sort((a, b) => (a.plannedEnd ?? '').localeCompare(b.plannedEnd ?? '')),
    [temporary],
  );
  const units = new Set(current?.map((c) => c.orgId) ?? []);
  const recent = (requests ?? []).slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 6);
  const dash = (v: number | undefined | null) => (v == null ? '…' : v.toLocaleString('ar-AE'));

  return (
    <div className="tz-home">
      <header className="tz-home-head">
        <div className="tz-home-title">
          <BrandMark size={44} />
          <div>
            <h1>منصة إدارة التمركز والمواقع والاعتمادات</h1>
            <p>
              {app.me.displayName} · {app.me.primaryRole?.name ?? 'المستخدم'}
              {app.me.primaryOrg ? ' · ' + app.me.primaryOrg.name : ''}
            </p>
          </div>
        </div>
        <div className="tz-home-actions">
          {!restriction('newRequest', app.can, app.summaryOnly) && <a className="button primary" href="#newRequest">＋ طلب جديد</a>}
          {canRs && (
            <a className="button primary" href="#restationing">
              <Icon name="map" /> مساحة إعادة التمركز
            </a>
          )}
        </div>
      </header>

      {cards.length > 0 && (
        <section className="tz-tiles" aria-label="ما ينتظرك" data-testid="home-cards">
          {cards.map((c) => <Tile key={c.key} icon="clock" value={c.value.toLocaleString('ar-AE')} label={c.label} tone={c.value ? 'amber' : ''} href={c.href} />)}
        </section>
      )}
      <section className="tz-tiles" aria-label="مؤشرات حية">
        {STATIONING_V3_ENABLED && <Tile icon="pin" value={dash(current ? units.size : null)} label="الوحدات المتمركزة حالياً" sub={current ? `${current.length} سجل تمركز معتمد` : undefined} tone="teal" href={canRs ? '#restationing' : undefined} />}
        {canRs && <Tile icon="clock" value={dash(count(REVIEW))} label="طلبات قيد الاعتماد" tone="amber" href="#restationing" />}
        {STATIONING_V3_ENABLED && <Tile icon="layers" value={dash(current ? temporary.length : null)} label="تمركز مؤقت نافذ" tone="green" />}
        {STATIONING_V3_ENABLED && <Tile icon="reset" value={dash(current ? returns.length : null)} label="عودات خلال 30 يوماً" tone="cyan" />}
        {canSites && <Tile icon="building" value={dash(app.sites.length)} label="المواقع" href="#stationing" />}
        {canUnits && <Tile icon="units" value={dash(app.orgs.length)} label="الوحدات" href="#org" />}
        {canRs && <Tile icon="shield" value={dash(count(BLOCKED))} label="موقوفة أو معادة أو مرفوضة" tone="red" href="#restationing" />}
      </section>

      <div className="tz-home-grid">
        <section className="tz-card tz-home-map" aria-label="نظرة على الخريطة">
          <div className="tz-card-head">
            <h3>نظرة على المواقع</h3>
            <small className="tz-muted">المواقع ذات التمركز الحالي ملوّنة</small>
          </div>
          <div className="tz-home-mapbox">
            {STATIONING_V3_ENABLED ? (
              <Suspense fallback={<p className="tz-muted tz-pad">جارٍ تحميل الخريطة…</p>}>
                <MapOverview sites={app.sites} current={current ?? []} />
              </Suspense>
            ) : (
              <p className="tz-muted tz-pad">الخريطة غير مفعّلة في هذا الإصدار.</p>
            )}
          </div>
        </section>

        <section className="tz-card tz-home-requests" aria-label="آخر الطلبات">
          <div className="tz-card-head">
            <h3>آخر طلبات إعادة التمركز</h3>
            {canRs && <a className="tz-link" href="#restationing">الكل ←</a>}
          </div>
          {!canRs && <p className="tz-muted">لا تملك عرض طلبات إعادة التمركز.</p>}
          {canRs && requests == null && <p className="tz-muted">جارٍ التحميل…</p>}
          {canRs && requests?.length === 0 && <p className="tz-muted">لا طلبات ضمن نطاقك.</p>}
          <ul className="tz-list">
            {recent.map((r) => (
              <li key={r.id}>
                <a href={'#restationing/' + r.id}>
                  <b>{r.number}</b>
                  <StatePill state={r.state} />
                  <small>
                    {r.requestingUnit.name} · {r.kind === 'TEMPORARY' ? 'مؤقت' : r.kind === 'EXTENSION' ? 'تمديد' : 'دائم'}
                    {r.currentStage ? ' · ' + r.currentStage : ''}
                  </small>
                </a>
              </li>
            ))}
          </ul>
        </section>

        <section className="tz-card tz-home-returns" aria-label="العودات القادمة">
          <div className="tz-card-head">
            <h3>العودات القادمة</h3>
            <small className="tz-muted">نهاية التمركز المؤقت المسجّلة</small>
          </div>
          {returns.length === 0 && <p className="tz-muted">لا عودات خلال 30 يوماً ضمن ما تراه.</p>}
          <ul className="tz-list">
            {returns.slice(0, 6).map((c) => (
              <li key={c.id}>
                <span>
                  <b>{c.orgName}</b>
                  <small>
                    {c.siteName} · حتى {fullDate(c.plannedEnd ?? '')}
                  </small>
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="tz-card tz-home-notes" aria-label="الإشعارات وسجل التدقيق">
          <div className="tz-card-head">
            <h3>{canAudit ? 'آخر أحداث التدقيق والإشعارات' : 'آخر الإشعارات'}</h3>
            {canAudit && <a className="tz-link" href="#audit">سجل التدقيق ←</a>}
          </div>
          <ul className="tz-list">
            {(audit ?? []).map((e) => (
              <li key={e.id}>
                <span>
                  <b>{e.actionLabel} · {e.entityLabel}</b>
                  <small>
                    {e.actor?.name ?? '—'} · {fullTime(e.at)}
                  </small>
                </span>
              </li>
            ))}
            {(notes ?? []).slice(0, 5).map((n) => (
              <li key={n.id}>
                <span>
                  <b>{n.title}</b>
                  <small>
                    {n.body.startsWith('#restationing/') ? <a href={n.body.split(' ')[0]}>فتح الطلب</a> : n.body} · {fullTime(n.createdAt)}
                  </small>
                </span>
              </li>
            ))}
          </ul>
          {notes?.length === 0 && !audit?.length && <p className="tz-muted">لا جديد.</p>}
        </section>
      </div>
    </div>
  );
}
