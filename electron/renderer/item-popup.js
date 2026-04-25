function $(id) {
  return document.getElementById(id);
}

function formatValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "--";
  return n.toLocaleString();
}

function onEvent(msg) {
  const ev = msg.event;
  const payload = msg.payload || {};
  if (ev === "categoryScanStarted") {
    $("item-name").textContent = "Starting scan...";
    $("item-price").textContent = "--";
    $("item-sub").textContent = `${payload.city || ""} ${payload.categoryId || ""}`.trim() || "Running";
    return;
  }
  if (ev === "categoryScanItem") {
    const scan = payload.scanResult || {};
    $("item-name").textContent = scan.queryText || payload.item?.name || "Unknown item";
    $("item-price").textContent = formatValue(scan.value);
    const idx = Number(payload.index || 0);
    const total = Number(payload.totalItems || 0);
    $("item-sub").textContent = `${idx}/${total}${payload.city ? ` · ${payload.city}` : ""}`;
    return;
  }
  if (ev === "categoryScanFinished") {
    $("item-sub").textContent = payload.cancelled ? "Stopped" : "Completed";
  }
}

window.addEventListener("DOMContentLoaded", () => {
  const off = window.itemPopupApi.onBotEvent(onEvent);
  window.addEventListener("beforeunload", () => {
    if (typeof off === "function") off();
  });
});
