// 全局语义化版本号
const VERSION = '1.4.2';

// 默认上海运价作为初始出厂参数；所有读取到的外部配置都会先回到这个安全基线再做校验。
const DEFAULT_RATE = Object.freeze({ base: 16, baseKm: 3, perKm: 2.7, emptyKm: 15, emptyRate: 1.5 });

// 终极车资最大限制 (防爆屏封顶：99.9万)
const MAX_FARE = 999999.00;

// 数字输入统一上限，避免用户输入 Infinity 或超大科学计数法后把账单算成 NaN。
const MAX_NUMERIC_INPUT = MAX_FARE;

// 返空倍率只允许在合理区间内波动，防止 1e309 之类的输入污染计费公式。
const MAX_EMPTY_RATE = 100;

// 收款码只需要小图；限制 512KB 可以避开 localStorage 配额爆炸和手机内存浪费。
const MAX_QR_IMAGE_BYTES = 512 * 1024;

// GPS 样本质量阈值：宁可少记一个坏点，也不让弱信号瞬间跳出离谱里程。
const MAX_GPS_ACCURACY_METERS = 80;
const MIN_MOVING_SPEED_KMH = 0.6;
const MAX_REASONABLE_SPEED_KMH = 200;
const MAX_SINGLE_SEGMENT_KM = 2;
const MIN_MOVING_DISTANCE_KM = 0.003;

// LocalStorage 专用键名集中管理，避免字符串散落导致迁移和清理遗漏。
const STORAGE_CONFIG_KEY = 'retro_taxi_meter_config_v1';
const STORAGE_QR_KEY = 'retro_taxi_meter_qr_v1';

// 夜间费率配置 (23:00 - 次日 05:00 自动加收 30% 费率)
const NIGHT_MULTIPLIER = 1.3;

// 用户配置
let config = {
    rate: { ...DEFAULT_RATE },
    qrImage: null
};

// 状态管理
let state = {
    isRunning: false,     // 行程是否运行中
    startTime: 0,         // 开始时间戳
    elapsedTime: 0,       // 累计时间 (秒)
    distance: 0,          // 累计里程 (km)
    currentFare: 0,       // 当前计价费 (元)
    fareDistance: 0,      // 已进入阶梯计价公式的有效里程 (km)
    tollFee: 0,           // 路桥费
    otherFee: 0,          // 停车费/其他
    tipFee: 0,            // 小费
    lastPos: null,        // 上一次 GPS 位置
    lastTimestamp: 0,     // 上一次 GPS 定位的时间戳
    lastChargedPos: null, // 上一次真正计费的 GPS 位置
    lastChargedTimestamp: 0, // 上一次真正计费的时间戳
    watchId: null,        // Geolocation 监听器 ID
    timerId: null,        // 计时器 ID
    isNight: false        // 当前是否处于夜间加费阶段
};

// Web Audio API 上下文 (延迟懒加载以兼容浏览器 Autoplay 限制)
let audioCtx = null;
// 屏幕常亮锁对象
let wakeLock = null;

// ================= 初始化与核心设置 =================

function init() {
    registerServiceWorker(); // 注册 PWA 离线脚本
    loadSettings();          // 读取缓存的费率和收款码
    initTheme();             // 初始化昼夜主题 (优先尊重用户选择，无选择时按时间自适应)
    updateNightStatus();     // 检测并更新夜间状态
    updateDisplay();         // 刷新数字显示
}

// 注册 PWA Service Worker 离线缓存
function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('./service-worker.js')
                .then((reg) => {
                    console.log('[PWA] Service Worker 注册成功，Scope:', reg.scope);
                })
                .catch((err) => {
                    console.warn('[PWA] Service Worker 注册失败:', err);
                });
        });
    }
}

// 把来自输入框、缓存或旧版本数据的数字清洗成有限范围内的数字，防止 NaN/Infinity 污染计费。
function clampNumber(value, fallback, min = 0, max = MAX_NUMERIC_INPUT) {
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }

    return Math.min(Math.max(parsed, min), max);
}

// 统一修正费率配置，尤其保证“返空起征点”不会小于“起步里程”。
function normalizeRate(rawRate = {}) {
    const source = rawRate || {};
    const rate = {
        base: clampNumber(source.base, DEFAULT_RATE.base),
        baseKm: clampNumber(source.baseKm, DEFAULT_RATE.baseKm),
        perKm: clampNumber(source.perKm, DEFAULT_RATE.perKm),
        emptyKm: clampNumber(source.emptyKm, DEFAULT_RATE.emptyKm),
        emptyRate: clampNumber(source.emptyRate, DEFAULT_RATE.emptyRate, 1, MAX_EMPTY_RATE)
    };

    if (rate.emptyKm < rate.baseKm) {
        rate.emptyKm = rate.baseKm;
    }

    return rate;
}

