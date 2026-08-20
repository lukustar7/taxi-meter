import {
    APP_VERSION,
    DEFAULT_RATE,
    GPS_SAMPLE_STATUS,
    MAX_FARE,
    MAX_NUMERIC_INPUT,
    NIGHT_MULTIPLIER,
    analyzeLocationSample,
    calculateBill,
    calculateElapsedSeconds,
    calculateFare,
    calculateSegmentedFare,
    calculateSuggestedTip,
    clampNumber,
    isNightTime,
    normalizeRate
} from './domain.js';
import {
    ensureAudioActive,
    playClackSound,
    playClickSound,
    playMeterTickSound,
    playPrintSound,
    playTearSound,
    releaseWakeLock,
    requestWakeLock,
    triggerHaptic
} from './device.js';

// 收款码只需要小图；限制 512KB 可以避开 localStorage 配额爆炸和手机内存浪费。
const MAX_QR_IMAGE_BYTES = 512 * 1024;
const MAX_QR_SOURCE_BYTES = 5 * 1024 * 1024;

// LocalStorage 专用键名集中管理
const STORAGE_CONFIG_KEY = 'retro_taxi_meter_config_v1';
const STORAGE_QR_KEY = 'retro_taxi_meter_qr_v1';

// 用户配置
const config = {
    rate: { ...DEFAULT_RATE },
    qrImage: null
};

// 状态管理
const state = {
    isRunning: false,     // 行程是否运行中
    startTime: 0,         // 开始时间戳
    elapsedTime: 0,       // 累计时间 (秒)
    distance: 0,          // 总体有效里程 (km)
    dayKm: 0,             // 白天段累计有效里程 (km)
    nightKm: 0,           // 夜间段累计有效里程 (km)
    startIsNight: false,  // 起步时刻是否为夜间
    currentFare: 0,       // 当前计价费 (元)
    previousFare: 0,      // 上一次计价车费，用于监控跳表
    tollFee: 0,           // 路桥费
    otherFee: 0,          // 停车费/其他
    tipFee: 0,            // 小费
    selectedTipPercent: 0.20, // 选中的小费比例
    lastLocationSample: null, // 上一个有效 GPS 样本
    watchId: null,        // Geolocation 监听器 ID
    timerId: null,        // 计时器 ID
    isNight: false,       // 当前是否处于夜间时段
    nextAction: 'receipt', // 'receipt' 或 'bankruptcy'
    pressAnimId: null,    // 长按动画帧 ID
    pressStartTime: 0,    // 长按开始时间戳
    cropState: {
        image: null,
        scale: 1,
        panX: 0,
        panY: 0,
        isDragging: false,
        startX: 0,
        startY: 0
    }
};

// ================= 初始化与核心设置 =================

function init() {
    bindEvents();             // 页面事件统一绑定
    document.title = `TAXI METER v${APP_VERSION}`;
    registerServiceWorker(); // 注册 PWA 离线脚本
    loadSettings();          // 读取缓存的费率和收款码
    initTheme();             // 初始化昼夜主题
    updateNightStatus();     // 检测并更新夜间状态
    updateDisplay();         // 刷新数字显示
    console.info(`[App] Retro Taxi Meter v${APP_VERSION} 初始化完成`);
}

