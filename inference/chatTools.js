/**
 * Chat Tools — Server-side tool execution for the regular chat.
 *
 * When the dashboard sends `tools_enabled: true` in the chat completions payload,
 * this module intercepts the request and adds tool definitions (web_search, web_fetch,
 * calculator, image_info). If the LLM responds with tool_calls, they are executed
 * server-side and the results are sent back for a final streaming response.
 *
 * Flow:
 *   1. Dashboard sends { messages, tools_enabled: true, stream: true, ... }
 *   2. We strip tools_enabled, inject OpenAI-format tool definitions
 *   3. First call: non-streaming to check for tool_calls
 *   4. If tool_calls → execute locally → append tool results → second streaming call
 *   5. If no tool_calls → re-issue as streaming and pipe to client
 */

// ── Tool Definitions (OpenAI function calling format) ──────────

const CHAT_TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the web for current information. Use when the user asks about recent events, ' +
        'news, people, products, or anything that requires up-to-date knowledge beyond your training data.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query. Be specific for better results.' },
          count: { type: 'integer', description: 'Number of results (1-10). Default: 5.', default: 5 },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description:
        'Fetch a web page and extract its text content. Use after web_search to read full articles. HTTPS only.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'HTTPS URL to fetch.' },
          max_chars: { type: 'integer', description: 'Max characters to return. Default: 30000.', default: 30000 },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calculator',
      description:
        'Perform precise mathematical calculations. Use instead of mental math for accuracy. ' +
        'Operations: add, subtract, multiply, divide, mod, pow, sqrt, log, ln, exp, ' +
        'abs, floor, ceil, round, average, median, variance, stdev_population, stdev_sample, ' +
        'min, max, count, sum, percentile.',
      parameters: {
        type: 'object',
        properties: {
          operation: { type: 'string', description: 'The calculation to perform.' },
          values: {
            type: 'array', items: { type: 'number' },
            description: 'Numeric values. For binary ops: [left, right]. For stats: all data points.',
          },
          percentile_rank: { type: 'integer', description: 'Percentile rank 0-100 (for percentile op).' },
        },
        required: ['operation', 'values'],
      },
    },
  },
];

// ── Tool Execution ─────────────────────────────────────────────

const SEARCH_TIMEOUT_MS = 15_000;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_FETCH_CHARS = 50_000;

const BLOCKED_HOSTS = new Set([
  'localhost', '127.0.0.1', '0.0.0.0', '::1',
  'metadata.google.internal', '169.254.169.254',
]);

function isBlockedHost(hostname) {
  if (BLOCKED_HOSTS.has(hostname)) return true;
  const prefixes = ['10.', '172.16.', '172.17.', '172.18.', '172.19.', '172.20.',
    '172.21.', '172.22.', '172.23.', '172.24.', '172.25.', '172.26.',
    '172.27.', '172.28.', '172.29.', '172.30.', '172.31.', '192.168.'];
  return prefixes.some((p) => hostname.startsWith(p));
}

// ── Search Providers (same as internetTools.js) ────────────────

async function searchDuckDuckGo(query, count) {
  const params = new URLSearchParams({ q: query, format: 'json', no_html: '1', skip_disambig: '1' });
  const res = await fetch(`https://api.duckduckgo.com/?${params}`, {
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    headers: { 'User-Agent': 'Tenrary-X/1.0' },
  });
  if (!res.ok) throw new Error(`DuckDuckGo error: ${res.status}`);
  const data = await res.json();
  const results = [];
  if (data.Abstract) results.push({ title: data.Heading || 'Answer', url: data.AbstractURL || '', snippet: data.Abstract });
  for (const t of (data.RelatedTopics || []).slice(0, count)) {
    if (t.Text && t.FirstURL) results.push({ title: t.Text.slice(0, 100), url: t.FirstURL, snippet: t.Text });
  }
  for (const r of (data.Results || []).slice(0, count)) {
    if (r.Text && r.FirstURL) results.push({ title: r.Text.slice(0, 100), url: r.FirstURL, snippet: r.Text });
  }
  return results.slice(0, count);
}

async function searchBrave(query, count, apiKey) {
  const params = new URLSearchParams({ q: query, count: String(count) });
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
  });
  if (!res.ok) throw new Error(`Brave error: ${res.status}`);
  const data = await res.json();
  return (data.web?.results || []).slice(0, count).map((r) => ({ title: r.title, url: r.url, snippet: r.description || '' }));
}

