// 应用版本只在一个位置维护，页面标题、离线缓存版本和发布记录需与它保持一致。
export const APP_VERSION = '1.4.3';

// 默认上海运价是所有外部配置的安全基线；冻结对象可防止运行时被意外改写。
export const DEFAULT_RATE = Object.freeze({
    base: 16,
    baseKm: 3,
    perKm: 2.7,
    emptyKm: 15,
    emptyRate: 1.5
});

// 金额和费率上限集中定义，确保设置、计费和结算使用同一套边界。
export const MAX_FARE = 999999;
export const MAX_NUMERIC_INPUT = MAX_FARE;
export const MAX_EMPTY_RATE = 100;
export const NIGHT_MULTIPLIER = 1.3;

// GPS 阈值属于业务规则，不应散落在页面事件代码中。
export const GPS_LIMITS = Object.freeze({
    maxAccuracyMeters: 80,
    minMovingSpeedKmh: 0.6,
    maxReasonableSpeedKmh: 200,
    maxSingleSegmentKm: 2,
    minMovingDistanceKm: 0.003
});

// 页面层只需按状态显示提示，不需要重复理解 GPS 判断细节。
export const GPS_SAMPLE_STATUS = Object.freeze({
    WEAK: 'weak',
    INITIAL: 'initial',
    STALE: 'stale',
    JUMP: 'jump',
    STATIONARY: 'stationary',
    MOVING: 'moving'
});

/**
 * 把输入框、缓存或外部设备返回的值限制为安全有限数字。
 * 无法解析的值回退到 fallback，避免 NaN 和 Infinity 污染后续账单。
 */
export function clampNumber(value, fallback, min = 0, max = MAX_NUMERIC_INPUT) {
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }

    return Math.min(Math.max(parsed, min), max);
}

/**
 * 统一清洗运价，并保证返空起征点不会早于起步里程。
 * 即使本地缓存被手工篡改，计费公式也只会收到完整且有效的字段。
 */
export function normalizeRate(rawRate = {}) {
    const source = rawRate && typeof rawRate === 'object' ? rawRate : {};
    const rate = {
        base: clampNumber(source.base, DEFAULT_RATE.base),
        baseKm: clampNumber(source.baseKm, DEFAULT_RATE.baseKm),
        perKm: clampNumber(source.perKm, DEFAULT_RATE.perKm),
        emptyKm: clampNumber(source.emptyKm, DEFAULT_RATE.emptyKm),
        emptyRate: clampNumber(source.emptyRate, DEFAULT_RATE.emptyRate, 1, MAX_EMPTY_RATE)
    };

    rate.emptyKm = Math.max(rate.emptyKm, rate.baseKm);
    return rate;
}

/**
 * 判断某个本地时间是否处于 23:00（含）至次日 05:00（不含）的夜间区间。
 * 日期参数可注入，既方便测试边界，也避免核心规则依赖页面环境。
 */
export function isNightTime(date = new Date()) {
    const hours = date instanceof Date ? date.getHours() : Number.NaN;
    return Number.isInteger(hours) && (hours >= 23 || hours < 5);
}

/**
 * 跨时段分段累计计价引擎：
 * 消除跨越 23:00 或 05:00 时对前序已行驶历史里程的全量追溯漏洞。
 * 起步价按发车时段决定，后续产生的白天与夜间里程分别应用对应倍率。
 */
