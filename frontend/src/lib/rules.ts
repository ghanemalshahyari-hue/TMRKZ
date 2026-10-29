import type { FactName, Rule, RuleOp, RuleValue } from '../api/types';

/** Facts available to rules on the client. The server evaluates the same typed grammar authoritatively. */
export type RuleContext = {
  values: Record<string, unknown>;
  facts: Partial<Record<FactName, string | number>>;
};

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);
}

function compare(actual: unknown, op: string, expected: RuleValue | undefined): boolean {
  switch (op) {
    case 'empty':
      return isEmpty(actual);
    case 'notEmpty':
      return !isEmpty(actual);
    case 'eq':
      return String(actual ?? '') === String(expected ?? '');
    case 'neq':
      return String(actual ?? '') !== String(expected ?? '');
    case 'in':
      return Array.isArray(expected) && expected.map(String).includes(String(actual ?? ''));
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = Number(actual);
      const b = Number(expected);
      if (isEmpty(actual) || !Number.isFinite(a) || !Number.isFinite(b)) return false;
      return op === 'gt' ? a > b : op === 'gte' ? a >= b : op === 'lt' ? a < b : a <= b;
    }
    default:
      return false;
  }
}

/** Evaluates the restricted, declarative rule grammar. Unknown constructs evaluate to false — nothing is ever executed. */
export function evaluateRule(rule: Rule | null | undefined, ctx: RuleContext): boolean {
  if (!rule) return true;
  if ('all' in rule) return Array.isArray(rule.all) && rule.all.every((r) => evaluateRule(r, ctx));
  if ('any' in rule) return Array.isArray(rule.any) && rule.any.some((r) => evaluateRule(r, ctx));
  if ('not' in rule) return !evaluateRule(rule.not, ctx);
  if ('field' in rule) return compare(ctx.values[rule.field], rule.op, rule.value);
  if ('fact' in rule) return compare(ctx.facts[rule.fact], rule.op, rule.value);
  return false;
}

// ---- editing (rule editor) ------------------------------------------------------------------------------------------

/** Something a condition can test: a form field or a fact of the request. */
export type RuleSubject = {
  key: string; // 'field:<id>' | 'fact:<name>'
  label: string;
  kind: 'number' | 'date' | 'text' | 'select' | 'files' | 'requestType';
  options?: { value: string; label: string }[];
};

export const FACT_SUBJECTS: RuleSubject[] = [
  { key: 'fact:durationDays', label: 'مدة الطلب بالأيام', kind: 'number' },
  { key: 'fact:durationHours', label: 'مدة الطلب بالساعات', kind: 'number' },
  { key: 'fact:resourceCount', label: 'عدد الموارد المطلوبة', kind: 'number' },
  { key: 'fact:participantCount', label: 'عدد الجهات المشاركة', kind: 'number' },
  { key: 'fact:requestType', label: 'نوع الطلب', kind: 'requestType' },
];

export const OP_LABELS: Record<RuleOp, string> = {
  eq: 'يساوي',
  neq: 'لا يساوي',
  gt: 'أكبر من',
  gte: 'أكبر من أو يساوي',
  lt: 'أصغر من',
  lte: 'أصغر من أو يساوي',
  in: 'أحد القيم',
  empty: 'فارغ',
  notEmpty: 'غير فارغ',
};

/** Operators that make sense for a subject; the server accepts the same set for every subject. */
export function opsFor(kind: RuleSubject['kind']): RuleOp[] {
  if (kind === 'number' || kind === 'date' || kind === 'files') return ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'empty', 'notEmpty'];
  return ['eq', 'neq', 'in', 'empty', 'notEmpty'];
}

export type Cond = { type: 'cond'; subject: string; op: RuleOp; value?: RuleValue };
export type Group = { type: 'group'; mode: 'all' | 'any'; negate: boolean; items: Node[] };
export type Node = Cond | Group;

const isGroupRule = (r: Rule): r is { all: Rule[] } | { any: Rule[] } => 'all' in r || 'any' in r;

