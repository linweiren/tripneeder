const CACHE_NAME = 'tripneeder-shell-v2'
const APP_SHELL = ['/', '/manifest.webmanifest', '/tripneeder-icon.svg']
const STATIC_EXTENSIONS = [
  '.webp',
  '.png',
  '.jpg',
  '.jpeg',
  '.svg',
  '.css',
  '.js',
  '.woff',
  '.woff2',
]

const isStaticAsset = (url) =>
  url.origin === self.location.origin &&
  (url.pathname.startsWith('/assets/') ||
    STATIC_EXTENSIONS.some((extension) => url.pathname.endsWith(extension)))

const isNavigationRequest = (request) =>
  request.mode === 'navigate' ||
  request.headers.get('accept')?.includes('text/html')

const fetchAndCache = async (request) => {
  const response = await fetch(request)

  if (response.ok) {
    const cache = await caches.open(CACHE_NAME)
    await cache.put(request, response.clone())
  }

  return response
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)),
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      ),
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') {
    return
  }

  const url = new URL(event.request.url)

  if (url.origin !== self.location.origin || url.hostname.includes('supabase.co')) {
    return
  }

  if (url.pathname.startsWith('/api/')) {
    return
  }

  if (isStaticAsset(url)) {
    event.respondWith(
      caches
        .match(event.request)
        .then((cached) => cached || fetchAndCache(event.request)),
    )
    return
  }

  if (isNavigationRequest(event.request)) {
    event.respondWith(
      fetchAndCache(event.request).catch(() => caches.match('/')),
    )
  }
})
