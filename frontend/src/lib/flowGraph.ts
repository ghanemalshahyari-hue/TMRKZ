import type { FlowChain, FlowEdge, FlowGraph, FlowNode, FlowNodeType, FlowWhen, OrgFrom, WfPlace, WfStage, WorkflowDefinition } from '../api/types';

/**
 * The studio's flow chart as data (ADR-041). The server validates and compiles it; everything here only helps drawing it.
 * A definition published before the chart existed opens as the chart it means: its stages in order, a stage's condition
 * as a question whose «no» line skips it, its last stage the final approval.
 */
export const newId = (prefix = 'n') => `${prefix}_${Math.random().toString(36).slice(2, 9)}`;

export const NODE_TITLES: Record<FlowNodeType, string> = {
  start: 'بداية الطلب',
  approval: 'موافقة',
  decision: 'سؤال نعم / لا',
  notify: 'إشعار',
  parallel: 'موافقات في نفس الوقت',
  join: 'انتظار انتهاء الجميع',
  end_approved: 'معتمد',
  end_rejected: 'مرفوض',
};

export const NODE_HINTS: Partial<Record<FlowNodeType, string>> = {
  approval: 'جهة توافق أو ترفض',
  decision: 'يتفرع الطلب حسب شرط',
  notify: 'إعلام بدون قرار',
  parallel: 'عدة جهات تعمل معاً',
  join: 'يكمل بعد انتهاء كل الجهات',
  end_approved: 'نهاية بالاعتماد',
  end_rejected: 'نهاية بالرفض',
};

export const WHEN_LABEL: Record<FlowWhen, string> = { approved: 'عند الموافقة', rejected: 'عند الرفض', yes: 'نعم', no: 'لا' };

/** The kinds of place a step can be given, in plain words. */
export const PLACE_KINDS: { value: OrgFrom; label: string; hint: string }[] = [
  { value: 'REQUEST_ORG', label: 'وحدة مقدم الطلب', hint: 'الوحدة التي قدّمت الطلب' },
  { value: 'BY_SCOPE', label: 'حسب الوحدات المعيّنة للمعتمد', hint: 'أقرب معتمد عُيّنت له وحدة مقدم الطلب في مركز الصلاحيات' },
  { value: 'UP', label: 'جهة أعلى منها', hint: 'صعوداً في الهيكل بعدد مستويات' },
  { value: 'AT_LEVEL', label: 'الجهة عند مستوى محدد', hint: 'أول جهة فوقها في هذا المستوى' },
  { value: 'FIXED', label: 'جهة محددة', hint: 'كل الطلبات تمر عليها' },
  { value: 'RESPONSIBLE', label: 'الجهة المسؤولة عن…', hint: 'حسب قواعد المسؤوليات' },
  { value: 'RESOURCE_ORG', label: 'الجهة المسؤولة عن الموقع', hint: 'مسؤول الموقع المطلوب' },
  { value: 'ANY', label: 'أي جهة', hint: 'أي شخص يملك الدور' },
];

/** The sentence a step shows for its place. */
export function placeText(p: WfPlace, responsibilityName?: (code: string) => string | undefined): string {
  switch (p.orgFrom) {
    case 'UP':
      return (p.levelsUp ?? 1) === 1 ? 'الجهة الأعلى مباشرة' : `أعلى بـ ${p.levelsUp} مستويات`;
    case 'AT_LEVEL':
      return p.level == null ? 'عند مستوى لم يُحدد' : `عند المستوى ${p.level}`;
    case 'FIXED':
      return p.orgName || 'جهة لم تُحدد';
    case 'RESPONSIBLE':
      return (p.responsibility && responsibilityName?.(p.responsibility)) || 'مسؤولية لم تُحدد';
    default:
      return PLACE_KINDS.find((k) => k.value === p.orgFrom)?.label ?? '';
  }
}

