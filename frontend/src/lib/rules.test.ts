import { describe, expect, it } from 'vitest';
import type { Rule } from '../api/types';
import { describeRule, evaluateRule, fromTree, incomplete, toTree, type RuleContext } from './rules';

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

describe('rule editor tree and wording', () => {
  const subjects = [
    { key: 'field:priority', label: 'الأولوية', kind: 'select' as const, options: [{ value: 'H', label: 'مرتفعة' }] },
    { key: 'fact:durationDays', label: 'مدة الطلب بالأيام', kind: 'number' as const },
  ];

  it('round-trips stored rules through the editable tree without changing their meaning', () => {
    const rules: Rule[] = [
      { field: 'priority', op: 'eq', value: 'H' },
      { all: [{ fact: 'durationDays', op: 'gt', value: 7 }, { field: 'priority', op: 'notEmpty' }] },
      { any: [{ fact: 'durationDays', op: 'lt', value: 1 }, { not: { field: 'priority', op: 'in', value: ['H', 'L'] } }] },
      { not: { all: [{ fact: 'durationDays', op: 'gt', value: 2 }, { field: 'priority', op: 'empty' }] } },
    ];
    const samples: Record<string, unknown>[] = [{ priority: 'H' }, { priority: '' }, { priority: 'L' }];
    for (const r of rules) {
      const back = fromTree(toTree(r));
      for (const values of samples) {
        for (const durationDays of [0.5, 3, 9]) {
          const c: RuleContext = { values, facts: { durationDays } };
          expect(evaluateRule(back, c)).toBe(evaluateRule(r, c));
        }
      }
    }
  });

  it('drops empty groups and treats an empty tree as no condition', () => {
    expect(fromTree({ type: 'group', mode: 'all', negate: false, items: [] })).toBeNull();
    expect(fromTree(null)).toBeNull();
  });

  it('counts incomplete conditions', () => {
    expect(incomplete({ type: 'group', mode: 'all', negate: false, items: [{ type: 'cond', subject: 'fact:durationDays', op: 'gt' }] })).toBe(1);
    expect(incomplete({ type: 'group', mode: 'all', negate: false, items: [{ type: 'cond', subject: 'field:priority', op: 'empty' }] })).toBe(0);
  });

  it('describes a rule in Arabic with labels and option names', () => {
    const r: Rule = { all: [{ fact: 'durationDays', op: 'gt', value: 7 }, { field: 'priority', op: 'eq', value: 'H' }] };
    expect(describeRule(r, subjects)).toBe('«مدة الطلب بالأيام» أكبر من «7» و «الأولوية» يساوي «مرتفعة»');
    expect(describeRule({ not: { field: 'priority', op: 'empty' } }, subjects)).toBe('ليس «الأولوية» فارغ');
    expect(describeRule(null, subjects)).toBe('دون شرط');
  });
});