// 只保存费率，不把二维码塞进配置对象，避免同一张收款码在 localStorage 里占两份空间。
function saveRateConfig() {
    try {
        localStorage.setItem(STORAGE_CONFIG_KEY, JSON.stringify({ rate: config.rate }));
        return true;
    } catch (e) {
        console.warn('保存费率配置失败:', e);
        alert('费率保存失败：浏览器本地存储不可用或空间不足');
        return false;
    }
}

// 初始化阶段静默写回精简配置，用来清掉旧版本 config 中混入的 qrImage 大字段。
function persistNormalizedRateSilently() {
    try {
        localStorage.setItem(STORAGE_CONFIG_KEY, JSON.stringify({ rate: config.rate }));
    } catch (e) {
        console.warn('精简费率配置写回失败:', e);
    }
}

// 安全读取本地存储；部分隐私模式或存储被禁用时会抛错，不能让页面初始化中断。
function readStorageItem(key) {
    try {
        return localStorage.getItem(key);
    } catch (e) {
        console.warn('读取本地缓存失败:', e);
        return null;
    }
}

// 渲染收款码预览和支付页二维码，所有入口都走这里，避免重复 DOM 逻辑。
function renderQRImage(dataUrl) {
    config.qrImage = dataUrl;

    const preview = document.getElementById('qr-preview');
    preview.innerHTML = '';

    const img = document.createElement('img');
    img.src = dataUrl;
    img.alt = '收款码预览';
    img.style.width = '100px';
    preview.appendChild(img);

    document.getElementById('pay-qr-img').src = dataUrl;
    document.getElementById('pay-qr-img').style.display = 'block';
    document.getElementById('default-qr-text').style.display = 'none';
}

// 估算 Data URL 还原后的二进制体积，用于拦截过大的收款码图片。
function getDataUrlByteSize(dataUrl) {
    const base64 = dataUrl.split(',')[1] || '';
    return Math.ceil(base64.length * 3 / 4);
}

// 只接受常见位图格式，拒绝 SVG 等可携带复杂脚本语义的图片格式。
function isAllowedQRImageType(type) {
    return ['image/png', 'image/jpeg', 'image/webp'].includes(type);
}

// 旧缓存恢复也必须检查图片格式和大小，不能让历史大图绕过新上传限制。
function isAllowedQRDataUrl(dataUrl) {
    const match = typeof dataUrl === 'string' && dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,/);
    return Boolean(match) && getDataUrlByteSize(dataUrl) <= MAX_QR_IMAGE_BYTES;
}

// 将用户上传的图片压缩成二维码足够清晰的小图，降低 localStorage 配额爆炸风险。
function compressQRImage(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('图片读取失败'));
        reader.onload = () => {
            const image = new Image();
            image.onerror = () => reject(new Error('图片解析失败'));
            image.onload = () => {
                const maxSide = 512;
                const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
                const width = Math.max(1, Math.round(image.width * scale));
                const height = Math.max(1, Math.round(image.height * scale));
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;

                const ctx = canvas.getContext('2d');
                ctx.fillStyle = '#fff';
                ctx.fillRect(0, 0, width, height);
                ctx.drawImage(image, 0, 0, width, height);

                resolve(canvas.toDataURL('image/jpeg', 0.9));
            };
            image.src = reader.result;
        };
        reader.readAsDataURL(file);
    });
}

// 兼容性平滑数据搬运
function migrateLegacyStorage() {
    try {
        const legacyConfig = localStorage.getItem('taxi_config');
        if (legacyConfig && !localStorage.getItem(STORAGE_CONFIG_KEY)) {
            localStorage.setItem(STORAGE_CONFIG_KEY, legacyConfig);
            localStorage.removeItem('taxi_config');
        }
        const legacyQR = localStorage.getItem('taxi_qr');
        if (legacyQR && !localStorage.getItem(STORAGE_QR_KEY)) {
            localStorage.setItem(STORAGE_QR_KEY, legacyQR);
            localStorage.removeItem('taxi_qr');
        }
    } catch (e) {
        console.warn('LocalStorage data migration failed:', e);
    }
}

