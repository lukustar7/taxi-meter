// 默认城市费率配置
const CITIES = {
    shanghai: { name: "上海", base: 16, baseKm: 3, perKm: 2.7, emptyKm: 15, emptyRate: 1.5 },
    guangzhou: { name: "广州", base: 12, baseKm: 3, perKm: 2.6, emptyKm: 25, emptyRate: 1.5 },
    nanjing: { name: "南京", base: 11, baseKm: 3, perKm: 2.5, emptyKm: 20, emptyRate: 1.5 }
};

let state = {
    isRunning: false,
    startTime: 0,
    elapsedTime: 0, 
    distance: 0, 
    currentFare: 0,
    tollFee: 0,
    otherFee: 0,
    tipFee: 0,
    lastPos: null,
    watchId: null,
    timerId: null
};

let config = {
    city: 'shanghai',
    customRate: null, 
    qrImage: null 
};

function init() {
    loadSettings();
    updateDisplay();
}

function loadSettings() {
    const savedConfig = localStorage.getItem('taxi_config');
    if (savedConfig) {
        config = JSON.parse(savedConfig);
        document.getElementById('city-select').value = config.city;
        if (config.city === 'custom') applyRateToInputs(config.customRate);
        else applyRateToInputs(CITIES[config.city]);
    } else {
        applyRateToInputs(CITIES.shanghai);
    }

    const savedQR = localStorage.getItem('taxi_qr');
    if (savedQR) {
        config.qrImage = savedQR;
        document.getElementById('pay-qr-img').src = savedQR;
        document.getElementById('pay-qr-img').style.display = 'block';
        document.getElementById('default-qr-text').style.display = 'none';
        
        const preview = document.getElementById('qr-preview');
        preview.innerHTML = `<img src="${savedQR}" style="width:100px;">`;
    }
}

function applyRateToInputs(rate) {
    if (!rate) return;
    document.getElementById('base-fare').value = rate.base;
    document.getElementById('base-dist').value = rate.baseKm;
    document.getElementById('per-km').value = rate.perKm;
    document.getElementById('empty-fee').value = rate.emptyRate;
    updateRateInfoDisplay(rate);
}

function updateRateInfoDisplay(rate) {
    const name = rate.name || (config.city === 'custom' ? '自定义' : CITIES[config.city].name);
    document.getElementById('rate-info').textContent = `${name} (${rate.base}元/${rate.baseKm}km)`;
}

function toggleSettings() {
    const panel = document.getElementById('settings-panel');
    panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
}

function loadCityRate() {
    const city = document.getElementById('city-select').value;
    if (city !== 'custom') applyRateToInputs(CITIES[city]);
}

function saveSettings() {
    const rate = {
        base: parseFloat(document.getElementById('base-fare').value),
        baseKm: parseFloat(document.getElementById('base-dist').value),
        perKm: parseFloat(document.getElementById('per-km').value),
        emptyRate: parseFloat(document.getElementById('empty-fee').value),
        name: '自定义'
    };

    config.city = document.getElementById('city-select').value;
    if (config.city === 'custom') config.customRate = rate;
    
    localStorage.setItem('taxi_config', JSON.stringify(config));
    updateRateInfoDisplay(rate);
    toggleSettings();
    alert('设置已保存');
}

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

// ================= 核心逻辑 =================

function startTrip() {
    if (state.isRunning) return;
    if (!navigator.geolocation) { alert('您的浏览器不支持 GPS 定位'); return; }

    state.isRunning = true;
    state.startTime = Date.now();
    state.distance = 0;
    state.elapsedTime = 0;
    state.currentFare = getCurrentRate().base; 
    state.lastPos = null;

    document.getElementById('empty-sign').classList.add('flipped'); 
    document.querySelector('.btn-start').disabled = true;
    document.querySelector('.btn-stop').disabled = false;
    document.getElementById('gps-status').textContent = 'GPS: Connecting...';
    document.getElementById('gps-status').style.color = 'yellow';

    state.timerId = setInterval(() => {
        state.elapsedTime++;
        updateDisplay();
    }, 1000);

    const options = { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 };
    state.watchId = navigator.geolocation.watchPosition(onLocationUpdate, onLocationError, options);
}

function stopTrip() {
    if (!state.isRunning) return;

    state.isRunning = false;
    clearInterval(state.timerId);
    navigator.geolocation.clearWatch(state.watchId);

    document.querySelector('.btn-stop').disabled = true;
    document.querySelector('.btn-next').style.display = 'inline-block'; 
    document.getElementById('gps-status').textContent = 'GPS: Stopped';
    document.getElementById('gps-status').style.color = '#666';
}

function onLocationUpdate(position) {
    const lat = position.coords.latitude;
    const lon = position.coords.longitude;
    const accuracy = position.coords.accuracy;
    
    document.getElementById('gps-status').textContent = `GPS: OK (±${Math.round(accuracy)}m)`;
    document.getElementById('gps-status').style.color = '#34c759';

    if (!state.lastPos) { state.lastPos = { lat, lon }; return; }

    const dist = haversineDistance(state.lastPos.lat, state.lastPos.lon, lat, lon);
    if (dist < 0.010) return; 

    state.distance += dist;
    state.lastPos = { lat, lon };
    
    recalcFare();
    updateDisplay();
}

