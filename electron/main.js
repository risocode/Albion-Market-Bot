const { app, BrowserWindow, ipcMain, Menu, screen, globalShortcut } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const readline = require("readline");
const { ensureItemCatalog } = require("./itemCatalog");

let mainWindow = null;
let statusWindow = null;
let itemPopupWindow = null;
/** @type {object[]} */
let statusEventQueue = [];
/** @type {object[]} */
let itemPopupEventQueue = [];
let backend = null;
let requestCounter = 0;
const pendingRequests = new Map();

const projectRoot = process.cwd();
const backendRoot = app.isPackaged
  ? path.join(process.resourcesPath, "backend")
  : projectRoot;
const userDataPath = app.isPackaged
  ? app.getPath("userData")
  : path.join(projectRoot, ".electron-user-data");
const sessionDataPath = path.join(userDataPath, "session");
const cachePath = path.join(userDataPath, "cache");
fs.mkdirSync(sessionDataPath, { recursive: true });
fs.mkdirSync(cachePath, { recursive: true });
app.setPath("userData", userDataPath);
app.setPath("sessionData", sessionDataPath);
app.setPath("cache", cachePath);

function flushStatusEventQueue() {
  if (!statusWindow || statusWindow.isDestroyed()) {
    statusEventQueue = [];
    return;
  }
  while (statusEventQueue.length > 0) {
    const msg = statusEventQueue.shift();
    statusWindow.webContents.send("status:bot-event", msg);
  }
}

function flushItemPopupEventQueue() {
  if (!itemPopupWindow || itemPopupWindow.isDestroyed()) {
    itemPopupEventQueue = [];
    return;
  }
  while (itemPopupEventQueue.length > 0) {
    const msg = itemPopupEventQueue.shift();
    itemPopupWindow.webContents.send("item-popup:bot-event", msg);
  }
}

function destroyStatusWindow() {
  statusEventQueue = [];
  if (statusWindow && !statusWindow.isDestroyed()) {
    statusWindow.destroy();
  }
  statusWindow = null;
}

function destroyItemPopupWindow() {
  itemPopupEventQueue = [];
  if (itemPopupWindow && !itemPopupWindow.isDestroyed()) {
    itemPopupWindow.destroy();
  }
  itemPopupWindow = null;
}