function bindEvents() {
    // 点击类事件
    const clickBindings = [
        ['theme-toggle-btn', toggleTheme],
        ['settings-open-btn', toggleSettings],
        ['settings-close-btn', toggleSettings],
        ['start-trip-btn', startTrip],
        ['next-step-btn', handlePrimaryAction],
        ['settings-save-btn', saveSettings],
        ['settings-reset-btn', resetSettingsToDefault],
        ['show-custom-tip-btn', showCustomTip],
        ['loan-submit-btn', submitLoanPayment],
        ['btn-tear-fallback', triggerTearReceipt],
        ['crop-cancel-btn', closeCropModal],
        ['crop-confirm-btn', confirmCropImage]
    ];

    clickBindings.forEach(([id, listener]) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', listener);
    });

    // 长按结束按钮防误触绑定
    const stopBtn = document.getElementById('stop-trip-btn');
    if (stopBtn) {
        stopBtn.addEventListener('pointerdown', handleStopPointerDown);
        stopBtn.addEventListener('pointerup', handleStopPointerUp);
        stopBtn.addEventListener('pointerleave', handleStopPointerUp);
        stopBtn.addEventListener('pointercancel', handleStopPointerUp);
        stopBtn.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    // 收款码文件选择与裁剪缩放
    document.getElementById('qr-upload').addEventListener('change', (event) => {
        handleQRFileSelect(event.currentTarget);
    });
    document.getElementById('crop-zoom').addEventListener('input', (event) => {
        state.cropState.scale = Number.parseFloat(event.target.value) || 1;
        drawCropCanvas();
    });

    // 绑定裁剪框手势拖拽平移事件
    bindCropPanEvents();

    // 小票内附加费和自定义小费实时同步
    document.getElementById('toll-fee').addEventListener('input', handleFeeInputChange);
    document.getElementById('other-fee').addEventListener('input', handleFeeInputChange);
    document.getElementById('custom-tip').addEventListener('input', handleCustomTipInput);

    // 小费比例按钮组
    document.querySelectorAll('[data-tip-percent]').forEach((button) => {
        button.addEventListener('click', () => selectTip(Number(button.dataset.tipPercent)));
    });

    // 重置重开下一单按钮
    document.querySelectorAll('[data-reset-app]').forEach((button) => {
        button.addEventListener('click', resetApp);
    });

    // 撕纸滑块手势绑定
    bindTearSlider();

    // 任何用户触摸时唤醒 iOS Web Audio
    window.addEventListener('pointerdown', ensureAudioActive, { once: false, passive: true });
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

// 保存费率配置
function saveRateConfig(rate) {
    try {
        localStorage.setItem(STORAGE_CONFIG_KEY, JSON.stringify({ rate }));
        return true;
    } catch (e) {
        console.warn('保存费率配置失败:', e);
        alert('费率保存失败：浏览器本地存储不可用或空间不足');
        return false;
    }
}

function persistNormalizedRateSilently() {
    try {
        localStorage.setItem(STORAGE_CONFIG_KEY, JSON.stringify({ rate: config.rate }));
    } catch (e) {
        console.warn('精简费率配置写回失败:', e);
    }
}

function readStorageItem(key) {
    try {
        return localStorage.getItem(key);
    } catch (e) {
        console.warn('读取本地缓存失败:', e);
        return null;
    }
}

// 渲染收款码
function renderQRImage(dataUrl) {
    config.qrImage = dataUrl;

    const preview = document.getElementById('qr-preview');
    preview.replaceChildren();

    const img = document.createElement('img');
    img.src = dataUrl;
    img.alt = '收款码预览';
    preview.appendChild(img);

    const payImg = document.getElementById('pay-qr-img');
    if (payImg) {
        payImg.src = dataUrl;
        payImg.style.display = 'block';
    }
    const defaultQrText = document.getElementById('default-qr-text');
    if (defaultQrText) defaultQrText.style.display = 'none';
}

function getDataUrlByteSize(dataUrl) {
    const base64 = dataUrl.split(',')[1] || '';
    return Math.ceil(base64.length * 3 / 4);
}

function isAllowedQRImageType(type) {
    return ['image/png', 'image/jpeg', 'image/webp'].includes(type);
}

function isAllowedQRDataUrl(dataUrl) {
    const match = typeof dataUrl === 'string' && dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,/);
    return Boolean(match) && getDataUrlByteSize(dataUrl) <= MAX_QR_IMAGE_BYTES;
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
    migrateLegacyStorage();

    const savedConfig = readStorageItem(STORAGE_CONFIG_KEY);
    if (savedConfig) {
        try {
            const parsed = JSON.parse(savedConfig);
            config.rate = normalizeRate(parsed && (parsed.rate || parsed));
            persistNormalizedRateSilently();
        } catch (e) {
            console.warn('读取配置解析失败，恢复默认配置:', e);
            config.rate = { ...DEFAULT_RATE };
            persistNormalizedRateSilently();
        }
    }
    
    document.getElementById('base-fare').value = config.rate.base;
    document.getElementById('base-dist').value = config.rate.baseKm;
    document.getElementById('per-km').value = config.rate.perKm;
    document.getElementById('empty-dist').value = config.rate.emptyKm;
    document.getElementById('empty-fee').value = config.rate.emptyRate;

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

function updateRateInfoDisplay(rate) {
    const nightText = state.isNight ? ` [夜间×${NIGHT_MULTIPLIER}]` : '';
    document.getElementById('rate-info').textContent = `费率 (${rate.base}元/${rate.baseKm}km)${nightText}`;
}

function toggleSettings() {
    playClickSound();
    triggerHaptic(15);
    const panel = document.getElementById('settings-panel');
    panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
}

function saveSettings() {
    playClickSound();
    triggerHaptic(20);

    const nextRate = normalizeRate({
        base: document.getElementById('base-fare').value,
        baseKm: document.getElementById('base-dist').value,
        perKm: document.getElementById('per-km').value,
        emptyKm: document.getElementById('empty-dist').value,
        emptyRate: document.getElementById('empty-fee').value
    });

    if (!saveRateConfig(nextRate)) return;
    config.rate = nextRate;
    document.getElementById('base-fare').value = config.rate.base;
    document.getElementById('base-dist').value = config.rate.baseKm;
    document.getElementById('per-km').value = config.rate.perKm;
    document.getElementById('empty-dist').value = config.rate.emptyKm;
    document.getElementById('empty-fee').value = config.rate.emptyRate;

    updateNightStatus();
    if (state.isRunning) {
        recalcFare();
        updateDisplay();
    }
    toggleSettings();
    alert('费率设置已保存');
}

// 恢复官方默认费率 (上海标准)
function resetSettingsToDefault() {
    playClickSound();
    triggerHaptic(20);

    if (!confirm('确定要恢复官方默认费率吗？\n（上海标准：起步 16 元 / 3km，续租 2.7 元/km，返空 15km / 1.5倍）')) {
        return;
    }

    config.rate = { ...DEFAULT_RATE };
    saveRateConfig(config.rate);

    document.getElementById('base-fare').value = config.rate.base;
    document.getElementById('base-dist').value = config.rate.baseKm;
    document.getElementById('per-km').value = config.rate.perKm;
    document.getElementById('empty-dist').value = config.rate.emptyKm;
    document.getElementById('empty-fee').value = config.rate.emptyRate;

    updateNightStatus();
    if (state.isRunning) {
        recalcFare();
        updateDisplay();
    }
    alert('已成功恢复官方默认费率配置！');
}

// ================= ✂️ 收款码正方形裁剪器 (支持任意拖拽平移与缩放) =================

function handleQRFileSelect(input) {
    const file = input.files && input.files[0];
    if (!file) return;

    if (!isAllowedQRImageType(file.type)) {
        input.value = '';
        alert('收款码仅支持 PNG、JPG 或 WebP 图片');
        return;
    }

    if (file.size > MAX_QR_SOURCE_BYTES) {
        input.value = '';
        alert('收款码源文件不能超过 5MB');
        return;
    }

    const reader = new FileReader();
    reader.onerror = () => alert('读取图片失败');
    reader.onload = () => {
        const img = new Image();
        img.onerror = () => alert('解析图片失败');
        img.onload = () => {
            state.cropState.image = img;
            state.cropState.scale = 1;
            state.cropState.panX = 0;
            state.cropState.panY = 0;
            document.getElementById('crop-zoom').value = '1';
            openCropModal();
        };
        img.src = reader.result;
    };
    reader.readAsDataURL(file);
}

function openCropModal() {
    const modal = document.getElementById('qr-crop-modal');
    modal.style.display = 'flex';
    drawCropCanvas();
}

function closeCropModal() {
    const modal = document.getElementById('qr-crop-modal');
    modal.style.display = 'none';
    document.getElementById('qr-upload').value = '';
}

// 绑定裁剪框内手指/鼠标拖拽平移手势
function bindCropPanEvents() {
    const viewport = document.getElementById('crop-viewport-box');
    if (!viewport) return;

    viewport.addEventListener('pointerdown', (e) => {
        if (!state.cropState.image) return;
        state.cropState.isDragging = true;
        state.cropState.startX = e.clientX - state.cropState.panX;
        state.cropState.startY = e.clientY - state.cropState.panY;
        viewport.setPointerCapture?.(e.pointerId);
    });

    window.addEventListener('pointermove', (e) => {
        if (!state.cropState.isDragging) return;
        state.cropState.panX = e.clientX - state.cropState.startX;
        state.cropState.panY = e.clientY - state.cropState.startY;
        drawCropCanvas();
    });

    const onPointerUp = () => {
        state.cropState.isDragging = false;
    };

    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
}

function drawCropCanvas() {
    const canvas = document.getElementById('crop-canvas');
    const img = state.cropState.image;
    if (!canvas || !img) return;

    const ctx = canvas.getContext('2d');
    const size = 240;
    canvas.width = size;
    canvas.height = size;

    ctx.fillStyle = '#0a0a0c';
    ctx.fillRect(0, 0, size, size);

    const minSide = Math.min(img.width, img.height);
    const scale = state.cropState.scale;
    const drawW = (img.width / minSide) * size * scale;
    const drawH = (img.height / minSide) * size * scale;
    const destX = (size - drawW) / 2 + state.cropState.panX;
    const destY = (size - drawH) / 2 + state.cropState.panY;

    ctx.drawImage(img, destX, destY, drawW, drawH);

    // 绘制 3x3 辅助九宫格线
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(80, 0); ctx.lineTo(80, size);
    ctx.moveTo(160, 0); ctx.lineTo(160, size);
    ctx.moveTo(0, 80); ctx.lineTo(size, 80);
    ctx.moveTo(0, 160); ctx.lineTo(size, 160);
    ctx.stroke();

    // 绘制正方形取景边框
    ctx.strokeStyle = '#0A84FF';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, size - 2, size - 2);
}