async function searchTavily(query, count, apiKey) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST', signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, query, max_results: count, search_depth: 'basic' }),
  });
  if (!res.ok) throw new Error(`Tavily error: ${res.status}`);
  const data = await res.json();
  return (data.results || []).slice(0, count).map((r) => ({ title: r.title, url: r.url, snippet: r.content || '' }));
}

async function searchSerper(query, count, apiKey) {
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST', signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
    body: JSON.stringify({ q: query, num: count }),
  });
  if (!res.ok) throw new Error(`Serper error: ${res.status}`);
  const data = await res.json();
  return (data.organic || []).slice(0, count).map((r) => ({ title: r.title, url: r.link, snippet: r.snippet || '' }));
}

function detectProvider() {
  if (process.env.SERPER_API_KEY) return 'serper';
  if (process.env.BRAVE_SEARCH_API_KEY) return 'brave';
  if (process.env.TAVILY_API_KEY) return 'tavily';
  return 'duckduckgo';
}

async function executeWebSearch(args) {
  const { query, count = 5 } = args;
  const n = Math.min(Math.max(count, 1), 10);
  const provider = detectProvider();
  let results;
  switch (provider) {
    case 'serper': results = await searchSerper(query, n, process.env.SERPER_API_KEY); break;
    case 'brave': results = await searchBrave(query, n, process.env.BRAVE_SEARCH_API_KEY); break;
    case 'tavily': results = await searchTavily(query, n, process.env.TAVILY_API_KEY); break;
    default: results = await searchDuckDuckGo(query, n);
  }
  return JSON.stringify({ query, provider, count: results.length, results: results.map((r, i) => ({ rank: i + 1, ...r, snippet: r.snippet?.slice(0, 300) })) });
}

// ── HTML → Text ────────────────────────────────────────────────

function htmlToText(html, maxChars) {
  let t = html;
  t = t.replace(/<(script|style|nav|header|footer|aside|noscript)[^>]*>[\s\S]*?<\/\1>/gi, '');
  t = t.replace(/<!--[\s\S]*?-->/g, '');
  t = t.replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre|section|article)>/gi, '\n');
  t = t.replace(/<br\s*\/?>/gi, '\n');
  t = t.replace(/<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
  t = t.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, l, c) => '\n' + '#'.repeat(+l) + ' ' + c.trim() + '\n');
  t = t.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**');
  t = t.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*');
  t = t.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  t = t.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n');
  t = t.replace(/<li[^>]*>/gi, '- ');
  t = t.replace(/<[^>]+>/g, '');
  t = t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
  t = t.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return t.slice(0, maxChars);
}

async function executeWebFetch(args) {
  const { url: urlStr, max_chars = 30000 } = args;
  let url;
  try { url = new URL(urlStr); } catch { return JSON.stringify({ error: `Invalid URL: ${urlStr}` }); }
  if (url.protocol !== 'https:') return JSON.stringify({ error: 'Only HTTPS URLs allowed' });
  if (isBlockedHost(url.hostname)) return JSON.stringify({ error: `Blocked host: ${url.hostname}` });

  const res = await fetch(url.href, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Tenrary-X/1.0)', Accept: 'text/html,application/xhtml+xml,text/plain,application/json' },
    redirect: 'follow',
  });
  if (!res.ok) return JSON.stringify({ error: `HTTP ${res.status}`, url: url.href });

  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    const json = await res.text();
    return JSON.stringify({ url: url.href, content_type: 'json', content: json.slice(0, max_chars) });
  }
  if (ct.includes('text/plain')) {
    const text = await res.text();
    return JSON.stringify({ url: url.href, content_type: 'text', content: text.slice(0, max_chars) });
  }
  const html = await res.text();
  const text = htmlToText(html, max_chars);
  return JSON.stringify({ url: url.href, content_type: 'html', content: text, chars: text.length });
}

// ── Calculator ─────────────────────────────────────────────────