export const STOP_KINDS: { value: FlowChain['stop']; label: string; hint: string }[] = [
  { value: 'MAIN_UNIT', label: 'حتى الوحدة الرئيسية', hint: 'حتى آخر مستوى تحت الوحدة الرئيسية في فرع مقدم الطلب، مهما كان مستواها. الرئيسية نفسها لا توقّع' },
  { value: 'LEVELS', label: 'حتى مستوى من المستويات', hint: 'يتوقف عند أول مستوى يصله منها. المستويات من الهيكل المستورد' },
  { value: 'TOP', label: 'حتى أعلى الهيكل', hint: 'إلى آخر جهة لا يوجد فوقها شيء' },
  { value: 'COUNT', label: 'عدد موافقات', hint: 'يتوقف بعد هذا العدد من الموافقات' },
  { value: 'ORG', label: 'حتى جهة محددة', hint: 'يتوقف عند هذه الجهة إذا كانت في طريقه' },
];

export const newChain = (): FlowChain => ({ from: 'PARENT', stop: 'MAIN_UNIT', skipEmpty: false });

/** The sentence a climbing approval shows on its card. */
export function chainText(c: FlowChain): string {
  switch (c.stop) {
    case 'MAIN_UNIT':
      return 'تصعد مستوى بعد مستوى حتى الوحدة الرئيسية';
    case 'TOP':
      return 'تصعد مستوى بعد مستوى حتى أعلى الهيكل';
    case 'LEVELS':
      return c.levels?.length ? `تصعد مستوى بعد مستوى حتى المستوى ${[...c.levels].sort((a, b) => b - a).join(' أو ')}` : 'تصعد مستوى بعد مستوى: حدد مستوى التوقف';
    case 'COUNT':
      return `تصعد مستوى بعد مستوى: ${c.count ?? 0} موافقات`;
    default:
      return c.orgName ? `تصعد مستوى بعد مستوى حتى ${c.orgName}` : 'تصعد مستوى بعد مستوى: حدد جهة التوقف';
  }
}

export function newNode(type: FlowNodeType, x: number, y: number): FlowNode {
  const base: FlowNode = { id: newId(), type, name: NODE_TITLES[type], x, y };
  if (type === 'approval') return { ...base, name: 'موافقة', mode: 'ANY', slaDays: 3, assignees: [], final: false, requiresSignature: false };
  if (type === 'decision') return { ...base, name: 'سؤال', condition: null };
  if (type === 'notify') return { ...base, name: 'إشعار', recipients: [{ kind: 'REQUESTER' }], message: '' };
  return base;
}

/** Which lines leave a step, by what they mean. */
export function outlets(type: FlowNodeType): (FlowWhen | 'out')[] {
  if (type === 'approval') return ['approved', 'rejected'];
  if (type === 'decision') return ['yes', 'no'];
  if (type === 'end_approved' || type === 'end_rejected') return [];
  return ['out'];
}

export const hasInlet = (type: FlowNodeType) => type !== 'start';

/** A new line. An outlet that takes one line gives it up to the new one; only parallel keeps several. */
export function connect(g: FlowGraph, from: string, to: string, handle: string | null): FlowGraph {
  const source = g.nodes.find((n) => n.id === from);
  if (!source || from === to) return g;
  const when = handle && handle !== 'out' ? (handle as FlowWhen) : undefined;
  const edges = source.type === 'parallel' ? g.edges.filter((e) => !(e.from === from && e.to === to)) : g.edges.filter((e) => !(e.from === from && e.when === when));
  return { ...g, edges: [...edges, when ? { from, to, when } : { from, to }] };
}

export function removeNode(g: FlowGraph, id: string): FlowGraph {
  return { nodes: g.nodes.filter((n) => n.id !== id), edges: g.edges.filter((e) => e.from !== id && e.to !== id) };
}

export const edgeKey = (e: FlowEdge) => `${e.from}|${e.when ?? 'out'}|${e.to}`;

const GAP_Y = 170;
const GAP_X = 300;

