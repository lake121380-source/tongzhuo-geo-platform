import assert from 'node:assert/strict';
import test from 'node:test';

import { formatTrendMetricValue, nearestTrendPointIndex } from '../../resources/js/admin/analytics.js';

const pointXs = Array.from({ length: 60 }, (_, index) => 48 + ((704 - 48) * index) / 59);
const bounds = { left: 100, width: 720 };
const viewBox = { x: 0, width: 720 };

test('trend pointer mapping follows plotted SVG points at both edges', () => {
    assert.equal(nearestTrendPointIndex(148, bounds, viewBox, pointXs), 0);
    assert.equal(nearestTrendPointIndex(804, bounds, viewBox, pointXs), 59);
});

test('trend pointer mapping selects the nearest plotted point', () => {
    const targetIndex = 24;
    const clientX = bounds.left + pointXs[targetIndex];

    assert.equal(nearestTrendPointIndex(clientX, bounds, viewBox, pointXs), targetIndex);
    assert.equal(nearestTrendPointIndex(-100, bounds, viewBox, pointXs), 0);
    assert.equal(nearestTrendPointIndex(2000, bounds, viewBox, pointXs), 59);
});

test('trend value formatting never turns an unmeasurable null into zero', () => {
    const visibility = { key: 'visibility', decimals: 1, suffix: '%' };
    const unavailable = '不可计算';

    // 后端在「无法测量」时返回 null/undefined：必须显示「不可计算」。
    assert.equal(formatTrendMetricValue(visibility, null, unavailable, 'zh-CN'), unavailable);
    assert.equal(formatTrendMetricValue(visibility, undefined, unavailable, 'zh-CN'), unavailable);
    assert.equal(formatTrendMetricValue(visibility, '', unavailable, 'zh-CN'), unavailable);
    assert.equal(formatTrendMetricValue(visibility, 'abc', unavailable, 'zh-CN'), unavailable);

    // 真实的 0 仍然要显示成 0，不能被「不可计算」吞掉。
    assert.equal(formatTrendMetricValue(visibility, 0, unavailable, 'zh-CN'), '0.0%');
    assert.equal(formatTrendMetricValue(visibility, 25, unavailable, 'zh-CN'), '25.0%');

    // 无后缀指标（采样数）照常格式化。
    assert.equal(formatTrendMetricValue({ key: 'samples' }, 3, unavailable, 'zh-CN'), '3');
});
