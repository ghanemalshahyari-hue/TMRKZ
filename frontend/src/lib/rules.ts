import type { FactName, Rule, RuleValue } from '../api/types';

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
