/** Royal + Caerleon + Brecilien — set your character in this city’s market before fetching. */
const MARKET_CITIES = [
  "Bridgewatch",
  "Martlock",
  "Thetford",
  "Fort Sterling",
  "Lymhurst",
  "Caerleon",
  "Brecilien",
];

const FETCH_CITY_STORAGE_KEY = "albionMarketFetchCity";

const EXACT_CATEGORY_ORDER = [
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
  activeTab: "items",
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
  draftSearchPoint: null,
  draftRegion: null,
};

const CATALOG_RENDER_CAP = 400;
let catalogFilterDebounce = null;

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

function setFetchCityModalVisible(visible) {
  const modal = byId("fetch-city-modal");
  if (!modal) return;
  modal.classList.toggle("is-hidden", !visible);
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

function logLine(message) {
  const panel = byId("log-panel");
  if (!panel) return;
  const stamp = new Date().toLocaleTimeString();
  panel.textContent = `[${stamp}] ${message}\n${panel.textContent}`.slice(0, 12000);
}

function setBackendStatus(text) {
  byId("backend-status").textContent = text;
}

function parseNumberInput(id, fallback = 0) {
  const raw = byId(id).value;
  const val = Number(raw);
  return Number.isFinite(val) ? val : fallback;
}

async function request(command, payload = {}) {
  try {
    return await window.botApi.request(command, payload);
  } catch (error) {
    logLine(`Request ${command} failed: ${error.message}`);
    throw error;
  }
}

function setActiveTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.tab === tab);
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("is-active", panel.dataset.tab === tab);
  });
}

function setHelpVisible(visible) {
  const modal = byId("help-modal");
  if (!modal) return;
  modal.classList.toggle("is-hidden", !visible);
}

function renderCategorySelector() {
  const select = byId("select-fetch-category");
  if (!select) return;
  const counts = new Map((state.itemCatalog?.exactCategories || []).map((c) => [c.id, c.count]));
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
  if (btn) {
    btn.disabled = state.isCategoryFetchRunning;
  }
  if (stopBtn) {
    stopBtn.disabled = !state.isCategoryFetchRunning;
  }
  if (!node) return;
  if (!state.isCategoryFetchRunning && progress.total === 0) {
    node.textContent = "Idle";
    return;
  }
  if (!state.isCategoryFetchRunning) {
    node.textContent = `Done: ${progress.done}/${progress.total}, failures: ${progress.failures}${progress.city ? ` · ${progress.city}` : ""}`;
    return;
  }
  node.textContent = `Scanning ${progress.category}${progress.city ? ` @ ${progress.city}` : ""}: ${progress.done}/${progress.total}, failures: ${progress.failures}, current: ${progress.item || "-"}`;
}

function renderCalibrationStatus() {
  const node = byId("calibration-status");
  if (!node) return;
  const hasPoint = Boolean(state.searchPoint && Number.isFinite(state.searchPoint.x));
  const hasRegion = Boolean(state.region && Number.isFinite(state.region.width) && state.region.width > 2);
  if (hasPoint && hasRegion) {
    node.textContent = `Calibration status: ready (search: ${state.searchPoint.x},${state.searchPoint.y} | region: ${state.region.width}x${state.region.height})`;
    return;
  }
  const missing = [];
  if (!hasPoint) missing.push("search point");
  if (!hasRegion) missing.push("price region");
  node.textContent = `Calibration status: missing ${missing.join(" + ")}`;
}

function renderCalibrationDraftStatus() {
  const node = byId("calibration-draft-status");
  if (!node) return;
  const hasDraftPoint = Boolean(state.draftSearchPoint);
  const hasDraftRegion = Boolean(state.draftRegion);
  if (!hasDraftPoint && !hasDraftRegion) {
    node.textContent = "Pending changes: none";
  } else {
    const chunks = [];
    if (hasDraftPoint) chunks.push("Search Point");
    if (hasDraftRegion) chunks.push("OCR Region");
    node.textContent = `Pending changes: ${chunks.join(" + ")} (click Save)`;
  }
  const savePointBtn = byId("btn-save-search-point");
  const saveRegionBtn = byId("btn-save-price-region");
  if (savePointBtn) savePointBtn.disabled = !hasDraftPoint;
  if (saveRegionBtn) saveRegionBtn.disabled = !hasDraftRegion;
}

