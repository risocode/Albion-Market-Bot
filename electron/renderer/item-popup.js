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
  const list = $("item-list");
  const appendResult = (name, price) => {
    if (!list) return;
    const row = document.createElement("div");
    row.className = "item-row";
    row.innerHTML = `
      <span class="item-name">${name || "Unknown item"}</span>
      <span class="item-price">${price}</span>
    `;
    list.prepend(row);
    while (list.children.length > 4) {
      list.removeChild(list.lastElementChild);
    }
  };
  if (ev === "categoryScanStarted") {
    if (list) {
      list.innerHTML = `
        <div class="item-row">
          <span class="item-name">Starting scan...</span>
          <span class="item-price">--</span>
        </div>
      `;
    }
    $("item-sub").textContent = `${payload.city || ""} ${payload.categoryId || ""}`.trim() || "Running";
    return;
  }
  if (ev === "categoryScanItem") {
    const scan = payload.scanResult || {};
    appendResult(scan.queryText || payload.item?.name || "Unknown item", formatValue(scan.value));
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
