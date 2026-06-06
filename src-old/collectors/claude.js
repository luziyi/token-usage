'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/*
 * Claude Code Collector
 *
 * Reads JSONL files from ~/.claude/projects/
 * Token data is in `type: "assistant"` lines → message.usage:
 *   input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens
 * Model name: message.model
 */

function claudeDataDirs(home) {
  const projects = path.join(home, '.claude', 'projects');
  const transcripts = path.join(home, '.claude', 'transcripts');
  const dirs = [];
  try { if (fs.statSync(projects).isDirectory()) dirs.push(projects); } catch {}
  try { if (fs.statSync(transcripts).isDirectory()) dirs.push(transcripts); } catch {}
  return dirs;
}

function* walkJsonlFiles(dir) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        yield { dir, name: entry.name, filePath: path.join(dir, entry.name) };
      } else if (entry.isDirectory()) {
        yield* walkJsonlFiles(path.join(dir, entry.name));
      }
    }
  } catch {}
}

function isWithinPeriod(ts, period, allTimeSince) {
  if (!ts) return period === 'allTime'; // only show untimestamped in TOTAL
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

function extractSessionId(obj, fallbackName, dirPath) {
  const id = obj.sessionId || obj.session_id || '';
  if (id) return id;
  const dirName = path.basename(dirPath);
  if (dirName && dirName !== '.' && dirName.length > 8) return dirName;
  return fallbackName || '';
}

function extractSessionTitle(obj, contentPreview) {
  // Use first user text message as title
  if (obj.message?.content) {
    const parts = Array.isArray(obj.message.content) ? obj.message.content : [obj.message.content];
    for (const part of parts) {
      if (part.type === 'text' && part.text) {
        const t = part.text.replace(/\n/g, ' ').trim();
        if (t.length > 20) return t.substring(0, 80);
        if (t.length > 0) return t;
      }
    }
  }
  return '';
}

function extractTools(msg) {
  if (!msg || !msg.content) return [];
  const parts = Array.isArray(msg.content) ? msg.content : [msg.content];
  return parts.filter(p => p && p.type === 'tool_use' && p.name).map(p => p.name);
}

function parseExchange(line, sessionId, dirPath) {
  try {
    const obj = JSON.parse(line);
    if (typeof obj !== 'object' || obj === null) return null;

    const type = obj.type || '';
    const msg = obj.message;

    if (!msg || typeof msg !== 'object') return null;

    // Assistant messages must have usage; user messages may not
    const usage = msg.usage;
    const isAssistant = type === 'assistant';
    const isUser = type === 'user';

    if (isAssistant && (!usage || typeof usage !== 'object')) return null;

    const inputTokens = usage ? Number(usage.input_tokens) || 0 : 0;
    const outputTokens = usage ? Number(usage.output_tokens) || 0 : 0;
    const cacheRead = usage ? Number(usage.cache_read_input_tokens) || 0 : 0;
    const cacheWrite = usage ? Number(usage.cache_creation_input_tokens) || 0 : 0;
    const reasoningTokens = usage ? Number(usage.reasoning_output_tokens) || Number(usage.reasoning_tokens) || 0 : 0;

    // Skip assistant messages with no token data; keep user messages for content preview
    if (isAssistant && inputTokens === 0 && outputTokens === 0 && cacheRead === 0 && cacheWrite === 0) return null;

    const model = msg.model || '';
    const sid = extractSessionId(obj, sessionId, dirPath);
    const ts = obj.timestamp || '';

    return {
      inputTokens,
      outputTokens,
      cacheReadInputTokens: cacheRead,
      cacheCreationInputTokens: cacheWrite,
      reasoningTokens,
      model: model || 'claude',
      sessionId: sid,
      timestamp: ts,
      sessionTitle: extractSessionTitle(obj, ''),
      type,
      role: msg.role || type,
      contentPreview: extractContentPreview(msg),
      tools: extractTools(msg),
      dirPath,
    };
  } catch {
    return null;
  }
}

function extractContentPreview(msg) {
  if (!msg || !msg.content) return '';
  // Handle string content (first user message in Claude Code JSONL)
  if (typeof msg.content === 'string') {
    return msg.content.replace(/\n/g, ' ').trim().substring(0, 200);
  }
  const parts = Array.isArray(msg.content) ? msg.content : [msg.content];
  for (const part of parts) {
    if (part && part.type === 'text' && part.text) {
      return part.text.substring(0, 200);
    }
    if (part && part.type === 'tool_use' && part.name) {
      return `[tool_use: ${part.name}]`;
    }
    if (part && part.type === 'thinking' && part.thinking) {
      return '[thinking...]';
    }
  }
  return '';
}

function extractFirstUserMessage(lines) {
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'user' && obj.message?.content) {
        const parts = Array.isArray(obj.message.content) ? obj.message.content : [obj.message.content];
        for (const part of parts) {
          if (part.type === 'text' && part.text) {
            const t = part.text.replace(/\n/g, ' ').trim();
            // Skip system-generated messages
            if (t.startsWith('<ide_opened_file>') || t.startsWith('[Request interrupted') || t.startsWith('Base directory for')) continue;
            if (t.length > 20) return t.substring(0, 100);
            if (t.length > 0) return t;
          }
        }
      }
    } catch {}
  }
  return '';
}