export function calculateSegmentedFare({
    rawRate,
    dayDistance = 0,
    nightDistance = 0,
    startIsNight = false
}) {
    const rate = normalizeRate(rawRate);
    const dayKm = clampNumber(dayDistance, 0);
    const nightKm = clampNumber(nightDistance, 0);
    const totalKm = dayKm + nightKm;

    const baseFareMultiplier = startIsNight ? NIGHT_MULTIPLIER : 1;
    const baseFare = rate.base * baseFareMultiplier;

    if (totalKm <= rate.baseKm) {
        return Math.min(Math.max(baseFare, 0), MAX_FARE);
    }

    // 计算各时段超出起步里程的有效续租里程
    let dayExtra = 0;
    let nightExtra = 0;

    if (startIsNight) {
        if (nightKm >= rate.baseKm) {
            nightExtra = nightKm - rate.baseKm;
            dayExtra = dayKm;
        } else {
            nightExtra = 0;
            dayExtra = Math.max(0, dayKm - (rate.baseKm - nightKm));
        }
    } else {
        if (dayKm >= rate.baseKm) {
            dayExtra = dayKm - rate.baseKm;
            nightExtra = nightKm;
        } else {
            dayExtra = 0;
            nightExtra = Math.max(0, nightKm - (rate.baseKm - dayKm));
        }
    }

    const normalCapacity = Math.max(0, rate.emptyKm - rate.baseKm);

    let dayNormal = 0;
    let dayEmpty = 0;
    let nightNormal = 0;
    let nightEmpty = 0;

    // 起步时段产生的超额里程先填充普通续租区间，超出后进入返空加价区间
    if (startIsNight) {
        nightNormal = Math.min(nightExtra, normalCapacity);
        nightEmpty = Math.max(0, nightExtra - normalCapacity);
        const remainingNormal = Math.max(0, normalCapacity - nightNormal);
        dayNormal = Math.min(dayExtra, remainingNormal);
        dayEmpty = Math.max(0, dayExtra - remainingNormal);
    } else {
        dayNormal = Math.min(dayExtra, normalCapacity);
        dayEmpty = Math.max(0, dayExtra - normalCapacity);
        const remainingNormal = Math.max(0, normalCapacity - dayNormal);
        nightNormal = Math.min(nightExtra, remainingNormal);
        nightEmpty = Math.max(0, nightExtra - remainingNormal);
    }

    const dayPerKm = rate.perKm;
    const nightPerKm = rate.perKm * NIGHT_MULTIPLIER;

    let fare = baseFare;
    fare += dayNormal * dayPerKm;
    fare += dayEmpty * dayPerKm * rate.emptyRate;
    fare += nightNormal * nightPerKm;
    fare += nightEmpty * nightPerKm * rate.emptyRate;

    if (!Number.isFinite(fare)) {
        return Math.min(baseFare, MAX_FARE);
    }

    return Math.min(Math.max(fare, 0), MAX_FARE);
}

/**
 * 单区间兼容入口：
 * 满足常规单时段快速计算，内部映射至分段计价引擎。
 */
export function calculateFare(rawRate, rawDistance, isNight = false) {
    const distance = clampNumber(rawDistance, 0);
    return calculateSegmentedFare({
        rawRate,
        dayDistance: isNight ? 0 : distance,
        nightDistance: isNight ? distance : 0,
        startIsNight: Boolean(isNight)
    });
}

/**
 * 生成内部一致的结算明细。
 * 当所有分项超过封顶金额时，按里程费、附加费、小费的顺序占用余额，
 * 从而保证页面展示的三个分项相加始终严格等于最终总额。
 */
export function calculateBill({ meterFare, tollFee, otherFee, tipFee }) {
    const maxFareCents = MAX_FARE * 100;
    let remainingCents = maxFareCents;

    const consumeRemaining = (value) => {
        // 结算阶段统一换算为整数“分”，避免多个小数分项分别显示后与总额相差 0.01 元。
        const safeValue = clampNumber(value, 0);
        const requestedCents = Math.round((safeValue + Number.EPSILON) * 100);
        const consumedCents = Math.min(requestedCents, remainingCents);
        remainingCents -= consumedCents;
        return consumedCents;
    };

    const billedMeterFareCents = consumeRemaining(meterFare);
    const billedTollFeeCents = consumeRemaining(tollFee);
    const billedOtherFeeCents = consumeRemaining(otherFee);
    const billedTipFeeCents = consumeRemaining(tipFee);
    const extraFeeCents = billedTollFeeCents + billedOtherFeeCents;
    const totalCents = billedMeterFareCents + extraFeeCents + billedTipFeeCents;

    return {
        meterFare: billedMeterFareCents / 100,
        extraFee: extraFeeCents / 100,
        tipFee: billedTipFeeCents / 100,
        total: totalCents / 100
    };
}

/**
 * 根据当前里程费和附加费计算预设小费，比例被限制在 0% 至 100%。
 */
export function calculateSuggestedTip(meterFare, tollFee, otherFee, rawPercent) {
    const percent = clampNumber(rawPercent, 0, 0, 1);
    const subtotal = calculateBill({ meterFare, tollFee, otherFee, tipFee: 0 }).total;
    return Math.min(subtotal * percent, MAX_FARE);
}

/**
 * 使用真实时间戳计算累计秒数，避免浏览器把后台 setInterval 降频后少算时间。
 */
export function calculateElapsedSeconds(startTimestamp, currentTimestamp = Date.now()) {
    if (!Number.isFinite(startTimestamp) || !Number.isFinite(currentTimestamp)) {
        return 0;
    }

    return Math.max(0, Math.floor((currentTimestamp - startTimestamp) / 1000));
}

// 经纬度不仅要是有限数字，还必须位于地球坐标的合法范围内。
function isValidCoordinate(latitude, longitude) {
    return Number.isFinite(latitude) &&
        Number.isFinite(longitude) &&
        latitude >= -90 && latitude <= 90 &&
        longitude >= -180 && longitude <= 180;
}

/**
 * 计算地球表面两点之间的球面距离，单位为公里。
 * 输入坐标非法时返回 NaN，由上层 GPS 判定直接拒绝该样本。
 */