function toNode(r: Rule): Node {
  if ('not' in r) {
    const inner = toNode(r.not);
    return inner.type === 'group' && !inner.negate ? { ...inner, negate: true } : { type: 'group', mode: 'all', negate: true, items: [inner] };
  }
  if (isGroupRule(r)) {
    const mode = 'all' in r ? 'all' : 'any';
    const items = ('all' in r ? r.all : r.any).map(toNode);
    return { type: 'group', mode, negate: false, items };
  }
  if ('field' in r) return { type: 'cond', subject: 'field:' + r.field, op: r.op, value: r.value };
  return { type: 'cond', subject: 'fact:' + r.fact, op: r.op, value: r.value };
}

/** Editable tree of a stored rule; a single condition becomes a one-item "all" group (same meaning). */
export function toTree(rule: Rule | null | undefined): Group | null {
  if (!rule) return null;
  const n = toNode(rule);
  return n.type === 'group' ? n : { type: 'group', mode: 'all', negate: false, items: [n] };
}

function fromNode(n: Node): Rule | null {
  if (n.type === 'cond') {
    const [kind, id] = [n.subject.slice(0, n.subject.indexOf(':')), n.subject.slice(n.subject.indexOf(':') + 1)];
    const base = n.op === 'empty' || n.op === 'notEmpty' ? { op: n.op } : { op: n.op, value: n.value };
    return (kind === 'field' ? { field: id, ...base } : { fact: id as FactName, ...base }) as Rule;
  }
  const items = n.items.map(fromNode).filter((x): x is Rule => x !== null);
  if (!items.length) return null;
  const grouped: Rule = items.length === 1 ? items[0] : n.mode === 'all' ? { all: items } : { any: items };
  return n.negate ? { not: grouped } : grouped;
}

/** Stored rule of an edited tree; empty groups disappear and an empty tree means "no condition". */
export function fromTree(g: Group | null): Rule | null {
  return g ? fromNode(g) : null;
}

/** Conditions not yet complete (no subject, or a value missing). */
export function incomplete(g: Group | null): number {
  if (!g) return 0;
  return g.items.reduce(
    (n, i) =>
      n +
      (i.type === 'group'
        ? incomplete(i)
        : !i.subject || (i.op !== 'empty' && i.op !== 'notEmpty' && (i.value === undefined || i.value === '' || (Array.isArray(i.value) && !i.value.length)))
          ? 1
          : 0),
    0,
  );
}

function valueText(v: RuleValue | undefined, s: RuleSubject | undefined): string {
  const one = (x: string | number | boolean) => {
    const o = s?.options?.find((opt) => opt.value === String(x));
    return '«' + (o?.label ?? String(x)) + '»';
  };
  if (Array.isArray(v)) return v.map(one).join(' أو ');
  return v === undefined ? '…' : one(v);
}

/** The rule as a plain Arabic sentence, e.g. «مدة الطلب بالأيام» أكبر من «7» و «نوع الطلب» يساوي «تمديد». */
export function describeRule(rule: Rule | null | undefined, subjects: RuleSubject[]): string {
  if (!rule) return 'دون شرط';
  const byKey = new Map(subjects.map((s) => [s.key, s]));
  const text = (n: Node, nested: boolean): string => {
    if (n.type === 'cond') {
      const s = byKey.get(n.subject);
      const label = '«' + (s?.label ?? n.subject.slice(n.subject.indexOf(':') + 1)) + '»';
      if (n.op === 'empty' || n.op === 'notEmpty') return label + ' ' + OP_LABELS[n.op];
      return label + ' ' + OP_LABELS[n.op] + ' ' + valueText(n.value, s);
    }
    const parts = n.items.map((i) => text(i, true));
    const joined = parts.join(n.mode === 'all' ? ' و ' : ' أو ');
    const body = nested && parts.length > 1 ? '(' + joined + ')' : joined;
    return n.negate ? 'ليس ' + (parts.length > 1 && !nested ? '(' + joined + ')' : body) : body;
  };
  return text(toNode(rule), false);
}
