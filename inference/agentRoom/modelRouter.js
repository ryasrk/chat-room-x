/**
 * Agent Room — Model Router (Cloud-Only)
 *
 * Routes agent requests to cloud LLM providers based on model tier or per-agent provider config.
 * No local inference — all tiers route to cloud providers.
 *
 * Tier-based routing (default):
 *   brain       → High-capability (GPT-5.4, Claude Opus) for planning/architecture
 *   worker      → Fast model (Gemini 2.5 Flash) for coding/review
 *   cheap_worker → Same fast model with lower token limits for formatting/simple tasks
 *
 * Per-agent provider config (override):
 *   Each agent can have its own provider_config with:
 *   { provider, base_url, api_key, model, max_tokens, temperature }
 *
 * Supported providers: enowxai, openai, anthropic, custom (any OpenAI-compatible endpoint)
 */

import '../loadEnv.js';

import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';

// ── Configuration ──────────────────────────────────────────────

const ENOWXAI_BASE_URL = process.env.ENOWXAI_BASE_URL || '';
const ENOWXAI_API_KEY = process.env.ENOWXAI_API_KEY || '';
const ENOWXAI_MODEL = process.env.ENOWXAI_MODEL || 'claude-opus-4.6';

/**
 * @typedef {'brain' | 'worker' | 'cheap_worker'} ModelTier
 */

/**
 * @typedef {Object} ModelRoute
 * @property {string} baseURL
 * @property {string} model
 * @property {string} apiKey
 * @property {number} maxTokens
 * @property {number} temperature
 * @property {string} label
 */

/** @type {Record<ModelTier, ModelRoute>} */
const MODEL_ROUTES = {
  brain: {
    baseURL: ENOWXAI_BASE_URL,
    model: ENOWXAI_MODEL,
    apiKey: ENOWXAI_API_KEY,
    maxTokens: 8192,
    temperature: 0.3,
    label: 'Brain (cloud provider)',
  },
  worker: {
    baseURL: ENOWXAI_BASE_URL,
    model: ENOWXAI_MODEL,
    apiKey: ENOWXAI_API_KEY,
    maxTokens: 4096,
    temperature: 0.2,
    label: 'Worker (cloud provider)',
  },
  cheap_worker: {
    baseURL: ENOWXAI_BASE_URL,
    model: ENOWXAI_MODEL,
    apiKey: ENOWXAI_API_KEY,
    maxTokens: 2048,
    temperature: 0.1,
    label: 'Cheap Worker (cloud provider)',
  },
};

// ── System Message Guard ───────────────────────────────────────

const DEFAULT_SYSTEM_MESSAGE = 'You are a helpful assistant.';

/**
 * Ensure the messages array contains at least one system message.
 * Some providers (e.g. enowxai) reject payloads without a system message.
 */
function ensureSystemMessage(messages) {
  if (Array.isArray(messages) && messages.some((m) => m.role === 'system')) {
    return messages;
  }
  return [{ role: 'system', content: DEFAULT_SYSTEM_MESSAGE }, ...(messages || [])];
}

// ── Streaming Chat Completion ──────────────────────────────────

/**
 * Send a chat completion request to the appropriate model.
 *
 * @param {ModelTier} tier - Model tier to route to
 * @param {Array<{role: string, content: string}>} messages - Chat messages
 * @param {Object} [options]
 * @param {string} [options.systemPrompt] - System prompt override
 * @param {number} [options.maxTokens] - Max tokens override
 * @param {number} [options.temperature] - Temperature override
 * @param {boolean} [options.stream=false] - Whether to stream
 * @returns {Promise<{content: string, model: string, tier: string, usage: Object}>}
 */
