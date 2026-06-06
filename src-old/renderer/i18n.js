'use strict';

(function () {
  const translations = {
    en: {
      totalTokens: 'TOTAL TOKENS',
      sources: 'sources',
      refresh: 'Refresh',
      settings: 'Settings',
      day: 'DAY',
      month: 'MONTH',
      total: 'TOTAL',
      initializing: 'Initializing...',
      collecting: 'Collecting...',
      error: 'Error',
      tokens: 'tokens',
      cost: 'cost',
      noData: 'No data'
    },
    'zh-CN': {
      totalTokens: '总 Token 数',
      sources: '个来源',
      refresh: '刷新',
      settings: '设置',
      day: '今日',
      month: '本月',
      total: '总计',
      initializing: '初始化中...',
      collecting: '采集中...',
      error: '错误',
      tokens: 'token',
      cost: '费用',
      noData: '暂无数据'
    }
  };

  function resolveLocale(preferred) {
    const lang = String(preferred || 'en').toLowerCase().replace(/-.*$/, '');
    if (lang === 'zh') return 'zh-CN';
    return 'en';
  }

  function translate(locale, key) {
    const table = translations[locale] || translations.en;
    return table[key] || translations.en[key] || key;
  }

  window.TokenUsageI18n = { resolveLocale, translate, translations };
})();