function confirmCropImage() {
    const img = state.cropState.image;
    if (!img) return;

    const exportCanvas = document.createElement('canvas');
    const exportSize = 512;
    exportCanvas.width = exportSize;
    exportCanvas.height = exportSize;
    const ctx = exportCanvas.getContext('2d');

    const size = 240;
    const minSide = Math.min(img.width, img.height);
    const scale = state.cropState.scale;
    const drawW = (img.width / minSide) * size * scale;
    const drawH = (img.height / minSide) * size * scale;
    const destX = (size - drawW) / 2 + state.cropState.panX;
    const destY = (size - drawH) / 2 + state.cropState.panY;

    const ratio = exportSize / size;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, exportSize, exportSize);
    ctx.drawImage(img, destX * ratio, destY * ratio, drawW * ratio, drawH * ratio);

    const dataUrl = exportCanvas.toDataURL('image/jpeg', 0.92);
    try {
        localStorage.setItem(STORAGE_QR_KEY, dataUrl);
        renderQRImage(dataUrl);
        closeCropModal();
        alert('收款码裁剪完成并已保存！');
    } catch (e) {
        console.warn('保存收款码失败:', e);
        alert('保存收款码失败：浏览器本地存储空间不足');
    }
}

// 页面切回前台时，若计价器仍在跑，则重新请求常亮锁并激活音频
document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible') {
        ensureAudioActive();
        if (state.isRunning) {
            await requestWakeLock();
        }
    }
});

