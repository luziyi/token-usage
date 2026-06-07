const { buildAggregate } = require('../calculator');
const opencodeCollector = require('./opencode');
const claudeCollector = require('./claude');

async function collectData({ period, allTimeSince, homeDir }) {
  const [opencodeResult, claudeResult] = await Promise.all([
    opencodeCollector.collect({ period, allTimeSince, homeDir }),
    claudeCollector.collect({ period, allTimeSince, homeDir }),
  ]);

  const allExchanges = [...opencodeResult.exchanges, ...claudeResult.exchanges];
  const aggregated = buildAggregate(allExchanges);

  const allSessions = new Set([
    ...(opencodeResult.sessions || []),
    ...(claudeResult.sessions || []),
  ]);

  return {
    period,
    exchanges: allExchanges,
    aggregated,
    totalExchanges: allExchanges.length,
    totalSessions: allSessions.size,
  };
}

async function collectAllPeriods({ allTimeSince, homeDir }) {
  const [opencodeExchanges, claudeExchanges] = await Promise.all([
    opencodeCollector.collectAll({ allTimeSince, homeDir }),
    claudeCollector.collectAll({ allTimeSince, homeDir }),
  ]);

  const allExchanges = [...opencodeExchanges, ...claudeExchanges];
  const now = Date.now();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const monthStart = new Date(todayStart.getFullYear(), todayStart.getMonth(), 1);
  const since = allTimeSince ? new Date(allTimeSince).getTime() : 0;

  const today = { period: 'today', exchanges: [], aggregated: null, totalExchanges: 0, totalSessions: 0 };
  const month = { period: 'month', exchanges: [], aggregated: null, totalExchanges: 0, totalSessions: 0 };
  const allTime = { period: 'allTime', exchanges: [], aggregated: null, totalExchanges: 0, totalSessions: 0 };

  const seenToday = new Set(), seenMonth = new Set(), seenAll = new Set();
  const start = todayStart.getTime();
  const mStart = monthStart.getTime();

  if (!Number.isNaN(since) && since > 0) {
    for (const ex of allExchanges) {
      const t = ex.timeCreated;
      if (t >= since) {
        allTime.exchanges.push(ex);
        if (ex.sessionId) seenAll.add(ex.sessionId);
        if (t >= mStart) {
          month.exchanges.push(ex);
          if (ex.sessionId) seenMonth.add(ex.sessionId);
          if (t >= start) {
            today.exchanges.push(ex);
            if (ex.sessionId) seenToday.add(ex.sessionId);
          }
        }
      }
    }
  } else {
    for (const ex of allExchanges) {
      allTime.exchanges.push(ex);
      if (ex.sessionId) seenAll.add(ex.sessionId);
      const t = ex.timeCreated;
      if (t >= mStart) {
        month.exchanges.push(ex);
        if (ex.sessionId) seenMonth.add(ex.sessionId);
        if (t >= start) {
          today.exchanges.push(ex);
          if (ex.sessionId) seenToday.add(ex.sessionId);
        }
      }
    }
  }

  today.aggregated = buildAggregate(today.exchanges);
  today.totalExchanges = today.exchanges.length;
  today.totalSessions = seenToday.size;

  month.aggregated = buildAggregate(month.exchanges);
  month.totalExchanges = month.exchanges.length;
  month.totalSessions = seenMonth.size;

  allTime.aggregated = buildAggregate(allTime.exchanges);
  allTime.totalExchanges = allTime.exchanges.length;
  allTime.totalSessions = seenAll.size;

  return { today, month, allTime, rawExchanges: allExchanges };
}

async function collectRawExchanges({ allTimeSince, homeDir }) {
  const [opencodeExchanges, claudeExchanges] = await Promise.all([
    opencodeCollector.collectAll({ allTimeSince, homeDir }),
    claudeCollector.collectAll({ allTimeSince, homeDir }),
  ]);
  return [...opencodeExchanges, ...claudeExchanges];
}

module.exports = { collectData, collectAllPeriods, collectRawExchanges, opencodeCollector, claudeCollector };
