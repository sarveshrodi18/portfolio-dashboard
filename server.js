// server.js — local proxy + dashboard host for Dhan API
// Run with:  bun server.js
// Then open: http://localhost:4000

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000; // hosting platforms (Railway etc.) inject PORT
const SCRIP_MASTER_URL = "https://images.dhan.co/api-data/api-scrip-master.csv";
const SCRIP_CACHE_FILE = "./scrip-master-cache.csv";

let ACCESS_TOKEN = null;
let CLIENT_ID = process.env.DHAN_CLIENT_ID || null; // required by Dhan market-quote (LTP) API
let TOKEN_SET_AT = null;
// Dhan credentials persisted to data/dhan-auth.json (keep "data" on the Railway Volume) so a
// restart/redeploy doesn't wipe them. Update daily from the "Dhan connection" popup in the UI.
const AUTH_FILE = "./data/dhan-auth.json";
try {
  const a = JSON.parse(require("fs").readFileSync(AUTH_FILE, "utf8"));
  ACCESS_TOKEN = a.token || null; CLIENT_ID = a.clientId || CLIENT_ID; TOKEN_SET_AT = a.setAt || null;
  if (ACCESS_TOKEN) console.log("Loaded saved Dhan token (set " + TOKEN_SET_AT + ")");
} catch {}
let scripRows = [];        // [{symbol, customSymbol, symbolName, securityId, exch, segment, instrument}]
let scripLoadedAt = null;

// authoritative Dhan index list (user-supplied, exact security ids — not scrip-master fuzzy matched)
const INDEX_LIST = JSON.parse(require("fs").readFileSync("./index_list.json", "utf8"));
// { exch, securityId, symbol, name }[]

// ---------- per-strategy position persistence (survives reloads/restarts) ----------
const fs = require("fs");
const DATA_DIR = "./data";
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

function slugify(name) {
  return String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}
function positionsFilePath(strategy) {
  return DATA_DIR + "/positions-" + slugify(strategy) + ".json";
}
function metaFilePath(strategy) {
  return DATA_DIR + "/meta-" + slugify(strategy) + ".json";
}

// ---------- server-side OHLC cache (survives browser refreshes/restarts) ----------
// Without this, every page reload re-fetched full history for every symbol/index from
// scratch — the single biggest driver of hitting Dhan's daily API cap. Now each symbol's
// data is cached to disk; a repeat request only fetches the missing delta (today's new
// candles), or nothing at all if the requested range is fully historical and already cached.
const OHLC_CACHE_DIR = DATA_DIR + "/ohlc-cache";
try { fs.mkdirSync(OHLC_CACHE_DIR, { recursive: true }); } catch {}
const OHLC_FRESH_MS = 3 * 60 * 1000; // don't re-hit Dhan for "today" data more than once per 3 min

function ohlcCacheFilePath(kind, securityId) {
  return OHLC_CACHE_DIR + "/" + kind + "-" + securityId + ".json";
}
function loadOhlcCache(kind, securityId) {
  try { return JSON.parse(fs.readFileSync(ohlcCacheFilePath(kind, securityId), "utf8")); }
  catch { return null; }
}
function saveOhlcCache(kind, securityId, data) {
  fs.writeFileSync(ohlcCacheFilePath(kind, securityId), JSON.stringify(data));
}
function mergeOhlc(a, b) {
  const map = new Map();
  const add = (d) => {
    if (!d || !d.timestamp) return;
    d.timestamp.forEach((t, i) => {
      map.set(t, { open: d.open[i], high: d.high[i], low: d.low[i], close: d.close[i] });
    });
  };
  add(a); add(b);
  const timestamps = [...map.keys()].sort((x, y) => x - y);
  return {
    timestamp: timestamps,
    open: timestamps.map((t) => map.get(t).open),
    high: timestamps.map((t) => map.get(t).high),
    low: timestamps.map((t) => map.get(t).low),
    close: timestamps.map((t) => map.get(t).close),
  };
}
function sliceOhlcRange(data, fromEpoch, toEpoch) {
  if (!data || !data.timestamp) return data;
  const idxs = [];
  data.timestamp.forEach((t, i) => { if (t >= fromEpoch && t <= toEpoch) idxs.push(i); });
  return {
    timestamp: idxs.map((i) => data.timestamp[i]),
    open: idxs.map((i) => data.open[i]),
    high: idxs.map((i) => data.high[i]),
    low: idxs.map((i) => data.low[i]),
    close: idxs.map((i) => data.close[i]),
  };
}

