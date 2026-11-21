/**
 * Visibility-aware poller (ADR-094 Gate 2 §N). Runs {@code load()} immediately when started, then every
 * {@code intervalMs} while the document is visible. On {@code visibilitychange}:
 *
 * <ul>
 *   <li>→ visible: runs {@code load()} once immediately and starts (or keeps) the interval.</li>
 *   <li>→ hidden: clears the interval; no background polling.</li>
 * </ul>
 *
 * Returns a {@code stop()} function that clears the interval and removes the listener. The implementation is
 * idempotent — calling start twice does NOT create two concurrent intervals, which is the regression the §N
 * test guards against.
 *
 * <p>Separated from {@code App.tsx} so it can be unit-tested with a fake document; the App itself just wires it
 * into a React effect.
 */
export function startVisibilityPoll(opts: {
  load: () => void;
  intervalMs: number;
  doc?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
  setInterval?: (fn: () => void, ms: number) => number;
  clearInterval?: (id: number) => void;
}): () => void {
  const doc = opts.doc ?? document;
  const si = opts.setInterval ?? ((fn, ms) => window.setInterval(fn, ms));
  const ci = opts.clearInterval ?? ((id) => window.clearInterval(id));
  let timer: number | null = null;
  const start = () => {
    if (timer !== null) return;
    timer = si(opts.load, opts.intervalMs);
  };
  const stop = () => {
    if (timer === null) return;
    ci(timer);
    timer = null;
  };
  const onVisibility = () => {
    if (doc.visibilityState === 'visible') {
      opts.load();
      start();
    } else {
      stop();
    }
  };
  opts.load();
  if (doc.visibilityState === 'visible') start();
  doc.addEventListener('visibilitychange', onVisibility);
  return () => {
    stop();
    doc.removeEventListener('visibilitychange', onVisibility);
  };
}
