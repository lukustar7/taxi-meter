// 用户配置 (默认上海运价作为初始出厂参数)
let config = {
    rate: { base: 16, baseKm: 3, perKm: 2.7, emptyKm: 15, emptyRate: 1.5 },
    qrImage: null
};

// 状态管理
let state = {
    isRunning: false,     // 行程是否运行中
    startTime: 0,         // 开始时间戳
    elapsedTime: 0,       // 累计时间 (秒)
    distance: 0,          // 累计里程 (km)
    currentFare: 0,       // 当前计价费 (元)
    tollFee: 0,           // 路桥费
    otherFee: 0,          // 停车费/其他
    tipFee: 0,            // 小费
    lastPos: null,        // 上一次 GPS 位置
    lastTimestamp: 0,     // 上一次 GPS 定位的时间戳
    watchId: null,        // Geolocation 监听器 ID
    timerId: null,        // 计时器 ID
    isNight: false        // 当前是否处于夜间加费阶段
};

// 终极车资最大限制 (防爆屏封顶：99.9万)
const MAX_FARE = 999999.00;

// 夜间费率配置 (23:00 - 次日 05:00 自动加收 30% 费率)
const NIGHT_MULTIPLIER = 1.3;

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

// 恢复缓存的运价和收款码
function loadSettings() {
    const savedConfig = localStorage.getItem('taxi_config');
    if (savedConfig) {
        try {
            const parsed = JSON.parse(savedConfig);
            // 兼容性兜底：如果缓存的是老版本没有 rate 属性的配置，则使用出厂上海默认值
            if (parsed && parsed.rate) {
                config.rate = parsed.rate;
            } else {
                config.rate = { base: 16, baseKm: 3, perKm: 2.7, emptyKm: 15, emptyRate: 1.5 };
            }
        } catch (e) {
            console.warn('读取配置解析失败，恢复默认配置:', e);
        }
    }
    
    // 扁平回填设置表单
    document.getElementById('base-fare').value = config.rate.base;
    document.getElementById('base-dist').value = config.rate.baseKm;
    document.getElementById('per-km').value = config.rate.perKm;
    document.getElementById('empty-dist').value = config.rate.emptyKm;
    document.getElementById('empty-fee').value = config.rate.emptyRate;

    // 二维码恢复
    const savedQR = localStorage.getItem('taxi_qr');
    if (savedQR) {
        config.qrImage = savedQR;
        document.getElementById('pay-qr-img').src = savedQR;
        document.getElementById('pay-qr-img').style.display = 'block';
        document.getElementById('default-qr-text').style.display = 'none';
        
        const preview = document.getElementById('qr-preview');
        preview.innerHTML = `<img src="${savedQR}" style="width:100px;">`;
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

    config.rate = {
        base: parseFloat(document.getElementById('base-fare').value) || 0,
        baseKm: parseFloat(document.getElementById('base-dist').value) || 0,
        perKm: parseFloat(document.getElementById('per-km').value) || 0,
        emptyKm: parseFloat(document.getElementById('empty-dist').value) || 0,
        emptyRate: parseFloat(document.getElementById('empty-fee').value) || 1.0
    };

    localStorage.setItem('taxi_config', JSON.stringify(config));
    updateNightStatus(); // 重新核对夜间指示并刷新运价展示
    toggleSettings();
    alert('费率设置已保存');
}

// 二维码图片上传本地缓存化
function handleQRUpload(input) {
    if (input.files && input.files[0]) {
        const reader = new FileReader();
        reader.onload = function(e) {
            const base64 = e.target.result;
            localStorage.setItem('taxi_qr', base64);
            config.qrImage = base64;
            
            document.getElementById('qr-preview').innerHTML = `<img src="${base64}" style="width:100px;">`;
            document.getElementById('pay-qr-img').src = base64;
            document.getElementById('pay-qr-img').style.display = 'block';
            document.getElementById('default-qr-text').style.display = 'none';
        }
        reader.readAsDataURL(input.files[0]);
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
    if ('wakeLock' in navigator) {
        try {
            wakeLock = await navigator.wakeLock.request('screen');
            console.log('[Wake Lock] 屏幕常亮锁已成功激活！');
            wakeLock.addEventListener('release', () => {
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
        });
    }
}

// 当页面切回前台时，若计价器仍在跑，则重新请求常亮锁
document.addEventListener('visibilitychange', async () => {
    if (wakeLock !== null && document.visibilityState === 'visible' && state.isRunning) {
        await requestWakeLock();
    }
});

// ================= 🌙 昼夜模式与时间检测 =================

// 检查是否属于夜间加成时间 (23:00 - 次日 05:00)
function isNightTime() {
    const hours = new Date().getHours();
    return hours >= 23 || hours < 5;
}

// 刷新夜间状态与 LED 指示灯
function updateNightStatus() {
    const isNight = isNightTime();
    const indicator = document.getElementById('night-indicator');
    
    if (isNight) {
        indicator.classList.add('active'); // 亮灯
        state.isNight = true;
    } else {
        indicator.classList.remove('active'); // 灭灯
        state.isNight = false;
    }
    
    updateRateInfoDisplay(config.rate);
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
    state.elapsedTime = 0;
    
    // 重新核对夜间费率
    updateNightStatus();
    const baseMultiplier = state.isNight ? NIGHT_MULTIPLIER : 1.0;
    state.currentFare = Math.min(config.rate.base * baseMultiplier, MAX_FARE); 
    state.lastPos = null;
    state.lastTimestamp = 0;

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
    clearInterval(state.timerId);
    navigator.geolocation.clearWatch(state.watchId);

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

// GPS 位置更新处理 (智能防漂移与蠕行计费过滤)
function onLocationUpdate(position) {
    const lat = position.coords.latitude;
    const lon = position.coords.longitude;
    const accuracy = position.coords.accuracy;
    const timestamp = position.timestamp || Date.now();
    const speed = position.coords.speed; // m/s, 系统原生测得的运动瞬时速度
    
    document.getElementById('gps-status').textContent = `GPS: OK (±${Math.round(accuracy)}m)`;
    document.getElementById('gps-status').style.color = '#34c759';

    // 首次定位，只初始化起点坐标和时间戳，不累计里程
    if (!state.lastPos) { 
        state.lastPos = { lat, lon }; 
        state.lastTimestamp = timestamp;
        return; 
    }

    // 计算两次定位之间的物理距离 (km)
    const dist = haversineDistance(state.lastPos.lat, state.lastPos.lon, lat, lon);
    // 计算与上一次定位的时间差 (秒)
    const timeDiffSec = (timestamp - state.lastTimestamp) / 1000;

    let isMoving = false;

    // 【智能蠕行与防漂移核心判定】
    // 1. 如果系统原生的 GPS 瞬时速度明确大于 0.2 m/s (约 0.72 km/h)，判定为真实移动
    if (speed !== null && speed !== undefined && speed > 0.2) {
        isMoving = true;
    } 
    // 2. 如果系统无法提供 speed，我们通过位移与时间差估算平均速度
    else if (dist > 0.003) { // 至少位移大于 3 米以排除极微小的传感器抖动
        const avgSpeedKmh = timeDiffSec > 0 ? (dist / (timeDiffSec / 3600)) : 0;
        
        // 如果均速在合理步行至车速区间 (0.6 km/h ~ 200 km/h) 且 GPS 精度较好，判定为有效行驶
        if (avgSpeedKmh > 0.6 && avgSpeedKmh < 200 && accuracy < 40) {
            isMoving = true;
        }
    }

    // 若判定为等红绿灯静止或信号杂无序漂移，直接拦截，不予计费
    if (!isMoving) return;

    // 确认移动，累计里程，更新上一次位置与时间戳
    state.distance += dist;
    state.lastPos = { lat, lon };
    state.lastTimestamp = timestamp;
    
    recalcFare(); // 重新核算阶梯费用
    updateDisplay(); // 刷新 LED 屏幕
}

// 定位失败错误提示
function onLocationError(err) {
    document.getElementById('gps-status').textContent = `GPS Error: ${err.message}`;
    document.getElementById('gps-status').style.color = 'red';
}

// 精密的阶梯价格算法 (支持白天/夜间差价 + 返空加价 + 99.9万硬封顶)
function recalcFare() {
    const rate = config.rate;
    const baseMultiplier = state.isNight ? NIGHT_MULTIPLIER : 1.0;
    
    let baseFare = rate.base * baseMultiplier;
    let perKmFare = rate.perKm * baseMultiplier;
    let fare = baseFare; 

    if (state.distance > rate.baseKm) {
        const extraDist = state.distance - rate.baseKm;
        const emptyThreshold = rate.emptyKm; 
        
        if (state.distance <= emptyThreshold) {
             fare += extraDist * perKmFare;
        } else {
             // 超过返空里程，部分算正常运价，溢出部分加收返空费率
             const normalExtra = emptyThreshold - rate.baseKm;
             fare += normalExtra * perKmFare;
             const emptyExtra = state.distance - emptyThreshold;
             fare += emptyExtra * (perKmFare * rate.emptyRate);
        }
    }
    
    // 【大数溢出防御第一关】强行封顶 999,999.00 元
    state.currentFare = Math.min(fare, MAX_FARE);
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
    mainRow.classList.remove('long-value', 'super-long-value');
    if (priceStr.length > 8) {       // 千位数以上，如 ¥100000.00
        mainRow.classList.add('super-long-value');
    } else if (priceStr.length > 6) { // 百位数以上，如 ¥1000.00
        mainRow.classList.add('long-value');
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
    state.tollFee = parseFloat(document.getElementById('toll-fee').value) || 0;
    state.otherFee = parseFloat(document.getElementById('other-fee').value) || 0;
    
    document.getElementById('extra-fee-screen').style.display = 'none';
    document.getElementById('tip-screen').style.display = 'flex';
    
    updateTipValues();
    selectTip(0.20); // 默认选中 20% 鸡腿小费 😈
}

// 刷新 POS 小费网格按钮的值
function updateTipValues() {
    const baseTotal = state.currentFare + state.tollFee + state.otherFee;
    
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
    
    const baseTotal = state.currentFare + state.tollFee + state.otherFee;
    state.tipFee = baseTotal * percent;
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
    state.tipFee = parseFloat(document.getElementById('custom-tip').value) || 0;
}

// 进入最终支付单详情页 (含有大数溢出防御限制)
function goToPay() {
    playClickSound();
    triggerHaptic(25);

    // 兜底再次核算自定义小费
    if (document.getElementById('custom-tip-container').style.display !== 'none') {
        state.tipFee = parseFloat(document.getElementById('custom-tip').value) || 0;
    }
    
    const total = state.currentFare + state.tollFee + state.otherFee + state.tipFee;
    
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

    state.isRunning = false;
    state.distance = 0;
    state.elapsedTime = 0;
    state.tollFee = 0;
    state.otherFee = 0;
    state.tipFee = 0;
    
    // 彻底清除上一单的 GPS 轨迹与时间戳，防起步信号瞬发跃变
    state.lastPos = null;
    state.lastTimestamp = 0;
    
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
