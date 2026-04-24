const { app, BrowserWindow, ipcMain, shell, globalShortcut } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const readline = require("readline");
const { ensureItemCatalog } = require("./itemCatalog");

let mainWindow = null;
let backend = null;
let requestCounter = 0;
const pendingRequests = new Map();

const userDataPath = path.join(process.cwd(), ".electron-user-data");
const sessionDataPath = path.join(userDataPath, "session");
const cachePath = path.join(userDataPath, "cache");
fs.mkdirSync(sessionDataPath, { recursive: true });
fs.mkdirSync(cachePath, { recursive: true });
app.setPath("userData", userDataPath);
app.setPath("sessionData", sessionDataPath);
app.setPath("cache", cachePath);

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 860,
    minWidth: 980,
    minHeight: 700,
    backgroundColor: "#11161f",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

function resolvePythonExecutable() {
  if (process.platform === "win32") {
    return path.join(process.cwd(), ".venv", "Scripts", "python.exe");
  }
  return path.join(process.cwd(), ".venv", "bin", "python");
}

function startBackend() {
  const pythonExecutable = resolvePythonExecutable();
  backend = spawn(pythonExecutable, ["-m", "albion_bot.service_main"], {
    cwd: process.cwd(),
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
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send("bot:event", eventMessage);
}

function emitEvent(event, payload) {
  emitRawEvent({ type: "event", event, payload });
}

function emitShortcut(action) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send("bot:shortcut", { action });
}

function registerGlobalShortcuts() {
  const shortcutMap = {
    "CommandOrControl+Shift+S": "captureSearchPoint",
    "CommandOrControl+Shift+R": "captureRegion",
    "CommandOrControl+Shift+Q": "runQueryOnce",
    "CommandOrControl+Shift+W": "runWatchlistScan",
    "CommandOrControl+Shift+L": "startWatchlistLoop",
    "CommandOrControl+Shift+X": "stopWatchlistLoop",
    "CommandOrControl+Shift+H": "refreshState",
  };

  Object.entries(shortcutMap).forEach(([accelerator, action]) => {
    const ok = globalShortcut.register(accelerator, () => emitShortcut(action));
    if (!ok) {
      emitEvent("log", {
        level: "warn",
        message: `Could not register shortcut: ${accelerator}`,
      });
    }
  });
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

ipcMain.handle("bot:request", async (_event, command, payload) => {
  const response = await sendRequest(command, payload);
  if (response.error) {
    throw new Error(response.error);
  }
  return response.payload;
});

ipcMain.handle("bot:open-log-file", async () => {
  const csvPath = path.join(process.cwd(), "capture_log.csv");
  await shell.openPath(csvPath);
  return true;
});

ipcMain.handle("bot:open-recommendations-file", async () => {
  const csvPath = path.join(process.cwd(), "recommendations_log.csv");
  await shell.openPath(csvPath);
  return true;
});

ipcMain.handle("items:catalog", async (_event, options = {}) => {
  const force = Boolean(options.force);
  return ensureItemCatalog(userDataPath, { force });
});

app.whenReady().then(() => {
  createWindow();
  startBackend();
  registerGlobalShortcuts();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", () => {
  if (backend && !backend.killed) {
    backend.kill();
  }
  if (process.platform !== "darwin") {
    app.quit();
  }
});
