/**
 * LangChain Structured Tools — Internet Operations
 *
 * Gives agents the ability to search the web, fetch pages, and make HTTP requests.
 * Inspired by NullClaw's web_search, web_fetch, and http_request tools.
 *
 *   - web_search:    Multi-provider web search (DuckDuckGo free, Brave, Tavily, Serper)
 *   - web_fetch:     Fetch a URL and extract readable text/markdown
 *   - http_request:  Make HTTP requests to external APIs (HTTPS-only)
 */

import { DynamicStructuredTool } from '@langchain/core/tools';

// ── Constants ──────────────────────────────────────────────────
const SEARCH_TIMEOUT_MS = 15_000;
const FETCH_TIMEOUT_MS = 20_000;
const HTTP_TIMEOUT_MS = 30_000;
const MAX_FETCH_CHARS = 50_000;
const MAX_HTTP_RESPONSE_SIZE = 512 * 1024; // 512 KB
const MAX_SEARCH_RESULTS = 10;

// Blocked hosts for SSRF protection
const BLOCKED_HOSTS = new Set([
  'localhost', '127.0.0.1', '0.0.0.0', '::1',
  'metadata.google.internal', '169.254.169.254',
  'metadata.google.com',
]);

const BLOCKED_HOST_PREFIXES = [
  '10.', '172.16.', '172.17.', '172.18.', '172.19.',
  '172.20.', '172.21.', '172.22.', '172.23.', '172.24.',
  '172.25.', '172.26.', '172.27.', '172.28.', '172.29.',
  '172.30.', '172.31.', '192.168.',
];

// ── SSRF Protection ────────────────────────────────────────────

function isBlockedHost(hostname) {
  if (BLOCKED_HOSTS.has(hostname)) return true;
  return BLOCKED_HOST_PREFIXES.some((p) => hostname.startsWith(p));
}

function validateUrl(urlStr, requireHttps = true) {
  let url;
  try {
    url = new URL(urlStr);
  } catch {
    throw new Error(`Invalid URL: ${urlStr}`);
  }
  if (requireHttps && url.protocol !== 'https:') {
    throw new Error(`Only HTTPS URLs are allowed. Got: ${url.protocol}`);
  }
  if (!requireHttps && !['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`Only HTTP/HTTPS URLs are allowed. Got: ${url.protocol}`);
  }
  if (isBlockedHost(url.hostname)) {
    throw new Error(`Blocked host: ${url.hostname} (SSRF protection)`);
  }
  return url;
}

// ── Search Providers ───────────────────────────────────────────

/**
 * DuckDuckGo Instant Answer API (free, no key required).
 */
async function searchDuckDuckGo(query, count) {
  const params = new URLSearchParams({
    q: query, format: 'json', no_html: '1', skip_disambig: '1',
  });
  const res = await fetch(`https://api.duckduckgo.com/?${params}`, {
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    headers: { 'User-Agent': 'Tenrary-X/1.0' },
  });
  if (!res.ok) throw new Error(`DuckDuckGo API error: ${res.status}`);
  const data = await res.json();

  const results = [];
  // Abstract (main answer)
  if (data.Abstract) {
    results.push({ title: data.Heading || 'Answer', url: data.AbstractURL || '', snippet: data.Abstract });
  }
  // Related topics
  for (const topic of (data.RelatedTopics || []).slice(0, count)) {
    if (topic.Text && topic.FirstURL) {
      results.push({ title: topic.Text.slice(0, 100), url: topic.FirstURL, snippet: topic.Text });
    }
  }
  // Results array
  for (const r of (data.Results || []).slice(0, count)) {
    if (r.Text && r.FirstURL) {
      results.push({ title: r.Text.slice(0, 100), url: r.FirstURL, snippet: r.Text });
    }
  }
  return results.slice(0, count);
}

/**
 * Brave Search API (requires BRAVE_SEARCH_API_KEY).
 */
async function searchBrave(query, count, apiKey) {
  const params = new URLSearchParams({ q: query, count: String(count) });
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    headers: { 'Accept': 'application/json', 'X-Subscription-Token': apiKey },
  });
  if (!res.ok) throw new Error(`Brave Search API error: ${res.status}`);
  const data = await res.json();
  return (data.web?.results || []).slice(0, count).map((r) => ({
    title: r.title || '', url: r.url || '', snippet: r.description || '',
  }));
}

/**
 * Tavily Search API (requires TAVILY_API_KEY).
 */
async function searchTavily(query, count, apiKey) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, query, max_results: count, search_depth: 'basic' }),
  });
  if (!res.ok) throw new Error(`Tavily API error: ${res.status}`);
  const data = await res.json();
  return (data.results || []).slice(0, count).map((r) => ({
    title: r.title || '', url: r.url || '', snippet: r.content || '',
  }));
}

