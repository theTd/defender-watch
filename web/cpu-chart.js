"use strict";
(function (root) {
  function toMillis(value) {
    if (typeof value === "number") return value;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function buildSeries(samples, startMs, endMs, maxPoints) {
    const limit = Math.max(16, Math.trunc(maxPoints || 320));
    const points = [];
    for (const sample of Array.isArray(samples) ? samples : []) {
      const t = typeof sample.tMs === "number" ? sample.tMs : toMillis(sample.t);
      const pct = Number(sample && sample.pct);
      if (!Number.isFinite(t) || !Number.isFinite(pct)) continue;
      if (Number.isFinite(startMs) && t < startMs) continue;
      if (Number.isFinite(endMs) && t > endMs) continue;
      points.push({ tMs: t, pct: pct });
    }
    points.sort(function (a, b) { return a.tMs - b.tMs; });
    if (points.length <= limit) return points;
    const from = Number.isFinite(startMs) ? startMs : points[0].tMs;
    const to = Number.isFinite(endMs) ? endMs : points[points.length - 1].tMs;
    const span = Math.max(1, to - from);
    const buckets = new Map();
    for (const point of points) {
      const index = Math.min(limit - 1, Math.max(0, Math.floor((point.tMs - from) / span * limit)));
      let bucket = buckets.get(index);
      if (!bucket) {
        bucket = { sum: 0, count: 0, first: point.tMs, last: point.tMs };
        buckets.set(index, bucket);
      }
      bucket.sum += point.pct;
      bucket.count += 1;
      bucket.last = point.tMs;
    }
    return Array.from(buckets.entries()).sort(function (a, b) { return a[0] - b[0]; }).map(function (pair) {
      const bucket = pair[1];
      return { tMs: Math.round((bucket.first + bucket.last) / 2), pct: bucket.sum / bucket.count };
    });
  }

  function geometry(points, width, height, padding, fixedMax) {
    const values = points.map(function (point) { return point.pct; });
    const finite = values.filter(function (value) { return Number.isFinite(value); });
    const observed = finite.length ? Math.max.apply(null, finite) : 0;
    const rawMax = fixedMax || Math.max(5, Math.ceil(observed / 5) * 5);
    const max = Math.min(100, Math.max(1, rawMax));
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;
    const x = function (index) {
      if (points.length <= 1) return padding.left + plotWidth / 2;
      return padding.left + index / (points.length - 1) * plotWidth;
    };
    const y = function (value) { return padding.top + (1 - Math.min(max, Math.max(0, value)) / max) * plotHeight; };
    let path = "";
    points.forEach(function (point, index) {
      path += (index ? "L" : "M") + x(index).toFixed(2) + "," + y(point.pct).toFixed(2) + " ";
    });
    return { max: max, path: path.trim(), x: x, y: y, width: width, height: height, padding: padding };
  }

  function formatPct(value) {
    if (!Number.isFinite(value)) return "no data";
    return value.toFixed(2) + "%";
  }

  if (typeof document === "undefined") {
    const pure = { buildSeries: buildSeries, geometry: geometry };
    if (typeof module !== "undefined" && module.exports) module.exports = pure;
    root.CpuChart = pure;
    return;
  }

  function svgElement(name, attrs) {
    const element = document.createElementNS("http://www.w3.org/2000/svg", name);
    for (const [key, value] of Object.entries(attrs || {})) element.setAttribute(key, value);
    return element;
  }

  function render(svg, samples, windows, startMs, endMs, readingElement) {
    const width = 1000;
    const height = 280;
    const padding = { left: 64, right: 18, top: 18, bottom: 38 };
    svg.replaceChildren();
    const points = buildSeries(samples, startMs, endMs, 320);
    if (!points.length) {
      svg.setAttribute("aria-label", "MsMpEng CPU trend. No samples in this interval.");
      if (readingElement) readingElement.textContent = "No CPU samples in this interval. Start the collector and wait for the first sample.";
      return null;
    }
    const plot = geometry(points, width, height, padding);
    svg.setAttribute("aria-label", "MsMpEng CPU trend from " + new Date(startMs).toLocaleString() + " to " + new Date(endMs).toLocaleString() + ". Use arrow keys to inspect samples.");
    for (const window of Array.isArray(windows) ? windows : []) {
      const data = window && window.data ? window.data : window;
      const ws = toMillis(data && data.start);
      const we = toMillis(data && data.end);
      if (ws === null || we === null) continue;
      const left = Math.max(startMs, ws);
      const right = Math.min(endMs, we);
      if (right < left) continue;
      const x1 = padding.left + (left - startMs) / Math.max(1, endMs - startMs) * (width - padding.left - padding.right);
      const x2 = padding.left + (right - startMs) / Math.max(1, endMs - startMs) * (width - padding.left - padding.right);
      svg.append(svgElement("rect", {
        x: x1.toFixed(2),
        y: padding.top,
        width: Math.max(2, x2 - x1).toFixed(2),
        height: (height - padding.top - padding.bottom).toFixed(2),
        class: "chart-band"
      }));
    }
    for (let i = 0; i <= 4; i++) {
      const value = plot.max * (4 - i) / 4;
      const y = plot.y(value);
      const label = svgElement("text", { x: padding.left - 10, y: y + 4, "text-anchor": "end", class: "chart-label" });
      label.textContent = value.toFixed(value < 10 ? 1 : 0) + "%";
      svg.append(svgElement("line", { x1: padding.left, x2: width - padding.right, y1: y, y2: y, class: "chart-grid" }), label);
    }
    const labels = [0, Math.floor((points.length - 1) / 2), points.length - 1];
    for (const index of [...new Set(labels)]) {
      const text = svgElement("text", {
        x: plot.x(index),
        y: height - 12,
        "text-anchor": index === 0 ? "start" : index === points.length - 1 ? "end" : "middle",
        class: "chart-label"
      });
      text.textContent = new Date(points[index].tMs).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
      svg.append(text);
    }
    svg.append(svgElement("path", { d: plot.path, fill: "none", class: "chart-line" }));
    const crosshair = svgElement("line", { y1: padding.top, y2: height - padding.bottom, class: "chart-crosshair", visibility: "hidden", id: "cpu-crosshair" });
    const dot = svgElement("circle", { r: 5, class: "chart-focus", visibility: "hidden", id: "cpu-dot" });
    svg.append(crosshair, dot);
    let inspected = null;
    const inspect = function (index) {
      inspected = Math.max(0, Math.min(points.length - 1, index));
      const point = points[inspected];
      const x = plot.x(inspected);
      crosshair.setAttribute("x1", x);
      crosshair.setAttribute("x2", x);
      crosshair.setAttribute("visibility", "visible");
      dot.setAttribute("cx", x);
      dot.setAttribute("cy", plot.y(point.pct));
      dot.setAttribute("visibility", "visible");
      if (readingElement) readingElement.textContent = new Date(point.tMs).toLocaleString() + " · MsMpEng " + formatPct(point.pct) + " of total CPU";
    };
    svg.onpointermove = function (event) {
      const bounds = svg.getBoundingClientRect();
      if (!bounds.width) return;
      const localX = (event.clientX - bounds.left) / bounds.width * width;
      const ratio = (localX - padding.left) / Math.max(1, width - padding.left - padding.right);
      inspect(Math.round(ratio * (points.length - 1)));
    };
    svg.onpointerleave = function () {
      crosshair.setAttribute("visibility", "hidden");
      dot.setAttribute("visibility", "hidden");
      if (readingElement) readingElement.textContent = "Hover the chart, or focus it and use the arrow keys, for exact samples.";
    };
    svg.onkeydown = function (event) {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      inspect(event.key === "Home" ? 0 : event.key === "End" ? points.length - 1 : (inspected === null ? points.length - 1 : inspected) + (event.key === "ArrowLeft" ? -1 : 1));
    };
    if (readingElement) readingElement.textContent = "Hover the chart, or focus it and use the arrow keys, for exact samples. Shaded bands are recording windows.";
    return { points: points, plot: plot };
  }

  root.renderCpuChart = render;
  root.CpuChart = { buildSeries: buildSeries, geometry: geometry };
})(typeof globalThis !== "undefined" ? globalThis : this);
