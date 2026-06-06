const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

let sqlJsPromise = null;
function getSqlJs() {
  if (!sqlJsPromise) {
    try {
      const initSqlJs = require('sql.js');
      sqlJsPromise = initSqlJs();
    } catch {
      sqlJsPromise = Promise.reject(new Error('sql.js not available'));
    }
  }
  return sqlJsPromise;
}

function opencodeDbPath(home) {
  return path.join(home, '.local', 'share', 'opencode', 'opencode.db');
}

function msToIso(ms) {
  if (!ms) return '';
  const d = new Date(Number(ms));
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

function getDateKey(ts) {
  if (!ts) return 'unknown';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return 'unknown';
  return d.toISOString().slice(0, 10);
}

function getProviderLabel(providerId) {
  const map = {
    deepseek: 'DeepSeek',
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    google: 'Google',
    meta: 'Meta',
    mistral: 'Mistral',
    azure: 'Azure',
    bedrock: 'AWS Bedrock',
    together_ai: 'Together AI',
    fireworks_ai: 'Fireworks AI',
  };
  return map[providerId] || providerId || 'unknown';
}

async function collect({ period, allTimeSince, homeDir }) {
  const home = homeDir || os.homedir();
  const dbPath = opencodeDbPath(home);
  const exchanges = [];

  let db;
  try {
    if (!fs.existsSync(dbPath)) return { exchanges: [], sessions: [] };
    const SQL = await getSqlJs();
    const buffer = fs.readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } catch {
    return { exchanges: [], sessions: [] };
  }

  try {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const monthStart = new Date(Date.UTC(todayStart.getUTCFullYear(), todayStart.getUTCMonth(), 1));

    let whereClause = '';
    const params = [];
    if (period === 'today') {
      whereClause = 'WHERE s.time_created >= ?';
      params.push(todayStart.getTime());
    } else if (period === 'month') {
      whereClause = 'WHERE s.time_created >= ?';
      params.push(monthStart.getTime());
    } else if (period === 'allTime' && allTimeSince) {
      const since = new Date(allTimeSince);
      if (!Number.isNaN(since.getTime())) {
        whereClause = 'WHERE s.time_created >= ?';
        params.push(since.getTime());
      }
    }

    const stmt = db.prepare(`
      SELECT
        s.id,
        s.model,
        s.time_created,
        s.time_updated,
        s.tokens_input,
        s.tokens_output,
        s.tokens_reasoning,
        s.tokens_cache_read,
        s.tokens_cache_write,
        s.cost,
        s.title,
        s.directory,
        s.project_id
      FROM session s
      ${whereClause}
      ORDER BY s.time_created DESC
    `);

    if (params.length > 0) stmt.bind(params);

    while (stmt.step()) {
      const row = stmt.getAsObject();
      const inputTokens = Number(row.tokens_input) || 0;
      const outputTokens = Number(row.tokens_output) || 0;
      const cacheRead = Number(row.tokens_cache_read) || 0;
      const cacheWrite = Number(row.tokens_cache_write) || 0;
      const reasoningTokens = Number(row.tokens_reasoning) || 0;
      const cost = Number(row.cost) || 0;
      let modelRaw = (row.model || '').trim();
      if (!modelRaw) continue;

      let modelId = modelRaw;
      let providerId = '';
      try {
        const parsed = JSON.parse(modelRaw);
        modelId = parsed.id || parsed.model || '';
        providerId = parsed.providerID || '';
      } catch {}

      if (!modelId) continue;

      const ts = msToIso(row.time_created);

      if (inputTokens === 0 && outputTokens === 0 && cacheRead === 0 && cacheWrite === 0 && cost === 0) continue;

      exchanges.push({
        inputTokens,
        outputTokens,
        cacheReadInputTokens: cacheRead,
        cacheCreationInputTokens: cacheWrite,
        reasoningTokens,
        model: modelId,
        modelClean: modelId,
        provider: providerId,
        providerLabel: getProviderLabel(providerId),
        sessionId: row.id,
        timestamp: ts,
        dateKey: getDateKey(ts),
        timeCreated: Number(row.time_created) || 0,
        costUsd: cost,
        costFromDb: cost,
        sessionTitle: row.title || '',
        dirName: row.directory || '',
        projectId: row.project_id || '',
      });
    }
    stmt.free();

    // --- Handle model-switched sessions ---
    applyModelSwitchSplit(db, exchanges);
  } catch (err) {
    return { exchanges: [], sessions: [], error: err.message };
  } finally {
    try { if (db) db.close(); } catch {}
  }

  const seenSessions = new Set(exchanges.map((e) => e.sessionId).filter(Boolean));
  return { exchanges, sessions: Array.from(seenSessions) };
}

async function collectAll({ allTimeSince, homeDir }) {
  const home = homeDir || os.homedir();
  const dbPath = opencodeDbPath(home);
  const exchanges = [];

  let db;
  try {
    if (!fs.existsSync(dbPath)) return [];
    const SQL = await getSqlJs();
    const buffer = fs.readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } catch {
    return [];
  }

  try {
    const since = allTimeSince ? new Date(allTimeSince).getTime() : 0;
    let whereClause = '';
    const params = [];
    if (!Number.isNaN(since) && since > 0) {
      whereClause = 'WHERE s.time_created >= ?';
      params.push(since);
    }

    const stmt = db.prepare(`
      SELECT
        s.id, s.model, s.time_created, s.time_updated,
        s.tokens_input, s.tokens_output, s.tokens_reasoning,
        s.tokens_cache_read, s.tokens_cache_write, s.cost,
        s.title, s.directory, s.project_id
      FROM session s
      ${whereClause}
      ORDER BY s.time_created DESC
    `);

    if (params.length > 0) stmt.bind(params);

    while (stmt.step()) {
      const row = stmt.getAsObject();
      const inputTokens = Number(row.tokens_input) || 0;
      const outputTokens = Number(row.tokens_output) || 0;
      const cacheRead = Number(row.tokens_cache_read) || 0;
      const cacheWrite = Number(row.tokens_cache_write) || 0;
      const reasoningTokens = Number(row.tokens_reasoning) || 0;
      const cost = Number(row.cost) || 0;
      let modelRaw = (row.model || '').trim();
      if (!modelRaw) continue;

      let modelId = modelRaw;
      let providerId = '';
      try {
        const parsed = JSON.parse(modelRaw);
        modelId = parsed.id || parsed.model || '';
        providerId = parsed.providerID || '';
      } catch {}

      if (!modelId) continue;
      const ts = msToIso(row.time_created);
      if (inputTokens === 0 && outputTokens === 0 && cacheRead === 0 && cacheWrite === 0 && cost === 0) continue;

      exchanges.push({
        inputTokens, outputTokens, cacheReadInputTokens: cacheRead,
        cacheCreationInputTokens: cacheWrite, reasoningTokens,
        model: modelId, modelClean: modelId,
        provider: providerId, providerLabel: getProviderLabel(providerId),
        sessionId: row.id, timestamp: ts, dateKey: getDateKey(ts),
        timeCreated: Number(row.time_created) || 0,
        costUsd: cost, costFromDb: cost,
        sessionTitle: row.title || '', dirName: row.directory || '',
        projectId: row.project_id || '',
      });
    }
    stmt.free();

    applyModelSwitchSplit(db, exchanges);
  } catch {} finally {
    try { if (db) db.close(); } catch {}
  }

  return exchanges;
}

/**
 * For sessions that had model-switched events, split their single exchange
 * into per-model exchanges proportionally by per-message cost.
 */
function applyModelSwitchSplit(db, exchanges) {
  const collectedIds = exchanges.map(e => e.sessionId).filter(Boolean);
  if (collectedIds.length === 0) return;

  const placeholders = collectedIds.map(() => '?').join(',');
  const switchCheck = db.prepare(`SELECT DISTINCT session_id FROM session_message WHERE type = 'model-switched' AND session_id IN (${placeholders})`);
  switchCheck.bind(collectedIds);
  const switchedIds = [];
  while (switchCheck.step()) {
    const r = switchCheck.getAsObject();
    if (r.session_id) switchedIds.push(r.session_id);
  }
  switchCheck.free();

  if (switchedIds.length === 0) return;

  const msgPlaceholders = switchedIds.map(() => '?').join(',');
  const msgSt = db.prepare(`
    SELECT session_id, data FROM message
    WHERE session_id IN (${msgPlaceholders})
      AND json_extract(data, '$.role') = 'assistant'
      AND json_extract(data, '$.model.modelID') IS NOT NULL
    ORDER BY session_id, time_created ASC
  `);
  msgSt.bind(switchedIds);

  const perModel = {};
  while (msgSt.step()) {
    const r = msgSt.getAsObject();
    let d = {};
    try { d = JSON.parse(r.data || '{}'); } catch {}
    const m = d.model;
    if (!m) continue;
    const mid = m.modelID || m.id || '';
    if (!mid) continue;
    const key = r.session_id + '::' + mid;
    if (!perModel[key]) {
      perModel[key] = {
        sessionId: r.session_id, model: mid, provider: m.providerID || '',
        cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0
      };
    }
    const t = d.tokens || {};
    perModel[key].cost += Number(d.cost) || 0;
    perModel[key].input += Number(t.input) || 0;
    perModel[key].output += Number(t.output) || 0;
    perModel[key].cacheRead += Number(t.cache?.read) || Number(t.cache_read) || 0;
    perModel[key].cacheWrite += Number(t.cache?.write) || Number(t.cache_write) || 0;
    perModel[key].reasoning += Number(t.reasoning) || 0;
  }
  msgSt.free();

  const switchedSet = new Set(switchedIds);
  const kept = [];
  const exchangeBySession = {};
  for (const ex of exchanges) {
    if (switchedSet.has(ex.sessionId)) {
      if (!exchangeBySession[ex.sessionId]) exchangeBySession[ex.sessionId] = [];
      exchangeBySession[ex.sessionId].push(ex);
    } else {
      kept.push(ex);
    }
  }

  for (const [sid, sessionExchanges] of Object.entries(exchangeBySession)) {
    const orig = sessionExchanges[0];
    const models = Object.values(perModel).filter(p => p.sessionId === sid);
    const totalMsgCost = models.reduce((s, m) => s + m.cost, 0);

    if (totalMsgCost > 0) {
      for (const pm of models) {
        const ratio = pm.cost / totalMsgCost;
        kept.push({
          ...orig,
          model: pm.model, modelClean: pm.model,
          provider: pm.provider, providerLabel: getProviderLabel(pm.provider),
          inputTokens: Math.round(orig.inputTokens * ratio),
          outputTokens: Math.round(orig.outputTokens * ratio),
          cacheReadInputTokens: Math.round(orig.cacheReadInputTokens * ratio),
          cacheCreationInputTokens: Math.round(orig.cacheCreationInputTokens * ratio),
          reasoningTokens: Math.round(orig.reasoningTokens * ratio),
          costUsd: orig.costUsd * ratio,
          costFromDb: orig.costUsd * ratio,
        });
      }
    } else {
      kept.push(orig);
    }
  }
  exchanges.length = 0;
  exchanges.push(...kept);
}

async function readSessionDetail({ sessionId, homeDir }) {
  const home = homeDir || os.homedir();
  const dbPath = opencodeDbPath(home);
  let db;
  try {
    if (!fs.existsSync(dbPath)) return { exchanges: [], summary: null };
    const SQL = await getSqlJs();
    const buffer = fs.readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } catch {
    return { exchanges: [], summary: null };
  }

  try {
    const sessionStmt = db.prepare(`
      SELECT id, model, time_created, title, directory, project_id,
             tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, cost
      FROM session WHERE id = ?
    `);
    sessionStmt.bind([sessionId]);
    let sessionInfo = null;
    if (sessionStmt.step()) {
      sessionInfo = sessionStmt.getAsObject();
    }
    sessionStmt.free();

    const msgStmt = db.prepare(`
      SELECT id, session_id, time_created, data
      FROM message
      WHERE session_id = ?
      ORDER BY time_created ASC, id ASC
    `);
    msgStmt.bind([sessionId]);

    const messages = [];
    while (msgStmt.step()) {
      const row = msgStmt.getAsObject();
      let data = {};
      try { data = JSON.parse(row.data || '{}'); } catch {}
      messages.push({
        id: row.id,
        sessionId: row.session_id,
        timeCreated: row.time_created,
        ...data
      });
    }
    msgStmt.free();

    const partStmt = db.prepare(`
      SELECT id, message_id, session_id, time_created, data
      FROM part
      WHERE session_id = ?
      ORDER BY time_created ASC, id ASC
    `);
    partStmt.bind([sessionId]);

    const partsMap = {};
    while (partStmt.step()) {
      const row = partStmt.getAsObject();
      let data = {};
      try { data = JSON.parse(row.data || '{}'); } catch {}
      const mid = row.message_id;
      if (!partsMap[mid]) partsMap[mid] = [];
      partsMap[mid].push(data);
    }
    partStmt.free();

    const exchanges = [];
    let current = null;

    for (const msg of messages) {
      const role = (msg.role || '').toLowerCase();
      const msgParts = partsMap[msg.id] || [];
      const textParts = msgParts.filter(p => p.type === 'text' && p.text);
      const toolParts = msgParts.filter(p => p.type === 'tool' && p.tool);
      const fileParts = msgParts.filter(p => p.type === 'file');
      const text = textParts.map(p => p.text).join(' ').replace(/\s+/g, ' ').trim().substring(0, 300);
      const tools = toolParts.map(p => p.tool);
      const tokens = msg.tokens || {};
      const cost = msg.cost || 0;
      const ts = msg.timeCreated ? msToIso(msg.timeCreated) : '';

      if (role === 'user') {
        if (!text && fileParts.length === 0) continue;
        current = {
          promptPreview: text || '[files]',
          startedAt: ts,
          turnCount: 0,
          tokens: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
          costEstimate: 0,
          tools: [],
          turns: []
        };
        exchanges.push(current);
      } else if (role === 'assistant') {
        const tInput = Number(tokens.input) || 0;
        const tOutput = Number(tokens.output) || 0;
        const tCacheRead = Number(tokens.cache?.read) || Number(tokens.cache_read) || 0;
        const tCacheWrite = Number(tokens.cache?.write) || Number(tokens.cache_write) || 0;
        const tReasoning = Number(tokens.reasoning) || 0;
        const turnTokens = {
          total: tInput + tOutput + tCacheRead + tCacheWrite + tReasoning,
          input: tInput,
          output: tOutput,
          cacheRead: tCacheRead,
          cacheWrite: tCacheWrite,
          reasoning: tReasoning
        };

        if (!current) {
          current = {
            promptPreview: '',
            startedAt: ts,
            turnCount: 0,
            tokens: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
            costEstimate: 0,
            tools: [],
            turns: []
          };
          exchanges.push(current);
        }

        current.turns.push({
          tokens: turnTokens,
          costEstimate: cost,
          tools: tools
        });
        current.turnCount++;
        current.tokens.output += tOutput;
        current.tokens.cacheRead += tCacheRead;
        current.tokens.cacheWrite += tCacheWrite;
        current.tokens.reasoning += tReasoning;
        current.tokens.total += turnTokens.total;
        current.costEstimate += cost;
        if (tools.length > 0) current.tools.push(...tools);
      }
    }

    const rawExchanges = [];
    if (sessionInfo) {
      rawExchanges.push({
        inputTokens: Number(sessionInfo.tokens_input) || 0,
        outputTokens: Number(sessionInfo.tokens_output) || 0,
        cacheReadInputTokens: Number(sessionInfo.tokens_cache_read) || 0,
        cacheCreationInputTokens: Number(sessionInfo.tokens_cache_write) || 0,
        reasoningTokens: Number(sessionInfo.tokens_reasoning) || 0,
        costUsd: Number(sessionInfo.cost) || 0,
        model: sessionInfo.model || ''
      });
    }

    const { sumTokens } = require('../calculator');
    const summary = sumTokens(rawExchanges);

    return { exchanges, summary, found: exchanges.length > 0, sessionInfo };
  } catch {
    return { exchanges: [], summary: null };
  } finally {
    try { if (db) db.close(); } catch {}
  }
}

module.exports = { collect, collectAll, readSessionDetail, opencodeDbPath };