function decodeClaudeDirName(raw) {
  // Claude encodes Windows paths like: C--Users-Ryanclawer, e----, e---------, E--WiseWeldCV
  // Format: drive + -- + path_segments (separated by -)
  // Chinese chars are encoded as multiple hyphens per UTF-8 byte
  if (!raw || raw.length < 2) return '';
  const idx = raw.indexOf('--');
  if (idx === -1) return raw;
  const drive = raw[0].toUpperCase() + ':/';
  const rest = raw.slice(idx + 2);
  if (!rest) return drive;
  // Split remaining hyphens as path segments, but filter out pure-hyphen segments (Chinese chars)
  const segments = rest.split('-').filter(s => s && !/^-+$/.test(s));
  return segments.length > 0 ? drive + segments.join('/') : drive;
}

function sessionDirName(dirPath) {
  const name = path.basename(dirPath);
  return decodeClaudeDirName(name);
}

function collect({ period, allTimeSince, homeDir }) {
  const home = homeDir || os.homedir();
  const dirs = claudeDataDirs(home);
  const exchanges = [];
  const seenSessions = new Set();
  const sessionTitles = {};

  for (const dir of dirs) {
    for (const entry of walkJsonlFiles(dir)) {
      const fileSessionId = path.basename(entry.name, '.jsonl');
      try {
        const content = fs.readFileSync(entry.filePath, 'utf8');
        const lines = content.split(/\r?\n/).filter(Boolean);
        const title = extractFirstUserMessage(lines) || sessionDirName(entry.dir);
        const dirName = sessionDirName(entry.dir);

        for (const line of lines) {
          const exchange = parseExchange(line, fileSessionId, entry.dir);
          if (!exchange) continue;
          if (!isWithinPeriod(exchange.timestamp, period, allTimeSince)) continue;
          if (title) sessionTitles[exchange.sessionId || fileSessionId] = title;
          exchange.dirName = dirName;
          seenSessions.add(exchange.sessionId || fileSessionId);
          exchanges.push(exchange);
        }
      } catch {}
    }
  }

  // Attach titles to exchanges
  for (const ex of exchanges) {
    if (!ex.sessionTitle && sessionTitles[ex.sessionId]) {
      ex.sessionTitle = sessionTitles[ex.sessionId];
    }
  }

  return { client: 'claude', label: 'Claude Code', exchanges, sessions: Array.from(seenSessions), sessionTitles };
}

module.exports = { collect, claudeDataDirs, walkJsonlFiles, isWithinPeriod };
