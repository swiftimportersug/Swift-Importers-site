// Minimal service worker for Swift Importers — exists to let the page show
// real system notifications reliably on mobile via registration.showNotification(),
// since the plain Notification() constructor is unreliable on mobile browsers.
//
// PHASE 2 UPDATE: this now also handles real background push notifications via
// Firebase Cloud Messaging, using the compat SDK (importScripts — service
// workers use classic scripts, not ES modules, for this). This is what lets a
// notification appear even with the browser fully closed, not just backgrounded.

importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyDqOE4NDmp3xJrTf71MzlClTZ201Uhyk0Q",
  authDomain: "swift-importers.firebaseapp.com",
  projectId: "swift-importers",
  storageBucket: "swift-importers.firebasestorage.app",
  messagingSenderId: "223766904777",
  appId: "1:223766904777:web:aae5780e08d0800aff7218"
});

const messaging = firebase.messaging();

// Fires when a push arrives while the browser is closed or the tab isn't in
// focus — this is the actual "closed browser" notification the whole Phase 2
// build exists for.
messaging.onBackgroundMessage(function(payload) {
  const data = (payload && payload.data) || {};
  const title = data.title || '🚨 New Order — Swift Importers';
  const options = {
    body: data.body || 'A new order has been placed.',
    icon: '/assets/images/swift-importers-logo-highres.svg',
    tag: 'swift-order',
    requireInteraction: true,
    vibrate: [300, 100, 300, 100, 300],
    data: { url: data.url || '/swift-admin.html' }
  };
  self.registration.showNotification(title, options);
});

self.addEventListener('install', function(event) {
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  var targetUrl = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