// ================= 🌙 昼夜模式与时间检测 =================

function updateNightStatus() {
    const isNight = isNightTime();
    const indicator = document.getElementById('night-indicator');
    const changed = state.isNight !== isNight;
    
    if (isNight) {
        indicator.classList.add('active');
        state.isNight = true;
    } else {
        indicator.classList.remove('active');
        state.isNight = false;
    }
    
    updateRateInfoDisplay(config.rate);
    return changed;
}

// ================= ☀️/🌙 昼夜视觉主题切换 =================

function initTheme() {
    const isNight = isNightTime();
    setTheme(isNight ? 'night' : 'day');
}

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

function toggleTheme() {
    playClickSound();
    triggerHaptic(15);
    const isDay = document.body.classList.contains('day-theme');
    setTheme(isDay ? 'night' : 'day');
}

// ================= 🚖 核心计费与 GPS 定位 =================

function startTrip() {
    if (state.isRunning) return;
    if (!navigator.geolocation) { alert('您的浏览器不支持 GPS 定位'); return; }

    ensureAudioActive();
    playClackSound();
    triggerHaptic(30);

    state.isRunning = true;
    state.startTime = Date.now();
    state.distance = 0;
    state.dayKm = 0;
    state.nightKm = 0;
    state.elapsedTime = 0;
    state.nextAction = 'receipt';
    
    updateNightStatus();
    state.startIsNight = state.isNight;
    state.currentFare = calculateFare(config.rate, 0, state.startIsNight);
    state.previousFare = state.currentFare;
    state.lastLocationSample = null;

    document.getElementById('empty-sign').classList.add('flipped'); 
    document.getElementById('start-trip-btn').disabled = true;
    document.getElementById('stop-trip-btn').disabled = false;
    document.getElementById('gps-status').textContent = '🛰️ 正在搜星...';
    document.getElementById('gps-status').style.color = '#ffcc00';

    state.timerId = setInterval(() => {
        state.elapsedTime = calculateElapsedSeconds(state.startTime);
        if (updateNightStatus()) {
            recalcFare();
        }
        updateDisplay();
    }, 1000);

    const options = { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 };
    try {
        state.watchId = navigator.geolocation.watchPosition(onLocationUpdate, onLocationError, options);
    } catch (error) {
        abortTripStart(error);
        return;
    }

    requestWakeLock();
}

