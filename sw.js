// Minimal service worker for Swift Importers — exists solely to let the page show
// real system notifications reliably on mobile via registration.showNotification(),
// since the plain Notification() constructor is unreliable on mobile browsers.
//
// NOTE: this does NOT enable notifications when the browser/tab is fully closed —
// that requires Firebase Cloud Messaging + a server-side trigger (a Cloud Function),
// which this project doesn't have set up. This service worker only helps while the
// tab is open somewhere (even backgrounded, minimized, or on another page/app).

self.addEventListener('install', function(event) {
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('/');
    })
  );
});
