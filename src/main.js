const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { app, BrowserWindow, ipcMain } = require("electron");
const chokidar = require("chokidar");
const { readSettings, saveSettings } = require("./store");
const {
  collectAllPeriods,
  collectRawExchanges,
  opencodeCollector,
  claudeCollector,
} = require("./collectors");
const { buildAggregate } = require("./calculator");
const persist = require("./persist");

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

async function collectAndPush() {
  try {
    const current = await collectAllPeriods({
      allTimeSince: settings.allTimeSince,
      homeDir: os.homedir(),
    });

    // Filter out exchanges with 0 total tokens (interrupted responses)
    const validExchanges = current.rawExchanges.filter(isValidExchange);

    // Persist raw exchanges to DB (historical archive)
    persist.upsertExchanges(validExchanges);
    persist.saveToDisk();

    // Merge with DB historical data for display
    const dbExchanges = persist.readAllExchanges();
    let mergedPeriods;
    if (dbExchanges.length > 0) {
      const merged = mergeExchanges(dbExchanges, validExchanges);
      mergedPeriods = buildPeriodData(merged, settings.allTimeSince);
    } else {
      mergedPeriods = {
        today: current.today,
        month: current.month,
        allTime: current.allTime,
      };
    }

    lastCollected = mergedPeriods;

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("data:push", {
        data: mergedPeriods,
        settings: settingsForRenderer(),
        at: new Date().toISOString(),
      });
    }
  } catch (err) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("data:push", {
        error: err.message,
        at: new Date().toISOString(),
      });
    }
  }
}

function mergeExchanges(dbExchanges, currentExchanges) {
  const map = new Map();
  // DB first
  for (const ex of dbExchanges) {
    const key =
      ex.source + ":" + ex.sessionId + ":" + ex.model + ":" + ex.timeCreated;
    map.set(key, ex);
  }
  // Current overwrites
  for (const ex of currentExchanges) {
    const key =
      ex.source + ":" + ex.sessionId + ":" + ex.model + ":" + ex.timeCreated;
    map.set(key, ex);
  }
  return Array.from(map.values());
}

function buildPeriodData(allExchanges, allTimeSince) {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const monthStart = new Date(
    todayStart.getFullYear(),
    todayStart.getMonth(),
    1,
  );
  const since = allTimeSince ? new Date(allTimeSince).getTime() : 0;

  const today = {
    period: "today",
    exchanges: [],
    aggregated: null,
    totalExchanges: 0,
    totalSessions: 0,
  };
  const month = {
    period: "month",
    exchanges: [],
    aggregated: null,
    totalExchanges: 0,
    totalSessions: 0,
  };
  const allTime = {
    period: "allTime",
    exchanges: [],
    aggregated: null,
    totalExchanges: 0,
    totalSessions: 0,
  };

  const seenToday = new Set(),
    seenMonth = new Set(),
    seenAll = new Set();
  const start = todayStart.getTime();
  const mStart = monthStart.getTime();

  if (!Number.isNaN(since) && since > 0) {
    for (const ex of allExchanges) {
      const t = ex.timeCreated;
      if (t >= since) {
        allTime.exchanges.push(ex);
        if (ex.sessionId) seenAll.add(ex.sessionId);
        if (t >= mStart) {
          month.exchanges.push(ex);
          if (ex.sessionId) seenMonth.add(ex.sessionId);
          if (t >= start) {
            today.exchanges.push(ex);
            if (ex.sessionId) seenToday.add(ex.sessionId);
          }
        }
      }
    }
  } else {
    for (const ex of allExchanges) {
      allTime.exchanges.push(ex);
      if (ex.sessionId) seenAll.add(ex.sessionId);
      const t = ex.timeCreated;
      if (t >= mStart) {
        month.exchanges.push(ex);
        if (ex.sessionId) seenMonth.add(ex.sessionId);
        if (t >= start) {
          today.exchanges.push(ex);
          if (ex.sessionId) seenToday.add(ex.sessionId);
        }
      }
    }
  }

  today.aggregated = buildAggregate(today.exchanges);
  today.totalExchanges = today.exchanges.length;
  today.totalSessions = seenToday.size;

  month.aggregated = buildAggregate(month.exchanges);
  month.totalExchanges = month.exchanges.length;
  month.totalSessions = seenMonth.size;

  allTime.aggregated = buildAggregate(allTime.exchanges);
  allTime.totalExchanges = allTime.exchanges.length;
  allTime.totalSessions = seenAll.size;

  return { today, month, allTime };
}

function isValidExchange(ex) {
  const total =
    (ex.inputTokens || 0) +
    (ex.outputTokens || 0) +
    (ex.cacheReadInputTokens || 0) +
    (ex.cacheCreationInputTokens || 0) +
    (ex.reasoningTokens || 0);
  return total > 0;
}

function opencodeDbPath() {
  return opencodeCollector.opencodeDbPath(os.homedir());
}

function claudeProjectsPath() {
  return path.join(os.homedir(), ".claude", "projects");
}

function watchDbFiles() {
  stopWatchers();

  // Watch OpenCode DB
  const dbPath = opencodeDbPath();
  try {
    if (fs.existsSync(dbPath)) {
      const dbDir = path.dirname(dbPath);
      opencodeWatcher = chokidar.watch(dbPath, {
        ignoreInitial: true,
        persistent: true,
        usePolling: true,
        interval: 1000,
        awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 200 },
      });
      opencodeWatcher.on("all", () => scheduleWatchTick());
      opencodeWatcher.on("error", () => {});
    }
  } catch {}

  // Watch Claude Code projects directory for JSONL files
  try {
    const projectsDir = claudeProjectsPath();
    if (fs.existsSync(projectsDir)) {
      claudeWatcher = chokidar.watch(["*/*.jsonl", "*/*/subagents/*.jsonl"], {
        cwd: projectsDir,
        ignoreInitial: true,
        persistent: true,
        usePolling: true,
        interval: 1000,
        awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 200 },
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
  }, 800);
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
    2000,
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
    // Try OpenCode first, then Claude Code
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

function pushToRenderer(data, settingsOverride, at) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("data:push", {
      data,
      settings: settingsOverride || settingsForRenderer(),
      at: at || new Date().toISOString(),
    });
  }
}

app.whenReady().then(async () => {
  settings = readSettings();
  await persist.init();
  persist.removeStatsCacheEntries();
  setupIPC();
  createWindow();

  // Fast path: show cached data from local DB immediately (no source file reads)
  const existing = persist.readAllExchanges();
  if (existing.length > 0) {
    lastCollected = buildPeriodData(existing, settings.allTimeSince);
    pushToRenderer(lastCollected);
  }

  // Defer source file reading so the window renders first
  setTimeout(async () => {
    if (existing.length === 0) {
      // First run: seed DB from sources once, then start collector without re-reading
      try {
        const seed = await collectRawExchanges({
          allTimeSince: settings.allTimeSince,
          homeDir: os.homedir(),
        });
        persist.upsertExchanges(seed);
        persist.saveToDisk();
        lastCollected = buildPeriodData(seed, settings.allTimeSince);
        pushToRenderer(lastCollected);
      } catch {}
      startCollector(true); // skip immediate tick — seed already has fresh data
    } else {
      // Sync from sources in background, user already sees cached data
      startCollector();
    }
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
  persist.close();
  app.quit();
});

app.on("activate", () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
});
