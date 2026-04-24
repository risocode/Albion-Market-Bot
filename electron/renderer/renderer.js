const state = {
  activePage: "dashboard",
  latestValue: null,
  runtimeStatus: "Idle",
  recentRows: [],
  opportunities: [],
  watchlist: [],
  watchFilter: "",
  catalogFilter: "",
  itemCatalog: null,
  lastQuery: "scholar robe 5.1",
  sessionStats: {
    scanBatches: 0,
    successRate: 0,
    avgScore: 0,
    topScore: 0,
  },
};

const CATALOG_RENDER_CAP = 400;
let catalogFilterDebounce = null;

function byId(id) {
  return document.getElementById(id);
}

function logLine(message) {
  const panel = byId("log-panel");
  const stamp = new Date().toLocaleTimeString();
  panel.textContent = `[${stamp}] ${message}\n${panel.textContent}`.slice(0, 8000);
}

function setBackendStatus(text) {
  byId("backend-status").textContent = text;
}

function parseNumberInput(id, fallback = 0) {
  const raw = byId(id).value;
  const val = Number(raw);
  return Number.isFinite(val) ? val : fallback;
}

function setActivePage(pageId) {
  state.activePage = pageId;
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.page === pageId);
  });
  document.querySelectorAll(".page").forEach((page) => {
    page.classList.toggle("is-visible", page.dataset.page === pageId);
  });
  const titleMap = {
    dashboard: "Dashboard",
    items: "Items",
    check: "Check",
    buy: "Buy",
    auction: "Auction Helper",
    settings: "Settings",
  };
  byId("page-title").textContent = titleMap[pageId] ?? "Dashboard";

  if (pageId === "items" && !state.itemCatalog) {
    loadItemCatalog(false).catch(() => {});
  }
}

function renderDashboard() {
  byId("runtime-status").textContent = state.runtimeStatus;
  byId("last-value").textContent = state.latestValue == null ? "--" : String(state.latestValue);
  byId("active-query").textContent = state.lastQuery;
  byId("metric-scan-batches").textContent = String(state.sessionStats.scanBatches ?? 0);
  byId("metric-success-rate").textContent = `${state.sessionStats.successRate ?? 0}%`;
  byId("metric-avg-score").textContent = String(state.sessionStats.avgScore ?? 0);
  byId("metric-top-score").textContent = String(state.sessionStats.topScore ?? 0);
}

function renderItems() {
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

function renderCheck() {
  const body = byId("results-body");
  body.innerHTML = "";
  for (const row of state.recentRows.slice(0, 40)) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${row.timestamp}</td><td>${row.query}</td><td>${row.value ?? "--"}</td><td>${row.rawText ?? ""}</td>`;
    body.appendChild(tr);
  }
}

function renderOpportunities() {
  const oppBody = byId("opportunities-body");
  oppBody.innerHTML = "";
  for (const opp of state.opportunities.slice(0, 80)) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${opp.timestamp}</td>
      <td>${opp.queryText}</td>
      <td>${opp.observedValue ?? "--"}</td>
      <td>${opp.targetPrice ?? "--"}</td>
      <td>${opp.deltaPct ?? "--"}</td>
      <td>${opp.score ?? "--"}</td>
      <td class="label-${opp.label}">${opp.label}</td>
    `;
    oppBody.appendChild(tr);
  }
}

function renderAll() {
  byId("top-status-line").textContent = `Runtime status: ${state.runtimeStatus}`;
  renderDashboard();
  renderItems();
  renderCheck();
  renderOpportunities();
}

async function request(command, payload = {}) {
  try {
    return await window.botApi.request(command, payload);
  } catch (error) {
    logLine(`Request ${command} failed: ${error.message}`);
    throw error;
  }
}

async function refreshWatchlist() {
  state.watchlist = await request("listWatchItems");
  renderAll();
}

async function refreshOpportunities() {
  state.opportunities = await request("getRecentOpportunities", { limit: 100 });
  state.sessionStats = await request("getSessionStats");
}

