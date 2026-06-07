const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const APP_NAME = 'Token Usage';

function userDataDir() {
  const platform = process.platform;
  if (platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), APP_NAME);
  if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', APP_NAME);
  return path.join(os.homedir(), '.config', APP_NAME);
}

function readSettings() {
  const p = path.join(userDataDir(), 'settings.json');
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { ...defaults(), ...raw };
  } catch {
    return defaults();
  }
}

function saveSettings(s) {
  const p = path.join(userDataDir(), 'settings.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(s, null, 2), 'utf8');
}

function defaults() {
  return {
    refreshMs: 5000,
    windowBounds: null,
    currency: 'USD',
    accentColor: '#5e9eff',
    allTimeSince: '2024-01-01'
  };
}

module.exports = { readSettings, saveSettings, defaults, userDataDir };
