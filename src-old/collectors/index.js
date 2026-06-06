'use strict';

const { buildAggregate } = require('../calculator');
const claudeCollector = require('./claude');
const codexCollector = require('./codex');
const opencodeCollector = require('./opencode');

const COLLECTORS = {
  claude: { collect: claudeCollector.collect, label: 'Claude Code' },
  codex: { collect: codexCollector.collect, label: 'Codex' },
  opencode: { collect: opencodeCollector.collect, label: 'OpenCode', readDetail: opencodeCollector.readSessionDetail }
};

function normalizeClientsList(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

async function collectAll({ clients, period, allTimeSince, homeDir }) {
  const enabled = new Set(normalizeClientsList(clients));
  const results = {};
  const allExchanges = [];
  const allSessions = new Set();

  const promises = [];
  for (const [key, collector] of Object.entries(COLLECTORS)) {
    if (enabled.size > 0 && !enabled.has(key)) continue;
    const p = Promise.resolve().then(async () => {
      try {
        const result = await collector.collect({ period, allTimeSince, homeDir });
        results[key] = result;
        allExchanges.push(...(result.exchanges || []));
        for (const s of (result.sessions || [])) allSessions.add(s);
      } catch (err) {
        results[key] = { client: key, label: collector.label, exchanges: [], sessions: [], error: err.message };
      }
    });
    promises.push(p);
  }

  await Promise.all(promises);

  const aggregated = buildAggregate(results);

  return {
    period,
    clients: results,
    aggregated,
    totalExchanges: allExchanges.length,
    totalSessions: allSessions.size
  };
}

async function collectAllPeriods({ clients, allTimeSince, homeDir }) {
  const todayData = await collectAll({ clients, period: 'today', allTimeSince, homeDir });
  const monthData = await collectAll({ clients, period: 'month', allTimeSince, homeDir });
  const allTimeData = await collectAll({ clients, period: 'allTime', allTimeSince, homeDir });
  return { today: todayData, month: monthData, allTime: allTimeData };
}

async function collectSessionDetail({ sessionId, client, allTimeSince, homeDir }) {
  const collector = COLLECTORS[client];
  if (collector && typeof collector.readDetail === 'function') {
    return await collector.readDetail({ sessionId, homeDir });
  }

  const allData = await collectAll({ clients: client || '', period: 'allTime', allTimeSince, homeDir });
  const clientData = allData.clients[client];
  if (!clientData) {
    console.log('[CSD] no clientData for:', client);
    return { exchanges: [], summary: null };
  }

  const sessionExchanges = (clientData.exchanges || []).filter((ex) => {
    return ex.sessionId === sessionId;
  });

  const { sumTokens } = require('../calculator');
  const summary = sumTokens(sessionExchanges);

  // Group raw exchanges into prompt-response pairs (Token Monitor format)
  const sorted = [...sessionExchanges].sort((a, b) =>
    (a.timestamp || '').localeCompare(b.timestamp || '')
  );

  const exchanges = [];
  let current = null;

  function mkTurnTokens(ex) {
    return {
      total: (ex.outputTokens || 0) + (ex.cacheReadInputTokens || 0) + (ex.cacheCreationInputTokens || 0) + (ex.reasoningTokens || 0),
      input: 0,
      output: ex.outputTokens || 0,
      cacheRead: ex.cacheReadInputTokens || 0,
      cacheWrite: ex.cacheCreationInputTokens || 0,
      reasoning: ex.reasoningTokens || 0
    };
  }

  for (const ex of sorted) {
    const role = (ex.role || ex.type || '').toLowerCase();
    if (role === 'user') {
      // Skip tool_result user messages (system-injected, no content preview)
      if (!ex.contentPreview) continue;
      current = {
        promptPreview: ex.contentPreview || '',
        startedAt: ex.timestamp || '',
        turnCount: 0,
        tokens: {
          total: (ex.inputTokens || 0) + (ex.cacheReadInputTokens || 0) + (ex.cacheCreationInputTokens || 0),
          input: ex.inputTokens || 0,
          output: 0,
          cacheRead: ex.cacheReadInputTokens || 0,
          cacheWrite: ex.cacheCreationInputTokens || 0,
          reasoning: 0
        },
        costEstimate: 0,
        tools: [],
        turns: []
      };
      exchanges.push(current);
    } else if (role === 'assistant') {
      if (!current) {
        // Orphan assistant — start a new exchange
        const t = mkTurnTokens(ex);
        current = {
          promptPreview: '',
          startedAt: ex.timestamp || '',
          turnCount: 0,
          tokens: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
          costEstimate: 0,
          tools: [],
          turns: []
        };
        exchanges.push(current);
      }
      const turnTokens = mkTurnTokens(ex);
      current.turns.push({
        tokens: turnTokens,
        costEstimate: ex.costUsd || 0,
        tools: ex.tools || []
      });
      current.turnCount++;
      current.tokens.output += turnTokens.output;
      current.tokens.cacheRead += turnTokens.cacheRead;
      current.tokens.cacheWrite += turnTokens.cacheWrite;
      current.tokens.reasoning += turnTokens.reasoning;
      current.tokens.total += turnTokens.total;
      current.costEstimate += ex.costUsd || 0;
      if (ex.tools) current.tools.push(...ex.tools);
    } else {
      // Flat exchange (OpenCode session, Codex token_count, etc.) — standalone with one turn
      const t = mkTurnTokens(ex);
      exchanges.push({
        promptPreview: ex.contentPreview || ex.sessionTitle || '',
        startedAt: ex.timestamp || '',
        turnCount: 1,
        tokens: {
          total: t.total + (ex.inputTokens || 0) + (ex.cacheReadInputTokens || 0) + (ex.cacheCreationInputTokens || 0),
          input: ex.inputTokens || 0,
          output: t.output,
          cacheRead: t.cacheRead + (ex.cacheReadInputTokens || 0),
          cacheWrite: t.cacheWrite + (ex.cacheCreationInputTokens || 0),
          reasoning: t.reasoning
        },
        costEstimate: ex.costUsd || 0,
        tools: ex.tools || [],
        turns: [{ tokens: t, costEstimate: ex.costUsd || 0, tools: ex.tools || [] }]
      });
    }
  }

  return { exchanges, summary, found: exchanges.length > 0 };
}

module.exports = { collectAll, collectAllPeriods, collectSessionDetail, normalizeClientsList, COLLECTORS };
