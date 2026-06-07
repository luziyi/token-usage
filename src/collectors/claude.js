const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { calculateExchangeCost } = require('../calculator');

const fileCache = new Map();

function extractUserText(entry) {
  if (!entry) return '';

  // entry.message.content — Anthropic API content blocks
  const msg = entry.message;
  if (msg && typeof msg === 'object') {
    if (typeof msg.content === 'string') return msg.content.replace(/\s+/g, ' ').trim();
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block && typeof block === 'object') {
          if (block.type === 'text' && block.text) return block.text.replace(/\s+/g, ' ').trim();
          // Some formats store text directly
          if (block.text && !block.type) return block.text.replace(/\s+/g, ' ').trim();
        }
      }
    }
    // msg itself is the text (entry.message = "text")
    if (typeof msg === 'string') return msg.replace(/\s+/g, ' ').trim();
  }

  // entry.text — text directly on the entry
  if (typeof entry.text === 'string') return entry.text.replace(/\s+/g, ' ').trim();

  // entry.content — content directly on the entry
  if (typeof entry.content === 'string') return entry.content.replace(/\s+/g, ' ').trim();

  return '';
}

// System/internal messages to exclude from user-facing display
function isUserGenerated(text) {
  if (!text || text.trim().length === 0) return false;
  // Starts with /command, <tag>, [system], ```code block — skip
  if (/^[/<\[`]/.test(text)) return false;
  return true;
}

function claudeProjectsDir(home) {
  const dir = home || os.homedir();
  return path.join(dir, '.claude', 'projects');
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
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
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

function providerFromModel(modelId) {
  if (!modelId) return '';
  const id = modelId.toLowerCase();
  if (id.includes('deepseek')) return 'deepseek';
  if (id.includes('claude') || id.includes('anthropic')) return 'anthropic';
  if (id.includes('gpt') || id.includes('o3') || id.includes('o4') || id.includes('openai')) return 'openai';
  if (id.includes('gemini') || id.includes('google')) return 'google';
  if (id.includes('qwen')) return 'qwen';
  if (id.includes('minimax')) return 'minimax';
  if (id.includes('meta') || id.includes('llama')) return 'meta';
  return '';
}

function findSessionFiles(home) {
  const dataDir = claudeProjectsDir(home);
  const files = [];
  try {
    if (!fs.existsSync(dataDir)) return files;
    const projectDirs = fs.readdirSync(dataDir, { withFileTypes: true });
    for (const dir of projectDirs) {
      if (!dir.isDirectory()) continue;
      const projectPath = path.join(dataDir, dir.name);
      try {
        const entries = fs.readdirSync(projectPath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile() && entry.name.endsWith('.jsonl')) {
            files.push({ filePath: path.join(projectPath, entry.name), projectDir: dir.name });

            // Look for subagent files in matching session directory
            const sessionDirName = entry.name.slice(0, -6);
            const subagentDir = path.join(projectPath, sessionDirName, 'subagents');
            try {
              if (fs.existsSync(subagentDir)) {
                const subEntries = fs.readdirSync(subagentDir, { withFileTypes: true });
                for (const subEntry of subEntries) {
                  if (subEntry.isFile() && subEntry.name.startsWith('agent-') && subEntry.name.endsWith('.jsonl')) {
                    files.push({ filePath: path.join(subagentDir, subEntry.name), projectDir: dir.name });
                  }
                }
              }
            } catch {}
          }
        }
      } catch {}
    }
  } catch {}
  return files;
}

function findSessionFileById(sessionId, home) {
  const dataDir = claudeProjectsDir(home);
  try {
    const projectDirs = fs.readdirSync(dataDir, { withFileTypes: true });
    for (const dir of projectDirs) {
      if (!dir.isDirectory()) continue;
      const candidate = path.join(dataDir, dir.name, sessionId + '.jsonl');
      if (fs.existsSync(candidate)) {
        return { filePath: candidate, projectDir: dir.name };
      }
    }
  } catch {}
  return null;
}

function readMetaFile(filePath) {
  const metaPath = filePath.replace(/\.jsonl$/, '.meta.json');
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    return null;
  }
}

function parseSessionFile(filePath, projectDir) {
  let sessionId = '';
  let cwd = '';
  let firstTimestamp = 0;
  let agentId = '';
  let firstUserMessage = '';
  const assistantMessages = [];

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    const seenIds = new Set();

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (!entry.sessionId) continue;
        sessionId = entry.sessionId;

        if (entry.cwd) cwd = entry.cwd;
        if (entry.agentId && !agentId) agentId = entry.agentId;

        if (entry.timestamp && !firstTimestamp) {
          firstTimestamp = new Date(entry.timestamp).getTime();
        }

        if (entry.type === 'assistant' && entry.message && !entry.error) {
          const msg = entry.message;
          const model = msg.model || '';
          const usage = msg.usage || {};

          if (model === '<synthetic>' || !model) continue;

          const inputTokens = Number(usage.input_tokens) || 0;
          const outputTokens = Number(usage.output_tokens) || 0;
          const cacheRead = Number(usage.cache_read_input_tokens) || 0;
          const cacheWrite = Number(usage.cache_creation_input_tokens) || 0;

          if (inputTokens === 0 && outputTokens === 0 && cacheRead === 0 && cacheWrite === 0) continue;

          const dedupId = msg.id || entry.uuid || '';
          if (dedupId && seenIds.has(dedupId)) continue;
          if (dedupId) seenIds.add(dedupId);

          assistantMessages.push({
            model,
            inputTokens,
            outputTokens,
            cacheRead,
            cacheWrite,
            reasoningTokens: 0,
            timeCreated: new Date(entry.timestamp || firstTimestamp || Date.now()).getTime(),
          });
        }

        if (!firstUserMessage && entry.type === 'user' && !entry.isMeta) {
          const text = extractUserText(entry);
          if (text && isUserGenerated(text)) firstUserMessage = text.substring(0, 120);
        }
      } catch {}
    }
  } catch {}

  if (!sessionId || assistantMessages.length === 0) return null;

  const modelGroups = {};
  for (const msg of assistantMessages) {
    if (!modelGroups[msg.model]) {
      modelGroups[msg.model] = {
        inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0,
        firstTime: msg.timeCreated, count: 0,
      };
    }
    const g = modelGroups[msg.model];
    g.inputTokens += msg.inputTokens;
    g.outputTokens += msg.outputTokens;
    g.cacheRead += msg.cacheRead;
    g.cacheWrite += msg.cacheWrite;
    g.reasoningTokens += msg.reasoningTokens;
    if (msg.timeCreated < g.firstTime) g.firstTime = msg.timeCreated;
    g.count++;
  }

  const ts = msToIso(firstTimestamp);

  return {
    sessionId,
    projectDir,
    ts,
    dateKey: getDateKey(ts),
    timeCreated: firstTimestamp || Date.now(),
    cwd,
    modelGroups,
    sessionTitle: firstUserMessage || '',
    rawMessages: assistantMessages,
    filePath,
    agentId,
  };
}

function parseSessionFileCached(filePath, projectDir) {
  try {
    const stat = fs.statSync(filePath);
    const cached = fileCache.get(filePath);
    if (cached && cached.mtime === stat.mtimeMs) {
      return cached.data;
    }
    const data = parseSessionFile(filePath, projectDir);
    if (data) {
      fileCache.set(filePath, { mtime: stat.mtimeMs, data });
    }
    return data;
  } catch {
    return null;
  }
}

function clearCache() {
  fileCache.clear();
}

function readStatsCacheModels(homeDir) {
  const home = homeDir || os.homedir();
  const cachePath = path.join(home, '.claude', 'stats-cache.json');
  const exchanges = [];

  try {
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const modelUsage = cache.modelUsage || {};
    const firstDate = cache.firstSessionDate || cache.lastComputedDate;
    if (!firstDate) return exchanges;

    const timeCreated = new Date(firstDate).getTime();
    const ts = msToIso(timeCreated);

    for (const [model, data] of Object.entries(modelUsage)) {
      const inputTokens = Number(data.inputTokens) || 0;
      const outputTokens = Number(data.outputTokens) || 0;
      const cacheRead = Number(data.cacheReadInputTokens) || 0;
      const cacheWrite = Number(data.cacheCreationInputTokens) || 0;

      if (inputTokens === 0 && outputTokens === 0 && cacheRead === 0 && cacheWrite === 0) continue;

      const provider = providerFromModel(model);
      const dateLabel = firstDate ? ' (截至' + firstDate + ')' : '';
      exchanges.push({
        inputTokens,
        outputTokens,
        cacheReadInputTokens: cacheRead,
        cacheCreationInputTokens: cacheWrite,
        reasoningTokens: 0,
        model,
        modelClean: model,
        provider,
        providerLabel: getProviderLabel(provider),
        sessionId: 'stats-cache-' + model.replace(/[^a-z0-9]/gi, '-'),
        timestamp: ts,
        dateKey: getDateKey(ts),
        timeCreated,
        costUsd: 0,
        costFromDb: 0,
        sessionTitle: model + dateLabel,
        dirName: '',
        projectId: '',
        source: 'claude-code',
        agentId: '',
        agentType: '',
        agentLabel: '',
      });
    }
  } catch {}

  return exchanges;
}

async function readAllExchanges({ homeDir }) {
  const home = homeDir || os.homedir();
  const files = findSessionFiles(home);
  const exchanges = [];

  for (const { filePath, projectDir } of files) {
    const session = parseSessionFileCached(filePath, projectDir);
    if (!session) continue;

    // Determine agent info and title
    const isSubagent = Boolean(session.agentId);
    const agentId = session.agentId || '';
    let agentType = '';
    let agentLabel = '';

    const meta = readMetaFile(filePath);
    let sessionTitle = '';

    if (isSubagent) {
      agentType = (meta && meta.agentType) || '';
      agentLabel = agentType || agentId.replace('agent-', '').substring(0, 8);
    } else {
      agentType = '';
      agentLabel = '主代理';
      // Use meta title, or first user message, or empty
      sessionTitle = (meta && meta.title) || session.sessionTitle || '';
    }

    for (const [model, tokens] of Object.entries(session.modelGroups)) {
      const provider = providerFromModel(model);
      exchanges.push({
        inputTokens: tokens.inputTokens,
        outputTokens: tokens.outputTokens,
        cacheReadInputTokens: tokens.cacheRead,
        cacheCreationInputTokens: tokens.cacheWrite,
        reasoningTokens: tokens.reasoningTokens,
        model,
        modelClean: model,
        provider,
        providerLabel: getProviderLabel(provider),
        sessionId: session.sessionId,
        timestamp: session.ts,
        dateKey: session.dateKey,
        timeCreated: tokens.firstTime,
        costUsd: 0,
        costFromDb: 0,
        sessionTitle,
        dirName: session.cwd || session.projectDir,
        projectId: session.projectDir,
        agentId,
        agentType,
        agentLabel,
        source: 'claude-code',
      });
    }
  }

  return exchanges;
}

async function collect({ period, allTimeSince, homeDir }) {
  const allExchanges = await readAllExchanges({ homeDir });
  const filtered = filterByPeriod(allExchanges, period, allTimeSince);
  const seenSessions = new Set(filtered.map((e) => e.sessionId).filter(Boolean));
  return { exchanges: filtered, sessions: Array.from(seenSessions) };
}

async function collectAll({ allTimeSince, homeDir }) {
  const exchanges = await readAllExchanges({ homeDir });
  if (!allTimeSince) return exchanges;
  const since = new Date(allTimeSince).getTime();
  if (Number.isNaN(since)) return exchanges;
  return exchanges.filter((e) => e.timeCreated >= since);
}

function filterByPeriod(exchanges, period, allTimeSince) {
  if (!period || period === 'allTime') {
    if (allTimeSince) {
      const since = new Date(allTimeSince).getTime();
      if (!Number.isNaN(since)) return exchanges.filter((e) => e.timeCreated >= since);
    }
    return exchanges;
  }

  let startMs;
  if (period === 'today') {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    startMs = todayStart.getTime();
  } else if (period === 'month') {
    const d = new Date();
    startMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  } else {
    return exchanges;
  }

  return exchanges.filter((e) => e.timeCreated >= startMs);
}

async function readSessionDetail({ sessionId, homeDir }) {
  const home = homeDir || os.homedir();
  const found = findSessionFileById(sessionId, home);
  if (!found) return { exchanges: [], summary: null, found: false };

  const { filePath, projectDir } = found;
  let sessionInfo = null;
  const allMessages = [];

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    const seenAssistantIds = new Set();

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);

        if (!sessionInfo && entry.sessionId) {
          sessionInfo = {
            id: entry.sessionId,
            time_created: entry.timestamp || '',
            model: '',
            title: '',
            directory: entry.cwd || '',
            project_id: projectDir,
          };
        }

        if (entry.type === 'user' && !entry.isMeta) {
          const text = extractUserText(entry).substring(0, 300);
          // Skip system messages and commands (e.g. /resume, <command-name>, [interrupted])
          if (!text || !isUserGenerated(text)) continue;
          allMessages.push({
            type: 'user',
            text,
            timestamp: entry.timestamp || '',
            uuid: entry.uuid,
          });
        }

        if (entry.type === 'assistant' && entry.message && !entry.error) {
          const msg = entry.message;
          const model = msg.model || '';
          const usage = msg.usage || {};

          if (model === '<synthetic>' || !model) continue;

          const dedupId = msg.id || entry.uuid || '';
          if (dedupId && seenAssistantIds.has(dedupId)) continue;
          if (dedupId) seenAssistantIds.add(dedupId);

          const inputTokens = Number(usage.input_tokens) || 0;
          const outputTokens = Number(usage.output_tokens) || 0;
          const cacheRead = Number(usage.cache_read_input_tokens) || 0;
          const cacheWrite = Number(usage.cache_creation_input_tokens) || 0;

          allMessages.push({
            type: 'assistant',
            model,
            inputTokens,
            outputTokens,
            cacheRead,
            cacheWrite,
            reasoningTokens: 0,
            timestamp: entry.timestamp || '',
            uuid: entry.uuid,
          });
        }
      } catch {}
    }
  } catch {}

  const exchanges = [];
  let current = null;

  for (const msg of allMessages) {
    if (msg.type === 'user') {
      if (current) exchanges.push(current);
      current = {
        promptPreview: msg.text || '',
        startedAt: msg.timestamp,
        turnCount: 0,
        tokens: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        costEstimate: 0,
        tools: [],
        turns: [],
      };
    } else if (msg.type === 'assistant') {
      if (!current) {
        // Assistant message without a preceding user message
        current = {
          promptPreview: '',
          startedAt: msg.timestamp,
          turnCount: 0,
          tokens: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
          costEstimate: 0,
          tools: [],
          turns: [],
        };
      }
      const turnTokens = {
        total: msg.inputTokens + msg.outputTokens + msg.cacheRead + msg.cacheWrite + msg.reasoningTokens,
        input: msg.inputTokens,
        output: msg.outputTokens,
        cacheRead: msg.cacheRead,
        cacheWrite: msg.cacheWrite,
        reasoning: msg.reasoningTokens,
      };
      if (msg.model && !current.modelName) current.modelName = msg.model;
      const turnCost = calculateExchangeCost(msg.inputTokens, msg.outputTokens, msg.cacheRead, msg.cacheWrite, msg.reasoningTokens, msg.model, '');
      current.turns.push({ tokens: turnTokens, costEstimate: turnCost, model: msg.model || '', tools: [] });
      current.turnCount++;
      current.tokens.total += turnTokens.total;
      current.tokens.input += turnTokens.input;
      current.tokens.output += turnTokens.output;
      current.tokens.cacheRead += turnTokens.cacheRead;
      current.tokens.cacheWrite += turnTokens.cacheWrite;
      current.tokens.reasoning += turnTokens.reasoning;
      current.costEstimate += turnCost;
    }
  }
  if (current) exchanges.push(current);

  const { sumTokens } = require('../calculator');
  const rawExchangeMap = {};
  for (const msg of allMessages) {
    if (msg.type === 'assistant') {
      const key = msg.model;
      if (!rawExchangeMap[key]) {
        rawExchangeMap[key] = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 0, model: key, provider: providerFromModel(key), costUsd: 0 };
      }
      const r = rawExchangeMap[key];
      r.inputTokens += msg.inputTokens;
      r.outputTokens += msg.outputTokens;
      r.cacheReadInputTokens += msg.cacheRead;
      r.cacheCreationInputTokens += msg.cacheWrite;
      r.reasoningTokens += msg.reasoningTokens;
    }
  }
  const rawExchanges = Object.values(rawExchangeMap);
  const summary = sumTokens(rawExchanges);

  return { exchanges, summary, found: exchanges.length > 0, sessionInfo };
}

module.exports = { collect, collectAll, readSessionDetail, clearCache };
