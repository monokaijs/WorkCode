const prefix = 'workos-code:' + self.registration.scope + ':';
const cacheName = prefix + '__VERSION__';
const files = __FILES__.map(path => new URL(path, self.registration.scope).href);
const entry = new URL('index.html', self.registration.scope);
self.addEventListener('install', event => {
  event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(files)));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith(prefix) && key !== cacheName).map(key => caches.delete(key))
  )));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  const navigation = event.request.mode === 'navigate' && url.origin === entry.origin &&
    [entry.pathname, new URL(self.registration.scope).pathname].includes(url.pathname);
  if (navigation || files.includes(url.href)) {
    event.respondWith(caches.open(cacheName).then(async cache =>
      (await cache.match(navigation ? entry.href : url.href)) || fetch(event.request)));
  }
});
