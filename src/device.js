// 设备能力适配层集中管理 Web Audio、振动和屏幕常亮，页面状态不直接持有浏览器资源。

let audioContext = null;
let wakeLock = null;
let wakeLockRequest = null;
let shouldHoldWakeLock = false;

// 音频上下文延迟到首次用户操作时创建，符合移动浏览器的自动播放限制。
function getAudioContext() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
        return null;
    }

    if (!audioContext) {
        audioContext = new AudioContextClass();
    }

    if (audioContext.state === 'suspended') {
        audioContext.resume().catch((error) => {
            console.warn('恢复音频上下文失败:', error);
        });
    }

    return audioContext;
}

// 合成短促高频音，用作普通按钮的机械点击反馈。
export function playClickSound() {
    try {
        const context = getAudioContext();
        if (!context) return;

        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(1600, context.currentTime);
        oscillator.frequency.exponentialRampToValueAtTime(350, context.currentTime + 0.015);
        gain.gain.setValueAtTime(0.25, context.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, context.currentTime + 0.015);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start();
        oscillator.stop(context.currentTime + 0.02);
    } catch (error) {
        console.warn('生成按钮点击音失败:', error);
    }
}

// 合成较低沉的翻牌音，用作开始行程和封顶流程的强调反馈。
export function playClackSound() {
    try {
        const context = getAudioContext();
        if (!context) return;

        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = 'triangle';
        oscillator.frequency.setValueAtTime(240, context.currentTime);
        oscillator.frequency.exponentialRampToValueAtTime(60, context.currentTime + 0.07);
        gain.gain.setValueAtTime(0.5, context.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, context.currentTime + 0.07);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start();
        oscillator.stop(context.currentTime + 0.08);
    } catch (error) {
        console.warn('生成机械翻牌音失败:', error);
    }
}

// 合成跳表提示音（车费上涨时清脆短促的一声“嘟”）
export function playMeterTickSound() {
    try {
        const context = getAudioContext();
        if (!context) return;

        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(1150, context.currentTime);
        oscillator.frequency.exponentialRampToValueAtTime(800, context.currentTime + 0.025);
        gain.gain.setValueAtTime(0.35, context.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, context.currentTime + 0.025);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start();
        oscillator.stop(context.currentTime + 0.03);
    } catch (error) {
        console.warn('生成跳表音效失败:', error);
    }
}

// 合成热敏/针式小票打印机步进电机“吱——吱——吱——哒”机械出纸声
export function playPrintSound() {
    try {
        const context = getAudioContext();
        if (!context) return;

        const duration = 0.45;
        const bufferSize = Math.floor(context.sampleRate * duration);
        const buffer = context.createBuffer(1, bufferSize, context.sampleRate);
        const data = buffer.getChannelData(0);

        for (let i = 0; i < bufferSize; i++) {
            const t = i / context.sampleRate;
            const stepPulse = Math.sin(2 * Math.PI * 190 * t) > 0 ? 0.3 : -0.3;
            const noise = (Math.random() * 2 - 1) * 0.45;
            const modulation = Math.sin(2 * Math.PI * 20 * t) > 0.1 ? 1 : 0.2;
            data[i] = (stepPulse + noise) * modulation;
        }

        const noiseNode = context.createBufferSource();
        noiseNode.buffer = buffer;

        const filter = context.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.setValueAtTime(2400, context.currentTime);
        filter.Q.setValueAtTime(2.8, context.currentTime);

        const gain = context.createGain();
        gain.gain.setValueAtTime(0.35, context.currentTime);
        gain.gain.linearRampToValueAtTime(0.35, context.currentTime + 0.38);
        gain.gain.exponentialRampToValueAtTime(0.01, context.currentTime + duration);

        noiseNode.connect(filter);
        filter.connect(gain);
        gain.connect(context.destination);

        noiseNode.start();
        noiseNode.stop(context.currentTime + duration);
    } catch (error) {
        console.warn('生成小票打印音效失败:', error);
    }
}

// 合成“嗤啦”撕纸物理音效
export function playTearSound() {
    try {
        const context = getAudioContext();
        if (!context) return;

        const duration = 0.22;
        const bufferSize = Math.floor(context.sampleRate * duration);
        const buffer = context.createBuffer(1, bufferSize, context.sampleRate);
        const data = buffer.getChannelData(0);

        for (let i = 0; i < bufferSize; i++) {
            const progress = i / bufferSize;
            const friction = (Math.random() * 2 - 1) * (1 - progress * 0.6);
            data[i] = friction;
        }

        const noise = context.createBufferSource();
        noise.buffer = buffer;

        const filter = context.createBiquadFilter();
        filter.type = 'highpass';
        filter.frequency.setValueAtTime(1200, context.currentTime);
        filter.frequency.linearRampToValueAtTime(800, context.currentTime + duration);

        const gain = context.createGain();
        gain.gain.setValueAtTime(0.4, context.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, context.currentTime + duration);

        noise.connect(filter);
        filter.connect(gain);
        gain.connect(context.destination);

        noise.start();
        noise.stop(context.currentTime + duration);
    } catch (error) {
        console.warn('生成撕纸音效失败:', error);
    }
}

// 确保在 iOS Safari 切回前台或首次交互时恢复音频上下文
export function ensureAudioActive() {
    if (audioContext && (audioContext.state === 'suspended' || audioContext.state === 'interrupted')) {
        audioContext.resume().catch(() => {});
    }
}

// 浏览器不支持振动时静默跳过，不影响主流程。
export function triggerHaptic(duration = 15) {
    if (navigator.vibrate) {
        navigator.vibrate(duration);
    }
}

/**
 * 申请屏幕常亮锁。并发调用会复用同一个请求，避免创建多把锁。
 * 如果行程在系统返回锁之前已经结束，拿到锁后会立即释放，防止竞态耗电。
 */
export async function requestWakeLock() {
    shouldHoldWakeLock = true;
    if (wakeLock) return wakeLock;
    if (wakeLockRequest) return wakeLockRequest;
    if (!('wakeLock' in navigator)) return null;

    wakeLockRequest = navigator.wakeLock.request('screen')
        .then(async (lock) => {
            if (!shouldHoldWakeLock) {
                await lock.release();
                return null;
            }

            wakeLock = lock;
            wakeLock.addEventListener('release', () => {
                if (wakeLock === lock) {
                    wakeLock = null;
                }
            });
            return wakeLock;
        })
        .catch((error) => {
            console.warn(`请求屏幕常亮锁失败: ${error.message}`);
            return null;
        })
        .finally(() => {
            wakeLockRequest = null;
        });

    return wakeLockRequest;
}

// 标记行程不再需要常亮；若请求仍在路上，requestWakeLock 会在成功后自行释放。
export function releaseWakeLock() {
    shouldHoldWakeLock = false;
    if (!wakeLock) return;

    const lockToRelease = wakeLock;
    wakeLock = null;
    lockToRelease.release().catch((error) => {
        console.warn('释放屏幕常亮锁失败:', error);
    });
}