// 恢复缓存的运价和收款码
function loadSettings() {
    migrateLegacyStorage(); // 优先执行平滑数据搬运

    const savedConfig = readStorageItem(STORAGE_CONFIG_KEY);
    if (savedConfig) {
        try {
            const parsed = JSON.parse(savedConfig);
            // 同时兼容 { rate: ... } 和更老的扁平对象，读出来后统一做边界校验。
            config.rate = normalizeRate(parsed && (parsed.rate || parsed));
            persistNormalizedRateSilently();
        } catch (e) {
            console.warn('读取配置解析失败，恢复默认配置:', e);
            config.rate = { ...DEFAULT_RATE };
            persistNormalizedRateSilently();
        }
    }
    
    // 扁平回填设置表单
    document.getElementById('base-fare').value = config.rate.base;
    document.getElementById('base-dist').value = config.rate.baseKm;
    document.getElementById('per-km').value = config.rate.perKm;
    document.getElementById('empty-dist').value = config.rate.emptyKm;
    document.getElementById('empty-fee').value = config.rate.emptyRate;

    // 二维码恢复
    const savedQR = readStorageItem(STORAGE_QR_KEY);
    if (isAllowedQRDataUrl(savedQR)) {
        renderQRImage(savedQR);
    } else if (savedQR) {
        try {
            localStorage.removeItem(STORAGE_QR_KEY);
        } catch (e) {
            console.warn('清理无效收款码缓存失败:', e);
        }
    }
    
    updateRateInfoDisplay(config.rate);
}

// 刷新 LED 屏下的城市费率提示文字
function updateRateInfoDisplay(rate) {
    const nightText = state.isNight ? ` [夜间×${NIGHT_MULTIPLIER}]` : '';
    document.getElementById('rate-info').textContent = `费率 (${rate.base}元/${rate.baseKm}km)${nightText}`;
}

// 打开/关闭设置浮窗 (带物理音效反馈)
function toggleSettings() {
    playClickSound();
    triggerHaptic(15);
    const panel = document.getElementById('settings-panel');
    panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
}

// 保存自定义设置 (带物理音效反馈)
function saveSettings() {
    playClickSound();
    triggerHaptic(20);

    config.rate = normalizeRate({
        base: document.getElementById('base-fare').value,
        baseKm: document.getElementById('base-dist').value,
        perKm: document.getElementById('per-km').value,
        emptyKm: document.getElementById('empty-dist').value,
        emptyRate: document.getElementById('empty-fee').value
    });

    document.getElementById('base-fare').value = config.rate.base;
    document.getElementById('base-dist').value = config.rate.baseKm;
    document.getElementById('per-km').value = config.rate.perKm;
    document.getElementById('empty-dist').value = config.rate.emptyKm;
    document.getElementById('empty-fee').value = config.rate.emptyRate;

    if (!saveRateConfig()) return;
    updateNightStatus(); // 重新核对夜间指示并刷新运价展示
    if (state.isRunning) {
        recalcFare();
        updateDisplay();
    }
    toggleSettings();
    alert('费率设置已保存');
}

// 二维码图片上传本地缓存化
async function handleQRUpload(input) {
    const file = input.files && input.files[0];
    if (!file) return;

    if (!isAllowedQRImageType(file.type)) {
        input.value = '';
        alert('收款码仅支持 PNG、JPG 或 WebP 图片');
        return;
    }

    try {
        const compressedDataUrl = await compressQRImage(file);
        if (getDataUrlByteSize(compressedDataUrl) > MAX_QR_IMAGE_BYTES) {
            input.value = '';
            alert('收款码图片过大，请换一张更清晰且更小的二维码截图');
            return;
        }

        localStorage.setItem(STORAGE_QR_KEY, compressedDataUrl);
        renderQRImage(compressedDataUrl);
    } catch (e) {
        console.warn('收款码保存失败:', e);
        input.value = '';
        alert('收款码保存失败：浏览器本地存储空间不足或图片无法解析');
    }
}

// ================= 🔊 物理音效与震动合成 (Web Audio API) =================

// 初始化并获取音频上下文 (处理 Autoplay 限制)
function getAudioContext() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
    return audioCtx;
}

