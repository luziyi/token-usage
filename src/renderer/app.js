(function () {
  const api = window.tokenUsage;

  const BREAKDOWN_MODES = [
    { key: "model", label: "模型" },
    { key: "date", label: "日期" },
    { key: "agent", label: "代理" },
    { key: "session", label: "会话" },
  ];

  const PERIOD_LABELS = { today: "今日", month: "本月", allTime: "总计" };

  const MODEL_ICONS = {
    deepseek: "deepseek.svg",
    "deepseek-v4-flash": "deepseek.svg",
    "deepseek-v4-pro": "deepseek.svg",
    "deepseek-chat": "deepseek.svg",
    "deepseek-reasoner": "deepseek.svg",
    claude: "claude.svg",
    "claude-code": "claude.svg",
    "claude-sonnet-4": "claude.svg",
    "claude-opus-4": "claude.svg",
    "gpt-4o": "openai.svg",
    openai: "openai.svg",
    opencode: "opencode.png",
    qwen: "qwen.svg",
    "alibaba-cn": "qwen.svg",
    minimax: "minimax.svg",
    gemini: "gemini.svg",
    google: "google.svg",
    anthropic: "anthropic.svg",
    openrouter: "anthropic.svg",
    meta: "meta.svg",
    default: null,
  };

  // Icon color cache — populated synchronously at startup with extracted icon colors
  const iconColorCache = new Map();

  function initIconColors() {
    // Real dominant colors extracted from each icon file
    // (hardcoded so first render is correct — no async flash)
    const iconColors = {
      "deepseek.svg": "#4D6BFE",
      "claude.svg": "#D97757",
      "openai.svg": "#66bb6a",
      "opencode.png": "#a6a6a6",
      "qwen.svg": "#6336E7",
      "minimax.svg": "#E2167E",
      "gemini.svg": "#3186FF",
      "google.svg": "#4285F4",
      "anthropic.svg": "#ce93d8",
      "meta.svg": "#0082FB",
    };
    for (const [file, color] of Object.entries(iconColors)) {
      iconColorCache.set("icons/" + file, color);
    }
  }

  const MODEL_COLORS = {
    deepseek: "#4fc3f7",
    "deepseek-v4-flash": "#4fc3f7",
    "deepseek-v4-pro": "#4fc3f7",
    "deepseek-chat": "#4fc3f7",
    "deepseek-reasoner": "#ff8a65",
    claude: "#ce93d8",
    "claude-sonnet-4": "#ce93d8",
    "claude-opus-4": "#ef5350",
    "gpt-4o": "#66bb6a",
    openai: "#66bb6a",
    qwen: "#6fa8dc",
    minimax: "#f4a073",
    gemini: "#f1d973",
    google: "#f1d973",
    anthropic: "#ce93d8",
    meta: "#4fc3f7",
    default: "#6c9ef0",
  };

  function modelIconSrc(modelId, provider, modelKey) {
    const id = (modelId || "").toLowerCase();
    const prov = (provider || "").toLowerCase();
    const mk = (modelKey || "").toLowerCase();
    // 1. Exact match on model identifier
    if (MODEL_ICONS[mk]) return "icons/" + MODEL_ICONS[mk];
    if (MODEL_ICONS[id]) return "icons/" + MODEL_ICONS[id];
    // 2. Substring match on model (catches variants like "deepseek-v4-flash-free")
    for (const [key, val] of Object.entries(MODEL_ICONS)) {
      if (mk.includes(key) || id.includes(key)) return "icons/" + val;
    }
    // 3. Provider match — lowest priority
    if (MODEL_ICONS[prov]) return "icons/" + MODEL_ICONS[prov];
    for (const [key, val] of Object.entries(MODEL_ICONS)) {
      if (prov.includes(key)) return "icons/" + val;
    }
    return null;
  }

  const state = {
    period: "today",
    breakdown: "model",
    settings: null,
    data: null,
    settingsOpen: false,
    connected: false,
    sessionDetail: null,
    menuOpen: false,
  };

  const els = {};

  function cacheElements() {
    els.shell = document.querySelector(".shell");
    els.status = document.getElementById("status");
    els.liveDot = document.getElementById("liveDot");
    els.totalTokens = document.getElementById("totalTokens");
    els.cost = document.getElementById("cost");
    els.inputLabel = document.getElementById("inputLabel");
    els.outputLabel = document.getElementById("outputLabel");
    els.cacheReadLabel = document.getElementById("cacheReadLabel");
    els.breakdown = document.getElementById("breakdown");
    els.sessionDetail = document.getElementById("session-detail");
    els.settingsPanel = document.getElementById("settingsPanel");
    els.settingsButton = document.getElementById("settingsButton");
    els.refreshButton = document.getElementById("refreshButton");
    els.minButton = document.getElementById("minButton");
    els.maxButton = document.getElementById("maxButton");
    els.closeButton = document.getElementById("closeButton");
    els.breakdownToggle = document.getElementById("breakdownToggle");
    els.breakdownLabel = document.getElementById("breakdownLabel");
    els.currencyInput = document.getElementById("currencyInput");
    els.refreshInput = document.getElementById("refreshInput");
    els.saveSettingsButton = document.getElementById("saveSettingsButton");

    els.tabs = document.querySelectorAll(".tab");
  }

  function formatNumber(n) {
    return String(n);
  }

  function formatNumberWithCommas(n) {
    return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  let lastTokenValue = 0;

  function animateNumber(el, target) {
    const rawText = el.textContent.replace(/,/g, "");
    const current = parseInt(rawText.replace(/[^0-9]/g, ""), 10) || 0;
    if (current === target) {
      el.textContent = formatNumberWithCommas(target);
      return;
    }
    const duration = 1200;
    const start = performance.now();
    const targetStr = formatNumberWithCommas(target);
    const currentStr = formatNumberWithCommas(current);

    const step = (timestamp) => {
      const progress = Math.min((timestamp - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const currentVal = Math.round(current + (target - current) * eased);
      el.textContent = formatNumberWithCommas(currentVal);
      if (progress < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function formatCost(costUsd, currency) {
    const c = currency || "USD";
    if (costUsd < 0.001) return "<$0.01";
    if (c === "CNY") return "¥" + (costUsd * 7.2).toFixed(2);
    return "$" + costUsd.toFixed(3);
  }

  function pad2(v) {
    return String(v).padStart(2, "0");
  }

  function compactTime(value) {
    if (!value) return "";
    const d = new Date(value);
    if (isNaN(d.getTime())) return "";
    const now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    if (sameDay) return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
    return pad2(d.getMonth() + 1) + "/" + pad2(d.getDate());
  }

  function formatDate(dateKey) {
    if (!dateKey || dateKey === "unknown") return "";
    const d = new Date(dateKey);
    if (isNaN(d.getTime())) return dateKey;
    const now = new Date();
    const sameYear = d.getFullYear() === now.getFullYear();
    return sameYear
      ? d.getMonth() + 1 + "/" + d.getDate()
      : d.getFullYear() + "/" + (d.getMonth() + 1) + "/" + d.getDate();
  }

  function formatDateWeekday(dateKey) {
    const days = ["日", "一", "二", "三", "四", "五", "六"];
    if (!dateKey || dateKey === "unknown") return "";
    const d = new Date(dateKey);
    if (isNaN(d.getTime())) return dateKey;
    return (
      d.getFullYear() +
      "年" +
      (d.getMonth() + 1) +
      "月" +
      d.getDate() +
      "日 星期" +
      days[d.getDay()]
    );
  }

  function formatSessionTitle(title, fallback) {
    if (title && title.length > 40) return title.substring(0, 40) + "…";
    return title || fallback || "(无标题)";
  }

  function modelColor(modelId, provider, modelKey) {
    // Prefer extracted icon color
    const iconPath = modelIconSrc(modelId, provider, modelKey);
    if (iconPath && iconColorCache.has(iconPath))
      return iconColorCache.get(iconPath);
    // Fallback to hardcoded colors
    const accent = state.settings?.accentColor || MODEL_COLORS.default;
    if (!modelId) return accent;
    for (const [key, color] of Object.entries(MODEL_COLORS)) {
      if (modelId.toLowerCase().includes(key)) return color;
    }
    return accent;
  }

  function agentColor(source) {
    if (source === "opencode") return "#4fc3f7";
    if (source === "claude-code" || source === "claude") return "#ce93d8";
    return state.settings?.accentColor || "#6c9ef0";
  }

  function sourceColor(source) {
    const iconPath = agentIcon(source);
    if (iconPath && iconColorCache.has(iconPath))
      return iconColorCache.get(iconPath);
    return agentColor(source);
  }

  function agentLabel(source) {
    if (source === "opencode") return "OpenCode";
    if (source === "claude-code") return "Claude Code";
    return source;
  }

  function agentIcon(source) {
    if (source === "opencode") return "icons/opencode.png";
    if (source === "claude-code") return "icons/claude.svg";
    return null;
  }

  function getProviderLabel(modelId) {
    if (!modelId) return "";
    const id = modelId.toLowerCase();
    if (id.includes("deepseek")) return "DeepSeek";
    if (id.includes("claude") || id.includes("anthropic")) return "Anthropic";
    if (id.includes("gpt") || id.includes("o3") || id.includes("o4"))
      return "OpenAI";
    if (id.includes("gemini")) return "Google";
    if (id.includes("qwen")) return "Qwen";
    return "";
  }

  function cleanModelName(raw) {
    if (!raw) return "";
    let name = String(raw);
    name = name.replace(/^openrouter\//i, "");
    const parts = name.split("/");
    return parts[parts.length - 1] || name;
  }

  function effectiveProvider(raw) {
    if (!raw) return "";
    const id = String(raw).toLowerCase();
    if (id.startsWith("openrouter/")) {
      const rest = id.replace(/^openrouter\//, "");
      const parts = rest.split("/");
      if (parts.length > 1) return getProviderLabel(parts[0]) || parts[0];
    }
    return "";
  }

  function render() {
    if (state.sessionDetail) {
      state.sessionDetail.loading
        ? renderSessionDetailLoading()
        : renderSessionDetail();
      return;
    }

    if (!state.data || !state.settings) return;

    els.breakdown.classList.remove("hidden");
    els.sessionDetail.classList.add("hidden");

    const periodData = state.data[state.period];
    if (!periodData) return;

    const { aggregated } = periodData;
    const currency = state.settings.currency || "USD";

    animateNumber(els.totalTokens, aggregated.totalTokens);
    els.cost.textContent = formatCost(aggregated.totalCost, currency);
    els.inputLabel.textContent =
      "IN " + formatNumber(aggregated.totals.totalInput);
    els.outputLabel.textContent =
      "OUT " + formatNumber(aggregated.totals.totalOutput);
    els.cacheReadLabel.textContent =
      "CACHE " +
      formatNumber(
        aggregated.totals.totalCacheRead + aggregated.totals.totalCacheWrite,
      );

    renderBreakdown(periodData, currency);
  }

  function renderBreakdown(periodData, currency) {
    const { aggregated } = periodData;
    const mode = state.breakdown;

    let groups = [];
    let dataSource;

    if (mode === "model") {
      dataSource = aggregated.byModel;
      groups = Object.entries(dataSource).map(([key, d]) => ({
        key,
        modelKey: cleanModelName(key),
        provider: d.provider,
        label: cleanModelName(key),
        sublabel: effectiveProvider(key) || d.provider || getProviderLabel(key),
        tokens: d.input + d.output + d.cacheRead + d.cacheWrite + d.reasoning,
        cost: d.cost,
        detail: `IN ${d.input} · OUT ${d.output} · CACHE ${d.cacheRead + d.cacheWrite}`,
        color: modelColor(key, d.provider, cleanModelName(key)),
      }));
    } else if (mode === "date") {
      dataSource = aggregated.byDate;
      groups = Object.entries(dataSource)
        .filter(([k]) => k !== "unknown")
        .sort(([a], [b]) => b.localeCompare(a))
        .map(([key, d]) => ({
          key,
          label: formatDateWeekday(key),
          sublabel: "",
          tokens: d.input + d.output + d.cacheRead + d.cacheWrite + d.reasoning,
          cost: d.cost,
          detail: `${d.count} 个会话`,
          color: state.settings?.accentColor || MODEL_COLORS.default,
        }));
    } else if (mode === "agent") {
      dataSource = aggregated.byAgent;
      groups = Object.entries(dataSource || {}).map(([key, d]) => ({
        key,
        source: d.source,
        label: agentLabel(key),
        sublabel: d.model || "",
        tokens: d.input + d.output + d.cacheRead + d.cacheWrite + d.reasoning,
        cost: d.cost,
        detail: `IN ${d.input} · OUT ${d.output} · CACHE ${d.cacheRead + d.cacheWrite}`,
        color: sourceColor(d.source || key),
      }));
    } else if (mode === "session") {
      dataSource = aggregated.bySession;
      groups = Object.values(dataSource)
        .filter(
          (s) =>
            s.input + s.output + s.cacheRead + s.cacheWrite + s.reasoning > 0,
        )
        .sort((a, b) => (b.timeCreated || 0) - (a.timeCreated || 0))
        .slice(0, 100)
        .map((s) => ({
          key: s.sessionId,
          modelKey: s.model,
          provider: s.provider,
          source: s.source,
          label: formatSessionTitle(s.title, s.sessionId.substring(0, 16)),
          sublabel: compactTime(s.timestamp),
          tokens: s.input + s.output + s.cacheRead + s.cacheWrite + s.reasoning,
          cost: s.cost,
          detail: "",
          color: sourceColor(s.source),
          sessionId: s.sessionId,
        }));
    }

    groups.sort((a, b) => b.tokens - a.tokens);

    if (groups.length === 0) {
      els.breakdown.innerHTML =
        '<div class="empty-state"><div class="empty-state-icon">&#9632;</div><div class="empty-state-text">暂无数据</div></div>';
      return;
    }

    const maxTokens = groups[0].tokens || 1;

    let html = "";
    html += `<div class="section-label">${BREAKDOWN_MODES.find((m) => m.key === mode).label}</div>`;
    for (const g of groups) {
      const pct = g.tokens / maxTokens;
      const clickable = g.sessionId ? "" : "";
      const toolIcon = g.source ? agentIcon(g.source) : null;
      const iconPath = toolIcon || modelIconSrc(g.key, g.provider, g.modelKey);
      const dotOrIcon = iconPath
        ? `<img class="row-icon" src="${iconPath}" alt="" aria-hidden="true">`
        : `<span class="row-dot" style="background:${g.color}"></span>`;
      html += `
        <div class="row" data-session="${g.sessionId || ""}" data-key="${g.key}" ${clickable}>
          <div class="row-head">
            <div class="row-name">
              ${dotOrIcon}
              <span class="row-label">${g.label}</span>
              ${g.sublabel ? `<span class="row-sublabel">${g.sublabel}</span>` : ""}
            </div>
            <div class="row-metrics">
              <div class="row-tokens">${formatNumber(g.tokens)}</div>
              <div class="row-cost">${formatCost(g.cost, currency)}</div>
            </div>
          </div>
          <div class="row-detail">${g.detail}</div>
          <div class="bar"><div class="bar-fill" style="width:${Math.max(2, pct * 100)}%;background:${g.color}"></div></div>
        </div>`;
    }
    els.breakdown.innerHTML = html;

    if (mode === "session") {
      els.breakdown.querySelectorAll(".row[data-session]").forEach((el) => {
        el.addEventListener("click", () => {
          const sessionId = el.dataset.session;
          if (sessionId) openSessionDetail(sessionId);
        });
      });
    }
  }

  function openSessionDetail(sessionId) {
    state.sessionDetail = { sessionId, loading: true };
    render();
    api
      .getSessionDetail({ sessionId })
      .then((result) => {
        state.sessionDetail = { sessionId, ...result, loading: false };
        render();
      })
      .catch(() => {
        state.sessionDetail = { sessionId, loading: false, error: true };
        render();
      });
  }

  function closeSessionDetail() {
    state.sessionDetail = null;
    render();
  }

  function renderSessionDetailLoading() {
    els.breakdown.classList.add("hidden");
    els.sessionDetail.classList.remove("hidden");
    els.sessionDetail.innerHTML =
      '<div class="detail-header"><button class="detail-back">&#8249; 返回</button><span class="detail-info">加载中…</span></div>';
    els.sessionDetail
      .querySelector(".detail-back")
      .addEventListener("click", closeSessionDetail);
  }

  function renderSessionDetail() {
    const detail = state.sessionDetail;
    if (!detail) return;
    els.breakdown.classList.add("hidden");
    els.sessionDetail.classList.remove("hidden");

    const container = els.sessionDetail;
    container.innerHTML = "";

    const header = document.createElement("div");
    header.className = "detail-header";
    const backBtn = document.createElement("button");
    backBtn.className = "detail-back";
    backBtn.textContent = "\u2039 返回";
    backBtn.addEventListener("click", closeSessionDetail);
    header.append(backBtn);
    const info = document.createElement("span");
    info.className = "detail-info";
    info.textContent = detail.exchanges
      ? detail.exchanges.length + " 轮对话"
      : "";
    header.append(info);
    container.append(header);

    if (detail.loading) {
      container.append(createNote("加载中…"));
      return;
    }
    if (detail.error || detail.found === false) {
      container.append(createNote("未找到会话详情"));
      return;
    }

    const exchanges = detail.exchanges || [];
    if (exchanges.length === 0) {
      container.append(createNote("此会话无对话记录"));
      return;
    }

    if (detail.summary) {
      animateNumber(els.totalTokens, detail.summary.totalTokens || 0);
      els.cost.textContent = formatCost(
        detail.summary.totalCost || 0,
        state.settings?.currency,
      );
    }

    const sorted = [...exchanges]
      .filter((ex) => (ex.tokens?.total || 0) > 0)
      .sort((a, b) => (a.startedAt || "").localeCompare(b.startedAt || ""));
    const maxValue = Math.max(1, ...sorted.map((r) => r.tokens?.total || 0));

    for (const ex of sorted) {
      container.append(createExchangeNode(ex, maxValue));
    }
  }

  function createNote(text) {
    const note = document.createElement("div");
    note.className = "empty-state";
    note.innerHTML = `<div class="empty-state-text">${text}</div>`;
    return note;
  }

  function createExchangeNode(row, max) {
    const wrap = document.createElement("div");
    wrap.className = "detail-exchange";

    const turnsHidden = row.turns && row.turns.length > 0;
    wrap.innerHTML = `
      <div class="detail-ex-head">
        <span class="detail-chev ${turnsHidden ? "" : "hidden"}">\u25b8</span>
        <div class="detail-ex-label">
          <span class="detail-ex-title"></span>
          <span class="detail-ex-sub"></span>
        </div>
        <div class="detail-ex-metrics">
          <span class="detail-ex-value"></span>
          <span class="detail-ex-cost"></span>
        </div>
      </div>
      <div class="bar"><div class="bar-fill"></div></div>
      <div class="detail-turns ${turnsHidden ? "hidden" : ""}"></div>
    `;

    const exTitle = wrap.querySelector(".detail-ex-title");
    if (row.promptPreview) {
      const role = document.createElement("span");
      role.className = "detail-role-user";
      role.textContent = "You \u203A ";
      exTitle.append(role);
      exTitle.append(document.createTextNode(row.promptPreview));
    } else if (row.modelName) {
      const role = document.createElement("span");
      role.className = "detail-role-ai";
      role.textContent = "AI \u203A ";
      exTitle.append(role);
      exTitle.append(document.createTextNode(row.modelName));
    } else {
      exTitle.append(document.createTextNode("AI 回复"));
    }

    const subParts = [
      row.startedAt ? compactTime(row.startedAt) : "",
      row.modelName ? row.modelName : "",
      row.turnCount ? row.turnCount + " 次回复" : "",
    ].filter(Boolean);
    wrap.querySelector(".detail-ex-sub").textContent =
      subParts.join(" \u00B7 ");

    wrap.querySelector(".detail-ex-value").textContent = formatNumber(
      row.tokens?.total || 0,
    );
    wrap.querySelector(".detail-ex-cost").textContent = formatCost(
      row.costEstimate || 0,
      state.settings?.currency,
    );
    wrap.querySelector(".bar-fill").style.width =
      Math.max(2, Math.min(100, ((row.tokens?.total || 0) / max) * 100)) + "%";

    const turnsEl = wrap.querySelector(".detail-turns");
    if (row.turns) {
      for (let i = 0; i < row.turns.length; i++) {
        turnsEl.append(createTurnNode(row.turns[i], i));
      }
    }

    const head = wrap.querySelector(".detail-ex-head");
    head.addEventListener("click", function () {
      if (!row.turns || row.turns.length === 0) return;
      const hidden = turnsEl.classList.toggle("hidden");
      wrap.querySelector(".detail-chev").textContent = hidden
        ? "\u25b8"
        : "\u25be";
    });

    return wrap;
  }

  function createTurnNode(turn, index) {
    const el = document.createElement("div");
    el.className = "detail-turn";
    const tk = turn.tokens || {};
    const cache = (tk.cacheRead || 0) + (tk.cacheWrite || 0);
    const split =
      "IN " +
      formatNumber(tk.input || 0) +
      " · OUT " +
      formatNumber(tk.output || 0) +
      " · CACHE " +
      formatNumber(cache) +
      (tk.reasoning ? " · REASON " + formatNumber(tk.reasoning) : "");

    el.innerHTML = `
      <div class="detail-turn-label">
        <span class="detail-turn-title">AI 回复 #${index + 1}</span>
        <span class="detail-turn-split">${split}</span>
      </div>
      <div class="detail-turn-metrics">
        <span class="detail-turn-value">${formatNumber(tk.total || 0)}</span>
        <span class="detail-turn-cost">${formatCost(turn.costEstimate || 0, state.settings?.currency)}</span>
      </div>`;
    return el;
  }

  function applyAccentColor(color) {
    document.documentElement.style.setProperty("--accent", color);
    // Mark active swatch
    const swatches = document.querySelectorAll(".color-swatch");
    swatches.forEach(function (sw) {
      sw.classList.toggle("active", sw.dataset.color === color);
    });
  }

  function applySettingsToUI(s) {
    const settings = s || state.settings;
    if (!settings) return;
    if (els.currencyInput) els.currencyInput.value = settings.currency || "USD";
    if (els.refreshInput)
      els.refreshInput.value = String(settings.refreshMs || 5000);
    if (settings.accentColor) applyAccentColor(settings.accentColor);
  }

  function openSettings() {
    state.settingsOpen = true;
    els.settingsPanel.classList.remove("hidden");
    applySettingsToUI();
    // Bind color swatch clicks
    document.querySelectorAll(".color-swatch").forEach(function (sw) {
      sw.onclick = function () {
        document.querySelectorAll(".color-swatch").forEach(function (s) {
          s.classList.remove("active");
        });
        sw.classList.add("active");
        applyAccentColor(sw.dataset.color);
      };
    });
  }

  function closeSettings() {
    state.settingsOpen = false;
    els.settingsPanel.classList.add("hidden");
  }

  function saveSettings() {
    const patch = {};
    if (els.currencyInput) patch.currency = els.currencyInput.value;
    if (els.refreshInput)
      patch.refreshMs = parseInt(els.refreshInput.value, 10);
    const activeSwatch = document.querySelector(".color-swatch.active");
    if (activeSwatch) patch.accentColor = activeSwatch.dataset.color;
    api.updateSettings(patch).then((s) => {
      state.settings = s;
      closeSettings();
    });
  }

  function switchPeriod(period) {
    state.period = period;
    state.sessionDetail = null;
    els.tabs.forEach((tab) =>
      tab.classList.toggle("active", tab.dataset.period === period),
    );
    render();
  }

  function switchBreakdown(mode) {
    state.breakdown = mode;
    state.sessionDetail = null;
    closeMenu();
    const label = BREAKDOWN_MODES.find((m) => m.key === mode)?.label || mode;
    if (els.breakdownLabel) els.breakdownLabel.textContent = label;
    render();
  }

  function toggleMenu() {
    if (state.menuOpen) {
      closeMenu();
      return;
    }
    state.menuOpen = true;
    const rect = els.breakdownToggle.getBoundingClientRect();
    const menu = document.createElement("div");
    menu.className = "dropdown-menu";
    menu.id = "breakdownMenu";
    menu.style.left = "0";
    menu.style.top = rect.height + 4 + "px";
    for (const m of BREAKDOWN_MODES) {
      const item = document.createElement("div");
      item.className =
        "dropdown-item" + (m.key === state.breakdown ? " active" : "");
      item.textContent = m.label;
      item.addEventListener("click", () => switchBreakdown(m.key));
      menu.append(item);
    }
    els.breakdownToggle.style.position = "relative";
    els.breakdownToggle.append(menu);
  }

  function closeMenu() {
    state.menuOpen = false;
    const menu = document.getElementById("breakdownMenu");
    if (menu) menu.remove();
  }

  function updateLiveDot(connected) {
    state.connected = connected;
    els.liveDot.classList.toggle("offline", !connected);
  }

  function handleDataPush(payload) {
    if (payload.error) {
      els.status.textContent = "错误: " + payload.error;
      updateLiveDot(false);
      return;
    }
    state.data = payload.data;
    if (payload.settings) state.settings = payload.settings;
    updateLiveDot(true);
    els.status.textContent =
      "更新于 " + new Date(payload.at).toLocaleTimeString();
    if (!state.sessionDetail) render();
  }

  function handleSettingsPush(settings) {
    state.settings = settings;
    if (!state.settingsOpen && !state.sessionDetail) render();
  }

  function init() {
    initIconColors();
    window.addEventListener("contextmenu", (e) => e.preventDefault());
    document.addEventListener("contextmenu", (e) => e.preventDefault());
    cacheElements();

    els.tabs.forEach((tab) => {
      tab.addEventListener("click", () => switchPeriod(tab.dataset.period));
    });

    els.breakdownToggle.addEventListener("click", toggleMenu);

    els.settingsButton.addEventListener("click", () => {
      if (state.settingsOpen) closeSettings();
      else openSettings();
    });

    els.saveSettingsButton.addEventListener("click", saveSettings);

    els.refreshButton.addEventListener("click", () => {
      const icon = els.refreshButton.querySelector(".refresh-icon");
      if (icon) {
        icon.style.transform = "rotate(360deg)";
        icon.style.transition = "transform 0.4s ease";
      }
      api.refreshData().then((data) => {
        setTimeout(() => {
          if (icon) {
            icon.style.transition = "none";
            icon.style.transform = "rotate(0deg)";
          }
        }, 400);
        if (data) {
          state.data = data;
          if (!state.sessionDetail) render();
        }
      });
    });

    els.minButton.addEventListener("click", () => api.minimize());
    els.maxButton.addEventListener("click", () => api.maximize());
    els.closeButton.addEventListener("click", () => api.close());

    document.addEventListener("click", (e) => {
      if (state.menuOpen && !e.target.closest(".toggle-btn")) closeMenu();
    });

    api.onDataPush(handleDataPush);
    api.onSettingsPush(handleSettingsPush);

    api
      .getSettings()
      .then((s) => {
        state.settings = s;
        applySettingsToUI(s);
        els.status.textContent = "就绪";
        return api.getData();
      })
      .then((data) => {
        if (data) {
          state.data = data;
          render();
        }
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