function abortTripStart(error) {
    if (state.timerId !== null) {
        clearInterval(state.timerId);
        state.timerId = null;
    }

    state.isRunning = false;
    state.lastLocationSample = null;
    releaseWakeLock();
    document.getElementById('empty-sign').classList.remove('flipped');
    document.getElementById('start-trip-btn').disabled = false;
    document.getElementById('stop-trip-btn').disabled = true;
    document.getElementById('gps-status').textContent = '🛑 GPS 不可用';
    document.getElementById('gps-status').style.color = '#ff3b30';
    console.warn('GPS 监听启动失败:', error);
    alert('GPS 定位启动失败，请检查浏览器定位权限');
}

// ================= 🛡️ 长按 1.5 秒结束行程逻辑 (防车载颠簸误触) =================

function handleStopPointerDown(e) {
    if (!state.isRunning) return;

    state.pressStartTime = Date.now();
    const progressEl = document.getElementById('stop-btn-progress');
    const stopBtn = document.getElementById('stop-trip-btn');
    stopBtn.classList.add('pressing');

    const updateProgress = () => {
        if (!state.pressStartTime) return;
        const elapsed = Date.now() - state.pressStartTime;
        const progress = Math.min(100, (elapsed / 1500) * 100);
        progressEl.style.width = `${progress}%`;

        if (elapsed >= 1500) {
            // 长按达到 1.5 秒，正式结束行程
            state.pressStartTime = 0;
            progressEl.style.width = '0%';
            stopBtn.classList.remove('pressing');
            stopTrip();
            return;
        }

        state.pressAnimId = requestAnimationFrame(updateProgress);
    };

    state.pressAnimId = requestAnimationFrame(updateProgress);
}

function handleStopPointerUp() {
    if (state.pressAnimId) {
        cancelAnimationFrame(state.pressAnimId);
        state.pressAnimId = null;
    }
    state.pressStartTime = 0;
    const progressEl = document.getElementById('stop-btn-progress');
    if (progressEl) progressEl.style.width = '0%';
    const stopBtn = document.getElementById('stop-trip-btn');
    if (stopBtn) stopBtn.classList.remove('pressing');
}

// 结束行程并打印小票
function stopTrip() {
    if (!state.isRunning) return;

    state.elapsedTime = calculateElapsedSeconds(state.startTime);
    state.isRunning = false;
    if (state.timerId) {
        clearInterval(state.timerId);
        state.timerId = null;
    }
    if (state.watchId !== null) {
        navigator.geolocation.clearWatch(state.watchId);
        state.watchId = null;
    }

    releaseWakeLock();
    document.getElementById('stop-trip-btn').disabled = true;
    document.getElementById('gps-status').textContent = '🛑 GPS 已停运';
    document.getElementById('gps-status').style.color = '#888';

    // 检查网贷渡劫彩蛋
    if (state.currentFare >= MAX_FARE) {
        state.nextAction = 'bankruptcy';
        triggerBankruptcy();
        return;
    }

    // 播放打印机出纸机械音并展示小票
    playPrintSound();
    triggerHaptic(25);
    state.nextAction = 'receipt';
    showReceiptScreen();
}