// cached, delta-only wrapper around fetchIntraday
async function fetchIntradayCached({ kind, securityId, exchangeSegment, instrument, interval, fromDate, toDate }) {
  const fromEpoch = Math.floor(new Date(fromDate).getTime() / 1000);
  const toEpoch = Math.floor(new Date(toDate).getTime() / 1000) + 86400; // include the whole "to" day
  const nowEpoch = Math.floor(Date.now() / 1000);
  const needsToday = toEpoch >= nowEpoch; // requested range reaches up to "now" — needs live data

  const cached = loadOhlcCache(kind, securityId);
  const cachedEarliest = cached && cached.timestamp && cached.timestamp.length ? cached.timestamp[0] : null;
  const cachedLatest = cached && cached.timestamp && cached.timestamp.length ? cached.timestamp[cached.timestamp.length - 1] : null;
  const cacheCoversFrom = cachedEarliest !== null && cachedEarliest <= fromEpoch;
  const cacheFreshEnough = cached && cached._cachedAt && (Date.now() - cached._cachedAt) < OHLC_FRESH_MS;

  if (cacheCoversFrom && (!needsToday || cacheFreshEnough)) {
    // fully served from disk — zero Dhan calls
    return sliceOhlcRange(cached, fromEpoch, toEpoch);
  }

  if (cacheCoversFrom && needsToday) {
    // only fetch the delta since the last cached candle, not the whole history again
    const deltaFromDate = new Date((cachedLatest || fromEpoch) * 1000).toISOString().slice(0, 10);
    const delta = await fetchIntraday({ securityId, exchangeSegment, instrument, interval, fromDate: deltaFromDate, toDate });
    const merged = mergeOhlc(cached, delta);
    merged._cachedAt = Date.now();
    saveOhlcCache(kind, securityId, merged);
    return sliceOhlcRange(merged, fromEpoch, toEpoch);
  }

  // cache doesn't go back far enough (or doesn't exist) — fetch the full requested range once
  const fresh = await fetchIntraday({ securityId, exchangeSegment, instrument, interval, fromDate, toDate });
  const merged = cached ? mergeOhlc(cached, fresh) : { ...fresh };
  merged._cachedAt = Date.now();
  saveOhlcCache(kind, securityId, merged);
  return sliceOhlcRange(merged, fromEpoch, toEpoch);
}

// ---------- Sector / Micro-Category mapping for Potential Candidates ----------
// Loaded from a CSV (Symbol,Sector,MicroCategory) seeded from the user's uploaded mapping sheet.
// Grows automatically: any candidate manually mapped in the dashboard (because it wasn't found
// here) gets appended back to this file, so it's auto-detected next time.
const SECTOR_MAP_FILE = DATA_DIR + "/sector-mapping.csv";
let sectorMap = {}; // SYMBOL (upper) -> { sector, microCategory }
function loadSectorMap() {
  sectorMap = {};
  try {
    const text = fs.readFileSync(SECTOR_MAP_FILE, "utf8");
    const { rows } = parseCSV(text);
    rows.forEach((r) => {
      const sym = (r["Symbol"] || "").trim().toUpperCase();
      if (!sym) return;
      sectorMap[sym] = { sector: r["Sector"] || "", microCategory: r["MicroCategory"] || "" };
    });
    console.log("Sector mapping ready:", Object.keys(sectorMap).length, "symbols");
  } catch (e) {
    console.warn("No sector-mapping.csv found yet — Potential Candidates auto-lookup will start empty.");
  }
}
function saveSectorMapRow(symbol, sector, microCategory) {
  const sym = symbol.trim().toUpperCase();
  sectorMap[sym] = { sector, microCategory };
  const lines = ["Symbol,Sector,MicroCategory"];
  const escapeCell = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  Object.keys(sectorMap).sort().forEach((s) => {
    lines.push([s, sectorMap[s].sector, sectorMap[s].microCategory].map(escapeCell).join(","));
  });
  fs.writeFileSync(SECTOR_MAP_FILE, lines.join("\n") + "\n");
}

