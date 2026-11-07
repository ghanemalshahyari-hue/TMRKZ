import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type StationingRouteRow } from '../api/client';
import { StationingRoutePanel } from '../components/studio/StationingRoutePanel';
import { PURPOSE_TITLE, type Purpose } from '../lib/requestPurpose';
import { STATIONING_V3_ENABLED } from '../lib/stationingV3';
import type { FlowEdge, FlowGraph, FlowNode, FlowNodeType, FormField, HierarchyLevel, Responsibility, RoleDef, SimulationResult, StudioItem, WfExec, WorkflowVersion } from '../api/types';
import { NumberField } from '../components/NumberField';
import { formSubjects } from '../components/rules/FieldRulesDialog';
import { DRAG_TYPE, FlowCanvas } from '../components/studio/FlowCanvas';
import { AccessOfferDialog } from '../components/access/AccessOfferDialog';
import { NodeInspector } from '../components/studio/NodeInspector';
import { OrgPicker } from '../components/studio/PlacePicker';
import { ResponsibilitiesDialog } from '../components/studio/ResponsibilitiesDialog';
import { Dialog, DialogHead } from '../components/ui';
import { useApp } from '../lib/app';
import { UNIT_SUBJECTS } from '../lib/rules';
import { fullTime } from '../lib/dates';
import { NODE_HINTS, NODE_TITLES, WHEN_LABEL, autoLayout, drawingHints, edgeKey, graphOf, newNode, problemNode, removeNode } from '../lib/flowGraph';
import './workflowStudio.css';

const EXCLUDED_ROLES = new Set(['SYSTEM_ADMIN', 'LIMITED_VIEWER', 'AUDITOR']);
const PALETTE: FlowNodeType[] = ['approval', 'decision', 'notify', 'parallel', 'join', 'end_approved', 'end_rejected'];
const HISTORY = 60;
const clone = <T,>(o: T): T => JSON.parse(JSON.stringify(o)) as T;

/**
 * «استوديو التدفقات»: the path of a request as a logical flow chart you draw (owner, 6 Nov 2026; ADR-041). Steps are dragged
 * in and joined by lines; a question has yes and no, an approval has approved and rejected. What a step is, and who it goes
 * to, is edited beside the chart. Trying it on a real unit shows the route, who it reaches and which units have nobody.
 * Publishing makes a new version: requests already running stay on theirs.
 */
