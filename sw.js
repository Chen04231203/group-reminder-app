const CACHE_NAME = 'reminder-app-v1';
const urlsToCache = [
  '/',
  '/static/index.html',
  '/static/style.css',
  '/static/app.js',
  '/static/manifest.json'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
  self.skipWaiting();
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        if (response) return response;
        return fetch(event.request);
      })
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

// 接收推送通知
self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(
    self.registration.showNotification(data.title || '提醒', {
      body: data.content || '',
      icon: '/static/icon-192.png',
      badge: '/static/icon-192.png',
      tag: data.id ? String(data.id) : 'reminder',
      requireInteraction: true,
      actions: [
        { action: 'copy', title: '复制内容' },
        { action: 'dismiss', title: '忽略' }
      ]
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'copy') {
    event.waitUntil(
      self.clients.matchAll({ type: 'window' }).then(clients => {
        clients.forEach(client => client.postMessage({
          type: 'COPY_REMINDER',
          content: event.notification.body
        }));
      })
    );
  }
  event.waitUntil(
    self.clients.openWindow('/')
  );
});
