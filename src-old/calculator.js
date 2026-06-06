'use strict';

/**
 * Token usage calculator — cost engine.
 *
 * Core formula (matches code-usage methodology):
 *   uncachedInput = max(0, inputTokens - cacheReadTokens)
 *   cost = uncachedInput × input_rate
 *        + cacheRead × cacheRead_rate
 *        + cacheWrite × cacheWrite_rate
 *        + output × output_rate
 *        + reasoning × output_rate      (reasoning billed at output rate)
 *
 * All rates come from the unified pricing module (LiteLLM + pinned table + heuristics).
 */

const { getPricing } = require('./pricing');

function perMillion(tokens, rate) {
  return (tokens / 1_000_000) * rate;
}

/**
 * Calculate cost for a single exchange.
 */
function calculateExchangeCost(inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, model) {
  const p = getPricing(model);
  const uncached = Math.max(0, (inputTokens || 0) - (cacheReadTokens || 0));
  let cost = 0;
  cost += perMillion(uncached, p.input);
  cost += perMillion(cacheReadTokens || 0, p.cacheRead || 0);
  cost += perMillion(cacheWriteTokens || 0, p.cacheWrite || 0);
  cost += perMillion(outputTokens || 0, p.output);
  cost += perMillion(reasoningTokens || 0, p.output);
  return cost;
}

/**
 * Sum an array of exchanges → aggregate token/cost totals.
 */
function sumTokens(exchanges) {
  let totalTokens = 0, totalCost = 0;
  let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheWrite = 0, totalReasoning = 0;

  for (const ex of exchanges) {
    const input     = Math.max(0, ex.inputTokens || 0);
    const output    = Math.max(0, ex.outputTokens || 0);
    const cacheRead = Math.max(0, ex.cacheReadInputTokens || ex.cacheReadTokens || 0);
    const cacheWrite= Math.max(0, ex.cacheCreationInputTokens || ex.cacheWriteTokens || 0);
    const reasoning = Math.max(0, ex.reasoningTokens || 0);

    totalInput     += input;
    totalOutput    += output;
    totalCacheRead += cacheRead;
    totalCacheWrite += cacheWrite;
    totalReasoning += reasoning;
    totalTokens    += input + output + cacheRead + cacheWrite;
    // Free models cost $0 regardless of pre-computed costUsd
    const isFree = ex.model && String(ex.model).toLowerCase().includes('free');
    totalCost      += isFree ? 0 : (ex.costUsd || calculateExchangeCost(input, output, cacheRead, cacheWrite, reasoning, ex.model));
  }

  return { totalTokens, totalCost, totalInput, totalOutput, totalCacheRead, totalCacheWrite, totalReasoning };
}

/**
 * Build per-tool / per-model / per-session aggregates.
 */
function buildAggregate(clients) {
  let allTokens = 0, allCost = 0;
  const byTool = {}, byModel = {}, bySession = {};

  for (const [clientKey, clientData] of Object.entries(clients)) {
    if (!clientData || !clientData.exchanges) continue;
    const result = sumTokens(clientData.exchanges);
    byTool[clientKey] = {
      tokens: Math.round(result.totalTokens),
      cost: result.totalCost,
      input: Math.round(result.totalInput),
      output: Math.round(result.totalOutput),
      cacheRead: Math.round(result.totalCacheRead),
      cacheWrite: Math.round(result.totalCacheWrite),
      reasoning: Math.round(result.totalReasoning),
    };
    allTokens += result.totalTokens;
    allCost   += result.totalCost;

    // Per-model aggregation
    for (const ex of clientData.exchanges) {
      const model = ex.model || 'unknown';
      if (!byModel[model]) byModel[model] = { tokens: 0, cost: 0, input: 0, output: 0 };
      const mTokens = (ex.inputTokens || 0) + (ex.outputTokens || 0)
                    + (ex.cacheReadInputTokens || ex.cacheReadTokens || 0)
                    + (ex.cacheCreationInputTokens || ex.cacheWriteTokens || 0);
      byModel[model].tokens += mTokens;
      const isFree = ex.model && String(ex.model).toLowerCase().includes('free');
      byModel[model].cost += isFree ? 0 : (ex.costUsd || calculateExchangeCost(
        ex.inputTokens || 0, ex.outputTokens || 0,
        ex.cacheReadInputTokens || ex.cacheReadTokens || 0,
        ex.cacheCreationInputTokens || ex.cacheWriteTokens || 0,
        ex.reasoningTokens || 0,
        ex.model,
      ));
    }
  }

  return { allTokens: Math.round(allTokens), allCost, byTool, byModel, bySession };
}

function normalizeClientName(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (s.includes('claude')) return 'claude';
  if (s.includes('codex')) return 'codex';
  if (s.includes('opencode')) return 'opencode';
  if (s.includes('cursor')) return 'cursor';
  return s.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || null;
}

module.exports = { calculateExchangeCost, sumTokens, buildAggregate, normalizeClientName };
