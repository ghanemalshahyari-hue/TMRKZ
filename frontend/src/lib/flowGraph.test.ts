import { describe, expect, it } from 'vitest';
import type { FlowGraph, WfStage } from '../api/types';
import { autoLayout, chainText, connect, drawingHints, fromStages, graphOf, newNode, outlets, placeText, problemNode, removeNode } from './flowGraph';

const stage = (key: string, fin = false, condition: WfStage['condition'] = null): WfStage => ({ key, name: key, mode: 'ALL', slaDays: 2, assignees: [{ role: 'APPROVER', orgFrom: 'ANY' }], final: fin, requiresSignature: fin, condition });

describe('a definition from before the chart', () => {
  it('opens as the chart it means, in order', () => {
    const g = fromStages([stage('aa'), stage('bb', true)]);
    expect(g.nodes.map((n) => n.type)).toEqual(['start', 'approval', 'approval', 'end_approved']);
    expect(g.edges).toEqual([{ from: 'start', to: 'aa' }, { from: 'aa', to: 'bb', when: 'approved' }, { from: 'bb', to: 'end_ok', when: 'approved' }]);
  });

  it('a stage with a condition becomes a question whose «no» skips it', () => {
    const cond = { fact: 'resourceCount' as const, op: 'gt' as const, value: 1 };
    const g = fromStages([stage('aa', false, cond), stage('bb', true)]);
    expect(g.nodes.find((n) => n.id === 'q_aa')?.condition).toEqual(cond);
    expect(g.edges).toContainEqual({ from: 'q_aa', to: 'aa', when: 'yes' });
    expect(g.edges).toContainEqual({ from: 'q_aa', to: 'bb', when: 'no' });
    expect(g.edges).toContainEqual({ from: 'aa', to: 'bb', when: 'approved' });
  });

  it('a chart already drawn opens as drawn', () => {
    const graph: FlowGraph = { nodes: [newNode('start', 7, 9)], edges: [] };
    expect(graphOf({ name: '', stages: [stage('aa')], execution: [], graph })).toBe(graph);
    expect(graphOf({ name: '', stages: [stage('aa')], execution: [], graph: null }).nodes).toHaveLength(3);
  });
});

describe('drawing', () => {
  const a = newNode('approval', 0, 0);
  const b = newNode('end_approved', 0, 0);
  const c = newNode('end_rejected', 0, 0);
  const par = newNode('parallel', 0, 0);

  it('an outlet holds one line: a new one replaces it, the other outlet stays', () => {
    let g: FlowGraph = { nodes: [a, b, c, par], edges: [] };
    g = connect(g, a.id, b.id, 'approved');
    g = connect(g, a.id, c.id, 'rejected');
    expect(g.edges).toHaveLength(2);
    g = connect(g, a.id, c.id, 'approved');
    expect(g.edges.filter((e) => e.when === 'approved')).toEqual([{ from: a.id, to: c.id, when: 'approved' }]);
    expect(g.edges).toHaveLength(2);
  });

  it('parallel keeps several lines, never the same one twice; a step never links to itself', () => {
    let g: FlowGraph = { nodes: [a, b, par], edges: [] };
    g = connect(g, par.id, a.id, 'out');
    g = connect(g, par.id, b.id, 'out');
    g = connect(g, par.id, b.id, 'out');
    expect(g.edges).toHaveLength(2);
    expect(connect(g, a.id, a.id, 'approved')).toBe(g);
  });

  it('removing a step removes its lines', () => {
    const g = connect({ nodes: [a, b], edges: [] }, a.id, b.id, 'approved');
    expect(removeNode(g, b.id)).toEqual({ nodes: [a], edges: [] });
  });

  it('each step has the outlets its meaning needs', () => {
    expect(outlets('approval')).toEqual(['approved', 'rejected']);
    expect(outlets('decision')).toEqual(['yes', 'no']);
    expect(outlets('end_rejected')).toEqual([]);
    expect(outlets('notify')).toEqual(['out']);
  });

  it('says what is missing while drawing', () => {
    const lonely = newNode('approval', 0, 0);
    expect(drawingHints({ nodes: [lonely], edges: [] }).get(lonely.id)).toBe('حدد من يوافق');
    const asked = newNode('decision', 0, 0);
    expect(drawingHints({ nodes: [asked], edges: [] }).get(asked.id)).toBe('اكتب الشرط');
  });

  it('tidies downwards, each step below what leads to it, and survives a loop drawn by mistake', () => {
    const g = autoLayout(fromStages([stage('aa'), stage('bb', true)]));
    const y = (id: string) => g.nodes.find((n) => n.id === id)!.y;
    expect(y('start')).toBeLessThan(y('aa'));
    expect(y('aa')).toBeLessThan(y('bb'));
    expect(y('bb')).toBeLessThan(y('end_ok'));
    const looped: FlowGraph = { nodes: g.nodes, edges: [...g.edges, { from: 'bb', to: 'aa', when: 'rejected' }] };
    expect(() => autoLayout(looped)).not.toThrow();
  });
});

