import { describe, expect, it } from 'vitest';
import type { DesktopFeed } from '../api/client';
import { nextStep, shouldAsk } from './desktopNotifications';

const item = (seq: number) => ({ seq, kind: 'TASK_ASSIGNED', title: 'تمركز — إشعار جديد', body: 'b', url: '/', requireInteraction: true, createdAt: '2026-11-11T00:00:00Z' });
const feed = (latestSeq: number, items = [] as ReturnType<typeof item>[], personId = 'p1'): DesktopFeed => ({ personId, latestSeq, items });

// TNQL's rules (ADR-050): no replay on the first poll, no toast while the page is in front, another person's answer stops
describe('desktop feed step', () => {
  it('the first poll only reads the current number', () => expect(nextStep(feed(41, [item(41)]), 'p1', null, false)).toEqual({ cursor: 41, show: [] }));
  it('new items are drawn and the cursor moves', () => expect(nextStep(feed(43, [item(42), item(43)]), 'p1', 41, false)).toEqual({ cursor: 43, show: [item(42), item(43)] }));
  it('in front: nothing drawn, the cursor still moves', () => expect(nextStep(feed(43, [item(42), item(43)]), 'p1', 41, true)).toEqual({ cursor: 43, show: [] }));
  it('never moves back', () => expect(nextStep(feed(10), 'p1', 41, false)?.cursor).toBe(41));
  it('another person: stop', () => expect(nextStep(feed(43, [], 'p2'), 'p1', 41, false)).toBeNull());
});

describe('when to ask for permission', () => {
  const now = Date.parse('2026-11-11T08:00:00Z');
  it('never asked', () => expect(shouldAsk('default', null, now)).toBe(true));
  it('asked yesterday, unanswered', () => expect(shouldAsk('default', String(now - 24 * 3600 * 1000), now)).toBe(false));
  it('asked 8 days ago, unanswered', () => expect(shouldAsk('default', String(now - 8 * 24 * 3600 * 1000), now)).toBe(true));
  it('granted or refused: never again', () => {
    expect(shouldAsk('granted', null, now)).toBe(false);
    expect(shouldAsk('denied', null, now)).toBe(false);
  });
});