function handlePrimaryAction() {
    if (state.nextAction === 'bankruptcy') {
        triggerBankruptcy();
        return;
    }
    showReceiptScreen();
}

// GPS 位置更新处理：分段累加里程并监控跳表
function onLocationUpdate(position) {
    if (!state.isRunning) return;

    const coords = position && position.coords ? position.coords : {};
    const sample = {
        latitude: coords.latitude,
        longitude: coords.longitude,
        accuracy: coords.accuracy,
        timestamp: position && position.timestamp ? position.timestamp : Date.now(),
        speedMps: coords.speed
    };
    const decision = analyzeLocationSample(state.lastLocationSample, sample);
    const accuracyText = Number.isFinite(sample.accuracy) ? Math.round(sample.accuracy) : '?';

    if (decision.status === GPS_SAMPLE_STATUS.WEAK) {
        document.getElementById('gps-status').textContent = `⚠️ 信号较弱 (±${accuracyText}m)`;
        document.getElementById('gps-status').style.color = 'orange';
        return;
    }

    if (decision.shouldUpdateAnchor) {
        state.lastLocationSample = sample;
    }

    if (decision.status === GPS_SAMPLE_STATUS.STALE) {
        document.getElementById('gps-status').textContent = '⚠️ 采样延迟';
        document.getElementById('gps-status').style.color = 'orange';
        return;
    }

    if (decision.status === GPS_SAMPLE_STATUS.JUMP) {
        document.getElementById('gps-status').textContent = '⚠️ 穿桥跳点已过滤';
        document.getElementById('gps-status').style.color = 'orange';
        return;
    }

    document.getElementById('gps-status').textContent = `🛰️ 卫星已连接 (±${accuracyText}m)`;
    document.getElementById('gps-status').style.color = '#34c759';

    if (decision.status !== GPS_SAMPLE_STATUS.MOVING) {
        return;
    }

    // 严密分段累加：按当前是否夜间将位移归入对应区间，彻底杜绝历史追溯
    const isNowNight = isNightTime();
    if (isNowNight) {
        state.nightKm += decision.distanceKm;
    } else {
        state.dayKm += decision.distanceKm;
    }
    state.distance = Math.min(state.dayKm + state.nightKm, MAX_NUMERIC_INPUT);

    updateNightStatus();
    recalcFare(); // 重新核算分段车费
    updateDisplay(); // 刷新 LED 数码管
}

function onLocationError(err) {
    if (!state.isRunning) return;
    document.getElementById('gps-status').textContent = `GPS 异常: ${err.message}`;
    document.getElementById('gps-status').style.color = 'red';
}

// 核心分段计费核算
function recalcFare() {
    config.rate = normalizeRate(config.rate);
    const newFare = calculateSegmentedFare({
        rawRate: config.rate,
        dayDistance: state.dayKm,
        nightDistance: state.nightKm,
        startIsNight: state.startIsNight
    });

    // ⏰【跳表压迫感】只要金额上涨，精准触发一声机械嘟与微震
    if (state.isRunning && newFare > state.previousFare) {
        playMeterTickSound();
        triggerHaptic(12);
        state.previousFare = newFare;
    }

    state.currentFare = newFare;
}

