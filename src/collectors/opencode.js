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

const tmpDbs = new WeakMap();

async function openDb(home) {
  const dbPath = opencodeDbPath(home);
  if (!fs.existsSync(dbPath)) return null;
  const SQL = await getSqlJs();
  const buffer = fs.readFileSync(dbPath);
  const db = new SQL.Database(buffer);

  const walPath = dbPath + "-wal";
  if (fs.existsSync(walPath) && fs.statSync(walPath).mtimeMs > fs.statSync(dbPath).mtimeMs) {
    db.close();
    try {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tku-"));
      const tmpDb = path.join(tmpDir, "opencode.db");
      fs.copyFileSync(dbPath, tmpDb);
      fs.copyFileSync(walPath, tmpDb + "-wal");
      const shmPath = dbPath + "-shm";
      if (fs.existsSync(shmPath)) fs.copyFileSync(shmPath, tmpDb + "-shm");
      const walDb = new SQL.Database(tmpDb, { filename: true });
      tmpDbs.set(walDb, tmpDir);
      return walDb;
    } catch {
      return new SQL.Database(buffer);
    }
  }

  return db;
}

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

    const stmt = db.prepare(
      EXCHANGE_SQL + whereClause + " GROUP BY s.id ORDER BY s.time_created DESC",
    );
    if (params.length > 0) stmt.bind(params);

    while (stmt.step()) {
      const ex = rowToExchange(stmt.getAsObject());
      if (ex) exchanges.push(ex);
    }
    stmt.free();

    applyModelSwitchSplit(db, exchanges);
  } catch {
  } finally {
    try {
      if (db) {
        const tmpDir = tmpDbs.get(db);
        db.close();
        tmpDbs.delete(db);
        if (tmpDir) try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
      }
    } catch {}
  }

  return exchanges;
}