export async function chatCompletion(tier, messages, options = {}) {
  const route = MODEL_ROUTES[tier];
  if (!route) {
    throw new Error(`Unknown model tier: ${tier}`);
  }

  const systemPrompt = options.systemPrompt;
  const fullMessages = ensureSystemMessage(
    systemPrompt
      ? [{ role: 'system', content: systemPrompt }, ...messages]
      : messages,
  );

  const payload = {
    model: route.model,
    messages: fullMessages,
    max_tokens: options.maxTokens || route.maxTokens,
    temperature: options.temperature ?? route.temperature,
    stream: false,
  };

  const body = JSON.stringify(payload);
  const url = new URL('/v1/chat/completions', route.baseURL);

  return new Promise((resolve, reject) => {
    const reqFn = url.protocol === 'https:' ? httpsRequest : httpRequest;

    const req = reqFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...(route.apiKey ? { 'Authorization': `Bearer ${route.apiKey}` } : {}),
      },
      timeout: 120_000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          if (res.statusCode >= 400) {
            reject(new Error(`Model API error (${res.statusCode}): ${data.slice(0, 500)}`));
            return;
          }
          const json = JSON.parse(data);
          const content = json.choices?.[0]?.message?.content || '';
          resolve({
            content,
            model: json.model || route.model,
            tier,
            usage: json.usage || {},
          });
        } catch (err) {
          reject(new Error(`Failed to parse model response: ${err.message}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Model request timed out (tier: ${tier})`));
    });

    req.write(body);
    req.end();
  });
}

/**
 * Stream a chat completion, yielding chunks via callback.
 *
 * @param {ModelTier} tier
 * @param {Array<{role: string, content: string}>} messages
 * @param {(chunk: string) => void} onChunk - Called for each text chunk
 * @param {Object} [options]
 * @returns {Promise<{content: string, model: string, tier: string}>}
 */
