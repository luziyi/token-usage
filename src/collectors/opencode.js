const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { calculateExchangeCost } = require("../calculator");
const { getSqlJs } = require("../persist");
const { msToIso, getDateKey, getProviderLabel } = require("./util");

function opencodeDbPath(home) {
  return path.join(home, ".local", "share", "opencode", "opencode.db");
}

const EXCHANGE_SQL = `
  SELECT
    s.id, s.model, s.time_created, s.time_updated,
    s.title, s.directory, s.project_id,
    COALESCE(SUM(CASE WHEN json_extract(m.data, '$.role') = 'assistant' THEN CAST(json_extract(m.data, '$.tokens.input') AS INTEGER) ELSE 0 END), 0) AS tokens_input,
    COALESCE(SUM(CASE WHEN json_extract(m.data, '$.role') = 'assistant' THEN CAST(json_extract(m.data, '$.tokens.output') AS INTEGER) ELSE 0 END), 0) AS tokens_output,
    COALESCE(SUM(CASE WHEN json_extract(m.data, '$.role') = 'assistant' THEN CAST(json_extract(m.data, '$.tokens.reasoning') AS INTEGER) ELSE 0 END), 0) AS tokens_reasoning,
    COALESCE(SUM(CASE WHEN json_extract(m.data, '$.role') = 'assistant' THEN CAST(json_extract(m.data, '$.tokens.cache.read') AS INTEGER) ELSE 0 END), 0) AS tokens_cache_read,
    COALESCE(SUM(CASE WHEN json_extract(m.data, '$.role') = 'assistant' THEN CAST(json_extract(m.data, '$.tokens.cache.write') AS INTEGER) ELSE 0 END), 0) AS tokens_cache_write,
    COALESCE(SUM(CASE WHEN json_extract(m.data, '$.role') = 'assistant' THEN CAST(json_extract(m.data, '$.cost') AS REAL) ELSE 0 END), 0) AS cost
  FROM session s
  LEFT JOIN message m ON m.session_id = s.id
`;

function rowToExchange(row) {
  const inputTokens = Number(row.tokens_input) || 0;
  const outputTokens = Number(row.tokens_output) || 0;
  const cacheRead = Number(row.tokens_cache_read) || 0;
  const cacheWrite = Number(row.tokens_cache_write) || 0;
  const reasoningTokens = Number(row.tokens_reasoning) || 0;
  const cost = Number(row.cost) || 0;

  if (
    inputTokens === 0 &&
    outputTokens === 0 &&
    cacheRead === 0 &&
    cacheWrite === 0 &&
    cost === 0
  )
    return null;

  let modelRaw = (row.model || "").trim();
  if (!modelRaw) return null;

  let modelId = modelRaw;
  let providerId = "";
  try {
    const parsed = JSON.parse(modelRaw);
    modelId = parsed.id || parsed.modelID || parsed.model || "";
    providerId = parsed.providerID || "";
  } catch {}

  if (!modelId) return null;

  const ts = msToIso(row.time_created);

  return {
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
    sessionTitle: row.title || "",
    dirName: row.directory || "",
    projectId: row.project_id || "",
    source: "opencode",
  };
}

// -- DB engine: sqlite3 CLI (native, WAL-aware), fallback to sql.js buffer --

