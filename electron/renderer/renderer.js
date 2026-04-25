/** Royal + Caerleon + Brecilien — set your character in this city's market before fetching. */
const MARKET_CITIES = ["Bridgewatch", "Martlock", "Thetford", "Fort Sterling", "Lymhurst", "Caerleon", "Brecilien"];
const FETCH_CITY_STORAGE_KEY = "albionMarketFetchCity";
const UI_PREFS_KEY = "albionUiPrefs";
const DB_READ_SCHEDULE_UTC_HOURS = [0, 6, 12, 18]; // Albion UTC time slots
const AUTO_POST_BATCH_SIZE = 10;
const AUTO_POST_IDLE_MS = 10000;
const MARKET_REVIEW_STATE_KEY = "albionMarketReviewState";
const MARKET_FILTER_DEBOUNCE_MS = 220;
const MARKET_DB_FETCH_LIMIT = 2000;

const EXACT_CATEGORY_ORDER = [
  { id: "all", label: "All Items" },
  { id: "weapons", label: "Weapons" },
  { id: "chest_armor", label: "Chest Armor" },
  { id: "head_armor", label: "Head Armor" },
  { id: "foot_armor", label: "Foot Armor" },
  { id: "off_hands", label: "Off-Hands" },
  { id: "capes", label: "Capes" },
  { id: "bags", label: "Bags" },
  { id: "mount", label: "Mount" },
  { id: "consumable", label: "Consumable" },
  { id: "gathering_equipment", label: "Gathering Equipment" },
  { id: "crafting", label: "Crafting" },
  { id: "artifact", label: "Artifact" },
  { id: "farming", label: "Farming" },
  { id: "furniture", label: "Furniture" },
  { id: "vanity", label: "Vanity" },
];

const state = {
  activeView: "dashboard",
  selectedCity: "",
  watchlist: [],
  watchFilter: "",
  catalogFilter: "",
  itemCatalog: null,
  liveRows: [],
  historyRows: [],
  isCategoryFetchRunning: false,
  categoryProgress: { done: 0, total: 0, failures: 0, item: "", category: "", city: "" },
  searchPoint: null,
  region: null,
  marketPriceRows: [],
  marketRowCounter: 0,
  isPostingMarketRows: false,
  resumeCheckpoint: null,
  marketDbRows: [],
  marketDbFilters: {
    search: "",
    category: "",
    type: "",
    tier: "",
    enchant: "",
    city: "",
    sort: "last_updated_desc",
  },
};

const CATALOG_RENDER_CAP = 400;
let catalogFilterDebounce = null;
let autoPostIdleTimer = null;
let marketFilterDebounce = null;
let dbReadScheduleTimer = null;

function byId(id) {
  return document.getElementById(id);
}

function formatRowTime(iso) {
  if (!iso || typeof iso !== "string") return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 19);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeDisplayPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return n > 1 ? Math.round(n) : 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function msUntilNextUtcReadSlot(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  for (const hour of DB_READ_SCHEDULE_UTC_HOURS) {
    const candidate = Date.UTC(y, m, d, hour, 0, 0, 0);
    if (candidate > now.getTime()) {
      return candidate - now.getTime();
    }
  }
  const tomorrowFirst = Date.UTC(y, m, d + 1, DB_READ_SCHEDULE_UTC_HOURS[0], 0, 0, 0);
  return tomorrowFirst - now.getTime();
}

function scheduleNextDbReadTick() {
  if (dbReadScheduleTimer) {
    clearTimeout(dbReadScheduleTimer);
  }
  const waitMs = Math.max(1000, msUntilNextUtcReadSlot(new Date()));
  dbReadScheduleTimer = setTimeout(() => {
    loadPriceHistory().catch(() => {});
    if (state.activeView === "market-price") {
      loadMarketPriceRows().catch(() => {});
    }
    scheduleNextDbReadTick();
  }, waitMs);
}

function setBackendStatus(text) {
  const n = byId("backend-status");
  if (n) n.textContent = text;
}

function logLine(message) {
  const panel = byId("log-panel");
  if (!panel) return;
  const stamp = new Date().toLocaleTimeString();
  panel.textContent = `[${stamp}] ${message}\n${panel.textContent}`.slice(0, 18000);
}

async function request(command, payload = {}) {
  try {
    return await window.botApi.request(command, payload);
  } catch (error) {
    logLine(`Request ${command} failed: ${error.message}`);
    throw error;
  }
}

function setActiveView(view) {
  state.activeView = view;
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.view === view);
  });
  document.querySelectorAll(".view-panel").forEach((panel) => {
    panel.classList.toggle("is-active", panel.dataset.view === view);
  });
  if (view === "market-price") {
    loadMarketPriceRows().catch((error) => {
      logLine(`Market DB load failed: ${error.message}`);
    });
  }
}

function setHelpVisible(visible) {
  const modal = byId("help-modal");
  if (!modal) return;
  modal.classList.toggle("is-hidden", !visible);
}

function setFetchCityModalVisible(visible) {
  const modal = byId("fetch-city-modal");
  if (!modal) return;
  modal.classList.toggle("is-hidden", !visible);
}

function renderFetchCityOptions() {
  const sel = byId("select-fetch-city");
  if (!sel) return;
  const saved = localStorage.getItem(FETCH_CITY_STORAGE_KEY);
  sel.innerHTML = "";
  for (const c of MARKET_CITIES) {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c;
    sel.appendChild(opt);
  }
  if (saved && MARKET_CITIES.includes(saved)) {
    sel.value = saved;
  }
}

function renderCityChips() {
  const root = byId("city-chip-list");
  if (!root) return;
  root.innerHTML = "";
  for (const city of MARKET_CITIES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `city-chip${state.selectedCity === city ? " is-active" : ""}`;
    btn.dataset.city = city;
    btn.textContent = city;
    root.appendChild(btn);
  }
}

function setSelectedCity(city) {
  state.selectedCity = String(city || "").trim();
  if (state.selectedCity) {
    localStorage.setItem(FETCH_CITY_STORAGE_KEY, state.selectedCity);
  }
  renderCityChips();
}

