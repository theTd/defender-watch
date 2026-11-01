"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Core = require("../web/defender-core.js");

const fixture = path.join(__dirname, "fixtures", "report.json");
const exclusionFixture = path.join(__dirname, "fixtures", "exclusions.json");
const report = JSON.parse(fs.readFileSync(fixture, "utf8"));
const fixtureExclusions = JSON.parse(fs.readFileSync(exclusionFixture, "utf8"));

function close(actual, expected, tolerance, label) {
  assert.ok(Math.abs(actual - expected) <= (tolerance || 1e-6), (label || "value") + ": " + actual + " != " + expected);
}

test("settings are clamped and default to auto-start", function () {
  const defaults = Core.normalizeSettings(null);
  assert.equal(defaults.recordSeconds, 60);
  assert.equal(defaults.pauseSeconds, 120);
  assert.equal(defaults.retentionDays, 7);
  assert.equal(defaults.autoStartCollector, true);
  assert.equal(defaults.alert.enabled, false);
  assert.equal(defaults.alert.thresholdPct, 5);

  const clamped = Core.normalizeSettings({
    recordSeconds: 2,
    pauseSeconds: 9999,
    retentionDays: 400,
    autoStartCollector: false,
    alert: { enabled: true, thresholdPct: 0, minutes: 0 }
  });
  assert.equal(clamped.recordSeconds, 15);
  assert.equal(clamped.pauseSeconds, 3600);
  assert.equal(clamped.retentionDays, 90);
  assert.equal(clamped.autoStartCollector, false);
  assert.equal(clamped.alert.thresholdPct, 1);
  assert.equal(clamped.alert.minutes, 1);
});

test("fixture exclusions accept the legacy capitalised keys", function () {
  const exclusions = Core.normalizeExclusions(fixtureExclusions);
  assert.ok(exclusions.paths.includes("E:\\misc"));
  assert.ok(exclusions.processes.includes("wpr.exe"));
  assert.deepEqual(exclusions.extensions, [".etl"]);
  assert.ok(Core.isPathExcluded("e:/MISC/project", exclusions));
  assert.equal(Core.isPathExcluded("E:\\misc2", exclusions), false);
});

test("real report flattening handles leaves, absolute segments and AMSI", function () {
  const flat = Core.flattenReport(report);
  assert.equal(flat.paths.length, 184);
  close(flat.totalScanSeconds, 17.7948857, 1e-7, "total scan seconds");
  const amsi = flat.paths.filter(function (row) { return row.path === Core.AMSI_LABEL; });
  assert.equal(amsi.length, 1);
  assert.equal(amsi[0].count, 38);
  close(amsi[0].seconds, 0.2190116, 1e-7, "AMSI seconds");
  assert.equal(flat.paths.some(function (row) { return /MemScanVfz-AMSI/.test(row.path); }), false);
  const bash = flat.paths.find(function (row) { return row.path === "C:\\WINDOWS\\Prefetch\\BASH.EXE-588D66F0.pf"; });
  assert.ok(bash, "absolute child segment should become its own full path");
  close(bash.seconds, 0.0489483, 1e-7, "bash prefetch seconds");
  assert.equal(bash.depth, 4);
  assert.equal(flat.paths.some(function (row) { return row.path.includes("Prefetch\\C:\\WINDOWS"); }), false);
  assert.equal(flat.paths.some(function (row) { return row.path.includes("windows\\prefetch\\C:\\"); }), false);
  assert.equal(flat.processes.length, 25);
  assert.equal(flat.extensions.length, 20);
  assert.equal(flat.files.length, 40);
});

test("path roll-up respects the requested depth and leaves AMSI alone", function () {
  assert.equal(Core.rollupPath("E:\\misc\\project\\deep\\file.txt", 2), "E:\\misc");
  assert.equal(Core.rollupPath("E:\\misc\\project\\deep\\file.txt", 3), "E:\\misc\\project");
  assert.equal(Core.rollupPath("E:\\misc\\project\\deep\\file.txt", 6), "E:\\misc\\project\\deep\\file.txt");
  assert.equal(Core.rollupPath(Core.AMSI_LABEL, 2), Core.AMSI_LABEL);
  assert.equal(Core.pathDepth("E:\\misc"), 2);
  assert.equal(Core.pathDepth("E:\\"), 1);
});

