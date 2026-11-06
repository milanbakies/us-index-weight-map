const state = {
  indices: [],
  periods: [],
  indexId: localStorage.getItem("idx") || "sp500",
  period: localStorage.getItem("period") || "1d",
  changes: {},
  extended: {},
  market: null,
  updatedAt: null,
  timer: null,
  refreshSeconds: 45,
};

const $ = (id) => document.getElementById(id);

function formatChange(n) {
  if (n == null || Number.isNaN(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function tone(n) {
  if (n == null || Number.isNaN(n) || Math.abs(n) < 0.005) return "";
  return n > 0 ? "up" : "down";
}

function formatEtTime(unixSec) {
  if (!unixSec) return "";
  return new Date(unixSec * 1000).toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
  });
}

function marketCopy(market) {
  if (!market) return { title: "US market", detail: "Checking…" };
  const tz = "ET";
  if (market.state === "open") {
    return {
      title: "US market open",
      detail: market.regularHours
        ? `Regular session · closes ${formatEtTime(market.regularHours.end)} ${tz}`
        : "Regular session",
    };
  }
  if (market.state === "pre") {
    return {
      title: "US pre-market",
      detail: market.regularHours
        ? `Opens ${formatEtTime(market.regularHours.start)} ${tz} · ext. hours active`
        : "Extended hours active",
    };
  }
  if (market.state === "post") {
    return {
      title: "US after hours",
      detail: market.postHours
        ? `Post session · ends ${formatEtTime(market.postHours.end)} ${tz}`
        : "Extended hours active",
    };
  }
  if (market.state === "closed") {
    const next =
      market.nextBoundary != null
        ? ` · next ${formatEtTime(market.nextBoundary)} ${tz}`
        : "";
    return {
      title: "US market closed",
      detail: `No regular session${next}`,
    };
  }
  return { title: "US market", detail: "Status unavailable" };
}

function layoutRow(row, x, y, w, h, horizontal) {
  const total = row.reduce((s, d) => s + d.weight, 0);
  let offset = 0;
  return row.map((item) => {
    const frac = item.weight / total;
    if (horizontal) {
      const rw = w * frac;
      const node = { ...item, x: x + offset, y, w: rw, h };
      offset += rw;
      return node;
    }
    const rh = h * frac;
    const node = { ...item, x, y: y + offset, w, h: rh };
    offset += rh;
    return node;
  });
}

function worstAspect(row, length) {
  if (!row.length) return Infinity;
  const s = row.reduce((a, b) => a + b.weight, 0);
  let worst = 0;
  for (const item of row) {
    const r1 = (length * length * item.weight) / (s * s);
    const r2 = (s * s) / (length * length * item.weight);
    worst = Math.max(worst, r1, r2);
  }
  return worst;
}

function squarify(items, bounds) {
  const total = items.reduce((s, d) => s + d.weight, 0);
  if (total <= 0 || bounds.w <= 0 || bounds.h <= 0) return [];
  const normalized = items.map((d) => ({
    ...d,
    weight: (d.weight / total) * bounds.w * bounds.h,
  }));
  const result = [];
  let remaining = normalized.slice();
  let { x, y, w, h } = bounds;

  while (remaining.length) {
    const horizontal = w >= h;
    const length = horizontal ? h : w;
    const row = [];
    let i = 0;
    while (i < remaining.length) {
      const trial = [...row, remaining[i]];
      if (
        !row.length ||
        worstAspect(trial, length) <= worstAspect(row, length)
      ) {
        row.push(remaining[i]);
        i += 1;
      } else break;
    }
    const rowArea = row.reduce((s, d) => s + d.weight, 0);
    if (horizontal) {
      const rowWidth = rowArea / h;
      result.push(...layoutRow(row, x, y, rowWidth, h, false));
      x += rowWidth;
      w -= rowWidth;
    } else {
      const rowHeight = rowArea / w;
      result.push(...layoutRow(row, x, y, w, rowHeight, true));
      y += rowHeight;
      h -= rowHeight;
    }
    remaining = remaining.slice(i);
  }
  return result;
}

function currentIndex() {
  return (
    state.indices.find((i) => i.id === state.indexId) || state.indices[0]
  );
}

function enrichedStocks() {
  const idx = currentIndex();
  if (!idx) return [];
  return idx.stocks.map((s) => ({
    ...s,
    change: state.changes[s.ticker] ?? null,
    extended: state.extended[s.ticker] ?? null,
  }));
}

function setStatus(kind, text) {
  const pill = $("statusPill");
  pill.className = `pill ${kind}`;
  $("statusText").textContent = text;
}

function renderMarketPill() {
  const pill = $("marketPill");
  const title = $("marketTitle");
  const detail = $("marketDetail");
  const copy = marketCopy(state.market);
  const stateKey = state.market?.state || "unknown";
  pill.className = `pill market ${stateKey}`;
  title.textContent = copy.title;
  detail.textContent = copy.detail;
}

function renderControls() {
  const indexSelect = $("indexSelect");
  const periodSelect = $("periodSelect");
  indexSelect.innerHTML = state.indices
    .map(
      (i) =>
        `<option value="${i.id}" ${i.id === state.indexId ? "selected" : ""}>${i.label}</option>`,
    )
    .join("");
  periodSelect.innerHTML = state.periods
    .map(
      (p) =>
        `<option value="${p.id}" ${p.id === state.period ? "selected" : ""}>${p.label}</option>`,
    )
    .join("");
}

function weightedAvg(stocks, key) {
  const known = stocks.filter((s) => s[key] != null);
  const w = known.reduce((s, d) => s + d.weight, 0);
  if (w <= 0) return null;
  return known.reduce((s, d) => s + d[key] * d.weight, 0) / w;
}

function renderStats(stocks) {
  const coverage = stocks.reduce((s, d) => s + d.weight, 0);
  const avg = weightedAvg(stocks, "change");
  const extAvg = weightedAvg(stocks, "extended");
  const gainers = stocks.filter((s) => s.change > 0).length;
  const losers = stocks.filter((s) => s.change < 0).length;
  const mover = [...stocks]
    .filter((s) => s.change != null)
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))[0];
  const extLabel =
    state.market?.state === "pre"
      ? "Pre-market avg"
      : state.market?.state === "post"
        ? "After-hours avg"
        : "Ext. hours avg";

  $("stats").innerHTML = `
    <div class="stat"><div class="label">Market</div><div class="value">${state.market?.label || "—"}</div></div>
    <div class="stat"><div class="label">Top-20 coverage</div><div class="value">${coverage.toFixed(1)}%</div></div>
    <div class="stat"><div class="label">Weight-avg change</div><div class="value ${tone(avg)}">${formatChange(avg)}</div></div>
    <div class="stat"><div class="label">${extLabel}</div><div class="value ${tone(extAvg)}">${formatChange(extAvg)}</div></div>
    <div class="stat"><div class="label">Gainers / losers</div><div class="value">${gainers} / ${losers}</div></div>
    <div class="stat"><div class="label">Largest move</div><div class="value ${tone(mover?.change)}">${mover ? `${mover.name} ${formatChange(mover.change)}` : "—"}</div></div>
  `;
}