export function WorkflowStudio() {
  const app = useApp();
  const [items, setItems] = useState<StudioItem[]>([]);
  const [typeCode, setTypeCode] = useState<string | null>(null);
  const [published, setPublished] = useState<WorkflowVersion | null>(null);
  const [name, setName] = useState('');
  const [graph, setGraph] = useState<FlowGraph>({ nodes: [], edges: [] });
  const [execution, setExecution] = useState<WfExec[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [roles, setRoles] = useState<RoleDef[]>([]);
  const [levels, setLevels] = useState<HierarchyLevel[]>([]);
  const [responsibilities, setResponsibilities] = useState<Responsibility[]>([]);
  const [formFields, setFormFields] = useState<FormField[]>([]);
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState<SimulationResult | null>(null);
  const [checkedVersion, setCheckedVersion] = useState<string | null>(null);
  const [panel, setPanel] = useState<'step' | 'try'>('step');
  const [tryOrg, setTryOrg] = useState<{ id?: string; name?: string }>({});
  const [tryFacts, setTryFacts] = useState({ durationDays: 3, resourceCount: 1, participantCount: 0 });
  const [tryRejected, setTryRejected] = useState<string[]>([]);
  const [respOpen, setRespOpen] = useState(false);
  const [execOpen, setExecOpen] = useState(false);
  const [focus, setFocus] = useState<{ id: string; key: number } | null>(null);
  const past = useRef<FlowGraph[]>([]);
  const future = useRef<FlowGraph[]>([]);
  const lastCommit = useRef(0);
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const [, setTick] = useState(0);

  // the stationing requests are in the same list, each with its own path (ADR-046); their path is not drawn by hand
  const routePurpose = typeCode?.startsWith('route:') ? (typeCode.slice(6) as Purpose) : null;
  const [routes, setRoutes] = useState<StationingRouteRow[]>([]);
  const [policyInForce, setPolicyInForce] = useState(true);
  const loadRoutes = useCallback(() => {
    if (!STATIONING_V3_ENABLED) return;
    api.stationingRoutes().then((r) => (setRoutes(r.routes), setPolicyInForce(r.policyInForce))).catch(() => setRoutes([]));
  }, []);
  useEffect(() => loadRoutes(), [loadRoutes]);
  const item = routePurpose ? undefined : items.find((i) => i.requestType.code === typeCode) ?? items[0];
  const subjects = useMemo(() => [...formSubjects(formFields, app.requestTypes), ...UNIT_SUBJECTS], [formFields, app.requestTypes]);
  const reviewerRoles = useMemo(() => roles.filter((r) => !EXCLUDED_ROLES.has(r.code)), [roles]);
  const roleName = useCallback((code: string) => roles.find((r) => r.code === code)?.name ?? code, [roles]);
  const responsibilityName = useCallback((code: string) => responsibilities.find((r) => r.code === code)?.name, [responsibilities]);
  const hints = useMemo(() => drawingHints(graph), [graph]);
  const problemNodes = useMemo(() => new Set((check?.errors ?? []).map((e) => problemNode(e.path) ?? '')), [check]);
  const route = useMemo(() => {
    if (!check?.route?.length) return null;
    return { visited: new Set(check.route.map((r) => r.node)), taken: new Map(check.route.filter((r) => r.taken).map((r) => [r.node, r.taken as string])) };
  }, [check]);
  const node = graph.nodes.find((n) => n.id === selected) ?? null;
  const edge = graph.edges.find((e) => edgeKey(e) === selectedEdge) ?? null;
  const checkedOk = !!check?.valid && !dirty && !!checkedVersion;

  const [itemsLoaded, setItemsLoaded] = useState(false);
  const [newType, setNewType] = useState<{ name: string; topic: '' | 'ACCESS' | 'FACILITY'; kind: string } | null>(null);
  const accessTypeExists = items.some((i) => i.requestType.kind === 'ACCESS');
  const [offerOpen, setOfferOpen] = useState(false);
  const reloadItems = () => api.workflows().then((w) => (setItems(w), setItemsLoaded(true)));
  const addType = async () => {
    if (!newType) return;
    try {
      const made = await api.createRequestType({ name: newType.name, kind: newType.topic === 'ACCESS' ? 'ACCESS' : newType.kind });
      setNewType(null);
      await reloadItems();
      setTypeCode(made.code);
      app.bump();
      app.toast('أُضيف نوع الطلب «' + made.name + '»');
    } catch (e) {
      app.toast((e as Error).message);
    }
  };
  const removeType = async () => {
    if (!item || !window.confirm('حذف نوع الطلب «' + item.requestType.name + '»؟ لن يظهر في القوائم بعد الآن.')) return;
    try {
      await api.removeRequestType(item.requestType.code);
      setTypeCode(null);
      setLoaded(false);
      await reloadItems();
      app.bump();
      app.toast('حُذف نوع الطلب');
    } catch (e) {
      app.toast((e as Error).message);
    }
  };

  useEffect(() => {
    reloadItems().catch((e: Error) => app.toast(e.message));
    api.roles().then(setRoles).catch(() => setRoles([]));
    api.hierarchyLevels().then(setLevels).catch(() => setLevels([]));
    api.responsibilities().then(setResponsibilities).catch(() => setResponsibilities([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.revision]);

  useEffect(() => {
    const code = item?.requestType.code;
    if (!code) return setFormFields([]);
    api
      .forms()
      .then(async (fs) => {
        const it = fs.find((x) => x.requestType.code === code);
        const v = it?.published ? await api.formVersion(it.published.id) : null;
        setFormFields(v?.schema.fields ?? []);
      })
      .catch(() => setFormFields([]));
  }, [item?.requestType.code]);

  const load = async (it: StudioItem | undefined, preferDraft = true) => {
    if (!it) return;
    setCheck(null);
    setCheckedVersion(null);
    setSelected(null);
    setSelectedEdge(null);
    try {
      const pub = it.published ? await api.workflowVersion(it.published.id) : null;
      setPublished(pub);
      const source = preferDraft && it.draft ? await api.workflowVersion(it.draft.id) : pub;
      const def = source ? clone(source.definition) : { name: 'مراجعة إدارية', stages: [], execution: [], graph: null };
      setName(it.requestType.name); // the path carries the name of its request type; nobody has to name it
      setExecution(def.execution ?? []);
      setGraph(def.graph?.nodes?.length || def.stages?.length ? graphOf(def) : autoLayout({ nodes: [{ ...newNode('start', 0, 0), id: 'start' }], edges: [] }));
      past.current = [];
      future.current = [];
      setDirty(false);
      setLoaded(true);
    } catch (e) {
      app.toast((e as Error).message);
    }
  };
  useEffect(() => {
    if (items.length) void load(item);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, typeCode]);

  /** Before a change that undo takes back whole: each move, line or new step is its own; only typing runs together. */
  const commit = useCallback((typing?: unknown) => {
    const now = Date.now();
    if (typing !== true || now - lastCommit.current > 700) {
      past.current = [...past.current.slice(-HISTORY), clone(graphRef.current)];
      future.current = [];
      setTick((t) => t + 1);
    }
    lastCommit.current = typing === true ? now : 0;
  }, []);
  const change = useCallback((g: FlowGraph) => {
    setGraph(g);
    setDirty(true);
  }, []);
  const undo = () => {
    const prev = past.current.at(-1);
    if (!prev) return;
    past.current = past.current.slice(0, -1);
    future.current = [clone(graph), ...future.current];
    lastCommit.current = 0;
    setGraph(prev);
    setDirty(true);
  };
  const redo = () => {
    const next = future.current[0];
    if (!next) return;
    future.current = future.current.slice(1);
    past.current = [...past.current, clone(graph)];
    setGraph(next);
    setDirty(true);
  };
  const patchNode = (id: string, patch: Partial<FlowNode>) => {
    commit(true);
    change({ ...graph, nodes: graph.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) });
  };
  const add = (type: FlowNodeType) => {
    commit();
    const bottom = graph.nodes.length ? Math.max(...graph.nodes.map((n) => n.y)) : 0;
    const n = newNode(type, 0, bottom + 150);
    change({ ...graph, nodes: [...graph.nodes, n] });
    setSelected(n.id);
    setSelectedEdge(null);
    setPanel('step');
    setFocus({ id: n.id, key: Date.now() });
  };
  const save = async () => {
    if (!item) throw new Error('لا يوجد نوع طلب');
    const v = await api.saveWorkflowDraft(item.id, { name, stages: [], execution, graph });
    setDirty(false);
    return v;
  };
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (e) {
      app.toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  /** Saves the draft, then the server checks it and walks it for the unit and values on the panel. */
  const tryIt = (rejected = tryRejected) =>
    run(async () => {
      const v = await save();
      const r = await api.simulateWorkflow(v.id, { ...tryFacts, durationHours: tryFacts.durationDays * 24, orgId: tryOrg.id, rejected });
      setCheck(r);
      setCheckedVersion(v.id);
      setPanel('try');
      if (!r.valid) app.toast('يوجد ' + r.errors.length + ' ملاحظة قبل النشر');
    });
  const publish = () =>
    run(async () => {
      if (!checkedVersion) return;
      const p = await api.publishWorkflow(checkedVersion);
      app.toast('نُشر الإصدار ' + p.version + ' للطلبات الجديدة؛ الطلبات القائمة تبقى على إصدارها');
      setCheck(null);
      setCheckedVersion(null);
      app.bump();
    });
  const reviewable = graph.nodes.filter((n) => n.type === 'approval');
  const toggleReject = (id: string) => {
    const next = tryRejected.includes(id) ? tryRejected.filter((x) => x !== id) : [...tryRejected, id];
    setTryRejected(next);
    void tryIt(next);
  };

  return (
    <div className="fs-page" data-testid="flow-studio">
      <header className="fs-bar">
        <div className="fs-bar-title">
          <h1>مسار الموافقات</h1>
          <select aria-label="نوع الطلب" value={routePurpose ? 'route:' + routePurpose : item?.requestType.code ?? ''} onChange={(e) => setTypeCode(e.target.value)}>
            {items.map((i) => <option key={i.requestType.code} value={i.requestType.code}>{i.requestType.name}</option>)}
            {STATIONING_V3_ENABLED && (['SITE_REGISTRATION', 'INITIAL_STATIONING', 'DEPLOYMENT_AREAS', 'RESTATIONING'] as Purpose[]).map((p) => <option key={p} value={'route:' + p}>{PURPOSE_TITLE[p]}</option>)}
          </select>
          <button className="button compact" data-testid="type-add" onClick={() => setNewType({ name: '', topic: '', kind: '' })}>＋ نوع طلب</button>
          {item && <button className="button compact" data-testid="type-remove" onClick={removeType}>حذف هذا النوع</button>}
          {item?.requestType.kind === 'ACCESS' && <button className="button compact" data-testid="access-offer" onClick={() => setOfferOpen(true)}>الصلاحيات المعروضة للطلب</button>}
          {!routePurpose && <span className="fs-state">
            {published ? `المعمول به: النسخة ${published.version} · ${fullTime(published.publishedAt ?? published.createdAt)}` : 'لا يوجد مسار معمول به بعد'}
            {item?.draft && !dirty ? ' · توجد نسخة محفوظة لم تُفعّل' : ''}
            {dirty ? ' · تعديلات غير محفوظة' : ''}
            {published && published.activeRequests > 0 ? ` · ${published.activeRequests} طلب قائم` : ''}
          </span>}
        </div>
        {!routePurpose && <div className="fs-tools">
          <button className="button compact" disabled={!past.current.length} onClick={undo} title="تراجع">↶ تراجع</button>
          <button className="button compact" disabled={!future.current.length} onClick={redo} title="إعادة">↷ إعادة</button>
          <button className="button compact" onClick={() => (commit(), change(autoLayout(graph)))}>ترتيب البطاقات</button>
          <button className="button compact" onClick={() => setRespOpen(true)}>الجهات المسؤولة</button>
          <button className="button compact" onClick={() => setExecOpen(true)}>مهام ما بعد الاعتماد</button>
          <span className="fs-sep" />
          <button className="button compact" disabled={busy || !dirty} onClick={() => run(async () => { await save(); app.toast('حُفظ'); })}>حفظ</button>
          <button className="button compact" data-testid="try" disabled={busy} onClick={() => tryIt()}>تجربة وفحص</button>
          <button className="button primary compact" data-testid="publish" disabled={busy || !checkedOk} title={checkedOk ? undefined : 'جرّب المسار أولاً، بلا ملاحظات وبلا تعديل بعده'} onClick={publish}>تفعيل المسار</button>
        </div>}
      </header>
      {offerOpen && <AccessOfferDialog onClose={() => setOfferOpen(false)} />}
      {newType && (
        <Dialog open onClose={() => setNewType(null)} className="small-dialog">
          <DialogHead eyebrow="" title="نوع طلب جديد" small="ثم نرسم له مسار الموافقات" onClose={() => setNewType(null)} />
          <div className="dialog-content">
            <label className="field">
              <span>اسم نوع الطلب</span>
              <input aria-label="اسم نوع الطلب" autoFocus value={newType.name} onChange={(e) => setNewType({ ...newType, name: e.target.value })} />
            </label>
            <div className="type-topic" role="group" aria-label="موضوع الطلب">
              <span>ما موضوع هذا الطلب؟</span>
              <button type="button" data-testid="topic-access" aria-pressed={newType.topic === 'ACCESS'} disabled={accessTypeExists} className={newType.topic === 'ACCESS' ? 'on' : ''} onClick={() => setNewType({ ...newType, topic: 'ACCESS', kind: '' })}>
                <b>صلاحيات</b>
                <small>{accessTypeExists ? 'مضاف بالفعل، ويكفي نوع واحد للصلاحيات' : 'شخص يطلب صلاحيات في البرنامج'}</small>
              </button>
              <button type="button" data-testid="topic-facility" aria-pressed={newType.topic === 'FACILITY'} className={newType.topic === 'FACILITY' ? 'on' : ''} onClick={() => setNewType({ ...newType, topic: 'FACILITY' })}>
                <b>مرفق أو حجز</b>
                <small>طلب يخص مرفقاً أو حجزاً قائماً</small>
              </button>
            </div>
            {newType.topic === 'FACILITY' && (
              <div className="type-after" role="radiogroup" aria-label="ماذا يحدث بعد الموافقة النهائية">
                <span>ماذا يحدث بعد الموافقة النهائية؟</span>
                {[
                  ['NEW_RESERVATION', 'يُحجز المرفق'],
                  ['EXTENSION', 'يُمدَّد الحجز'],
                  ['MODIFICATION', 'تتغير فترة الحجز'],
                  ['CANCELLATION', 'يُلغى الحجز'],
                  ['EVACUATION', 'يُخلى المرفق بعد إثبات التسليم'],
                  ['RELOCATION', 'تُنقل الجهة إلى مقر آخر، بدون حجز'],
                ].map(([value, label]) => (
                  <label key={value} className="check-label">
                    <input type="radio" name="type-kind" value={value} checked={newType.kind === value} onChange={() => setNewType({ ...newType, kind: value })} /> {label}
                  </label>
                ))}
              </div>
            )}
          </div>
          <div className="dialog-actions">
            <button className="button primary" disabled={newType.name.trim().length < 2 || !(newType.topic === 'ACCESS' || (newType.topic === 'FACILITY' && newType.kind))} onClick={addType}>إضافة</button>
            <button className="button" onClick={() => setNewType(null)}>إلغاء</button>
          </div>
        </Dialog>
      )}
      {routePurpose && !policyInForce && <div className="rs-banner orange" data-testid="no-policy" style={{ margin: '0 0 10px' }}>لا توجد سياسة تمركز منشورة بعد. يمكنك ضبط هذا المسار وتفعيله الآن، لكن لا يُرسل أي طلب تمركز حتى تُنشر السياسة بقيم المسافات والتضاريس.</div>}
      {routePurpose ? (
        <StationingRoutePanel purpose={routePurpose} others={routes} onChanged={loadRoutes} />
      ) : itemsLoaded && !items.length ? (
        <div className="empty" data-testid="no-types">لا توجد أنواع طلبات. أضف أول نوع من زر «＋ نوع طلب» ثم نرسم له مسار الموافقات.</div>
      ) : (
      <div className="fs-body">
        <aside className="fs-palette" aria-label="الخطوات">
          <h3>الخطوات</h3>
          <small className="muted">اسحبها إلى المخطط أو انقرها</small>
          {PALETTE.map((t) => (
            <button
              key={t}
              className={'fs-tile t-' + t}
              draggable
              data-testid={'tile-' + t}
              onDragStart={(e) => e.dataTransfer.setData(DRAG_TYPE, t)}
              onClick={() => add(t)}
            >
              <b>{NODE_TITLES[t]}</b>
              <small>{NODE_HINTS[t]}</small>
            </button>
          ))}
          <div className="fs-help">
            <h4>طريقة الربط</h4>
            <p>اسحب من النقطة أسفل الخطوة إلى النقطة أعلى الخطوة التالية. لحذف خطوة أو خط: حدده ثم اضغط Delete.</p>
          </div>
        </aside>
        {loaded && (
          <FlowCanvas
            noDeadline={item?.requestType.kind === 'ACCESS'}
            graph={graph}
            selected={selected}
            selectedEdge={selectedEdge}
            hints={hints}
            problems={problemNodes}
            route={panel === 'try' ? route : null}
            onGraph={change}
            onCommit={commit}
            onSelect={(id) => {
              setSelected(id);
              if (id) setPanel('step');
            }}
            onSelectEdge={setSelectedEdge}
            focus={focus}
            roleName={roleName}
            responsibilityName={responsibilityName}
          />
        )}
        <aside className="fs-side">
          <div className="fs-side-tabs" role="tablist">
            <button role="tab" aria-selected={panel === 'step'} onClick={() => setPanel('step')}>الخطوة</button>
            <button role="tab" aria-selected={panel === 'try'} onClick={() => setPanel('try')}>التجربة والفحص{check && !check.valid ? ` (${check.errors.length})` : ''}</button>
          </div>
          {panel === 'step' ? (
            node ? (
              <NodeInspector
                node={node}
                roles={reviewerRoles}
                levels={levels}
                responsibilities={responsibilities}
                subjects={subjects}
                noSignature={item?.requestType.kind === 'ACCESS'}
                onChange={(p) => patchNode(node.id, p)}
                onDelete={() => {
                  commit();
                  change(removeNode(graph, node.id));
                  setSelected(null);
                }}
                onManage={() => setRespOpen(true)}
              />
            ) : edge ? (
              <EdgeInspector
                edge={edge}
                from={graph.nodes.find((n) => n.id === edge.from)}
                to={graph.nodes.find((n) => n.id === edge.to)}
                onDelete={() => {
                  commit();
                  change({ ...graph, edges: graph.edges.filter((e) => e !== edge) });
                  setSelectedEdge(null);
                }}
              />
            ) : (
              <div className="fs-inspector">
                <p className="muted">حدد خطوة أو خطاً في المخطط لتعديله، أو اسحب خطوة جديدة من اليمين.</p>
                <p className="muted">{graph.nodes.length} خطوة · {graph.edges.length} خط</p>
              </div>
            )
          ) : (
            <div className="fs-try" data-testid="try-panel">
              <h4>جرّب المسار لوحدة</h4>
              <OrgPicker label="الوحدة مقدمة الطلب" value={tryOrg.id} name={tryOrg.name} onChange={(id, n) => setTryOrg({ id, name: n })} />
              <div className="fs-try-facts">
                <label>مدة الطلب (يوم)<NumberField value={tryFacts.durationDays} onChange={(v) => setTryFacts((f) => ({ ...f, durationDays: v ?? 0 }))} /></label>
                <label>عدد الموارد<NumberField value={tryFacts.resourceCount} onChange={(v) => setTryFacts((f) => ({ ...f, resourceCount: v ?? 0 }))} /></label>
                <label>جهات مشاركة<NumberField value={tryFacts.participantCount} onChange={(v) => setTryFacts((f) => ({ ...f, participantCount: v ?? 0 }))} /></label>
              </div>
              <button className="button compact" disabled={busy} onClick={() => tryIt()}>تشغيل التجربة</button>
              {check && (
                <>
                  {check.errors.length > 0 && (
                    <section data-testid="problems">
                      <h4 className="fs-bad">يجب إصلاحها قبل النشر ({check.errors.length})</h4>
                      <ul className="fs-problems">
                        {check.errors.map((e, i) => {
                          const id = problemNode(e.path) ?? '';
                          const known = graph.nodes.some((n) => n.id === id);
                          return (
                            <li key={i}>
                              {known ? <button className="link-button" onClick={() => (setSelected(id), setFocus({ id, key: Date.now() }), setPanel('step'))}>{e.message}</button> : e.message}
                            </li>
                          );
                        })}
                      </ul>
                    </section>
                  )}
                  {check.valid && (
                    <section data-testid="route">
                      <div className={'fs-outcome ' + (check.outcome === 'REJECTED' || check.outcome === 'NO_FINAL_APPROVER' ? 'no' : 'ok')}>النتيجة: {check.outcome === 'REJECTED' ? 'ينتهي الطلب مرفوضاً' : check.outcome === 'NO_FINAL_APPROVER' ? 'لا يكتمل الطلب الآن: لا يوجد من يعتمد الخطوة النهائية' : 'ينتهي الطلب معتمداً'}</div>
                      <ol className="fs-route">
                        {check.route.map((r) => (
                          <li key={r.node}>
                            <b>{r.type === 'parallel' || r.type === 'join' || r.type === 'start' ? NODE_TITLES[r.type] : r.name}</b>
                            {r.taken && <span className={'fs-taken ' + r.taken}>{WHEN_LABEL[r.taken]}</span>}
                            {r.chain && r.places.length === 0 && <div className="fs-route-place">لا شيء يصعد إليه من هذه الوحدة، فيكمل الطلب إلى الخطوة التالية.</div>}
                            {r.places.map((p, i) => (
                              <div key={i} className={'fs-route-place' + (p.holders === 0 || p.unresolved ? ' warn' : '')}>
                                {r.chain && <b>{i + 1}. </b>}
                                {roleName(p.role)}: {p.unresolved ? 'لم تُوجد جهة، فتبقى مفتوحة لأي صاحب دور' : p.anyOrg ? 'أي جهة ضمن النطاق' : p.orgs.join('، ')} · {p.holders ? `${p.holders} شخص` : 'لا أحد يملك هذا الدور هناك'}
                              </div>
                            ))}
                            {r.type === 'approval' && (
                              <label className="fs-check">
                                <input type="checkbox" checked={tryRejected.includes(r.node)} onChange={() => toggleReject(r.node)} /> ماذا لو رُفضت هنا؟
                              </label>
                            )}
                          </li>
                        ))}
                      </ol>
                      {tryRejected.filter((id) => reviewable.some((n) => n.id === id) && !check.route.some((r) => r.node === id)).map((id) => (
                        <label key={id} className="fs-check">
                          <input type="checkbox" checked onChange={() => toggleReject(id)} /> إلغاء تجربة الرفض عند «{graph.nodes.find((n) => n.id === id)?.name}»
                        </label>
                      ))}
                      {check.coverage.length > 0 && (
                        <div className="fs-coverage" data-testid="coverage">
                          <h4>وحدات لا تجد جهة</h4>
                          {check.coverage.map((c, i) => (
                            <p key={i}>
                              «{c.name}»: {c.unresolved.toLocaleString('en-US')} من {c.total.toLocaleString('en-US')} وحدة لا تجد جهة، فتبقى الخطوة مفتوحة لأي صاحب دور.
                              {c.sample.length > 0 && <small> مثل: {c.sample.join('، ')}</small>}
                            </p>
                          ))}
                        </div>
                      )}
                      <p className="muted">{check.impact.message}</p>
                    </section>
                  )}
                </>
              )}
            </div>
          )}
        </aside>
      </div>
      )}
      <ResponsibilitiesDialog open={respOpen} onClose={() => setRespOpen(false)} list={responsibilities} onList={setResponsibilities} />
      <Dialog open={execOpen} onClose={() => setExecOpen(false)} className="detail-dialog">
        <DialogHead title="مهام ما بعد الاعتماد" small="التنفيذ والاستلام بعد انتهاء الموافقات" onClose={() => setExecOpen(false)} />
        <div className="dialog-content">
          {execution.length === 0 ? (
            <p className="muted">لا مهام لهذا النوع من الطلبات.</p>
          ) : (
            <table className="data-table">
              <thead><tr><th>المهمة</th><th>الدور</th><th>المهلة (يوم)</th><th>دليل مطلوب</th></tr></thead>
              <tbody>
                {execution.map((x, i) => (
                  <tr key={x.key}>
                    <td><input aria-label="اسم المهمة" value={x.name} onChange={(e) => (setExecution(execution.map((y, j) => (j === i ? { ...y, name: e.target.value } : y))), setDirty(true))} /></td>
                    <td>{roleName(x.role)}</td>
                    <td><NumberField label="مهلة المهمة" value={x.dueDays} onChange={(v) => (setExecution(execution.map((y, j) => (j === i ? { ...y, dueDays: Math.max(1, Math.trunc(v ?? 1)) } : y))), setDirty(true))} /></td>
                    <td><input type="checkbox" aria-label="دليل مطلوب" checked={x.evidenceRequired} onChange={(e) => (setExecution(execution.map((y, j) => (j === i ? { ...y, evidenceRequired: e.target.checked } : y))), setDirty(true))} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Dialog>
    </div>
  );
}

function EdgeInspector({ edge, from, to, onDelete }: { edge: FlowEdge; from?: FlowNode; to?: FlowNode; onDelete: () => void }) {
  return (
    <div className="fs-inspector">
      <div className="fs-inspector-head">
        <span>خط</span>
        <button className="link-button fs-danger" onClick={onDelete}>حذف الخط</button>
      </div>
      <p>من «{from?.name}» إلى «{to?.name}»{edge.when ? ` — ${WHEN_LABEL[edge.when]}` : ''}</p>
      <p className="muted">لتغيير وجهته: احذفه وصل خطاً جديداً، أو اسحب طرفه إلى خطوة أخرى.</p>
    </div>
  );
}

