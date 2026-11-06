#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8787;
const PUBLIC_DIR = path.join(__dirname, "public");
const WEIGHTS = JSON.parse(
  fs.readFileSync(path.join(__dirname, "data", "weights.json"), "utf8"),
);

const PERIODS = {
  "1d": { yahooRange: "1d", yahooInterval: "5m", label: "Past day" },
  "1w": { yahooRange: "5d", yahooInterval: "1d", label: "Past week" },
  "1m": { yahooRange: "1mo", yahooInterval: "1d", label: "Past month" },
  "3m": { yahooRange: "3mo", yahooInterval: "1d", label: "Past quarter" },
  "6m": { yahooRange: "6mo", yahooInterval: "1d", label: "Past 6 months" },
  "1y": { yahooRange: "1y", yahooInterval: "1d", label: "Past year" },
};

const cache = new Map();
const CACHE_TTL_MS = {
  "1d": 45_000,
  "1w": 5 * 60_000,
  "1m": 10 * 60_000,
  "3m": 15 * 60_000,
  "6m": 15 * 60_000,
  "1y": 15 * 60_000,
  overlay: 45_000,
};

const allTickers = [
  ...new Set(
    Object.values(WEIGHTS).flatMap((idx) => idx.stocks.map((s) => s.ticker)),
  ),
];

function mime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon",
    }[ext] || "application/octet-stream"
  );
}