// 纯代码实时合成物理开关“咔哒”Click音效 (微动弹簧感)
function playClickSound() {
    try {
        const ctx = getAudioContext();
        if (!ctx) return;

        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        
        osc.type = 'sine';
        // 音调瞬间从高频滑落，极其清脆
        osc.frequency.setValueAtTime(1600, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(350, ctx.currentTime + 0.015);
        
        // 极速毫秒级包络衰减
        gain.gain.setValueAtTime(0.25, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.015);
        
        osc.connect(gain);
        gain.connect(ctx.destination);
        
        osc.start();
        osc.stop(ctx.currentTime + 0.02);
    } catch (e) {
        console.warn('Audio click generation failed:', e);
    }
}

// 纯代码实时合成机械翻牌“啪嗒”Clack音效 (稍微低沉厚重，带有一点回声)
function playClackSound() {
    try {
        const ctx = getAudioContext();
        if (!ctx) return;

        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        
        osc.type = 'triangle'; // 三角波，声音偏温和、带塑料撞击的质感
        osc.frequency.setValueAtTime(240, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(60, ctx.currentTime + 0.07);
        
        gain.gain.setValueAtTime(0.5, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.07);
        
        osc.connect(gain);
        gain.connect(ctx.destination);
        
        osc.start();
        osc.stop(ctx.currentTime + 0.08);
    } catch (e) {
        console.warn('Audio clack generation failed:', e);
    }
}

// 调用原生振动 API 实现物理震动反馈 (Taptic Engine 质感)
function triggerHaptic(duration = 15) {
    if (navigator.vibrate) {
        navigator.vibrate(duration);
    }
}

// ================= 🔒 屏幕常亮控制 (Wake Lock API) =================

// 申请屏幕常亮，防黑屏和计费中断
async function requestWakeLock() {
    if (wakeLock !== null) return;

    if ('wakeLock' in navigator) {
        try {
            wakeLock = await navigator.wakeLock.request('screen');
            console.log('[Wake Lock] 屏幕常亮锁已成功激活！');
            wakeLock.addEventListener('release', () => {
                wakeLock = null;
                console.log('[Wake Lock] 屏幕常亮锁已被系统强制释放');
            });
        } catch (err) {
            console.warn(`[Wake Lock] 请求常亮锁失败: ${err.message}`);
        }
    }
}

// 释放屏幕常亮锁
function releaseWakeLock() {
    if (wakeLock !== null) {
        wakeLock.release().then(() => {
            wakeLock = null;
            console.log('[Wake Lock] 屏幕常亮锁已手动释放');
        }).catch((err) => {
            wakeLock = null;
            console.warn('[Wake Lock] 释放常亮锁失败:', err);
        });
    }
}

// 当页面切回前台时，若计价器仍在跑，则重新请求常亮锁
document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && state.isRunning) {
        await requestWakeLock();
    }
});

// ================= 🌙 昼夜模式与时间检测 =================

// 检查是否属于夜间加成时间 (23:00 - 次日 05:00)
function isNightTime() {
    const hours = new Date().getHours();
    return hours >= 23 || hours < 5;
}

// 刷新夜间状态与 LED 指示灯；返回值表示夜间状态是否发生变化。
function updateNightStatus() {
    const isNight = isNightTime();
    const indicator = document.getElementById('night-indicator');
    const changed = state.isNight !== isNight;
    
    if (isNight) {
        indicator.classList.add('active'); // 亮灯
        state.isNight = true;
    } else {
        indicator.classList.remove('active'); // 灭灯
        state.isNight = false;
    }
    
    updateRateInfoDisplay(config.rate);
    return changed;
}

// ================= ☀️/🌙 昼夜视觉主题切换 =================

// 初始化昼夜主题 (始终根据当前实际时间自适应，不保留上次的缓存选择)
function initTheme() {
    const isNight = isNightTime();
    setTheme(isNight ? 'night' : 'day');
}

// 执行主题切换
function setTheme(theme) {
    const body = document.body;
    const btn = document.getElementById('theme-toggle-btn');
    if (theme === 'day') {
        body.classList.add('day-theme');
        btn.textContent = '☀️';
    } else {
        body.classList.remove('day-theme');
        btn.textContent = '🌙';
    }
}

// 点击顶部切换按钮
function toggleTheme() {
    playClickSound();
    triggerHaptic(15);
    const isDay = document.body.classList.contains('day-theme');
    setTheme(isDay ? 'night' : 'day');
}

// ================= 🚖 核心计费与 GPS 定位 =================

// 开始行程
function startTrip() {
    if (state.isRunning) return;
    if (!navigator.geolocation) { alert('您的浏览器不支持 GPS 定位'); return; }

    // 播放清脆的机械声和较强物理震动
    playClackSound();
    triggerHaptic(30);

    state.isRunning = true;
    state.startTime = Date.now();
    state.distance = 0;
    state.fareDistance = 0;
    state.elapsedTime = 0;
    
    // 重新核对夜间费率
    updateNightStatus();
    const baseMultiplier = state.isNight ? NIGHT_MULTIPLIER : 1.0;
    state.currentFare = Math.min(config.rate.base * baseMultiplier, MAX_FARE); 
    state.lastPos = null;
    state.lastTimestamp = 0;
    state.lastChargedPos = null;
    state.lastChargedTimestamp = 0;

    // 申请屏幕常亮
    requestWakeLock();

    document.getElementById('empty-sign').classList.add('flipped'); 
    document.querySelector('.btn-start').disabled = true;
    document.querySelector('.btn-stop').disabled = false;
    document.getElementById('gps-status').textContent = 'GPS: Connecting...';
    document.getElementById('gps-status').style.color = 'yellow';

    // 启动秒计时器
    state.timerId = setInterval(() => {
        state.elapsedTime++;
        if (updateNightStatus()) {
            recalcFare();
        }
        updateDisplay();
    }, 1000);

    // 启动 GPS 定位监听
    const options = { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 };
    state.watchId = navigator.geolocation.watchPosition(onLocationUpdate, onLocationError, options);
}

