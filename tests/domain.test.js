import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    DEFAULT_RATE,
    GPS_SAMPLE_STATUS,
    MAX_FARE,
    analyzeLocationSample,
    calculateBill,
    calculateElapsedSeconds,
    calculateFare,
    calculateSegmentedFare,
    calculateSuggestedTip,
    clampNumber,
    haversineDistance,
    isNightTime,
    isUsableLocationSample,
    normalizeRate
} from '../src/domain.js';

// 金额计算允许保留小数，统一用误差比较避免二进制浮点表示造成误报。
function assertClose(actual, expected, tolerance = 1e-9) {
    assert.ok(
        Math.abs(actual - expected) <= tolerance,
        `期望 ${actual} 与 ${expected} 的差值不超过 ${tolerance}`
    );
}

// 构造稳定的上海附近定位样本，各测试只覆盖自己关心的字段。
function createLocationSample(overrides = {}) {
    return {
        latitude: 31.2304,
        longitude: 121.4737,
        accuracy: 10,
        timestamp: 1000,
        speedMps: null,
        ...overrides
    };
}

describe('数字与运价边界', () => {
    it('拒绝非有限数字并限制上下界', () => {
        assert.equal(clampNumber('1e309', 7), 7);
        assert.equal(clampNumber(-5, 0), 0);
        assert.equal(clampNumber(MAX_FARE + 1, 0), MAX_FARE);
    });

    it('修正不完整费率和倒置的返空起征点', () => {
        const rate = normalizeRate({
            base: '20',
            baseKm: 10,
            perKm: 'not-a-number',
            emptyKm: 5,
            emptyRate: 0
        });

        assert.deepEqual(rate, {
            base: 20,
            baseKm: 10,
            perKm: DEFAULT_RATE.perKm,
            emptyKm: 10,
            emptyRate: 1
        });
    });

    it('起步里程内只收起步价', () => {
        assert.equal(calculateFare(DEFAULT_RATE, 0), 16);
        assert.equal(calculateFare(DEFAULT_RATE, 3), 16);
        assert.equal(calculateSegmentedFare({ rawRate: DEFAULT_RATE, dayDistance: 2, nightDistance: 1, startIsNight: false }), 16);
        assert.equal(calculateSegmentedFare({ rawRate: DEFAULT_RATE, dayDistance: 1, nightDistance: 2, startIsNight: true }), 16 * 1.3);
    });

    it('普通续租区间按每公里单价计费', () => {
        assertClose(calculateFare(DEFAULT_RATE, 10), 34.9);
    });

    it('跨时段分段计费：白天上车开入夜间，各自计算对应单价', () => {
        // 白天跑 5km（前3km起步16元，后2km续租 2*2.7=5.4），夜间跑 5km（5*2.7*1.3=17.55），总计 16 + 5.4 + 17.55 = 38.95
        const fare = calculateSegmentedFare({
            rawRate: DEFAULT_RATE,
            dayDistance: 5,
            nightDistance: 5,
            startIsNight: false
        });
        assertClose(fare, 38.95);
    });

    it('超过返空起征点后只对超出部分应用返空倍率', () => {
        assertClose(calculateFare(DEFAULT_RATE, 20), 68.65);
    });

    it('夜间倍率同时作用于起步价和里程单价', () => {
        assertClose(calculateFare(DEFAULT_RATE, 20, true), 89.245);
    });

    it('任何运价组合都不能突破总金额上限', () => {
        const extremeRate = {
            base: MAX_FARE,
            baseKm: 0,
            perKm: MAX_FARE,
            emptyKm: 0,
            emptyRate: 100
        };

        assert.equal(calculateFare(extremeRate, MAX_FARE, true), MAX_FARE);
    });
});

describe('结算一致性', () => {
    it('正常账单完整保留里程费、附加费和小费', () => {
        assert.deepEqual(
            calculateBill({ meterFare: 50, tollFee: 10, otherFee: 5, tipFee: 13 }),
            { meterFare: 50, extraFee: 15, tipFee: 13, total: 78 }
        );
    });

    it('封顶账单按固定顺序截断且分项之和等于总额', () => {
        const bill = calculateBill({
            meterFare: 900000,
            tollFee: 150000,
            otherFee: 200,
            tipFee: 500
        });

        assert.deepEqual(bill, {
            meterFare: 900000,
            extraFee: 99999,
            tipFee: 0,
            total: MAX_FARE
        });
        assert.equal(bill.meterFare + bill.extraFee + bill.tipFee, bill.total);
    });

    it('所有分项按分取整后仍与页面总额完全一致', () => {
        const bill = calculateBill({
            meterFare: 1.005,
            tollFee: 1.005,
            otherFee: 0,
            tipFee: 1.005
        });
        const displayedComponentCents = [bill.meterFare, bill.extraFee, bill.tipFee]
            .reduce((sum, value) => sum + Math.round(value * 100), 0);

        assert.deepEqual(bill, {
            meterFare: 1.01,
            extraFee: 1.01,
            tipFee: 1.01,
            total: 3.03
        });
        assert.equal(displayedComponentCents, Math.round(bill.total * 100));
    });

    it('预设小费以清洗后的里程费和附加费小计为基数', () => {
        assertClose(calculateSuggestedTip(50, 10, 5, 0.2), 13);
        assert.equal(calculateSuggestedTip(50, 10, 5, -1), 0);
    });
});

