"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Chart = require("../web/cpu-chart.js");

test("CPU series filters, sorts and downsamples without losing the range", function () {
  const start = 1000000;
  const end = start + 60 * 60000;
  const samples = [];
  for (let i = 0; i < 1000; i++) {
    samples.push({ tMs: start + i * 3600, pct: i % 100 });
  }
  const series = Chart.buildSeries(samples, start, end, 100);
  assert.ok(series.length <= 100);
  assert.ok(series.length > 20);
  assert.ok(series[0].tMs >= start);
  assert.ok(series[series.length - 1].tMs <= end);
  for (let i = 1; i < series.length; i++) assert.ok(series[i].tMs >= series[i - 1].tMs);
  for (const point of series) assert.ok(Number.isFinite(point.pct));
});

test("CPU series keeps small inputs exact", function () {
  const points = [{ tMs: 10, pct: 1 }, { tMs: 20, pct: 3 }];
  assert.deepEqual(Chart.buildSeries(points, 0, 30, 320), points);
});

test("chart geometry produces a bounded path and a useful maximum", function () {
  const points = [{ tMs: 0, pct: 2 }, { tMs: 1, pct: 17 }, { tMs: 2, pct: 4 }];
  const plot = Chart.geometry(points, 1000, 280, { left: 60, right: 20, top: 20, bottom: 40 });
  assert.equal(plot.max, 20);
  assert.ok(plot.path.startsWith("M"));
  assert.ok(plot.path.includes("L"));
  assert.ok(plot.y(17) < plot.y(2));
  assert.equal(Chart.buildSeries([], 0, 100, 10).length, 0);
});