// 结束行程 (包含破产清算拦截变异)
function stopTrip() {
    if (!state.isRunning) return;

    playClickSound();
    triggerHaptic(20);

    state.isRunning = false;
    if (state.timerId) {
        clearInterval(state.timerId);
        state.timerId = null;
    }
    if (state.watchId !== null) {
        navigator.geolocation.clearWatch(state.watchId);
        state.watchId = null;
    }

    // 释放屏幕常亮锁
    releaseWakeLock();

    document.querySelector('.btn-stop').disabled = true;
    document.getElementById('gps-status').textContent = 'GPS: Stopped';
    document.getElementById('gps-status').style.color = '#666';

    const payBtn = document.querySelector('.btn-phys.btn-next');
    
    // 【网贷渡劫彩蛋触发】
    if (state.currentFare >= MAX_FARE) {
        payBtn.textContent = '⚡ 余额不足，一键渡劫';
        payBtn.classList.add('btn-bankrupt-alert'); // 添加财富闪动效果
        payBtn.onclick = triggerBankruptcy;          // 直达一键借款页
    } else {
        // 恢复正常支付通道
        payBtn.textContent = '支付';
        payBtn.classList.remove('btn-bankrupt-alert');
        payBtn.onclick = nextStep;
    }
    
    payBtn.style.display = 'inline-block';
}

// 判断定位点的基础质量，先挡掉空值、无效经纬度和弱信号坏点。
function isUsableLocationSample(lat, lon, accuracy, timestamp) {
    return Number.isFinite(lat) &&
        Number.isFinite(lon) &&
        Number.isFinite(accuracy) &&
        Number.isFinite(timestamp) &&
        accuracy <= MAX_GPS_ACCURACY_METERS;
}

// 将 GPS 样本写为新的参考点；静止样本也需要更新时间，避免红灯等待后平均速度被摊薄。
function updateLocationAnchor(lat, lon, timestamp) {
    state.lastPos = { lat, lon };
    state.lastTimestamp = timestamp;
}

// GPS 位置更新处理 (智能防漂移与蠕行计费过滤)
function onLocationUpdate(position) {
    if (!state.isRunning) return;

    const lat = position.coords.latitude;
    const lon = position.coords.longitude;
    const accuracy = position.coords.accuracy;
    const timestamp = position.timestamp || Date.now();
    const speed = position.coords.speed; // m/s, 系统原生测得的运动瞬时速度
    
    document.getElementById('gps-status').textContent = `GPS: OK (±${Math.round(accuracy)}m)`;
    document.getElementById('gps-status').style.color = '#34c759';

    if (!isUsableLocationSample(lat, lon, accuracy, timestamp)) {
        document.getElementById('gps-status').textContent = `GPS: Weak (±${Math.round(accuracy || 0)}m)`;
        document.getElementById('gps-status').style.color = 'orange';
        return;
    }

    // 首次定位只初始化采样点和计费点，不累计里程。
    if (!state.lastPos) { 
        updateLocationAnchor(lat, lon, timestamp);
        state.lastChargedPos = { lat, lon };
        state.lastChargedTimestamp = timestamp;
        return; 
    }

    const dist = haversineDistance(state.lastPos.lat, state.lastPos.lon, lat, lon);
    const timeDiffSec = (timestamp - state.lastTimestamp) / 1000;

    if (timeDiffSec <= 0) {
        return;
    }

    const avgSpeedKmh = dist / (timeDiffSec / 3600);
    const reportedSpeedKmh = Number.isFinite(speed) ? speed * 3.6 : null;
    const passesPhysicsGate = dist <= MAX_SINGLE_SEGMENT_KM && avgSpeedKmh <= MAX_REASONABLE_SPEED_KMH;

    if (!passesPhysicsGate) {
        updateLocationAnchor(lat, lon, timestamp);
        document.getElementById('gps-status').textContent = 'GPS: Jump filtered';
        document.getElementById('gps-status').style.color = 'orange';
        return;
    }

    const hasReportedMovement = reportedSpeedKmh !== null &&
        reportedSpeedKmh >= MIN_MOVING_SPEED_KMH &&
        reportedSpeedKmh <= MAX_REASONABLE_SPEED_KMH;
    const hasMeasuredMovement = dist >= MIN_MOVING_DISTANCE_KM &&
        avgSpeedKmh >= MIN_MOVING_SPEED_KMH &&
        avgSpeedKmh <= MAX_REASONABLE_SPEED_KMH;

    // 若判定为等红绿灯静止或轻微信号漂移，更新时间锚点但不累计里程。
    if (!hasReportedMovement && !hasMeasuredMovement) {
        updateLocationAnchor(lat, lon, timestamp);
        return;
    }

    state.distance = Math.min(state.distance + dist, MAX_NUMERIC_INPUT);
    state.fareDistance = state.distance;
    state.lastChargedPos = { lat, lon };
    state.lastChargedTimestamp = timestamp;
    updateLocationAnchor(lat, lon, timestamp);
    
    if (updateNightStatus()) {
        console.log('[Fare] 夜间状态已切换，按当前时段重新核算车资');
    }
    recalcFare(); // 重新核算阶梯费用
    updateDisplay(); // 刷新 LED 屏幕
}

