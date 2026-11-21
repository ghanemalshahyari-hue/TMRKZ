import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './client';

/**
 * ADR-094 Gate 2 §M — a stale posture response must never overwrite newer state. The api client exposes the
 * `signal` parameter and the fetch wrapper hands it to the browser; the test here proves (a) the signal reaches
 * {@code fetch}, and (b) an abort before the response arrives rejects with an AbortError the caller can ignore
 * instead of applying stale data to the UI.
 */
describe('api.operationalPosture respects an AbortSignal', () => {
  const realFetch = globalThis.fetch;
  let capturedSignal: AbortSignal | undefined;

  beforeEach(() => {
    capturedSignal = undefined;
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined;
      return new Promise<Response>((_, reject) => {
        // Never resolve: the only way out is the AbortSignal firing.
        const onAbort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
        if (init?.signal?.aborted) onAbort();
        else init?.signal?.addEventListener('abort', onAbort);
      });
    });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('threads the caller\'s AbortSignal all the way to fetch', async () => {
    const controller = new AbortController();
    // Fire the request but don't await it — we only care about the fetch call's `init`.
    const pending = api.operationalPosture(controller.signal).catch(() => undefined);
    // Flush microtasks so fetch is actually called.
    await Promise.resolve();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(capturedSignal).toBe(controller.signal);
    // Cancel: the promise should reject with AbortError, matching the behaviour PosturePage relies on.
    controller.abort();
    await expect(pending).resolves.toBeUndefined();
    expect(controller.signal.aborted).toBe(true);
  });

  it('aborting before the call starts short-circuits the fetch (signal reaches it already aborted)', async () => {
    const controller = new AbortController();
    controller.abort();
    const pending = api.operationalPosture(controller.signal).catch((e: unknown) => e);
    const err = await pending;
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe('AbortError');
  });

  it('a fresh call without a signal still works (back-compat)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ siteHubs: [], unitsTotal: 0, sitesTotal: 0, summary: {}, noStationingSummary: { count: 0 }, dataRevision: 'x' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const body = await api.postureOverview();
    expect(body.siteHubs).toEqual([]);
  });
});