function openFetchCityModal() {
  const categoryId = byId("select-fetch-category").value;
  const categoryMeta = EXACT_CATEGORY_ORDER.find((c) => c.id === categoryId);
  const summary = byId("fetch-city-summary");
  if (summary) {
    summary.textContent = `Category: ${categoryMeta?.label || categoryId}`;
  }
  renderFetchCityOptions();
  setFetchCityModalVisible(true);
}

function renderCategorySelector() {
  const select = byId("select-fetch-category");
  if (!select) return;
  const counts = new Map((state.itemCatalog?.exactCategories || []).map((c) => [c.id, c.count]));
  const allCount = (state.itemCatalog?.categories || []).reduce(
    (acc, section) => acc + ((section.items && section.items.length) || 0),
    0,
  );
  counts.set("all", allCount);
  const previous = select.value;
  select.innerHTML = "";
  for (const c of EXACT_CATEGORY_ORDER) {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = `${c.label} (${counts.get(c.id) || 0})`;
    select.appendChild(opt);
  }
  if (previous && [...select.options].some((o) => o.value === previous)) {
    select.value = previous;
  }
}

function renderCategoryProgress() {
  const node = byId("category-fetch-status");
  const progress = state.categoryProgress;
  const btn = byId("btn-start-category-fetch");
  const stopBtn = byId("btn-stop-category-fetch");
  if (btn) btn.disabled = state.isCategoryFetchRunning;
  if (stopBtn) stopBtn.disabled = !state.isCategoryFetchRunning;
  if (!node) return;
  if (!state.isCategoryFetchRunning && progress.total === 0) {
    node.textContent = "Scan: Idle";
    return;
  }
  if (!state.isCategoryFetchRunning) {
    node.textContent = `Scan: Done ${progress.done}/${progress.total}${progress.failures ? ` · Fail ${progress.failures}` : ""}${progress.city ? ` · ${progress.city}` : ""}`;
    return;
  }
  node.textContent = `Scan: Running ${progress.done}/${progress.total}${progress.failures ? ` · Fail ${progress.failures}` : ""}${progress.city ? ` · ${progress.city}` : ""}`;
}

function saveMarketReviewState() {
  try {
    const payload = {
      rows: state.marketPriceRows,
      marketRowCounter: state.marketRowCounter,
      selectedCity: state.selectedCity || "",
      savedAt: new Date().toISOString(),
    };
    localStorage.setItem(MARKET_REVIEW_STATE_KEY, JSON.stringify(payload));
  } catch (_error) {
    // ignore localStorage write failures
  }
}

function restoreMarketReviewState() {
  try {
    const raw = localStorage.getItem(MARKET_REVIEW_STATE_KEY);
    if (!raw) return;
    const payload = JSON.parse(raw);
    const rows = Array.isArray(payload?.rows) ? payload.rows : [];
    state.marketPriceRows = rows
      .filter((row) => row && typeof row === "object" && row.id)
      .map((row) => ({
        ...row,
        status: String(row.status || "pending"),
        statusLabel: String(row.statusLabel || "Pending"),
      }));
    state.marketRowCounter = Number.isFinite(Number(payload?.marketRowCounter))
      ? Math.max(0, Number(payload.marketRowCounter))
      : state.marketPriceRows.length;
    if (!state.selectedCity && payload?.selectedCity) {
      state.selectedCity = String(payload.selectedCity);
    }
  } catch (_error) {
    // ignore corrupted persisted review state
  }
}

function renderResumeCheckpointState() {
  const statusNode = byId("resume-scan-status");
  const resumeBtn = byId("btn-resume-last-scan");
  const discardBtn = byId("btn-discard-last-scan");
  const cp = state.resumeCheckpoint;
  const running = state.isCategoryFetchRunning;
  if (resumeBtn) resumeBtn.disabled = running || !cp?.resumable;
  if (discardBtn) discardBtn.disabled = running || !cp?.hasCheckpoint;
  if (!statusNode) return;
  if (!cp?.hasCheckpoint) {
    statusNode.textContent = "Resume: No saved progress";
    return;
  }
  if (cp.invalid) {
    statusNode.textContent = `Resume: Saved progress invalid (${cp.reason || "unknown"})`;
    return;
  }
  if (cp.completed) {
    statusNode.textContent = `Resume: Last scan completed (${cp.processed}/${cp.totalItems})`;
    return;
  }
  statusNode.textContent =
    `Resume: ${cp.categoryId || "-"} @ ${cp.city || "-"} ` +
    `(${cp.nextIndex || 0}/${cp.totalItems || 0})`;
}

async function refreshResumeCheckpointState() {
  try {
    const payload = await request("getResumeScanCheckpoint");
    state.resumeCheckpoint = payload || { hasCheckpoint: false };
  } catch (error) {
    state.resumeCheckpoint = { hasCheckpoint: false, invalid: true, reason: error.message };
  }
  renderResumeCheckpointState();
}

function renderCalibrationStatus() {
  const pointNode = byId("status-search-point");
  const regionNode = byId("status-price-region");
  const pointBtn = byId("btn-capture-search-point");
  const regionBtn = byId("btn-draw-price-region");
  if (!pointNode || !regionNode) return;
  const hasPoint = Boolean(state.searchPoint && Number.isFinite(state.searchPoint.x));
  const hasRegion = Boolean(state.region && Number.isFinite(state.region.width) && state.region.width > 2);
  pointNode.textContent = hasPoint
    ? `Search Point: ${state.searchPoint.x},${state.searchPoint.y}`
    : "Search Point: Not set";
  regionNode.textContent = hasRegion
    ? `Price Region: ${state.region.width}x${state.region.height}`
    : "Price Region: Not set";
  if (pointBtn) pointBtn.textContent = hasPoint ? "Reselect Search Point" : "Pick Search Point";
  if (regionBtn) regionBtn.textContent = hasRegion ? "Redraw Price Region" : "Draw Price Region";
}

