/** Royal + Caerleon + Brecilien + Black Market — set your character in this market before fetching. */
const MARKET_CITIES = ["Bridgewatch", "Martlock", "Thetford", "Fort Sterling", "Lymhurst", "Caerleon", "Brecilien", "Black Market"];
const FETCH_CITY_STORAGE_KEY = "albionMarketFetchCity";
const UI_PREFS_KEY = "albionUiPrefs";
const DB_READ_SCHEDULE_UTC_HOURS = [0, 6, 12, 18]; // Albion UTC time slots

const MARKET_FLIP_CATEGORY_ID = "market_flip";
const FLIP_TIERS = [4, 5, 6, 7, 8];
const FLIP_ENCHANTS = [0, 1, 2, 3, 4];

function createInitialMarketFlip() {
  return {
    active: false,
    phase: "idle",
    cityA: "",
    cityB: "",
    baseItems: [],
    prices: new Map(),
    resultRows: [],
  };
}

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
  { id: "all", label: "All Items" },
];

const state = {
  activeView: "dashboard",
  selectedCity: "",
  watchlist: [],
  watchFilter: "",
  catalogFilter: "",
  flipCatalogFilter: "",
  itemCatalog: null,
  liveRows: [],
  historyRows: [],
  isCategoryFetchRunning: false,
  categoryProgress: { done: 0, total: 0, failures: 0, item: "", category: "", city: "" },
  searchPoint: null,
  region: null,
  resumeCheckpoint: null,
  marketFlip: createInitialMarketFlip(),
};

const CATALOG_RENDER_CAP = 400;
let catalogFilterDebounce = null;
let flipCatalogFilterDebounce = null;
let dbReadScheduleTimer = null;
let flipBulkEditorDraft = null;

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

