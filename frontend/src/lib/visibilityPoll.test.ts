import { describe, expect, it, vi } from 'vitest';
import { startVisibilityPoll } from './visibilityPoll';

/**
 * ADR-094 Gate 2 §N — the global 30-second poll must:
 *  - run exactly one load on start,
 *  - tick every intervalMs while visible,
 *  - stop while hidden,
 *  - run one load on wake-up,
 *  - never leave two concurrent timers after repeated visibility changes.
 *
 * A fake document and a fake interval scheduler drive the test deterministically — no real timers, no DOM.
 */
type FakeDoc = Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'> & { setState(s: 'visible' | 'hidden'): void };

function fakeDoc(initial: 'visible' | 'hidden'): FakeDoc {
  const listeners = new Map<string, Array<() => void>>();
  const doc = {
    visibilityState: initial as DocumentVisibilityState,
    addEventListener: (ev: string, fn: EventListenerOrEventListenerObject) => {
      const arr = listeners.get(ev) ?? [];
      arr.push(fn as () => void);
      listeners.set(ev, arr);
    },
    removeEventListener: (ev: string, fn: EventListenerOrEventListenerObject) => {
      const arr = listeners.get(ev) ?? [];
      listeners.set(ev, arr.filter((f) => f !== (fn as () => void)));
    },
    setState(s: 'visible' | 'hidden') {
      doc.visibilityState = s as DocumentVisibilityState;
      (listeners.get('visibilitychange') ?? []).forEach((f) => f());
    },
  };
  return doc as unknown as FakeDoc;
}

function fakeScheduler() {
  let id = 0;
  const active = new Map<number, () => void>();
  return {
    setInterval: (fn: () => void) => {
      id++;
      active.set(id, fn);
      return id;
    },
    clearInterval: (which: number) => {
      active.delete(which);
    },
    activeCount: () => active.size,
    tick: () => active.forEach((fn) => fn()),
  };
}

describe('startVisibilityPoll', () => {
  it('runs load once on start and installs exactly one interval while visible', () => {
    const load = vi.fn();
    const doc = fakeDoc('visible');
    const s = fakeScheduler();
    const stop = startVisibilityPoll({ load, intervalMs: 30000, doc, setInterval: s.setInterval, clearInterval: s.clearInterval });
    expect(load).toHaveBeenCalledTimes(1);
    expect(s.activeCount()).toBe(1);
    s.tick();
    expect(load).toHaveBeenCalledTimes(2);
    stop();
    expect(s.activeCount()).toBe(0);
  });

  it('does NOT install an interval when the tab is hidden at start', () => {
    const load = vi.fn();
    const doc = fakeDoc('hidden');
    const s = fakeScheduler();
    const stop = startVisibilityPoll({ load, intervalMs: 30000, doc, setInterval: s.setInterval, clearInterval: s.clearInterval });
    // Load still runs once on start (one-shot fetch is cheap; the brief only bans background polling).
    expect(load).toHaveBeenCalledTimes(1);
    expect(s.activeCount()).toBe(0);
    stop();
  });

  it('becoming hidden stops the interval; becoming visible again re-installs exactly one and fires one wake-up load', () => {
    const load = vi.fn();
    const doc = fakeDoc('visible');
    const s = fakeScheduler();
    const stop = startVisibilityPoll({ load, intervalMs: 30000, doc, setInterval: s.setInterval, clearInterval: s.clearInterval });
    expect(s.activeCount()).toBe(1);
    expect(load).toHaveBeenCalledTimes(1);

    doc.setState('hidden');
    expect(s.activeCount()).toBe(0);
    expect(load).toHaveBeenCalledTimes(1); // no load on hide — nothing to refresh

    doc.setState('visible');
    expect(s.activeCount()).toBe(1);
    expect(load).toHaveBeenCalledTimes(2); // exactly one wake-up load

    doc.setState('hidden');
    doc.setState('visible');
    doc.setState('hidden');
    doc.setState('visible');
    expect(s.activeCount()).toBe(1); // repeated flips never accumulate timers (§N regression guard)

    stop();
    expect(s.activeCount()).toBe(0);
  });
});