function renderWatchlist() {
  const watchBody = byId("watchlist-body");
  if (!watchBody) return;
  const filterText = state.watchFilter.trim().toLowerCase();
  const filtered = state.watchlist.filter((item) => {
    if (!filterText) return true;
    return item.queryText.toLowerCase().includes(filterText);
  });

  watchBody.innerHTML = "";
  for (const item of filtered) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input type="checkbox" data-action="toggle-watch" data-id="${item.id}" ${item.enabled ? "checked" : ""} /></td>
      <td>${item.queryText}</td>
      <td>${item.targetPrice ?? "--"}</td>
      <td>${item.minProfitPct}</td>
      <td><button class="btn-secondary" data-action="remove-watch" data-id="${item.id}">Remove</button></td>
    `;
    watchBody.appendChild(tr);
  }

  watchBody.querySelectorAll("[data-action='toggle-watch']").forEach((el) => {
    el.addEventListener("change", async () => {
      await request("toggleWatchItem", { itemId: el.dataset.id });
      await refreshWatchlist();
    });
  });
  watchBody.querySelectorAll("[data-action='remove-watch']").forEach((el) => {
    el.addEventListener("click", async () => {
      await request("removeWatchItem", { itemId: el.dataset.id });
      await refreshWatchlist();
    });
  });
}

function renderDashboardStats() {
  const values = state.historyRows
    .concat(state.liveRows)
    .map((r) => normalizeDisplayPrice(r.observed_price ?? r.value))
    .filter((n) => n > 0);
  const totalRevenue = values.reduce((acc, n) => acc + n, 0);
  const itemCount = state.liveRows.length;
  const failures = state.liveRows.filter((r) => r.error).length;
  const successRate = itemCount === 0 ? 0 : Math.max(0, ((itemCount - failures) / itemCount) * 100);

  byId("stat-revenue").textContent = totalRevenue > 0 ? totalRevenue.toLocaleString() : "--";
  // Profit is not emitted by backend yet; avoid mock estimation.
  byId("stat-profit").textContent = "--";
  byId("stat-items").textContent = itemCount > 0 ? String(itemCount) : "--";
  byId("stat-success").textContent = itemCount > 0 ? `${successRate.toFixed(1)}%` : "--";

  if (state.liveRows.length > 0) {
    const topItem = state.liveRows[0].item_name || state.liveRows[0].queryText || "--";
    const cityCount = new Map();
    for (const row of state.liveRows) {
      const city = row.city || "-";
      cityCount.set(city, (cityCount.get(city) || 0) + 1);
    }
    const topCity = [...cityCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "--";
    const bestRow = state.liveRows
      .filter((r) => !r.error && Number.isFinite(Number(r.observed_price ?? r.value)))
      .sort(
        (a, b) =>
          normalizeDisplayPrice(a.observed_price ?? a.value) -
          normalizeDisplayPrice(b.observed_price ?? b.value),
      )[0];

    byId("metric-top-item").textContent = topItem;
    byId("metric-top-city").textContent = topCity;
    byId("metric-best-item").textContent = bestRow
      ? `${bestRow.item_name || bestRow.queryText} @ ${normalizeDisplayPrice(bestRow.observed_price ?? bestRow.value)}`
      : "--";
  } else {
    byId("metric-top-item").textContent = "--";
    byId("metric-top-city").textContent = "--";
    byId("metric-best-item").textContent = "--";
  }
}

function renderLiveRows() {
  const body = byId("live-prices-body");
  if (body) {
    body.innerHTML = "";
    for (const row of state.liveRows) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
      <td>${formatRowTime(row.timestamp)}</td>
      <td>${row.city || "-"}</td>
      <td>${row.category || "-"}</td>
      <td>${row.item_name || row.queryText || "-"}</td>
      <td>${normalizeDisplayPrice(row.observed_price ?? row.value)}</td>
    `;
      body.appendChild(tr);
    }
  }

  const dashBody = byId("dashboard-live-body");
  if (dashBody) {
    dashBody.innerHTML = "";
    for (const row of state.liveRows.slice(0, 12)) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
      <td>${formatRowTime(row.timestamp)}</td>
      <td>${row.city || "-"}</td>
      <td>${row.item_name || row.queryText || "-"}</td>
      <td>${normalizeDisplayPrice(row.observed_price ?? row.value)}</td>
      <td>${row.error || ""}</td>
    `;
      dashBody.appendChild(tr);
    }
  }
  renderDashboardStats();
}

function renderHistoryRows() {
  const body = byId("history-prices-body");
  if (!body) {
    renderDashboardStats();
    return;
  }
  body.innerHTML = "";
  for (const row of state.historyRows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${formatRowTime(row.timestamp)}</td>
      <td>${row.city || "-"}</td>
      <td>${row.category || "-"}</td>
      <td>${row.item_name || "-"}</td>
      <td>${normalizeDisplayPrice(row.observed_price)}</td>
      <td>${row.tier ?? "-"}</td>
      <td>${row.enchant ?? "-"}</td>
      <td>${row.error || ""}</td>
    `;
    body.appendChild(tr);
  }
  renderDashboardStats();
}

function marketRowStatusClass(row) {
  if (row.status === "posted") return "posted";
  if (row.status === "failed") return "failed";
  if (!Number.isFinite(Number(row.finalPrice)) || Number(row.finalPrice) < 0) return "invalid";
  return "pending";
}

function renderMarketPriceSummary() {
  const node = byId("market-review-summary");
  if (!node) return;
  const total = state.marketPriceRows.length;
  const posted = state.marketPriceRows.filter((row) => row.status === "posted").length;
  const failed = state.marketPriceRows.filter((row) => row.status === "failed").length;
  const invalid = state.marketPriceRows.filter((row) => marketRowStatusClass(row) === "invalid").length;
  const pending = state.marketPriceRows.filter((row) => marketRowStatusClass(row) === "pending").length;
  if (total === 0) {
    node.textContent = "No rows yet.";
    return;
  }
  node.textContent = `Rows: ${total} · Pending: ${pending} · Posted: ${posted} · Failed: ${failed} · Invalid: ${invalid}`;
}

function clearAutoPostIdleTimer() {
  if (autoPostIdleTimer) {
    clearTimeout(autoPostIdleTimer);
    autoPostIdleTimer = null;
  }
}