async function loadItemCatalog(force = false) {
  const statusEl = byId("catalog-status");
  if (statusEl) {
    statusEl.textContent = force
      ? "Refreshing catalog…"
      : "Loading catalog (first run may download ~24 MB)…";
  }
  try {
    const data = await window.botApi.loadItemCatalog({ force });
    state.itemCatalog = data;
    const when = data.fetchedAt ? new Date(data.fetchedAt).toLocaleString() : "—";
    const src = data.fromCache ? "cache" : "network";
    if (statusEl) {
      statusEl.textContent = `${data.itemCount.toLocaleString()} items · ${src} · ${when}`;
    }
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
  if (!root) {
    return;
  }
  root.replaceChildren();
  const cat = state.itemCatalog;
  if (!cat?.categories) {
    return;
  }

  const filt = state.catalogFilter.trim().toLowerCase();

  for (const section of cat.categories) {
    const items = filt
      ? section.items.filter((it) => {
          const hay = it.searchHaystack || `${it.name} ${it.id}`.toLowerCase();
          return hay.includes(filt);
        })
      : section.items;
    if (filt && items.length === 0) {
      continue;
    }

    const details = document.createElement("details");
    details.className = "catalog-section";
    if (filt) {
      details.open = true;
    }

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
      if (it.tier != null) {
        metaBits.push(`T${it.tier}`);
      }
      if (it.enchant > 0) {
        metaBits.push(`.${it.enchant}`);
      }
      if (metaBits.length) {
        const meta = document.createElement("span");
        meta.className = "catalog-item-meta";
        meta.textContent = metaBits.join(" ");
        btn.appendChild(meta);
      }
      const tierEnc =
        it.tier != null || it.enchant > 0
          ? [
              "Tier / enchant (from item ID):",
              it.tier != null ? `  Tier: ${it.tier} (T prefix)` : "  Tier: not in ID prefix",
              it.enchant > 0 ? `  Enchant: .${it.enchant} (@ suffix)` : "  Enchant: flat (no @)",
            ].join("\n")
          : null;
      const tip = [it.id, tierEnc, "Quality (Normal–Masterpiece): not in this file — pick in market."].filter(Boolean).join("\n");
      btn.title = tip;
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
      more.textContent = `… and ${items.length - CATALOG_RENDER_CAP} more — refine search`;
      details.appendChild(more);
    }

    root.appendChild(details);
  }
}

async function refreshState() {
  const snapshot = await request("getState");
  state.runtimeStatus = snapshot.runtimeStatus;
  state.latestValue = snapshot.lastValue;
  state.lastQuery = snapshot.queryText;
  state.watchlist = snapshot.watchlist || [];
  state.sessionStats = snapshot.sessionStats || state.sessionStats;
  if (snapshot.searchPoint) {
    byId("input-search-x").value = snapshot.searchPoint.x;
    byId("input-search-y").value = snapshot.searchPoint.y;
  }
  if (snapshot.region) {
    byId("input-region-left").value = snapshot.region.left;
    byId("input-region-top").value = snapshot.region.top;
    byId("input-region-width").value = snapshot.region.width;
    byId("input-region-height").value = snapshot.region.height;
  }
  byId("input-query").value = snapshot.queryText;
  byId("input-interval").value = snapshot.captureIntervalSeconds;
  byId("input-settle").value = snapshot.humanization.settleDelaySeconds;
  byId("input-post").value = snapshot.humanization.postSearchDelaySeconds;
  byId("input-jitter").value = snapshot.humanization.jitterRatio;
  byId("input-key-delay-ms").value = snapshot.humanization.keyDelayBaseMs;
  byId("diagnostics").textContent = JSON.stringify(snapshot.diagnostics, null, 2);
  await refreshOpportunities();
  renderAll();
}

function wireNavigation() {
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => setActivePage(btn.dataset.page));
  });
}