function renderWatchlist() {
  const watchBody = byId("watchlist-body");
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
      <td><button data-action="remove-watch" data-id="${item.id}">Remove</button></td>
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

function renderLiveRows() {
  const body = byId("live-prices-body");
  if (!body) return;
  body.innerHTML = "";
  for (const row of state.liveRows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${formatRowTime(row.timestamp)}</td>
      <td>${row.city || "-"}</td>
      <td>${row.category || "-"}</td>
      <td>${row.item_name || row.queryText || "-"}</td>
      <td>${row.observed_price ?? row.value ?? "--"}</td>
      <td>${row.confidence ?? "--"}</td>
      <td>${row.error || ""}</td>
    `;
    body.appendChild(tr);
  }
}

function renderHistoryRows() {
  const body = byId("history-prices-body");
  if (!body) return;
  body.innerHTML = "";
  for (const row of state.historyRows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${formatRowTime(row.timestamp)}</td>
      <td>${row.city || "-"}</td>
      <td>${row.category || "-"}</td>
      <td>${row.item_name || "-"}</td>
      <td>${row.observed_price ?? "--"}</td>
      <td>${row.tier ?? "-"}</td>
      <td>${row.enchant ?? "-"}</td>
      <td>${row.error || ""}</td>
    `;
    body.appendChild(tr);
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
    state.draftSearchPoint = null;
    state.draftRegion = null;
    renderCalibrationStatus();
    renderCalibrationDraftStatus();
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
    .map((item) => ({
      id: item.id,
      name: item.name,
      tier: item.tier,
      enchant: item.enchant,
    }));
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

function openStartFetchFlow() {
  if (state.isCategoryFetchRunning) return;
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
    // Auto-recover from stale cached catalog schema.
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
  await window.botApi.setWindowProgress(0);
  await window.botApi.minimizeWindow();
  logLine(
    `Starting category fetch: ${categoryMeta?.label || categoryId} @ ${marketCity} (${items.length} items)`,
  );

  try {
    logLine("Electron minimized. Keep Albion market window focused.");
    await window.botApi.runCategoryScan(categoryId, items, marketCity);
    logLine("Category fetch started.");
  } catch (error) {
    logLine(`Category fetch failed: ${error.message}`);
    state.isCategoryFetchRunning = false;
    renderCategoryProgress();
    await window.botApi.setWindowProgress(-1);
    await window.botApi.restoreWindow();
  }
}

function wireTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => setActiveTab(btn.dataset.tab));
  });
}