function createStatusWindow() {
  if (statusWindow && !statusWindow.isDestroyed()) {
    statusWindow.showInactive();
    return statusWindow;
  }
  statusWindow = new BrowserWindow({
    width: 420,
    height: 186,
    minWidth: 360,
    maxWidth: 520,
    minHeight: 168,
    maxHeight: 240,
    resizable: true,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    backgroundColor: "#14171f",
    webPreferences: {
      preload: path.join(__dirname, "status-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });
  statusWindow.loadFile(path.join(__dirname, "renderer", "status.html"));
  statusWindow.webContents.once("did-finish-load", () => {
    flushStatusEventQueue();
  });
  statusWindow.once("ready-to-show", () => {
    if (statusWindow && !statusWindow.isDestroyed()) {
      const display = screen.getPrimaryDisplay();
      const area = display.workArea;
      const [winW, winH] = statusWindow.getSize();
      const x = area.x + Math.max(0, Math.floor((area.width - winW) / 2));
      const y = area.y + Math.max(0, area.height - winH - 10);
      statusWindow.setPosition(x, y);
      statusWindow.show();
    }
  });
  statusWindow.on("closed", () => {
    statusWindow = null;
    statusEventQueue = [];
  });
  return statusWindow;
}

function createItemPopupWindow() {
  if (itemPopupWindow && !itemPopupWindow.isDestroyed()) {
    itemPopupWindow.showInactive();
    return itemPopupWindow;
  }
  itemPopupWindow = new BrowserWindow({
    width: 410,
    height: 290,
    minWidth: 360,
    maxWidth: 520,
    minHeight: 220,
    maxHeight: 420,
    resizable: false,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: "#14171f",
    webPreferences: {
      preload: path.join(__dirname, "item-popup-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });
  itemPopupWindow.loadFile(path.join(__dirname, "renderer", "item-popup.html"));
  itemPopupWindow.webContents.once("did-finish-load", () => {
    flushItemPopupEventQueue();
  });
  itemPopupWindow.once("ready-to-show", () => {
    if (itemPopupWindow && !itemPopupWindow.isDestroyed()) {
      const display = screen.getPrimaryDisplay();
      const area = display.workArea;
      const [winW, winH] = itemPopupWindow.getSize();
      const x = area.x + Math.max(0, area.width - winW - 20);
      const y = area.y + Math.max(0, area.height - winH - 20);
      itemPopupWindow.setPosition(x, y);
      itemPopupWindow.showInactive();
    }
  });
  itemPopupWindow.on("closed", () => {
    itemPopupWindow = null;
    itemPopupEventQueue = [];
  });
  return itemPopupWindow;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 880,
    minWidth: 1020,
    minHeight: 720,
    backgroundColor: "#0a0c10",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    autoHideMenuBar: true,
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  mainWindow.on("close", () => {
    destroyStatusWindow();
    destroyItemPopupWindow();
  });
}

function resolvePythonExecutable() {
  const root = backendRoot;
  if (process.platform === "win32") {
    return path.join(root, ".venv", "Scripts", "python.exe");
  }
  return path.join(root, ".venv", "bin", "python");
}

function resolveBackendCwd() {
  return backendRoot;
}

function resolveBackendEnv() {
  const env = { ...process.env };
  const srcPath = path.join(backendRoot, "src");
  const existingPythonPath = env.PYTHONPATH ? String(env.PYTHONPATH) : "";
  env.PYTHONPATH = existingPythonPath
    ? `${srcPath}${path.delimiter}${existingPythonPath}`
    : srcPath;
  return env;
}

function startBackend() {
  const pythonExecutable = resolvePythonExecutable();
  backend = spawn(pythonExecutable, ["-m", "albion_bot.service_main"], {
    cwd: resolveBackendCwd(),
    env: resolveBackendEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  });

  const rl = readline.createInterface({ input: backend.stdout });
  rl.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch (_error) {
      emitEvent("log", { level: "error", message: `Invalid backend JSON: ${line}` });
      return;
    }

    if (message.type === "response" && message.requestId) {
      const waiter = pendingRequests.get(message.requestId);
      if (waiter) {
        pendingRequests.delete(message.requestId);
        waiter.resolve(message);
      }
      return;
    }

    if (message.type === "event") {
      emitRawEvent(message);
      return;
    }
  });

  backend.stderr.on("data", (chunk) => {
    emitEvent("log", { level: "error", message: chunk.toString("utf-8") });
  });

  backend.on("exit", (code, signal) => {
    emitEvent("backendExit", { code, signal });
    backend = null;
    for (const [_id, waiter] of pendingRequests.entries()) {
      waiter.reject(new Error("Backend exited before responding."));
    }
    pendingRequests.clear();
  });
}

function emitRawEvent(eventMessage) {
  if (
    eventMessage.type === "event" &&
    eventMessage.event === "categoryScanStarted"
  ) {
    createStatusWindow();
    createItemPopupWindow();
  }
  if (
    eventMessage.type === "event" &&
    eventMessage.event === "categoryScanFinished"
  ) {
    destroyItemPopupWindow();
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("bot:event", eventMessage);
  }
  if (statusWindow && !statusWindow.isDestroyed()) {
    if (statusWindow.webContents.isLoading()) {
      statusEventQueue.push(eventMessage);
    } else {
      statusWindow.webContents.send("status:bot-event", eventMessage);
    }
  }
  if (itemPopupWindow && !itemPopupWindow.isDestroyed()) {
    if (itemPopupWindow.webContents.isLoading()) {
      itemPopupEventQueue.push(eventMessage);
    } else {
      itemPopupWindow.webContents.send("item-popup:bot-event", eventMessage);
    }
  }
}

function emitEvent(event, payload) {
  emitRawEvent({ type: "event", event, payload });
}

function sendRequest(command, payload = {}) {
  if (!backend || backend.killed) {
    return Promise.reject(new Error("Python backend is not running."));
  }

  requestCounter += 1;
  const requestId = `req-${Date.now()}-${requestCounter}`;
  const message = {
    type: "request",
    requestId,
    command,
    payload,
  };

  return new Promise((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject });
    backend.stdin.write(`${JSON.stringify(message)}\n`, "utf-8", (err) => {
      if (err) {
        pendingRequests.delete(requestId);
        reject(err);
      }
    });
  });
}

async function safeScanControl(command) {
  try {
    await sendRequest(command, {});
  } catch (_error) {
    // ignore when no scan is active or backend is restarting
  }
}

function registerGlobalScanHotkeys() {
  globalShortcut.unregister("F1");
  globalShortcut.unregister("F2");
  globalShortcut.unregister("F5");
  globalShortcut.register("F1", () => {
    safeScanControl("toggleCategoryScanPause");
  });
  globalShortcut.register("F2", () => {
    safeScanControl("skipCategoryScanDelay");
  });
  globalShortcut.register("F5", () => {
    safeScanControl("stopCategoryScan");
  });
}

ipcMain.handle("bot:request", async (_event, command, payload) => {
  const response = await sendRequest(command, payload);
  if (response.error) {
    throw new Error(response.error);
  }
  return response.payload;
});

ipcMain.handle("items:catalog", async (_event, options = {}) => {
  const force = Boolean(options.force);
  return ensureItemCatalog(userDataPath, { force });
});

ipcMain.handle("window:minimize", async () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.minimize();
  }
  return true;
});

ipcMain.handle("window:restore", async () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
  }
  return true;
});

ipcMain.handle("window:set-progress", async (_event, value) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric >= 0 && numeric <= 1) {
      mainWindow.setProgressBar(numeric);
    } else {
      mainWindow.setProgressBar(-1);
    }
  }
  return true;
});

ipcMain.handle("app:version", async () => app.getVersion());

ipcMain.handle("status-window:open", async () => {
  createStatusWindow();
  return true;
});

ipcMain.handle("status-window:close", async () => {
  destroyStatusWindow();
  return true;
});

ipcMain.handle("status-window:toggle-pin", async () => {
  if (!statusWindow || statusWindow.isDestroyed()) {
    return { alwaysOnTop: true };
  }
  const next = !statusWindow.isAlwaysOnTop();
  statusWindow.setAlwaysOnTop(next);
  return { alwaysOnTop: next };
});

ipcMain.handle("scan:control", async (_event, action) => {
  const map = {
    pause: "pauseCategoryScan",
    resume: "resumeCategoryScan",
    togglePause: "toggleCategoryScanPause",
    skip: "skipCategoryScanDelay",
    stop: "stopCategoryScan",
  };
  const command = map[action];
  if (!command) {
    throw new Error(`Unknown scan action: ${action}`);
  }
  const response = await sendRequest(command, {});
  if (response.error) {
    throw new Error(response.error);
  }
  return response.payload ?? {};
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
  startBackend();
  registerGlobalScanHotkeys();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (backend && !backend.killed) {
    backend.kill();
  }
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});