// 定位失败错误提示
function onLocationError(err) {
    if (!state.isRunning) return;

    document.getElementById('gps-status').textContent = `GPS Error: ${err.message}`;
    document.getElementById('gps-status').style.color = 'red';
}

// 精密的阶梯价格算法 (支持白天/夜间差价 + 返空加价 + 99.9万硬封顶)
function recalcFare() {
    const rate = normalizeRate(config.rate);
    config.rate = rate;
    const baseMultiplier = state.isNight ? NIGHT_MULTIPLIER : 1.0;
    
    const baseFare = rate.base * baseMultiplier;
    const perKmFare = rate.perKm * baseMultiplier;
    const billableDistance = clampNumber(state.fareDistance, 0);
    const baseKm = rate.baseKm;
    const emptyThreshold = Math.max(rate.emptyKm, baseKm);
    let fare = baseFare; 

    if (billableDistance > baseKm) {
        const normalExtra = Math.max(0, Math.min(billableDistance, emptyThreshold) - baseKm);
        const emptyExtra = Math.max(0, billableDistance - emptyThreshold);
        fare += normalExtra * perKmFare;
        fare += emptyExtra * perKmFare * rate.emptyRate;
    }
    
    // 【大数溢出防御第一关】强行封顶 999,999.00 元，异常数值直接回到起步价。
    state.currentFare = Number.isFinite(fare) ? Math.min(Math.max(fare, 0), MAX_FARE) : Math.min(baseFare, MAX_FARE);
}

// 地球表面两点经纬度距离公式 (Haversine Formula)
function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // 地球半径 (km)
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