function renderList(stocks) {
  const extHead =
    state.market?.state === "pre"
      ? "Pre-mkt"
      : state.market?.state === "post"
        ? "After-hrs"
        : "Ext. hrs";

  $("list").innerHTML = `
    <div class="row head">
      <div class="rank">#</div>
      <div class="name">Company</div>
      <div class="weight">Weight</div>
      <div class="chg">Period</div>
      <div class="ext">${extHead}</div>
    </div>
    ${stocks
      .map(
        (s, i) => `
      <div class="row">
        <div class="rank">${i + 1}</div>
        <div class="name">${s.name}</div>
        <div class="weight">${s.weight.toFixed(2)}%</div>
        <div class="chg ${tone(s.change)}">${formatChange(s.change)}</div>
        <div class="ext ${tone(s.extended)}">${formatChange(s.extended)}</div>
      </div>`,
      )
      .join("")}`;
}

function renderTreemap(stocks) {
  const svg = $("treemap");
  const rect = svg.getBoundingClientRect();
  const width = Math.max(320, Math.floor(rect.width) || 960);
  const height = Math.max(280, Math.floor(rect.height) || 520);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

  const showExtended =
    state.market?.state === "pre" ||
    state.market?.state === "post" ||
    state.market?.state === "closed";
  // Color by extended move outside regular hours; otherwise by selected period.
  const colorKey = showExtended ? "extended" : "change";

  const nodes = squarify(stocks, { x: 0, y: 0, w: width, h: height });
  const gap = 2;

  svg.innerHTML = nodes
    .map((node) => {
      const rx = node.x + gap / 2;
      const ry = node.y + gap / 2;
      const rw = Math.max(0, node.w - gap);
      const rh = Math.max(0, node.h - gap);
      const paint = node[colorKey];
      const fill =
        paint == null || Math.abs(paint) < 0.05
          ? "var(--flat)"
          : paint > 0
            ? "var(--up-soft)"
            : "var(--down-soft)";
      const showDetail = rw > 88 && rh > 48;
      const showCompact = rw > 56 && rh > 28;
      const fontSize = Math.min(15, Math.max(10, Math.min(rw, rh) / 9));
      const label =
        rw < 110 && node.name.length > 14
          ? `${node.name.slice(0, 12)}…`
          : node.name;
      const chgColor =
        node.change == null
          ? "var(--muted)"
          : node.change > 0
            ? "#7ddbb0"
            : node.change < 0
              ? "#f0a0a0"
              : "var(--muted)";
      const extColor =
        node.extended == null
          ? "var(--muted)"
          : node.extended > 0
            ? "#7ddbb0"
            : node.extended < 0
              ? "#f0a0a0"
              : "var(--muted)";

      let labels = "";
      if (showCompact) {
        labels += `<text x="${rx + 8}" y="${ry + (showDetail ? 18 : rh / 2 + 4)}" fill="var(--text)" font-size="${fontSize}" font-weight="600">${escapeXml(label)}</text>`;
      }
      if (showDetail) {
        labels += `<text x="${rx + 8}" y="${ry + 36}" fill="${chgColor}" font-size="${Math.max(10, fontSize - 1)}" font-weight="600">${escapeXml(formatChange(node.change))}</text>`;
        if (node.extended != null && Math.abs(node.extended) >= 0.005) {
          const tag =
            state.market?.state === "pre"
              ? "pre"
              : state.market?.state === "post"
                ? "AH"
                : "ext";
          labels += `<text x="${rx + 8}" y="${ry + 52}" fill="${extColor}" font-size="10" font-weight="600">${tag} ${escapeXml(formatChange(node.extended))}</text>`;
          labels += `<text x="${rx + 8}" y="${ry + 66}" fill="var(--faint)" font-size="10">${node.weight.toFixed(2)}% weight</text>`;
        } else {
          labels += `<text x="${rx + 8}" y="${ry + 52}" fill="var(--faint)" font-size="10">${node.weight.toFixed(2)}% weight</text>`;
        }
      } else if (showCompact) {
        labels += `<text x="${rx + 8}" y="${ry + rh / 2 + 18}" fill="${chgColor}" font-size="10" font-weight="600">${escapeXml(formatChange(node.change))}</text>`;
      }

      return `<g>
        <rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" fill="${fill}" stroke="var(--stroke)" stroke-width="1" />
        ${labels}
      </g>`;
    })
    .join("");
}

