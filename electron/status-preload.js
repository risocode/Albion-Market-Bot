const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("statusApi", {
  onBotEvent(handler) {
    const wrapped = (_event, msg) => handler(msg);
    ipcRenderer.on("status:bot-event", wrapped);
    return () => ipcRenderer.removeListener("status:bot-event", wrapped);
  },
  control(action) {
    return ipcRenderer.invoke("scan:control", action);
  },
  togglePin() {
    return ipcRenderer.invoke("status-window:toggle-pin");
  },
  close() {
    return ipcRenderer.invoke("status-window:close");
  },
});