function collectRowsForPost({ auto = false } = {}) {
  const rowsToPost = [];
  const blocked = [];
  for (const row of state.marketPriceRows) {
    if (row.status === "posted") continue;
    if (auto && row.status !== "pending") continue;
    const numericPrice = Number(row.finalPrice);
    if (!row.item_id) {
      blocked.push({ rowId: row.id, reason: "Missing item id" });
      continue;
    }
    if (!row.city) {
      blocked.push({ rowId: row.id, reason: "Missing city" });
      continue;
    }
    if (!Number.isFinite(numericPrice) || numericPrice < 0) {
      blocked.push({ rowId: row.id, reason: "Invalid price" });
      continue;
    }
    // Auto-post skips OCR miss/zero rows by request.
    if (auto && numericPrice === 0) {
      continue;
    }
    rowsToPost.push(row);
  }
  return { rowsToPost, blocked };
}

async function postMarketRows({ auto = false } = {}) {
  clearAutoPostIdleTimer();
  if (state.isPostingMarketRows) return { posted: 0, failed: 0, skipped: true };

  const { rowsToPost, blocked } = collectRowsForPost({ auto });
  if (!auto && blocked.length) {
    const blockedById = new Map(blocked.map((x) => [x.rowId, x.reason]));
    state.marketPriceRows = state.marketPriceRows.map((row) => {
      const reason = blockedById.get(row.id);
      if (!reason || row.status === "posted") return row;
      return { ...row, status: "failed", statusLabel: `Failed: ${reason}` };
    });
    renderMarketPriceRows();
  }
  if (rowsToPost.length === 0) {
    if (!auto) logLine("No postable rows. Check Post Status reasons.");
    return { posted: 0, failed: 0, skipped: false };
  }

  logLine(`${auto ? "Auto-posting" : "Posting"} ${rowsToPost.length} reviewed rows to Supabase...`);
  const payload = rowsToPost.map((row) => ({
    rowId: row.id,
    itemUniqueName: row.item_id,
    itemName: row.item_name || row.item_id,
    tier: row.tier,
    enchant: row.enchant || 0,
    city: row.city,
    price: Number(row.finalPrice),
    postedAt: row.timestamp,
  }));

  state.isPostingMarketRows = true;
  try {
    const response = await request("postReviewedPrices", { rows: payload });
    const byIdMap = new Map((response.results || []).map((result) => [result.rowId, result]));
    state.marketPriceRows = state.marketPriceRows.map((row) => {
      const result = byIdMap.get(row.id);
      if (!result) return row;
      if (result.ok) {
        return { ...row, status: "posted", statusLabel: "Posted" };
      }
      return { ...row, status: "failed", statusLabel: `Failed: ${result.error || "unknown"}` };
    });
    renderMarketPriceRows();
    logLine(`Supabase post complete. OK=${response.posted || 0}, Failed=${response.failed || 0}`);
    return { posted: response.posted || 0, failed: response.failed || 0, skipped: false };
  } catch (error) {
    logLine(`Supabase post failed: ${error.message}`);
    return { posted: 0, failed: rowsToPost.length, skipped: false };
  } finally {
    state.isPostingMarketRows = false;
  }
}

function scheduleAutoPostIdleFlush() {
  clearAutoPostIdleTimer();
  autoPostIdleTimer = setTimeout(() => {
    postMarketRows({ auto: true }).catch((error) => {
      logLine(`Auto-post idle flush failed: ${error.message}`);
    });
  }, AUTO_POST_IDLE_MS);
}

