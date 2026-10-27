/* 群通知提醒助手 - Service Worker
   策略：网络优先（保证更新能立刻生效），断网时回退缓存
   支持：Web Push 系统推送（网页关掉也能收到） */

const CACHE_NAME = 'reminder-app-v3';
const PRECACHE = [
  '/',
  '/static/style.css',
  '/static/app.js',
  '/static/manifest.json',
  '/static/icon-192.png',
  '/static/icon-512.png',
];

// ===== 安装：预缓存核心资源 =====
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => Promise.all(
        PRECACHE.map(url => cache.add(url).catch(() => null))
      ))
      .then(() => self.skipWaiting())
  );
});

// ===== 激活：清掉旧版本缓存 =====
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ===== 请求：网络优先，失败回退缓存 =====
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // 接口和 WebSocket 一律走网络，不缓存
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return;
  // 跨域资源不插手
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(req)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then(hit => hit || caches.match('/')))
  );
});

// ===== 收到服务端推送 =====
self.addEventListener('push', event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: '提醒', content: event.data ? event.data.text() : '' };
  }

  const title = data.title || '提醒';
  const options = {
    body: data.content || '你有一个新的提醒',
    icon: '/static/icon-192.png',
    badge: '/static/icon-192.png',
    tag: data.id ? String(data.id) : 'reminder-' + Date.now(),
    renotify: true,
    requireInteraction: true,
    vibrate: [200, 100, 200, 100, 200],
    data: { id: data.id, content: data.content || '', url: '/' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// ===== 点击通知 =====
self.addEventListener('notificationclick', event => {
  const notif = event.notification;
  notif.close();

  event.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    // 已有打开的页面就直接聚焦，不重复开
    for (const c of all) {
      if (c.url.includes(self.location.origin)) {
        await c.focus();
        c.postMessage({ type: 'REMINDER_CLICKED', data: notif.data || {} });
        return;
      }
    }
    await clients.openWindow('/');
  })());
});

// ===== 订阅过期时尝试重新订阅 =====
self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil((async () => {
    try {
      const res = await fetch('/api/push/vapid-public-key');
      const { publicKey } = await res.json();
      const sub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          endpoint: sub.endpoint,
          keys: {
            p256dh: btoa(String.fromCharCode(...new Uint8Array(sub.getKey('p256dh'))))
              .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
            auth: btoa(String.fromCharCode(...new Uint8Array(sub.getKey('auth'))))
              .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
          },
          device: '自动续订',
        }),
      });
    } catch (e) {
      console.log('pushsubscriptionchange 续订失败', e);
    }
  })());
});

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

// ===== 收到页面消息 =====
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
