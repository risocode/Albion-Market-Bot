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

function $(id) {
  return document.getElementById(id);
}

function categoryLabel(id) {
  return EXACT_CATEGORY_ORDER.find((c) => c.id === id)?.label || id || "—";
}

function formatItemLine(item, scan) {
  const q = (scan && scan.queryText) || "";
  if (q) return `> ${q}`;
  if (!item) return "> —";
  const name = item.name || item.base_name || "—";
  const t = item.tier != null ? item.tier : "?";
  const e = item.enchant != null ? item.enchant : 0;
  return `> ${name} T${t}.${e}`;
}

function formatPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "--";
  return n.toLocaleString();
}

function setProgress(done, total) {
  const wrap = $("progress-wrap");
  const fill = $("progress-fill");
  const label = $("progress-label");
  const t = Math.max(0, Number(total) || 0);
  const d = Math.max(0, Number(done) || 0);
  const pct = t > 0 ? Math.min(100, (d / t) * 100) : 0;
  fill.style.width = `${pct}%`;
  label.textContent = `${d} / ${t}`;
  if (wrap) {
    wrap.setAttribute("aria-valuenow", String(Math.round(pct)));
    wrap.setAttribute("aria-valuemax", "100");
  }
}

let pausedLocal = false;

function setPausedUi(paused) {
  pausedLocal = Boolean(paused);
  const line = $("current-line");
  if (line) {
    line.classList.toggle("is-paused", pausedLocal);
  }
  const sub = $("status-sub");
  if (sub && sub.dataset.base) {
    sub.textContent = pausedLocal ? `${sub.dataset.base} · PAUSED` : sub.dataset.base;
  }
}

function applyBotMessage(msg) {
  const ev = msg.event;
  const payload = msg.payload || {};

  if (ev === "categoryScanStarted") {
    const cat = categoryLabel(payload.categoryId);
    const city = payload.city || "";
    const sub = `${cat}${city ? ` · ${city}` : ""}`;
    $("status-sub").textContent = sub;
    $("status-sub").dataset.base = sub;
    setProgress(0, payload.totalItems || 0);
    $("current-line").textContent = "> Starting…";
    $("current-price").textContent = "Price: --";
    setPausedUi(false);
    return;
  }

  if (ev === "categoryScanItem") {
    const total = Number(payload.totalItems || 0);
    const idx = Number(payload.index || 0);
    setProgress(idx, total);
    const scan = payload.scanResult || {};
    $("current-line").textContent = formatItemLine(payload.item, scan);
    $("current-price").textContent = `Price: ${formatPrice(scan.value)}`;
    return;
  }

  if (ev === "categoryScanFinished") {
    setProgress(payload.processed || 0, payload.processed || 0);
    $("current-line").textContent = payload.cancelled ? "> Stopped" : "> Complete";
    $("current-price").textContent = "Price: --";
    return;
  }

  if (ev === "log" && payload.level === "error") {
    $("current-line").textContent = `> ${payload.message || "Error"}`.slice(0, 120);
  }
}

function wireHotkeys() {
  document.addEventListener("keydown", async (e) => {
    if (e.key === "F1") {
      e.preventDefault();
      try {
        const r = await window.statusApi.control("togglePause");
        setPausedUi(r.paused);
      } catch (_err) {
        /* ignore */
      }
    } else if (e.key === "F2") {
      e.preventDefault();
      window.statusApi.control("skip").catch(() => {});
    } else if (e.key === "F5") {
      e.preventDefault();
      window.statusApi.control("stop").catch(() => {});
    }
  });
}

function wireButtons() {
  $("btn-pin").addEventListener("click", async () => {
    try {
      const r = await window.statusApi.togglePin();
      $("btn-pin").style.opacity = r.alwaysOnTop ? "1" : "0.45";
    } catch (_e) {
      /* ignore */
    }
  });
  $("btn-close").addEventListener("click", () => {
    window.statusApi.close().catch(() => {});
  });
}

window.addEventListener("DOMContentLoaded", () => {
  wireHotkeys();
  wireButtons();
  const off = window.statusApi.onBotEvent(applyBotMessage);
  window.addEventListener("beforeunload", () => {
    if (typeof off === "function") off();
  });
});
