'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const chokidar = require('chokidar');
const { readSettings, saveSettings } = require('./store');
const { collectAllPeriods, collectSessionDetail } = require('./collectors');

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
let allRawExchanges = {};
let tickInFlight = false;
let tickPending = false;

const DEFAULT_WINDOW = { width: 360, height: 500 };

function createWindow() {
  const savedBounds = settings?.windowBounds;
  const options = {
    width: savedBounds?.width || DEFAULT_WINDOW.width,
    height: savedBounds?.height || DEFAULT_WINDOW.height,
    minWidth: 240,
    minHeight: 140,
    maxWidth: 1200,
    maxHeight: 1400,
    frame: false,
    transparent: true,
    resizable: true,
    skipTaskbar: false,
    alwaysOnTop: true,
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

  applyWindowSettings();
}

function applyWindowSettings() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setAlwaysOnTop(true, 'floating');
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

async function collectAndPush(force = false) {
  try {
    const data = await collectAllPeriods({
      clients: settings.clients,
      allTimeSince: settings.allTimeSince,
      homeDir: os.homedir()
    });
    lastCollected = data;

    // Store raw exchanges for session detail queries
    for (const [client, clientData] of Object.entries(data.today?.clients || {})) {
      if (clientData?.exchanges) {
        allRawExchanges[client] = clientData.exchanges;
      }
    }
    // Also merge month and allTime exchanges
    for (const period of ['month', 'allTime']) {
      for (const [client, clientData] of Object.entries(data[period]?.clients || {})) {
        if (clientData?.exchanges) {
          if (!allRawExchanges[client]) allRawExchanges[client] = [];
          const existing = new Set(allRawExchanges[client].map(e => e.sessionId + ':' + e.timestamp));
          for (const ex of clientData.exchanges) {
            const key = ex.sessionId + ':' + ex.timestamp;
            if (!existing.has(key)) {
              allRawExchanges[client].push(ex);
              existing.add(key);
            }
          }
        }
      }
    }

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

function watchPathsForClients(clientsCsv) {
  const home = os.homedir();
  const enabled = new Set(String(clientsCsv || '').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean));
  const candidates = [];
  if (enabled.has('claude')) {
    candidates.push(path.join(home, '.claude', 'projects'));
    candidates.push(path.join(home, '.claude', 'transcripts'));
  }
  if (enabled.has('codex')) {
    candidates.push(path.join(home, '.codex', 'sessions'));
  }
  if (enabled.has('opencode')) {
    candidates.push(path.join(home, '.local', 'share', 'opencode'));
  }
  return candidates.filter((c) => { try { return fs.statSync(c).isDirectory(); } catch { return false; } });
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

function scheduleWatchTick() {
  if (watchDebounceTimer) clearTimeout(watchDebounceTimer);
  watchDebounceTimer = setTimeout(() => {
    watchDebounceTimer = null;
    runTick('watch');
  }, 800);
}

function startWatcher() {
  stopWatcher();
  const dirs = watchPathsForClients(settings.clients);
  if (dirs.length === 0) return;
  watcher = chokidar.watch(dirs, {
    ignoreInitial: true,
    persistent: true,
    usePolling: true,
    interval: 1000,
    binaryInterval: 2000,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 }
  });
  watcher.on('all', () => scheduleWatchTick());
  watcher.on('error', () => {});
}

function stopWatcher() {
  if (watchDebounceTimer) { clearTimeout(watchDebounceTimer); watchDebounceTimer = null; }
  if (watcher) { try { watcher.close(); } catch {} watcher = null; }
}

function startCollector() {
  stopCollector();
  runTick('start');
  startWatcher();
  const intervalMs = Math.max(5000, Math.min(300000, Number(settings.refreshMs) || 15000));
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

function isBoundsOnScreen(bounds) {
  if (!bounds || typeof bounds.x !== 'number') return false;
  try {
    const display = screen.getDisplayMatching({ x: bounds.x, y: bounds.y, width: bounds.width || 1, height: bounds.height || 1 });
    const wa = display.workArea;
    return bounds.x + bounds.width > wa.x && bounds.x < wa.x + wa.width && bounds.y + bounds.height > wa.y && bounds.y < wa.y + wa.height;
  } catch { return false; }
}

function setupIPC() {
  ipcMain.handle('settings:get', () => settingsForRenderer());

  ipcMain.handle('settings:update', (_event, patch) => {
    Object.assign(settings, patch);
    saveSettings(settings);
    if (patch.refreshMs !== undefined || patch.clients !== undefined) startCollector();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('settings:push', settingsForRenderer());
    }
    return settingsForRenderer();
  });

  ipcMain.handle('data:refresh', async () => {
    await collectAndPush(true);
    return lastCollected;
  });

  ipcMain.handle('data:get', () => lastCollected);

  ipcMain.handle('session:getDetail', async (_event, { sessionId, client }) => {
    const result = await collectSessionDetail({
      sessionId,
      client,
      allTimeSince: settings.allTimeSince,
      homeDir: os.homedir()
    });
    return { ...result, client };
  });

  ipcMain.handle('window:minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
  });

  ipcMain.handle('window:close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  });

  ipcMain.handle('window:togglePin', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const next = !mainWindow.isAlwaysOnTop();
      mainWindow.setAlwaysOnTop(next, 'floating');
      return next;
    }
    return false;
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
