const { getPricing } = require('./pricing');

function perMillion(tokens, rate) {
  return (tokens / 1_000_000) * rate;
}

function calculateExchangeCost(inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, model, provider) {
  const p = getPricing(model, provider);
  let cost = 0;
  cost += perMillion(inputTokens || 0, p.input);
  cost += perMillion(cacheReadTokens || 0, p.cacheRead || 0);
  cost += perMillion(cacheWriteTokens || 0, p.cacheWrite || 0);
  cost += perMillion(outputTokens || 0, p.output);
  cost += perMillion(reasoningTokens || 0, p.output);
  return cost;
}

function sumTokens(exchanges) {
  let totalCost = 0;
  let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheWrite = 0, totalReasoning = 0;

  for (const ex of exchanges) {
    const input     = Math.max(0, ex.inputTokens || 0);
    const output    = Math.max(0, ex.outputTokens || 0);
    const cacheRead = Math.max(0, ex.cacheReadInputTokens || 0);
    const cacheWrite= Math.max(0, ex.cacheCreationInputTokens || 0);
    const reasoning = Math.max(0, ex.reasoningTokens || 0);

    totalInput     += input;
    totalOutput    += output;
    totalCacheRead += cacheRead;
    totalCacheWrite += cacheWrite;
    totalReasoning += reasoning;

    totalCost += ex.costUsd || calculateExchangeCost(input, output, cacheRead, cacheWrite, reasoning, ex.model, ex.provider);
  }

  const totalTokens = totalInput + totalOutput + totalCacheRead + totalCacheWrite + totalReasoning;
  return { totalCost, totalTokens, totalInput, totalOutput, totalCacheRead, totalCacheWrite, totalReasoning };
}

function buildAggregate(exchanges) {
  let allCost = 0;
  const totals = { totalInput: 0, totalOutput: 0, totalCacheRead: 0, totalCacheWrite: 0, totalReasoning: 0 };
  const byModel = {}, byDate = {}, bySession = {}, byAgent = {};

  for (const ex of exchanges) {
    const input     = Math.max(0, ex.inputTokens || 0);
    const output    = Math.max(0, ex.outputTokens || 0);
    const cacheRead = Math.max(0, ex.cacheReadInputTokens || 0);
    const cacheWrite= Math.max(0, ex.cacheCreationInputTokens || 0);
    const reasoning = Math.max(0, ex.reasoningTokens || 0);

    // Skip exchanges with 0 total tokens (interrupted/no response)
    if (input + output + cacheRead + cacheWrite + reasoning === 0) continue;

    const cost = ex.costUsd || calculateExchangeCost(input, output, cacheRead, cacheWrite, reasoning, ex.model, ex.provider);

    totals.totalInput += input;
    totals.totalOutput += output;
    totals.totalCacheRead += cacheRead;
    totals.totalCacheWrite += cacheWrite;
    totals.totalReasoning += reasoning;
    allCost += cost;

    const model = ex.modelClean || ex.model || 'unknown';

    if (!byModel[model]) byModel[model] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0, count: 0, provider: ex.provider || '' };
    byModel[model].input += input;
    byModel[model].output += output;
    byModel[model].cacheRead += cacheRead;
    byModel[model].cacheWrite += cacheWrite;
    byModel[model].reasoning += reasoning;
    byModel[model].cost += cost;
    byModel[model].count++;

    const dateKey = ex.dateKey || 'unknown';
    if (!byDate[dateKey]) byDate[dateKey] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0, count: 0 };
    byDate[dateKey].input += input;
    byDate[dateKey].output += output;
    byDate[dateKey].cacheRead += cacheRead;
    byDate[dateKey].cacheWrite += cacheWrite;
    byDate[dateKey].reasoning += reasoning;
    byDate[dateKey].cost += cost;
    byDate[dateKey].count++;

    const sessionId = ex.sessionId || 'unknown';
    if (!bySession[sessionId]) {
      bySession[sessionId] = {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0, count: 0,
        model: model,
        provider: ex.provider || '',
        source: ex.source || '',
        timestamp: ex.timestamp || '',
        title: ex.sessionTitle || '',
        sessionId
      };
    }
    bySession[sessionId].input += input;
    bySession[sessionId].output += output;
    bySession[sessionId].cacheRead += cacheRead;
    bySession[sessionId].cacheWrite += cacheWrite;
    bySession[sessionId].reasoning += reasoning;
    bySession[sessionId].cost += cost;
    bySession[sessionId].count++;

    const sourceKey = ex.source || 'unknown';
    if (!byAgent[sourceKey]) {
      byAgent[sourceKey] = {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0, count: 0,
        source: sourceKey,
        model: model,
        sessionId: sessionId,
        timestamp: ex.timestamp || '',
      };
    }
    byAgent[sourceKey].input += input;
    byAgent[sourceKey].output += output;
    byAgent[sourceKey].cacheRead += cacheRead;
    byAgent[sourceKey].cacheWrite += cacheWrite;
    byAgent[sourceKey].reasoning += reasoning;
    byAgent[sourceKey].cost += cost;
    byAgent[sourceKey].count++;
  }

  const totalTokens = totals.totalInput + totals.totalOutput + totals.totalCacheRead + totals.totalCacheWrite + totals.totalReasoning;

  return { totalTokens, totalCost: allCost, totals, byModel, byDate, bySession, byAgent };
}

module.exports = { calculateExchangeCost, sumTokens, buildAggregate };
