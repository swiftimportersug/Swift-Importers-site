// Swift Importers — Service Worker for background order notifications
// Version 1.0 — Place this file in the ROOT of your Netlify site

const CACHE_NAME = 'swift-admin-v1';

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

// Handle push notifications sent from Firebase Cloud Messaging (future)
self.addEventListener('push', event => {
  if (!event.data) return;
  try {
    const data = event.data.json();
    const title = data.title || '🛒 New Swift Importers Order!';
    const options = {
      body: data.body || 'A new order has been placed.',
      icon: data.icon || '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.tag || 'swift-order',
      requireInteraction: true,
      vibrate: [300, 100, 300, 100, 300],
      actions: [
        { action: 'view', title: '📦 View Order' },
        { action: 'dismiss', title: '✕ Dismiss' }
      ],
      data: { url: data.url || '/swift-admin.html' }
    };
    event.waitUntil(self.registration.showNotification(title, options));
  } catch(e) {
    self.registration.showNotification('🛒 New Order!', {
      body: 'A new order has been placed on Swift Importers.',
      requireInteraction: true
    });
  }
});

// Handle notification click
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/swift-admin.html';

  if (event.action === 'dismiss') return;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      // Focus existing tab if open
      for (const client of clients) {
        if (client.url.includes('swift-admin') && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open new tab
      if (self.clients.openWindow) {
        return self.clients.openWindow(url);
      }
    })
  );
});

// Background sync — check for new orders periodically
self.addEventListener('sync', event => {
  if (event.tag === 'check-orders') {
    event.waitUntil(checkForOrdersInBackground());
  }
});

async function checkForOrdersInBackground() {
  // This runs in background — lightweight check
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put('/sw-heartbeat', new Response(Date.now().toString()));
  } catch(e) {}
}