async function yahooChart(ticker, range, interval, includePrePost = false) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
    `?range=${range}&interval=${interval}&includePrePost=${includePrePost ? "true" : "false"}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`Yahoo ${ticker} ${res.status}`);
  }
  return res.json();
}

function closesFromChart(payload) {
  const result = payload?.chart?.result?.[0];
  if (!result) return null;
  const quote = result.indicators?.quote?.[0];
  const closes = (quote?.close || []).filter((v) => typeof v === "number");
  const meta = result.meta || {};
  return { closes, meta };
}

function changeFromCloses(closes, meta, period) {
  if (period === "1d") {
    if (typeof meta.regularMarketChangePercent === "number") {
      return meta.regularMarketChangePercent;
    }
    const price = meta.regularMarketPrice ?? closes[closes.length - 1];
    const prev =
      meta.chartPreviousClose ?? meta.previousClose ?? closes[0];
    if (typeof price !== "number" || typeof prev !== "number" || prev === 0) {
      return null;
    }
    return ((price - prev) / prev) * 100;
  }
  if (closes.length < 2) return null;
  const first = closes[0];
  const last = closes[closes.length - 1];
  if (!first) return null;
  return ((last - first) / first) * 100;
}

/** % move since regular-session close (pre-market or after-hours). */
function extendedChangeFromMeta(meta) {
  if (!meta) return null;
  const reg = meta.regularMarketPrice;
  const full = meta.fulldayPrice;
  if (typeof reg === "number" && typeof full === "number" && reg !== 0) {
    return ((full - reg) / reg) * 100;
  }
  if (typeof meta.fulldayChangePercent === "number") {
    return meta.fulldayChangePercent;
  }
  return null;
}

function marketStatusFromMeta(meta, nowSec = Date.now() / 1000) {
  const ctp = meta?.currentTradingPeriod;
  if (!ctp) {
    return {
      state: "unknown",
      label: "Unknown",
      exchange: meta?.fullExchangeName || meta?.exchangeName || "US",
      timezone: meta?.exchangeTimezoneName || "America/New_York",
    };
  }

  const { pre, regular, post } = ctp;
  let state = "closed";
  let label = "Closed";
  let sessionEndsAt = null;

  if (regular && nowSec >= regular.start && nowSec < regular.end) {
    state = "open";
    label = "Open";
    sessionEndsAt = regular.end;
  } else if (pre && nowSec >= pre.start && nowSec < pre.end) {
    state = "pre";
    label = "Pre-market";
    sessionEndsAt = pre.end;
  } else if (post && nowSec >= post.start && nowSec < post.end) {
    state = "post";
    label = "After hours";
    sessionEndsAt = post.end;
  } else {
    // Point to the next upcoming session edge for context.
    const upcoming = [pre, regular, post]
      .filter((p) => p && p.start > nowSec)
      .sort((a, b) => a.start - b.start)[0];
    sessionEndsAt = upcoming?.start ?? regular?.end ?? null;
  }

  return {
    state,
    label,
    exchange: meta?.fullExchangeName || meta?.exchangeName || "US equities",
    timezone: meta?.exchangeTimezoneName || "America/New_York",
    regularHours: regular
      ? { start: regular.start, end: regular.end }
      : null,
    preHours: pre ? { start: pre.start, end: pre.end } : null,
    postHours: post ? { start: post.start, end: post.end } : null,
    nextBoundary: sessionEndsAt,
    asOf: new Date(nowSec * 1000).toISOString(),
  };
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return out;
}

async function fetchMarketOverlay() {
  const cached = cache.get("overlay");
  if (cached && Date.now() - cached.at < CACHE_TTL_MS.overlay) {
    return { ...cached.payload, cached: true };
  }

  let market = null;
  const rows = await mapPool(allTickers, 6, async (ticker) => {
    try {
      const data = await yahooChart(ticker, "1d", "1m", true);
      const parsed = closesFromChart(data);
      if (!parsed) return [ticker, null];
      if (!market) market = marketStatusFromMeta(parsed.meta);
      return [ticker, extendedChangeFromMeta(parsed.meta)];
    } catch {
      return [ticker, null];
    }
  });

  const payload = {
    market: market || {
      state: "unknown",
      label: "Unknown",
      exchange: "US equities",
      timezone: "America/New_York",
      asOf: new Date().toISOString(),
    },
    extended: Object.fromEntries(rows),
    updatedAt: new Date().toISOString(),
  };
  cache.set("overlay", { at: Date.now(), payload });
  return { ...payload, cached: false };
}

async function fetchChanges(period) {
  const cfg = PERIODS[period];
  if (!cfg) throw new Error(`Unknown period: ${period}`);

  const cached = cache.get(period);
  if (cached && Date.now() - cached.at < (CACHE_TTL_MS[period] || 60_000)) {
    return { ...cached.payload, cached: true };
  }

  const includePrePost = period === "1d";
  const rows = await mapPool(allTickers, 6, async (ticker) => {
    try {
      const data = await yahooChart(
        ticker,
        cfg.yahooRange,
        cfg.yahooInterval,
        includePrePost,
      );
      const parsed = closesFromChart(data);
      if (!parsed) return [ticker, null];
      return [ticker, changeFromCloses(parsed.closes, parsed.meta, period)];
    } catch {
      return [ticker, null];
    }
  });

  const changes = Object.fromEntries(rows);
  const payload = {
    period,
    label: cfg.label,
    updatedAt: new Date().toISOString(),
    changes,
  };
  cache.set(period, { at: Date.now(), payload });
  return { ...payload, cached: false };
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(data);
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  const rel = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404).end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": mime(filePath) });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (url.pathname === "/api/indices") {
      sendJson(res, 200, {
        periods: Object.entries(PERIODS).map(([id, p]) => ({
          id,
          label: p.label,
        })),
        indices: Object.values(WEIGHTS),
        refreshSeconds: { "1d": 45, default: 300 },
      });
      return;
    }

    if (url.pathname === "/api/changes") {
      const period = url.searchParams.get("period") || "1d";
      if (!PERIODS[period]) {
        sendJson(res, 400, { error: "Invalid period" });
        return;
      }
      const [payload, overlay] = await Promise.all([
        fetchChanges(period),
        fetchMarketOverlay(),
      ]);
      sendJson(res, 200, {
        ...payload,
        market: overlay.market,
        extended: overlay.extended,
        overlayCached: overlay.cached,
      });
      return;
    }

    if (url.pathname === "/api/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    serveStatic(req, res);
  } catch (err) {
    sendJson(res, 500, { error: String(err?.message || err) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Index dashboard live at http://127.0.0.1:${PORT}`);
  console.log("Auto-refresh: ~45s for daily, ~5m for longer periods");
});