describe('a climbing approval in words', () => {
  it('says where it stops', () => {
    expect(chainText({ from: 'PARENT', stop: 'MAIN_UNIT', skipEmpty: true })).toBe('تصعد مستوى بعد مستوى حتى الوحدة الرئيسية');
    expect(chainText({ from: 'PARENT', stop: 'TOP', skipEmpty: true })).toBe('تصعد مستوى بعد مستوى حتى أعلى الهيكل');
    expect(chainText({ from: 'PARENT', stop: 'LEVELS', levels: [6, 9], skipEmpty: true })).toBe('تصعد مستوى بعد مستوى حتى المستوى 9 أو 6');
    expect(chainText({ from: 'PARENT', stop: 'COUNT', count: 3, skipEmpty: true })).toBe('تصعد مستوى بعد مستوى: 3 موافقات');
    expect(chainText({ from: 'SELF', stop: 'ORG', orgName: 'إدارة المرافق', skipEmpty: false })).toBe('تصعد مستوى بعد مستوى حتى إدارة المرافق');
  });

  it('asks for what is missing', () => {
    const n = { ...newNode('approval', 0, 0), assignees: [{ role: 'R', orgFrom: 'REQUEST_ORG' as const }], chain: { from: 'PARENT' as const, stop: 'LEVELS' as const, skipEmpty: true } };
    expect(drawingHints({ nodes: [n], edges: [] }).get(n.id)).toBe('حدد مستوى التوقف');
  });
});

describe('a problem from the check', () => {
  it('points at its step, however deep in the step it is', () => {
    expect(problemNode('node:n_ab12')).toBe('n_ab12');
    expect(problemNode('node:n_ab12.all[0].value')).toBe('n_ab12');
    expect(problemNode('graph')).toBeNull();
  });
});

describe('a place in words', () => {
  it('says where a step goes', () => {
    expect(placeText({ role: 'R', orgFrom: 'UP', levelsUp: 1 })).toBe('الجهة الأعلى مباشرة');
    expect(placeText({ role: 'R', orgFrom: 'UP', levelsUp: 3 })).toBe('أعلى بـ 3 مستويات');
    expect(placeText({ role: 'R', orgFrom: 'AT_LEVEL', level: 5 })).toBe('عند المستوى 5');
    expect(placeText({ role: 'R', orgFrom: 'FIXED', orgId: 'x', orgName: 'إدارة المرافق' })).toBe('إدارة المرافق');
    expect(placeText({ role: 'R', orgFrom: 'RESPONSIBLE', responsibility: 'r1' }, () => 'الموافقة على المرافق')).toBe('الموافقة على المرافق');
    expect(placeText({ role: 'R', orgFrom: 'REQUEST_ORG' })).toBe('وحدة مقدم الطلب');
  });
});
