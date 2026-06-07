const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const initSqlJs = require('sql.js');

const DB_DIR = path.join(os.homedir(), '.token-usage');
const DB_PATH = path.join(DB_DIR, 'data.db');

let db = null;

async function init() {
  const SQL = await initSqlJs();
  fs.mkdirSync(DB_DIR, { recursive: true });

  let buffer;
  try { buffer = fs.readFileSync(DB_PATH); } catch { buffer = null; }

  db = new SQL.Database(buffer);
  db.run('PRAGMA journal_mode=WAL');
  db.run(`CREATE TABLE IF NOT EXISTS exchanges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    session_id TEXT NOT NULL,
    model TEXT NOT NULL,
    model_clean TEXT DEFAULT '',
    provider TEXT DEFAULT '',
    provider_label TEXT DEFAULT '',
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0,
    cache_write_tokens INTEGER DEFAULT 0,
    reasoning_tokens INTEGER DEFAULT 0,
    timestamp TEXT DEFAULT '',
    date_key TEXT DEFAULT '',
    time_created INTEGER DEFAULT 0,
    cost_usd REAL DEFAULT 0,
    cost_from_db REAL DEFAULT 0,
    session_title TEXT DEFAULT '',
    dir_name TEXT DEFAULT '',
    project_id TEXT DEFAULT '',
    agent_id TEXT DEFAULT '',
    agent_type TEXT DEFAULT '',
    agent_label TEXT DEFAULT '',
    UNIQUE(source, session_id, model, time_created)
  )`);

  return db;
}

function saveToDisk() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function upsertExchanges(exchanges) {
  if (!db || !exchanges.length) return;
  const stmt = db.prepare(`INSERT OR REPLACE INTO exchanges
    (source, session_id, model, model_clean, provider, provider_label,
     input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
     timestamp, date_key, time_created, cost_usd, cost_from_db,
     session_title, dir_name, project_id,
     agent_id, agent_type, agent_label)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  for (const ex of exchanges) {
    stmt.run([
      ex.source || 'unknown',
      ex.sessionId || '',
      ex.model || '',
      ex.modelClean || '',
      ex.provider || '',
      ex.providerLabel || '',
      ex.inputTokens || 0,
      ex.outputTokens || 0,
      ex.cacheReadInputTokens || 0,
      ex.cacheCreationInputTokens || 0,
      ex.reasoningTokens || 0,
      ex.timestamp || '',
      ex.dateKey || '',
      ex.timeCreated || 0,
      ex.costUsd || 0,
      ex.costFromDb || 0,
      ex.sessionTitle || '',
      ex.dirName || '',
      ex.projectId || '',
      ex.agentId || '',
      ex.agentType || '',
      ex.agentLabel || '',
    ]);
  }
  stmt.free();
}

function readAllExchanges() {
  if (!db) return [];
  const results = db.exec('SELECT * FROM exchanges ORDER BY time_created ASC');
  if (!results.length) return [];

  const columns = results[0].columns;
  const rows = results[0].values;

  return rows.map(row => {
    const ex = {};
    columns.forEach((col, i) => { ex[col] = row[i]; });
    return {
      source: ex.source,
      sessionId: ex.session_id,
      model: ex.model,
      modelClean: ex.model_clean || ex.model,
      provider: ex.provider || '',
      providerLabel: ex.provider_label || '',
      inputTokens: ex.input_tokens || 0,
      outputTokens: ex.output_tokens || 0,
      cacheReadInputTokens: ex.cache_read_tokens || 0,
      cacheCreationInputTokens: ex.cache_write_tokens || 0,
      reasoningTokens: ex.reasoning_tokens || 0,
      timestamp: ex.timestamp || '',
      dateKey: ex.date_key || '',
      timeCreated: ex.time_created || 0,
      costUsd: ex.cost_usd || 0,
      costFromDb: ex.cost_from_db || 0,
      sessionTitle: ex.session_title || '',
      dirName: ex.dir_name || '',
      projectId: ex.project_id || '',
      agentId: ex.agent_id || '',
      agentType: ex.agent_type || '',
      agentLabel: ex.agent_label || '',
    };
  });
}

function removeStatsCacheEntries() {
  if (!db) return;
  db.run("DELETE FROM exchanges WHERE session_id LIKE 'stats-cache-%'");
  saveToDisk();
}

function close() {
  saveToDisk();
  if (db) { db.close(); db = null; }
}

module.exports = { init, saveToDisk, upsertExchanges, readAllExchanges, removeStatsCacheEntries, close };