export async function streamChatCompletion(tier, messages, onChunk, options = {}) {
  const route = MODEL_ROUTES[tier];
  if (!route) {
    throw new Error(`Unknown model tier: ${tier}`);
  }

  const systemPrompt = options.systemPrompt;
  const fullMessages = ensureSystemMessage(
    systemPrompt
      ? [{ role: 'system', content: systemPrompt }, ...messages]
      : messages,
  );

  const payload = {
    model: route.model,
    messages: fullMessages,
    max_tokens: options.maxTokens || route.maxTokens,
    temperature: options.temperature ?? route.temperature,
    stream: true,
  };

  const body = JSON.stringify(payload);
  const url = new URL('/v1/chat/completions', route.baseURL);

  return new Promise((resolve, reject) => {
    const reqFn = url.protocol === 'https:' ? httpsRequest : httpRequest;
    let fullContent = '';

    const req = reqFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...(route.apiKey ? { 'Authorization': `Bearer ${route.apiKey}` } : {}),
      },
      timeout: 120_000,
    }, (res) => {
      if (res.statusCode >= 400) {
        let errData = '';
        res.on('data', chunk => { errData += chunk; });
        res.on('end', () => reject(new Error(`Model API error (${res.statusCode}): ${errData.slice(0, 500)}`)));
        return;
      }

      let buffer = '';
      res.on('data', chunk => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6);
          if (data === '[DONE]') continue;

          try {
            const json = JSON.parse(data);
            const delta = json.choices?.[0]?.delta?.content || '';
            if (delta) {
              fullContent += delta;
              onChunk(delta);
            }
          } catch {
            // Skip malformed SSE lines
          }
        }
      });

      res.on('end', () => {
        resolve({
          content: fullContent,
          model: route.model,
          tier,
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Stream request timed out (tier: ${tier})`));
    });

    req.write(body);
    req.end();
  });
}

/**
 * Get available model routes and their status.
 * @returns {Record<ModelTier, {label: string, available: boolean}>}
 */
export function getModelRoutes() {
  return Object.fromEntries(
    Object.entries(MODEL_ROUTES).map(([tier, route]) => [
      tier,
      {
        label: route.label,
        model: route.model,
        available: tier === 'cheap_worker' || !!route.apiKey || route.baseURL.includes('127.0.0.1'),
      },
    ])
  );
}

// ── Provider Presets ───────────────────────────────────────────

/**
 * @typedef {Object} ProviderConfig
 * @property {string} provider - 'enowxai' | 'openai' | 'anthropic' | 'custom'
 * @property {string} [base_url] - API base URL (auto-filled for known providers)
 * @property {string} [api_key] - API key for the provider
 * @property {string} [model] - Model name
 * @property {number} [max_tokens] - Max tokens for completion
 * @property {number} [temperature] - Temperature for sampling
 */

const PROVIDER_PRESETS = {
  enowxai: {
    base_url: ENOWXAI_BASE_URL,
    api_key: ENOWXAI_API_KEY,
    api_path: '/v1/chat/completions',
    format: 'openai',
    default_model: ENOWXAI_MODEL,
    default_max_tokens: 4096,
    default_temperature: 0.2,
  },
  openai: {
    base_url: 'https://api.openai.com',
    api_path: '/v1/chat/completions',
    format: 'openai',
    default_model: 'gpt-4o-mini',
    default_max_tokens: 4096,
    default_temperature: 0.3,
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'o4-mini', 'o3', 'o3-mini'],
  },
  anthropic: {
    base_url: 'https://api.anthropic.com',
    api_path: '/v1/messages',
    format: 'anthropic',
    default_model: 'claude-sonnet-4-20250514',
    default_max_tokens: 4096,
    default_temperature: 0.3,
    models: ['claude-opus-4-20250514', 'claude-sonnet-4-20250514', 'claude-haiku-3-20250414'],
  },
  custom: {
    base_url: '',
    api_path: '/v1/chat/completions',
    format: 'openai',
    default_model: '',
    default_max_tokens: 4096,
    default_temperature: 0.3,
  },
};

/**
 * Get provider presets for the dashboard UI.
 * @returns {Record<string, Object>}
 */
export function getProviderPresets() {
  return Object.fromEntries(
    Object.entries(PROVIDER_PRESETS).map(([key, preset]) => [
      key,
      {
        base_url: preset.base_url,
        default_model: preset.default_model,
        default_max_tokens: preset.default_max_tokens,
        default_temperature: preset.default_temperature,
        models: preset.models || [],
      },
    ])
  );
}

async function fetchOpenAICompatibleModels(baseURL, apiKey = '') {
  if (!baseURL) {
    return [];
  }

  const url = new URL('/v1/models', baseURL);

  return new Promise((resolve, reject) => {
    const reqFn = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = reqFn(url, {
      method: 'GET',
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      timeout: 15_000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        if ((res.statusCode || 500) >= 400) {
          reject(new Error(`Model list request failed with status ${res.statusCode}`));
          return;
        }

        try {
          const parsed = JSON.parse(data || '{}');
          const models = Array.isArray(parsed?.data)
            ? parsed.data
            : Array.isArray(parsed?.models)
              ? parsed.models
              : [];

          resolve(models
            .map((entry) => {
              if (typeof entry === 'string') return entry.trim();
              if (entry && typeof entry === 'object' && typeof entry.id === 'string') {
                return entry.id.trim();
              }
              return '';
            })
            .filter(Boolean));
        } catch (error) {
          reject(new Error(`Failed to parse model list: ${error.message}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Model list request timed out'));
    });
    req.end();
  });
}

export async function getProviderPresetsForUi() {
  const presets = getProviderPresets();

  if (ENOWXAI_BASE_URL) {
    try {
      const models = await fetchOpenAICompatibleModels(ENOWXAI_BASE_URL, ENOWXAI_API_KEY);
      if (models.length > 0) {
        presets.enowxai = {
          ...presets.enowxai,
          models,
        };
      }
    } catch {
      // Keep static defaults if live model fetching fails.
    }
  }

  return presets;
}

