const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("itemPopupApi", {
  onBotEvent(handler) {
    const wrapped = (_event, msg) => handler(msg);
    ipcRenderer.on("item-popup:bot-event", wrapped);
    return () => ipcRenderer.removeListener("item-popup:bot-event", wrapped);
  },
});