test("exclusion matching is case-insensitive and directory-boundary aware", function () {
  const exclusions = { paths: ["E:\\misc\\", "C:\\Windows\\Prefetch"], processes: ["wpr.exe", "C:\\Tools\\PerfView.exe"], extensions: [".etl"] };
  assert.equal(Core.isPathExcluded("E:\\misc", exclusions), true);
  assert.equal(Core.isPathExcluded("E:\\MISC\\project", exclusions), true);
  assert.equal(Core.isPathExcluded("e:/misc/project", exclusions), true);
  assert.equal(Core.isPathExcluded("E:\\misc2", exclusions), false);
  assert.equal(Core.isPathExcluded("E:\\misc2\\child", exclusions), false);
  assert.equal(Core.isPathExcluded("C:\\Windows\\Prefetch\\A.pf", exclusions), true);
  assert.equal(Core.isPathExcluded("C:\\Windows\\Prefetch2\\A.pf", exclusions), false);
  assert.equal(Core.isExtensionExcluded("C:\\Temp\\capture.ETL", exclusions), true);
  assert.equal(Core.isExtensionExcluded("C:\\Temp\\capture.txt", exclusions), false);
  assert.equal(Core.isFileExcluded("E:\\misc2\\capture.etl", exclusions), true);
  assert.equal(Core.isProcessExcluded("C:\\Windows\\System32\\wpr.exe", exclusions), true);
  assert.equal(Core.isProcessExcluded("C:\\Windows\\System32\\WPR2.EXE", exclusions), false);
  assert.equal(Core.isProcessExcluded("C:\\Tools\\PerfView.exe", exclusions), true);
  assert.equal(Core.exclusionCommand("E:\\misc"), 'Add-MpPreference -ExclusionPath "E:\\misc"');
});

function windowFile(id, start, end, recordSeconds, total, paths, processes, extensions, files) {
  return {
    file: id + ".json",
    mtime: 1,
    data: {
      schema: 1,
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      recordSeconds: recordSeconds,
      totalScanSeconds: total,
      paths: paths,
      processes: processes || [],
      extensions: extensions || [],
      files: files || []
    }
  };
}

test("interval aggregation combines overlapping windows and applies exclusions", function () {
  const now = Date.now();
  const windows = [
    windowFile("w1", now - 10 * 60000, now - 9 * 60000, 60, 10, [
      { path: "E:\\misc\\a", seconds: 2, count: 2, maxSeconds: 1.2 },
      { path: "E:\\misc\\b", seconds: 3, count: 3, maxSeconds: 1.5 },
      { path: "E:\\other\\c", seconds: 1, count: 1, maxSeconds: 0.9 },
      { path: Core.AMSI_LABEL, seconds: 0.5, count: 5, maxSeconds: 0.2 }
    ], [{ path: "C:\\Windows\\System32\\wpr.exe", seconds: 4, count: 4, maxSeconds: 2 }], [{ extension: ".etl", seconds: 4, count: 4, maxSeconds: 2 }], [{ path: "E:\\misc\\a\\one.bin", seconds: 2, count: 2, maxSeconds: 1 }]),
    windowFile("w2", now - 8 * 60000, now - 7 * 60000, 60, 8, [
      { path: "E:\\misc\\a", seconds: 4, count: 4, maxSeconds: 2.2 },
      { path: "E:\\other\\c", seconds: 2, count: 2, maxSeconds: 1.1 }
    ], [{ path: "C:\\Windows\\System32\\wpr.exe", seconds: 1, count: 1, maxSeconds: 1 }], [{ extension: ".etl", seconds: 1, count: 1, maxSeconds: 1 }], [{ path: "E:\\other\\c\\two.txt", seconds: 2, count: 2, maxSeconds: 1 }]),
    windowFile("old", now - 120 * 60000, now - 119 * 60000, 60, 99, [
      { path: "E:\\old\\z", seconds: 99, count: 99, maxSeconds: 99 }
    ])
  ];
  const exclusions = { paths: ["E:\\misc"], processes: ["wpr.exe"], extensions: [".etl"] };
  const all = Core.aggregateWindows(windows, {
    startMs: now - 20 * 60000,
    endMs: now,
    depth: 2,
    exclusions: exclusions,
    onlyNotExcluded: false
  });
  assert.equal(all.windowCount, 2);
  assert.equal(all.recordedSeconds, 120);
  assert.equal(all.recordedMinutes, 2);
  close(all.totalScanSeconds, 18, 1e-9, "total scan seconds");
  const misc = all.paths.find(function (row) { return row.path === "E:\\misc"; });
  assert.ok(misc);
  assert.equal(misc.count, 9);
  close(misc.seconds, 9, 1e-9, "misc seconds");
  close(misc.sharePct, 50, 1e-9, "misc share");
  close(misc.perMinuteSeconds, 4.5, 1e-9, "misc per minute");
  assert.equal(misc.excluded, true);
  const other = all.paths.find(function (row) { return row.path === "E:\\other"; });
  assert.ok(other);
  close(other.seconds, 3, 1e-9, "other seconds");
  const amsi = all.paths.find(function (row) { return row.amsi; });
  assert.ok(amsi);
  close(amsi.seconds, 0.5, 1e-9, "AMSI aggregate");
  assert.equal(all.processes[0].excluded, true);
  assert.equal(all.extensions[0].excluded, true);
  assert.equal(all.files.find(function (row) { return row.path.indexOf("two.txt") >= 0; }).excluded, false);
  assert.equal(all.files.find(function (row) { return row.path.indexOf("one.bin") >= 0; }).excluded, true);

  const visible = Core.aggregateWindows(windows, {
    startMs: now - 20 * 60000,
    endMs: now,
    depth: 2,
    exclusions: exclusions,
    onlyNotExcluded: true
  });
  assert.equal(visible.paths.some(function (row) { return row.path === "E:\\misc"; }), false);
  assert.ok(visible.paths.some(function (row) { return row.path === "E:\\other"; }));
});