export async function fetchProviderModelsForUi(provider) {
  const normalized = String(provider || '').trim().toLowerCase();
  if (!normalized) return [];

  if (normalized === 'enowxai') {
    if (!ENOWXAI_BASE_URL) return [];
    try {
      return await fetchOpenAICompatibleModels(ENOWXAI_BASE_URL, ENOWXAI_API_KEY);
    } catch {
      return [];
    }
  }

  const presets = getProviderPresets();
  return Array.isArray(presets?.[normalized]?.models) ? presets[normalized].models : [];
}

// ── Anthropic API Format ───────────────────────────────────────

function buildAnthropicPayload(messages, model, maxTokens, temperature, systemPrompt) {
  const anthropicMessages = [];
  for (const msg of messages) {
    if (msg.role === 'system') continue;
    anthropicMessages.push({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: msg.content,
    });
  }

  return {
    model,
    max_tokens: maxTokens,
    temperature,
    ...(systemPrompt ? { system: systemPrompt } : {}),
    messages: anthropicMessages,
  };
}

function parseAnthropicResponse(data) {
  const json = JSON.parse(data);
  const textBlocks = (json.content || []).filter((b) => b.type === 'text');
  const content = textBlocks.map((b) => b.text).join('');
  return {
    content,
    model: json.model || '',
    usage: {
      prompt_tokens: json.usage?.input_tokens || 0,
      completion_tokens: json.usage?.output_tokens || 0,
      total_tokens: (json.usage?.input_tokens || 0) + (json.usage?.output_tokens || 0),
    },
  };
}

function formatOpenAITools(tools = []) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return undefined;
  }

  return tools
    .filter((tool) => tool && typeof tool === 'object' && tool.name)
    .map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: tool.schema || {
          type: 'object',
          properties: {},
        },
      },
    }));
}

function parseOpenAIToolCalls(message = {}) {
  const toolCalls = [];
  const rawToolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

  for (const rawCall of rawToolCalls) {
    const name = rawCall?.function?.name || rawCall?.name || '';
    const rawArgs = rawCall?.function?.arguments ?? rawCall?.arguments ?? '{}';
    if (!name) continue;

    let args = {};
    try {
      args = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : (rawArgs || {});
    } catch {
      args = {};
    }

    toolCalls.push({
      id: rawCall.id || `${name}_${toolCalls.length}`,
      name,
      args,
      type: 'tool_call',
    });
  }

  if (toolCalls.length === 0 && message.function_call?.name) {
    let args = {};
    try {
      args = JSON.parse(message.function_call.arguments || '{}');
    } catch {
      args = {};
    }

    toolCalls.push({
      id: message.function_call.id || `${message.function_call.name}_0`,
      name: message.function_call.name,
      args,
      type: 'tool_call',
    });
  }

  return toolCalls;
}

// ── Per-Agent Config Completion ────────────────────────────────

/**
 * Resolve a route from per-agent provider config, falling back to tier-based routing.
 *
 * @param {ProviderConfig|null} providerConfig - Per-agent provider config (from DB)
 * @param {ModelTier} tier - Fallback model tier
 * @returns {{ baseURL: string, apiPath: string, model: string, apiKey: string, maxTokens: number, temperature: number, format: string }}
 */
function resolveRoute(providerConfig, tier) {
  const config = providerConfig && typeof providerConfig === 'object' ? providerConfig : {};
  const provider = config.provider || '';

  if (!provider || provider === 'tier') {
    const route = MODEL_ROUTES[tier] || MODEL_ROUTES.worker;
    if (!route.baseURL || !route.model) {
      throw new Error('EnowxAI provider is not configured for agent rooms. Set ENOWXAI_BASE_URL and ENOWXAI_MODEL.');
    }
    return {
      baseURL: route.baseURL,
      apiPath: '/v1/chat/completions',
      model: route.model,
      apiKey: route.apiKey,
      maxTokens: route.maxTokens,
      temperature: route.temperature,
      format: 'openai',
    };
  }

  const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.custom;
  if (provider === 'enowxai' && !(config.base_url || preset.base_url) ) {
    throw new Error('EnowxAI provider is not configured for agent rooms. Set ENOWXAI_BASE_URL.');
  }
  return {
    baseURL: config.base_url || preset.base_url,
    apiPath: preset.api_path,
    model: config.model || preset.default_model,
    apiKey: config.api_key || preset.api_key || '',
    maxTokens: config.max_tokens || preset.default_max_tokens,
    temperature: config.temperature ?? preset.default_temperature,
    format: preset.format,
  };
}

