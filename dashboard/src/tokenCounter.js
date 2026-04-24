// tokenCounter.js — Token counting and context window management for chatbot dashboard
// Cloud-only variant — token counting uses approximate BPE estimation

const MODEL_VOCAB_SIZE = 151669;
const MODEL_MAX_CONTEXT = 65536;
const DEFAULT_MAX_CONTEXT = 16384;
const SESSION_STATS_KEY = 'tenrary-x-session-stats';

const CJK_RANGES = /[\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\u{20000}-\u{2FA1F}]/u;

let session = loadSessionStats();

function createEmptySession() {
  return {
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalTokens: 0,
    messageCount: 0,
    startTime: Date.now(),
  };
}

function clampNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function saveSessionStats() {
  try {
    localStorage.setItem(SESSION_STATS_KEY, JSON.stringify(session));
  } catch {
    // Ignore storage failures (private mode/quota limits)
  }
}

function loadSessionStats() {
  try {
    const raw = localStorage.getItem(SESSION_STATS_KEY);
    if (!raw) return createEmptySession();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return createEmptySession();

    return {
      totalPromptTokens: clampNumber(parsed.totalPromptTokens),
      totalCompletionTokens: clampNumber(parsed.totalCompletionTokens),
      totalTokens: clampNumber(parsed.totalTokens),
      messageCount: clampNumber(parsed.messageCount),
      startTime: clampNumber(parsed.startTime) || Date.now(),
    };
  } catch {
    return createEmptySession();
  }
}

/**
 * Estimate token count from text.
 * Uses char/4 for Latin/English text, char/2 for CJK characters.
 */
export function estimateTokens(text) {
  if (!text) return 0;

  let tokens = 0;
  for (const char of text) {
    tokens += CJK_RANGES.test(char) ? 0.5 : 0.25;
  }
  // Every message has a small fixed overhead for BPE special tokens
  return Math.max(1, Math.ceil(tokens) + 4);
}

/**
 * Calculate context window usage given messages and system prompt.
 * @param {Array<{role: string, content: string}>} messages
 * @param {string} systemPrompt
 * @param {number} [maxContext=DEFAULT_MAX_CONTEXT]
 * @returns {{ used: number, remaining: number, percentage: number, warning: string|null }}
 */
export function calculateContextUsage(messages, systemPrompt = '', maxContext = DEFAULT_MAX_CONTEXT) {
  const cap = Math.min(maxContext, MODEL_MAX_CONTEXT);

  let used = 0;
  if (systemPrompt) {
    used += estimateTokens(systemPrompt);
  }

  if (Array.isArray(messages)) {
    for (const msg of messages) {
      // Per-message overhead: role token + separators (~4 tokens)
      used += estimateTokens(msg.content || '') + 4;
    }
  }

  const remaining = Math.max(0, cap - used);
  const percentage = cap > 0 ? Math.min(100, (used / cap) * 100) : 100;

  return {
    used,
    remaining,
    percentage: Math.round(percentage * 10) / 10,
    warning: getWarningLevel(percentage),
  };
}

/**
 * Return current session statistics.
 */
export function getSessionStats() {
  return { ...session };
}

/**
 * Update session statistics with usage data from a completion response.
 * @param {{ prompt_tokens?: number, completion_tokens?: number }} usage
 */
export function updateSessionStats(usage) {
  if (!usage) return;
  const prompt = usage.prompt_tokens || 0;
  const completion = usage.completion_tokens || 0;

  session.totalPromptTokens += prompt;
  session.totalCompletionTokens += completion;
  session.totalTokens += prompt + completion;
  session.messageCount += 1;
  saveSessionStats();
}

/**
 * Reset session statistics.
 */
export function resetSessionStats() {
  session = createEmptySession();
  saveSessionStats();
}

/**
 * Map a usage percentage to a warning level.
 * @param {number} percentage
 * @returns {null | 'approaching' | 'high' | 'critical'}
 */
export function getWarningLevel(percentage) {
  if (percentage >= 95) return 'critical';
  if (percentage >= 90) return 'high';
  if (percentage >= 80) return 'approaching';
  return null;
}

/**
 * Format a token count for display.
 * @param {number} n
 * @returns {string}
 */
export function formatTokenCount(n) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return (n / 1_000_000).toFixed(2).replace(/\.?0+$/, '') + 'M';
}

/**
 * Build an object describing a context-usage bar for UI rendering.
 * @param {number} percentage  0–100
 * @returns {{ width: string, color: string, label: string }}
 */
export function getContextBar(percentage) {
  const clamped = Math.max(0, Math.min(100, percentage));
  let color;
  if (clamped >= 95) color = '#ef4444';      // red-500
  else if (clamped >= 90) color = '#f97316';  // orange-500
  else if (clamped >= 80) color = '#eab308';  // yellow-500
  else color = '#22c55e';                      // green-500

  return {
    width: `${clamped.toFixed(1)}%`,
    color,
    label: `${clamped.toFixed(1)}% context used`,
  };
}

/**
 * Estimate cost for tokens used at a configurable rate.
 * @param {number} tokens
 * @param {number} [ratePerMillionTokens=0]  cost per 1M tokens
 * @returns {{ tokens: number, cost: number, formatted: string }}
 */
export function estimateCost(tokens, ratePerMillionTokens = 0) {
  const cost = (tokens / 1_000_000) * ratePerMillionTokens;
  return {
    tokens,
    cost: Math.round(cost * 1_000_000) / 1_000_000,
    formatted: cost > 0 ? `$${cost.toFixed(4)}` : '—',
  };
}

export const CONFIG = Object.freeze({
  MODEL_VOCAB_SIZE,
  MODEL_MAX_CONTEXT,
  DEFAULT_MAX_CONTEXT,
});

// ── Token Usage Analytics ──────────────────────────────────────
const ANALYTICS_KEY = 'tenrary-x-token-analytics';

export function recordUsage(promptTokens, completionTokens, mode) {
  const analytics = JSON.parse(localStorage.getItem(ANALYTICS_KEY) || '[]');
  analytics.push({
    timestamp: Date.now(),
    prompt: promptTokens,
    completion: completionTokens,
    total: promptTokens + completionTokens,
    mode,
  });
  // Keep last 1000 records
  if (analytics.length > 1000) analytics.splice(0, analytics.length - 1000);
  localStorage.setItem(ANALYTICS_KEY, JSON.stringify(analytics));
}

export function getAnalytics() {
  return JSON.parse(localStorage.getItem(ANALYTICS_KEY) || '[]');
}

export function getAnalyticsSummary() {
  const data = getAnalytics();
  const today = new Date(); today.setHours(0,0,0,0);
  const todayTs = today.getTime();
  const weekAgo = todayTs - 7 * 24 * 60 * 60 * 1000;

  const todayData = data.filter(d => d.timestamp >= todayTs);
  const weekData = data.filter(d => d.timestamp >= weekAgo);

  return {
    today: { total: todayData.reduce((s, d) => s + d.total, 0), count: todayData.length },
    week: { total: weekData.reduce((s, d) => s + d.total, 0), count: weekData.length },
    allTime: { total: data.reduce((s, d) => s + d.total, 0), count: data.length },
    byMode: {
      enowxai: data.filter(d => d.mode === 'enowxai').reduce((s, d) => s + d.total, 0),
      openai: data.filter(d => d.mode === 'openai').reduce((s, d) => s + d.total, 0),
      anthropic: data.filter(d => d.mode === 'anthropic').reduce((s, d) => s + d.total, 0),
    },
  };
}