// ---------- known-strategies registry (auto-grows as combined CSVs introduce new strategy names) ----------
const STRATEGIES_FILE = DATA_DIR + "/strategies.json";
const DEFAULT_STRATEGIES = ["Volatility Vault", "Super Surge", "Momentum Matrix"];
function loadStrategies() {
  try {
    const text = fs.readFileSync(STRATEGIES_FILE, "utf8");
    const list = JSON.parse(text);
    if (Array.isArray(list) && list.length) return list;
  } catch {}
  return DEFAULT_STRATEGIES.slice();
}
function saveStrategies(list) {
  fs.writeFileSync(STRATEGIES_FILE, JSON.stringify(list));
}
function registerStrategy(name) {
  const list = loadStrategies();
  if (!list.includes(name)) {
    list.push(name);
    saveStrategies(list);
  }
  return list;
}


// ---------- tiny CSV parser (handles quoted commas) ----------
function parseCSV(text) {
  const lines = text.split(/\r?\n/);
  if (!lines.length) return { headers: [], rows: [] };
  const splitLine = (line) => {
    const cells = [];
    let cur = "", inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === "," && !inQ) { cells.push(cur); cur = ""; continue; }
      cur += ch;
    }
    cells.push(cur);
    return cells;
  };
  const headers = splitLine(lines[0]).map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i] || !lines[i].trim()) continue;
    const cells = splitLine(lines[i]);
    const obj = {};
    headers.forEach((h, idx) => (obj[h] = (cells[idx] ?? "").trim()));
    rows.push(obj);
  }
  return { headers, rows };
}

// ---------- load & cache the Dhan scrip master ----------
async function loadScripMaster() {
  let text;
  try {
    console.log("Fetching Dhan scrip master...");
    const res = await fetch(SCRIP_MASTER_URL);
    if (!res.ok) throw new Error("HTTP " + res.status);
    text = await res.text();
    await Bun.write(SCRIP_CACHE_FILE, text);
    console.log("Scrip master downloaded and cached.");
  } catch (e) {
    console.warn("Could not fetch scrip master live (" + e.message + "), trying cache...");
    const cacheFile = Bun.file(SCRIP_CACHE_FILE);
    if (await cacheFile.exists()) {
      text = await cacheFile.text();
      console.log("Loaded scrip master from local cache.");
    } else {
      console.error("No scrip master available (no network, no cache). Symbol lookups will fail.");
      return;
    }
  }
  const { rows } = parseCSV(text);
  scripRows = rows.map((r) => ({
    symbol: r["SEM_TRADING_SYMBOL"] || "",
    customSymbol: r["SEM_CUSTOM_SYMBOL"] || "",
    symbolName: r["SM_SYMBOL_NAME"] || "",
    securityId: r["SEM_SMST_SECURITY_ID"] || "",
    exch: r["SEM_EXM_EXCH_ID"] || "",
    segment: r["SEM_SEGMENT"] || "",
    instrument: r["SEM_INSTRUMENT_NAME"] || "",
  }));
  scripLoadedAt = new Date();
  console.log("Scrip master ready:", scripRows.length, "rows");
}

// ---------- lookup helpers ----------
function findEquity(symbol) {
  const s = symbol.trim().toUpperCase();
  // exact match on NSE equity first
  let hit = scripRows.find(
    (r) => r.exch === "NSE" && r.segment === "E" && r.instrument === "EQUITY" && r.symbol.toUpperCase() === s
  );
  if (!hit) {
    hit = scripRows.find(
      (r) => r.exch === "NSE" && r.segment === "E" && r.symbol.toUpperCase() === s
    );
  }
  if (!hit) {
    // fall back to custom symbol match
    hit = scripRows.find(
      (r) => r.exch === "NSE" && r.segment === "E" && r.customSymbol.toUpperCase().startsWith(s)
    );
  }
  return hit || null;
}

function searchScrip(query) {
  const q = query.trim().toUpperCase();
  if (!q) return [];
  return scripRows
    .filter((r) => r.exch === "NSE" && r.segment === "E" && r.instrument === "EQUITY") // plain equities only — excludes F&O contracts, SME, ETFs etc.
    .filter(
      (r) =>
        r.symbol.toUpperCase().includes(q) ||
        r.symbolName.toUpperCase().includes(q) ||
        r.customSymbol.toUpperCase().includes(q)
    )
    .slice(0, 25);
}

