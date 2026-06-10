function msToIso(ms) {
  if (!ms) return "";
  const d = new Date(Number(ms));
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

function getDateKey(ts) {
  if (!ts) return "unknown";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "unknown";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

function getProviderLabel(providerId) {
  const map = {
    deepseek: "DeepSeek",
    openai: "OpenAI",
    anthropic: "Anthropic",
    google: "Google",
    meta: "Meta",
    mistral: "Mistral",
    azure: "Azure",
    bedrock: "AWS Bedrock",
    together_ai: "Together AI",
    fireworks_ai: "Fireworks AI",
    qwen: "Qwen",
    minimax: "MiniMax",
    cohere: "Cohere",
    openrouter: "OpenRouter",
  };
  return map[providerId] || providerId || "unknown";
}

module.exports = { msToIso, getDateKey, getProviderLabel };
