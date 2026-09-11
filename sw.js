"use strict";

// 内容を更新するときは版番号も上げ、古い画面と新しい資材を混在させません。
const CACHE_PREFIX = "museum-sensor-shell:" + self.registration.scope + ":";
const CACHE_NAME = CACHE_PREFIX + "v1";
const APP_PATHS = [
  "./", "./index.html", "./room_logger.html", "./manifest.json",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png",
];
const APP_URLS = APP_PATHS.map(path => new URL(path, self.registration.scope).href);

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_URLS.map(url => new Request(url, { cache: "reload" })));
    // 実験中のページを途中で更新しないため、skipWaiting は呼びません。
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  url.search = "";
  url.hash = "";
  // 記録データや別サイトは扱わず、公開用の固定ファイルだけをキャッシュします。
  if (!APP_URLS.includes(url.href)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(url.href);
    return cached || fetch(event.request);
  })());
});