function renderMarketPriceRows() {
  const body = byId("market-price-body");
  if (!body) {
    saveMarketReviewState();
    return;
  }
  body.innerHTML = "";
  for (const row of state.marketPriceRows) {
    const statusClass = marketRowStatusClass(row);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.category || "-"}</td>
      <td>${row.item_name || row.queryText || "-"}</td>
      <td>${row.tier ?? "-"}</td>
      <td>${row.enchant ?? 0}</td>
      <td>
        <input
          class="price-input"
          type="number"
          min="0"
          step="1"
          value="${row.finalPrice ?? ""}"
          data-action="edit-final"
          data-row-id="${row.id}"
        />
      </td>
      <td>${row.city || "-"}</td>
      <td><span class="status-badge ${statusClass}">${row.statusLabel || row.status || "pending"}</span></td>
      <td>${formatRowTime(row.timestamp)}</td>
    `;
    body.appendChild(tr);
  }
  renderMarketPriceSummary();
  saveMarketReviewState();
}

function appendMarketReviewRowFromScan(payload, scan) {
  const rawScanValue = Number(scan.value);
  // OCR noise can produce tiny false positives (e.g. 1). Treat them as undetected.
  const normalizedPrice = Number.isFinite(rawScanValue) && rawScanValue > 1 ? Math.round(rawScanValue) : 0;
  const displayItemName = String(payload.item?.name || "").trim() || String(scan.queryText || "").replace(/\s+\d+\.\d+\s*$/, "");
  const row = {
    id: `mpr-${Date.now()}-${++state.marketRowCounter}`,
    timestamp: scan.timestamp,
    city: payload.city || "",
    category: payload.categoryId || "",
    item_name: displayItemName,
    item_id: payload.item?.id || "",
    tier: payload.item?.tier ?? null,
    enchant: payload.item?.enchant ?? 0,
    ocrPrice: normalizedPrice,
    finalPrice: normalizedPrice,
    error: scan.error || "",
    status: "pending",
    statusLabel: normalizedPrice > 0 ? "Pending" : "No OCR (0)",
  };
  state.marketPriceRows.unshift(row);
  renderMarketPriceRows();
  const postableNow = collectRowsForPost({ auto: true }).rowsToPost.length;
  if (postableNow >= AUTO_POST_BATCH_SIZE) {
    clearAutoPostIdleTimer();
    postMarketRows({ auto: true }).catch((error) => {
      logLine(`Auto-post batch failed: ${error.message}`);
    });
  } else {
    scheduleAutoPostIdleFlush();
  }
}

async function refreshWatchlist() {
  state.watchlist = await request("listWatchItems");
  renderWatchlist();
}

async function refreshCalibrationState() {
  try {
    const snapshot = await request("getState");
    state.searchPoint = snapshot.searchPoint || null;
    state.region = snapshot.region || null;
    renderCalibrationStatus();
  } catch (error) {
    logLine(`Failed to load calibration state: ${error.message}`);
  }
}

async function loadItemCatalog(force = false) {
  const statusEl = byId("catalog-status");
  if (statusEl) {
    statusEl.textContent = force
      ? "Refreshing catalog..."
      : "Loading catalog (first run may download ~24 MB)...";
  }
  try {
    const data = await window.botApi.loadItemCatalog({ force });
    state.itemCatalog = data;
    const when = data.fetchedAt ? new Date(data.fetchedAt).toLocaleString() : "-";
    const src = data.fromCache ? "cache" : "network";
    if (statusEl) {
      statusEl.textContent = `${data.itemCount.toLocaleString()} items · ${src} · ${when}`;
    }
    renderCategorySelector();
    renderCatalogAccordion();
    logLine(`Item catalog ready (${data.itemCount} rows, ${src})`);
  } catch (error) {
    if (statusEl) {
      statusEl.textContent = `Catalog error: ${error.message}`;
    }
    logLine(`Catalog error: ${error.message}`);
  }
}

function renderCatalogAccordion() {
  const root = byId("catalog-accordion");
  if (!root) return;
  root.replaceChildren();

  const cat = state.itemCatalog;
  if (!cat?.categories) return;

  const filt = state.catalogFilter.trim().toLowerCase();
  for (const section of cat.categories) {
    const items = filt
      ? section.items.filter((it) => {
          const hay = it.searchHaystack || `${it.name} ${it.id}`.toLowerCase();
          return hay.includes(filt);
        })
      : section.items;
    if (filt && items.length === 0) continue;

    const details = document.createElement("details");
    details.className = "catalog-section";
    if (filt) details.open = true;

    const summary = document.createElement("summary");
    const label = document.createElement("span");
    label.textContent = `${section.icon} ${section.label}`;
    summary.appendChild(label);
    const count = document.createElement("span");
    count.className = "catalog-count";
    count.textContent = filt ? `${items.length} match` : `${section.count}`;
    summary.appendChild(count);
    details.appendChild(summary);

    const wrap = document.createElement("div");
    wrap.className = "catalog-items";
    const slice = items.slice(0, CATALOG_RENDER_CAP);
    for (const it of slice) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "catalog-item";

      const nameSpan = document.createElement("span");
      nameSpan.className = "catalog-item-name";
      nameSpan.textContent = it.name;
      btn.appendChild(nameSpan);

      const metaBits = [];
      if (it.tier != null) metaBits.push(`T${it.tier}`);
      if (it.enchant > 0) metaBits.push(`.${it.enchant}`);
      if (metaBits.length) {
        const meta = document.createElement("span");
        meta.className = "catalog-item-meta";
        meta.textContent = metaBits.join(" ");
        btn.appendChild(meta);
      }

      btn.title = `${it.id}\nQuality (Normal-Masterpiece) is selected in market UI.`;
      btn.addEventListener("click", () => {
        byId("input-watch-query").value = it.name;
        setActiveView("items");
        logLine(`Filled query from catalog: ${it.name}`);
      });
      wrap.appendChild(btn);
    }
    details.appendChild(wrap);

    if (items.length > CATALOG_RENDER_CAP) {
      const more = document.createElement("div");
      more.className = "catalog-more";
      more.textContent = `... and ${items.length - CATALOG_RENDER_CAP} more - refine search`;
      details.appendChild(more);
    }
    root.appendChild(details);
  }
}

function collectItemsForCategory(categoryId) {
  if (!state.itemCatalog?.categories) return [];
  const allItems = state.itemCatalog.categories.flatMap((section) => section.items || []);
  if (categoryId === "all") {
    return allItems.map((item) => ({ id: item.id, name: item.name, tier: item.tier, enchant: item.enchant }));
  }
  const inferCategoryFromId = (id = "") => {
    const u = String(id).toUpperCase();
    if (u.includes("ARTEFACT") || u.includes("ARTIFACT") || u.includes("_RUNE") || u.includes("_SOUL") || u.includes("_RELIC")) return "artifact";
    if (u.includes("_MAIN_") || (u.includes("_2H_") && !u.includes("_2H_TOOL_"))) return "weapons";
    if (u.includes("_ARMOR_")) return "chest_armor";
    if (u.includes("_HEAD_")) return "head_armor";
    if (u.includes("_SHOES_")) return "foot_armor";
    if (u.includes("_OFF_")) return "off_hands";
    if (u.includes("CAPE")) return "capes";
    if (/^T\d+_BAG/i.test(id)) return "bags";
    if (u.includes("MOUNT")) return "mount";
    if (u.includes("_TOOL_")) return "gathering_equipment";
    if (u.includes("FARM") || u.includes("SEED") || u.includes("BABY") || u.includes("MOUNT_GROWN")) return "farming";
    if (u.includes("FURNITURE") || u.includes("HOUSE") || u.includes("TROPHY")) return "furniture";
    if (u.includes("VANITY") || u.includes("SKIN")) return "vanity";
    if (u.includes("MATERIAL") || u.includes("METALBAR") || u.includes("PLANK") || u.includes("CLOTH") || u.includes("LEATHER")) return "crafting";
    return "consumable";
  };
  return allItems
    .filter((item) => (item.exactCategoryId || inferCategoryFromId(item.id)) === categoryId)
    .map((item) => ({ id: item.id, name: item.name, tier: item.tier, enchant: item.enchant }));
}

async function loadPriceHistory() {
  try {
    const payload = await window.botApi.getPriceHistory(1000);
    state.historyRows = payload.rows || [];
    renderHistoryRows();
  } catch (error) {
    logLine(`History load failed: ${error.message}`);
  }
}

function renderMarketDbSummary() {
  const node = byId("market-db-summary");
  if (!node) return;
  const total = state.marketDbRows.length;
  if (total === 0) {
    node.textContent = "No rows found for current filters.";
    return;
  }
  node.textContent = `Rows: ${total} · Source: bot database`;
}

function repopulateFilterSelect(id, values, allLabel, selectedValue = "") {
  const sel = byId(id);
  if (!sel) return;
  const prev = selectedValue || sel.value || "";
  sel.innerHTML = "";
  const base = document.createElement("option");
  base.value = "";
  base.textContent = allLabel;
  sel.appendChild(base);
  for (const value of values) {
    const opt = document.createElement("option");
    opt.value = String(value);
    opt.textContent = String(value);
    sel.appendChild(opt);
  }
  sel.value = [...sel.options].some((o) => o.value === prev) ? prev : "";
}

function renderMarketDbRows() {
  const body = byId("market-db-body");
  if (!body) return;
  body.innerHTML = "";
  for (const row of state.marketDbRows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.item || "-"}</td>
      <td>${row.tier ?? "-"}</td>
      <td>${row.enchant ?? 0}</td>
      <td>${row.city || "-"}</td>
      <td>${row.category || "-"}</td>
      <td>${row.type || "-"}</td>
      <td>${row.quality || "-"}</td>
      <td class="price-cell">${normalizeDisplayPrice(row.price)}</td>
      <td>${formatRowTime(row.last_updated)}</td>
    `;
    body.appendChild(tr);
  }
  renderMarketDbSummary();
}

