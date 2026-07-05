// 缓存版本号必须随发布版本同步升级，否则已安装 PWA 会长期读取旧文件。
const CACHE_NAME = 'taxi-meter-v1.4.2';

// 需要离线缓存的核心资源列表
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './manifest.json',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

const CORE_ASSET_PATHS = new Set(ASSETS_TO_CACHE);

// 安装 Service Worker，缓存所有必要资源。
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

// 判断请求是否属于本站核心静态文件，避免把无关请求塞进缓存。
function isCoreAsset(request) {
  const url = new URL(request.url);
  const fileName = url.pathname.split('/').pop();
  return url.origin === location.origin &&
    (CORE_ASSET_PATHS.has(`./${fileName}`) || url.pathname.endsWith('/'));
}

// HTML 导航使用网络优先，确保发布新版本后用户不会被旧缓存长期困住。
async function handleNavigationRequest(request) {
  try {
    const response = await fetch(request);
    const cache = await caches.open(CACHE_NAME);
    cache.put('./index.html', response.clone());
    return response;
  } catch (e) {
    const cached = await caches.match('./index.html');
    return cached || Response.error();
  }
}

// 核心静态资源使用缓存优先并后台刷新，兼顾离线可用和版本更新。
async function handleStaticRequest(request) {
  const cachedResponse = await caches.match(request);
  const networkFetch = fetch(request)
    .then((response) => {
      if (response && response.status === 200 && response.type === 'basic') {
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(request, response.clone());
        });
      }
      return response;
    })
    .catch(() => null);

  return cachedResponse || await networkFetch || Response.error();
}

// 拦截请求并实施“导航网络优先、静态资源缓存优先”的离线策略。
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 只拦截同源的 GET 请求，外部资源交给浏览器默认网络栈处理。
  if (event.request.method !== 'GET') return;
  if (url.origin !== location.origin) return;

  if (event.request.mode === 'navigate') {
    event.respondWith(handleNavigationRequest(event.request));
    return;
  }

  if (isCoreAsset(event.request)) {
    event.respondWith(handleStaticRequest(event.request));
  }
});
