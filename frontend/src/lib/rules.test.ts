import { describe, expect, it } from 'vitest';
import type { Rule } from '../api/types';
import { evaluateRule, type RuleContext } from './rules';

const ctx: RuleContext = {
  values: { headcount: 40, priority: 'أولوية مرتفعة', reference: '' },
  facts: { resourceCount: 2, durationDays: 3, requestType: 'TEMP_OCCUPANCY' },
};

describe('restricted rule grammar', () => {
  it('treats a missing rule as satisfied', () => {
    expect(evaluateRule(null, ctx)).toBe(true);
  });

  it('compares fields and facts with typed operators', () => {
    expect(evaluateRule({ field: 'headcount', op: 'gt', value: 30 }, ctx)).toBe(true);
    expect(evaluateRule({ field: 'headcount', op: 'lte', value: 30 }, ctx)).toBe(false);
    expect(evaluateRule({ fact: 'resourceCount', op: 'gte', value: 2 }, ctx)).toBe(true);
    expect(evaluateRule({ field: 'priority', op: 'in', value: ['أولوية مرتفعة', 'عاجل'] }, ctx)).toBe(true);
    expect(evaluateRule({ field: 'reference', op: 'empty' }, ctx)).toBe(true);
    expect(evaluateRule({ field: 'priority', op: 'notEmpty' }, ctx)).toBe(true);
  });

  it('combines rules with all/any/not', () => {
    const rule: Rule = {
      all: [{ fact: 'durationDays', op: 'gt', value: 2 }, { not: { field: 'reference', op: 'notEmpty' } }, { any: [{ fact: 'requestType', op: 'eq', value: 'X' }, { field: 'headcount', op: 'gt', value: 10 }] }],
    };
    expect(evaluateRule(rule, ctx)).toBe(true);
  });

  it('never executes or accepts unknown constructs', () => {
    const hostile = { expr: '${T(java.lang.Runtime).getRuntime().exec("x")}' } as unknown as Rule;
    expect(evaluateRule(hostile, ctx)).toBe(false);
    expect(evaluateRule({ field: 'headcount', op: 'like' as never, value: 1 }, ctx)).toBe(false);
  });

  it('does not treat empty numeric values as zero', () => {
    expect(evaluateRule({ field: 'reference', op: 'lt', value: 5 }, ctx)).toBe(false);
  });
});
