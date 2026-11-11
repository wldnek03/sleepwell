/* SleepWell 서비스워커 — 앱 셸만 캐시한다.
   오디오는 매번 기기에서 생성되므로 캐시 대상이 아니다. */
var CACHE = 'sleepwell-v2';
var SHELL = [
  './',
  './index.html',
  './css/app.css',
  './js/presets.js',
  './js/synth.js',
  './js/listen.js',
  './js/app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(function (hit) {
      return hit || fetch(e.request).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); }).catch(function () { });
        return res;
      });
    }).catch(function () { return caches.match('./index.html'); })
  );
});