function applyModelSwitchSplit(db, exchanges) {
  const collectedIds = exchanges.map((e) => e.sessionId).filter(Boolean);
  if (collectedIds.length === 0) return;

  const placeholders = collectedIds.map(() => "?").join(",");
  const switchCheck = db.prepare(
    `SELECT DISTINCT session_id FROM session_message WHERE type = 'model-switched' AND session_id IN (${placeholders})`,
  );
  switchCheck.bind(collectedIds);
  const switchedIds = [];
  while (switchCheck.step()) {
    const r = switchCheck.getAsObject();
    if (r.session_id) switchedIds.push(r.session_id);
  }
  switchCheck.free();
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
  const st1 = db.prepare(`
    SELECT session_id, time_created, data FROM message
    WHERE (${likeList})
      AND json_extract(data, '$.role') = 'assistant'
      AND (json_extract(data, '$.modelID') IS NOT NULL OR json_extract(data, '$.model.modelID') IS NOT NULL)
    ORDER BY session_id, time_created ASC
  `);
  st1.bind(switchedIds);
  while (st1.step()) {
    const r = st1.getAsObject();
    let d = {};
    try {
      d = JSON.parse(r.data || "{}");
    } catch {}
    const mid = d.modelID || (d.model && (d.model.modelID || d.model.id)) || "";
    const provID = d.providerID || (d.model && d.model.providerID) || "";
    if (!mid) continue;
    const sid = matchSession(r.session_id);
    const key = sid + "::" + mid;
    if (!perModel[key]) {
      perModel[key] = {
        sessionId: sid,
        model: mid,
        provider: provID,
        cost: 0,
      };
    }
    perModel[key].cost += Number(d.cost) || 0;
  }
  st1.free();

  const needFallback = switchedIds.filter(
    (sid) => !Object.keys(perModel).some((k) => k.startsWith(sid + "::")),
  );
  if (needFallback.length > 0) {
    const timeline = {};
    for (const sid of needFallback) {
      timeline[sid] = [];
      const sRow = db.exec("SELECT model FROM session WHERE id = ?", [sid]);
      if (sRow.length > 0 && sRow[0].values.length > 0) {
        try {
          const p = JSON.parse(sRow[0].values[0][0] || "{}");
          if (p.id)
            timeline[sid].push({
              time: 0,
              model: p.id,
              provider: p.providerID || "",
            });
        } catch {}
      }
    }

    const fb1 = db.prepare(`
      SELECT session_id, data FROM session_message
      WHERE (${needFallback.map(() => "session_id LIKE ? || '%'").join(" OR ")}) AND type = 'model-switched'
      ORDER BY session_id, json_extract(data, '$.time.created') ASC
    `);
    fb1.bind(needFallback);
    while (fb1.step()) {
      const r = fb1.getAsObject();
      let d = {};
      try {
        d = JSON.parse(r.data || "{}");
      } catch {}
      const mi = d.model;
      if (!mi || !mi.id) continue;
      const time = d.time && d.time.created ? Number(d.time.created) : 0;
      const sid = matchSession(r.session_id);
      if (timeline[sid])
        timeline[sid].push({
          time,
          model: mi.id,
          provider: mi.providerID || "",
        });
    }
    fb1.free();

    const fb2 = db.prepare(`
      SELECT session_id, time_created, data FROM message
      WHERE (${needFallback.map(() => "session_id LIKE ? || '%'").join(" OR ")})
        AND json_extract(data, '$.role') = 'assistant'
      ORDER BY session_id, time_created ASC
    `);
    fb2.bind(needFallback);
    while (fb2.step()) {
      const r = fb2.getAsObject();
      let d = {};
      try {
        d = JSON.parse(r.data || "{}");
      } catch {}
      const msgTime = Number(r.time_created) || 0;
      const sid = matchSession(r.session_id);
      const tl = timeline[sid] || [];
      let active = tl[0];
      for (const e of tl) {
        if (msgTime >= e.time) active = e;
      }
      if (!active) continue;
      const key = sid + "::" + active.model;
      if (!perModel[key]) {
        perModel[key] = {
          sessionId: sid,
          model: active.model,
          provider: active.provider || "",
          cost: 0,
        };
      }
      perModel[key].cost += Number(d.cost) || 0;
    }
    fb2.free();
  }

  const switchedSet = new Set(switchedIds);
  const kept = [];
  const exchangeBySession = {};
  for (const ex of exchanges) {
    if (switchedSet.has(ex.sessionId)) {
      (exchangeBySession[ex.sessionId] =
        exchangeBySession[ex.sessionId] || []).push(ex);
    } else {
      kept.push(ex);
    }
  }
  for (const [sid, sessionExchanges] of Object.entries(exchangeBySession)) {
    const orig = sessionExchanges[0];
    const models = Object.values(perModel).filter((p) => p.sessionId === sid);
    const totalMsgCost = models.reduce((s, m) => s + m.cost, 0);
    if (totalMsgCost > 0) {
      for (const pm of models) {
        const ratio = pm.cost / totalMsgCost;
        kept.push({
          ...orig,
          model: pm.model,
          modelClean: pm.model,
          provider: pm.provider,
          providerLabel: getProviderLabel(pm.provider),
          inputTokens: Math.round(orig.inputTokens * ratio),
          outputTokens: Math.round(orig.outputTokens * ratio),
          cacheReadInputTokens: Math.round(orig.cacheReadInputTokens * ratio),
          cacheCreationInputTokens: Math.round(
            orig.cacheCreationInputTokens * ratio,
          ),
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
      SELECT id, model, time_created, title, directory, project_id
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
      WHERE session_id LIKE ? || '%'
      ORDER BY time_created ASC, id ASC
    `);
    msgStmt.bind([sessionId]);

    const messages = [];
    while (msgStmt.step()) {
      const row = msgStmt.getAsObject();
      let data = {};
      try {
        data = JSON.parse(row.data || "{}");
      } catch {}
      messages.push({
        id: row.id,
        sessionId: row.session_id,
        timeCreated: row.time_created,
        ...data,
      });
    }
    msgStmt.free();

    const partStmt = db.prepare(`
      SELECT id, message_id, session_id, time_created, data
      FROM part
      WHERE session_id LIKE ? || '%'
      ORDER BY time_created ASC, id ASC
    `);
    partStmt.bind([sessionId]);

    const partsMap = {};
    while (partStmt.step()) {
      const row = partStmt.getAsObject();
      let data = {};
      try {
        data = JSON.parse(row.data || "{}");
      } catch {}
      const mid = row.message_id;
      if (!partsMap[mid]) partsMap[mid] = [];
      partsMap[mid].push(data);
    }
    partStmt.free();

    const exchanges = [];
    let current = null;
    let sessionModel = "",
      sessionProvider = "";
    if (sessionInfo && sessionInfo.model) {
      try {
        const parsed = JSON.parse(sessionInfo.model);
        sessionModel = parsed.id || parsed.model || "";
        sessionProvider = parsed.providerID || "";
      } catch {
        sessionModel = String(sessionInfo.model).trim();
      }
    }

    for (const msg of messages) {
      const role = (msg.role || "").toLowerCase();
      const msgParts = partsMap[msg.id] || [];
      const textParts = msgParts.filter((p) => p.type === "text" && p.text);
      const toolParts = msgParts.filter((p) => p.type === "tool" && p.tool);
      const fileParts = msgParts.filter((p) => p.type === "file");
      const text = textParts
        .map((p) => p.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
        .substring(0, 300);
      const tools = toolParts.map((p) => p.tool);
      const tokens = msg.tokens || {};
      const cost = msg.cost || 0;
      const ts = msg.timeCreated ? msToIso(msg.timeCreated) : "";

      const turnModel =
        msg.modelID ||
        (msg.model && (msg.model.modelID || msg.model.id)) ||
        sessionModel;
      const turnProvider =
        msg.providerID ||
        (msg.model && msg.model.providerID) ||
        msg.provider ||
        sessionProvider;

      if (role === "user") {
        if (!text && fileParts.length === 0) continue;
        current = {
          promptPreview: text || "[files]",
          startedAt: ts,
          turnCount: 0,
          tokens: {
            total: 0,
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            reasoning: 0,
          },
          costEstimate: 0,
          tools: [],
          turns: [],
        };
        exchanges.push(current);
      } else if (role === "assistant") {
        const tInput = Number(tokens.input) || 0;
        const tOutput = Number(tokens.output) || 0;
        const tCacheRead =
          Number(tokens.cache?.read) || Number(tokens.cache_read) || 0;
        const tCacheWrite =
          Number(tokens.cache?.write) || Number(tokens.cache_write) || 0;
        const tReasoning = Number(tokens.reasoning) || 0;
        const turnTokens = {
          total: tInput + tOutput + tCacheRead + tCacheWrite + tReasoning,
          input: tInput,
          output: tOutput,
          cacheRead: tCacheRead,
          cacheWrite: tCacheWrite,
          reasoning: tReasoning,
        };

        if (!current) {
          current = {
            promptPreview: "",
            startedAt: ts,
            turnCount: 0,
            tokens: {
              total: 0,
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              reasoning: 0,
            },
            costEstimate: 0,
            tools: [],
            turns: [],
          };
          exchanges.push(current);
        }

        const turnCost =
          cost ||
          calculateExchangeCost(
            tInput,
            tOutput,
            tCacheRead,
            tCacheWrite,
            tReasoning,
            turnModel,
            turnProvider,
          );
        current.turns.push({
          tokens: turnTokens,
          costEstimate: turnCost,
          model: turnModel,
          provider: turnProvider,
          tools: tools,
        });
        current.turnCount++;
        current.tokens.output += tOutput;
        current.tokens.cacheRead += tCacheRead;
        current.tokens.cacheWrite += tCacheWrite;
        current.tokens.reasoning += tReasoning;
        current.tokens.total += turnTokens.total;
        current.costEstimate += turnCost;
        if (tools.length > 0) current.tools.push(...tools);
      }
    }

    const rawExchanges = [];
    for (const msg of messages) {
      if ((msg.role || "").toLowerCase() !== "assistant") continue;
      const t = msg.tokens || {};
      const tInput = Number(t.input) || 0;
      const tOutput = Number(t.output) || 0;
      const tCacheRead = Number(t.cache?.read) || Number(t.cache_read) || 0;
      const tCacheWrite = Number(t.cache?.write) || Number(t.cache_write) || 0;
      const tReasoning = Number(t.reasoning) || 0;
      const msgCost = Number(msg.cost) || 0;
      if (
        tInput === 0 &&
        tOutput === 0 &&
        tCacheRead === 0 &&
        tCacheWrite === 0 &&
        tReasoning === 0 &&
        msgCost === 0
      )
        continue;
      rawExchanges.push({
        inputTokens: tInput,
        outputTokens: tOutput,
        cacheReadInputTokens: tCacheRead,
        cacheCreationInputTokens: tCacheWrite,
        reasoningTokens: tReasoning,
        costUsd: msgCost,
        model: msg.modelID || (sessionInfo && sessionInfo.model) || "",
      });
    }

    const { sumTokens } = require("../calculator");
    const summary = sumTokens(rawExchanges);

    return { exchanges, summary, found: exchanges.length > 0, sessionInfo };
  } catch {
    return { exchanges: [], summary: null };
  } finally {
    try {
      if (db) db.close();
    } catch {}
  }
}

module.exports = { collectAll, readSessionDetail, opencodeDbPath };