function inferTypeFromItemName(itemName) {
  const text = String(itemName || "").trim();
  if (!text) return "-";
  const parts = text.split(/\s+/);
  if (!parts.length) return "-";
  if (parts.length >= 2 && parts[0].endsWith("'s")) return parts[1];
  return parts[0];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function flipItemKeyFromItem(it) {
  const id = String(it?.id || "").trim();
  const tier = it?.tier != null ? String(it.tier) : "";
  const ench = it?.enchant != null ? String(it.enchant) : "0";
  return `${id}|${tier}|${ench}`;
}

function normalizeFlipMatchName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function flipCanonicalCompositeKey(name, tier, enchant) {
  const t = tier != null && Number.isFinite(Number(tier)) ? Number(tier) : "";
  const e = enchant != null && Number.isFinite(Number(enchant)) ? Number(enchant) : 0;
  return `${normalizeFlipMatchName(name)}|t${t}|e${e}`;
}

function flipTierEnchantKey(tier, enchant) {
  return `${Number(tier)}.${Number(enchant)}`;
}

function parseFlipTierEnchantKey(key) {
  const [tierText, enchantText] = String(key || "").split(".");
  return {
    tier: Number(tierText),
    enchant: Number(enchantText),
  };
}

function extractFlipFamilyName(name) {
  const raw = String(name || "").trim();
  if (!raw) return "";
  return raw.replace(/^[^ ]+'s\s+/i, "").trim() || raw;
}

function buildFlipBaseFromCatalogItem(item) {
  const familyName = extractFlipFamilyName(item?.name);
  const baseKey = familyName.toLowerCase();
  const variants = [];
  if (state.itemCatalog?.categories) {
    const all = state.itemCatalog.categories.flatMap((section) => section.items || []);
    for (const row of all) {
      const rowFamily = extractFlipFamilyName(row?.name).toLowerCase();
      const tier = Number(row?.tier);
      const enchant = Number(row?.enchant ?? 0);
      if (rowFamily !== baseKey) continue;
      if (!FLIP_TIERS.includes(tier) || !FLIP_ENCHANTS.includes(enchant)) continue;
      variants.push({ id: row.id, name: row.name, tier, enchant });
    }
  }
  variants.sort((a, b) => (a.tier - b.tier) || (a.enchant - b.enchant));
  const selectedVariantKeys = variants.map((row) => flipTierEnchantKey(row.tier, row.enchant));
  return {
    baseKey,
    familyName,
    displayName: familyName || item?.name || "Unknown",
    variants,
    selectedVariantKeys,
  };
}

function getFlipSelectedVariants(baseItems = state.marketFlip.baseItems) {
  const out = [];
  for (const base of baseItems || []) {
    const selected = new Set(base.selectedVariantKeys || []);
    for (const row of base.variants || []) {
      const key = flipTierEnchantKey(row.tier, row.enchant);
      if (selected.has(key)) {
        out.push({ id: row.id, name: row.name, tier: row.tier, enchant: row.enchant ?? 0 });
      }
    }
  }
  return out;
}

function flipItemKeyFromPayload(payload) {
  const item = payload?.item || {};
  const id = String(item.id || "").trim();
  if (id) {
    const tier = item.tier != null ? String(item.tier) : "";
    const ench = item.enchant != null ? String(item.enchant) : "0";
    return `${id}|${tier}|${ench}`;
  }
  const qt = String(payload?.scanResult?.queryText || "").trim();
  return `q:${qt}`;
}

function marketFlipBlocking() {
  const mf = state.marketFlip;
  if (!mf?.active) return false;
  return mf.phase === "running_1" || mf.phase === "running_2" || mf.phase === "handoff";
}

function resetMarketFlipSession() {
  const keptItems = (state.marketFlip.baseItems || []).map((base) => ({
    ...base,
    variants: [...(base.variants || [])],
    selectedVariantKeys: [...(base.selectedVariantKeys || [])],
  }));
  state.marketFlip = createInitialMarketFlip();
  state.marketFlip.baseItems = keptItems;
  renderMarketFlipChrome();
  renderMarketFlipItems();
}

function formatFlipSilver(n) {
  if (n == null || !Number.isFinite(Number(n))) return "--";
  return Math.round(Number(n)).toLocaleString();
}

function renderFlipCitySelectors() {
  const selectA = byId("select-flip-city-a");
  const selectB = byId("select-flip-city-b");
  if (!selectA || !selectB) return;
  const prevA = selectA.value || state.marketFlip.cityA;
  const prevB = selectB.value || state.marketFlip.cityB;
  selectA.innerHTML = "";
  selectB.innerHTML = "";
  for (const c of MARKET_CITIES) {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c;
    selectA.appendChild(opt);
    selectB.appendChild(opt.cloneNode(true));
  }
  const fallbackA = MARKET_CITIES.includes(state.selectedCity) ? state.selectedCity : MARKET_CITIES[0];
  const fallbackB = MARKET_CITIES.find((c) => c !== fallbackA) || MARKET_CITIES[0];
  selectA.value = MARKET_CITIES.includes(prevA) ? prevA : fallbackA;
  selectB.value = MARKET_CITIES.includes(prevB) ? prevB : fallbackB;
  if (selectA.value === selectB.value) {
    const alt = MARKET_CITIES.find((c) => c !== selectA.value);
    if (alt) selectB.value = alt;
  }
}

function renderMarketFlipItems() {
  const body = byId("flip-items-body");
  if (!body) return;
  body.replaceChildren();
  for (const base of state.marketFlip.baseItems || []) {
    const selectedKeys = new Set(base.selectedVariantKeys || []);
    const rows = (base.variants || [])
      .filter((row) => selectedKeys.has(flipTierEnchantKey(row.tier, row.enchant)))
      .sort((a, b) => (a.tier - b.tier) || (a.enchant - b.enchant));
    const tr = document.createElement("tr");
    const tdName = document.createElement("td");
    tdName.textContent = base.displayName || "-";
    const tdSelected = document.createElement("td");
    if (rows.length) {
      const details = document.createElement("details");
      details.className = "flip-selected-details";
      const summary = document.createElement("summary");
      summary.textContent = `${rows.length} selected`;
      details.appendChild(summary);
      for (const row of rows) {
        const line = document.createElement("div");
        line.className = "flip-selected-line";
        line.textContent = `${row.name} ${row.tier}.${row.enchant}`;
        details.appendChild(line);
      }
      tdSelected.appendChild(details);
    } else {
      tdSelected.textContent = "No variants selected";
      tdSelected.className = "muted-text";
    }
    const tdBulk = document.createElement("td");
    const bulkBtn = document.createElement("button");
    bulkBtn.type = "button";
    bulkBtn.className = "btn-secondary";
    bulkBtn.dataset.flipBulkBase = base.baseKey;
    bulkBtn.textContent = "Bulk";
    tdBulk.appendChild(bulkBtn);
    const tdDelete = document.createElement("td");
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "btn-secondary";
    deleteBtn.dataset.flipRemoveBase = base.baseKey;
    deleteBtn.textContent = "Delete";
    tdDelete.appendChild(deleteBtn);
    tr.appendChild(tdName);
    tr.appendChild(tdSelected);
    tr.appendChild(tdBulk);
    tr.appendChild(tdDelete);
    body.appendChild(tr);
  }
  const selectedVariants = getFlipSelectedVariants();
  const hint = byId("flip-items-hint");
  if (hint) {
    hint.textContent = `${(state.marketFlip.baseItems || []).length} base item(s) · ${selectedVariants.length} variant(s) selected.`;
  }
  const checkBtn = byId("btn-flip-check-selected");
  if (checkBtn) checkBtn.disabled = selectedVariants.length === 0 || state.isCategoryFetchRunning || marketFlipBlocking();
  renderFlipCatalogAccordion();
}

function renderFlipCatalogAccordion() {
  const root = byId("flip-catalog-accordion");
  const status = byId("flip-catalog-status");
  if (!root) return;
  root.replaceChildren();
  const cat = state.itemCatalog;
  if (!cat?.categories) {
    if (status) status.textContent = "Catalog not loaded.";
    return;
  }
  const selectedBaseKeys = new Set((state.marketFlip.baseItems || []).map((it) => it.baseKey));
  const filt = state.flipCatalogFilter.trim().toLowerCase();
  let totalShown = 0;
  const checkCategories = EXACT_CATEGORY_ORDER.filter((c) => c.id !== "all");
  for (const section of checkCategories) {
    const sourceItems = collectItemsForCategory(section.id);
    const items = filt
      ? sourceItems.filter((it) => {
          const hay = `${String(it.name || "").toLowerCase()} ${String(it.id || "").toLowerCase()}`;
          return hay.includes(filt);
        })
      : sourceItems;
    if (!items.length) continue;
    const unique = new Map();
    for (const it of items) {
      const familyName = extractFlipFamilyName(it?.name);
      const baseKey = familyName.toLowerCase();
      if (!baseKey || unique.has(baseKey)) continue;
      unique.set(baseKey, { it, familyName, baseKey });
    }
    const uniqueRows = Array.from(unique.values());
    if (!uniqueRows.length) continue;
    const details = document.createElement("details");
    details.className = "catalog-section";
    if (filt) details.open = true;
    const summary = document.createElement("summary");
    const label = document.createElement("span");
    label.textContent = section.label;
    summary.appendChild(label);
    const count = document.createElement("span");
    count.className = "catalog-count";
    count.textContent = `${uniqueRows.length}`;
    summary.appendChild(count);
    details.appendChild(summary);
    const wrap = document.createElement("div");
    wrap.className = "catalog-items";
    const slice = uniqueRows.slice(0, CATALOG_RENDER_CAP);
    for (const row of slice) {
      const it = row.it;
      const familyName = row.familyName;
      const baseKey = row.baseKey;
      const isSelected = selectedBaseKeys.has(baseKey);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "catalog-item";
      if (isSelected) btn.classList.add("is-selected");
      btn.title = isSelected ? "Already selected for Market Flip" : "Click to add to Market Flip";
      const nameSpan = document.createElement("span");
      nameSpan.className = "catalog-item-name";
      nameSpan.textContent = familyName || it.name;
      btn.appendChild(nameSpan);
      btn.addEventListener("click", () => {
        if (selectedBaseKeys.has(baseKey)) return;
        const base = buildFlipBaseFromCatalogItem(it);
        state.marketFlip.baseItems.push(base);
        renderMarketFlipItems();
        logLine(`Added to Market Flip: ${base.displayName}`);
      });
      wrap.appendChild(btn);
      totalShown += 1;
    }
    details.appendChild(wrap);
    if (uniqueRows.length > CATALOG_RENDER_CAP) {
      const more = document.createElement("div");
      more.className = "catalog-more";
      more.textContent = `... and ${uniqueRows.length - CATALOG_RENDER_CAP} more - refine search`;
      details.appendChild(more);
    }
    root.appendChild(details);
  }
  if (status) {
    status.textContent = filt
      ? `Showing ${totalShown} catalog matches. Click an item to add.`
      : "Click an item to add to Market Flip selection.";
  }
}

function setFlipBulkModalVisible(visible) {
  const modal = byId("flip-bulk-modal");
  if (!modal) return;
  modal.classList.toggle("is-hidden", !visible);
}

function renderFlipBulkEditor() {
  const title = byId("flip-bulk-title");
  const body = byId("flip-bulk-body");
  if (!body) return;
  body.replaceChildren();
  if (!flipBulkEditorDraft) {
    if (title) title.textContent = "Bulk Tier/Enchant";
    return;
  }
  if (title) title.textContent = `${flipBulkEditorDraft.displayName} · Tier/Enchant`;
  for (const tier of FLIP_TIERS) {
    const row = document.createElement("div");
    row.className = "flip-bulk-row";
    const label = document.createElement("span");
    label.className = "flip-bulk-tier-label";
    label.textContent = `T${tier}`;
    row.appendChild(label);
    const chips = document.createElement("div");
    chips.className = "flip-bulk-chip-row";
    for (const enchant of FLIP_ENCHANTS) {
      const key = flipTierEnchantKey(tier, enchant);
      const hasVariant = flipBulkEditorDraft.availableKeys.has(key);
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = `flip-chip${flipBulkEditorDraft.selectedKeys.has(key) ? " is-selected" : ""}`;
      chip.textContent = `${tier}.${enchant}`;
      chip.disabled = !hasVariant;
      chip.dataset.flipBulkToggle = key;
      chips.appendChild(chip);
    }
    row.appendChild(chips);
    body.appendChild(row);
  }
}

function openFlipBulkEditor(baseKey) {
  const base = (state.marketFlip.baseItems || []).find((row) => row.baseKey === baseKey);
  if (!base) return;
  flipBulkEditorDraft = {
    baseKey: base.baseKey,
    displayName: base.displayName,
    availableKeys: new Set((base.variants || []).map((row) => flipTierEnchantKey(row.tier, row.enchant))),
    selectedKeys: new Set(base.selectedVariantKeys || []),
  };
  renderFlipBulkEditor();
  setFlipBulkModalVisible(true);
}

function closeFlipBulkEditor() {
  flipBulkEditorDraft = null;
  setFlipBulkModalVisible(false);
}

function applyFlipBulkEditor() {
  if (!flipBulkEditorDraft) return;
  const base = (state.marketFlip.baseItems || []).find((row) => row.baseKey === flipBulkEditorDraft.baseKey);
  if (!base) {
    closeFlipBulkEditor();
    return;
  }
  base.selectedVariantKeys = Array.from(flipBulkEditorDraft.selectedKeys);
  renderMarketFlipItems();
  closeFlipBulkEditor();
}

function renderMarketFlipResultsTable() {
  const body = byId("flip-results-body");
  if (!body) return;
  body.replaceChildren();
  for (const row of state.marketFlip.resultRows || []) {
    const tr = document.createElement("tr");
    const basicCells = [
      row.name,
      row.tier != null ? String(row.tier) : "-",
      String(row.enchant ?? 0),
      formatFlipSilver(row.cityA),
      formatFlipSilver(row.cityB),
    ];
    for (const text of basicCells) {
      const td = document.createElement("td");
      td.textContent = text;
      tr.appendChild(td);
    }
    const tdSetup = document.createElement("td");
    tdSetup.innerHTML = row.setupHtml || row.notes || "--";
    tr.appendChild(tdSetup);
    const tdProfit = document.createElement("td");
    tdProfit.textContent = formatFlipSilver(row.profit);
    tdProfit.className = row.profit > 0 ? "flip-profit-good" : row.profit < 0 ? "flip-profit-bad" : "";
    tr.appendChild(tdProfit);
    body.appendChild(tr);
  }
}

function renderFlipHandoff() {
  const panel = byId("flip-handoff-panel");
  const btn = byId("btn-flip-continue-phase2");
  const mf = state.marketFlip;
  const show = Boolean(mf.active && mf.phase === "handoff");
  if (panel) panel.classList.toggle("is-hidden", !show);
  if (btn) btn.disabled = !show;
  const nextLab = byId("flip-handoff-next-label");
  if (nextLab && show) {
    nextLab.textContent = mf.cityB || "City B";
  }
}

function renderMarketFlipChrome() {
  const mf = state.marketFlip;
  const st = byId("flip-scan-status");
  const startBtn = byId("btn-flip-start");
  const exportBtn = byId("btn-flip-export-live");
  if (st) {
    if (!mf.active || mf.phase === "idle") {
      st.textContent = "Flip: Idle";
    } else if (mf.phase === "running_1") {
      st.textContent = `Flip: Scanning City A (${mf.cityA})...`;
    } else if (mf.phase === "handoff") {
      st.textContent = "Flip: Open City B market in-game, then click Continue.";
    } else if (mf.phase === "running_2") {
      st.textContent = `Flip: Scanning City B (${mf.cityB})...`;
    } else if (mf.phase === "done") {
      st.textContent = `Flip: Complete (${mf.resultRows.length} compared items).`;
    }
  }
  if (startBtn) {
    startBtn.disabled =
      state.isCategoryFetchRunning || (mf.active && mf.phase !== "idle" && mf.phase !== "done");
  }
  if (exportBtn) {
    exportBtn.disabled = !mf.resultRows?.length || mf.phase !== "done";
  }
  renderFlipHandoff();
  renderMarketFlipResultsTable();
}

function recordMarketFlipPrice(payload, normalizedScanValue, scan) {
  const mf = state.marketFlip;
  if (!mf.active || (mf.phase !== "running_1" && mf.phase !== "running_2")) return;
  if (payload.categoryId !== MARKET_FLIP_CATEGORY_ID) return;
  const city = String(payload.city || "").trim();
  const key = flipItemKeyFromPayload(payload);
  let slot = mf.prices.get(key);
  if (!slot) {
    slot = { cityA: null, cityB: null, errA: "", errB: "" };
  }
  const price = normalizedScanValue > 0 ? normalizedScanValue : null;
  const err = String(scan?.error || "");
  if (city === mf.cityA) {
    slot.cityA = price;
    if (err) slot.errA = err;
  } else if (city === mf.cityB) {
    slot.cityB = price;
    if (err) slot.errB = err;
  }
  mf.prices.set(key, slot);
}

function finalizeMarketFlipResults() {
  const mf = state.marketFlip;
  const selectedVariants = getFlipSelectedVariants(mf.baseItems);
  const rows = [];
  for (const it of selectedVariants) {
    const key = flipItemKeyFromItem(it);
    const slot = mf.prices.get(key) || { cityA: null, cityB: null, errA: "", errB: "" };
    const priceA = slot.cityA;
    const priceB = slot.cityB;
    let setupHtml = "--";
    let profit = null;
    if (priceA != null && priceB != null) {
      if (priceA < priceB) {
        setupHtml = `<span class="flip-city-a">City A</span> → <span class="flip-city-b">City B</span>`;
        profit = priceB - priceA;
      } else if (priceB < priceA) {
        setupHtml = `<span class="flip-city-a">City B</span> → <span class="flip-city-b">City A</span>`;
        profit = priceA - priceB;
      } else {
        setupHtml = "Same price";
        profit = 0;
      }
    }
    const notes = [slot.errA && `City A: ${slot.errA}`, slot.errB && `City B: ${slot.errB}`]
      .filter(Boolean)
      .join("; ");
    rows.push({
      name: it.name,
      tier: it.tier,
      enchant: it.enchant ?? 0,
      cityA: priceA,
      cityB: priceB,
      setupHtml,
      profit,
      notes,
    });
  }
  mf.resultRows = rows;
}

function _buildFlipResultsFromRows(rows, cityA, cityB) {
  const map = new Map();
  for (const row of rows) {
    const key = `${row.item_name}|${row.tier ?? ""}|${row.enchant ?? 0}`;
    let slot = map.get(key);
    if (!slot) {
      slot = {
        name: row.item_name,
        tier: row.tier,
        enchant: row.enchant ?? 0,
        cityA: null,
        cityB: null,
      };
      map.set(key, slot);
    }
    if (row.city === cityA && slot.cityA == null) {
      slot.cityA = Number(row.observed_price ?? row.value ?? 0) || null;
    } else if (row.city === cityB && slot.cityB == null) {
      slot.cityB = Number(row.observed_price ?? row.value ?? 0) || null;
    }
  }
  const out = [];
  for (const slot of map.values()) {
    const priceA = slot.cityA;
    const priceB = slot.cityB;
    let setupHtml = "--";
    let profit = null;
    if (priceA != null && priceB != null) {
      if (priceA < priceB) {
        setupHtml = `<span class="flip-city-a">City A</span> → <span class="flip-city-b">City B</span>`;
        profit = priceB - priceA;
      } else if (priceB < priceA) {
        setupHtml = `<span class="flip-city-a">City B</span> → <span class="flip-city-b">City A</span>`;
        profit = priceA - priceB;
      } else {
        setupHtml = "Same price";
        profit = 0;
      }
    }
    out.push({
      name: slot.name,
      tier: slot.tier,
      enchant: slot.enchant,
      cityA: priceA,
      cityB: priceB,
      setupHtml,
      profit,
      notes: "",
    });
  }
  out.sort((a, b) => String(a.name).localeCompare(String(b.name)) || (a.tier ?? 0) - (b.tier ?? 0) || (a.enchant ?? 0) - (b.enchant ?? 0));
  return out;
}

async function runMarketFlipCategoryInvoke(city) {
  const mf = state.marketFlip;
  const items = getFlipSelectedVariants(mf.baseItems).map((it) => ({
    id: it.id,
    name: it.name,
    tier: it.tier,
    enchant: it.enchant ?? 0,
  }));
  await window.botApi.setWindowProgress(0);
  await window.botApi.minimizeWindow();
  await sleep(350);
  try {
    await window.botApi.runCategoryScan(MARKET_FLIP_CATEGORY_ID, items, city);
    logLine(`Flip scan leg started (${city}).`);
  } catch (error) {
    logLine(`Flip scan failed to start: ${error.message}`);
    resetMarketFlipSession();
    await window.botApi.setWindowProgress(-1);
    await window.botApi.restoreWindow();
  }
}

async function startMarketFlipScan() {
  if (state.isCategoryFetchRunning) {
    logLine("A scan is already running.");
    return;
  }
  if (marketFlipBlocking()) {
    logLine("Finish the Market Flip handoff or wait for the scan to finish.");
    return;
  }
  const items = getFlipSelectedVariants(state.marketFlip.baseItems);
  if (!items.length) {
    logLine("Add at least one specific item first.");
    return;
  }
  const cityA = byId("select-flip-city-a")?.value?.trim() || "";
  const cityB = byId("select-flip-city-b")?.value?.trim() || "";
  if (!cityA || !cityB) {
    logLine("Select City A and City B.");
    return;
  }
  if (cityA === cityB) {
    logLine("City A and City B must be different.");
    return;
  }
  await refreshCalibrationState();
  if (!state.searchPoint || !state.region) {
    logLine("Calibrate Search Point and Price Region on the Check tab first.");
    return;
  }
  state.marketFlip = {
    ...createInitialMarketFlip(),
    active: true,
    phase: "running_1",
    cityA,
    cityB,
    baseItems: (state.marketFlip.baseItems || []).map((x) => ({
      ...x,
      variants: [...(x.variants || [])],
      selectedVariantKeys: [...(x.selectedVariantKeys || [])],
    })),
    prices: new Map(),
    resultRows: [],
  };
  setActiveView("market-flip");
  renderMarketFlipChrome();
  logLine(`Market flip phase 1 @ ${cityA} (${items.length} items). Open that market in-game.`);
  await runMarketFlipCategoryInvoke(cityA);
}

async function continueMarketFlipPhase2() {
  const mf = state.marketFlip;
  if (!mf.active || mf.phase !== "handoff") return;
  if (state.isCategoryFetchRunning) {
    logLine("Scan already running.");
    return;
  }
  const secondCity = mf.cityB;
  mf.phase = "running_2";
  setActiveView("market-flip");
  renderMarketFlipChrome();
  logLine(`Market flip phase 2 @ ${secondCity}. Open that market in-game.`);
  await runMarketFlipCategoryInvoke(secondCity);
}

function fetchMarketFlipResultsFromLiveRows() {
  const mf = state.marketFlip;
  if (!mf.cityA || !mf.cityB) {
    logLine("Set City A and City B first.");
    return;
  }
  const selected = getFlipSelectedVariants(mf.baseItems);
  if (!selected.length) {
    logLine("No selected variants to compare.");
    return;
  }
  const selectedCompositeKeys = new Set(
    selected.map((it) => flipCanonicalCompositeKey(it.name, it.tier, it.enchant ?? 0)),
  );
  let sourceRows = (state.liveRows || []).filter((row) => {
    if (row.category !== "market_flip") return false;
    if (row.city !== mf.cityA && row.city !== mf.cityB) return false;
    const rowComposite = row.flipCompositeKey || flipCanonicalCompositeKey(row.item_name, row.tier, row.enchant ?? 0);
    return selectedCompositeKeys.has(rowComposite);
  });
  if (!sourceRows.length) {
    const relaxed = [];
    for (const row of state.liveRows || []) {
      if (row.category !== "market_flip") continue;
      if (row.city !== mf.cityA && row.city !== mf.cityB) continue;
      const rowName = normalizeFlipMatchName(row.item_name);
      const rowTier = row.tier != null ? Number(row.tier) : null;
      const rowEnchant = Number(row.enchant ?? 0);
      const candidates = selected.filter((it) => {
        const selName = normalizeFlipMatchName(it.name);
        const sameTier = (it.tier != null ? Number(it.tier) : null) === rowTier;
        const sameEnchant = Number(it.enchant ?? 0) === rowEnchant;
        const nameClose = selName === rowName || selName.includes(rowName) || rowName.includes(selName);
        return sameTier && sameEnchant && nameClose;
      });
      if (candidates.length === 1) relaxed.push(row);
    }
    sourceRows = relaxed;
  }
  mf.resultRows = _buildFlipResultsFromRows(sourceRows, mf.cityA, mf.cityB);
  mf.phase = mf.resultRows.length ? "done" : mf.phase;
  renderMarketFlipChrome();
  logLine(`Fetched ${mf.resultRows.length} comparison rows from Live Session Rows.`);
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
  if (view === "market-flip") {
    renderFlipCitySelectors();
    renderMarketFlipChrome();
    renderMarketFlipItems();
    renderFlipCatalogAccordion();
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
  const flipBlock = marketFlipBlocking();
  const flipCheckBtn = byId("btn-flip-check-selected");
  if (btn) btn.disabled = state.isCategoryFetchRunning || flipBlock;
  if (stopBtn) stopBtn.disabled = !state.isCategoryFetchRunning;
  if (flipCheckBtn) {
    const hasFlipItems = getFlipSelectedVariants().length > 0;
    flipCheckBtn.disabled = !hasFlipItems || state.isCategoryFetchRunning || flipBlock;
  }
  if (!node) return;
  if (!state.isCategoryFetchRunning && progress.total === 0) {
    node.textContent = "Scan: Idle";
    return;
  }
  const flipLabel = progress.category === "Market Flip" ? "Market Flip · " : "";
  if (!state.isCategoryFetchRunning) {
    node.textContent = `${flipLabel}Done ${progress.done}/${progress.total}${progress.failures ? ` · Fail ${progress.failures}` : ""}${progress.city ? ` · ${progress.city}` : ""}`;
    return;
  }
  node.textContent = `${flipLabel}Running ${progress.done}/${progress.total}${progress.failures ? ` · Fail ${progress.failures}` : ""}${progress.city ? ` · ${progress.city}` : ""}`;
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
      <td>${row.item_name || row.queryText || "-"}</td>
      <td>${row.tier ?? "-"}</td>
      <td>${row.enchant ?? 0}</td>
      <td>${row.city || "-"}</td>
      <td>${row.category || "-"}</td>
      <td>${row.type || "-"}</td>
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
    renderFlipCitySelectors();
    renderFlipCatalogAccordion();
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
    .filter((item) => {
      if (categoryId !== "vanity") return true;
      return !/^\s*\d/.test(String(item.name || ""));
    })
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

function openStartFetchFlow() {
  if (state.isCategoryFetchRunning) return;
  if (marketFlipBlocking()) {
    logLine("Finish Market Flip (Continue phase 2 or stop) before starting a category fetch.");
    return;
  }
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
  if (marketFlipBlocking()) {
    logLine("Finish Market Flip before starting a category fetch.");
    return;
  }
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

async function startManualCheckScanWithItems(city, items, categoryLabel = "Market Flip Selected") {
  if (state.isCategoryFetchRunning) {
    logLine("A scan is already running.");
    return;
  }
  if (marketFlipBlocking()) {
    logLine("Finish Market Flip phase first or stop it, then run Check.");
    return;
  }
  const marketCity = String(city || "").trim();
  if (!marketCity) {
    logLine("Select a city first.");
    return;
  }
  const safeItems = Array.isArray(items) ? items.filter((it) => it && it.name) : [];
  if (!safeItems.length) {
    logLine("No selected items to check.");
    return;
  }
  await refreshCalibrationState();
  if (!state.searchPoint || !state.region) {
    logLine("Cannot start fetch: calibrate Search Point and Price Region first.");
    return;
  }
  setSelectedCity(marketCity);
  state.isCategoryFetchRunning = true;
  state.categoryProgress = {
    done: 0,
    total: safeItems.length,
    failures: 0,
    item: "",
    category: categoryLabel,
    city: marketCity,
  };
  renderCategoryProgress();
  setActiveView("check");
  await window.botApi.setWindowProgress(0);
  await window.botApi.minimizeWindow();
  await sleep(350);
  logLine(`Starting check: ${categoryLabel} @ ${marketCity} (${safeItems.length} items)`);
  try {
    logLine("Electron minimized. Keep Albion market window focused.");
    await window.botApi.runCategoryScan(MARKET_FLIP_CATEGORY_ID, safeItems, marketCity);
    await refreshResumeCheckpointState();
    logLine("Check scan started.");
  } catch (error) {
    logLine(`Check scan failed: ${error.message}`);
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

  const flipCatalogFilterInput = byId("input-flip-catalog-filter");
  flipCatalogFilterInput?.addEventListener("input", (event) => {
    state.flipCatalogFilter = event.target.value;
    clearTimeout(flipCatalogFilterDebounce);
    flipCatalogFilterDebounce = setTimeout(() => renderFlipCatalogAccordion(), 120);
  });
  byId("btn-flip-catalog-clear")?.addEventListener("click", () => {
    state.flipCatalogFilter = "";
    if (flipCatalogFilterInput) flipCatalogFilterInput.value = "";
    renderFlipCatalogAccordion();
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
    if (marketFlipBlocking()) {
      logLine("Finish Market Flip before resuming a checkpoint scan.");
      return;
    }
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

  renderFlipCitySelectors();
  byId("btn-flip-items-clear")?.addEventListener("click", () => {
    state.marketFlip.baseItems = [];
    renderMarketFlipItems();
  });
  byId("btn-flip-check-selected")?.addEventListener("click", () => {
    const city = byId("select-flip-city-a")?.value?.trim() || "";
    const items = getFlipSelectedVariants().map((it) => ({
      id: it.id,
      name: it.name,
      tier: it.tier,
      enchant: it.enchant ?? 0,
    }));
    startManualCheckScanWithItems(city, items, `Manual Check (${city || "-"})`).catch((error) =>
      logLine(`Manual check failed: ${error.message}`),
    );
  });
  byId("flip-items-body")?.addEventListener("click", (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLElement)) return;
    if (t.dataset.flipBulkBase) {
      openFlipBulkEditor(t.dataset.flipBulkBase);
      return;
    }
    if (t.dataset.flipRemoveBase) {
      state.marketFlip.baseItems = state.marketFlip.baseItems.filter((it) => it.baseKey !== t.dataset.flipRemoveBase);
      renderMarketFlipItems();
    }
  });
  byId("flip-bulk-body")?.addEventListener("click", (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLElement)) return;
    const key = t.dataset.flipBulkToggle;
    if (!key || !flipBulkEditorDraft) return;
    if (flipBulkEditorDraft.selectedKeys.has(key)) {
      flipBulkEditorDraft.selectedKeys.delete(key);
    } else if (flipBulkEditorDraft.availableKeys.has(key)) {
      flipBulkEditorDraft.selectedKeys.add(key);
    }
    renderFlipBulkEditor();
  });
  byId("btn-flip-bulk-save")?.addEventListener("click", () => applyFlipBulkEditor());
  byId("btn-flip-bulk-close")?.addEventListener("click", () => closeFlipBulkEditor());
  byId("flip-bulk-modal")?.addEventListener("click", (event) => {
    if (event.target?.id === "flip-bulk-modal") {
      closeFlipBulkEditor();
    }
  });
  byId("btn-flip-start")?.addEventListener("click", () => {
    startMarketFlipScan().catch((error) => logLine(`Flip start: ${error.message}`));
  });
  byId("btn-flip-continue-phase2")?.addEventListener("click", () => {
    continueMarketFlipPhase2().catch((error) => logLine(`Flip phase 2: ${error.message}`));
  });
  byId("btn-flip-export-live")?.addEventListener("click", () => {
    fetchMarketFlipResultsFromLiveRows();
  });

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
      const catLabel =
        catId === MARKET_FLIP_CATEGORY_ID
          ? "Market Flip"
          : EXACT_CATEGORY_ORDER.find((c) => c.id === catId)?.label || catId;
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
      recordMarketFlipPrice(payload, normalizedScanValue, scan);
      const displayItemName = String(payload.item?.name || "").trim() || String(scan.queryText || "").replace(/\s+\d+\.\d+\s*$/, "");
      state.liveRows.unshift({
        timestamp: scan.timestamp,
        city: payload.city || "",
        category: payload.categoryId,
        item_name: displayItemName,
        flipCompositeKey: flipCanonicalCompositeKey(displayItemName, payload.item?.tier ?? null, payload.item?.enchant ?? 0),
        tier: payload.item?.tier ?? null,
        enchant: payload.item?.enchant ?? 0,
        type: inferTypeFromItemName(displayItemName),
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
      window.botApi.setWindowProgress(-1).catch(() => {});
      window.botApi.restoreWindow().catch(() => {});
      window.botApi.closeStatusWindow().catch(() => {});

      const mf = state.marketFlip;
      const flipFinished = payload.categoryId === MARKET_FLIP_CATEGORY_ID;
      if (flipFinished && mf.active) {
        if (payload.cancelled) {
          resetMarketFlipSession();
          logLine("Market flip stopped.");
        } else if (mf.phase === "running_1") {
          mf.phase = "handoff";
          setActiveView("market-flip");
          renderMarketFlipChrome();
          logLine(`Market flip phase 1 done. Open ${mf.cityB} market now, then click Continue to phase 2.`);
        } else if (mf.phase === "running_2") {
          finalizeMarketFlipResults();
          mf.active = false;
          mf.phase = "done";
          setActiveView("market-flip");
          renderMarketFlipChrome();
          logLine("Market flip complete. See comparison table.");
        }
      }
      renderCategoryProgress();

      loadPriceHistory().catch(() => {});
      refreshResumeCheckpointState().catch(() => {});
      logLine(
        `Category fetch ${payload.cancelled ? "stopped" : "done"}: processed=${payload.processed ?? 0}, failures=${payload.failures ?? 0}`,
      );
      return;
    }
    if (message.event === "maintenanceDetected") {
      if (state.marketFlip.active) {
        resetMarketFlipSession();
        logLine("Market flip reset (maintenance).");
      }
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
  setSelectedCity(localStorage.getItem(FETCH_CITY_STORAGE_KEY) || MARKET_CITIES[0]);
  renderCityChips();
  renderCalibrationStatus();
  renderCategoryProgress();
  renderFlipCitySelectors();
  renderMarketFlipItems();
  renderFlipCatalogAccordion();
  renderMarketFlipChrome();
  await loadItemCatalog(false);
  await refreshWatchlist();
  await refreshCalibrationState();
  await loadPriceHistory();
  await refreshResumeCheckpointState();
  scheduleNextDbReadTick();
  renderLiveRows();
  setActiveView("dashboard");
  logLine("Items console ready");
}

bootstrap().catch((error) => {
  setBackendStatus("Error");
  logLine(`Bootstrap failed: ${error.message}`);
});
