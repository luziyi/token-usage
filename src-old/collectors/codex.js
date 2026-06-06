'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/*
 * Codex (OpenAI) Collector
 *
 * Reads JSONL files from ~/.codex/sessions/
 * Token data is in lines with type: 'event_msg', payload.type: 'token_count':
 *   payload.info.last_token_usage has per-turn tokens
 *   payload.info.total_token_usage has cumulative tokens
 */

function codexSessionDirs(home) {
  const sessions = path.join(home, '.codex', 'sessions');
  try {
    if (fs.statSync(sessions).isDirectory()) return [sessions];
  } catch {}
  return [];
}

function* walkSessionFiles(dir) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        yield* walkSessionFiles(path.join(dir, entry.name));
      } else if (entry.isFile() && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.json'))) {
        yield path.join(dir, entry.name);
      }
    }
  } catch {}
}

function isWithinPeriod(timestamp, period, allTimeSince) {
  if (!timestamp) return true;
  const d = new Date(timestamp);
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

function collect({ period, allTimeSince, homeDir }) {
  const home = homeDir || os.homedir();
  const dirs = codexSessionDirs(home);
  const exchanges = [];
  const seenSessions = new Set();

  for (const dir of dirs) {
    for (const filePath of walkSessionFiles(dir)) {
      const sessionId = path.basename(filePath, path.extname(filePath));
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split(/\r?\n/).filter(Boolean);

        let sessionTimestamp = '';

        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            if (typeof obj !== 'object' || obj === null) continue;

            const ts = obj.timestamp || '';
            if (!sessionTimestamp && ts) sessionTimestamp = ts;

            // token_count events carry the token usage
            if (obj.type === 'event_msg' && obj.payload?.type === 'token_count') {
              const info = obj.payload.info;
              if (!info) continue;

              // Use last_token_usage for per-turn data
              const usage = info.last_token_usage || info.total_token_usage;
              if (!usage) continue;

              const inputTokens = Number(usage.input_tokens) || 0;
              const outputTokens = Number(usage.output_tokens) || 0;
              const cacheRead = Number(usage.cached_input_tokens) || 0;
              const reasoningTokens = Number(usage.reasoning_output_tokens) || 0;

              if (inputTokens === 0 && outputTokens === 0 && cacheRead === 0) continue;
              if (!isWithinPeriod(ts, period, allTimeSince)) continue;

              seenSessions.add(sessionId);

              exchanges.push({
                inputTokens,
                outputTokens,
                cacheReadInputTokens: cacheRead,
                cacheCreationInputTokens: 0,
                reasoningTokens,
                model: 'gpt-4o',
                sessionId,
                timestamp: ts,
                type: 'token_count',
                contentPreview: extractCodexContent(obj)
              });
            }

            // Also check for model info in session_meta
            if (obj.type === 'session_meta' && obj.payload?.model_provider) {
              // The model info is available here
            }
          } catch {}
        }
      } catch {}
    }
  }

  return { client: 'codex', label: 'Codex', exchanges, sessions: Array.from(seenSessions) };
}

function extractCodexContent(obj) {
  try {
    if (obj.type === 'event_msg' && obj.payload?.type === 'task_complete') {
      const msg = obj.payload.last_agent_message || '';
      return msg.substring(0, 200);
    }
  } catch {}
  return '';
}

module.exports = { collect, codexSessionDirs };