export function haversineDistance(lat1, lon1, lat2, lon2) {
    if (!isValidCoordinate(lat1, lon1) || !isValidCoordinate(lat2, lon2)) {
        return Number.NaN;
    }

    const earthRadiusKm = 6371;
    const degreesToRadians = Math.PI / 180;
    const deltaLatitude = (lat2 - lat1) * degreesToRadians;
    const deltaLongitude = (lon2 - lon1) * degreesToRadians;
    const firstLatitude = lat1 * degreesToRadians;
    const secondLatitude = lat2 * degreesToRadians;
    const rawA = Math.sin(deltaLatitude / 2) ** 2 +
        Math.cos(firstLatitude) * Math.cos(secondLatitude) *
        Math.sin(deltaLongitude / 2) ** 2;

    // 浮点误差可能让 rawA 略微越过 0 或 1，先夹紧可避免开方得到 NaN。
    const normalizedA = Math.min(Math.max(rawA, 0), 1);
    const centralAngle = 2 * Math.atan2(Math.sqrt(normalizedA), Math.sqrt(1 - normalizedA));
    return earthRadiusKm * centralAngle;
}

/**
 * 检查单个 GPS 样本的坐标、精度和时间戳是否合法。
 */
export function isUsableLocationSample(sample) {
    if (!sample || typeof sample !== 'object') {
        return false;
    }

    return isValidCoordinate(sample.latitude, sample.longitude) &&
        Number.isFinite(sample.accuracy) &&
        sample.accuracy >= 0 &&
        sample.accuracy <= GPS_LIMITS.maxAccuracyMeters &&
        Number.isFinite(sample.timestamp) &&
        sample.timestamp > 0;
}

/**
 * 对相邻 GPS 样本做完整判定，并告诉页面层是否更新参考点、是否累计里程。
 * 弱信号点与乱序点不移动参考点；跳点和静止点会更新参考点，避免后续速度被旧时间摊薄。
 */
export function analyzeLocationSample(previousSample, currentSample) {
    if (!isUsableLocationSample(currentSample)) {
        return createGpsDecision(GPS_SAMPLE_STATUS.WEAK, false);
    }

    if (!isUsableLocationSample(previousSample)) {
        return createGpsDecision(GPS_SAMPLE_STATUS.INITIAL, true);
    }

    const elapsedSeconds = (currentSample.timestamp - previousSample.timestamp) / 1000;
    if (elapsedSeconds <= 0) {
        return createGpsDecision(GPS_SAMPLE_STATUS.STALE, false);
    }

    const distanceKm = haversineDistance(
        previousSample.latitude,
        previousSample.longitude,
        currentSample.latitude,
        currentSample.longitude
    );
    const averageSpeedKmh = distanceKm / (elapsedSeconds / 3600);
    const reportedSpeedKmh = Number.isFinite(currentSample.speedMps)
        ? currentSample.speedMps * 3.6
        : null;
    const exceedsPhysicalLimits = !Number.isFinite(distanceKm) ||
        distanceKm > GPS_LIMITS.maxSingleSegmentKm ||
        averageSpeedKmh > GPS_LIMITS.maxReasonableSpeedKmh;

    if (exceedsPhysicalLimits) {
        return createGpsDecision(
            GPS_SAMPLE_STATUS.JUMP,
            true,
            0,
            elapsedSeconds,
            averageSpeedKmh
        );
    }

    const hasReportedMovement = reportedSpeedKmh !== null &&
        reportedSpeedKmh >= GPS_LIMITS.minMovingSpeedKmh &&
        reportedSpeedKmh <= GPS_LIMITS.maxReasonableSpeedKmh;
    const hasMeasuredMovement = distanceKm >= GPS_LIMITS.minMovingDistanceKm &&
        averageSpeedKmh >= GPS_LIMITS.minMovingSpeedKmh &&
        averageSpeedKmh <= GPS_LIMITS.maxReasonableSpeedKmh;

    if (!hasReportedMovement && !hasMeasuredMovement) {
        return createGpsDecision(
            GPS_SAMPLE_STATUS.STATIONARY,
            true,
            0,
            elapsedSeconds,
            averageSpeedKmh
        );
    }

    return createGpsDecision(
        GPS_SAMPLE_STATUS.MOVING,
        true,
        distanceKm,
        elapsedSeconds,
        averageSpeedKmh
    );
}

// 所有分支返回固定形状，页面层无需为缺失字段编写额外判断。
function createGpsDecision(status, shouldUpdateAnchor, distanceKm = 0, elapsedSeconds = 0, averageSpeedKmh = 0) {
    return {
        status,
        shouldUpdateAnchor,
        distanceKm,
        elapsedSeconds,
        averageSpeedKmh
    };
}
