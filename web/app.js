"use strict";
const invoke = window.__TAURI__.core.invoke;
const Core = window.DefenderCore;
const $ = function (id) { return document.getElementById(id); };
const INTERVALS = { last: null, "15": 15, "60": 60, "360": 360, "1440": 1440, "10080": 10080 };
const state = {
  settings: Core.normalizeSettings(null),
  exclusions: Core.normalizeExclusions(null),
  status: null,
  statusMtime: 0,
  collector: { state: "not running", detail: "Waiting for the first status check." },
  runtime: { phase: "idle" },
  latestWindow: null,
  windows: [],
  intervalCpu: [],
  recentCpu: [],
  interval: "last",
  depth: 2,
  onlyNotExcluded: true,
  tab: "processes",
  dataDir: "—",
  windowCount: 0,
  cpuCount: 1,
  lastCpuT: Date.now() - 65 * 60000,
  intervalLoaded: false,
  intervalStart: null,
  intervalEnd: null,
  latestSignature: "",
  busy: false,
  dirty: false,
  startPending: false,
  autoStartAttempted: false,
  errorMessage: "",
  notice: "",
  alertNotified: false,
  latestCpu: null
};
let noticeTimer = null;

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
}
function fmtPct(value) {
  return value === null || value === undefined || !Number.isFinite(Number(value)) ? "—" : Number(value).toFixed(2) + "%";
}
function fmtCores(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  return (Number(value) / 100 * state.cpuCount).toFixed(2) + " cores";
}
function fmtSeconds(value) {
  if (!Number.isFinite(Number(value))) return "—";
  const n = Number(value);
  return n >= 60 ? (n / 60).toFixed(2) + " min" : n.toFixed(2) + " s";
}
function fmtCount(value) {
  return new Intl.NumberFormat().format(num(value, 0));
}
function fmtTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}
function fmtClock(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function fmtMinutes(value) {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) return "—";
  const n = Number(value);
  return n >= 90 ? (n / 60).toFixed(1) + " h" : Math.round(n) + " min";
}
function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}
function showError(message) {
  state.errorMessage = String(message || "").trim();
}
function setNotice(message) {
  state.notice = String(message || "");
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(function () {
    state.notice = "";
    render();
  }, 7000);
}
function setFeedback(message) {
  setText("feedback", message || "");
}
function normalizeSamples(list) {
  const result = [];
  for (const sample of Array.isArray(list) ? list : []) {
    if (!sample) continue;
    const t = typeof sample.tMs === "number" ? sample.tMs : Date.parse(sample.t);
    const pct = Number(sample.pct);
    if (Number.isFinite(t) && Number.isFinite(pct)) result.push({ tMs: t, pct: pct });
  }
  result.sort(function (a, b) { return a.tMs - b.tMs; });
  return result;
}
function mergeSamples(a, b) {
  const map = new Map();
  for (const sample of (Array.isArray(a) ? a : []).concat(Array.isArray(b) ? b : [])) {
    if (!sample) continue;
    const t = typeof sample.tMs === "number" ? sample.tMs : Date.parse(sample.t);
    const pct = Number(sample.pct);
    if (Number.isFinite(t) && Number.isFinite(pct)) map.set(t, { tMs: t, pct: pct });
  }
  return Array.from(map.values()).sort(function (x, y) { return x.tMs - y.tMs; });
}
function appendRecent(list) {
  const incoming = normalizeSamples(list);
  if (!incoming.length) return;
  state.recentCpu = mergeSamples(state.recentCpu, incoming);
  const cutoff = Date.now() - 3 * 60 * 60 * 1000;
  state.recentCpu = state.recentCpu.filter(function (sample) { return sample.tMs >= cutoff; });
  const newest = state.recentCpu[state.recentCpu.length - 1];
  if (newest) state.latestCpu = newest;
}
function currentBounds() {
  if (state.interval === "last") {
    const data = state.latestWindow && state.latestWindow.data;
    if (!data) return null;
    const start = Date.parse(data.start);
    const end = Date.parse(data.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    return { start: start, end: end };
  }
  const minutes = INTERVALS[state.interval];
  const end = Date.now();
  return { start: end - minutes * 60000, end: end };
}
function intervalLabel() {
  if (state.interval === "last") return "Last window";
  const minutes = INTERVALS[state.interval];
  return minutes < 60 ? minutes + " min" : minutes < 1440 ? (minutes / 60) + " h" : (minutes / 1440) + " d";
}
function currentWindows() {
  if (state.interval === "last") return state.latestWindow ? [state.latestWindow] : [];
  const bounds = currentBounds();
  if (!bounds) return [];
  return state.windows.filter(function (entry) {
    const data = entry && entry.data ? entry.data : entry;
    const start = Date.parse(data && data.start);
    const end = Date.parse(data && data.end);
    return Number.isFinite(start) && Number.isFinite(end) && end >= bounds.start && start <= bounds.end;
  });
}
function mergedIntervalCpu() {
  const bounds = currentBounds();
  if (!bounds) return [];
  const recent = state.recentCpu.filter(function (sample) { return sample.tMs >= bounds.start && sample.tMs <= bounds.end; });
  return mergeSamples(state.intervalCpu, recent);
}
function aggregate() {
  const bounds = currentBounds();
  if (!bounds) {
    return { windowCount: 0, recordedSeconds: 0, recordedMinutes: 0, totalScanSeconds: 0, paths: [], allPathCount: 0, processes: [], extensions: [], files: [], startMs: 0, endMs: 0, depth: state.depth };
  }
  return Core.aggregateWindows(currentWindows(), {
    startMs: bounds.start,
    endMs: bounds.end,
    depth: state.depth,
    exclusions: state.exclusions,
    onlyNotExcluded: state.onlyNotExcluded,
    limit: 500
  });
}
function collectorClass(value) {
  const stateName = String(value || "").toLowerCase();
  if (stateName === "error") return "error";
  if (stateName === "stale") return "warn";
  if (stateName === "starting") return "starting";
  if (stateName === "not running") return "off";
  return "";
}
function collectorLabel(value) {
  const stateName = String(value || "").toLowerCase();
  if (stateName === "not running") return "Collector not running";
  if (stateName === "starting") return "Collector starting";
  if (stateName === "stale") return "Collector stale";
  if (stateName === "error") return "Collector error";
  return "Collector running";
}
function topNotExcludedPath() {
  if (!state.latestWindow) return "";
  const result = Core.aggregateWindows([state.latestWindow], {
    depth: 3,
    exclusions: state.exclusions,
    onlyNotExcluded: true,
    limit: 20
  });
  const row = result.paths.find(function (item) { return !item.amsi; });
  return row ? row.path : "";
}
function evaluateAlert() {
  const alertSettings = state.settings.alert;
  if (!alertSettings || !alertSettings.enabled) {
    state.alertNotified = false;
    return;
  }
  const decision = Core.alertDecision({
    samples: state.recentCpu,
    minutes: alertSettings.minutes,
    thresholdPct: alertSettings.thresholdPct,
    now: Date.now(),
    enabled: true,
    alreadyNotified: state.alertNotified
  });
  if (decision.averagePct !== null && !decision.aboveThreshold) state.alertNotified = false;
  if (!decision.shouldNotify) return;
  state.alertNotified = true;
  const topPath = topNotExcludedPath();
  const body = "MsMpEng averaged " + decision.averagePct.toFixed(2) + "% of total CPU over " + alertSettings.minutes + " min." +
    (topPath ? " Top not-excluded path in the latest window: " + topPath : " No not-excluded hot path was recorded in the latest window.");
  invoke("notify_alert", { title: "Defender Watch — MsMpEng CPU alert", body: body })
    .then(function () { setNotice("Desktop alert sent: " + body); })
    .catch(function (error) { showError("Could not send the desktop alert: " + error); });
}
function appendCell(row, text, className, title) {
  const td = document.createElement("td");
  td.textContent = text;
  td.className = className || "";
  if (title) td.title = title;
  row.append(td);
  return td;
}
function addBadge(row, text, kind, title) {
  const td = document.createElement("td");
  const badge = document.createElement("span");
  badge.className = "badge " + kind;
  badge.textContent = text;
  if (title) badge.title = title;
  td.append(badge);
  row.append(td);
}
function addEmptyRow(tbody, columns, message) {
  const row = document.createElement("tr");
  const td = document.createElement("td");
  td.colSpan = columns;
  td.className = "empty";
  td.textContent = message;
  row.append(td);
  tbody.append(row);
}
async function copyExclusion(path) {
  const command = Core.exclusionCommand(path);
  try {
    await invoke("copy_text", { text: command });
    setFeedback("Copied: " + command);
  } catch (error) {
    try {
      await navigator.clipboard.writeText(command);
      setFeedback("Copied: " + command);
    } catch (fallbackError) {
      setFeedback("Could not copy the command: " + error);
    }
  }
}
function renderSettings() {
  const s = state.settings;
  if (!s) return;
  if (!state.dirty) {
    $("record-seconds").value = s.recordSeconds;
    $("pause-seconds").value = s.pauseSeconds;
    $("retention-days").value = s.retentionDays;
    $("auto-start").checked = s.autoStartCollector;
    $("alert-enabled").checked = s.alert.enabled;
    $("alert-threshold").value = s.alert.thresholdPct;
    $("alert-minutes").value = s.alert.minutes;
  }
  $("alert-threshold").disabled = !$("alert-enabled").checked;
  $("alert-minutes").disabled = !$("alert-enabled").checked;
}
function renderHeader(bounds, stats) {
  const health = state.collector || { state: "not running", detail: "" };
  const pill = $("collector-status");
  pill.textContent = collectorLabel(health.state);
  pill.className = "status-pill " + collectorClass(health.state);
  pill.title = health.detail || "";
  const latest = state.latestCpu;
  const headerCrypto = $("header-cpu");
  headerCrypto.replaceChildren();
  const label = document.createElement("span");
  label.textContent = "MsMpEng ";
  const strong = document.createElement("strong");
  strong.textContent = latest ? fmtPct(latest.pct) : "—";
  const rest = document.createElement("span");
  rest.textContent = latest ? " now" : " waiting for samples";
  headerCrypto.append(label, strong, rest);
  const avg = stats.average;
  const avgSpan = document.createElement("span");
  avgSpan.textContent = avg === null ? " · avg —" : " · avg " + fmtPct(avg);
  headerCrypto.append(avgSpan);
  const latestData = state.latestWindow && state.latestWindow.data;
  if (latestData && latestData.end) {
    setText("header-window", "Last window " + fmtClock(latestData.end) + " · " + fmtSeconds(latestData.recordSeconds));
  } else {
    setText("header-window", "No recording window yet");
  }
  $("start-collector").disabled = state.startPending || health.state === "running" || health.state === "starting";
  $("stop-collector").disabled = state.startPending || (health.state !== "running" && health.state !== "starting");
  $("record-now").disabled = health.state !== "running";
}
function renderStats(agg, bounds) {
  const latest = state.latestCpu;
  setText("stat-cpu", latest ? fmtPct(latest.pct) : "—");
  setText("stat-cpu-note", latest ? fmtCores(latest.pct) + " · sample " + fmtClock(latest.tMs) : "No CPU sample yet. Start the collector.");
  const average = bounds ? Core.cpuAverage(mergedIntervalCpu(), bounds.start, bounds.end) : null;
  setText("stat-average", fmtPct(average));
  setText("stat-average-note", average === null ? "No samples in this interval" : fmtCores(average) + " · " + intervalLabel() + " · " + fmtCount(mergedIntervalCpu().length) + " samples");
  const latestData = state.latestWindow && state.latestWindow.data;
  setText("stat-window", latestData && latestData.end ? fmtClock(latestData.end) : "—");
  setText("stat-window-note", latestData ? fmtSeconds(latestData.recordSeconds) + " recording · " + fmtTime(latestData.end) : "No windows in the data folder");
  setText("stat-collector", collectorLabel(state.collector && state.collector.state));
  setText("stat-collector-note", (state.collector && state.collector.detail) || "");
}
function renderPaths(agg) {
  const tbody = $("path-rows");
  tbody.replaceChildren();
  if (!agg.paths.length) {
    addEmptyRow(tbody, 7, state.onlyNotExcluded && agg.allPathCount
      ? "Every hot path in this interval is already excluded. Clear Only not excluded to inspect them."
      : "No scan paths in the selected interval yet. Leave the app open so the collector can record a window.");
  }
  for (const row of agg.paths) {
    const tr = document.createElement("tr");
    const pathCell = appendCell(tr, row.path, "path-cell", row.path);
    if (row.amsi) pathCell.title = "AMSI memory scans are aggregated into one entry. There is no file path to exclude.";
    appendCell(tr, fmtSeconds(row.seconds), "num");
    appendCell(tr, fmtCount(row.count), "num");
    appendCell(tr, row.sharePct.toFixed(1) + "%", "num");
    appendCell(tr, row.perMinuteSeconds.toFixed(2) + " s", "num");
    if (row.amsi) {
      addBadge(tr, "Memory scan", "special", "Not a filesystem path.");
    } else {
      addBadge(tr, row.excluded ? "Excluded" : "Not excluded", row.excluded ? "excluded" : "not-excluded",
        row.excluded ? "This path is covered by a Defender path exclusion or an extension exclusion." : "This path is not covered by a Defender exclusion.");
    }
    const action = document.createElement("td");
    if (!row.excluded && !row.amsi) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "small";
      button.textContent = "Copy exclusion command";
      button.addEventListener("click", function () { copyExclusion(row.path); });
      action.append(button);
    } else {
      action.textContent = "—";
      action.className = "muted";
    }
    tr.append(action);
    tbody.append(tr);
  }
  const summary = agg.windowCount
    ? agg.windowCount + " window" + (agg.windowCount === 1 ? "" : "s") + " · " + fmtMinutes(agg.recordedMinutes) + " recorded · " + fmtSeconds(agg.totalScanSeconds) + " total scan time · " + agg.allPathCount + " path groups at depth " + state.depth
    : "Waiting for a recording window.";
  setText("path-summary", summary + " · Only not excluded " + (state.onlyNotExcluded ? "on" : "off"));
}
function renderTop(agg) {
  const thead = $("top-head");
  const tbody = $("top-rows");
  thead.replaceChildren();
  tbody.replaceChildren();
  const head = document.createElement("tr");
  if (state.tab === "processes") {
    ["Process", "Scan seconds", "Scans", "Share", "Excluded"].forEach(function (text, index) {
      const th = document.createElement("th");
      th.textContent = text;
      if (index > 0 && index < 4) th.className = "num";
      head.append(th);
    });
  } else if (state.tab === "extensions") {
    ["Extension", "Scan seconds", "Scans", "Share", "Excluded"].forEach(function (text, index) {
      const th = document.createElement("th");
      th.textContent = text;
      if (index > 0 && index < 4) th.className = "num";
      head.append(th);
    });
  } else {
    ["File", "Scan seconds", "Scans", "Share", "Excluded"].forEach(function (text, index) {
      const th = document.createElement("th");
      th.textContent = text;
      if (index > 0 && index < 4) th.className = "num";
      head.append(th);
    });
  }
  thead.append(head);
  const rows = state.tab === "processes" ? agg.processes : state.tab === "extensions" ? agg.extensions : agg.files;
  if (!rows.length) {
    addEmptyRow(tbody, 5, "No activity in the selected interval.");
  }
  for (const row of rows) {
    const tr = document.createElement("tr");
    if (state.tab === "extensions") {
      appendCell(tr, row.extension || "(none)", "path-cell", row.extension || "No extension");
    } else {
      appendCell(tr, row.path, "path-cell", row.path);
    }
    appendCell(tr, fmtSeconds(row.seconds), "num");
    appendCell(tr, fmtCount(row.count), "num");
    appendCell(tr, row.sharePct.toFixed(1) + "%", "num");
    addBadge(tr, row.excluded ? "Excluded" : "Not excluded", row.excluded ? "excluded" : "not-excluded",
      row.excluded ? "Covered by a Defender exclusion." : "No matching Defender exclusion.");
    tbody.append(tr);
  }
  const unit = state.tab === "processes" ? "processes" : state.tab === "extensions" ? "extensions" : "files";
  setText("top-summary", rows.length + " " + unit + " · " + agg.windowCount + " window" + (agg.windowCount === 1 ? "" : "s") + " · " + fmtMinutes(agg.recordedMinutes) + " recorded");
  const exclusions = state.exclusions;
  setText("exclusion-summary", "Exclusions: " + exclusions.paths.length + " paths · " + exclusions.processes.length + " processes · " + exclusions.extensions.length + " extensions" +
    (exclusions.updatedAt ? " · updated " + fmtTime(exclusions.updatedAt) : " · no exclusions.json yet"));
}
function render() {
  const bounds = currentBounds();
  const agg = aggregate();
  const average = bounds ? Core.cpuAverage(mergedIntervalCpu(), bounds.start, bounds.end) : null;
  const stats = { average: average };
  renderHeader(bounds, stats);
  const errorParts = [];
  if (state.errorMessage) errorParts.push(state.errorMessage);
  if (state.collector && state.collector.state === "error" && state.collector.detail) errorParts.push(state.collector.detail);
  const errorEl = $("error");
  if (errorParts.length) {
    errorEl.textContent = errorParts.join("\n\n");
    errorEl.hidden = false;
  } else {
    errorEl.hidden = true;
  }
  const rtpEl = $("rtp-warning");
  const rtpWarning = Core.realTimeProtectionWarning(state.status);
  rtpEl.textContent = rtpWarning;
  rtpEl.hidden = !rtpWarning;
  const noticeEl = $("notice");
  if (state.notice) {
    noticeEl.textContent = state.notice;
    noticeEl.hidden = false;
  } else {
    noticeEl.hidden = true;
  }
  renderStats(agg, bounds);
  setText("interval-state", intervalLabel());
  setText("interval-caption", state.interval === "last"
    ? "The newest completed recording window."
    : "All recording windows overlapping the last " + intervalLabel() + ".");
  document.querySelectorAll("#interval-presets button").forEach(function (button) {
    button.classList.toggle("selected", button.dataset.interval === state.interval);
  });
  if (bounds) {
    setText("trend-caption", fmtTime(bounds.start) + " to " + fmtTime(bounds.end) + " · " + fmtCount(mergedIntervalCpu().length) + " CPU samples · shaded bands are recording windows");
    setText("trend-scale", "% of total CPU");
    if (window.renderCpuChart) window.renderCpuChart($("cpu-chart"), mergedIntervalCpu(), currentWindows(), bounds.start, bounds.end, $("trend-reading"));
  } else {
    setText("trend-caption", "Waiting for the first recording window");
    if (window.renderCpuChart) window.renderCpuChart($("cpu-chart"), [], [], Date.now() - 60000, Date.now(), $("trend-reading"));
  }
  renderPaths(agg);
  renderTop(agg);
  document.querySelectorAll(".tabs button").forEach(function (button) {
    button.classList.toggle("selected", button.dataset.tab === state.tab);
    button.setAttribute("aria-selected", button.dataset.tab === state.tab ? "true" : "false");
  });
  renderSettings();
  setText("data-folder", "Data folder: " + state.dataDir + " · " + state.windowCount + " window files");
}
async function loadInterval() {
  const bounds = currentBounds();
  if (!bounds) {
    state.windows = [];
    state.intervalCpu = [];
    state.intervalStart = null;
    state.intervalEnd = null;
    state.intervalLoaded = true;
    return;
  }
  const data = await invoke("interval_data", { startMs: Math.round(bounds.start), endMs: Math.round(bounds.end) });
  state.windows = Array.isArray(data.windows) ? data.windows : [];
  state.intervalCpu = normalizeSamples(data.cpu || []);
  state.intervalStart = bounds.start;
  state.intervalEnd = bounds.end;
  state.intervalLoaded = true;
}
async function refresh(payload) {
  const visible = !payload || payload.visible !== false;
  if (state.busy) return;
  state.busy = true;
  try {
    const data = await invoke("dashboard_state", { cpuSinceMs: Math.floor(state.lastCpuT) });
    state.settings = Core.normalizeSettings(data.settings);
    state.exclusions = Core.normalizeExclusions(data.exclusions);
    state.status = data.status || null;
    state.statusMtime = num(data.statusMtime, 0);
    state.runtime = data.runtime || { phase: "idle" };
    state.collector = Core.collectorHealth({
      status: state.status,
      statusMtime: state.statusMtime,
      now: num(data.now, Date.now()),
      recordSeconds: state.settings.recordSeconds,
      pauseSeconds: state.settings.pauseSeconds,
      runtime: state.runtime
    });
    state.latestWindow = data.latestWindow || null;
    state.windowCount = num(data.windowCount, 0);
    state.cpuCount = Math.max(1, num(data.cpuCount, 1));
    state.dataDir = data.dataDir || "—";
    appendRecent(data.cpu || []);
    state.lastCpuT = Math.max(state.lastCpuT, num(data.now, Date.now()) - 10000);
    const latestData = state.latestWindow && state.latestWindow.data;
    const latestEnd = latestData ? Date.parse(latestData.end) : 0;
    const signature = state.latestWindow ? String(state.latestWindow.file || "") + ":" + num(state.latestWindow.mtime, 0) + ":" + latestEnd : "none";
    if (!state.intervalLoaded || signature !== state.latestSignature || state.interval !== "last" && !state.windows.length) {
      await loadInterval();
      state.latestSignature = signature;
    }
    state.errorMessage = "";
    if (state.settings.autoStartCollector && !state.autoStartAttempted && (state.collector.state === "not running" || state.collector.state === "stale")) {
      state.autoStartAttempted = true;
      startCollector(true);
    }
    evaluateAlert();
    if (visible) render();
  } catch (error) {
    showError("Could not read the Defender Watch data: " + error);
    if (visible) render();
  } finally {
    state.busy = false;
  }
}
function refreshNow() {
  window.dashboardRefresh.refreshNow().catch(function (error) {
    showError("Refresh failed: " + error);
    render();
  });
}
async function startCollector(auto) {
  if (state.startPending) return;
  state.startPending = true;
  state.errorMessage = "";
  state.collector = { state: "starting", detail: "Waiting for the Windows UAC prompt. Confirm it to start the elevated collector." };
  if (!auto) setFeedback("Waiting for the Windows UAC prompt…");
  render();
  try {
    await invoke("start_collector");
    setFeedback(auto ? "Collector start requested. Confirm the Windows UAC prompt if it is still visible." : "Collector start requested.");
    setNotice("The collector is starting. Its first recording window can take about a minute.");
  } catch (error) {
    showError(String(error));
    setFeedback("Collector start failed.");
  } finally {
    state.startPending = false;
    setTimeout(refreshNow, 1200);
  }
}
async function stopCollector() {
  setFeedback("Stopping the elevated collector…");
  try {
    await invoke("stop_collector");
    state.runtime = { phase: "stopping" };
    state.collector = { state: "running", detail: "Stopping the elevated collector..." };
    render();
    setNotice("Stop requested. The collector exits within a few seconds and removes its status file.");
    setTimeout(refreshNow, 1800);
  } catch (error) {
    showError("Could not stop the collector: " + error);
    render();
  }
}
async function recordNow() {
  setFeedback("Requesting a recording…");
  try {
    await invoke("record_now");
    setNotice("Recording requested. If a window is being recorded, the next one starts as soon as it finishes.");
    setFeedback("Record requested");
    setTimeout(refreshNow, 2500);
  } catch (error) {
    showError("Could not request a recording: " + error);
    setFeedback("Record request failed.");
    render();
  }
}
async function saveSettings(event) {
  event.preventDefault();
  const settings = Core.normalizeSettings({
    recordSeconds: Number($("record-seconds").value),
    pauseSeconds: Number($("pause-seconds").value),
    retentionDays: Number($("retention-days").value),
    autoStartCollector: $("auto-start").checked,
    alert: {
      enabled: $("alert-enabled").checked,
      thresholdPct: Number($("alert-threshold").value),
      minutes: Number($("alert-minutes").value)
    }
  });
  try {
    const saved = await invoke("save_settings", { settings: settings });
    state.settings = Core.normalizeSettings(saved);
    state.dirty = false;
    setFeedback("Settings saved. The collector applies them on its next cycle.");
    setNotice("Settings saved. The elevated collector reads settings.json on its next cycle.");
    render();
    refreshNow();
  } catch (error) {
    showError("Could not save settings: " + error);
    setFeedback("Save failed.");
    render();
  }
}
function attachEvents() {
  document.querySelectorAll("#interval-presets button").forEach(function (button) {
    button.addEventListener("click", function () {
      state.interval = button.dataset.interval;
      state.intervalLoaded = false;
      render();
      refreshNow();
    });
  });
  $("path-depth").addEventListener("change", function () {
    state.depth = Number($("path-depth").value);
    render();
  });
  $("only-excluded").addEventListener("change", function () {
    state.onlyNotExcluded = $("only-excluded").checked;
    render();
  });
  document.querySelectorAll(".tabs button").forEach(function (button) {
    button.addEventListener("click", function () {
      state.tab = button.dataset.tab;
      render();
    });
  });
  $("settings-form").addEventListener("input", function (event) {
    if (event.target && event.target.closest && event.target.closest("#settings-form")) {
      state.dirty = true;
      if (event.target.id === "alert-enabled") {
        $("alert-threshold").disabled = !$("alert-enabled").checked;
        $("alert-minutes").disabled = !$("alert-enabled").checked;
      }
    }
  });
  $("settings-form").addEventListener("submit", saveSettings);
  $("test-alert").addEventListener("click", function () {
    invoke("notify_alert", {
      title: "Defender Watch — test alert",
      body: "Desktop alerts are connected. Windows notification settings decide whether a banner appears. Current top path: " + (topNotExcludedPath() || "none recorded")
    }).then(function () {
      setFeedback("Test alert submitted to Windows.");
      setNotice("Test alert submitted to Windows.");
      render();
    }).catch(function (error) {
      showError("Could not send the test alert: " + error);
      render();
    });
  });
  $("open-data").addEventListener("click", function () {
    invoke("open_data_folder").catch(function (error) {
      showError("Could not open the data folder: " + error);
      render();
    });
  });
  $("start-collector").addEventListener("click", function () { startCollector(false); });
  $("stop-collector").addEventListener("click", stopCollector);
  $("record-now").addEventListener("click", recordNow);
}
function init() {
  $("path-depth").value = String(state.depth);
  $("only-excluded").checked = state.onlyNotExcluded;
  attachEvents();
  render();
  window.dashboardRefresh.subscribe(function (payload) {
    refresh(payload);
  });
}
init();