function escapeXml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderAll() {
  const idx = currentIndex();
  const stocks = enrichedStocks();
  const periodLabel =
    state.periods.find((p) => p.id === state.period)?.label || state.period;
  $("mapTitle").textContent = `${idx?.label || "Index"} — weight × ${periodLabel.toLowerCase()}`;
  if (state.updatedAt) {
    const t = new Date(state.updatedAt);
    const extNote =
      state.market?.state === "pre" || state.market?.state === "post"
        ? " · tiles colored by extended hours"
        : "";
    $("mapMeta").textContent = `Updated ${t.toLocaleTimeString()} · refresh ~${state.refreshSeconds}s${extNote}`;
  }
  renderMarketPill();
  renderStats(stocks);
  renderTreemap(stocks);
  renderList(stocks);
}

async function loadMeta() {
  const res = await fetch("/api/indices");
  if (!res.ok) throw new Error("Failed to load indices");
  const data = await res.json();
  state.indices = data.indices;
  state.periods = data.periods;
  state.refreshSeconds =
    data.refreshSeconds?.[state.period] ||
    data.refreshSeconds?.default ||
    45;
  if (!state.indices.some((i) => i.id === state.indexId)) {
    state.indexId = state.indices[0]?.id || "sp500";
  }
  if (!state.periods.some((p) => p.id === state.period)) {
    state.period = "1d";
  }
  renderControls();
}

async function loadChanges({ silent = false } = {}) {
  if (!silent) setStatus("", "Refreshing…");
  try {
    const res = await fetch(
      `/api/changes?period=${encodeURIComponent(state.period)}`,
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.changes = data.changes || {};
    state.extended = data.extended || {};
    state.market = data.market || null;
    state.updatedAt = data.updatedAt;
    setStatus("live", data.cached ? "Live (cached)" : "Live");
    renderAll();
  } catch (err) {
    setStatus("err", `Error: ${err.message}`);
    throw err;
  }
}

function scheduleRefresh() {
  clearInterval(state.timer);
  const outsideRegular =
    state.market?.state === "pre" ||
    state.market?.state === "post" ||
    state.period === "1d";
  const seconds = outsideRegular ? 45 : 300;
  state.refreshSeconds = seconds;
  state.timer = setInterval(() => {
    loadChanges({ silent: true }).catch(() => {});
  }, seconds * 1000);
}

function bind() {
  $("indexSelect").addEventListener("change", (e) => {
    state.indexId = e.target.value;
    localStorage.setItem("idx", state.indexId);
    renderAll();
  });
  $("periodSelect").addEventListener("change", async (e) => {
    state.period = e.target.value;
    localStorage.setItem("period", state.period);
    scheduleRefresh();
    await loadChanges();
  });
  window.addEventListener("resize", () => renderTreemap(enrichedStocks()));
}

async function boot() {
  bind();
  await loadMeta();
  await loadChanges();
  scheduleRefresh();
}

boot().catch((err) => {
  setStatus("err", err.message || "Failed to start");
});