async function loadMarketPriceRows() {
  const payload = {
    search: state.marketDbFilters.search || "",
    category: state.marketDbFilters.category || "",
    type: state.marketDbFilters.type || "",
    tier: state.marketDbFilters.tier || "",
    enchant: state.marketDbFilters.enchant || "",
    city: state.marketDbFilters.city || "",
    sort: state.marketDbFilters.sort || "last_updated_desc",
    limit: MARKET_DB_FETCH_LIMIT,
    offset: 0,
    botOnly: true,
  };
  const res = await request("getMarketPriceRows", payload);
  state.marketDbRows = Array.isArray(res?.rows) ? res.rows : [];
  const f = res?.filters || {};
  repopulateFilterSelect("market-filter-category", f.categories || [], "All Categories", state.marketDbFilters.category);
  repopulateFilterSelect("market-filter-type", f.types || [], "All Types", state.marketDbFilters.type);
  repopulateFilterSelect("market-filter-tier", f.tiers || [], "All Tiers", state.marketDbFilters.tier);
  repopulateFilterSelect("market-filter-enchant", f.enchants || [], "All Enchants", state.marketDbFilters.enchant);
  repopulateFilterSelect("market-filter-city", f.cities || [], "All Regions", state.marketDbFilters.city);
  renderMarketDbRows();
}

function openStartFetchFlow() {
  if (state.isCategoryFetchRunning) return;
  if (state.selectedCity) {
    startCategoryFetchWithCity(state.selectedCity).catch((error) => {
      logLine(`Category fetch failed: ${error.message}`);
    });
    return;
  }
  openFetchCityModal();
}

async function startCategoryFetchWithCity(city) {
  if (state.isCategoryFetchRunning) return;
  const marketCity = String(city || "").trim();
  if (!marketCity) {
    logLine("Choose a city before starting.");
    return;
  }
  await refreshCalibrationState();
  if (!state.searchPoint || !state.region) {
    logLine("Cannot start fetch: calibrate Search Point and Price Region first.");
    return;
  }
  const categoryId = byId("select-fetch-category").value;
  const categoryMeta = EXACT_CATEGORY_ORDER.find((c) => c.id === categoryId);
  let items = collectItemsForCategory(categoryId);
  if (items.length === 0) {
    await loadItemCatalog(true);
    items = collectItemsForCategory(categoryId);
  }
  if (items.length === 0) {
    logLine(`No items mapped for category: ${categoryMeta?.label || categoryId}`);
    return;
  }

  state.isCategoryFetchRunning = true;
  state.categoryProgress = {
    done: 0,
    total: items.length,
    failures: 0,
    item: "",
    category: categoryMeta?.label || categoryId,
    city: marketCity,
  };
  renderCategoryProgress();
  setActiveView("check");
  await window.botApi.setWindowProgress(0);
  await window.botApi.minimizeWindow();
  await sleep(350);
  logLine(
    `Starting category fetch: ${categoryMeta?.label || categoryId} @ ${marketCity} (${items.length} items)`,
  );

  try {
    logLine("Electron minimized. Keep Albion market window focused.");
    await window.botApi.runCategoryScan(categoryId, items, marketCity);
    await refreshResumeCheckpointState();
    logLine("Category fetch started.");
  } catch (error) {
    logLine(`Category fetch failed: ${error.message}`);
    state.isCategoryFetchRunning = false;
    renderCategoryProgress();
    await window.botApi.setWindowProgress(-1);
    await window.botApi.restoreWindow();
  }
}

function loadUiPrefs() {
  try {
    const raw = localStorage.getItem(UI_PREFS_KEY);
    if (!raw) return;
    const prefs = JSON.parse(raw);
    if (prefs.writeMs != null) byId("setting-write-ms").value = prefs.writeMs;
    if (prefs.clickMs != null) byId("setting-click-ms").value = prefs.clickMs;
    if (prefs.listenMs != null) byId("setting-listen-ms").value = prefs.listenMs;
  } catch (_error) {
    // ignore corrupted local prefs
  }
}

function saveUiPrefs() {
  const prefs = {
    writeMs: toNumber(byId("setting-write-ms")?.value, 100),
    clickMs: toNumber(byId("setting-click-ms")?.value, 100),
    listenMs: toNumber(byId("setting-listen-ms")?.value, 300),
  };
  localStorage.setItem(UI_PREFS_KEY, JSON.stringify(prefs));
  logLine("Settings saved locally.");
}

function resetUiPrefs() {
  localStorage.removeItem(UI_PREFS_KEY);
  byId("setting-write-ms").value = 100;
  byId("setting-click-ms").value = 100;
  byId("setting-listen-ms").value = 300;
  logLine("Settings reset to defaults.");
}

function wireNavigation() {
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => setActiveView(btn.dataset.view));
  });
}

