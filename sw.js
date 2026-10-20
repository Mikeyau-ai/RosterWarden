// RosterWarden has moved to rosterwarden.sixthdaystudios.com.
//
// This replaces the old offline worker at this address: it clears the cached
// app, removes itself, and reloads any open copy so it reaches the redirect.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil((async () => {
  for (const key of await caches.keys()) await caches.delete(key);
  await self.registration.unregister();
  for (const client of await self.clients.matchAll({ type: 'window' })) client.navigate(client.url);
})()));
