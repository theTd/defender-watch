"use strict";
(function (root) {
  const AMSI_LABEL = "AMSI memory scans";
  const DEFAULTS = Object.freeze({
    recordSeconds: 60,
    pauseSeconds: 120,
    retentionDays: 7,
    autoStartCollector: true,
    alert: Object.freeze({ enabled: false, thresholdPct: 5, minutes: 5 })
  });

  function clampNumber(value, fallback, min, max) {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }
  function clampInt(value, fallback, min, max) {
    return Math.round(clampNumber(value, fallback, min, max));
  }
  function numberOr(value, fallback) {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
  function boolOr(value, fallback) {
    return typeof value === "boolean" ? value : fallback;
  }
  function textOr(value, fallback) {
    return typeof value === "string" ? value : fallback;
  }

  function normalizeSettings(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const alert = source.alert && typeof source.alert === "object" ? source.alert : {};
    return {
      recordSeconds: clampInt(source.recordSeconds, DEFAULTS.recordSeconds, 15, 300),
      pauseSeconds: clampInt(source.pauseSeconds, DEFAULTS.pauseSeconds, 0, 3600),
      retentionDays: clampInt(source.retentionDays, DEFAULTS.retentionDays, 1, 90),
      autoStartCollector: boolOr(source.autoStartCollector, DEFAULTS.autoStartCollector),
      alert: {
        enabled: boolOr(alert.enabled, DEFAULTS.alert.enabled),
        thresholdPct: clampNumber(alert.thresholdPct, DEFAULTS.alert.thresholdPct, 1, 100),
        minutes: clampInt(alert.minutes, DEFAULTS.alert.minutes, 1, 120)
      }
    };
  }

  function stringArray(value) {
    if (value === null || value === undefined) return [];
    const list = Array.isArray(value) ? value : [value];
    const result = [];
    for (const item of list) {
      if (item === null || item === undefined) continue;
      const text = String(item).trim();
      if (text) result.push(text);
    }
    return result;
  }

  function normalizeExtension(value) {
    let ext = String(value === null || value === undefined ? "" : value).trim().toLowerCase();
    if (!ext) return "";
    if (!ext.startsWith(".")) ext = "." + ext;
    return ext;
  }

  function normalizeExclusions(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const paths = source.paths ?? source.Path;
    const processes = source.processes ?? source.Process;
    const extensions = source.extensions ?? source.Extension;
    return {
      paths: stringArray(paths),
      processes: stringArray(processes),
      extensions: stringArray(extensions).map(normalizeExtension).filter(Boolean),
      updatedAt: textOr(source.updatedAt, "")
    };
  }

  function displayPath(value) {
    let p = String(value === null || value === undefined ? "" : value).trim();
    if (!p) return "";
    p = p.replace(/\//g, "\\");
    if (/^[a-z]:/i.test(p)) p = p.charAt(0).toUpperCase() + p.slice(1);
    if (p.length > 3) p = p.replace(/\\+$/, "");
    return p;
  }

  function matchPath(value) {
    let p = displayPath(value).toLowerCase();
    if (!p) return "";
    if (p.length > 3) p = p.replace(/\\+$/, "");
    return p;
  }

  function isAbsoluteSegment(segment) {
    return /^[a-z]:[\\/]/i.test(segment) || segment.startsWith("\\\\");
  }

  function isAmsiName(value) {
    return /^MemScanVfz-AMSI-/i.test(String(value || ""));
  }

  function joinPath(prefix, segment) {
    const value = displayPath(segment);
    if (!value) return displayPath(prefix);
    if (isAbsoluteSegment(value)) return value;
    if (!prefix) return value;
    return displayPath(String(prefix).replace(/\\+$/, "") + "\\" + value.replace(/^\\+/, ""));
  }

  function pathDepth(value) {
    if (value === AMSI_LABEL) return 1;
    const p = displayPath(value).replace(/\\+$/, "");
    if (/^[a-z]:$/i.test(p)) return 1;
    return p.split("\\").filter(Boolean).length;
  }

  function leafPaths(report) {
    const result = [];
    let amsiSeconds = 0;
    let amsiCount = 0;
    let amsiMax = 0;
    function walk(node, prefix) {
      if (!node || typeof node !== "object") return;
      const full = joinPath(prefix, node.Path);
      const children = Array.isArray(node.Folder) ? node.Folder.filter(Boolean) : [];
      if (children.length) {
        for (const child of children) walk(child, full);
        return;
      }
      result.push({
        path: full,
        depth: pathDepth(full),
        seconds: numberOr(node.TotalDuration, 0) / 10000000,
        count: Math.trunc(numberOr(node.Count, 0)),
        maxSeconds: numberOr(node.MaxDuration, 0) / 10000000
      });
    }
    for (const node of Array.isArray(report && report.TopPaths) ? report.TopPaths : []) {
      if (!node) continue;
      if (isAmsiName(node.Path)) {
        amsiSeconds += numberOr(node.TotalDuration, 0) / 10000000;
        amsiCount += Math.trunc(numberOr(node.Count, 0));
        amsiMax = Math.max(amsiMax, numberOr(node.MaxDuration, 0) / 10000000);
        continue;
      }
      walk(node, "");
    }
    if (amsiSeconds || amsiCount) {
      result.push({ path: AMSI_LABEL, depth: 1, seconds: amsiSeconds, count: amsiCount, maxSeconds: amsiMax, amsi: true });
    }
    result.sort((a, b) => b.seconds - a.seconds || a.path.localeCompare(b.path));
    return result;
  }

  function normalizeReportEntries(list, key) {
    const result = [];
    for (const entry of Array.isArray(list) ? list : []) {
      if (!entry) continue;
      const value = key === "extension" ? String(entry.Extension ?? "") : String(entry[key] ?? "");
      result.push({
        value,
        seconds: numberOr(entry.TotalDuration, 0) / 10000000,
        count: Math.trunc(numberOr(entry.Count, 0)),
        maxSeconds: numberOr(entry.MaxDuration, 0) / 10000000
      });
    }
    result.sort((a, b) => b.seconds - a.seconds || a.value.localeCompare(b.value));
    return result;
  }

  function flattenReport(report) {
    let total = 0;
    for (const node of Array.isArray(report && report.TopPaths) ? report.TopPaths : []) {
      if (node) total += numberOr(node.TotalDuration, 0);
    }
    return {
      totalScanSeconds: total / 10000000,
      paths: leafPaths(report),
      processes: normalizeReportEntries(report && report.TopProcesses, "ProcessPath").map(function (x) {
        return { path: x.value, seconds: x.seconds, count: x.count, maxSeconds: x.maxSeconds };
      }),
      extensions: normalizeReportEntries(report && report.TopExtensions, "extension").map(function (x) {
        return { extension: x.value, seconds: x.seconds, count: x.count, maxSeconds: x.maxSeconds };
      }),
      files: normalizeReportEntries(report && report.TopFiles, "Path").map(function (x) {
        return { path: x.value, seconds: x.seconds, count: x.count, maxSeconds: x.maxSeconds };
      })
    };
  }

  function rollupPath(value, depth) {
    const requested = clampInt(depth, 2, 2, 6);
    if (value === AMSI_LABEL) return AMSI_LABEL;
    const p = displayPath(value);
    if (!p) return "";
    const parts = p.split("\\").filter(Boolean);
    if (parts.length <= requested) return p;
    return parts.slice(0, requested).join("\\");
  }

  function pathWithin(path, base) {
    const p = matchPath(path);
    const b = matchPath(base);
    if (!p || !b) return false;
    if (p === b) return true;
    if (b.endsWith("\\")) return p.startsWith(b);
    return p.startsWith(b + "\\");
  }

  function isPathExcluded(path, exclusions) {
    const config = Array.isArray(exclusions) ? { paths: exclusions, extensions: [], processes: [] } : normalizeExclusions(exclusions);
    return config.paths.some(function (base) { return pathWithin(path, base); });
  }

  function extensionOf(value) {
    const p = String(value === null || value === undefined ? "" : value).replace(/\//g, "\\");
    const base = p.slice(p.lastIndexOf("\\") + 1);
    const dot = base.lastIndexOf(".");
    if (dot <= 0) return "";
    return base.slice(dot).toLowerCase();
  }

  function isExtensionExcluded(value, exclusions) {
    const config = Array.isArray(exclusions) ? normalizeExclusions({ extensions: exclusions }) : normalizeExclusions(exclusions);
    let ext = extensionOf(value);
    if (!ext && !/[\\/]/.test(String(value))) ext = normalizeExtension(value);
    if (!ext) return false;
    return config.extensions.includes(ext);
  }

  function isFileExcluded(path, exclusions) {
    return isPathExcluded(path, exclusions) || isExtensionExcluded(path, exclusions);
  }

  function processName(value) {
    const p = String(value === null || value === undefined ? "" : value).replace(/\//g, "\\").replace(/\\+$/, "");
    return p.slice(p.lastIndexOf("\\") + 1).toLowerCase();
  }

  function isProcessExcluded(processPath, exclusions) {
    const config = Array.isArray(exclusions) ? normalizeExclusions({ processes: exclusions }) : normalizeExclusions(exclusions);
    const processFull = matchPath(processPath);
    const processBase = processName(processPath);
    if (!processFull) return false;
    return config.processes.some(function (pattern) {
      const normalized = String(pattern).trim();
      if (!normalized) return false;
      if (normalized.includes("\\") || normalized.includes("/")) {
        return matchPath(normalized) === processFull;
      }
      return processName(normalized) === processBase;
    });
  }

  function isAmsiPath(path) {
    return path === AMSI_LABEL;
  }

  function isLikelyFilePath(path) {
    if (isAmsiPath(path)) return false;
    const p = displayPath(path);
    const base = p.slice(p.lastIndexOf("\\") + 1);
    const dot = base.lastIndexOf(".");
    return dot > 0;
  }

  function windowData(entry) {
    return entry && entry.data && typeof entry.data === "object" ? entry.data : entry;
  }

  function windowBounds(window) {
    const data = windowData(window) || {};
    const start = Date.parse(data.start);
    let end = Date.parse(data.end);
    if (!Number.isFinite(end) && Number.isFinite(start)) end = start;
    return { start: Number.isFinite(start) ? start : null, end: Number.isFinite(end) ? end : null };
  }

  function selectedWindows(windows, startMs, endMs) {
    const list = Array.isArray(windows) ? windows : [];
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return list.slice();
    return list.filter(function (entry) {
      const bounds = windowBounds(entry);
      if (bounds.start === null || bounds.end === null) return false;
      return bounds.end >= startMs && bounds.start <= endMs;
    });
  }

  function addAggregate(map, key, path, seconds, count, maxSeconds) {
    let row = map.get(key);
    if (!row) {
      row = { path: path, seconds: 0, count: 0, maxSeconds: 0 };
      map.set(key, row);
    }
    row.seconds += seconds;
    row.count += count;
    row.maxSeconds = Math.max(row.maxSeconds, maxSeconds);
    return row;
  }

  function aggregateWindows(windows, options) {
    const opts = options || {};
    const startMs = Number.isFinite(opts.startMs) ? opts.startMs : null;
    const endMs = Number.isFinite(opts.endMs) ? opts.endMs : null;
    const depth = clampInt(opts.depth, 2, 2, 6);
    const exclusions = normalizeExclusions(opts.exclusions);
    const selected = selectedWindows(windows, startMs, endMs);
    const paths = new Map();
    const processes = new Map();
    const extensions = new Map();
    const files = new Map();
    let recordedSeconds = 0;
    let totalScanSeconds = 0;

    for (const entry of selected) {
      const w = windowData(entry);
      if (!w || typeof w !== "object") continue;
      const record = numberOr(w.recordSeconds, 0);
      recordedSeconds += record > 0 ? record : Math.max(0, ((windowBounds(w) || {}).end || 0) - ((windowBounds(w) || {}).start || 0)) / 1000;
      totalScanSeconds += numberOr(w.totalScanSeconds, 0);
      for (const item of Array.isArray(w.paths) ? w.paths : []) {
        if (!item || !item.path) continue;
        const rolled = rollupPath(item.path, depth);
        if (!rolled) continue;
        const row = addAggregate(paths, rolled.toLowerCase(), rolled, numberOr(item.seconds, 0), Math.trunc(numberOr(item.count, 0)), numberOr(item.maxSeconds, 0));
        if (isAmsiPath(rolled)) {
          row.amsi = true;
        }
      }
      for (const item of Array.isArray(w.processes) ? w.processes : []) {
        if (!item || !item.path) continue;
        addAggregate(processes, matchPath(item.path), displayPath(item.path), numberOr(item.seconds, 0), Math.trunc(numberOr(item.count, 0)), numberOr(item.maxSeconds, 0));
      }
      for (const item of Array.isArray(w.extensions) ? w.extensions : []) {
        const ext = String(item && item.extension !== undefined ? item.extension : "").trim().toLowerCase();
        const key = ext || "(none)";
        addAggregate(extensions, key, ext || "(none)", numberOr(item && item.seconds, 0), Math.trunc(numberOr(item && item.count, 0)), numberOr(item && item.maxSeconds, 0));
      }
      for (const item of Array.isArray(w.files) ? w.files : []) {
        if (!item || !item.path) continue;
        addAggregate(files, matchPath(item.path), displayPath(item.path), numberOr(item.seconds, 0), Math.trunc(numberOr(item.count, 0)), numberOr(item.maxSeconds, 0));
      }
    }

    const pathRows = Array.from(paths.values()).map(function (row) {
      const amsi = row.amsi || isAmsiPath(row.path);
      const excluded = !amsi && (isPathExcluded(row.path, exclusions) || (isLikelyFilePath(row.path) && isExtensionExcluded(row.path, exclusions)));
      return {
        path: row.path,
        depth: amsi ? 1 : pathDepth(row.path),
        seconds: row.seconds,
        count: row.count,
        maxSeconds: row.maxSeconds,
        sharePct: totalScanSeconds > 0 ? row.seconds / totalScanSeconds * 100 : 0,
        perMinuteSeconds: recordedSeconds > 0 ? row.seconds / (recordedSeconds / 60) : 0,
        excluded: excluded,
        amsi: amsi
      };
    }).sort(function (a, b) { return b.seconds - a.seconds || a.path.localeCompare(b.path); });
    const visiblePaths = opts.onlyNotExcluded ? pathRows.filter(function (row) { return !row.excluded; }) : pathRows;

    const processRows = Array.from(processes.values()).map(function (row) {
      return {
        path: row.path,
        seconds: row.seconds,
        count: row.count,
        maxSeconds: row.maxSeconds,
        sharePct: totalScanSeconds > 0 ? row.seconds / totalScanSeconds * 100 : 0,
        excluded: isProcessExcluded(row.path, exclusions)
      };
    }).sort(function (a, b) { return b.seconds - a.seconds || a.path.localeCompare(b.path); });
    const extensionRows = Array.from(extensions.values()).map(function (row) {
      return {
        extension: row.path,
        seconds: row.seconds,
        count: row.count,
        maxSeconds: row.maxSeconds,
        sharePct: totalScanSeconds > 0 ? row.seconds / totalScanSeconds * 100 : 0,
        excluded: row.path !== "(none)" && isExtensionExcluded(row.path, exclusions)
      };
    }).sort(function (a, b) { return b.seconds - a.seconds || a.extension.localeCompare(b.extension); });
    const fileRows = Array.from(files.values()).map(function (row) {
      return {
        path: row.path,
        extension: extensionOf(row.path),
        seconds: row.seconds,
        count: row.count,
        maxSeconds: row.maxSeconds,
        sharePct: totalScanSeconds > 0 ? row.seconds / totalScanSeconds * 100 : 0,
        excluded: isFileExcluded(row.path, exclusions)
      };
    }).sort(function (a, b) { return b.seconds - a.seconds || a.path.localeCompare(b.path); });

    const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.trunc(opts.limit) : 500;
    return {
      windowCount: selected.length,
      recordedSeconds: recordedSeconds,
      recordedMinutes: recordedSeconds / 60,
      totalScanSeconds: totalScanSeconds,
      paths: visiblePaths.slice(0, limit),
      allPathCount: pathRows.length,
      processes: processRows.slice(0, limit),
      extensions: extensionRows.slice(0, limit),
      files: fileRows.slice(0, limit),
      startMs: startMs,
      endMs: endMs,
      depth: depth
    };
  }

  function latestWindow(windows) {
    let latest = null;
    let latestEnd = -Infinity;
    for (const entry of Array.isArray(windows) ? windows : []) {
      const bounds = windowBounds(entry);
      if (bounds.end !== null && bounds.end > latestEnd) {
        latestEnd = bounds.end;
        latest = entry;
      }
    }
    return latest;
  }

  function cpuAverage(samples, startMs, endMs) {
    let sum = 0;
    let count = 0;
    for (const sample of Array.isArray(samples) ? samples : []) {
      const t = typeof sample.tMs === "number" ? sample.tMs : Date.parse(sample.t);
      const pct = numberOr(sample.pct, NaN);
      if (!Number.isFinite(t) || !Number.isFinite(pct)) continue;
      if (Number.isFinite(startMs) && t < startMs) continue;
      if (Number.isFinite(endMs) && t > endMs) continue;
      sum += pct;
      count += 1;
    }
    return count ? sum / count : null;
  }

  function collectorHealth(input) {
    const opts = input || {};
    const runtime = opts.runtime || {};
    const status = opts.status || null;
    const statusMtime = numberOr(opts.statusMtime, 0);
    const now = numberOr(opts.now, Date.now());
    const recordSeconds = clampNumber(opts.recordSeconds, 60, 15, 300);
    const pauseSeconds = clampNumber(opts.pauseSeconds, 120, 0, 3600);
    const staleAfterMs = (recordSeconds + pauseSeconds + 60) * 1000;
    const runtimeError = typeof runtime.error === "string" && runtime.error.trim() ? runtime.error.trim() : "";
    if (runtimeError) {
      return { state: "error", detail: runtimeError, staleAfterSeconds: staleAfterMs / 1000 };
    }
    const phase = String(runtime.phase || "idle");
    const startedAt = numberOr(runtime.startedAt, 0);
    if (phase === "starting") {
      const freshAfterStart = status && statusMtime >= Math.max(0, startedAt - 2000);
      if (!freshAfterStart) {
        return { state: "starting", detail: "Waiting for the Windows UAC prompt. Confirm it to start the elevated collector.", staleAfterSeconds: staleAfterMs / 1000 };
      }
    }
    if (!status) {
      return { state: "not running", detail: "Click Start collector. Windows will ask for administrator permission once per app session.", staleAfterSeconds: staleAfterMs / 1000 };
    }
    const state = String(status.state || "").toLowerCase();
    if (state === "error") {
      const lastError = String(status.lastError || "The collector reported an error.").trim();
      return { state: "error", detail: lastError, staleAfterSeconds: staleAfterMs / 1000 };
    }
    const age = now - statusMtime;
    if (!Number.isFinite(age) || statusMtime <= 0 || age > staleAfterMs) {
      const minutes = statusMtime > 0 ? Math.max(1, Math.round(age / 60000)) : null;
      return {
        state: "stale",
        detail: minutes === null ? "Collector status is unavailable." : "Collector status has not updated for " + minutes + " min. It may have stopped.",
        staleAfterSeconds: staleAfterMs / 1000
      };
    }
    if (phase === "stopping") {
      return { state: "running", detail: "Stopping the elevated collector...", staleAfterSeconds: staleAfterMs / 1000 };
    }
    if (state === "recording") {
      return { state: "running", detail: "Recording a Defender performance window now.", staleAfterSeconds: staleAfterMs / 1000 };
    }
    return { state: "running", detail: "Collector is alive and waiting for the next window.", staleAfterSeconds: staleAfterMs / 1000 };
  }

  function alertDecision(input) {
    const opts = input || {};
    const samples = Array.isArray(opts.samples) ? opts.samples : [];
    const minutes = clampNumber(opts.minutes, 5, 1, 120);
    const thresholdPct = clampNumber(opts.thresholdPct, 5, 1, 100);
    const now = numberOr(opts.now, Date.now());
    const cutoff = now - minutes * 60000;
    const selected = [];
    for (const sample of samples) {
      const t = typeof sample.tMs === "number" ? sample.tMs : Date.parse(sample.t);
      const pct = numberOr(sample.pct, NaN);
      if (Number.isFinite(t) && Number.isFinite(pct) && t >= cutoff && t <= now) selected.push({ t: t, pct: pct });
    }
    if (selected.length < 2) return { shouldNotify: false, averagePct: null, coverageSeconds: 0 };
    const first = selected[0].t;
    const last = selected[selected.length - 1].t;
    const coverageSeconds = (last - first) / 1000;
    const average = selected.reduce(function (sum, s) { return sum + s.pct; }, 0) / selected.length;
    const enough = coverageSeconds >= minutes * 60 - 30;
    const above = average > thresholdPct;
    return {
      shouldNotify: Boolean(opts.enabled) && !opts.alreadyNotified && enough && above,
      averagePct: average,
      coverageSeconds: coverageSeconds,
      enoughHistory: enough,
      aboveThreshold: above
    };
  }

  function exclusionCommand(path) {
    return 'Add-MpPreference -ExclusionPath "' + String(path).replace(/"/g, "") + '"';
  }

  // Only an explicit false from the collector counts; a missing value means unknown.
  function realTimeProtectionWarning(status) {
    if (!status || status.realTimeProtection !== false) return "";
    return "Defender real-time protection is off, so Defender is not scanning files and recording windows stay empty. " +
      "Turn it on in Windows Security > Virus & threat protection > Manage settings.";
  }

  const api = {
    AMSI_LABEL: AMSI_LABEL,
    DEFAULTS: DEFAULTS,
    normalizeSettings: normalizeSettings,
    normalizeExclusions: normalizeExclusions,
    normalizeExtension: normalizeExtension,
    displayPath: displayPath,
    matchPath: matchPath,
    flattenReport: flattenReport,
    leafPaths: leafPaths,
    rollupPath: rollupPath,
    pathDepth: pathDepth,
    pathWithin: pathWithin,
    isPathExcluded: isPathExcluded,
    extensionOf: extensionOf,
    isExtensionExcluded: isExtensionExcluded,
    isFileExcluded: isFileExcluded,
    isProcessExcluded: isProcessExcluded,
    aggregateWindows: aggregateWindows,
    selectedWindows: selectedWindows,
    latestWindow: latestWindow,
    cpuAverage: cpuAverage,
    collectorHealth: collectorHealth,
    alertDecision: alertDecision,
    realTimeProtectionWarning: realTimeProtectionWarning,
    exclusionCommand: exclusionCommand
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.DefenderCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
