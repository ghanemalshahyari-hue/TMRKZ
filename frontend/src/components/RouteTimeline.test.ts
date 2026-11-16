import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { StageView } from '../api/types';
import { skippedSummary } from '../lib/routeSkips';
import { Timeline } from './RouteTimeline';

const render = (stages: StageView[]) => renderToStaticMarkup(createElement(Timeline, { stages }));
const REASON = 'لا يوجد معتمد للسلسلة الهرمية';
const skip = (name: string, order: number) => ({ organizationId: 'o' + order, organizationName: name, level: 9 - order, order, reasonCode: 'NO_HIERARCHY_APPROVER' as const, reason: REASON });

/** The owner's health example (ADR-062): every hierarchy unit skipped, then unit operations, then the final approval. */
const allSkipped: StageView[] = [
  { key: 'levels', name: 'اعتماد مستويات الوحدة', mode: 'ALL', slaDays: 3, state: 'COMPLETE', tasks: [], skipped: [skip('إدارة الصحة', 2), skip('مركز صحة 1', 1), skip('إدارة الصحة الرئيسية', 3)] },
  { key: 'ops', name: 'اعتماد عمليات الوحدة', mode: 'ALL', slaDays: 2, state: 'ACTIVE', tasks: [{ id: 't1', roleName: 'معتمد عمليات الوحدة', orgName: 'عمليات الصحة', state: 'OPEN', decidedBy: null, decidedAt: null }] },
  { key: 'fin', name: 'الاعتماد النهائي', mode: 'ALL', slaDays: 1, state: 'PENDING', tasks: [{ id: '', roleName: 'الاعتماد النهائي', orgName: null, state: 'PENDING', decidedBy: null, decidedAt: null }] },
];

/** Mixed: the centre signed by the inherited approver above it, the main administration skipped. */
const mixed: StageView[] = [
  {
    key: 'levels', name: 'اعتماد مستويات الوحدة', mode: 'ALL', slaDays: 3, state: 'COMPLETE',
    tasks: [
      { id: 'a', roleName: 'معتمد السلسلة الهرمية', orgName: 'مركز صحة 1', state: 'APPROVED', decidedBy: 'معتمد إدارة الصحة', decidedAt: '2026-11-16T08:00:00Z' },
      { id: 'b', roleName: 'معتمد السلسلة الهرمية', orgName: 'إدارة الصحة', state: 'APPROVED', decidedBy: 'معتمد إدارة الصحة', decidedAt: '2026-11-16T08:05:00Z' },
    ],
    skipped: [skip('إدارة الصحة الرئيسية', 3)],
  },
];

describe('hierarchy units skipped on the request page (ADR-062)', () => {
  it('shows each skipped unit with «تم التجاوز» and the Arabic reason, in climb order', () => {
    const html = render(allSkipped);
    const names = [...html.matchAll(/class="tl-skip-name">([^<]+)</g)].map((m) => m[1]);
    expect(names).toEqual(['مركز صحة 1', 'إدارة الصحة', 'إدارة الصحة الرئيسية']);
    expect(html.match(/تم التجاوز</g)).toHaveLength(3);
    expect(html).toContain(REASON);
  });

  it('never draws a skipped unit as approved: no check mark, no approved chip, the all-skipped step is «passed»', () => {
    const html = render(allSkipped);
    const skips = html.slice(html.indexOf('data-testid="skipped-units"'), html.indexOf('</ul>', html.indexOf('data-testid="skipped-units"')));
    expect(skips).not.toContain('✓');
    expect(skips).not.toContain('task-chip done');
    expect(html).toMatch(/class="timeline-item passed" data-stage="levels"><i>⤼<\/i>/);
  });

  it('draws the inherited approver as an approval, not as a skip', () => {
    const html = render(mixed);
    expect(html).toContain('task-chip done');
    expect(html).toMatch(/مركز صحة 1 ✓/);
    const skipped = [...html.matchAll(/class="tl-skip-name">([^<]+)</g)].map((m) => m[1]);
    expect(skipped).toEqual(['إدارة الصحة الرئيسية']);
    expect(html).toMatch(/class="timeline-item complete" data-stage="levels"><i>✓<\/i>/);
  });

  it('sums the skipped units, opening to their names', () => {
    expect(skippedSummary(allSkipped)).toBe('تم تجاوز 3 جهات في السلسلة الهرمية لعدم وجود معتمد');
    expect(skippedSummary(mixed)).toBe('تم تجاوز جهة واحدة في السلسلة الهرمية لعدم وجود معتمد');
    expect(skippedSummary(allSkipped.slice(1))).toBeNull();
    const html = render(allSkipped);
    expect(html).toContain('data-testid="skipped-note"');
    expect(html).toContain('مركز صحة 1 — ' + REASON);
  });

  it('keeps the order: the climb, then unit operations, then the final approval', () => {
    const html = render(allSkipped);
    const order = [...html.matchAll(/data-stage="([a-z]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(['levels', 'ops', 'fin']);
  });
});