/** Tidy layers from the start downwards: each step below all that lead to it, each layer centred. Works with loops drawn by mistake. */
export function autoLayout(g: FlowGraph): FlowGraph {
  const depth = new Map<string, number>();
  const start = g.nodes.find((n) => n.type === 'start');
  const visit = (id: string, d: number, path: Set<string>) => {
    if (path.has(id) || (depth.get(id) ?? -1) >= d) return;
    depth.set(id, d);
    const next = new Set(path).add(id);
    g.edges.filter((e) => e.from === id).forEach((e) => visit(e.to, d + 1, next));
  };
  if (start) visit(start.id, 0, new Set());
  const maxDepth = Math.max(0, ...depth.values());
  const layers = new Map<number, FlowNode[]>();
  for (const n of g.nodes) {
    const d = depth.get(n.id) ?? maxDepth + 1;
    layers.set(d, [...(layers.get(d) ?? []), n]);
  }
  const placed = new Map<string, { x: number; y: number }>();
  for (const [d, list] of layers) {
    // the line that matters first: approved and yes stay on the main column, rejected and no go aside
    const rank = (n: FlowNode) => (g.edges.some((e) => e.to === n.id && (e.when === 'rejected' || e.when === 'no')) ? 1 : 0);
    const sorted = [...list].sort((a, b) => rank(a) - rank(b));
    sorted.forEach((n, i) => placed.set(n.id, { x: i * GAP_X - ((sorted.length - 1) * GAP_X) / 2 + (rank(sorted[0]) ? GAP_X / 2 : 0), y: d * GAP_Y }));
  }
  return { ...g, nodes: g.nodes.map((n) => ({ ...n, ...placed.get(n.id) })) };
}

/** A definition's chart: its own, or the one its stages mean. */
export function graphOf(def: WorkflowDefinition): FlowGraph {
  if (def.graph?.nodes?.length) return def.graph;
  return fromStages(def.stages ?? []);
}

export function fromStages(stages: WfStage[]): FlowGraph {
  const start: FlowNode = { id: 'start', type: 'start', name: NODE_TITLES.start, x: 0, y: 0 };
  const end: FlowNode = { id: 'end_ok', type: 'end_approved', name: 'معتمد', x: 0, y: 0 };
  const nodes: FlowNode[] = [start];
  const edges: FlowEdge[] = [];
  // the lines waiting for the next step: from a previous step, or from a question's «no»
  let waiting: { from: string; when?: FlowWhen }[] = [{ from: start.id }];
  const link = (to: string) => {
    waiting.forEach((w) => edges.push(w.when ? { from: w.from, to, when: w.when } : { from: w.from, to }));
    waiting = [];
  };
  stages.forEach((s) => {
    if (s.condition) {
      const q: FlowNode = { id: `q_${s.key}`, type: 'decision', name: `هل تنطبق «${s.name}»؟`, x: 0, y: 0, condition: s.condition };
      nodes.push(q);
      link(q.id);
      waiting = [{ from: q.id, when: 'yes' }];
    }
    nodes.push({ id: s.key, type: 'approval', name: s.name, x: 0, y: 0, mode: s.mode, slaDays: s.slaDays, assignees: s.assignees, final: !!s.final, requiresSignature: !!s.requiresSignature });
    link(s.key);
    waiting = [{ from: s.key, when: 'approved' }, ...(s.condition ? [{ from: `q_${s.key}`, when: 'no' as const }] : [])];
  });
  nodes.push(end);
  link(end.id);
  return autoLayout({ nodes, edges });
}

/** The step a check's problem is about: its path starts «node:<id>», sometimes with more after it. */
export const problemNode = (path: string) => /^node:([a-z][a-z0-9_]*)/.exec(path)?.[1] ?? null;

/** What can be read from the chart before asking the server: only what helps while drawing. */
export function drawingHints(g: FlowGraph): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of g.nodes) {
    const from = g.edges.filter((e) => e.from === n.id);
    if (n.type === 'approval' && (!n.assignees?.length || (n.chain && !n.assignees[0].role))) out.set(n.id, 'حدد من يوافق');
    else if (n.chain?.stop === 'LEVELS' && !n.chain.levels?.length) out.set(n.id, 'حدد مستوى التوقف');
    else if (n.type === 'approval' && !from.some((e) => e.when === 'approved')) out.set(n.id, 'صل خط «عند الموافقة»');
    else if (n.type === 'decision' && !n.condition) out.set(n.id, 'اكتب الشرط');
    else if (n.type === 'decision' && from.length < 2) out.set(n.id, 'صل «نعم» و«لا»');
    else if (n.type === 'notify' && !n.recipients?.length) out.set(n.id, 'حدد المستلمين');
    else if (n.type !== 'end_approved' && n.type !== 'end_rejected' && !from.length) out.set(n.id, 'صلها بخطوة تالية');
    else if (n.type !== 'start' && !g.edges.some((e) => e.to === n.id)) out.set(n.id, 'غير موصولة');
  }
  return out;
}
