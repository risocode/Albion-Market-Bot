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
  onShortcut(handler) {
    const wrapped = (_event, payload) => handler(payload);
    ipcRenderer.on("bot:shortcut", wrapped);
    return () => ipcRenderer.removeListener("bot:shortcut", wrapped);
  },
  openLogFile() {
    return ipcRenderer.invoke("bot:open-log-file");
  },
  openRecommendationsFile() {
    return ipcRenderer.invoke("bot:open-recommendations-file");
  },
  loadItemCatalog(options = {}) {
    return ipcRenderer.invoke("items:catalog", options);
  },
});
