"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const Core = require("../web/defender-core.js");

const fixture = path.join(__dirname, "fixtures", "report.json");
const exclusionsFixture = path.join(__dirname, "fixtures", "exclusions.json");
const collector = path.join(__dirname, "..", "collector", "collector.ps1");
const tempDir = path.join(__dirname, ".tmp");

function aggregateByKey(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    let item = map.get(key);
    if (!item) {
      item = { path: row.path || row.extension || "", seconds: 0, count: 0, maxSeconds: 0 };
      map.set(key, item);
    }
    item.seconds += Number(row.seconds) || 0;
    item.count += Number(row.count) || 0;
    item.maxSeconds = Math.max(item.maxSeconds, Number(row.maxSeconds) || 0);
  }
  return map;
}

test("collector -ConvertOnly matches the JS flattening expectations", function () {
  fs.mkdirSync(tempDir, { recursive: true });
  const output = path.join(tempDir, "converted-" + process.pid + "-" + Date.now() + ".json");
  try {
    const result = spawnSync("pwsh", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      collector,
      "-ConvertOnly",
      fixture,
      output
    ], { encoding: "utf8", timeout: 120000 });
    assert.equal(result.status, 0, "collector failed: " + (result.stderr || result.stdout));
    assert.ok(fs.existsSync(output), "collector did not write the output window");
    const window = JSON.parse(fs.readFileSync(output, "utf8"));
    const report = JSON.parse(fs.readFileSync(fixture, "utf8"));
    const js = Core.flattenReport(report);

    assert.equal(window.schema, 1);
    assert.equal(window.recordSeconds, 90);
    assert.ok(Number.isFinite(window.collectorSeconds));
    assert.equal(window.paths.length, 184);
    assert.equal(window.processes.length, 25);
    assert.equal(window.extensions.length, 20);
    assert.equal(window.files.length, 40);
    assert.ok(Math.abs(window.totalScanSeconds - js.totalScanSeconds) < 1e-7);

    const psPaths = aggregateByKey(window.paths, function (row) { return String(row.path).toLowerCase(); });
    const jsPaths = aggregateByKey(js.paths, function (row) { return String(row.path).toLowerCase(); });
    assert.equal(psPaths.size, jsPaths.size);
    for (const [key, expected] of jsPaths) {
      const actual = psPaths.get(key);
      assert.ok(actual, "collector is missing " + key);
      assert.equal(actual.count, expected.count, "count for " + key);
      assert.ok(Math.abs(actual.seconds - expected.seconds) < 1e-6, "seconds for " + key);
      assert.ok(Math.abs(actual.maxSeconds - expected.maxSeconds) < 1e-6, "max seconds for " + key);
    }
    const amsi = window.paths.filter(function (row) { return row.path === "AMSI memory scans"; });
    assert.equal(amsi.length, 1);
    assert.equal(amsi[0].count, 38);
    assert.ok(window.paths.some(function (row) { return row.path === "C:\\WINDOWS\\Prefetch\\BASH.EXE-588D66F0.pf"; }));

    const psProcesses = aggregateByKey(window.processes, function (row) { return String(row.path).toLowerCase(); });
    const jsProcesses = aggregateByKey(js.processes, function (row) { return String(row.path).toLowerCase(); });
    assert.equal(psProcesses.size, jsProcesses.size);
    const psExtensions = aggregateByKey(window.extensions, function (row) { return String(row.extension).toLowerCase(); });
    const jsExtensions = aggregateByKey(js.extensions, function (row) { return String(row.extension).toLowerCase(); });
    assert.equal(psExtensions.size, jsExtensions.size);
    const psFiles = aggregateByKey(window.files, function (row) { return String(row.path).toLowerCase(); });
    const jsFiles = aggregateByKey(js.files, function (row) { return String(row.path).toLowerCase(); });
    assert.equal(psFiles.size, jsFiles.size);

    const fixtureExclusions = JSON.parse(fs.readFileSync(exclusionsFixture, "utf8"));
    const exclusions = Core.normalizeExclusions(fixtureExclusions);
    assert.ok(exclusions.paths.length > 0);
    assert.ok(exclusions.processes.length > 0);
  } finally {
    try { fs.unlinkSync(output); } catch (_) {}
  }
});