function wireActions() {
  byId("btn-refresh-state").addEventListener("click", refreshState);
  byId("btn-open-log").addEventListener("click", () => window.botApi.openLogFile());
  byId("input-watch-filter").addEventListener("input", (event) => {
    state.watchFilter = event.target.value;
    renderItems();
  });

  const catalogFilterInput = byId("input-catalog-filter");
  if (catalogFilterInput) {
    catalogFilterInput.addEventListener("input", (event) => {
      state.catalogFilter = event.target.value;
      clearTimeout(catalogFilterDebounce);
      catalogFilterDebounce = setTimeout(() => renderCatalogAccordion(), 140);
    });
  }

  const btnCatalogClear = byId("btn-catalog-clear");
  if (btnCatalogClear) {
    btnCatalogClear.addEventListener("click", () => {
      state.catalogFilter = "";
      if (catalogFilterInput) {
        catalogFilterInput.value = "";
      }
      renderCatalogAccordion();
    });
  }

  const btnCatalogRefresh = byId("btn-catalog-refresh");
  if (btnCatalogRefresh) {
    btnCatalogRefresh.addEventListener("click", async () => {
      await loadItemCatalog(true);
    });
  }

  byId("btn-run-once").addEventListener("click", async () => {
    state.lastQuery = byId("input-query").value.trim() || state.lastQuery;
    await request("setQueryText", { queryText: state.lastQuery });
    await request("runQueryOnce");
    logLine("Triggered runQueryOnce");
  });

  byId("btn-start-loop").addEventListener("click", async () => {
    state.lastQuery = byId("input-query").value.trim() || state.lastQuery;
    await request("setQueryText", { queryText: state.lastQuery });
    await request("startLoop", { intervalSeconds: parseNumberInput("input-interval", 1) });
    logLine("Loop started");
  });

  byId("btn-stop-loop").addEventListener("click", async () => {
    await request("stopLoop");
    logLine("Loop stopped");
  });

  byId("btn-capture-search-point").addEventListener("click", async () => {
    const point = await request("captureCursor");
    byId("input-search-x").value = point.x;
    byId("input-search-y").value = point.y;
    await request("setSearchPoint", point);
    logLine(`Search point captured: ${point.x},${point.y}`);
    await refreshState();
  });

  byId("btn-apply-search-point").addEventListener("click", async () => {
    const payload = {
      x: parseNumberInput("input-search-x", 0),
      y: parseNumberInput("input-search-y", 0),
    };
    await request("setSearchPoint", payload);
    logLine(`Search point applied: ${payload.x},${payload.y}`);
  });

  byId("btn-select-region").addEventListener("click", async () => {
    const region = await request("selectRegion");
    if (!region) {
      logLine("Region selection cancelled");
      return;
    }
    byId("input-region-left").value = region.left;
    byId("input-region-top").value = region.top;
    byId("input-region-width").value = region.width;
    byId("input-region-height").value = region.height;
    await request("setRegion", region);
    logLine(`Region selected ${region.width}x${region.height}`);
    await refreshState();
  });

  byId("btn-apply-region").addEventListener("click", async () => {
    const region = {
      left: parseNumberInput("input-region-left", 0),
      top: parseNumberInput("input-region-top", 0),
      width: parseNumberInput("input-region-width", 0),
      height: parseNumberInput("input-region-height", 0),
    };
    await request("setRegion", region);
    logLine(`Region applied ${region.width}x${region.height}`);
  });

  byId("btn-apply-humanization").addEventListener("click", async () => {
    const payload = {
      settleDelaySeconds: parseNumberInput("input-settle", 0.35),
      postSearchDelaySeconds: parseNumberInput("input-post", 0.6),
      jitterRatio: parseNumberInput("input-jitter", 0.1),
      keyDelayBaseMs: parseNumberInput("input-key-delay-ms", 12),
    };
    await request("setHumanization", payload);
    logLine("Humanization updated");
    await refreshState();
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

  byId("btn-run-watch-scan").addEventListener("click", async () => {
    await request("runWatchlistScan", {
      itemSpacingSeconds: parseNumberInput("input-item-spacing", 0.25),
    });
    logLine("Triggered watchlist scan");
  });

  byId("btn-start-watch-loop").addEventListener("click", async () => {
    await request("startWatchlistLoop", {
      intervalSeconds: parseNumberInput("input-watch-interval", 2),
      itemSpacingSeconds: parseNumberInput("input-item-spacing", 0.25),
    });
    logLine("Watchlist loop started");
  });

  byId("btn-stop-watch-loop").addEventListener("click", async () => {
    await request("stopWatchlistLoop");
    logLine("Watchlist loop stopped");
  });

  byId("btn-export-reco").addEventListener("click", async () => {
    const exported = await request("exportRecommendationsCsv");
    logLine(`Recommendations CSV path: ${exported.path}`);
    await window.botApi.openRecommendationsFile();
  });
}

function wireEvents() {
  window.botApi.onEvent((message) => {
    if (message.event === "result") {
      const payload = message.payload;
      state.latestValue = payload.value;
      state.runtimeStatus = payload.runtimeStatus || state.runtimeStatus;
      state.recentRows.unshift({
        timestamp: payload.timestamp,
        query: payload.queryText,
        value: payload.value,
        rawText: payload.rawText,
      });
      renderAll();
      return;
    }

    if (message.event === "status") {
      state.runtimeStatus = message.payload.runtimeStatus;
      renderAll();
      return;
    }

    if (message.event === "watchlistChanged") {
      state.watchlist = message.payload.items || [];
      renderAll();
      return;
    }

    if (message.event === "scanItemComplete") {
      if (message.payload.opportunity) {
        state.opportunities.unshift(message.payload.opportunity);
      }
      if (message.payload.scanResult) {
        const scan = message.payload.scanResult;
        state.recentRows.unshift({
          timestamp: scan.timestamp,
          query: scan.queryText,
          value: scan.value,
          rawText: scan.rawText,
        });
      }
      renderAll();
      return;
    }

    if (message.event === "scanFinished") {
      if (message.payload.stats) {
        state.sessionStats = message.payload.stats;
      }
      renderAll();
      logLine(`Watchlist scan finished. processed=${message.payload.processed} failures=${message.payload.failures}`);
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

function wireShortcuts() {
  document.addEventListener("keydown", (event) => {
    const tag = event.target?.tagName?.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select" || event.target?.isContentEditable) {
      return;
    }
    if (!(event.ctrlKey && event.shiftKey)) {
      return;
    }

    const key = event.key.toLowerCase();
    if (key === "s") {
      event.preventDefault();
      performShortcutAction("captureSearchPoint");
      return;
    }

    if (key === "r") {
      event.preventDefault();
      performShortcutAction("captureRegion");
    }
  });
}

function performShortcutAction(action) {
  const actionMap = {
    captureSearchPoint: () => {
      setActivePage("check");
      byId("btn-capture-search-point").click();
      logLine("Shortcut: capture search point");
    },
    captureRegion: () => {
      setActivePage("check");
      byId("btn-select-region").click();
      logLine("Shortcut: capture OCR region");
    },
    runQueryOnce: () => {
      setActivePage("check");
      byId("btn-run-once").click();
      logLine("Shortcut: run query once");
    },
    runWatchlistScan: () => {
      setActivePage("dashboard");
      byId("btn-run-watch-scan").click();
      logLine("Shortcut: run watchlist scan");
    },
    startWatchlistLoop: () => {
      setActivePage("dashboard");
      byId("btn-start-watch-loop").click();
      logLine("Shortcut: start watchlist loop");
    },
    stopWatchlistLoop: () => {
      setActivePage("dashboard");
      byId("btn-stop-watch-loop").click();
      logLine("Shortcut: stop watchlist loop");
    },
    refreshState: () => {
      byId("btn-refresh-state").click();
      logLine("Shortcut: refresh state");
    },
  };
  const fn = actionMap[action];
  if (fn) {
    fn();
  }
}

function wireGlobalShortcutBridge() {
  window.botApi.onShortcut((payload) => {
    if (!payload || !payload.action) {
      return;
    }
    performShortcutAction(payload.action);
  });
}

async function bootstrap() {
  setBackendStatus("Connected");
  wireNavigation();
  wireActions();
  wireEvents();
  wireShortcuts();
  wireGlobalShortcutBridge();
  setActivePage("dashboard");
  await refreshState();
  await refreshWatchlist();
  logLine("Dashboard ready");
}

bootstrap().catch((error) => {
  setBackendStatus("Error");
  logLine(`Bootstrap failed: ${error.message}`);
});