function findSqlite3() {
  let isPkg = false;
  try { isPkg = require("electron").app.isPackaged; } catch {}
  const candidates = [];

  if (process.platform === "win32") {
    if (isPkg) {
      candidates.push(path.join(process.resourcesPath, "sqlite3.exe"));
    } else {
      candidates.push(path.join(__dirname, "..", "..", "assets", "sqlite3.exe"));
    }
  } else {
    candidates.push("sqlite3");
    if (isPkg) {
      candidates.push(path.join(process.resourcesPath, "sqlite3"));
    } else {
      candidates.push(path.join(__dirname, "..", "..", "assets", "sqlite3"));
      candidates.push("/usr/bin/sqlite3");
      candidates.push("/usr/local/bin/sqlite3");
    }
  }

  for (const c of candidates) {
    try {
      const r = execFileSync(c, ["--version"], {
        encoding: "utf8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (r && r.trim()) return c;
    } catch {}
  }
  return null;
}

function sqlEscape(val) {
  if (typeof val === "number") return String(val);
  return "'" + String(val).replace(/'/g, "''") + "'";
}

function substParams(sql, params) {
  if (!params || params.length === 0) return sql;
  let i = 0;
  return sql.replace(/\?/g, () => sqlEscape(params[i++]));
}

function sqlite3All(sqlite3Path, dbPath, sql, params) {
  const fullSql = ".mode json\n" + substParams(sql, params) + ";\n";
  const result = execFileSync(sqlite3Path, [dbPath], {
    encoding: "utf8",
    timeout: 10000,
    input: fullSql,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const trimmed = result.trim();
  if (!trimmed) return [];
  return JSON.parse(trimmed);
}

function sqlJsAll(db, sql, params) {
  const p = db.prepare(sql);
  if (params && params.length > 0) p.bind(params);
  const rows = [];
  while (p.step()) {
    rows.push(p.getAsObject());
  }
  p.free();
  return rows;
}

let _sqlite3Cache;
let _sqlJsFallback;

async function openDb(home) {
  const dbPath = opencodeDbPath(home);
  if (!fs.existsSync(dbPath)) return null;

  if (_sqlite3Cache === undefined) _sqlite3Cache = findSqlite3();
  if (_sqlite3Cache) return { _type: "cli", _dbPath: dbPath, _bin: _sqlite3Cache };

  const SQL = await getSqlJs();
  const buffer = fs.readFileSync(dbPath);
  return _sqlJsFallback || (_sqlJsFallback = new SQL.Database(buffer));
}

function sqlAll(db, sql, params) {
  if (db._type === "cli") {
    return sqlite3All(db._bin, db._dbPath, sql, params);
  }
  return sqlJsAll(db, sql, params);
}

function dbClose(db) {
  if (!db || db._type === "cli") return;
  try { db.close(); } catch {}
}

// -- End DB engine --

async function collectAll({ allTimeSince, homeDir }) {
  const home = homeDir || os.homedir();
  const exchanges = [];

  let db;
  try {
    db = await openDb(home);
    if (!db) return [];

    const since = allTimeSince ? new Date(allTimeSince).getTime() : 0;
    let whereClause = "";
    const params = [];
    if (!Number.isNaN(since) && since > 0) {
      whereClause = "WHERE s.time_created >= ?";
      params.push(since);
    }

    const sql =
      EXCHANGE_SQL + whereClause + " GROUP BY s.id ORDER BY s.time_created DESC";
    const rows = sqlAll(db, sql, params);

    for (const row of rows) {
      const ex = rowToExchange(row);
      if (ex) exchanges.push(ex);
    }

    applyModelSwitchSplit(db, exchanges);
  } catch {
  } finally {
    dbClose(db);
  }

  return exchanges;
}

function applyModelSwitchSplit(db, exchanges) {
  const collectedIds = exchanges.map((e) => e.sessionId).filter(Boolean);
  if (collectedIds.length === 0) return;

  const placeholders = collectedIds.map(() => "?").join(",");
  const switchRows = sqlAll(
    db,
    `SELECT DISTINCT session_id FROM session_message WHERE type = 'model-switched' AND session_id IN (${placeholders})`,
    collectedIds,
  );
  const switchedIds = switchRows.map((r) => r.session_id).filter(Boolean);
  if (switchedIds.length === 0) return;

  const matchSession = (msgSid) => {
    for (const sid of switchedIds) {
      if (msgSid.startsWith(sid)) return sid;
    }
    return msgSid;
  };

  const perModel = {};

  const likeList = switchedIds
    .map(() => "session_id LIKE ? || '%'")
    .join(" OR ");
  const st1Rows = sqlAll(
    db,
    `SELECT session_id, time_created, data FROM message
      WHERE (${likeList})
        AND json_extract(data, '$.role') = 'assistant'
        AND (json_extract(data, '$.modelID') IS NOT NULL OR json_extract(data, '$.model.modelID') IS NOT NULL)
      ORDER BY session_id, time_created ASC`,
    switchedIds,
  );
  for (const r of st1Rows) {
    let d = {};
    try { d = JSON.parse(r.data || "{}"); } catch {}
    const mid = d.modelID || (d.model && (d.model.modelID || d.model.id)) || "";
    const provID = d.providerID || (d.model && d.model.providerID) || "";
    if (!mid) continue;
    const sid = matchSession(r.session_id);
    const key = sid + "::" + mid;
    if (!perModel[key]) { perModel[key] = { sessionId: sid, model: mid, provider: provID, cost: 0 }; }
    perModel[key].cost += Number(d.cost) || 0;
  }

  const needFallback = switchedIds.filter(
    (sid) => !Object.keys(perModel).some((k) => k.startsWith(sid + "::")),
  );
  if (needFallback.length > 0) {
    const timeline = {};
    for (const sid of needFallback) {
      timeline[sid] = [];
      const sRows = sqlAll(db, "SELECT model FROM session WHERE id = ?", [sid]);
      if (sRows.length > 0) {
        try {
          const p = JSON.parse(sRows[0].model || "{}");
          if (p.id) timeline[sid].push({ time: 0, model: p.id, provider: p.providerID || "" });
        } catch {}
      }
    }

    const fb1Rows = sqlAll(
      db,
      `SELECT session_id, data FROM session_message
        WHERE (${needFallback.map(() => "session_id LIKE ? || '%'").join(" OR ")}) AND type = 'model-switched'
        ORDER BY session_id, json_extract(data, '$.time.created') ASC`,
      needFallback,
    );
    for (const r of fb1Rows) {
      let d = {};
      try { d = JSON.parse(r.data || "{}"); } catch {}
      const mi = d.model;
      if (!mi || !mi.id) continue;
      const time = d.time && d.time.created ? Number(d.time.created) : 0;
      const sid = matchSession(r.session_id);
      if (timeline[sid]) timeline[sid].push({ time, model: mi.id, provider: mi.providerID || "" });
    }

    const fb2Rows = sqlAll(
      db,
      `SELECT session_id, time_created, data FROM message
        WHERE (${needFallback.map(() => "session_id LIKE ? || '%'").join(" OR ")})
          AND json_extract(data, '$.role') = 'assistant'
        ORDER BY session_id, time_created ASC`,
      needFallback,
    );
    for (const r of fb2Rows) {
      let d = {};
      try { d = JSON.parse(r.data || "{}"); } catch {}
      const msgTime = Number(r.time_created) || 0;
      const sid = matchSession(r.session_id);
      const tl = timeline[sid] || [];
      let active = tl[0];
      for (const e of tl) { if (msgTime >= e.time) active = e; }
      if (!active) continue;
      const key = sid + "::" + active.model;
      if (!perModel[key]) { perModel[key] = { sessionId: sid, model: active.model, provider: active.provider || "", cost: 0 }; }
      perModel[key].cost += Number(d.cost) || 0;
    }
  }

  const switchedSet = new Set(switchedIds);
  const kept = [];
  const exchangeBySession = {};
  for (const ex of exchanges) {
    if (switchedSet.has(ex.sessionId)) {
      (exchangeBySession[ex.sessionId] = exchangeBySession[ex.sessionId] || []).push(ex);
    } else { kept.push(ex); }
  }
  for (const [sid, sessionExchanges] of Object.entries(exchangeBySession)) {
    const orig = sessionExchanges[0];
    const models = Object.values(perModel).filter((p) => p.sessionId === sid);
    const totalMsgCost = models.reduce((s, m) => s + m.cost, 0);
    if (totalMsgCost > 0) {
      for (const pm of models) {
        const ratio = pm.cost / totalMsgCost;
        kept.push({ ...orig, model: pm.model, modelClean: pm.model, provider: pm.provider, providerLabel: getProviderLabel(pm.provider), inputTokens: Math.round(orig.inputTokens * ratio), outputTokens: Math.round(orig.outputTokens * ratio), cacheReadInputTokens: Math.round(orig.cacheReadInputTokens * ratio), cacheCreationInputTokens: Math.round(orig.cacheCreationInputTokens * ratio), reasoningTokens: Math.round(orig.reasoningTokens * ratio), costUsd: orig.costUsd * ratio, costFromDb: orig.costUsd * ratio });
      }
    } else { kept.push(orig); }
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
    db = await openDb(home);
    if (!db) return { exchanges: [], summary: null };
  } catch { return { exchanges: [], summary: null }; }

  try {
    const sessionRows = sqlAll(db, "SELECT id, model, time_created, title, directory, project_id FROM session WHERE id = ?", [sessionId]);
    const sessionInfo = sessionRows.length > 0 ? sessionRows[0] : null;

    const msgRows = sqlAll(db, "SELECT id, session_id, time_created, data FROM message WHERE session_id LIKE ? || '%' ORDER BY time_created ASC, id ASC", [sessionId]);
    const messages = [];
    for (const row of msgRows) {
      let data = {};
      try { data = JSON.parse(row.data || "{}"); } catch {}
      messages.push({ id: row.id, sessionId: row.session_id, timeCreated: row.time_created, ...data });
    }

    const partRows = sqlAll(db, "SELECT id, message_id, session_id, time_created, data FROM part WHERE session_id LIKE ? || '%' ORDER BY time_created ASC, id ASC", [sessionId]);
    const partsMap = {};
    for (const row of partRows) {
      let data = {};
      try { data = JSON.parse(row.data || "{}"); } catch {}
      const mid = row.message_id;
      if (!partsMap[mid]) partsMap[mid] = [];
      partsMap[mid].push(data);
    }

    const exchanges = [];
    let current = null;
    let sessionModel = "", sessionProvider = "";
    if (sessionInfo && sessionInfo.model) {
      try { const parsed = JSON.parse(sessionInfo.model); sessionModel = parsed.id || parsed.model || ""; sessionProvider = parsed.providerID || ""; }
      catch { sessionModel = String(sessionInfo.model).trim(); }
    }

    for (const msg of messages) {
      const role = (msg.role || "").toLowerCase();
      const msgParts = partsMap[msg.id] || [];
      const textParts = msgParts.filter((p) => p.type === "text" && p.text);
      const toolParts = msgParts.filter((p) => p.type === "tool" && p.tool);
      const fileParts = msgParts.filter((p) => p.type === "file");
      const text = textParts.map((p) => p.text).join(" ").replace(/\s+/g, " ").trim().substring(0, 300);
      const tools = toolParts.map((p) => p.tool);
      const tokens = msg.tokens || {};
      const cost = msg.cost || 0;
      const ts = msg.timeCreated ? msToIso(msg.timeCreated) : "";

      const turnModel = msg.modelID || (msg.model && (msg.model.modelID || msg.model.id)) || sessionModel;
      const turnProvider = msg.providerID || (msg.model && msg.model.providerID) || msg.provider || sessionProvider;

      if (role === "user") {
        if (!text && fileParts.length === 0) continue;
        current = { promptPreview: text || "[files]", startedAt: ts, turnCount: 0, tokens: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, costEstimate: 0, tools: [], turns: [] };
        exchanges.push(current);
      } else if (role === "assistant") {
        const tInput = Number(tokens.input) || 0;
        const tOutput = Number(tokens.output) || 0;
        const tCacheRead = Number(tokens.cache?.read) || Number(tokens.cache_read) || 0;
        const tCacheWrite = Number(tokens.cache?.write) || Number(tokens.cache_write) || 0;
        const tReasoning = Number(tokens.reasoning) || 0;
        const turnTokens = { total: tInput + tOutput + tCacheRead + tCacheWrite + tReasoning, input: tInput, output: tOutput, cacheRead: tCacheRead, cacheWrite: tCacheWrite, reasoning: tReasoning };

        if (!current) {
          current = { promptPreview: "", startedAt: ts, turnCount: 0, tokens: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, costEstimate: 0, tools: [], turns: [] };
          exchanges.push(current);
        }

        const turnCost = cost || calculateExchangeCost(tInput, tOutput, tCacheRead, tCacheWrite, tReasoning, turnModel, turnProvider);
        current.turns.push({ tokens: turnTokens, costEstimate: turnCost, model: turnModel, provider: turnProvider, tools: tools });
        current.turnCount++;
        current.tokens.output += tOutput; current.tokens.cacheRead += tCacheRead; current.tokens.cacheWrite += tCacheWrite;
        current.tokens.reasoning += tReasoning; current.tokens.total += turnTokens.total; current.costEstimate += turnCost;
        if (tools.length > 0) current.tools.push(...tools);
      }
    }

    const rawExchanges = [];
    for (const msg of messages) {
      if ((msg.role || "").toLowerCase() !== "assistant") continue;
      const t = msg.tokens || {};
      const tInput = Number(t.input) || 0; const tOutput = Number(t.output) || 0;
      const tCacheRead = Number(t.cache?.read) || Number(t.cache_read) || 0;
      const tCacheWrite = Number(t.cache?.write) || Number(t.cache_write) || 0;
      const tReasoning = Number(t.reasoning) || 0; const msgCost = Number(msg.cost) || 0;
      if (tInput === 0 && tOutput === 0 && tCacheRead === 0 && tCacheWrite === 0 && tReasoning === 0 && msgCost === 0) continue;
      rawExchanges.push({ inputTokens: tInput, outputTokens: tOutput, cacheReadInputTokens: tCacheRead, cacheCreationInputTokens: tCacheWrite, reasoningTokens: tReasoning, costUsd: msgCost, model: msg.modelID || (sessionInfo && sessionInfo.model) || "" });
    }
    const { sumTokens } = require("../calculator");
    const summary = sumTokens(rawExchanges);
    return { exchanges, summary, found: exchanges.length > 0, sessionInfo };
  } catch { return { exchanges: [], summary: null }; }
  finally { dbClose(db); }
}

module.exports = { collectAll, readSessionDetail, opencodeDbPath };
