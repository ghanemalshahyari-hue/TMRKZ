import { useEffect, useMemo, useState } from 'react';
import { api, type StationingRouteRow, type StationingRouteTry } from '../../api/client';
import type { HierarchyLevel } from '../../api/types';
import { useApp } from '../../lib/app';
import { fullTime } from '../../lib/dates';
import { PURPOSE_TITLE, type Purpose } from '../../lib/requestPurpose';
import { emptyRoute, routeGraph, setApproves, setLabel, setLast, withLevels, type RouteValues } from '../../lib/stationingRoute';
import { FlowCanvas } from './FlowCanvas';
import { OrgPicker } from './PlacePicker';

const nothing = () => undefined;
const NONE = new Map<string, string>();
const NO_PROBLEMS = new Set<string>();

/**
 * One stationing request's path on «مسار الموافقات» (ADR-046): the Oracle levels that approve and the stages after them, drawn as the
 * chart the server will build. Saved, tried on a unit, then activated. It names levels and stages only: who decides is a grant.
 */
export function StationingRoutePanel({ purpose, others, onChanged }: { purpose: Purpose; others: StationingRouteRow[]; onChanged: () => void }) {
  const app = useApp();
  const row = others.find((r) => r.purpose === purpose) ?? null;
  const [levels, setLevels] = useState<HierarchyLevel[] | null>(null);
  const [route, setRoute] = useState<RouteValues | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [org, setOrg] = useState<{ id: string; name: string }>({ id: '', name: '' });
  const [tried, setTried] = useState<StationingRouteTry | null>(null);
  const [reason, setReason] = useState('');
  useEffect(() => {
    api.hierarchyLevels().then(setLevels).catch((e: Error) => (setLevels([]), app.toast(e.message)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!levels) return;
    const saved = row?.draft ?? row?.published;
    setRoute(saved ? withLevels({ routing: saved.routing, stages: saved.stages }, levels) : withLevels(emptyRoute(levels), levels));
    setDirty(false);
    setTried(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [purpose, levels, row?.draft?.version, row?.published?.version]);
  const graph = useMemo(() => (route ? routeGraph(route) : null), [route]);
  const change = (next: RouteValues) => {
    setRoute(next);
    setDirty(true);
    setTried(null);
  };
  const run = async (what: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await what();
      app.toast(done);
      setDirty(false);
      onChanged();
    } catch (e) {
      app.toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const tryIt = async () => {
    if (!route || !org.id) return;
    setBusy(true);
    try {
      setTried(await api.tryStationingRoute(purpose, { ...route, orgId: org.id }));
    } catch (e) {
      app.toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const copyFrom = (p: string) => {
    const r = others.find((x) => x.purpose === p);
    const saved = r?.draft ?? r?.published;
    if (saved && levels) change(withLevels({ routing: saved.routing, stages: saved.stages }, levels));
  };
  if (!route || !graph) return <div className="empty">جارٍ التحميل…</div>;
  const hasLast = route.routing.levels.some((l) => l.finalStage);
  const copyable = others.filter((r) => r.purpose !== purpose && (r.draft || r.published));
  return (
    <div className="fs-body fs-route-body" data-testid="stationing-route" data-purpose={purpose}>
      <aside className="fs-palette fs-route-levels" aria-label="مستويات المسار">
        <h3>من يعتمد في التسلسل</h3>
        <small className="muted">المستويات كما يرسلها Oracle. يصعد الطلب من الوحدة الطالبة إلى آخر مستوى تحدده.</small>
        {levels?.length === 0 && <p className="muted">لا توجد مستويات في بيانات الموارد البشرية.</p>}
        {route.routing.levels.map((l) => (
          <div key={l.level} className="fs-route-level" data-level={l.level}>
            <label className="fs-check"><input type="checkbox" data-approves={l.level} checked={l.approves} onChange={(e) => change(setApproves(route, l.level, e.target.checked))} /> <b>L{l.level}</b> يعتمد</label>
            {l.approves && <input aria-label={'اسم مرحلة L' + l.level} value={l.label} onChange={(e) => change(setLabel(route, l.level, e.target.value))} />}
            <label className="fs-check"><input type="radio" name="last-level" data-last={l.level} checked={l.finalStage} onChange={() => change(setLast(route, l.level))} /> آخر مستوى</label>
            <small className="muted">{levels?.find((x) => x.level === l.level)?.units ?? 0} وحدة</small>
          </div>
        ))}
        <label className="field"><span>يبدأ المسار من</span>
          <select aria-label="بداية المسار" value={route.routing.startAt} onChange={(e) => change({ ...route, routing: { ...route.routing, startAt: e.target.value as 'SELF' | 'PARENT' } })}>
            <option value="SELF">الوحدة الطالبة نفسها</option>
            <option value="PARENT">الجهة الأعلى منها</option>
          </select>
        </label>
        <h3 style={{ marginTop: 12 }}>بعد التسلسل</h3>
        <label className="fs-check"><input type="checkbox" data-stage="unitOperations" checked={route.stages.unitOperations} onChange={(e) => change({ ...route, stages: { ...route.stages, unitOperations: e.target.checked } })} /> اعتماد عمليات الوحدة</label>
        <label className="fs-check"><input type="checkbox" data-stage="finalByPermission" checked={route.stages.finalByPermission} onChange={(e) => change({ ...route, stages: { ...route.stages, finalByPermission: e.target.checked } })} /> الاعتماد النهائي مرحلة مستقلة</label>
        <label className="fs-check"><input type="checkbox" data-stage="fyiBeforeActivation" checked={route.stages.fyiBeforeActivation} onChange={(e) => change({ ...route, stages: { ...route.stages, fyiBeforeActivation: e.target.checked } })} /> تحديد وحدات العلم قبل التفعيل</label>
        <small className="muted">من يقرر كل مرحلة تحدده الصلاحيات، لا هذه الصفحة.</small>
        {copyable.length > 0 && (
          <label className="field" style={{ marginTop: 10 }}><span>نسخ مسار نوع آخر</span>
            <select aria-label="نسخ مسار نوع آخر" value="" onChange={(e) => copyFrom(e.target.value)}>
              <option value="">— اختر —</option>
              {copyable.map((r) => <option key={r.purpose} value={r.purpose}>{PURPOSE_TITLE[r.purpose as Purpose]}</option>)}
            </select>
          </label>
        )}
      </aside>
      <FlowCanvas readOnly noDeadline graph={graph} selected={null} selectedEdge={null} hints={NONE} problems={NO_PROBLEMS} route={null} onGraph={nothing} onCommit={nothing} onSelect={nothing} onSelectEdge={nothing} focus={null} roleName={(c) => c} responsibilityName={() => undefined} />
      <aside className="fs-side" aria-label="الحفظ والتجربة">
        <div className="fs-inspector" data-testid="route-actions">
          <h3>{PURPOSE_TITLE[purpose]}</h3>
          <p className="muted micro" data-testid="route-state">
            {row?.published ? `المعمول به: النسخة ${row.published.version} · ${row.published.publishedAt ? fullTime(row.published.publishedAt) : ''}` : 'لا يوجد مسار معمول به بعد'}
            {row?.draft && !dirty ? ' · توجد نسخة محفوظة لم تُفعّل' : ''}
            {dirty ? ' · تعديلات غير محفوظة' : ''}
          </p>
          <button className="button" data-testid="route-save" disabled={busy || !dirty || !hasLast} title={hasLast ? undefined : 'حدد آخر مستوى أولاً'} onClick={() => run(() => api.saveStationingRoute(purpose, route), 'حُفظ المسار')}>حفظ</button>
          <h4 style={{ marginTop: 14 }}>جرّب المسار لوحدة</h4>
          <OrgPicker label="الوحدة مقدمة الطلب" value={org.id} name={org.name} onChange={(id, name) => (setOrg({ id: id ?? '', name: name ?? '' }), setTried(null))} />
          <button className="button compact" data-testid="route-try" disabled={busy || !org.id || !hasLast} onClick={tryIt}>تشغيل التجربة</button>
          {tried && (
            <div data-testid="route-tried">
              <div className={'fs-outcome ' + (tried.complete && tried.stages.every((s) => s.holders > 0) ? 'ok' : 'no')}>
                النتيجة: {!tried.complete ? 'لا يُقبل إرسال الطلب من هذه الوحدة' : tried.stages.every((s) => s.holders > 0) ? 'يصل الطلب إلى كل المراحل' : 'يتوقف الطلب عند مرحلة لا يحملها أحد'}
              </div>
              {tried.problems.map((p) => <p key={p} className="micro error-text">{p}</p>)}
              <ol className="fs-route">
                {tried.stages.map((s) => (
                  <li key={s.key}><b>{s.label}</b>{s.unit ? ' — ' + s.unit : ''}<div className={'micro ' + (s.holders ? 'muted' : 'error-text')}>{s.holders ? s.holders + ' شخص يحمل هذه المرحلة' : 'لا أحد يحمل هذه المرحلة'}</div></li>
                ))}
              </ol>
              <p className="micro muted">التفعيل: {tried.activators ?? 0} شخص.{tried.fyiHolders != null ? ' وحدات العلم: ' + tried.fyiHolders + ' شخص.' : ''} يُحسب من منح الوحدة وما فوقها، والقرار نفسه يفحص النطاق كاملاً.</p>
            </div>
          )}
          <h4 style={{ marginTop: 14 }}>التفعيل</h4>
          <label className="field"><span>السبب (مطلوب)</span><textarea aria-label="سبب تفعيل المسار" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          <button className="button primary" data-testid="route-publish" disabled={busy || dirty || !row?.draft || !tried?.complete || reason.trim().length < 5} title={!row?.draft ? 'احفظ المسار أولاً' : !tried?.complete ? 'جرّب المسار على وحدة أولاً' : undefined} onClick={() => run(async () => { await api.publishStationingRoute(purpose, reason); setReason(''); }, 'فُعّل المسار')}>تفعيل المسار</button>
        </div>
      </aside>
    </div>
  );
}