function wireActions() {
  byId("input-watch-filter")?.addEventListener("input", (event) => {
    state.watchFilter = event.target.value;
    renderWatchlist();
  });

  const catalogFilterInput = byId("input-catalog-filter");
  catalogFilterInput?.addEventListener("input", (event) => {
    state.catalogFilter = event.target.value;
    clearTimeout(catalogFilterDebounce);
    catalogFilterDebounce = setTimeout(() => renderCatalogAccordion(), 140);
  });

  byId("btn-catalog-clear")?.addEventListener("click", () => {
    state.catalogFilter = "";
    catalogFilterInput.value = "";
    renderCatalogAccordion();
  });

  byId("btn-catalog-refresh")?.addEventListener("click", async () => {
    await loadItemCatalog(true);
  });

  byId("btn-watch-add")?.addEventListener("click", async () => {
    const queryText = byId("input-watch-query").value.trim();
    if (!queryText) {
      logLine("Watch item query is required.");
      return;
    }
    const targetRaw = byId("input-watch-target").value.trim();
    await request("addWatchItem", {
      queryText,
      targetPrice: targetRaw ? Number(targetRaw) : null,
      minProfitPct: toNumber(byId("input-watch-profit").value, 5),
      tags: [],
    });
    byId("input-watch-query").value = "";
    await refreshWatchlist();
    logLine("Watch item added");
  });

  byId("btn-start-category-fetch")?.addEventListener("click", openStartFetchFlow);
  byId("city-chip-list")?.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const city = target.dataset.city;
    if (!city) return;
    setSelectedCity(city);
    logLine(`Selected city: ${city}`);
  });
  byId("btn-fetch-city-confirm")?.addEventListener("click", async () => {
    const sel = byId("select-fetch-city");
    const city = sel?.value?.trim() || "";
    if (!city) {
      logLine("Select a city.");
      return;
    }
    setSelectedCity(city);
    setFetchCityModalVisible(false);
    await startCategoryFetchWithCity(city);
  });
  byId("btn-fetch-city-close")?.addEventListener("click", () => setFetchCityModalVisible(false));
  byId("fetch-city-modal")?.addEventListener("click", (event) => {
    if (event.target.id === "fetch-city-modal") {
      setFetchCityModalVisible(false);
    }
  });

  byId("btn-stop-category-fetch")?.addEventListener("click", async () => {
    await window.botApi.stopCategoryScan();
    logLine("Stop requested. Waiting for current item to finish.");
  });
  byId("btn-resume-last-scan")?.addEventListener("click", async () => {
    if (state.isCategoryFetchRunning) return;
    try {
      const response = await request("resumeCategoryScanFromCheckpoint");
      if (response?.running) {
        logLine("Resuming saved category scan...");
      } else {
        logLine("No resumable scan found.");
      }
      await refreshResumeCheckpointState();
    } catch (error) {
      logLine(`Resume failed: ${error.message}`);
      await refreshResumeCheckpointState();
    }
  });
  byId("btn-discard-last-scan")?.addEventListener("click", async () => {
    if (state.isCategoryFetchRunning) return;
    try {
      await request("clearCategoryScanCheckpoint");
      logLine("Saved scan checkpoint discarded.");
    } catch (error) {
      logLine(`Discard failed: ${error.message}`);
    }
    await refreshResumeCheckpointState();
  });

  byId("btn-capture-search-point")?.addEventListener("click", async () => {
    logLine("Pick mode: click the exact market search box point (Esc to cancel).");
    const point = await request("selectPoint");
    if (!point) {
      logLine("Search point selection cancelled.");
      return;
    }
    await request("setSearchPoint", point);
    state.searchPoint = point;
    renderCalibrationStatus();
    logLine(`Search point set: ${state.searchPoint.x},${state.searchPoint.y}`);
  });

  byId("btn-draw-price-region")?.addEventListener("click", async () => {
    const region = await request("selectRegion");
    if (!region) {
      logLine("Price region selection cancelled.");
      return;
    }
    await request("setRegion", region);
    state.region = region;
    renderCalibrationStatus();
    logLine(`Price region set: ${state.region.width}x${state.region.height}`);
  });

  byId("btn-clear-live-rows")?.addEventListener("click", () => {
    state.liveRows = [];
    renderLiveRows();
  });

  byId("market-filter-search")?.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    state.marketDbFilters.search = target.value || "";
    clearTimeout(marketFilterDebounce);
    marketFilterDebounce = setTimeout(() => {
      loadMarketPriceRows().catch((error) => logLine(`Market DB load failed: ${error.message}`));
    }, MARKET_FILTER_DEBOUNCE_MS);
  });
  byId("market-filter-category")?.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) return;
    state.marketDbFilters.category = target.value || "";
    loadMarketPriceRows().catch((error) => logLine(`Market DB load failed: ${error.message}`));
  });
  byId("market-filter-type")?.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) return;
    state.marketDbFilters.type = target.value || "";
    loadMarketPriceRows().catch((error) => logLine(`Market DB load failed: ${error.message}`));
  });
  byId("market-filter-tier")?.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) return;
    state.marketDbFilters.tier = target.value || "";
    loadMarketPriceRows().catch((error) => logLine(`Market DB load failed: ${error.message}`));
  });
  byId("market-filter-enchant")?.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) return;
    state.marketDbFilters.enchant = target.value || "";
    loadMarketPriceRows().catch((error) => logLine(`Market DB load failed: ${error.message}`));
  });
  byId("market-filter-city")?.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) return;
    state.marketDbFilters.city = target.value || "";
    loadMarketPriceRows().catch((error) => logLine(`Market DB load failed: ${error.message}`));
  });
  byId("market-filter-sort")?.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) return;
    state.marketDbFilters.sort = target.value || "last_updated_desc";
    loadMarketPriceRows().catch((error) => logLine(`Market DB load failed: ${error.message}`));
  });

  byId("btn-help")?.addEventListener("click", () => {
    const hidden = byId("help-modal").classList.contains("is-hidden");
    setHelpVisible(hidden);
  });
  byId("btn-help-close")?.addEventListener("click", () => setHelpVisible(false));
  byId("help-modal")?.addEventListener("click", (event) => {
    if (event.target.id === "help-modal") {
      setHelpVisible(false);
    }
  });

  byId("btn-save-settings")?.addEventListener("click", saveUiPrefs);
  byId("btn-reset-settings")?.addEventListener("click", resetUiPrefs);

  document.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();
    // Local fallback for scan hotkeys when global shortcuts are blocked by OS/game focus rules.
    if (!event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey) {
      if (key === "f1") {
        event.preventDefault();
        window.botApi.scanControl("togglePause")
          .then((res) => logLine(`Scan ${res?.paused ? "paused" : "resumed"} (F1).`))
          .catch((error) => logLine(`F1 failed: ${error.message}`));
        return;
      }
      if (key === "f2") {
        event.preventDefault();
        window.botApi.scanControl("skip")
          .then(() => logLine("Skipped current delay (F2)."))
          .catch((error) => logLine(`F2 failed: ${error.message}`));
        return;
      }
      if (key === "f5") {
        event.preventDefault();
        window.botApi.scanControl("stop")
          .then(() => logLine("Stop requested (F5)."))
          .catch((error) => logLine(`F5 failed: ${error.message}`));
        return;
      }
    }
    if (!(event.ctrlKey && event.shiftKey)) return;
    if (key === "f") {
      event.preventDefault();
      setActiveView("check");
      openStartFetchFlow();
    } else if (key === "s") {
      event.preventDefault();
      window.botApi
        .stopCategoryScan()
        .then(() => {
          logLine("Stop requested by shortcut.");
        })
        .catch((error) => logLine(`Stop request failed: ${error.message}`));
    } else if (key === "1") {
      event.preventDefault();
      setActiveView("items");
    } else if (key === "2") {
      event.preventDefault();
      setActiveView("check");
    } else if (key === "h") {
      event.preventDefault();
      const hidden = byId("help-modal").classList.contains("is-hidden");
      setHelpVisible(hidden);
    }
  });
}