// 更新 LED 屏幕渲染数值 (含有大数自适应字号缩放)
function updateDisplay() {
    const priceStr = state.currentFare.toFixed(2);
    const priceDisplayNode = document.getElementById('display-price');
    priceDisplayNode.textContent = priceStr;
    
    // 【大数溢出防御第二关】根据车资字符长度，动态缩放 LED 显示屏字号，防止挤爆撑大
    const mainRow = priceDisplayNode.parentElement;
    let targetClass = '';
    if (priceStr.length > 8) {       // 千位数以上，如 ¥100000.00
        targetClass = 'super-long-value';
    } else if (priceStr.length > 6) { // 百位数以上，如 ¥1000.00
        targetClass = 'long-value';
    }

    // 性能优化：仅在类名确实需要变更时才操作 DOM classList，防止高频触发 Style Recalculation
    const hasLong = mainRow.classList.contains('long-value');
    const hasSuper = mainRow.classList.contains('super-long-value');

    if (targetClass === 'super-long-value') {
        if (!hasSuper) {
            mainRow.classList.remove('long-value');
            mainRow.classList.add('super-long-value');
        }
    } else if (targetClass === 'long-value') {
        if (!hasLong) {
            mainRow.classList.remove('super-long-value');
            mainRow.classList.add('long-value');
        }
    } else {
        if (hasLong || hasSuper) {
            mainRow.classList.remove('long-value', 'super-long-value');
        }
    }
    
    document.getElementById('display-km').textContent = state.distance.toFixed(1);
    
    const mins = Math.floor(state.elapsedTime / 60);
    const secs = state.elapsedTime % 60;
    document.getElementById('display-time').textContent = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// ================= 💳 页面流转与结账交互 =================

// ================= ↩️ 返回上一页流转处理 =================

// 从附加费页面返回计价器主屏
function goBackToMeter() {
    playClickSound();
    triggerHaptic(15);
    
    document.getElementById('extra-fee-screen').style.display = 'none';
    document.getElementById('meter-screen').style.display = 'flex';
    document.getElementById('meter-screen').classList.add('active-screen');
}

// 从小费选择页面返回附加费页面 (数据自然保留在输入框)
function goBackToExtra() {
    playClickSound();
    triggerHaptic(15);
    
    document.getElementById('tip-screen').style.display = 'none';
    document.getElementById('extra-fee-screen').style.display = 'flex';
}

// 从支付详情页面返回小费选择页面 (仅限未代扣的正常结算状态)
function goBackToTip() {
    playClickSound();
    triggerHaptic(15);
    
    document.getElementById('pay-screen').style.display = 'none';
    document.getElementById('tip-screen').style.display = 'flex';
}

// 进入附加费页面
function nextStep() {
    playClickSound();
    triggerHaptic(15);
    document.getElementById('meter-screen').classList.remove('active-screen');
    document.getElementById('meter-screen').style.display = 'none';
    document.getElementById('extra-fee-screen').style.display = 'flex';
}

// 进入小费选择页 (带小费动态预算)
function goToTip() {
    playClickSound();
    triggerHaptic(15);
    state.tollFee = clampNumber(document.getElementById('toll-fee').value, 0);
    state.otherFee = clampNumber(document.getElementById('other-fee').value, 0);
    document.getElementById('toll-fee').value = state.tollFee || '';
    document.getElementById('other-fee').value = state.otherFee || '';
    
    document.getElementById('extra-fee-screen').style.display = 'none';
    document.getElementById('tip-screen').style.display = 'flex';
    
    updateTipValues();
    selectTip(0.20); // 默认选中 20% 鸡腿小费 😈
}

// 刷新 POS 小费网格按钮的值
function updateTipValues() {
    const baseTotal = Math.min(state.currentFare + state.tollFee + state.otherFee, MAX_FARE);
    
    document.getElementById('val-15').textContent = '¥' + (baseTotal * 0.15).toFixed(1);
    document.getElementById('val-20').textContent = '¥' + (baseTotal * 0.20).toFixed(1);
    document.getElementById('val-25').textContent = '¥' + (baseTotal * 0.25).toFixed(1);
}

// 选中某个小费比例
function selectTip(percent) {
    playClickSound();
    triggerHaptic(15);

    // 隐藏并清空自定义输入框
    document.getElementById('custom-tip-container').style.display = 'none';
    document.getElementById('custom-tip').value = '';
    
    // 更新选中状态 UI
    document.querySelectorAll('.btn-pos-tip').forEach(b => b.classList.remove('selected'));
    
    if (percent === 0.15) document.querySelectorAll('.btn-pos-tip')[0].classList.add('selected');
    if (percent === 0.20) document.querySelectorAll('.btn-pos-tip')[1].classList.add('selected');
    if (percent === 0.25) document.querySelectorAll('.btn-pos-tip')[2].classList.add('selected');
    
    const baseTotal = Math.min(state.currentFare + state.tollFee + state.otherFee, MAX_FARE);
    state.tipFee = Math.min(baseTotal * percent, MAX_FARE);
}

// 切换到自定义小费输入框
function showCustomTip() {
    playClickSound();
    triggerHaptic(15);

    document.querySelectorAll('.btn-pos-tip').forEach(b => b.classList.remove('selected'));
    document.getElementById('custom-tip-container').style.display = 'block';
    
    // 延迟 100ms 自动聚焦，确保键盘拉起顺畅
    setTimeout(() => document.getElementById('custom-tip').focus(), 100);
    state.tipFee = 0; 
}

// 清空预置小费，使用输入框的自定义金额
function clearTipSelection() {
    state.tipFee = clampNumber(document.getElementById('custom-tip').value, 0);
}

// 进入最终支付单详情页 (含有大数溢出防御限制)
function goToPay() {
    playClickSound();
    triggerHaptic(25);

    // 兜底再次核算自定义小费
    if (document.getElementById('custom-tip-container').style.display !== 'none') {
        state.tipFee = clampNumber(document.getElementById('custom-tip').value, 0);
    }
    
    const total = [state.currentFare, state.tollFee, state.otherFee, state.tipFee]
        .reduce((sum, value) => sum + clampNumber(value, 0), 0);
    
    // 最终汇总金额同样加入 999999.00 的硬封顶拦截
    const cappedTotal = Math.min(total, MAX_FARE);
    
    document.getElementById('bill-meter').textContent = state.currentFare.toFixed(2);
    document.getElementById('bill-extra').textContent = (state.tollFee + state.otherFee).toFixed(2);
    document.getElementById('bill-tip').textContent = state.tipFee.toFixed(2);
    document.getElementById('final-total').textContent = cappedTotal.toFixed(2);
    
    // 恢复为常规支付标题与二维码显示 (避免上一单彩蛋残留)
    document.getElementById('pay-screen-title').textContent = '请支付';
    document.getElementById('pay-qr-area').style.display = 'block';
    document.getElementById('paid-stamp-area').style.display = 'none';
    
    // 正常支付下显示返回修改小费按钮
    document.getElementById('btn-pay-back').style.display = 'inline-block';

    document.getElementById('tip-screen').style.display = 'none';
    document.getElementById('pay-screen').style.display = 'flex';
}

// ================= ⚡ 触发一键渡劫网贷彩蛋页面 =================

function triggerBankruptcy() {
    playClackSound();  // 终极清算大声 Clack！
    triggerHaptic(50); // 强烈的微型手机震动

    // 回填封顶金额展示
    document.getElementById('bankrupt-total').textContent = MAX_FARE.toFixed(2);
    
    // 全屏切换进入渡劫贷彩蛋页面
    document.getElementById('meter-screen').classList.remove('active-screen');
    document.getElementById('meter-screen').style.display = 'none';
    document.getElementById('bankruptcy-screen').style.display = 'flex';
}

// 借款人点击“立即借款付清”逻辑 (爆笑弹窗并划扣车资)
function submitLoanPayment() {
    playClackSound();
    triggerHaptic(40);

    alert("⚡ 借款申请成功！\n\n已成功从您的【打车借呗·一键渡劫贷】专属账户划扣 ¥999,999.00 并足额付清车资！\n\n💡 贴心提示：请于 5 秒内结清还款以享受首期免息特权！超时将自动转入全家九族工地无偿搬砖信用抵债流程 👷‍♂️🧱！不留遗憾！");

    // 伪造最终账单并跳转到常规支付成功界面
    state.tollFee = 0;
    state.otherFee = 0;
    state.tipFee = 0;

    document.getElementById('bill-meter').textContent = MAX_FARE.toFixed(2);
    document.getElementById('bill-extra').textContent = '0.00';
    document.getElementById('bill-tip').textContent = '0.00';
    document.getElementById('final-total').textContent = MAX_FARE.toFixed(2);

    // 渲染为“已代扣结清”的尊贵状态，隐藏扫码区域，展示 PAID 印章
    document.getElementById('pay-screen-title').textContent = '🎉 账单已结清 (网贷代扣)';
    document.getElementById('pay-qr-area').style.display = 'none';
    document.getElementById('paid-stamp-area').style.display = 'flex';
    
    // 网贷代扣完成，合同生效，强行隐藏返回修改按钮，防反悔逻辑漏洞
    document.getElementById('btn-pay-back').style.display = 'none';

    // 隐藏网贷页，展示常规支付账单成功页
    document.getElementById('bankruptcy-screen').style.display = 'none';
    document.getElementById('pay-screen').style.display = 'flex';
}

// ================= 🔄 重置与重开下一单 =================

function resetApp() {
    playClickSound();
    triggerHaptic(30); // 重启大震动

    // 强制终止并释放可能驻留在后台的定时器和 GPS 监听器，封杀多路重影计费与内存泄漏
    if (state.timerId) {
        clearInterval(state.timerId);
        state.timerId = null;
    }
    if (state.watchId !== null) {
        navigator.geolocation.clearWatch(state.watchId);
        state.watchId = null;
    }
    releaseWakeLock();

    state.isRunning = false;
    state.distance = 0;
    state.fareDistance = 0;
    state.elapsedTime = 0;
    state.tollFee = 0;
    state.otherFee = 0;
    state.tipFee = 0;
    
    // 彻底清除上一单的 GPS 轨迹与时间戳，防起步信号瞬发跃变
    state.lastPos = null;
    state.lastTimestamp = 0;
    state.lastChargedPos = null;
    state.lastChargedTimestamp = 0;
    
    updateNightStatus(); // 重新核对此时的夜间费率
    const baseMultiplier = state.isNight ? NIGHT_MULTIPLIER : 1.0;
    state.currentFare = Math.min(config.rate.base * baseMultiplier, MAX_FARE);
    
    // 恢复主计表盘屏幕，隐藏所有结账、中间残留及网贷彩蛋页面
    document.getElementById('meter-screen').style.display = 'flex';
    document.getElementById('meter-screen').classList.add('active-screen');
    document.getElementById('pay-screen').style.display = 'none';
    document.getElementById('bankruptcy-screen').style.display = 'none';
    document.getElementById('extra-fee-screen').style.display = 'none';
    document.getElementById('tip-screen').style.display = 'none';
    document.getElementById('paid-stamp-area').style.display = 'none'; // 还原网贷印章
    
    document.getElementById('empty-sign').classList.remove('flipped');
    document.querySelector('.btn-start').disabled = false;
    document.querySelector('.btn-stop').disabled = true;
    
    // 彻底恢复主屏上可能发生变异的物理支付按钮（还原文字、取消金光闪烁、重新绑定正常流程）
    const payBtn = document.querySelector('.btn-phys.btn-next');
    payBtn.style.display = 'none';
    payBtn.textContent = '支付';
    payBtn.classList.remove('btn-bankrupt-alert');
    payBtn.onclick = nextStep;
    
    // 调用 updateDisplay 统一复位 LED 数码管，自动清空大数爆屏样式并填充 '0.00'
    updateDisplay();
    
    // 附加费和自定义小费输入框重置为 placeholder 默认状态 ('' 会被 parseFloat 转化为 0)
    document.getElementById('toll-fee').value = '';
    document.getElementById('other-fee').value = '';
    document.getElementById('custom-tip').value = '';
}

// 执行初始化
init();
