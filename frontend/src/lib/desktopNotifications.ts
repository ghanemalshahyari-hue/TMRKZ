/**
 * Desktop notifications, as in TNQL (owner, 11 Nov 2026; ADR-050; TNQL's tnql-desktop-notifications.js).
 *
 * - The service worker /sw.js (root scope) draws Windows toasts; this page polls /api/v1/notifications/desktop-feed every 30 s
 *   and when the tab becomes visible, and hands new items to it. No Web Push: the network is isolated.
 * - Permission is asked once on the person's first click or key press, never by a banner; an unanswered prompt is asked again
 *   after 7 days; a refusal is respected (only the browser's own settings or group policy turn it back on).
 * - The cursor (the highest number already handled) is kept per person, so a shared PC never mixes people; the first poll only
 *   reads the current number, so older items are not replayed. While the tab is visible and focused the page itself is in
 *   front: no toast, but the cursor moves on.
 * - Browsers allow notifications only in a secure context: https, or http://localhost on the server itself.
 */
import { api, type DesktopFeed, type DesktopFeedItem as FeedItem } from '../api/client';

const POLL_MS = 30_000;
const ASK_AGAIN_MS = 7 * 24 * 3600 * 1000;
const ASKED_KEY = 'tmrkz.notify.askedAt';
const cursorKey = (person: string) => 'tmrkz.notify.since.' + person;

const store = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private window: the cursor lives for this page only */
    }
  },
};

export function supported(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext && 'Notification' in window && 'serviceWorker' in navigator;
}

async function worker(): Promise<ServiceWorker | null> {
  const reg = await navigator.serviceWorker.ready;
  return reg.active;
}

/** The person's next cursor and the items to draw, from one feed answer (pure, for the tests). */
export function nextStep(feed: DesktopFeed, person: string, since: number | null, inFront: boolean): { cursor: number; show: FeedItem[] } | null {
  if (feed.personId !== person) return null;
  if (since == null) return { cursor: feed.latestSeq, show: [] };
  return { cursor: Math.max(since, feed.latestSeq), show: inFront ? [] : feed.items };
}

/** Whether to ask now: never asked, or an unanswered prompt more than 7 days ago. */
export function shouldAsk(permission: NotificationPermission, askedAt: string | null, now: number): boolean {
  if (permission !== 'default') return false;
  const t = askedAt ? Number(askedAt) : NaN;
  return !Number.isFinite(t) || now - t > ASK_AGAIN_MS;
}

/** Tells the worker that no one is signed in: every toast closes (the sign-in page, sign-out). */
export function clearDesktopUser() {
  if (!supported()) return;
  void navigator.serviceWorker.getRegistration('/').then((r) => r?.active?.postMessage({ type: 'clear-user' }));
}

/** Starts desktop notifications for the signed-in person; returns the stop function. */
export function startDesktopNotifications(person: string): () => void {
  if (!supported()) {
    if (typeof window !== 'undefined' && !window.isSecureContext) console.warn('إشعارات سطح المكتب تتطلب اتصالاً آمناً (https).');
    return () => undefined;
  }
  let stopped = false;
  let timer: number | undefined;
  let polling = false;

  const poll = async () => {
    if (stopped || polling || Notification.permission !== 'granted') return;
    polling = true;
    try {
      const raw = store.get(cursorKey(person));
      const since = raw != null && /^\d+$/.test(raw) ? Number(raw) : null;
      const feed = await api.desktopFeed(since ?? undefined);
      const inFront = document.visibilityState === 'visible' && document.hasFocus();
      const step = nextStep(feed, person, since, inFront);
      if (!step) return stop();
      // the cursor moves before drawing: another tab polling at the same moment replaces, never doubles, a toast
      store.set(cursorKey(person), String(step.cursor));
      if (step.show.length) {
        const w = await worker();
        step.show.forEach((item) => w?.postMessage({ type: 'show', personId: person, item }));
      }
    } catch {
      /* offline or signed out: the next poll tries again */
    } finally {
      polling = false;
    }
  };

  const enabled = async () => {
    const w = await worker();
    w?.postMessage({
      type: 'show',
      personId: person,
      item: { seq: 0, title: 'تمركز', body: 'تم تفعيل إشعارات سطح المكتب. ستصلك التنبيهات هنا.', url: '/', requireInteraction: false, createdAt: new Date().toISOString() },
    });
    void poll();
  };

  // asked on the first gesture only: browsers refuse a prompt that no click or key started
  const ask = () => {
    window.removeEventListener('pointerdown', ask, true);
    window.removeEventListener('keydown', ask, true);
    if (!shouldAsk(Notification.permission, store.get(ASKED_KEY), Date.now())) return;
    store.set(ASKED_KEY, String(Date.now()));
    void Notification.requestPermission().then((p) => {
      if (p === 'granted') void enabled();
    });
  };
  const onVisible = () => document.visibilityState === 'visible' && void poll();
  const onSwMessage = (e: MessageEvent) => {
    if (e.data?.type === 'open' && typeof e.data.url === 'string') location.href = e.data.url;
  };

  let permissionStatus: PermissionStatus | null = null;
  const onPermission = () => Notification.permission === 'granted' && void poll();
  const stop = () => {
    stopped = true;
    window.clearInterval(timer);
    window.removeEventListener('pointerdown', ask, true);
    window.removeEventListener('keydown', ask, true);
    document.removeEventListener('visibilitychange', onVisible);
    navigator.serviceWorker.removeEventListener('message', onSwMessage);
    if (permissionStatus) permissionStatus.onchange = null;
  };

  void navigator.serviceWorker
    .register('/sw.js', { scope: '/' })
    .then(async () => {
      if (stopped) return;
      (await worker())?.postMessage({ type: 'set-user', personId: person });
      if (shouldAsk(Notification.permission, store.get(ASKED_KEY), Date.now())) {
        window.addEventListener('pointerdown', ask, true);
        window.addEventListener('keydown', ask, true);
      }
      // allowed later from the browser's own settings: start at once
      navigator.permissions
        ?.query({ name: 'notifications' as PermissionName })
        .then((s) => {
          permissionStatus = s;
          s.onchange = onPermission;
        })
        .catch(() => undefined);
      void poll();
      timer = window.setInterval(() => void poll(), POLL_MS);
      document.addEventListener('visibilitychange', onVisible);
      navigator.serviceWorker.addEventListener('message', onSwMessage);
    })
    .catch(() => undefined);
  return stop;
}
