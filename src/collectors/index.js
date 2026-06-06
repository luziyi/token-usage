const { buildAggregate } = require('../calculator');
const opencodeCollector = require('./opencode');

async function collectData({ period, allTimeSince, homeDir }) {
  const result = await opencodeCollector.collect({ period, allTimeSince, homeDir });
  const aggregated = buildAggregate(result.exchanges);
  return {
    period,
    exchanges: result.exchanges,
    aggregated,
    totalExchanges: result.exchanges.length,
    totalSessions: result.sessions ? result.sessions.length : 0
  };
}

async function collectAllPeriods({ allTimeSince, homeDir }) {
  const allExchanges = await opencodeCollector.collectAll({ allTimeSince, homeDir });
  const now = Date.now();
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const monthStart = new Date(Date.UTC(todayStart.getUTCFullYear(), todayStart.getUTCMonth(), 1));
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

  return { today, month, allTime };
}

module.exports = { collectData, collectAllPeriods, opencodeCollector };