/**
 * Serper.dev Google Search API (requires SERPER_API_KEY).
 */
async function searchSerper(query, count, apiKey) {
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
    body: JSON.stringify({ q: query, num: count }),
  });
  if (!res.ok) throw new Error(`Serper API error: ${res.status}`);
  const data = await res.json();
  return (data.organic || []).slice(0, count).map((r) => ({
    title: r.title || '', url: r.link || '', snippet: r.snippet || '',
  }));
}

/**
 * Auto-detect best available search provider.
 */
function detectSearchProvider() {
  if (process.env.SERPER_API_KEY) return 'serper';
  if (process.env.BRAVE_SEARCH_API_KEY) return 'brave';
  if (process.env.TAVILY_API_KEY) return 'tavily';
  return 'duckduckgo'; // Free fallback
}

async function executeSearch(query, count, provider) {
  switch (provider) {
    case 'brave':
      return searchBrave(query, count, process.env.BRAVE_SEARCH_API_KEY);
    case 'tavily':
      return searchTavily(query, count, process.env.TAVILY_API_KEY);
    case 'serper':
      return searchSerper(query, count, process.env.SERPER_API_KEY);
    case 'duckduckgo':
    default:
      return searchDuckDuckGo(query, count);
  }
}

// ── HTML → Text Extraction ─────────────────────────────────────

/**
 * Strip HTML tags and extract readable text content.
 * Lightweight — no external dependency needed.
 */
function htmlToText(html, maxChars = MAX_FETCH_CHARS) {
  let text = html;
  // Remove script/style/nav/header/footer blocks
  text = text.replace(/<(script|style|nav|header|footer|aside|noscript)[^>]*>[\s\S]*?<\/\1>/gi, '');
  // Remove HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  // Convert common block elements to newlines
  text = text.replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre|section|article)>/gi, '\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<hr\s*\/?>/gi, '\n---\n');
  // Convert links to markdown-style
  text = text.replace(/<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
  // Convert headings to markdown
  text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, content) => {
    return '\n' + '#'.repeat(parseInt(level)) + ' ' + content.trim() + '\n';
  });
  // Convert bold/italic
  text = text.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**');
  text = text.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*');
  // Convert code blocks
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n');
  // Convert list items
  text = text.replace(/<li[^>]*>/gi, '- ');
  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, '');
  // Decode HTML entities
  text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
  // Normalize whitespace
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.trim();
  return text.slice(0, maxChars);
}

// ── Tool Factory ───────────────────────────────────────────────

/**
 * Create internet tools for the agent room.
 *
 * @param {Object} context
 * @param {string} context.agentName
 * @returns {DynamicStructuredTool[]}
 */