describe('时间规则', () => {
    it('准确覆盖夜间费率的两个边界', () => {
        assert.equal(isNightTime(new Date(2026, 0, 1, 22, 59)), false);
        assert.equal(isNightTime(new Date(2026, 0, 1, 23, 0)), true);
        assert.equal(isNightTime(new Date(2026, 0, 2, 4, 59)), true);
        assert.equal(isNightTime(new Date(2026, 0, 2, 5, 0)), false);
    });

    it('用真实时间差计算秒数并拒绝倒退时间', () => {
        assert.equal(calculateElapsedSeconds(1000, 6500), 5);
        assert.equal(calculateElapsedSeconds(6500, 1000), 0);
        assert.equal(calculateElapsedSeconds(Number.NaN, 6500), 0);
    });
});

describe('GPS 样本判定', () => {
    it('Haversine 公式能得到合理的短距离结果', () => {
        assertClose(haversineDistance(0, 0, 0, 0.001), 0.1111949266, 1e-6);
        assert.ok(Number.isNaN(haversineDistance(91, 0, 0, 0)));
    });

    it('拒绝越界坐标、负精度和弱信号', () => {
        assert.equal(isUsableLocationSample(createLocationSample()), true);
        assert.equal(isUsableLocationSample(createLocationSample({ latitude: 91 })), false);
        assert.equal(isUsableLocationSample(createLocationSample({ accuracy: -1 })), false);
        assert.equal(isUsableLocationSample(createLocationSample({ accuracy: 81 })), false);
    });

    it('首个有效点只建立锚点，不累计里程', () => {
        const decision = analyzeLocationSample(null, createLocationSample());
        assert.equal(decision.status, GPS_SAMPLE_STATUS.INITIAL);
        assert.equal(decision.shouldUpdateAnchor, true);
        assert.equal(decision.distanceKm, 0);
    });

    it('乱序或重复时间戳不会覆盖现有锚点', () => {
        const previous = createLocationSample({ timestamp: 2000 });
        const current = createLocationSample({ timestamp: 2000, longitude: 121.4747 });
        const decision = analyzeLocationSample(previous, current);

        assert.equal(decision.status, GPS_SAMPLE_STATUS.STALE);
        assert.equal(decision.shouldUpdateAnchor, false);
    });

    it('静止漂移会刷新锚点但不会累计距离', () => {
        const previous = createLocationSample();
        const current = createLocationSample({
            longitude: previous.longitude + 0.000001,
            timestamp: previous.timestamp + 60000,
            speedMps: 0
        });
        const decision = analyzeLocationSample(previous, current);

        assert.equal(decision.status, GPS_SAMPLE_STATUS.STATIONARY);
        assert.equal(decision.shouldUpdateAnchor, true);
        assert.equal(decision.distanceKm, 0);
    });

    it('合理移动样本会返回可累计的实际距离', () => {
        const previous = createLocationSample();
        const current = createLocationSample({
            longitude: previous.longitude + 0.001,
            timestamp: previous.timestamp + 60000
        });
        const decision = analyzeLocationSample(previous, current);

        assert.equal(decision.status, GPS_SAMPLE_STATUS.MOVING);
        assert.ok(decision.distanceKm > 0.09 && decision.distanceKm < 0.1);
    });

    it('超过物理上限的跳点会被丢弃并重建锚点', () => {
        const previous = createLocationSample();
        const current = createLocationSample({
            latitude: previous.latitude + 1,
            timestamp: previous.timestamp + 60000
        });
        const decision = analyzeLocationSample(previous, current);

        assert.equal(decision.status, GPS_SAMPLE_STATUS.JUMP);
        assert.equal(decision.shouldUpdateAnchor, true);
        assert.equal(decision.distanceKm, 0);
    });
});
