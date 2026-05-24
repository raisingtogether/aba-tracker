var CACHE = 'rt-tracker-v1';
var URLS = [
  '/tracker/',
  '/tracker/index.html',
  'https://unpkg.com/preact@10.23.2/dist/preact.umd.js',
  'https://unpkg.com/preact@10.23.2/hooks/dist/hooks.umd.js',
  'https://unpkg.com/htm@3.1.1/dist/htm.umd.js'
];

self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE).then(function(cache) {
      return cache.addAll(URLS);
    }).then(function() {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.filter(function(k) { return k !== CACHE; }).map(function(k) { return caches.delete(k); }));
    }).then(function() {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function(e) {
  e.respondWith(
    caches.match(e.request).then(function(cached) {
      if (cached) return cached;
      return fetch(e.request).then(function(response) {
        if (!response || response.status !== 200 || response.type === 'error') return response;
        var clone = response.clone();
        caches.open(CACHE).then(function(cache) { cache.put(e.request, clone); });
        return response;
      }).catch(function() {
        if (e.request.mode === 'navigate') {
          return caches.match('/tracker/index.html');
        }
      });
    })
  );
});
