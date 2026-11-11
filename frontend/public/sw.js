/* TMRKZ desktop notifications (owner, 11 Nov 2026; ADR-050), as in TNQL's sw.js.
 *
 * The page polls /api/v1/notifications/desktop-feed and hands each new item to this worker, which draws it as a Windows
 * toast. No Web Push: the installation is isolated and the browser's push service is unreachable. Nothing is cached here.
 * Messages from the page:
 *   { type: 'show', personId, item }   draw one toast (title and body are the server's lock-screen-safe text)
 *   { type: 'set-user', personId }     another person signed in on this browser: close the previous person's toasts
 *   { type: 'clear-user' }             signed out: close every toast
 */
'use strict';

const ICON = '/notify-icon-192.png';
let currentPerson = null;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

async function closeAll(exceptPerson) {
  const shown = await self.registration.getNotifications();
  for (const n of shown) {
    if (!exceptPerson || (n.data && n.data.personId !== exceptPerson)) n.close();
  }
}

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'set-user') {
    currentPerson = msg.personId || null;
    event.waitUntil(closeAll(currentPerson));
  } else if (msg.type === 'clear-user') {
    currentPerson = null;
    event.waitUntil(closeAll(null));
  } else if (msg.type === 'show' && msg.item && msg.personId) {
    const it = msg.item;
    event.waitUntil(
      self.registration.showNotification(it.title || 'تمركز — إشعار جديد', {
        body: it.body || 'تمركز — لديك إشعار جديد. افتح المنصة لعرض التفاصيل.',
        icon: ICON,
        badge: ICON,
        lang: 'ar',
        dir: 'rtl',
        // one toast per notification and person: several open tabs replace instead of stacking
        tag: 'tmrkz-' + msg.personId + '-' + it.seq,
        renotify: true,
        silent: false,
        requireInteraction: !!it.requireInteraction,
        timestamp: it.createdAt ? Date.parse(it.createdAt) : Date.now(),
        data: { url: it.url || '/', personId: msg.personId },
      }),
    );
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil(
    (async () => {
      const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of open) {
        if (new URL(c.url).origin === self.location.origin) {
          await c.focus();
          if ('navigate' in c) {
            try {
              await c.navigate(target);
            } catch {
              c.postMessage({ type: 'open', url: target });
            }
          }
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
