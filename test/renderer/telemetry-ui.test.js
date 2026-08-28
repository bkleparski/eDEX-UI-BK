'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  numeric,
  formatPercent,
  formatCapacity,
  formatRate,
  formatUptime,
  sparklinePoints,
  pushHistory,
  sortProcesses
} = require('../../src/renderer/telemetry-ui.js');

test('numeric accepts finite numbers and numeric strings, rejects everything else', () => {
  assert.equal(numeric(42), 42);
  assert.equal(numeric('42'), 42);
  assert.equal(numeric(0), 0);
  assert.equal(numeric(-7), -7);
  // Number(null) coerces to 0, so null reads as a real zero, not "missing".
  assert.equal(numeric(null), 0);
  assert.equal(numeric(undefined), null);
  assert.equal(numeric(NaN), null);
  assert.equal(numeric(Infinity), null);
  assert.equal(numeric('abc'), null);
  assert.equal(numeric({}), null);
});

test('formatPercent handles missing values, zero, negatives and digit precision', () => {
  // null coerces through Number() to 0, so it renders as a real percentage,
  // not the "--" placeholder — only undefined/NaN/non-numeric do that.
  assert.equal(formatPercent(null), '0%');
  assert.equal(formatPercent(undefined), '--');
  assert.equal(formatPercent(NaN), '--');
  assert.equal(formatPercent(0), '0%');
  assert.equal(formatPercent(-12.5), '-13%');
  assert.equal(formatPercent(12.345, 1), '12.3%');
});

test('formatCapacity spans zero, negative, and TB-scale values', () => {
  assert.equal(formatCapacity(null), '0.0 GB');
  assert.equal(formatCapacity(undefined), '--');
  assert.equal(formatCapacity(0), '0.0 GB');
  assert.equal(formatCapacity(-(1024 ** 3)), '-1.0 GB');
  assert.equal(formatCapacity(99 * 1024 ** 3), '99.0 GB');
  // >=100 GiB drops the decimal.
  assert.equal(formatCapacity(100 * 1024 ** 3), '100 GB');
  // 5 TiB.
  assert.equal(formatCapacity(5 * 1024 ** 4), '5120 GB');
});

test('formatRate spans zero, negative, and each unit boundary', () => {
  assert.equal(formatRate(null), '0 B/s');
  assert.equal(formatRate(undefined), '--');
  assert.equal(formatRate(0), '0 B/s');
  assert.equal(formatRate(-5), '-5 B/s');
  assert.equal(formatRate(1024), '1.0 KB/s');
  assert.equal(formatRate(1024 ** 2), '1.0 MB/s');
  assert.equal(formatRate(1024 ** 3), '1.0 GB/s');
  assert.equal(formatRate(5 * 1024 ** 3), '5.0 GB/s');
});

test('formatUptime clamps negative seconds to zero and rolls over days/hours', () => {
  assert.equal(formatUptime(null), '0D 00:00');
  assert.equal(formatUptime(undefined), '--');
  assert.equal(formatUptime(0), '0D 00:00');
  assert.equal(formatUptime(-100), '0D 00:00');
  assert.equal(formatUptime(3661), '0D 01:01');
  assert.equal(formatUptime(90_000), '1D 01:00');
});

test('sparklinePoints handles empty, single-point, and all-zero series', () => {
  assert.equal(sparklinePoints([], 34), '0,34 100,34');
  assert.equal(sparklinePoints([5], 10), '100.00,2.00');
  assert.equal(sparklinePoints([0, 0, 0], 10), '0.00,10.00 50.00,10.00 100.00,10.00');
});

test('sparklinePoints scales against an explicit maximum instead of the series peak', () => {
  assert.equal(sparklinePoints([50, 100], 20, 200), '0.00,15.50 100.00,11.00');
});

test('pushHistory clamps negatives and non-numeric input to zero, trims to limit', () => {
  const history = [];
  pushHistory(history, 5);
  assert.deepEqual(history, [5]);
  pushHistory(history, -10);
  assert.deepEqual(history, [5, 0]);
  pushHistory(history, 'not-a-number');
  assert.deepEqual(history, [5, 0, 0]);

  const bounded = [1, 2, 3];
  pushHistory(bounded, 4, 3);
  assert.deepEqual(bounded, [2, 3, 4]);
});

test('sortProcesses sorts descending, sends nulls to the bottom, and never mutates the input', () => {
  const processes = [
    { name: 'a', cpuPercent: 10, energyImpact: 5 },
    { name: 'b', cpuPercent: 50, energyImpact: null },
    { name: 'c', cpuPercent: 30, energyImpact: 20 },
    { name: 'd', cpuPercent: 5 } // no energyImpact field at all
  ];
  const originalOrder = processes.map((p) => p.name);

  const byCpu = sortProcesses(processes, 'cpuPercent');
  assert.deepEqual(byCpu.map((p) => p.name), ['b', 'c', 'a', 'd']);

  // energyImpact: real values sort first (descending), explicit null and a
  // missing field both count as "no sample" and land at the bottom in their
  // original relative order (stable sort).
  const byEnergy = sortProcesses(processes, 'energyImpact');
  assert.deepEqual(byEnergy.map((p) => p.name), ['c', 'a', 'b', 'd']);

  assert.deepEqual(processes.map((p) => p.name), originalOrder);
});