test("stale collector detection covers missing, running, stale, starting and error", function () {
  const now = Date.now();
  const base = { now: now, recordSeconds: 60, pauseSeconds: 120 };
  assert.equal(Core.collectorHealth(Object.assign({}, base, { status: null, statusMtime: 0, runtime: { phase: "idle" } })).state, "not running");
  assert.equal(Core.collectorHealth(Object.assign({}, base, { status: { state: "idle", lastError: "" }, statusMtime: now - 10000, runtime: { phase: "idle" } })).state, "running");
  assert.equal(Core.collectorHealth(Object.assign({}, base, { status: { state: "idle", lastError: "" }, statusMtime: now - 241000, runtime: { phase: "idle" } })).state, "stale");
  assert.equal(Core.collectorHealth(Object.assign({}, base, { status: null, statusMtime: 0, runtime: { phase: "starting", startedAt: now } })).state, "starting");
  assert.equal(Core.collectorHealth(Object.assign({}, base, { status: { state: "idle" }, statusMtime: now - 5000, runtime: { phase: "starting", startedAt: now } })).state, "starting");
  assert.equal(Core.collectorHealth(Object.assign({}, base, { status: { state: "error", lastError: "UAC prompt was declined" }, statusMtime: now, runtime: { phase: "idle" } })).state, "error");
  assert.equal(Core.collectorHealth(Object.assign({}, base, { status: null, statusMtime: 0, runtime: { phase: "idle", error: "The UAC prompt was declined" } })).state, "error");
});

test("alert decision needs a full recent window above the threshold", function () {
  const now = Date.now();
  const samples = [];
  for (let i = 0; i <= 10; i++) samples.push({ tMs: now - (10 - i) * 60000, pct: i === 10 ? 1 : 8 });
  const firing = Core.alertDecision({ samples: samples, minutes: 5, thresholdPct: 5, now: now, enabled: true, alreadyNotified: false });
  assert.equal(firing.shouldNotify, true);
  assert.ok(firing.averagePct > 5);
  const silenced = Core.alertDecision({ samples: samples, minutes: 5, thresholdPct: 5, now: now, enabled: true, alreadyNotified: true });
  assert.equal(silenced.shouldNotify, false);
  const low = Core.alertDecision({ samples: samples.map(function (s) { return { tMs: s.tMs, pct: 1 }; }), minutes: 5, thresholdPct: 5, now: now, enabled: true, alreadyNotified: false });
  assert.equal(low.shouldNotify, false);
  const shortHistory = Core.alertDecision({ samples: [{ tMs: now - 1000, pct: 50 }, { tMs: now, pct: 50 }], minutes: 5, thresholdPct: 5, now: now, enabled: true, alreadyNotified: false });
  assert.equal(shortHistory.shouldNotify, false);
});

test("real-time protection warning shows only for an explicit false", function () {
  assert.equal(Core.realTimeProtectionWarning(null), "");
  assert.equal(Core.realTimeProtectionWarning({ state: "idle" }), "");
  assert.equal(Core.realTimeProtectionWarning({ state: "idle", realTimeProtection: null }), "");
  assert.equal(Core.realTimeProtectionWarning({ state: "idle", realTimeProtection: true }), "");
  assert.match(Core.realTimeProtectionWarning({ state: "idle", realTimeProtection: false }), /real-time protection is off/);
});