function resolveIndex(name) {
  const key = name.trim().toUpperCase();
  let hit = INDEX_LIST.find((r) => r.symbol.toUpperCase() === key || r.name.toUpperCase() === key);
  if (hit) return { securityId: hit.securityId, exch: "IDX_I", matchedName: hit.name };
  hit = INDEX_LIST.find((r) => r.symbol.toUpperCase().includes(key) || r.name.toUpperCase().includes(key));
  if (hit) return { securityId: hit.securityId, exch: "IDX_I", matchedName: hit.name };
  return null;
}

function searchIndices(query) {
  const q = query.trim().toUpperCase();
  if (!q) return INDEX_LIST.slice(0, 30);
  return INDEX_LIST.filter((r) => r.symbol.toUpperCase().includes(q) || r.name.toUpperCase().includes(q)).slice(0, 30);
}

// ---------- Dhan API call (server-side, no CORS issue) ----------
// Dhan's Data API allows 5 req/sec — pace all outgoing calls under that,
// and retry once with backoff if a 429 slips through anyway.
let lastCallAt = 0;
const MIN_INTERVAL_MS = 230; // ~4.3 req/sec, safely under the 5/sec ceiling

async function throttle() {
  const now = Date.now();
  const wait = lastCallAt + MIN_INTERVAL_MS - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

async function fetchIntraday({ securityId, exchangeSegment, instrument, interval, fromDate, toDate }, attempt = 1) {
  if (!ACCESS_TOKEN) throw new Error("No access token set. Paste today's Dhan token in the dashboard first.");
  await throttle();
  const res = await fetch("https://api.dhan.co/v2/charts/intraday", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "access-token": ACCESS_TOKEN,
    },
    body: JSON.stringify({
      securityId: String(securityId),
      exchangeSegment,
      instrument,
      interval: String(interval),
      fromDate,
      toDate,
    }),
  });
  const text = await res.text();
  if (res.status === 429 && attempt <= 3) {
    const backoff = 1000 * attempt;
    console.log("Rate limited, retrying in " + backoff + "ms (attempt " + attempt + ")");
    await new Promise((r) => setTimeout(r, backoff));
    return fetchIntraday({ securityId, exchangeSegment, instrument, interval, fromDate, toDate }, attempt + 1);
  }
  if (!res.ok) throw new Error("Dhan API error " + res.status + ": " + text.slice(0, 300));
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("Dhan returned non-JSON: " + text.slice(0, 200)); }
  return data;
}


// ---------- STYLED PORTFOLIOS: LTP (last traded price) via Dhan market-quote API ----------
// One batched POST covers up to 1000 instruments, so every stock across all styles is
// 1-2 calls. Results are cached (memory + disk) and only re-fetched when the dashboard
// explicitly asks (Refresh button / chosen frequency) AND the cache is older than LTP_MIN_AGE_MS.
const LTP_CACHE_FILE = DATA_DIR + "/ltp-cache.json";
const LTP_MIN_AGE_MS = 60 * 1000; // never hit Dhan for the same prices more than once a minute
let ltpCache = { prices: {}, fetchedAt: null }; // key "NSE:SYMBOL" | "BSE:CODE" -> { ltp, securityId }
try { ltpCache = JSON.parse(fs.readFileSync(LTP_CACHE_FILE, "utf8")); } catch {}
let lastLtpCallAt = 0;

function findBseEquity(code) {
  const c = String(code).trim();
  return scripRows.find((r) => r.exch === "BSE" && r.segment === "E" && r.securityId === c) || null;
}

async function fetchLtpBatch(segmentMap, attempt = 1) {
  // segmentMap: { NSE_EQ: [ids], BSE_EQ: [ids] }  — Dhan limit ~1 req/sec for quote APIs
  const wait = lastLtpCallAt + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastLtpCallAt = Date.now();
  const res = await fetch("https://api.dhan.co/v2/marketfeed/ltp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "access-token": ACCESS_TOKEN, "client-id": CLIENT_ID },
    body: JSON.stringify(segmentMap),
  });
  const text = await res.text();
  if (res.status === 429 && attempt <= 3) {
    await new Promise((r) => setTimeout(r, 1500 * attempt));
    return fetchLtpBatch(segmentMap, attempt + 1);
  }
  if (!res.ok) throw new Error("Dhan LTP error " + res.status + ": " + text.slice(0, 300));
  const d = JSON.parse(text);
  return d.data || {};
}

