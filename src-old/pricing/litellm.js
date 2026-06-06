'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DATA_PATH = path.join(__dirname, 'litellm-data.json');
let cache = null;

function loadData() {
  if (cache !== null) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  } catch {
    cache = {};
  }
  return cache;
}

/**
 * Per-model pricing: { input, output, cacheRead, cacheWrite } $/MTok
 */
function toMTok(entry) {
  if (!entry) return null;
  const M = 1e6;
  return {
    input: (entry.input_cost_per_token || 0) * M,
    output: (entry.output_cost_per_token || 0) * M,
    cacheRead: (entry.cache_read_input_token_cost || 0) * M,
    cacheWrite: (entry.cache_creation_input_token_cost || 0) * M,
  };
}

/**
 * Probe LiteLLM data with a set of key variations.
 * Supports all known provider prefixes.
 */
const ALL_PREFIXES = [
  '',  // bare key
  'anthropic/', 'anthropic.',
  'openai/', 'openai.',
  'azure/', 'azure.',
  'deepseek/', 'deepseek.',
  'google/', 'google.',
  'meta/', 'meta.',
  'mistral/', 'mistral.',
  'cohere/', 'cohere.',
  'together_ai/', 'togetherai/',
  'fireworks_ai/', 'fireworks-ai/',
];

function litellmLookup(modelId) {
  if (!modelId) return null;
  const db = loadData();
  const keys = new Set([modelId]);

  for (const prefix of ALL_PREFIXES) {
    if (!prefix) continue;
    keys.add(prefix + modelId);
    // Try alternate separator
    if (prefix.endsWith('/')) keys.add(prefix.slice(0, -1) + '.' + modelId);
    if (prefix.endsWith('.')) keys.add(prefix.slice(0, -1) + '/' + modelId);
  }

  for (const key of keys) {
    if (db[key]) return toMTok(db[key]);
  }

  return null;
}

module.exports = { litellmLookup, loadData };
