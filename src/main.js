const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { app, BrowserWindow, ipcMain } = require("electron");
const chokidar = require("chokidar");
const { readSettings, saveSettings } = require("./store");
const {
  collectAllPeriods,
  opencodeCollector,
  claudeCollector,
} = require("./collectors");

const APP_NAME = "Token Usage";

app.setName(APP_NAME);
if (process.platform === "win32") app.setAppUserModelId("com.token-usage.app");

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.exit(0);

let mainWindow = null;
let settings = null;
let collectorTimer = null;
let watchDebounceTimer = null;
let opencodeWatcher = null;
let claudeWatcher = null;
let lastCollected = null;
let tickInFlight = false;
let tickPending = false;

function createWindow() {
  const savedBounds = settings?.windowBounds;
  const options = {
    width: savedBounds?.width || 420,
    height: savedBounds?.height || 640,
    minWidth: 320,
    minHeight: 400,
    maxWidth: 1400,
    maxHeight: 2000,
    frame: false,
    transparent: true,
    resizable: true,
    skipTaskbar: false,
    alwaysOnTop: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  };

  if (savedBounds && typeof savedBounds.x === "number") {
    options.x = savedBounds.x;
    options.y = savedBounds.y;
  }

  mainWindow = new BrowserWindow(options);
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.on("resize", () => persistBoundsSoon());
  mainWindow.on("move", () => persistBoundsSoon());
}

function persistBoundsSoon() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized() || mainWindow.isFullScreen()) return;
  const bounds = mainWindow.getBounds();
  const prev = settings.windowBounds || {};
  if (
    prev.x === bounds.x &&
    prev.y === bounds.y &&
    prev.width === bounds.width &&
    prev.height === bounds.height
  )
    return;
  settings.windowBounds = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  };
  saveSettings(settings);
}

function ensureClaudeConfig() {
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  let claudeSettings = {};

  try {
    if (fs.existsSync(settingsPath)) {
      claudeSettings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    }
  } catch {}

  if (claudeSettings.cleanupPeriodDays !== undefined) return;

  claudeSettings.cleanupPeriodDays = 36500;
  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify(claudeSettings, null, 2) + "\n",
      "utf8",
    );
  } catch {}
}

async function collectAndPush() {
  try {
    const current = await collectAllPeriods({
      allTimeSince: settings.allTimeSince,
      homeDir: os.homedir(),
    });

    lastCollected = {
      today: current.today,
      month: current.month,
      allTime: current.allTime,
    };

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("data:push", {
        data: lastCollected,
        settings: settingsForRenderer(),
        at: new Date().toISOString(),
      });
    }
  } catch (err) {
    if (lastCollected) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("data:push", {
          data: lastCollected,
          settings: settingsForRenderer(),
          at: new Date().toISOString(),
        });
      }
      return;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("data:push", {
        error: err.message,
        at: new Date().toISOString(),
      });
    }
  }
}

function opencodeDbPath() {
  return opencodeCollector.opencodeDbPath(os.homedir());
}

function claudeProjectsPath() {
  return path.join(os.homedir(), ".claude", "projects");
}

function watchDbFiles() {
  stopWatchers();

  const dbPath = opencodeDbPath();
  try {
    if (fs.existsSync(dbPath)) {
      const watchPaths = [dbPath];
      const walPath = dbPath + "-wal";
      if (fs.existsSync(walPath)) watchPaths.push(walPath);
      const shmPath = dbPath + "-shm";
      if (fs.existsSync(shmPath)) watchPaths.push(shmPath);
      opencodeWatcher = chokidar.watch(watchPaths, {
        ignoreInitial: true,
        persistent: true,
        usePolling: true,
        interval: 300,
        awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
      });
      opencodeWatcher.on("all", () => scheduleWatchTick());
      opencodeWatcher.on("error", () => {});
    }
  } catch {}

  try {
    const projectsDir = claudeProjectsPath();
    if (fs.existsSync(projectsDir)) {
      claudeWatcher = chokidar.watch(["*/*.jsonl", "*/*/subagents/*.jsonl"], {
        cwd: projectsDir,
        ignoreInitial: true,
        persistent: true,
        usePolling: true,
        interval: 300,
        awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
      });
      claudeWatcher.on("all", () => {
        claudeCollector.clearCache();
        scheduleWatchTick();
      });
      claudeWatcher.on("error", () => {});
    }
  } catch {}
}

function stopWatchers() {
  if (watchDebounceTimer) {
    clearTimeout(watchDebounceTimer);
    watchDebounceTimer = null;
  }
  if (opencodeWatcher) {
    try {
      opencodeWatcher.close();
    } catch {}
    opencodeWatcher = null;
  }
  if (claudeWatcher) {
    try {
      claudeWatcher.close();
    } catch {}
    claudeWatcher = null;
  }
}

function scheduleWatchTick() {
  if (watchDebounceTimer) clearTimeout(watchDebounceTimer);
  watchDebounceTimer = setTimeout(() => {
    watchDebounceTimer = null;
    runTick("watch");
  }, 200);
}

async function runTick(reason) {
  if (tickInFlight) {
    tickPending = true;
    return;
  }
  tickInFlight = true;
  try {
    await collectAndPush();
    while (tickPending) {
      tickPending = false;
      await collectAndPush();
    }
  } finally {
    tickInFlight = false;
  }
}

function startCollector(skipImmediate) {
  stopCollector();
  if (!skipImmediate) runTick("start");
  watchDbFiles();
  const intervalMs = Math.max(
    1000,
    Math.min(300000, Number(settings.refreshMs) || 5000),
  );
  collectorTimer = setInterval(() => runTick("interval"), intervalMs);
}

function stopCollector() {
  stopWatchers();
  if (collectorTimer) {
    clearInterval(collectorTimer);
    collectorTimer = null;
  }
}

function settingsForRenderer() {
  return { ...settings };
}

function setupIPC() {
  ipcMain.handle("settings:get", () => settingsForRenderer());

  ipcMain.handle("settings:update", (_event, patch) => {
    Object.assign(settings, patch);
    saveSettings(settings);
    if (patch.refreshMs !== undefined) startCollector();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("settings:push", settingsForRenderer());
    }
    return settingsForRenderer();
  });

  ipcMain.handle("data:refresh", async () => {
    await collectAndPush();
    return lastCollected;
  });

  ipcMain.handle("data:get", () => lastCollected);

  ipcMain.handle("session:getDetail", async (_event, { sessionId }) => {
    const opencodeResult = await opencodeCollector.readSessionDetail({
      sessionId,
      homeDir: os.homedir(),
    });
    if (opencodeResult && opencodeResult.found) {
      return opencodeResult;
    }

    const claudeResult = await claudeCollector.readSessionDetail({
      sessionId,
      homeDir: os.homedir(),
    });
    return claudeResult;
  });

  ipcMain.handle("window:minimize", () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
  });

  ipcMain.handle("window:maximize", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
    }
  });

  ipcMain.handle("window:close", () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  });

  ipcMain.handle("app:getInfo", () => ({
    version: app.getVersion(),
    name: APP_NAME,
    platform: `${process.platform}-${process.arch}`,
    userData: app.getPath("userData"),
  }));
}

app.whenReady().then(async () => {
  settings = readSettings();
  ensureClaudeConfig();
  setupIPC();
  createWindow();

  setTimeout(() => {
    startCollector();
  }, 50);
});

app.on("second-instance", () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.on("window-all-closed", () => {
  stopCollector();
  app.quit();
});

app.on("activate", () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
});