// items: [{ nse, bse }] -> returns { prices: { key: {ltp} }, fetchedAt, unresolved: [] }
async function getLtp(items, force) {
  const fresh = ltpCache.fetchedAt && Date.now() - ltpCache.fetchedAt < LTP_MIN_AGE_MS;
  const keys = [];
  const unresolved = [];
  const idToKey = {}; // "NSE_EQ:123" -> key
  const seg = { NSE_EQ: [], BSE_EQ: [] };
  for (const it of items) {
    let key = null, row = null, segName = null;
    if (it.nse) { key = "NSE:" + it.nse.toUpperCase(); row = findEquity(it.nse); segName = "NSE_EQ"; }
    if (!row && it.bse) { key = "BSE:" + it.bse; row = findBseEquity(it.bse); segName = "BSE_EQ"; }
    if (!row) { unresolved.push(it.nse || it.bse); continue; }
    keys.push(key);
    const idNum = Number(row.securityId);
    if (!idToKey[segName + ":" + idNum]) { seg[segName].push(idNum); idToKey[segName + ":" + idNum] = key; }
  }
  if (!keys.length) return { prices: {}, fetchedAt: ltpCache.fetchedAt, unresolved, servedFromCache: true };
  const missing = keys.filter((k) => !ltpCache.prices[k]);
  if ((force && !fresh) || missing.length) {
    if (!ACCESS_TOKEN) throw new Error("No access token set. Paste today's Dhan token first.");
    if (!CLIENT_ID) throw new Error("No Dhan client ID set. Enter it next to the token.");
    // chunk into <=1000 instruments per call
    const all = [...seg.NSE_EQ.map((id) => ["NSE_EQ", id]), ...seg.BSE_EQ.map((id) => ["BSE_EQ", id])];
    for (let i = 0; i < all.length; i += 1000) {
      const chunk = { NSE_EQ: [], BSE_EQ: [] };
      all.slice(i, i + 1000).forEach(([sg, id]) => chunk[sg].push(id));
      if (!chunk.BSE_EQ.length) delete chunk.BSE_EQ;
      if (!chunk.NSE_EQ.length) delete chunk.NSE_EQ;
      const data = await fetchLtpBatch(chunk);
      for (const sg of Object.keys(data)) {
        for (const id of Object.keys(data[sg])) {
          const k = idToKey[sg + ":" + Number(id)];
          if (k) ltpCache.prices[k] = { ltp: data[sg][id].last_price, securityId: id };
        }
      }
    }
    ltpCache.fetchedAt = Date.now();
    try { fs.writeFileSync(LTP_CACHE_FILE, JSON.stringify(ltpCache)); } catch {}
  }
  const prices = {};
  keys.forEach((k) => { if (ltpCache.prices[k]) prices[k] = ltpCache.prices[k]; });
  return { prices, fetchedAt: ltpCache.fetchedAt, unresolved, servedFromCache: !!fresh && !missing.length };
}

// ---------- STYLED PORTFOLIOS: single JSON store ----------
const STYLED_FILE = DATA_DIR + "/styled-portfolios.json";
const STYLED_DEFAULTS_FILE = DATA_DIR + "/styled-style-defaults.json";