/**
 * Send a chat completion using per-agent provider config with tier fallback.
 *
 * @param {ProviderConfig|null} providerConfig - Per-agent provider config
 * @param {ModelTier} tier - Fallback model tier
 * @param {Array<{role: string, content: string}>} messages - Chat messages
 * @param {Object} [options]
 * @param {string} [options.systemPrompt] - System prompt
 * @param {number} [options.maxTokens] - Max tokens override
 * @param {number} [options.temperature] - Temperature override
 * @param {Array<{name: string, description: string, schema: Object}>} [options.tools] - Native tool definitions
 * @param {'auto' | 'none' | Object} [options.toolChoice] - Tool choice hint for provider-native calling
 * @returns {Promise<{content: string, model: string, tier: string, provider: string, usage: Object, toolCalls: Array<Object>}>}
 */
export async function chatCompletionWithConfig(providerConfig, tier, messages, options = {}) {
  const resolved = resolveRoute(providerConfig, tier);
  const systemPrompt = options.systemPrompt;
  const maxTokens = options.maxTokens || resolved.maxTokens;
  const temperature = options.temperature ?? resolved.temperature;
  const tools = formatOpenAITools(options.tools);

  const fullMessages = ensureSystemMessage(
    systemPrompt
      ? [{ role: 'system', content: systemPrompt }, ...messages]
      : messages,
  );

  let body;
  let apiPath = resolved.apiPath;
  let headers = {
    'Content-Type': 'application/json',
  };

  if (resolved.format === 'anthropic') {
    body = JSON.stringify(buildAnthropicPayload(fullMessages, resolved.model, maxTokens, temperature, systemPrompt));
    headers['x-api-key'] = resolved.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    const payload = {
      model: resolved.model,
      messages: fullMessages,
      max_tokens: maxTokens,
      temperature,
      stream: false,
    };

    if (tools) {
      payload.tools = tools;
      payload.tool_choice = options.toolChoice || 'auto';
    }

    body = JSON.stringify(payload);
    if (resolved.apiKey) {
      headers['Authorization'] = `Bearer ${resolved.apiKey}`;
    }
  }

  headers['Content-Length'] = Buffer.byteLength(body);
  const url = new URL(apiPath, resolved.baseURL);

  return new Promise((resolve, reject) => {
    const reqFn = url.protocol === 'https:' ? httpsRequest : httpRequest;

    const req = reqFn(url, {
      method: 'POST',
      headers,
      timeout: 120_000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          if (res.statusCode >= 400) {
            reject(new Error(`Model API error (${res.statusCode}): ${data.slice(0, 500)}`));
            return;
          }

          let content, model, usage;
          let toolCalls = [];
          if (resolved.format === 'anthropic') {
            const parsed = parseAnthropicResponse(data);
            content = parsed.content;
            model = parsed.model;
            usage = parsed.usage;
          } else {
            const json = JSON.parse(data);
            const message = json.choices?.[0]?.message || {};
            content = message.content || '';
            model = json.model || resolved.model;
            usage = json.usage || {};
            toolCalls = parseOpenAIToolCalls(message);
          }

          resolve({
            content,
            model,
            tier,
            provider: providerConfig?.provider || 'tier',
            usage,
            toolCalls,
          });
        } catch (err) {
          reject(new Error(`Failed to parse model response: ${err.message}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Model request timed out (provider: ${providerConfig?.provider || tier})`));
    });

    req.write(body);
    req.end();
  });
}
