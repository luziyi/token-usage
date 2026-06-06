'use strict';

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

function isWithinPeriod(ts, period, allTimeSince) {
  if (!ts) return true;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return true;
  const now = new Date();
  if (period === 'today') {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    return d.getTime() >= start.getTime();
  }
  if (period === 'month') {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    return d.getTime() >= start.getTime();
  }
  if (period === 'allTime') {
    if (!allTimeSince) return true;
    const since = new Date(allTimeSince);
    return Number.isNaN(since.getTime()) || d.getTime() >= since.getTime();
  }
  return true;
}

async function collect({ period, allTimeSince, homeDir }) {
  const home = homeDir || os.homedir();
  const dbPath = opencodeDbPath(home);
  const exchanges = [];

  let db;
  try {
    if (!fs.existsSync(dbPath)) return { client: 'opencode', label: 'OpenCode', exchanges: [], sessions: [] };
    const SQL = await getSqlJs();
    const buffer = fs.readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } catch {
    return { client: 'opencode', label: 'OpenCode', exchanges: [], sessions: [] };
  }

  try {
    const now = Date.now();
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
        s.directory
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
      let model = (row.model || '').trim();
      if (!model) continue; // skip sessions with no model info
      // OpenCode stores model as JSON like {"id":"deepseek-v4-flash","providerID":"deepseek",...}
      try { const parsed = JSON.parse(model); model = parsed.id || parsed.model || ''; } catch {}
      if (!model) continue; 
      const ts = msToIso(row.time_created);

      if (inputTokens === 0 && outputTokens === 0 && cacheRead === 0 && cacheWrite === 0 && cost === 0) continue;
      if (!isWithinPeriod(ts, period, allTimeSince)) continue;

      exchanges.push({
        inputTokens,
        outputTokens,
        cacheReadInputTokens: cacheRead,
        cacheCreationInputTokens: cacheWrite,
        reasoningTokens,
        model: model || 'opencode-default',
        sessionId: row.id,
        timestamp: ts,
        costUsd: cost,
        type: 'session',
        sessionTitle: row.title || '',
        dirName: row.directory || '',
      });
    }
    stmt.free();
  } catch {
    return { client: 'opencode', label: 'OpenCode', exchanges: [], sessions: [] };
  } finally {
    try { if (db) db.close(); } catch {}
  }

  const seenSessions = new Set(exchanges.map((e) => e.sessionId).filter(Boolean));
  return { client: 'opencode', label: 'OpenCode', exchanges, sessions: Array.from(seenSessions) };
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
    // Read messages for this session
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

    // Read parts for this session
    const partStmt = db.prepare(`
      SELECT id, message_id, session_id, time_created, data
      FROM part
      WHERE session_id = ?
      ORDER BY time_created ASC, id ASC
    `);
    partStmt.bind([sessionId]);

    const parts = {};
    while (partStmt.step()) {
      const row = partStmt.getAsObject();
      let data = {};
      try { data = JSON.parse(row.data || '{}'); } catch {}
      const mid = row.message_id;
      if (!parts[mid]) parts[mid] = [];
      parts[mid].push(data);
    }
    partStmt.free();

    // Build events (prompt → turn grouping)
    const exchanges = [];
    let current = null;

    for (const msg of messages) {
      const role = (msg.role || '').toLowerCase();
      const msgParts = parts[msg.id] || [];
      const textParts = msgParts.filter(p => p.type === 'text' && p.text);
      const toolParts = msgParts.filter(p => p.type === 'tool' && p.tool);
      const text = textParts.map(p => p.text).join(' ').replace(/\s+/g, ' ').trim().substring(0, 200);
      const tools = toolParts.map(p => p.tool);
      const tokens = msg.tokens || {};
      const cost = msg.cost || 0;
      const ts = msg.timeCreated ? msToIso(msg.timeCreated) : '';

      if (role === 'user') {
        if (!text) continue; // skip empty user messages
        current = {
          promptPreview: text,
          startedAt: ts,
          turnCount: 0,
          tokens: {
            total: 0,
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            reasoning: 0
          },
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
        current.tokens.input += tInput;
        current.tokens.output += tOutput;
        current.tokens.cacheRead += tCacheRead;
        current.tokens.cacheWrite += tCacheWrite;
        current.tokens.reasoning += tReasoning;
        current.tokens.total += turnTokens.total;
        current.costEstimate += cost;
        if (tools.length > 0) current.tools.push(...tools);
      }
    }

    const { sumTokens } = require('../calculator');
    // Build raw exchange objects for sumTokens
    const rawExchanges = messages.map(msg => {
      const tokens = msg.tokens || {};
      return {
        inputTokens: Number(tokens.input) || 0,
        outputTokens: Number(tokens.output) || 0,
        cacheReadInputTokens: Number(tokens.cache?.read) || Number(tokens.cache_read) || 0,
        cacheCreationInputTokens: Number(tokens.cache?.write) || Number(tokens.cache_write) || 0,
        reasoningTokens: Number(tokens.reasoning) || 0,
        costUsd: msg.cost || 0,
        model: (msg.model?.modelID || msg.model?.id || 'opencode').replace(/^opencode\//, '')
      };
    });
    const summary = sumTokens(rawExchanges);

    return { exchanges, summary, found: exchanges.length > 0 };
  } catch {
    return { exchanges: [], summary: null };
  } finally {
    try { if (db) db.close(); } catch {}
  }
}

module.exports = { collect, readSessionDetail, opencodeDbPath };
