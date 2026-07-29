// sw.js — Service Worker untuk cache permanen model AI dan static assets
const CACHE_VERSION = 'v5-semangka-deteksi-2026-07-29-bbox-tuning';
const CORE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './best.onnx',
  './favicon.svg',
  './favicon.ico',
  './icon-192.png',
  './icon-512.png',
  './manifest.json'
];

const ORT_CDN_PATTERN = /^https:\/\/cdn\.jsdelivr\.net\/npm\/onnxruntime-web@[^/]+\/dist\//;

// Install: simpan static assets utama (TIDAK simpan best.onnx di install — 12MB, biarkan fetch saat butuh)
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      cache.addAll(CORE_ASSETS.filter(p => !p.includes('best.onnx')))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Strategi fetch:
//  - best.onnx / ORT CDN: cache-first (ambil dari cache kalau ada, download kalau belum)
//  - index.html: network-first, fallback cache
//  - sisanya: stale-while-revalidate
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // ===== best.onnx (cache-first, 12 MB — setelah diunduh jangan diunduh lagi) =====
  if (sameOrigin && url.pathname.endsWith('best.onnx')) {
    event.respondWith(
      caches.open(CACHE_VERSION).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        // Belum ada cache — download dulu, simpan ke cache permanen
        const network = await fetch(req);
        if (network && network.status === 200) cache.put(req, network.clone());
        return network;
      })
    );
    return;
  }

  // ===== ONNX Runtime dari jsdelivr CDN (cache-first) =====
  if (ORT_CDN_PATTERN.test(req.url)) {
    event.respondWith(
      caches.open(CACHE_VERSION + '-ort').then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        try {
          const network = await fetch(req);
          if (network && network.status === 200) cache.put(req, network.clone());
          return network;
        } catch {
          return cached;
        }
      })
    );
    return;
  }

  // ===== index.html — network first (mau yang terbaru) =====
  if (sameOrigin && (url.pathname === '/' || url.pathname.endsWith('index.html'))) {
    event.respondWith(
      fetch(req).then(async (network) => {
        if (network.status === 200) {
          const cache = await caches.open(CACHE_VERSION);
          cache.put(req, network.clone());
        }
        return network;
      }).catch(async () => {
        const cache = await caches.open(CACHE_VERSION);
        return cache.match(req) || cache.match('./index.html') || cache.match('./');
      })
    );
    return;
  }

  // ===== lainnya (css/js/favicon) — stale-while-revalidate =====
  if (sameOrigin) {
    event.respondWith(
      caches.open(CACHE_VERSION).then(async (cache) => {
        const cached = await cache.match(req);
        const networkPromise = fetch(req).then((network) => {
          if (network && network.status === 200) cache.put(req, network.clone());
          return network;
        }).catch(() => cached);
        return cached || networkPromise;
      })
    );
  }
});
