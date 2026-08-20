// 缓存前缀用于限定清理范围；修订后缀用于同一应用版本内刷新静态资源。
const CACHE_PREFIX = 'taxi-meter-';
const CACHE_NAME = 'taxi-meter-v1.4.3-r3';

// 需要离线缓存的核心资源列表
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './style.css',
  './src/app.js',
  './src/device.js',
  './src/domain.js',
  './manifest.json',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

// 统一转换为绝对地址，嵌套模块路径不会因只比较文件名而漏掉。
const CORE_ASSET_URLS = new Set(
  ASSETS_TO_CACHE.map((path) => new URL(path, self.registration.scope).href)
);
const INDEX_URL = new URL('./index.html', self.registration.scope).href;

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

// 激活阶段只清理本应用自己的旧缓存，不能影响同域名下的其他 PWA。
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache.startsWith(CACHE_PREFIX) && cache !== CACHE_NAME) {
            console.log('[Service Worker] Clearing old cache:', cache);
            return caches.delete(cache);
          }

          return Promise.resolve(false);
        })
      );
    }).then(() => self.clients.claim())
  );
});

// 判断请求是否属于本站核心静态文件，避免把无关请求塞进缓存。
function isCoreAsset(request) {
  return CORE_ASSET_URLS.has(new URL(request.url).href);
}

// HTML 导航使用网络优先，确保发布新版本后用户不会被旧缓存长期困住。
async function handleNavigationRequest(request) {
  try {
    const response = await fetch(request);

    // 404 或代理错误页不能覆盖可用的离线入口；缓存失败也不能阻断在线页面。
    if (response.ok && response.type === 'basic') {
      try {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(INDEX_URL, response.clone());
      } catch (cacheError) {
        console.warn('[Service Worker] Navigation cache write failed:', cacheError);
      }
    }

    return response;
  } catch (networkError) {
    const cached = await caches.match(INDEX_URL);
    return cached || Response.error();
  }
}

// 从网络读取核心资源，成功后等待写入缓存，防止 Service Worker 提前休眠。
async function fetchAndCache(request) {
  const response = await fetch(request);
  if (response && response.status === 200 && response.type === 'basic') {
    try {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    } catch (cacheError) {
      console.warn('[Service Worker] Static cache write failed:', cacheError);
    }
  }

  return response;
}

// 核心静态资源使用缓存优先并后台刷新，兼顾离线可用和版本更新。
function handleStaticRequest(request, event) {
  const networkFetch = fetchAndCache(request);

  // waitUntil 必须在 fetch 事件处理期间同步登记，否则部分浏览器会拒绝延长后台刷新任务。
  event.waitUntil(networkFetch.then(() => undefined).catch(() => undefined));

  return caches.match(request).then(async (cachedResponse) => {
    if (cachedResponse) return cachedResponse;

    try {
      return await networkFetch;
    } catch (networkError) {
      return Response.error();
    }
  });
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
    event.respondWith(handleStaticRequest(event.request, event));
  }
});