function wireActions() {
  byId("input-watch-filter").addEventListener("input", (event) => {
    state.watchFilter = event.target.value;
    renderWatchlist();
  });

  const catalogFilterInput = byId("input-catalog-filter");
  catalogFilterInput.addEventListener("input", (event) => {
    state.catalogFilter = event.target.value;
    clearTimeout(catalogFilterDebounce);
    catalogFilterDebounce = setTimeout(() => renderCatalogAccordion(), 140);
  });

  byId("btn-catalog-clear").addEventListener("click", () => {
    state.catalogFilter = "";
    catalogFilterInput.value = "";
    renderCatalogAccordion();
  });

  byId("btn-catalog-refresh").addEventListener("click", async () => {
    await loadItemCatalog(true);
  });

  byId("btn-watch-add").addEventListener("click", async () => {
    const queryText = byId("input-watch-query").value.trim();
    if (!queryText) {
      logLine("Watch item query is required.");
      return;
    }
    const targetRaw = byId("input-watch-target").value.trim();
    await request("addWatchItem", {
      queryText,
      targetPrice: targetRaw ? Number(targetRaw) : null,
      minProfitPct: parseNumberInput("input-watch-profit", 5),
      tags: [],
    });
    byId("input-watch-query").value = "";
    await refreshWatchlist();
    logLine("Watch item added");
  });

  byId("btn-start-category-fetch").addEventListener("click", openStartFetchFlow);
  byId("btn-fetch-city-confirm").addEventListener("click", async () => {
    const sel = byId("select-fetch-city");
    const city = sel?.value?.trim() || "";
    if (!city) {
      logLine("Select a city.");
      return;
    }
    localStorage.setItem(FETCH_CITY_STORAGE_KEY, city);
    setFetchCityModalVisible(false);
    await startCategoryFetchWithCity(city);
  });
  byId("btn-fetch-city-close").addEventListener("click", () => setFetchCityModalVisible(false));
  byId("fetch-city-modal")?.addEventListener("click", (event) => {
    if (event.target.id === "fetch-city-modal") {
      setFetchCityModalVisible(false);
    }
  });
  byId("btn-stop-category-fetch").addEventListener("click", async () => {
    await window.botApi.stopCategoryScan();
    logLine("Stop requested. Waiting for current item to finish.");
  });
  byId("btn-capture-search-point").addEventListener("click", async () => {
    logLine("Pick mode: click the exact market search box point (Esc to cancel).");
    const point = await request("selectPoint");
    if (!point) {
      logLine("Search point selection cancelled.");
      return;
    }
    state.draftSearchPoint = point;
    renderCalibrationDraftStatus();
    logLine(`Search point picked (draft): ${point.x},${point.y}`);
  });
  byId("btn-save-search-point").addEventListener("click", async () => {
    if (!state.draftSearchPoint) {
      logLine("No pending Search Point to save.");
      return;
    }
    await request("setSearchPoint", state.draftSearchPoint);
    state.searchPoint = state.draftSearchPoint;
    state.draftSearchPoint = null;
    renderCalibrationStatus();
    renderCalibrationDraftStatus();
    logLine(`Search point saved: ${state.searchPoint.x},${state.searchPoint.y}`);
  });
  byId("btn-draw-price-region").addEventListener("click", async () => {
    const region = await request("selectRegion");
    if (!region) {
      logLine("Price region selection cancelled.");
      return;
    }
    state.draftRegion = region;
    renderCalibrationDraftStatus();
    logLine(`Price region drawn (draft): ${region.width}x${region.height}`);
  });
  byId("btn-save-price-region").addEventListener("click", async () => {
    if (!state.draftRegion) {
      logLine("No pending OCR region to save.");
      return;
    }
    await request("setRegion", state.draftRegion);
    state.region = state.draftRegion;
    state.draftRegion = null;
    renderCalibrationStatus();
    renderCalibrationDraftStatus();
    logLine(`Price region saved: ${state.region.width}x${state.region.height}`);
  });
  byId("btn-refresh-history").addEventListener("click", loadPriceHistory);
  byId("btn-clear-live-rows").addEventListener("click", () => {
    state.liveRows = [];
    renderLiveRows();
  });

  byId("btn-help").addEventListener("click", () => {
    const hidden = byId("help-modal").classList.contains("is-hidden");
    setHelpVisible(hidden);
  });
  byId("btn-help-close").addEventListener("click", () => setHelpVisible(false));
  byId("help-modal").addEventListener("click", (event) => {
    if (event.target.id === "help-modal") {
      setHelpVisible(false);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey && event.shiftKey)) return;
    const key = event.key.toLowerCase();
    if (key === "f") {
      event.preventDefault();
      openStartFetchFlow();
    } else if (key === "s") {
      event.preventDefault();
      window.botApi.stopCategoryScan().then(() => {
        logLine("Stop requested by shortcut.");
      }).catch((error) => logLine(`Stop request failed: ${error.message}`));
    } else if (key === "1") {
      event.preventDefault();
      setActiveTab("items");
    } else if (key === "2") {
      event.preventDefault();
      setActiveTab("prices");
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
      return;
    }
    if (message.event === "categoryScanItem") {
      const payload = message.payload || {};
      const scan = payload.scanResult || {};
      state.liveRows.unshift({
        timestamp: scan.timestamp,
        city: payload.city || "",
        category: payload.categoryId,
        item_name: scan.queryText,
        observed_price: scan.value,
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
      loadPriceHistory().catch(() => {});
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
  wireTabs();
  wireActions();
  wireEvents();
  renderCategorySelector();
  renderFetchCityOptions();
  renderCalibrationStatus();
  renderCalibrationDraftStatus();
  renderCategoryProgress();
  await loadItemCatalog(false);
  await refreshWatchlist();
  await refreshCalibrationState();
  await loadPriceHistory();
  renderLiveRows();
  logLine("Items console ready");
}

bootstrap().catch((error) => {
  setBackendStatus("Error");
  logLine(`Bootstrap failed: ${error.message}`);
});
