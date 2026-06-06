'use strict';

(function () {
  const api = window.tokenUsage;

  const CLIENT_COLORS = {
    claude: '#cc7c5e',
    codex: '#49a3b0',
    opencode: '#000000',
    cursor: '#000000',
    default: '#6ab4f0'
  };

  const CLIENT_LABELS = {
    claude: 'Claude Code',
    codex: 'Codex',
    opencode: 'OpenCode',
    cursor: 'Cursor'
  };

  const BREAKDOWN_MODES = ['tool', 'model', 'session'];
  const PERIOD_VALUES = new Set(['today', 'month', 'allTime']);

  const state = {
    period: 'today',
    breakdown: 'tool',
    settings: null,
    data: null,
    settingsOpen: false,
    refreshTimer: null,
    connected: false,
    sessionDetail: null,
    detailSort: 'time'
  };

  const els = {};

  function cacheElements() {
    els.shell = document.querySelector('.shell');
    els.status = document.getElementById('status');
    els.liveDot = document.getElementById('liveDot');
    els.totalTokens = document.getElementById('totalTokens');
    els.cost = document.getElementById('cost');
    els.breakdown = document.getElementById('breakdown');
    els.sessionDetail = document.getElementById('session-detail');
    els.settingsPanel = document.getElementById('settingsPanel');
    els.settingsButton = document.getElementById('settingsButton');
    els.pinButton = document.getElementById('pinButton');
    els.refreshButton = document.getElementById('refreshButton');
    els.minButton = document.getElementById('minButton');
    els.closeButton = document.getElementById('closeButton');
    els.breakdownToggle = document.getElementById('breakdownToggle');
    els.clientsInput = document.getElementById('clientsInput');
    els.currencyInput = document.getElementById('currencyInput');
    els.refreshInput = document.getElementById('refreshInput');
    els.glassInput = document.getElementById('glassInput');
    els.blurInput = document.getElementById('blurInput');
    els.zoomInput = document.getElementById('zoomInput');
    els.systemGlassInput = document.getElementById('systemGlassInput');
    els.liveDotInput = document.getElementById('liveDotInput');
    els.toolIconsInput = document.getElementById('toolIconsInput');
    els.saveSettingsButton = document.getElementById('saveSettingsButton');
    els.advancedSettingsButton = document.getElementById('advancedSettingsButton');

    els.tabs = document.querySelectorAll('.tab');
    els.breakdownBtns = document.querySelectorAll('.breakdown-btn');
  }

  function formatNumber(n) {
    return String(n);
  }

  function formatNumberWithCommas(n) {
    return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function formatCost(costUsd, currency) {
    const c = currency || 'USD';
    if (costUsd < 0.001) return '<$0.01';
    if (c === 'CNY') return '¥' + (costUsd * 7.2).toFixed(2);
    if (c === 'TWD') return 'NT$' + (costUsd * 32.5).toFixed(2);
    if (c === 'HKD') return 'HK$' + (costUsd * 7.8).toFixed(2);
    return '$' + costUsd.toFixed(2);
  }

  function animateNumber(el, target) {
    const rawText = el.textContent.replace(/,/g, '');
    const current = parseInt(rawText.replace(/[^0-9]/g, ''), 10) || 0;
    if (current === target) return;
    const duration = 400;
    const start = performance.now();

    const targetStr = formatNumberWithCommas(target);
    const currentStr = formatNumberWithCommas(current);
    const maxLen = Math.max(targetStr.length, currentStr.length);

    const paddedCurrent = currentStr.padStart(maxLen);
    const paddedTarget = targetStr.padStart(maxLen);

    const step = (timestamp) => {
      const progress = Math.min((timestamp - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);

      const currentVal = Math.round(current + (target - current) * eased);
      const interStr = formatNumberWithCommas(currentVal).padStart(maxLen);

      let html = '';
      for (let i = 0; i < maxLen; i++) {
        const tc = paddedTarget[i];
        const ic = interStr[i];
        if (tc === ic && tc === paddedCurrent[i]) {
          html += `<span class="n-stable">${tc}</span>`;
        } else {
          html += `<span class="n-changing">${ic}</span>`;
        }
      }
      el.innerHTML = html;
      if (progress < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  const PROVIDER_PREFIXES = ['anthropic/', 'anthropic.', 'openai/', 'bedrock/', 'deepseek/', 'azure/', 'google/', 'meta/'];

  function pad2(v) { return String(v).padStart(2, '0'); }

  function compactSessionTime(value, now) {
    if (!value) return '';
    const d = new Date(value);
    if (isNaN(d.getTime())) return '';
    const time = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    const sameDay = d.getFullYear() === now.getFullYear()
      && d.getMonth() === now.getMonth()
      && d.getDate() === now.getDate();
    return sameDay ? time : pad2(d.getMonth() + 1) + '/' + pad2(d.getDate()) + ' ' + time;
  }

  function displayModelName(raw) {
    if (!raw) return '';
    let name = String(raw);
    for (const p of PROVIDER_PREFIXES) {
      if (name.startsWith(p)) { name = name.slice(p.length); break; }
    }
    return name;
  }

  function colorFor(key) {
    return CLIENT_COLORS[key] || CLIENT_COLORS.default;
  }

  function labelFor(key) {
    return CLIENT_LABELS[key] || key;
  }

  function render() {
    if (state.sessionDetail && state.sessionDetail.loading) {
      els.breakdown.classList.add('hidden');
      els.sessionDetail.classList.remove('hidden');
      renderSessionDetail();
      return;
    }
    if (state.sessionDetail) {
      els.breakdown.classList.add('hidden');
      els.sessionDetail.classList.remove('hidden');
      renderSessionDetail();
      return;
    }

    if (!state.data || !state.settings) return;

    els.breakdown.classList.remove('hidden');
    els.sessionDetail.classList.add('hidden');

    const periodData = state.data[state.period];
    if (!periodData) return;

    const { aggregated } = periodData;
    const currency = state.settings.currency || 'USD';

    animateNumber(els.totalTokens, aggregated.allTokens);
    els.cost.textContent = formatCost(aggregated.allCost, currency);

    renderBreakdown(periodData, currency);
    updateFooter(periodData);
  }

  function renderBreakdown(periodData, currency) {
    const { aggregated, clients } = periodData;
    const mode = state.breakdown;
    let rows = [];

    if (mode === 'tool') {
      rows = Object.entries(aggregated.byTool || {}).map(([key, data]) => ({
        key,
        label: labelFor(key),
        sublabel: '',
        tokens: data.tokens,
        cost: data.cost,
        pct: aggregated.allTokens > 0 ? data.tokens / aggregated.allTokens : 0,
        breakdown: data,
        sessionId: null,
        client: key
      }));
    } else if (mode === 'model') {
      rows = Object.entries(aggregated.byModel || {}).map(([key, data]) => ({
        key,
        label: displayModelName(key),
        sublabel: '',
        tokens: data.tokens,
        cost: data.cost,
        pct: aggregated.allTokens > 0 ? data.tokens / aggregated.allTokens : 0,
        sessionId: null,
        client: null
      }));
    } else if (mode === 'session') {
      const sessionMap = {};
      for (const [clientKey, clientData] of Object.entries(clients || {})) {
        for (const ex of (clientData.exchanges || [])) {
          if (!ex.sessionId) continue;
          if (!sessionMap[ex.sessionId]) {
            sessionMap[ex.sessionId] = {
              tokens: 0, cost: 0, client: clientKey, sessionId: ex.sessionId,
              models: new Set(), timestamp: ex.timestamp || ''
            };
          }
          const t = (ex.inputTokens || 0) + (ex.outputTokens || 0) + (ex.cacheReadInputTokens || ex.cacheReadTokens || 0) + (ex.cacheCreationInputTokens || ex.cacheWriteTokens || 0);
          sessionMap[ex.sessionId].tokens += t;
          sessionMap[ex.sessionId].cost += ex.costUsd || 0;
          if (ex.model) sessionMap[ex.sessionId].models.add(ex.model);
          // Keep latest timestamp
          if (ex.timestamp && ex.timestamp > sessionMap[ex.sessionId].timestamp) {
            sessionMap[ex.sessionId].timestamp = ex.timestamp;
          }
        }
      }
      const now = new Date();
      rows = Object.values(sessionMap)
        .filter(s => s.tokens > 0)
        .sort((a, b) => {
          const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
          const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
          return tb - ta || b.tokens - a.tokens;
        })
        .slice(0, 50)
        .map((s) => {
          const clientLabel = CLIENT_LABELS[s.client] || s.client || 'Session';
          const modelList = [...s.models].filter(Boolean);
          const modelLabel = modelList.length === 1 ? modelList[0] : modelList.length > 1 ? modelList.length + ' models' : '';
          const name = [clientLabel, modelLabel].filter(Boolean).join(' \u00B7 ');
          const ts = compactSessionTime(s.timestamp, now);
          const subtitle = ts || '';
          return {
            key: s.sessionId,
            label: name,
            sublabel: subtitle,
            tokens: s.tokens,
            cost: s.cost,
            pct: aggregated.allTokens > 0 ? s.tokens / aggregated.allTokens : 0,
            sessionId: s.sessionId,
            client: s.client
          };
        });
    }

    rows.sort((a, b) => b.tokens - a.tokens);
    if (rows.length === 0) {
      els.breakdown.innerHTML = '<div class="empty-state"><div class="empty-state-icon">&#9632;</div><div class="empty-state-text">No token data found</div></div>';
      return;
    }

    const hiddenClients = new Set(String(state.settings.hiddenClients || '').split(',').filter(Boolean));
    if (mode === 'tool') rows = rows.filter((r) => !hiddenClients.has(r.key));

    const maxPct = rows.length > 0 ? Math.max(...rows.map((r) => r.pct), 0.01) : 1;
    const toolIconMap = { claude: 'claude', codex: 'codex', opencode: 'opencode', cursor: 'cursor' };

    function iconFor(name) {
      if (toolIconMap[name]) return name;
      const id = String(name || '').toLowerCase();
      if (id.startsWith('claude') || id.startsWith('anthropic')) return 'claude';
      if (id.startsWith('gpt') || id.startsWith('o3') || id.startsWith('o4')) return 'openai';
      if (id.startsWith('opencode')) return 'opencode';
      if (id.startsWith('cursor')) return 'cursor';
      if (id.startsWith('deepseek')) return 'deepseek';
      if (id.startsWith('qwen')) return 'qwen';
      if (id.startsWith('minimax')) return 'minimax';
      if (id.startsWith('gemini')) return 'gemini';
      if (id.startsWith('chatglm') || id.includes('glm')) return 'chatglm';
      return '';
    }

    let html = '';
    for (const row of rows) {
      const color = colorFor(row.key);
      const tokensStr = formatNumberWithCommas(row.tokens);
      const costStr = formatCost(row.cost, currency);
      const pct = row.pct / maxPct;
      const showSub = row.sublabel ? `<span class="row-sublabel">${row.sublabel}</span>` : '';
      const clickable = row.sessionId ? 'style="cursor:pointer"' : '';
      const rowIconClass = iconFor(row.key) || iconFor(row.client) || '';
      html += `
        <div class="row" data-key="${row.key}" data-session="${row.sessionId || ''}" data-client="${row.client || ''}" ${clickable}>
          <div class="row-head">
            <div class="row-name">
              <span class="row-dot${rowIconClass ? ' row-icon-' + rowIconClass : ''}" style="${rowIconClass ? '' : 'background:' + color}"></span>
              <span class="row-label">${row.label}${showSub}</span>
            </div>
            <div class="row-metrics">
              <div class="row-tokens">${tokensStr}</div>
              <div class="row-cost">${costStr}</div>
            </div>
          </div>
          <div class="bar"><div class="bar-fill" style="width:${Math.max(2, pct * 100)}%;background:${color}"></div></div>
        </div>`;
    }
    els.breakdown.innerHTML = html;

    // Bind session click
    if (mode === 'session') {
      els.breakdown.querySelectorAll('.row[data-session]').forEach((el) => {
        el.addEventListener('click', () => {
          const sessionId = el.dataset.session;
          const client = el.dataset.client;
          if (sessionId) openSessionDetail(sessionId, client);
        });
      });
    }
  }

  function updateFooter(periodData) {
    const count = Object.keys(periodData.clients || {}).length;
    els.breakdownToggle.textContent = `${count} sources \u00B7 ${state.breakdown}`;
  }

  function openSessionDetail(sessionId, client) {
    state.sessionDetail = { sessionId, client, loading: true };
    render();
    api.getSessionDetail({ sessionId, client }).then((result) => {
      state.sessionDetail = { sessionId, client, ...result, loading: false };
      render();
    }).catch(() => {
      state.sessionDetail = { sessionId, client, loading: false, error: true };
      render();
    });
  }

  function closeSessionDetail() {
    state.sessionDetail = null;
    state.detailSort = 'time';
    render();
  }

  function toggleDetailSort() {
    state.detailSort = state.detailSort === 'tokens' ? 'time' : 'tokens';
    if (state.sessionDetail && !state.sessionDetail.loading) render();
  }

  function renderSessionDetail() {
    const detail = state.sessionDetail;
    if (!detail) return;
    const container = els.sessionDetail;
    container.replaceChildren();

    const backBtn = document.createElement('button');
    backBtn.className = 'detail-back';
    backBtn.textContent = '\u2039 Sessions';
    backBtn.addEventListener('click', closeSessionDetail);
    container.append(backBtn);

    if (detail.loading) {
      container.append(detailNote('Loading\u2026'));
      return;
    }
    if (detail.error || detail.found === false) {
      container.append(detailNote('Transcript not found on this machine.'));
      return;
    }

    const exchanges = detail.exchanges || [];
    if (exchanges.length === 0) {
      container.append(detailNote('No activity in this session.'));
      return;
    }

    const sortBtn = document.createElement('button');
    sortBtn.className = 'detail-sort';
    sortBtn.textContent = state.detailSort === 'tokens' ? '\u2195 Most tokens' : '\u2195 Newest';
    sortBtn.addEventListener('click', toggleDetailSort);
    container.append(sortBtn);

    const sorted = [...exchanges];
    if (state.detailSort === 'tokens') {
      sorted.sort((a, b) => (b.tokens?.total || 0) - (a.tokens?.total || 0));
    } else {
      sorted.sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
    }

    const summary = detail.summary || {};
    els.totalTokens.textContent = formatNumberWithCommas(summary.totalTokens || 0);
    els.cost.textContent = formatCost(summary.totalCost || 0, state.settings?.currency);

    const maxValue = Math.max(1, ...sorted.map(r => r.tokens?.total || 0));

    for (const row of sorted) {
      container.append(exchangeNode(row, maxValue));
    }
  }

  function detailNote(text) {
    const note = document.createElement('div');
    note.className = 'detail-note';
    note.textContent = text;
    return note;
  }

  function exchangeNode(row, max) {
    const wrap = document.createElement('div');
    wrap.className = 'detail-exchange';
    wrap.innerHTML = '<div class="detail-ex-head"><span class="detail-chev">\u25b8</span>'
      + '<div class="detail-ex-label"><span class="detail-ex-title"></span><span class="detail-ex-sub"></span></div>'
      + '<div class="detail-ex-metrics"><span class="detail-ex-value"></span><span class="detail-ex-cost"></span></div></div>'
      + '<div class="bar"><div class="bar-fill"></div></div>'
      + '<div class="detail-turns hidden"></div>';

    const exTitle = wrap.querySelector('.detail-ex-title');
    if (row.promptPreview) {
      const role = document.createElement('span');
      role.className = 'detail-role-user';
      role.textContent = 'You \u203A ';
      exTitle.append(role);
    }
    exTitle.append(document.createTextNode(row.promptPreview || '(session start)'));

    const now = new Date();
    const subParts = [
      row.startedAt ? compactSessionTime(row.startedAt, now) : '',
      row.turnCount + ' turn' + (row.turnCount !== 1 ? 's' : ''),
      row.tools && row.tools.length > 0 ? row.tools.length + ' tool' + (row.tools.length !== 1 ? 's' : '') : ''
    ].filter(Boolean);
    wrap.querySelector('.detail-ex-sub').textContent = subParts.join(' \u00B7 ');

    wrap.querySelector('.detail-ex-value').textContent = formatNumberWithCommas(row.tokens?.total || 0);
    wrap.querySelector('.detail-ex-cost').textContent = formatCost(row.costEstimate || 0, state.settings?.currency);
    wrap.querySelector('.bar-fill').style.width = (Math.max(2, Math.min(100, ((row.tokens?.total || 0) / max) * 100))) + '%';

    const turnsEl = wrap.querySelector('.detail-turns');
    for (let i = 0; i < (row.turns || []).length; i++) {
      turnsEl.append(turnNode(row.turns[i], i));
    }

    const head = wrap.querySelector('.detail-ex-head');
    head.addEventListener('click', function () {
      const hidden = turnsEl.classList.toggle('hidden');
      wrap.querySelector('.detail-chev').textContent = hidden ? '\u25b8' : '\u25be';
    });

    if (!row.turns || row.turns.length === 0) {
      wrap.querySelector('.detail-chev').classList.add('hidden');
    }

    return wrap;
  }

  function turnNode(turn, index) {
    const el = document.createElement('div');
    el.className = 'detail-turn';
    const tk = turn.tokens || {};
    const cache = (tk.cacheRead || 0) + (tk.cacheWrite || 0);
    const split = 'in ' + formatNumberWithCommas(tk.input || 0)
      + ' \u00B7 out ' + formatNumberWithCommas(tk.output || 0)
      + ' \u00B7 cache ' + formatNumberWithCommas(cache)
      + (tk.reasoning ? ' \u00B7 reason ' + formatNumberWithCommas(tk.reasoning) : '');

    el.innerHTML = '<div class="detail-turn-label"><span class="detail-turn-title"></span><span class="detail-turn-split"></span><span class="detail-turn-tools"></span></div>'
      + '<div class="detail-turn-metrics"><span class="detail-turn-value"></span><span class="detail-turn-cost"></span></div>';
    el.querySelector('.detail-turn-title').textContent = 'AI Reply #' + (index + 1);
    el.querySelector('.detail-turn-split').textContent = split;
    el.querySelector('.detail-turn-tools').textContent = turn.tools && turn.tools.length ? '\u22a2 ' + turn.tools.join(' \u00B7 ') : '';
    el.querySelector('.detail-turn-value').textContent = formatNumberWithCommas(turn.value || tk.total || 0);
    el.querySelector('.detail-turn-cost').textContent = formatCost(turn.costEstimate || 0, state.settings?.currency);
    return el;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function applySettingsToUI(s) {
    const settings = s || state.settings;
    if (!settings) return;
    if (els.clientsInput) els.clientsInput.value = settings.clients || '';
    if (els.currencyInput) els.currencyInput.value = settings.currency || 'USD';
    if (els.refreshInput) els.refreshInput.value = String(settings.refreshMs || 30000);
    if (els.glassInput) { els.glassInput.value = settings.glassOpacity ?? 68; onGlassChange(); }
    if (els.blurInput) { els.blurInput.value = settings.glassBlur ?? 32; onBlurChange(); }
    if (els.zoomInput) { els.zoomInput.value = Math.round((settings.zoomFactor || 1) * 100); onZoomChange(); }
    if (els.systemGlassInput) els.systemGlassInput.checked = settings.systemGlass !== false;
    if (els.liveDotInput) els.liveDotInput.checked = settings.showLiveDot !== false;
    if (els.toolIconsInput) els.toolIconsInput.checked = settings.showToolIcons !== false;
  }

  function onGlassChange() {
    const value = parseInt(els.glassInput.value, 10);
    document.documentElement.style.setProperty('--glass-alpha', value / 100);
  }

  function onBlurChange() {
    const value = parseInt(els.blurInput.value, 10);
    els.shell.style.setProperty('-webkit-backdrop-filter', `blur(${value}px) saturate(115%)`);
    els.shell.style.setProperty('backdrop-filter', `blur(${value}px) saturate(115%)`);
  }

  function onZoomChange() {
    document.body.style.zoom = parseInt(els.zoomInput.value, 10) / 100;
  }

  function openSettings() {
    state.settingsOpen = true;
    els.settingsPanel.classList.remove('hidden');
    applySettingsToUI();
  }

  function closeSettings() {
    state.settingsOpen = false;
    els.settingsPanel.classList.add('hidden');
  }

  function saveSettings() {
    const patch = {};
    if (els.clientsInput) patch.clients = els.clientsInput.value.trim();
    if (els.currencyInput) patch.currency = els.currencyInput.value;
    if (els.refreshInput) patch.refreshMs = parseInt(els.refreshInput.value, 10);
    if (els.glassInput) patch.glassOpacity = parseInt(els.glassInput.value, 10);
    if (els.blurInput) patch.glassBlur = parseInt(els.blurInput.value, 10);
    if (els.zoomInput) patch.zoomFactor = parseInt(els.zoomInput.value, 10) / 100;
    if (els.systemGlassInput) patch.systemGlass = els.systemGlassInput.checked;
    if (els.liveDotInput) patch.showLiveDot = els.liveDotInput.checked;
    if (els.toolIconsInput) patch.showToolIcons = els.toolIconsInput.checked;
    api.updateSettings(patch).then((s) => {
      state.settings = s;
      closeSettings();
    });
  }

  function switchPeriod(period) {
    if (!PERIOD_VALUES.has(period)) return;
    state.period = period;
    state.sessionDetail = null;
    els.tabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.period === period));
    render();
  }

  function switchBreakdown(mode) {
    state.breakdown = mode;
    state.sessionDetail = null;
    render();
  }

  function updateLiveDot(connected) {
    state.connected = connected;
    els.liveDot.classList.toggle('offline', !connected);
  }

  function handleDataPush(payload) {
    if (payload.error) {
      els.status.textContent = 'Error: ' + payload.error;
      updateLiveDot(false);
      return;
    }
    state.data = payload.data;
    if (payload.settings) state.settings = payload.settings;
    updateLiveDot(true);
    els.status.textContent = 'Updated ' + new Date(payload.at).toLocaleTimeString();
    if (!state.sessionDetail) render();
  }

  function handleSettingsPush(settings) {
    state.settings = settings;
    if (!state.settingsOpen && !state.sessionDetail) render();
  }

  function init() {
    cacheElements();

    els.tabs.forEach((tab) => {
      tab.addEventListener('click', () => switchPeriod(tab.dataset.period));
    });

    els.breakdownBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        els.breakdownBtns.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        switchBreakdown(btn.dataset.breakdown);
      });
    });

    els.settingsButton.addEventListener('click', () => {
      if (state.settingsOpen) closeSettings();
      else openSettings();
    });

    els.saveSettingsButton.addEventListener('click', saveSettings);

    els.advancedSettingsButton.addEventListener('click', () => {
      api.getAppInfo().then(console.log);
    });

    els.pinButton.addEventListener('click', () => {
      api.togglePin().then((isPinned) => {
        els.pinButton.style.color = isPinned ? 'var(--green)' : '';
      });
    });

    els.minButton.addEventListener('click', () => api.minimize());
    els.closeButton.addEventListener('click', () => api.close());

    els.refreshButton.addEventListener('click', () => {
      els.refreshButton.classList.add('spinning');
      api.refreshData().then((data) => {
        setTimeout(() => els.refreshButton.classList.remove('spinning'), 400);
        if (data) { state.data = data; if (!state.sessionDetail) render(); }
      });
    });

    if (els.glassInput) els.glassInput.addEventListener('input', onGlassChange);
    if (els.blurInput) els.blurInput.addEventListener('input', onBlurChange);
    if (els.zoomInput) els.zoomInput.addEventListener('input', onZoomChange);

    api.onDataPush(handleDataPush);
    api.onSettingsPush(handleSettingsPush);

    api.getSettings().then((s) => {
      state.settings = s;
      applySettingsToUI(s);
      els.status.textContent = 'Ready';
      return api.getData();
    }).then((data) => {
      if (data) { state.data = data; render(); }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
