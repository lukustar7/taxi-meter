// 缓存版本号
const CACHE_NAME = 'taxi-meter-v1.1';

// 需要离线缓存的核心资源列表
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './manifest.json',
  './icon.svg'
];

// 安装 Service Worker，缓存所有必要资源
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[Service Worker] Caching core assets');
        return cache.addAll(ASSETS_TO_CACHE);
      })
      .then(() => self.skipWaiting()) // 强制激活新版 SW
  );
});

// 激活阶段，清除旧版缓存
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            console.log('[Service Worker] Clearing old cache:', cache);
            return caches.delete(cache);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// 拦截请求并实施“缓存优先”策略
self.addEventListener('fetch', (event) => {
  // 只拦截同源的 GET 请求
  if (event.request.method !== 'GET') return;
  
  event.respondWith(
    caches.match(event.request)
      .then((cachedResponse) => {
        // 如果命中缓存，直接返回；否则进行网络请求
        if (cachedResponse) {
          return cachedResponse;
        }

        return fetch(event.request)
          .then((response) => {
            // 如果请求失败，或者是无效响应，则直接返回网络响应
            if (!response || response.status !== 200 || response.type !== 'basic') {
              return response;
            }

            // 克隆响应，将其存入缓存，供下次离线使用
            const responseToCache = response.clone();
            caches.open(CACHE_NAME)
              .then((cache) => {
                cache.put(event.request, responseToCache);
              });

            return response;
          })
          .catch(() => {
            // 如果网络彻底断开，且没有对应缓存，这里可以返回占位符或友好提示
            console.log('[Service Worker] Network request failed and no cache available.');
          });
      })
  );
});
