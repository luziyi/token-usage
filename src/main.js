const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { app, BrowserWindow, ipcMain } = require('electron');
const chokidar = require('chokidar');
const { readSettings, saveSettings } = require('./store');
const { collectAllPeriods, opencodeCollector } = require('./collectors');

const APP_NAME = 'Token Usage';

app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId('com.token-usage.app');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.exit(0);

let mainWindow = null;
let settings = null;
let collectorTimer = null;
let watchDebounceTimer = null;
let watcher = null;
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
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  };

  if (savedBounds && typeof savedBounds.x === 'number') {
    options.x = savedBounds.x;
    options.y = savedBounds.y;
  }

  mainWindow = new BrowserWindow(options);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.on('resize', () => persistBoundsSoon());
  mainWindow.on('move', () => persistBoundsSoon());
}

function persistBoundsSoon() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized() || mainWindow.isFullScreen()) return;
  const bounds = mainWindow.getBounds();
  const prev = settings.windowBounds || {};
  if (prev.x === bounds.x && prev.y === bounds.y && prev.width === bounds.width && prev.height === bounds.height) return;
  settings.windowBounds = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  saveSettings(settings);
}

async function collectAndPush() {
  try {
    const data = await collectAllPeriods({
      allTimeSince: settings.allTimeSince,
      homeDir: os.homedir()
    });
    lastCollected = data;

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('data:push', {
        data,
        settings: settingsForRenderer(),
        at: new Date().toISOString()
      });
    }
  } catch (err) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('data:push', {
        error: err.message,
        at: new Date().toISOString()
      });
    }
  }
}

function opencodeDbPath() {
  return opencodeCollector.opencodeDbPath(os.homedir());
}

function watchDbFile() {
  stopWatcher();
  const dbPath = opencodeDbPath();
  try {
    if (!fs.existsSync(dbPath)) return;
    const dbDir = path.dirname(dbPath);
    watcher = chokidar.watch(dbPath, {
      ignoreInitial: true,
      persistent: true,
      usePolling: true,
      interval: 1000,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 200 }
    });
    watcher.on('all', () => scheduleWatchTick());
    watcher.on('error', () => {});
  } catch {}
}

function stopWatcher() {
  if (watchDebounceTimer) { clearTimeout(watchDebounceTimer); watchDebounceTimer = null; }
  if (watcher) { try { watcher.close(); } catch {} watcher = null; }
}

function scheduleWatchTick() {
  if (watchDebounceTimer) clearTimeout(watchDebounceTimer);
  watchDebounceTimer = setTimeout(() => {
    watchDebounceTimer = null;
    runTick('watch');
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

function startCollector() {
  stopCollector();
  runTick('start');
  watchDbFile();
  const intervalMs = Math.max(2000, Math.min(300000, Number(settings.refreshMs) || 5000));
  collectorTimer = setInterval(() => runTick('interval'), intervalMs);
}

function stopCollector() {
  stopWatcher();
  if (collectorTimer) {
    clearInterval(collectorTimer);
    collectorTimer = null;
  }
}

function settingsForRenderer() {
  return { ...settings };
}

function setupIPC() {
  ipcMain.handle('settings:get', () => settingsForRenderer());

  ipcMain.handle('settings:update', (_event, patch) => {
    Object.assign(settings, patch);
    saveSettings(settings);
    if (patch.refreshMs !== undefined) startCollector();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('settings:push', settingsForRenderer());
    }
    return settingsForRenderer();
  });

  ipcMain.handle('data:refresh', async () => {
    await collectAndPush();
    return lastCollected;
  });

  ipcMain.handle('data:get', () => lastCollected);

  ipcMain.handle('session:getDetail', async (_event, { sessionId }) => {
    const result = await opencodeCollector.readSessionDetail({
      sessionId,
      homeDir: os.homedir()
    });
    return result;
  });

  ipcMain.handle('window:minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
  });

  ipcMain.handle('window:maximize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
    }
  });

  ipcMain.handle('window:close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  });

  ipcMain.handle('app:getInfo', () => ({
    version: app.getVersion(),
    name: APP_NAME,
    platform: `${process.platform}-${process.arch}`,
    userData: app.getPath('userData')
  }));
}

app.whenReady().then(() => {
  settings = readSettings();
  setupIPC();
  createWindow();
  startCollector();
});

app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.on('window-all-closed', () => {
  stopCollector();
  app.quit();
});

app.on('activate', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
});