function onLocationError(err) {
    document.getElementById('gps-status').textContent = `GPS Error: ${err.message}`;
    document.getElementById('gps-status').style.color = 'red';
}

function recalcFare() {
    const rate = getCurrentRate();
    let fare = rate.base; 

    if (state.distance > rate.baseKm) {
        const extraDist = state.distance - rate.baseKm;
        const emptyThreshold = rate.emptyKm || 15; 
        
        if (state.distance <= emptyThreshold) {
             fare += extraDist * rate.perKm;
        } else {
             const normalExtra = emptyThreshold - rate.baseKm;
             fare += normalExtra * rate.perKm;
             const emptyExtra = state.distance - emptyThreshold;
             const emptyRate = rate.emptyRate || 1.5;
             fare += emptyExtra * (rate.perKm * emptyRate);
        }
    }
    state.currentFare = fare;
}

function getCurrentRate() {
    if (config.city === 'custom') return config.customRate;
    return CITIES[config.city];
}

function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; 
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

function updateDisplay() {
    document.getElementById('display-price').textContent = state.currentFare.toFixed(2);
    document.getElementById('display-km').textContent = state.distance.toFixed(1);
    
    const mins = Math.floor(state.elapsedTime / 60);
    const secs = state.elapsedTime % 60;
    document.getElementById('display-time').textContent = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// ================= 页面流转 =================

function nextStep() {
    document.getElementById('meter-screen').classList.remove('active-screen');
    document.getElementById('meter-screen').style.display = 'none';
    document.getElementById('extra-fee-screen').style.display = 'flex';
}

function goToTip() {
    state.tollFee = parseFloat(document.getElementById('toll-fee').value) || 0;
    state.otherFee = parseFloat(document.getElementById('other-fee').value) || 0;
    
    document.getElementById('extra-fee-screen').style.display = 'none';
    document.getElementById('tip-screen').style.display = 'flex';
    
    updateTipValues();
    selectTip(0.20); // 默认选中 20%
}

function updateTipValues() {
    const baseTotal = state.currentFare + state.tollFee + state.otherFee;
    
    document.getElementById('val-15').textContent = '¥' + (baseTotal * 0.15).toFixed(1);
    document.getElementById('val-20').textContent = '¥' + (baseTotal * 0.20).toFixed(1);
    document.getElementById('val-25').textContent = '¥' + (baseTotal * 0.25).toFixed(1);
}

function selectTip(percent) {
    // 隐藏自定义
    document.getElementById('custom-tip-container').style.display = 'none';
    document.getElementById('custom-tip').value = '';
    
    // UI 选中态
    document.querySelectorAll('.btn-pos-tip').forEach(b => b.classList.remove('selected'));
    
    if (percent === 0.15) document.querySelectorAll('.btn-pos-tip')[0].classList.add('selected');
    if (percent === 0.20) document.querySelectorAll('.btn-pos-tip')[1].classList.add('selected');
    if (percent === 0.25) document.querySelectorAll('.btn-pos-tip')[2].classList.add('selected');
    
    const baseTotal = state.currentFare + state.tollFee + state.otherFee;
    state.tipFee = baseTotal * percent;
}

function showCustomTip() {
    document.querySelectorAll('.btn-pos-tip').forEach(b => b.classList.remove('selected'));
    document.getElementById('custom-tip-container').style.display = 'block';
    // 自动聚焦
    setTimeout(() => document.getElementById('custom-tip').focus(), 100);
    state.tipFee = 0; 
}

function clearTipSelection() {
    state.tipFee = parseFloat(document.getElementById('custom-tip').value) || 0;
}

function goToPay() {
    // 再次确认 (如果此时输入框可见)
    if (document.getElementById('custom-tip-container').style.display !== 'none') {
        state.tipFee = parseFloat(document.getElementById('custom-tip').value) || 0;
    }
    
    const total = state.currentFare + state.tollFee + state.otherFee + state.tipFee;
    
    document.getElementById('bill-meter').textContent = state.currentFare.toFixed(2);
    document.getElementById('bill-extra').textContent = (state.tollFee + state.otherFee).toFixed(2);
    document.getElementById('bill-tip').textContent = state.tipFee.toFixed(2);
    document.getElementById('final-total').textContent = total.toFixed(2);
    
    document.getElementById('tip-screen').style.display = 'none';
    document.getElementById('pay-screen').style.display = 'flex';
}

function resetApp() {
    state.isRunning = false;
    state.distance = 0;
    state.elapsedTime = 0;
    state.currentFare = getCurrentRate().base;
    state.tollFee = 0;
    state.otherFee = 0;
    state.tipFee = 0;
    
    document.getElementById('meter-screen').style.display = 'flex';
    document.getElementById('meter-screen').classList.add('active-screen');
    document.getElementById('pay-screen').style.display = 'none';
    
    document.getElementById('empty-sign').classList.remove('flipped');
    document.querySelector('.btn-start').disabled = false;
    document.querySelector('.btn-stop').disabled = true;
    document.querySelector('.btn-next').style.display = 'none';
    
    document.getElementById('display-price').textContent = '0.00';
    document.getElementById('display-km').textContent = '0.0';
    document.getElementById('display-time').textContent = '00:00';
    
    document.getElementById('toll-fee').value = '';
    document.getElementById('other-fee').value = '';
    document.getElementById('custom-tip').value = '';
}

init();