function wireEvents() {
  window.botApi.onEvent((message) => {
    if (message.event === "watchlistChanged") {
      state.watchlist = message.payload.items || [];
      renderWatchlist();
      return;
    }
    if (message.event === "categoryScanStarted") {
      const payload = message.payload || {};
      const catId = payload.categoryId || "";
      const catLabel = EXACT_CATEGORY_ORDER.find((c) => c.id === catId)?.label || catId;
      state.isCategoryFetchRunning = true;
      state.categoryProgress = {
        done: 0,
        total: payload.totalItems || 0,
        failures: 0,
        item: "",
        category: catLabel,
        city: payload.city || "",
      };
      renderCategoryProgress();
      renderResumeCheckpointState();
      return;
    }
    if (message.event === "categoryScanItem") {
      const payload = message.payload || {};
      const scan = payload.scanResult || {};
      const rawScanValue = Number(scan.value);
      const normalizedScanValue =
        Number.isFinite(rawScanValue) && rawScanValue > 1 ? Math.round(rawScanValue) : 0;
      const displayItemName = String(payload.item?.name || "").trim() || String(scan.queryText || "").replace(/\s+\d+\.\d+\s*$/, "");
      state.liveRows.unshift({
        timestamp: scan.timestamp,
        city: payload.city || "",
        category: payload.categoryId,
        item_name: displayItemName,
        observed_price: normalizedScanValue,
        confidence: scan.confidence,
        error: scan.error || "",
      });
      state.categoryProgress = {
        ...state.categoryProgress,
        done: payload.index || state.categoryProgress.done,
        total: payload.totalItems || state.categoryProgress.total,
        failures: payload.failures || 0,
        item: scan.queryText || "",
        city: payload.city || state.categoryProgress.city,
      };
      renderLiveRows();
      appendMarketReviewRowFromScan(payload, scan);
      renderCategoryProgress();
      const total = Number(payload.totalItems || 0);
      const done = Number(payload.index || 0);
      if (total > 0) {
        window.botApi.setWindowProgress(Math.max(0, Math.min(1, done / total))).catch(() => {});
      }
      return;
    }
    if (message.event === "categoryScanFinished") {
      const payload = message.payload || {};
      state.isCategoryFetchRunning = false;
      state.categoryProgress = {
        ...state.categoryProgress,
        done: payload.processed || state.categoryProgress.done,
        total: payload.processed || state.categoryProgress.total,
        failures: payload.failures || state.categoryProgress.failures,
        city: payload.city || state.categoryProgress.city,
      };
      renderCategoryProgress();
      window.botApi.setWindowProgress(-1).catch(() => {});
      window.botApi.restoreWindow().catch(() => {});
      window.botApi.closeStatusWindow().catch(() => {});
      loadPriceHistory().catch(() => {});
      loadMarketPriceRows().catch(() => {});
      refreshResumeCheckpointState().catch(() => {});
      logLine(
        `Category fetch ${payload.cancelled ? "stopped" : "done"}: processed=${payload.processed ?? 0}, failures=${payload.failures ?? 0}`,
      );
      return;
    }
    if (message.event === "log") {
      logLine(message.payload.message);
      return;
    }
    if (message.event === "backendExit") {
      setBackendStatus("Exited");
      logLine(`Backend exited code=${message.payload.code} signal=${message.payload.signal}`);
    }
  });
}

async function bootstrap() {
  setBackendStatus("Connected");
  try {
    const ver = await window.botApi.getAppVersion();
    const vNode = byId("footer-version");
    if (vNode) vNode.textContent = `Version ${ver}`;
  } catch (_error) {
    // keep default footer text if version lookup fails
  }
  wireNavigation();
  wireActions();
  wireEvents();
  loadUiPrefs();
  renderCategorySelector();
  renderFetchCityOptions();
  restoreMarketReviewState();
  const marketSearchInput = byId("market-filter-search");
  if (marketSearchInput) marketSearchInput.value = state.marketDbFilters.search;
  const marketSortSelect = byId("market-filter-sort");
  if (marketSortSelect) marketSortSelect.value = state.marketDbFilters.sort || "last_updated_desc";
  setSelectedCity(localStorage.getItem(FETCH_CITY_STORAGE_KEY) || MARKET_CITIES[0]);
  renderCityChips();
  renderCalibrationStatus();
  renderCategoryProgress();
  await loadItemCatalog(false);
  await refreshWatchlist();
  await refreshCalibrationState();
  await loadPriceHistory();
  await refreshResumeCheckpointState();
  scheduleNextDbReadTick();
  renderLiveRows();
  renderMarketDbRows();
  renderMarketPriceRows();
  const restoredPostable = collectRowsForPost({ auto: true }).rowsToPost.length;
  if (restoredPostable > 0) {
    scheduleAutoPostIdleFlush();
  }
  setActiveView("dashboard");
  logLine("Items console ready");
}

bootstrap().catch((error) => {
  setBackendStatus("Error");
  logLine(`Bootstrap failed: ${error.message}`);
});