// 更新 LED 屏幕渲染数值
function updateDisplay() {
    const priceStr = state.currentFare.toFixed(2);
    const priceDisplayNode = document.getElementById('display-price');
    priceDisplayNode.textContent = priceStr;
    
    const mainRow = priceDisplayNode.parentElement.parentElement;
    let targetClass = '';
    if (priceStr.length > 8) {
        targetClass = 'super-long-value';
    } else if (priceStr.length > 6) {
        targetClass = 'long-value';
    }

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

// ================= 🧾 一体化复古热敏小票结算页面 =================

function showReceiptScreen() {
    document.getElementById('meter-screen').style.display = 'none';
    document.getElementById('meter-screen').classList.remove('active-screen');
    document.getElementById('bankruptcy-screen').style.display = 'none';
    
    const receiptScreen = document.getElementById('receipt-screen');
    receiptScreen.style.display = 'flex';

    // 格式化发票元数据
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${(now.getMonth()+1).toString().padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')} ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
    const mins = Math.floor(state.elapsedTime / 60);
    const secs = state.elapsedTime % 60;

    document.getElementById('rec-date').textContent = dateStr;
    document.getElementById('rec-time').textContent = `${mins}分${secs}秒`;
    document.getElementById('rec-dist').textContent = `${state.distance.toFixed(1)} km`;
    document.getElementById('rec-rate').textContent = `${config.rate.base}元/${config.rate.baseKm}km`;
    document.getElementById('rec-meter-fare').textContent = state.currentFare.toFixed(2);

    // 默认选中 20% 鸡腿小费
    state.tollFee = clampNumber(document.getElementById('toll-fee').value, 0);
    state.otherFee = clampNumber(document.getElementById('other-fee').value, 0);
    updateReceiptTipGrid();
    selectTip(0.20);
    updateReceiptTotal();
}

function handleFeeInputChange() {
    state.tollFee = clampNumber(document.getElementById('toll-fee').value, 0);
    state.otherFee = clampNumber(document.getElementById('other-fee').value, 0);
    updateReceiptTipGrid();
    if (state.selectedTipPercent !== null) {
        selectTip(state.selectedTipPercent);
    } else {
        handleCustomTipInput();
    }
}

function updateReceiptTipGrid() {
    [0.15, 0.20, 0.25].forEach((percent) => {
        const tip = calculateSuggestedTip(
            state.currentFare,
            state.tollFee,
            state.otherFee,
            percent
        );
        const valueNode = document.querySelector(`[data-tip-value="${percent}"]`);
        if (valueNode) valueNode.textContent = `¥${tip.toFixed(1)}`;
    });
}

function selectTip(percent) {
    playClickSound();
    triggerHaptic(15);
    state.selectedTipPercent = percent;

    document.getElementById('custom-tip-container').style.display = 'none';
    document.getElementById('custom-tip').value = '';

    document.querySelectorAll('.btn-pos-tip').forEach((button) => {
        button.classList.toggle('selected', Number(button.dataset.tipPercent) === percent);
    });

    state.tipFee = calculateSuggestedTip(
        state.currentFare,
        state.tollFee,
        state.otherFee,
        percent
    );
    updateReceiptTotal();
}

function showCustomTip() {
    playClickSound();
    triggerHaptic(15);
    state.selectedTipPercent = null;

    document.querySelectorAll('.btn-pos-tip').forEach(b => b.classList.remove('selected'));
    document.getElementById('custom-tip-container').style.display = 'block';
    setTimeout(() => document.getElementById('custom-tip').focus(), 100);
    state.tipFee = 0;
    updateReceiptTotal();
}

function handleCustomTipInput() {
    state.tipFee = clampNumber(document.getElementById('custom-tip').value, 0);
    updateReceiptTotal();
}

function updateReceiptTotal() {
    const bill = calculateBill({
        meterFare: state.currentFare,
        tollFee: state.tollFee,
        otherFee: state.otherFee,
        tipFee: state.tipFee
    });
    document.getElementById('final-total').textContent = bill.total.toFixed(2);
}

// ================= 👉 向右滑动撕纸手势交互 =================

function bindTearSlider() {
    const track = document.getElementById('tear-slider-track');
    const thumb = document.getElementById('tear-slider-thumb');
    if (!track || !thumb) return;

    let isDragging = false;
    let startX = 0;
    let currentX = 0;

    const onPointerDown = (e) => {
        isDragging = true;
        startX = e.clientX || (e.touches && e.touches[0].clientX) || 0;
        thumb.setPointerCapture?.(e.pointerId);
    };

    const onPointerMove = (e) => {
        if (!isDragging) return;
        const clientX = e.clientX || (e.touches && e.touches[0].clientX) || 0;
        const maxDrag = track.clientWidth - thumb.clientWidth - 6;
        currentX = Math.max(0, Math.min(maxDrag, clientX - startX));
        thumb.style.transform = `translateX(${currentX}px)`;

        // 超过 75% 阈值立即触发撕纸
        if (currentX >= maxDrag * 0.75) {
            isDragging = false;
            triggerTearReceipt();
        }
    };

    const onPointerUp = () => {
        if (!isDragging) return;
        isDragging = false;
        thumb.style.transition = 'transform 0.2s ease';
        thumb.style.transform = 'translateX(0px)';
        setTimeout(() => { thumb.style.transition = 'transform 0.08s ease'; }, 200);
    };

    thumb.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
}

// 触发撕纸动画并复位下一单
function triggerTearReceipt() {
    playTearSound();
    triggerHaptic(35);

    const paper = document.getElementById('receipt-paper');
    if (paper) {
        paper.style.transition = 'transform 0.35s cubic-bezier(0.4, 0, 1, 1), opacity 0.35s ease';
        paper.style.transform = 'translateX(130%) rotate(12deg)';
        paper.style.opacity = '0';
    }

    setTimeout(() => {
        if (paper) {
            paper.style.transition = '';
            paper.style.transform = '';
            paper.style.opacity = '';
        }
        resetApp();
    }, 350);
}

// ================= ⚡ 触发一键渡劫网贷彩蛋页面 =================

function triggerBankruptcy() {
    playClackSound();
    triggerHaptic(50);

    document.getElementById('bankrupt-total').textContent = MAX_FARE.toFixed(2);
    document.getElementById('meter-screen').style.display = 'none';
    document.getElementById('meter-screen').classList.remove('active-screen');
    document.getElementById('receipt-screen').style.display = 'none';
    document.getElementById('bankruptcy-screen').style.display = 'flex';
}

function submitLoanPayment() {
    playClackSound();
    triggerHaptic(40);

    alert("⚡ 借款申请成功！\n\n已成功从您的【打车借呗·一键渡劫贷】专属账户划扣 ¥999,999.00 并足额付清车资！\n\n💡 贴心提示：请于 5 秒内结清还款以享受首期免息特权！超时将自动转入全家九族工地无偿搬砖信用抵债流程 👷‍♂️🧱！不留遗憾！");

    // 划扣后展示盖有 PAID 印章的小票
    document.getElementById('bankruptcy-screen').style.display = 'none';
    document.getElementById('receipt-screen').style.display = 'flex';

    document.getElementById('rec-meter-fare').textContent = MAX_FARE.toFixed(2);
    document.getElementById('final-total').textContent = MAX_FARE.toFixed(2);
    document.getElementById('pay-qr-area').style.display = 'none';
    document.getElementById('paid-stamp-area').style.display = 'flex';
}

// ================= 🔄 重置与重开下一单 =================

function resetApp() {
    playClickSound();
    triggerHaptic(30);

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
    state.startTime = 0;
    state.distance = 0;
    state.dayKm = 0;
    state.nightKm = 0;
    state.elapsedTime = 0;
    state.tollFee = 0;
    state.otherFee = 0;
    state.tipFee = 0;
    state.nextAction = 'receipt';
    state.lastLocationSample = null;
    
    updateNightStatus();
    state.currentFare = calculateFare(config.rate, 0, state.isNight);
    state.previousFare = state.currentFare;
    
    // 恢复主计价器界面
    document.getElementById('meter-screen').style.display = 'flex';
    document.getElementById('meter-screen').classList.add('active-screen');
    document.getElementById('receipt-screen').style.display = 'none';
    document.getElementById('bankruptcy-screen').style.display = 'none';
    document.getElementById('paid-stamp-area').style.display = 'none';
    document.getElementById('pay-qr-area').style.display = 'block';

    document.getElementById('empty-sign').classList.remove('flipped');
    document.getElementById('start-trip-btn').disabled = false;
    document.getElementById('stop-trip-btn').disabled = true;
    document.getElementById('gps-status').textContent = '🛰️ GPS 待命';
    document.getElementById('gps-status').style.color = '#888';

    const payBtn = document.getElementById('next-step-btn');
    if (payBtn) {
        payBtn.style.display = 'none';
        payBtn.textContent = '查看小票';
        payBtn.classList.remove('btn-bankrupt-alert');
    }

    updateDisplay();

    document.getElementById('toll-fee').value = '';
    document.getElementById('other-fee').value = '';
    document.getElementById('custom-tip').value = '';
    const thumb = document.getElementById('tear-slider-thumb');
    if (thumb) thumb.style.transform = 'translateX(0px)';
}

// 执行初始化
init();