export function createInternetTools(context = {}) {
  const tools = [];

  // ── web_search ─────────────────────────────────────────────
  tools.push(new DynamicStructuredTool({
    name: 'web_search',
    description:
      'Search the web for information. Returns titles, URLs, and snippets. ' +
      'Use this to research topics, find documentation, look up error messages, ' +
      'or discover solutions. Auto-detects the best available search provider ' +
      '(Serper/Brave/Tavily/DuckDuckGo).',
    schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query. Be specific for better results.',
        },
        count: {
          type: 'number',
          description: 'Number of results to return (1-10). Default: 5.',
          default: 5,
        },
        provider: {
          type: 'string',
          description: 'Optional provider override: duckduckgo, brave, tavily, serper. Auto-detected if omitted.',
        },
      },
      required: ['query'],
    },
    func: async ({ query, count = 5, provider }) => {
      try {
        const effectiveCount = Math.min(Math.max(count || 5, 1), MAX_SEARCH_RESULTS);
        const effectiveProvider = provider || detectSearchProvider();

        const results = await executeSearch(query, effectiveCount, effectiveProvider);

        if (results.length === 0) {
          return JSON.stringify({ results: [], message: `No results found for: "${query}"`, provider: effectiveProvider });
        }

        return JSON.stringify({
          query,
          provider: effectiveProvider,
          count: results.length,
          results: results.map((r, i) => ({
            rank: i + 1,
            title: r.title,
            url: r.url,
            snippet: r.snippet?.slice(0, 300) || '',
          })),
        });
      } catch (err) {
        return JSON.stringify({ error: err.message, query });
      }
    },
  }));

  // ── web_fetch ──────────────────────────────────────────────
  tools.push(new DynamicStructuredTool({
    name: 'web_fetch',
    description:
      'Fetch a web page and extract its text content as readable markdown. ' +
      'Use after web_search to read full page content. ' +
      'Converts HTML to clean text with markdown formatting. HTTPS only.',
    schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'HTTPS URL to fetch.',
        },
        max_chars: {
          type: 'number',
          description: 'Maximum characters to return. Default: 50000.',
          default: 50000,
        },
      },
      required: ['url'],
    },
    func: async ({ url, max_chars = MAX_FETCH_CHARS }) => {
      try {
        const validatedUrl = validateUrl(url, true);
        const maxChars = Math.min(Math.max(max_chars || MAX_FETCH_CHARS, 1000), 100_000);

        const res = await fetch(validatedUrl.href, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; Tenrary-X/1.0; +https://tenrary.com)',
            'Accept': 'text/html,application/xhtml+xml,text/plain,application/json',
          },
          redirect: 'follow',
        });

        if (!res.ok) {
          return JSON.stringify({ error: `HTTP ${res.status}: ${res.statusText}`, url });
        }

        const contentType = res.headers.get('content-type') || '';

        // JSON response — return as-is
        if (contentType.includes('application/json')) {
          const json = await res.text();
          return JSON.stringify({
            url, content_type: 'json',
            content: json.slice(0, maxChars),
            truncated: json.length > maxChars,
          });
        }

        // Plain text — return directly
        if (contentType.includes('text/plain')) {
          const text = await res.text();
          return JSON.stringify({
            url, content_type: 'text',
            content: text.slice(0, maxChars),
            truncated: text.length > maxChars,
          });
        }

        // HTML — convert to readable text
        const html = await res.text();
        const text = htmlToText(html, maxChars);

        return JSON.stringify({
          url, content_type: 'html',
          content: text,
          chars: text.length,
          truncated: text.length >= maxChars,
        });
      } catch (err) {
        return JSON.stringify({ error: err.message, url });
      }
    },
  }));

  // ── http_request ───────────────────────────────────────────
  tools.push(new DynamicStructuredTool({
    name: 'http_request',
    description:
      'Make HTTP/HTTPS requests to external APIs. ' +
      'Supports GET, POST, PUT, PATCH, DELETE methods. ' +
      'Use for testing APIs, fetching data, or calling webhooks. ' +
      'SSRF protection blocks private/internal IPs.',
    schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'URL to request (HTTPS recommended).',
        },
        method: {
          type: 'string',
          description: 'HTTP method: GET, POST, PUT, PATCH, DELETE. Default: GET.',
          default: 'GET',
        },
        headers: {
          type: 'object',
          description: 'Optional HTTP headers as key-value pairs.',
        },
        body: {
          type: 'string',
          description: 'Optional request body (for POST/PUT/PATCH). JSON string or plain text.',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds. Default: 30000.',
          default: 30000,
        },
      },
      required: ['url'],
    },
    func: async ({ url, method = 'GET', headers = {}, body, timeout = HTTP_TIMEOUT_MS }) => {
      try {
        const validatedUrl = validateUrl(url, false); // Allow HTTP for local dev APIs
        const effectiveMethod = (method || 'GET').toUpperCase();
        const effectiveTimeout = Math.min(Math.max(timeout || HTTP_TIMEOUT_MS, 1000), 60_000);

        const fetchOpts = {
          method: effectiveMethod,
          signal: AbortSignal.timeout(effectiveTimeout),
          headers: {
            'User-Agent': 'Tenrary-X/1.0',
            ...headers,
          },
          redirect: 'follow',
        };

        if (body && ['POST', 'PUT', 'PATCH'].includes(effectiveMethod)) {
          fetchOpts.body = body;
          if (!fetchOpts.headers['Content-Type'] && !fetchOpts.headers['content-type']) {
            // Auto-detect JSON
            try { JSON.parse(body); fetchOpts.headers['Content-Type'] = 'application/json'; } catch { /* not JSON */ }
          }
        }

        const res = await fetch(validatedUrl.href, fetchOpts);
        const responseText = await res.text();
        const truncated = responseText.length > MAX_HTTP_RESPONSE_SIZE;
        const content = truncated ? responseText.slice(0, MAX_HTTP_RESPONSE_SIZE) : responseText;

        // Redact sensitive headers from response
        const safeHeaders = {};
        for (const [k, v] of res.headers.entries()) {
          if (/auth|token|key|secret|cookie/i.test(k)) {
            safeHeaders[k] = '[REDACTED]';
          } else {
            safeHeaders[k] = v;
          }
        }

        return JSON.stringify({
          status: res.status,
          statusText: res.statusText,
          headers: safeHeaders,
          body: content,
          truncated,
          url: validatedUrl.href,
          method: effectiveMethod,
        });
      } catch (err) {
        return JSON.stringify({ error: err.message, url, method });
      }
    },
  }));

  return tools;
}