const CALC_OPS = {
  add: (v) => v.reduce((a, b) => a + b, 0),
  subtract: (v) => v.reduce((a, b) => a - b),
  multiply: (v) => v.reduce((a, b) => a * b, 1),
  divide: (v) => { if (v[1] === 0) throw new Error('Division by zero'); return v[0] / v[1]; },
  mod: (v) => { if (v[1] === 0) throw new Error('Modulo by zero'); return v[0] % v[1]; },
  pow: (v) => Math.pow(v[0], v[1]),
  sqrt: (v) => { if (v[0] < 0) throw new Error('Sqrt of negative'); return Math.sqrt(v[0]); },
  log: (v) => Math.log10(v[0]),
  ln: (v) => Math.log(v[0]),
  exp: (v) => Math.exp(v[0]),
  abs: (v) => Math.abs(v[0]),
  floor: (v) => Math.floor(v[0]),
  ceil: (v) => Math.ceil(v[0]),
  round: (v) => Math.round(v[0]),
  average: (v) => v.reduce((a, b) => a + b, 0) / v.length,
  median: (v) => { const s = [...v].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; },
  min: (v) => Math.min(...v),
  max: (v) => Math.max(...v),
  sum: (v) => v.reduce((a, b) => a + b, 0),
  count: (v) => v.length,
};

function executeCalculator(args) {
  const { operation, values, percentile_rank } = args;
  if (!Array.isArray(values) || values.length === 0) return JSON.stringify({ error: 'values required' });
  const nums = values.map(Number);
  if (operation === 'percentile') {
    const r = Number(percentile_rank);
    const s = [...nums].sort((a, b) => a - b);
    const idx = (r / 100) * (s.length - 1);
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    const result = lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo);
    return JSON.stringify({ operation, result: String(result) });
  }
  const fn = CALC_OPS[operation];
  if (!fn) return JSON.stringify({ error: `Unknown operation: ${operation}` });
  return JSON.stringify({ operation, result: String(fn(nums)) });
}

// ── Tool Dispatcher ────────────────────────────────────────────

async function executeTool(name, argsStr) {
  let args;
  try { args = typeof argsStr === 'string' ? JSON.parse(argsStr) : argsStr; } catch { args = {}; }

  try {
    switch (name) {
      case 'web_search': return await executeWebSearch(args);
      case 'web_fetch': return await executeWebFetch(args);
      case 'calculator': return executeCalculator(args);
      default: return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (err) {
    return JSON.stringify({ error: err.message });
  }
}

// ── Public API ─────────────────────────────────────────────────

/**
 * Check if a parsed chat completions payload should use tools.
 */
export function shouldUseTools(parsed) {
  return parsed?.tools_enabled === true;
}

/**
 * Inject tool definitions into the payload and strip the custom flag.
 * Returns the modified payload object (not stringified).
 */
export function injectTools(parsed) {
  const payload = { ...parsed };
  delete payload.tools_enabled;
  payload.tools = CHAT_TOOL_DEFINITIONS;
  payload.tool_choice = 'auto';
  // First call must be non-streaming to detect tool_calls
  payload.stream = false;
  return payload;
}

/**
 * Build a follow-up payload with tool results appended.
 * This one streams the final response.
 */
export function buildFollowUpPayload(originalParsed, assistantMessage, toolResults) {
  const payload = { ...originalParsed };
  delete payload.tools_enabled;
  payload.tools = CHAT_TOOL_DEFINITIONS;

  // Append the assistant's tool_calls message and tool results
  payload.messages = [
    ...(payload.messages || []),
    assistantMessage,
    ...toolResults,
  ];
  payload.stream = true;
  return payload;
}

/**
 * Execute all tool calls from an assistant message.
 * Returns { assistantMessage, toolResultMessages }.
 */
export async function executeToolCalls(assistantMessage) {
  const toolCalls = assistantMessage.tool_calls || [];
  const toolResultMessages = [];

  for (const tc of toolCalls) {
    const result = await executeTool(tc.function?.name, tc.function?.arguments);
    toolResultMessages.push({
      role: 'tool',
      tool_call_id: tc.id,
      content: result,
    });
  }

  return {
    assistantMessage: {
      role: 'assistant',
      content: assistantMessage.content || null,
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.function.name, arguments: tc.function.arguments },
      })),
    },
    toolResultMessages,
  };
}

/**
 * Check if an LLM response contains tool calls.
 */
export function hasToolCalls(responseData) {
  const choice = responseData?.choices?.[0];
  return choice?.finish_reason === 'tool_calls' ||
    (Array.isArray(choice?.message?.tool_calls) && choice.message.tool_calls.length > 0);
}

export { CHAT_TOOL_DEFINITIONS };
