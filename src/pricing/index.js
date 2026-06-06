const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { litellmLookup } = require('./litellm');

const PROVIDER_PREFIXES = [
  'anthropic/', 'anthropic.',
  'openai/', 'openai.',
  'azure/', 'azure.',
  'deepseek/', 'deepseek.',
  'google/', 'google.',
  'meta/', 'meta.',
  'bedrock/', 'bedrock.',
  'us.', 'eu.', 'apac.',
];

function normalizeModelDisplayName(raw) {
  if (!raw) return '';
  let name = String(raw).trim();
  for (const prefix of PROVIDER_PREFIXES) {
    if (name.startsWith(prefix)) {
      name = name.slice(prefix.length);
      break;
    }
  }
  name = name.replace(/-v\d+:\d+$/, '');
  return name;
}

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const OPUS_MODERN = { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 };
const OPUS_LEGACY = { input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75 };
const SONNET      = { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 };
const HAIKU_4     = { input: 1.00, output: 5.00, cacheRead: 0.10, cacheWrite: 1.25 };
const GPT4O       = { input: 2.50, output: 10.00, cacheRead: 1.25 };
const DEEPSEEK_V4_FLASH = { input: 0.14, output: 0.28, cacheRead: 0.028 };
const DEEPSEEK_V4_PRO   = { input: 0.435, output: 0.87, cacheRead: 0.003625 };
const DEEPSEEK_CHAT     = { input: 0.14, output: 0.28, cacheRead: 0.028 };
const DEEPSEEK_REASONER = { input: 0.55, output: 2.19, cacheRead: 0.055 };
const QWEN_PLUS   = { input: 0.50, output: 2.00 };

const PINNED = {
  'claude-opus-4-7': OPUS_MODERN, 'claude-opus-4-7-20260416': OPUS_MODERN,
  'claude-opus-4-6': OPUS_MODERN, 'claude-opus-4-6-20260205': OPUS_MODERN,
  'claude-opus-4-5': OPUS_MODERN, 'claude-opus-4-5-20251101': OPUS_MODERN,
  'claude-opus-4-4': OPUS_MODERN,
  'claude-opus-4-1': OPUS_LEGACY, 'claude-opus-4-1-20250805': OPUS_LEGACY,
  'claude-opus-4-20250514': OPUS_LEGACY,
  'claude-sonnet-4-6': SONNET, 'claude-sonnet-4-5': SONNET,
  'claude-sonnet-4-5-20250929': SONNET, 'claude-sonnet-4-20250514': SONNET,
  'claude-3-7-sonnet-20250219': SONNET, 'claude-3-5-sonnet-20241022': SONNET,
  'claude-3-5-sonnet': SONNET, 'claude-3-sonnet': SONNET,
  'claude-haiku-4-5': HAIKU_4, 'claude-haiku-4-5-20251001': HAIKU_4,
  'claude-3-5-haiku-20241022': { input: 0.80, output: 4.00, cacheRead: 0.08, cacheWrite: 1.00 },
  'claude-3-haiku-20240307': { input: 0.25, output: 1.25, cacheRead: 0.03, cacheWrite: 0.30 },
  'gpt-4o': GPT4O, 'gpt-4o-mini': { input: 0.15, output: 0.60, cacheRead: 0.075 },
  'claude': SONNET,
  'deepseek-v4-flash': DEEPSEEK_V4_FLASH, 'deepseek-v4-pro': DEEPSEEK_V4_PRO,
  'deepseek-chat': DEEPSEEK_CHAT, 'deepseek-reasoner': DEEPSEEK_REASONER,
};

let opencodeModelsCache = null;
let opencodeModelsByProvider = null;

function loadOpencodeModels() {
  if (opencodeModelsCache !== null) return { flat: opencodeModelsCache, byProvider: opencodeModelsByProvider };
  const p = path.join(os.homedir(), '.cache', 'opencode', 'models.json');
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const byModel = {};
    const byProvider = {};
    for (const [providerId, provider] of Object.entries(raw)) {
      for (const [id, m] of Object.entries(provider.models || {})) {
        const c = m.cost;
        if (!c || typeof c !== 'object') continue;
        if (!c.input && !c.output) continue;
        if (id.endsWith('-free')) continue;
        if (!byModel[id]) byModel[id] = [];
        byModel[id].push(c);
        const pKey = providerId + '::' + id;
        if (!byProvider[pKey]) byProvider[pKey] = [];
        byProvider[pKey].push(c);
      }
    }
    const flat = {};
    for (const [id, prices] of Object.entries(byModel)) {
      prices.sort((a, b) => (b.input || 0) - (a.input || 0));
      flat[id] = prices[0];
    }
    const flatProvider = {};
    for (const [key, prices] of Object.entries(byProvider)) {
      prices.sort((a, b) => (b.input || 0) - (a.input || 0));
      flatProvider[key] = prices[0];
    }
    opencodeModelsCache = flat;
    opencodeModelsByProvider = flatProvider;
  } catch {
    opencodeModelsCache = {};
    opencodeModelsByProvider = {};
  }
  return { flat: opencodeModelsCache, byProvider: opencodeModelsByProvider };
}

function heuristic(modelId) {
  const id = String(modelId || '').toLowerCase();
  if (id.includes('free')) return ZERO;
  if (id.includes('opus')) return OPUS_MODERN;
  if (id.includes('sonnet')) return SONNET;
  if (id.includes('haiku')) return HAIKU_4;
  if ((id.includes('deepseek') && id.includes('flash')) || id.includes('v4-flash')) return DEEPSEEK_V4_FLASH;
  if (id.includes('deepseek') && id.includes('pro')) return DEEPSEEK_V4_PRO;
  if (id.includes('deepseek-chat') || (id.includes('deepseek') && id.includes('v3'))) return DEEPSEEK_CHAT;
  if (id.includes('deepseek') && id.includes('reasoner')) return DEEPSEEK_REASONER;
  if (id.includes('qwen') && id.includes('plus')) return QWEN_PLUS;
  if (id.includes('gpt-4o') || id.includes('gpt-5')) return GPT4O;
  return null;
}

function getPricing(modelId, providerId) {
  if (!modelId) return ZERO;

  const id = String(modelId).trim();
  const baseId = normalizeModelDisplayName(id);

  if (baseId.includes('free') || id.includes('free')) return ZERO;

  const { flat: ocFlat, byProvider: ocByProvider } = loadOpencodeModels();

  // 1. Prefer exact provider::model match from OpenCode cache
  if (providerId) {
    const pKey = providerId + '::' + baseId;
    if (ocByProvider[pKey]) {
      const c = ocByProvider[pKey];
      return {
        input: c.input || 0,
        output: c.output || 0,
        cacheRead: c.cache_read || 0,
        cacheWrite: c.cache_write || 0,
      };
    }
  }

  // 2. Fallback to model-only match from OpenCode cache
  if (ocFlat[baseId]) {
    const c = ocFlat[baseId];
    return {
      input: c.input || 0,
      output: c.output || 0,
      cacheRead: c.cache_read || 0,
      cacheWrite: c.cache_write || 0,
    };
  }

  // 3. LiteLLM lookup
  const lm = litellmLookup(id) || litellmLookup(baseId);
  if (lm) return lm;

  // 4. Pinned table
  const key = baseId.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/-+$/, '');
  if (PINNED[key]) return PINNED[key];

  // 5. Heuristic
  const h = heuristic(baseId);
  if (h) return h;

  return ZERO;
}

module.exports = { getPricing, normalizeModelDisplayName };
