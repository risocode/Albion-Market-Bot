const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("botApi", {
  request(command, payload = {}) {
    return ipcRenderer.invoke("bot:request", command, payload);
  },
  onEvent(handler) {
    const wrapped = (_event, eventMessage) => handler(eventMessage);
    ipcRenderer.on("bot:event", wrapped);
    return () => ipcRenderer.removeListener("bot:event", wrapped);
  },
  loadItemCatalog(options = {}) {
    return ipcRenderer.invoke("items:catalog", options);
  },
  runCategoryScan(categoryId, items = [], city = "") {
    return ipcRenderer.invoke("bot:request", "runCategoryScan", { categoryId, items, city });
  },
  stopCategoryScan() {
    return ipcRenderer.invoke("bot:request", "stopCategoryScan", {});
  },
  getPriceHistory(limit = 500) {
    return ipcRenderer.invoke("bot:request", "getPriceHistory", { limit });
  },
  minimizeWindow() {
    return ipcRenderer.invoke("window:minimize");
  },
  restoreWindow() {
    return ipcRenderer.invoke("window:restore");
  },
  setWindowProgress(value) {
    return ipcRenderer.invoke("window:set-progress", value);
  },
  getAppVersion() {
    return ipcRenderer.invoke("app:version");
  },
  openStatusWindow() {
    return ipcRenderer.invoke("status-window:open");
  },
  closeStatusWindow() {
    return ipcRenderer.invoke("status-window:close");
  },
  scanControl(action) {
    return ipcRenderer.invoke("scan:control", action);
  },
});