// ---------- HTTP server ----------
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------- optional basic-auth gate ----------
// Off by default (local use). Set DASH_USER and DASH_PASS as environment variables on
// whatever host you deploy to, and every request will require that username/password —
// use this before putting the dashboard anywhere reachable off your own machine.
const DASH_USER = process.env.DASH_USER || "";
const DASH_PASS = process.env.DASH_PASS || "";
function checkAuth(req) {
  if (!DASH_USER || !DASH_PASS) return true; // auth not configured — allow (local dev)
  const header = req.headers.get("authorization") || "";
  if (!header.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const [u, p] = decoded.split(":");
  return u === DASH_USER && p === DASH_PASS;
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (!checkAuth(req)) {
      return new Response("Authentication required.", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="Portfolio Dashboard"' },
      });
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const file = Bun.file("./dashboard.html");
      if (await file.exists()) return new Response(file, { headers: { "Content-Type": "text/html" } });
      return new Response("dashboard.html not found next to server.js", { status: 404 });
    }

    if (url.pathname === "/api/status") {
      return json({
        scripLoaded: scripRows.length > 0,
        scripRows: scripRows.length,
        scripLoadedAt,
        hasToken: !!ACCESS_TOKEN,
        hasClientId: !!CLIENT_ID,
        clientId: CLIENT_ID || "",
        tokenSetAt: TOKEN_SET_AT,
      });
    }

    if (url.pathname === "/api/set-token" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      if (!body.token && !body.clientId) return json({ error: "token or clientId required" }, 400);
      if (body.token) { ACCESS_TOKEN = body.token.trim(); TOKEN_SET_AT = new Date().toISOString(); }
      if (body.clientId) CLIENT_ID = String(body.clientId).trim();
      try { fs.writeFileSync(AUTH_FILE, JSON.stringify({ token: ACCESS_TOKEN, clientId: CLIENT_ID, setAt: TOKEN_SET_AT })); } catch (e) { console.warn("Could not save dhan-auth.json:", e.message); }
      return json({ ok: true, tokenSetAt: TOKEN_SET_AT });
    }

    if (url.pathname === "/api/resolve-index") {
      const name = url.searchParams.get("name") || "";
      const result = resolveIndex(name);
      return result ? json(result) : json({ error: "not found" }, 404);
    }

    if (url.pathname === "/api/indices") {
      const q = url.searchParams.get("q") || "";
      return json({ results: searchIndices(q) });
    }

    if (url.pathname === "/api/search-symbol") {
      const q = url.searchParams.get("q") || "";
      return json({ results: searchScrip(q) });
    }

    if (url.pathname === "/api/positions" && req.method === "GET") {
      const strategy = url.searchParams.get("strategy") || "";
      if (!strategy) return json({ error: "strategy is required" }, 400);
      const file = Bun.file(positionsFilePath(strategy));
      if (await file.exists()) {
        try { return json(await file.json()); }
        catch { return json({ positions: [] }); }
      }
      return json({ positions: [] });
    }

    if (url.pathname === "/api/positions" && req.method === "POST") {
      const strategy = url.searchParams.get("strategy") || "";
      if (!strategy) return json({ error: "strategy is required" }, 400);
      const body = await req.json().catch(() => null);
      if (!body || !Array.isArray(body.positions)) return json({ error: "positions array required" }, 400);
      await Bun.write(positionsFilePath(strategy), JSON.stringify(body));
      registerStrategy(strategy);
      return json({ ok: true, count: body.positions.length });
    }

    if (url.pathname === "/api/sector-lookup" && req.method === "GET") {
      const symbol = (url.searchParams.get("symbol") || "").trim().toUpperCase();
      if (!symbol) return json({ error: "symbol is required" }, 400);
      const hit = sectorMap[symbol];
      return hit ? json({ found: true, symbol, ...hit }) : json({ found: false, symbol });
    }

    if (url.pathname === "/api/sector-lookup" && req.method === "POST") {
      const body = await req.json().catch(() => null);
      if (!body || !body.symbol) return json({ error: "symbol is required" }, 400);
      saveSectorMapRow(body.symbol, body.sector || "", body.microCategory || "");
      return json({ ok: true, symbol: body.symbol.trim().toUpperCase(), sector: body.sector || "", microCategory: body.microCategory || "" });
    }

    if (url.pathname === "/api/strategies" && req.method === "GET") {
      return json({ strategies: loadStrategies() });
    }

    if (url.pathname === "/api/strategies" && req.method === "POST") {
      const body = await req.json().catch(() => null);
      if (!body || !body.name) return json({ error: "name required" }, 400);
      const list = registerStrategy(body.name);
      return json({ strategies: list });
    }

    if (url.pathname === "/api/strategies" && req.method === "DELETE") {
      const name = url.searchParams.get("name") || "";
      if (!name) return json({ error: "name is required" }, 400);
      const list = loadStrategies().filter((n) => n !== name);
      saveStrategies(list);
      try { fs.unlinkSync(positionsFilePath(name)); } catch {}
      try { fs.unlinkSync(metaFilePath(name)); } catch {}
      return json({ strategies: list });
    }

    if (url.pathname === "/api/meta" && req.method === "GET") {
      const strategy = url.searchParams.get("strategy") || "";
      if (!strategy) return json({ error: "strategy is required" }, 400);
      const file = Bun.file(metaFilePath(strategy));
      if (await file.exists()) {
        try { return json(await file.json()); }
        catch { return json({ exitSchematics: {}, candidates: "", candidatesList: [], baseCapital: 100000 }); }
      }
      return json({ exitSchematics: {}, candidates: "", candidatesList: [], baseCapital: 100000 });
    }

    if (url.pathname === "/api/meta" && req.method === "POST") {
      const strategy = url.searchParams.get("strategy") || "";
      if (!strategy) return json({ error: "strategy is required" }, 400);
      const body = await req.json().catch(() => null);
      if (!body) return json({ error: "body required" }, 400);
      const existingFile = Bun.file(metaFilePath(strategy));
      let existing = { exitSchematics: {}, candidates: "", candidatesList: [], baseCapital: 100000 };
      if (await existingFile.exists()) {
        try { existing = await existingFile.json(); } catch {}
      }
      const merged = {
        exitSchematics: body.exitSchematics !== undefined ? body.exitSchematics : (existing.exitSchematics || {}),
        candidates: body.candidates !== undefined ? body.candidates : (existing.candidates || ""),
        candidatesList: body.candidatesList !== undefined ? body.candidatesList : (existing.candidatesList || []),
        baseCapital: body.baseCapital !== undefined ? body.baseCapital : (existing.baseCapital || 100000),
      };
      await Bun.write(metaFilePath(strategy), JSON.stringify(merged));
      return json({ ok: true });
    }

    if (url.pathname === "/api/ohlc") {
      try {
        const symbol = url.searchParams.get("symbol");
        const kind = url.searchParams.get("kind") || "equity"; // equity | index
        const interval = url.searchParams.get("interval") || "15";
        const fromDate = url.searchParams.get("from");
        const toDate = url.searchParams.get("to");
        const overrideId = url.searchParams.get("securityId");
        const overrideExch = url.searchParams.get("exchSegment");
        if (!symbol || !fromDate || !toDate) return json({ error: "symbol, from, to are required" }, 400);

        let securityId, exchangeSegment, instrument;
        if (overrideId) {
          securityId = overrideId;
          exchangeSegment = overrideExch || (kind === "index" ? "IDX_I" : "NSE_EQ");
          instrument = kind === "index" ? "INDEX" : "EQUITY";
        } else if (kind === "index") {
          const idx = resolveIndex(symbol);
          if (!idx) return json({ error: "Could not resolve index '" + symbol + "' in scrip master — set a manual security ID override" }, 404);
          securityId = idx.securityId;
          exchangeSegment = "IDX_I";
          instrument = "INDEX";
        } else {
          const eq = findEquity(symbol);
          if (!eq) return json({ error: "Could not resolve symbol '" + symbol + "' in scrip master" }, 404);
          securityId = eq.securityId;
          exchangeSegment = "NSE_EQ";
          instrument = "EQUITY";
        }

        const data = await fetchIntradayCached({ kind, securityId, exchangeSegment, instrument, interval, fromDate, toDate });
        return json({ symbol, securityId, exchangeSegment, ...data });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }


    if (url.pathname === "/api/ltp" && req.method === "POST") {
      try {
        const body = await req.json().catch(() => ({}));
        const items = Array.isArray(body.items) ? body.items : [];
        return json(await getLtp(items, !!body.force));
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    if (url.pathname === "/api/styled" && req.method === "GET") {
      const file = Bun.file(STYLED_FILE);
      if (await file.exists()) { try { return json(await file.json()); } catch {} }
      return json({});
    }

    if (url.pathname === "/api/styled" && req.method === "POST") {
      const body = await req.json().catch(() => null);
      if (!body) return json({ error: "body required" }, 400);
      await Bun.write(STYLED_FILE, JSON.stringify(body));
      return json({ ok: true });
    }

    if (url.pathname === "/api/styled-defaults") {
      const file = Bun.file(STYLED_DEFAULTS_FILE);
      if (await file.exists()) { try { return json(await file.json()); } catch {} }
      return json({});
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log("Dhan proxy + dashboard running at http://localhost:" + PORT);
loadScripMaster();
loadSectorMap();
