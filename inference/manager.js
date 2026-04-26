/**
 * Tenrary-X Cloud Inference Manager
 * Cloud-only variant — all inference routed to cloud providers (no local llama-server).
 * Exposes a control API on :18247 and proxies inference to cloud provider endpoints.
 */

import './loadEnv.js';

import { Agent as HttpAgent, createServer, request as httpRequest } from 'http';
import { Agent as HttpsAgent } from 'https';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from 'redis';
import { WebSocketServer } from 'ws';
import { exec } from 'child_process';
import { promisify } from 'util';

import { buildCacheKey, CACHE_TTLS, RequestCache, shouldCacheRequest } from './requestCache.js';
import { sendCompressedJson } from './compression.js';
import { getCacheStats, closeDatabase } from './db/database.js';
import { handleAgentRoomUpgrade } from './agentRoom/wsBridge.js';
import { buildChatCompletionPayload, parseSseLine, splitSseLines } from './streamProxy.js';
import { shouldUseTools, injectTools, buildFollowUpPayload, buildFinalPayload, executeToolCalls, hasToolCalls } from './chatTools.js';
import { routeApiRequest } from './routes/apiRouter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__dirname, '..');

const CONTROL_PORT = parseInt(process.env.CONTROL_PORT, 10) || 18247;
const MAX_WS_CONNECTIONS = 32;
const MAX_WS_PER_IP = 4;
const MAX_STREAM_BUFFER_SIZE = 64 * 1024;
const STREAM_REQUEST_COOLDOWN_MS = 250;
const UPSTREAM_REQUEST_TIMEOUT_MS = 45_000;

const DASHBOARD_ORIGIN = process.env.DASHBOARD_ORIGIN || '';
const CONTROL_API_KEY = process.env.CONTROL_API_KEY || '';
const ENOWXAI_BASE_URL = process.env.ENOWXAI_BASE_URL || '';
const ENOWXAI_API_KEY = process.env.ENOWXAI_API_KEY || '';
const ENOWXAI_MODEL = process.env.ENOWXAI_MODEL || '';
const REDIS_URL = process.env.REDIS_URL || '';
const MAX_PROXY_BODY_SIZE = 512 * 1024;
const MAX_BUFFERED_PROXY_RESPONSE_SIZE = 2 * 1024 * 1024;
const SUPPORTED_PROXY_GET_PATHS = new Set(['/v1/models']);
const SUPPORTED_PROXY_POST_PATHS = new Set(['/v1/chat/completions', '/v1/responses', '/v1/messages']);

// ── JSON response helper (compressed for large payloads) ──────
function sendJson(req, res, statusCode, data, extraHeaders = {}) {
  return sendCompressedJson(req, res, statusCode, data, extraHeaders);
}

// ── Gateway Restart Helper ─────────────────────────────────────
const execAsync = promisify(exec);
const BASH_EXEC_OPTS = { shell: '/bin/bash', env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` } };

async function restartEnowxaiGateway() {
  const steps = [];

  try {
    // Step 1: enowxai stop
    console.log('[restart-gateway] Step 1/3 — enowxai stop...');
    try {
      const { stdout, stderr } = await execAsync('enowxai stop', { ...BASH_EXEC_OPTS, timeout: 10000 });
      console.log('[restart-gateway] enowxai stop completed');
      if (stdout?.trim()) console.log('[restart-gateway] stdout:', stdout.trim());
      steps.push({ step: 'enowxai stop', status: 'ok' });
    } catch (stopErr) {
      console.warn('[restart-gateway] enowxai stop warning:', stopErr.message);
      steps.push({ step: 'enowxai stop', status: 'warning', detail: stopErr.message });
      // Continue — we'll force-kill next
    }

    // Step 2: Kill port 1431 PID
    console.log('[restart-gateway] Step 2/3 — killing port 1431 PID...');
    try {
      const { stdout: pids } = await execAsync('lsof -ti:1431 2>/dev/null || true', BASH_EXEC_OPTS);
      const pidList = pids.trim().split('\n').filter(Boolean);

      if (pidList.length > 0) {
        await execAsync(`lsof -ti:1431 | xargs kill -9 2>/dev/null || true`, BASH_EXEC_OPTS);
        console.log(`[restart-gateway] Killed PIDs on port 1431: ${pidList.join(', ')}`);
        steps.push({ step: 'kill port 1431', status: 'ok', pids: pidList });
      } else {
        console.log('[restart-gateway] No process found on port 1431');
        steps.push({ step: 'kill port 1431', status: 'ok', detail: 'no process on port' });
      }
    } catch (killErr) {
      console.warn('[restart-gateway] Kill port 1431 warning:', killErr.message);
      steps.push({ step: 'kill port 1431', status: 'warning', detail: killErr.message });
    }

    // Wait for port to be released
    await new Promise(resolve => setTimeout(resolve, 1500));

    // Step 3: enowxai start
    console.log('[restart-gateway] Step 3/3 — enowxai start...');
    try {
      const { stdout, stderr } = await execAsync('enowxai start', { ...BASH_EXEC_OPTS, timeout: 15000 });
      console.log('[restart-gateway] enowxai start completed');
      if (stdout?.trim()) console.log('[restart-gateway] stdout:', stdout.trim());
      if (stderr && !stderr.includes('already') && !stderr.includes('Starting')) {
        console.warn('[restart-gateway] startup stderr:', stderr.trim());
      }
      steps.push({ step: 'enowxai start', status: 'ok' });
    } catch (startErr) {
      console.error('[restart-gateway] enowxai start failed:', startErr.message);
      steps.push({ step: 'enowxai start', status: 'error', detail: startErr.message });
      throw new Error(`enowxai start failed: ${startErr.message}`);
    }

    console.log('[restart-gateway] Gateway restart completed successfully');
    return {
      status: 'success',
      message: 'EnowxAI gateway restarted (stop → kill 1431 → start)',
      steps,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[restart-gateway] Error:', message);
    throw new Error(`Failed to restart gateway: ${message}`);
  }
}

// ── Keep-Alive Agents (reuse TCP connections to cloud providers) ──
const remoteHttpAgent = new HttpAgent({ keepAlive: true, maxSockets: 8, keepAliveMsecs: 30_000 });
const remoteHttpsAgent = new HttpsAgent({ keepAlive: true, maxSockets: 8, keepAliveMsecs: 30_000 });

// ── Request Queue ──────────────────────────────────────────────
const requestQueue = [];
let activeSlots = 0;
const MAX_QUEUE_SIZE = 10;

const MODES = {
  enowxai: {
    type: 'provider',
    label: `EnowxAI (${ENOWXAI_MODEL || 'cloud'})`,
    baseURL: ENOWXAI_BASE_URL,
    apiKey: ENOWXAI_API_KEY,
    model: ENOWXAI_MODEL,
  },
};

let currentMode = null;

function getDashboardOrigins() {
  const origins = [];

  if (DASHBOARD_ORIGIN) {
    origins.push(
      ...DASHBOARD_ORIGIN.split(',').map((v) => v.trim()).filter(Boolean),
    );
  } else {
    origins.push(
      'http://localhost:7391',
      'http://localhost:7392',
      'http://127.0.0.1:7391',
      'http://127.0.0.1:7392',
    );
  }

  // Auto-allow ngrok domain when configured
  const ngrokDomain = process.env.NGROK_DOMAIN || '';
  if (ngrokDomain) {
    origins.push(`https://${ngrokDomain}`, `http://${ngrokDomain}`);
  }

  return origins;
}

function getCorsOrigin(requestOrigin) {
  const allowedOrigins = getDashboardOrigins();
  if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
    return requestOrigin;
  }
  return allowedOrigins[0] || 'http://localhost:7391';
}
let activeWebSocketConnections = 0;
// Cloud providers handle concurrency — generous parallel slots
let maxParallelSlots = 8;
const wsConnectionsByIp = new Map();

const startedAt = Date.now();
let totalRequests = 0;
const requestCache = new RequestCache();

const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

function log(msg) {
  const ts = new Date().toLocaleTimeString();
  console.log(`[${ts}] ${msg}`);
}

async function initRedisCache() {
  if (!REDIS_URL) {
    log('Redis cache disabled (REDIS_URL not set). Using memory cache.');
    return;
  }

  const client = createClient({ url: REDIS_URL });
  client.on('error', (error) => {
    if (client.isReady) {
      log(`Redis cache error: ${error.message}`);
    }
  });

  try {
    await client.connect();
    requestCache.redisClient = client;
    log(`Redis cache connected: ${REDIS_URL}`);
  } catch (error) {
    log(`Redis cache unavailable, falling back to memory cache: ${error.message}`);
    try {
      await client.disconnect();
    } catch {}
  }
}

void initRedisCache();

function wsSend(ws, payload) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(payload));
  }
}

function requestInference(pathname, { method = 'GET', body = null } = {}) {
  const modeConfig = currentMode ? MODES[currentMode] : null;

  if (!modeConfig) {
    throw new Error('No active provider mode configured');
  }

  const baseUrl = new URL(modeConfig.baseURL);
  const basePath = baseUrl.pathname.replace(/\/$/, '');
  const upstreamPath = pathname.startsWith(basePath)
    ? pathname
    : `${basePath}${pathname.startsWith('/') ? pathname.replace(/^\/v1/, '') : pathname}`;
  const headers = body ? {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  } : {};

  if (modeConfig.apiKey) {
    headers.Authorization = `Bearer ${modeConfig.apiKey}`;
  }

  return httpRequest({
    protocol: baseUrl.protocol,
    hostname: baseUrl.hostname,
    port: baseUrl.port || (baseUrl.protocol === 'https:' ? 443 : 80),
    path: upstreamPath,
    method,
    headers,
    agent: baseUrl.protocol === 'https:' ? remoteHttpsAgent : remoteHttpAgent,
  });
}

function isInferenceReady() {
  return Boolean(currentMode);
}

function readRequestBody(req, sizeLimit = MAX_PROXY_BODY_SIZE) {
  return new Promise((resolve, reject) => {
    let rawBody = '';

    req.on('data', (chunk) => {
      rawBody += chunk;
      if (rawBody.length > sizeLimit) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });

    req.on('end', () => resolve(rawBody));
    req.on('error', reject);
  });
}

function writeProxyHeaders(res, upstreamResponse) {
  const headers = { ...(upstreamResponse.headers || {}) };
  delete headers.connection;
  delete headers['transfer-encoding'];
  res.writeHead(upstreamResponse.statusCode ?? 502, headers);
}

function normalizeProxyHeaders(headers = {}) {
  const nextHeaders = { ...headers };
  delete nextHeaders.connection;
  delete nextHeaders['transfer-encoding'];
  return nextHeaders;
}

function sendBufferedProxyResponse(res, response) {
  res.writeHead(response.statusCode ?? 502, normalizeProxyHeaders(response.headers));
  res.end(response.body);
}

function isCacheableProviderRequest(pathname, method, body) {
  return Boolean(currentMode) && shouldCacheRequest(pathname, method, body);
}

function fetchBufferedInferenceResponse(pathname, { method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const upstreamRequest = requestInference(pathname, { method, body });

    upstreamRequest.setTimeout(UPSTREAM_REQUEST_TIMEOUT_MS, () => {
      upstreamRequest.destroy(new Error('Proxy request timeout'));
    });

    upstreamRequest.on('response', (upstreamResponse) => {
      const chunks = [];
      let totalLength = 0;

      upstreamResponse.on('data', (chunk) => {
        totalLength += chunk.length;
        if (totalLength > MAX_BUFFERED_PROXY_RESPONSE_SIZE) {
          upstreamRequest.destroy(new Error('Buffered proxy response exceeded size limit'));
          return;
        }
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });

      upstreamResponse.on('end', () => {
        resolve({
          statusCode: upstreamResponse.statusCode ?? 502,
          headers: normalizeProxyHeaders(upstreamResponse.headers),
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });

      upstreamResponse.on('error', reject);
    });

    upstreamRequest.on('error', reject);

    if (body) {
      upstreamRequest.write(body);
    }

    upstreamRequest.end();
  });
}

async function maybeServeCachedProxyRequest(pathname, { method = 'GET', body = null } = {}, res) {
  if (!isCacheableProviderRequest(pathname, method, body)) {
    return false;
  }

  const cacheKey = buildCacheKey(pathname, method, body || '');
  const ttlSeconds = CACHE_TTLS[pathname] ?? 60;
  const { value, source } = await requestCache.getOrCompute(
    cacheKey,
    ttlSeconds,
    () => {
      totalRequests += 1;
      return fetchBufferedInferenceResponse(pathname, { method, body });
    },
    {
      shouldCache: (response) => (response?.statusCode ?? 500) < 400,
    },
  );

  res.setHeader('X-Tenrary-Cache', source);
  sendBufferedProxyResponse(res, value);
  return true;
}

function proxyInferenceRequest(pathname, { method = 'GET', body = null } = {}, res) {
  const upstreamRequest = requestInference(pathname, { method, body });

  upstreamRequest.setTimeout(UPSTREAM_REQUEST_TIMEOUT_MS, () => {
    upstreamRequest.destroy(new Error('Proxy request timeout'));
  });

  upstreamRequest.on('response', (upstreamResponse) => {
    writeProxyHeaders(res, upstreamResponse);
    upstreamResponse.pipe(res);
  });

  upstreamRequest.on('error', (error) => {
    if (res.headersSent) {
      res.end();
      return;
    }

    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message || 'Failed to reach inference backend.' }));
  });

  if (body) {
    upstreamRequest.write(body);
  }

  upstreamRequest.end();
}

// ── Tool-Augmented Chat Handler ────────────────────────────────
// Intercepts chat completions when tools_enabled is true.
// Makes a non-streaming call first to check for tool_calls,
// executes tools server-side, then streams the final response.
const MAX_TOOL_ROUNDS = 2; // Prevent infinite tool loops (1 search + 1 follow-up max)

/**
 * Make a non-streaming inference call and return the parsed response.
 * Handles both JSON and SSE responses (some providers always stream).
 * For SSE, reconstructs the full message by merging deltas.
 */
function callInferenceNonStreaming(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = requestInference('/v1/chat/completions', { method: 'POST', body });
    req.setTimeout(UPSTREAM_REQUEST_TIMEOUT_MS, () => req.destroy(new Error('Tool call timeout')));

    let rawData = '';
    req.on('response', (upRes) => {
      upRes.setEncoding('utf8');
      upRes.on('data', (chunk) => { rawData += chunk; });
      upRes.on('end', () => {
        if ((upRes.statusCode ?? 500) >= 400) {
          try { resolve({ status: upRes.statusCode, data: JSON.parse(rawData) }); }
          catch { resolve({ status: upRes.statusCode, data: { error: rawData.slice(0, 500) } }); }
          return;
        }

        // Try parsing as plain JSON first (non-streaming response)
        try {
          const parsed = JSON.parse(rawData);
          resolve({ status: upRes.statusCode, data: parsed });
          return;
        } catch { /* Not plain JSON — try SSE parsing below */ }

        // Parse as SSE stream: reconstruct the full message from deltas
        try {
          let content = '';
          let reasoningContent = '';
          let finishReason = null;
          const toolCalls = []; // Map of index → { id, type, function: { name, arguments } }

          for (const line of rawData.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (!data || data === '[DONE]') continue;

            const chunk = JSON.parse(data);
            const delta = chunk.choices?.[0]?.delta;
            if (!delta) {
              // Check for non-delta format (some providers return full message)
              const msg = chunk.choices?.[0]?.message;
              if (msg) {
                resolve({ status: 200, data: chunk });
                return;
              }
              finishReason = chunk.choices?.[0]?.finish_reason || finishReason;
              continue;
            }

            if (delta.content) content += delta.content;
            if (delta.reasoning_content) reasoningContent += delta.reasoning_content;
            if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;

            // Accumulate tool_calls deltas
            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!toolCalls[idx]) {
                  toolCalls[idx] = { id: tc.id || '', type: 'function', function: { name: '', arguments: '' } };
                }
                if (tc.id) toolCalls[idx].id = tc.id;
                if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
                if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
              }
            }
          }

          // Reconstruct a standard chat completion response
          const message = { role: 'assistant', content: content || null };
          if (reasoningContent) message.reasoning_content = reasoningContent;
          const activeToolCalls = toolCalls.filter(Boolean);
          if (activeToolCalls.length > 0) message.tool_calls = activeToolCalls;

          resolve({
            status: 200,
            data: {
              choices: [{
                message,
                finish_reason: finishReason || (activeToolCalls.length > 0 ? 'tool_calls' : 'stop'),
              }],
            },
          });
        } catch (sseErr) {
          reject(new Error(`Failed to parse upstream response: ${sseErr.message}. Raw: ${rawData.slice(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function handleToolAugmentedChat(parsed, res) {
  const toolPayload = injectTools(parsed);
  let currentPayload = toolPayload;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const upstreamResponse = await callInferenceNonStreaming(currentPayload);

    if (upstreamResponse.status >= 400) {
      res.writeHead(upstreamResponse.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(upstreamResponse.data));
    }

    // Check if the LLM wants to call tools
    if (!hasToolCalls(upstreamResponse.data)) {
      // No tool calls — stream the content as SSE to match expected format
      const content = upstreamResponse.data.choices?.[0]?.message?.content || '';
      const reasoning = upstreamResponse.data.choices?.[0]?.message?.reasoning_content;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      // Emit as a single SSE delta to match streaming format
      if (reasoning) {
        const reasoningChunk = { choices: [{ delta: { reasoning_content: reasoning } }] };
        res.write(`data: ${JSON.stringify(reasoningChunk)}\n\n`);
      }
      const chunk = { choices: [{ delta: { content } }] };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    // Execute tool calls
    const assistantMsg = upstreamResponse.data.choices[0].message;
    log(`[chat-tools] Round ${round + 1}: executing ${assistantMsg.tool_calls.length} tool(s): ${assistantMsg.tool_calls.map(tc => tc.function?.name).join(', ')}`);

    const { assistantMessage, toolResultMessages } = await executeToolCalls(assistantMsg);

    // Build follow-up payload with tool results
    currentPayload = buildFollowUpPayload(currentPayload, assistantMessage, toolResultMessages);
  }

  // Final call: strip tools entirely and convert tool messages to text summary.
  // Many providers ignore tool_choice:"none", so we remove tools completely.
  const finalPayload = buildFinalPayload(currentPayload);
  const finalResponse = await callInferenceNonStreaming(finalPayload);
  const finalContent = finalResponse.data?.choices?.[0]?.message?.content || '';
  const finalReasoning = finalResponse.data?.choices?.[0]?.message?.reasoning_content;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  if (finalReasoning) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: finalReasoning } }] })}\n\n`);
  }
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: finalContent } }] })}\n\n`);
  res.write('data: [DONE]\n\n');
  return res.end();
}

function checkInferenceHealth() {
  return new Promise((resolve) => {
    if (!isInferenceReady()) {
      resolve(false);
      return;
    }

    const req = requestInference('/v1/models');
    req.setTimeout(5000, () => req.destroy(new Error('Health check timeout')));
    req.on('response', (res) => {
      res.resume();
      resolve((res.statusCode ?? 500) < 400);
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

function attachWebSocketBridge(server) {
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://localhost:${CONTROL_PORT}`);
    console.log(`[ws-upgrade] pathname="${url.pathname}" from=${req.headers.origin || 'no-origin'}`);
    if (url.pathname === '/ws/agent-room') {
      handleAgentRoomUpgrade(req, socket, head);
      return;
    }

    if (url.pathname !== '/ws/chat') {
      console.warn(`[ws-upgrade] Rejected unknown path: ${url.pathname}`);
      socket.destroy();
      return;
    }

    const ip = req.socket.remoteAddress || '';
    const ipCount = wsConnectionsByIp.get(ip) || 0;
    if (ipCount >= MAX_WS_PER_IP) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      socket.destroy();
      return;
    }

    websocketServer.handleUpgrade(req, socket, head, (ws) => {
      ws._clientIp = ip;
      websocketServer.emit('connection', ws);
    });
  });
}

// ── Shared stream-to-upstream logic ─────────────────────────────
function streamUpstreamToSink(params, sink) {
  const body = buildChatCompletionPayload(params);
  let upstreamRequest = null;
  let upstreamResponse = null;
  let streamBuffer = '';
  let completed = false;
  const activeIntervals = new Set();

  const cleanupUpstream = () => {
    streamBuffer = '';
    for (const iv of activeIntervals) clearInterval(iv);
    activeIntervals.clear();
    if (upstreamResponse) { upstreamResponse.destroy(); upstreamResponse = null; }
    if (upstreamRequest) { upstreamRequest.destroy(); upstreamRequest = null; }
  };

  const finishStream = () => {
    if (completed) return;
    completed = true;
    sink.onDone();
    cleanupUpstream();
  };

  upstreamRequest = requestInference('/v1/chat/completions', { method: 'POST', body });
  upstreamRequest.setTimeout(UPSTREAM_REQUEST_TIMEOUT_MS, () => {
    sink.onError('Inference request timed out.');
    cleanupUpstream();
  });

  upstreamRequest.on('response', (res) => {
    upstreamResponse = res;
    res.setEncoding('utf8');

    if ((res.statusCode ?? 500) >= 400) {
      let errorBody = '';
      res.on('data', (chunk) => { errorBody += chunk; });
      res.on('end', () => {
        sink.onError(errorBody || `Upstream inference request failed with status ${res.statusCode}.`);
        cleanupUpstream();
      });
      return;
    }

    res.on('data', (chunk) => {
      if (streamBuffer.length + chunk.length > MAX_STREAM_BUFFER_SIZE) {
        sink.onError('Inference stream exceeded the buffer limit.');
        cleanupUpstream();
        return;
      }

      // Backpressure: if sink signals it's overwhelmed, pause upstream
      if (sink.shouldPause && sink.shouldPause()) {
        res.pause();
        const checkResume = setInterval(() => {
          if (!sink.shouldPause || !sink.shouldPause()) {
            clearInterval(checkResume);
            activeIntervals.delete(checkResume);
            if (upstreamResponse) res.resume();
          }
        }, 50);
        activeIntervals.add(checkResume);
      }

      const { lines, buffer } = splitSseLines(streamBuffer, chunk);
      streamBuffer = buffer;

      for (const line of lines) {
        const event = parseSseLine(line);
        if (!event || event.type === 'meta') continue;
        if (event.type === 'delta') { sink.onDelta(event.delta, event.channel); continue; }
        if (event.type === 'done') { finishStream(); return; }
        if (event.type === 'invalid') {
          sink.onError('Received malformed stream data from inference server.');
          cleanupUpstream();
          return;
        }
      }
    });

    res.on('end', () => {
      if (streamBuffer.trim()) {
        const trailingEvent = parseSseLine(streamBuffer.trim());
        if (trailingEvent?.type === 'delta') sink.onDelta(trailingEvent.delta);
        if (trailingEvent?.type === 'done') { finishStream(); return; }
      }
      if (!completed) finishStream();
    });

    res.on('error', () => {
      sink.onError('Inference stream closed unexpectedly.');
      cleanupUpstream();
    });
  });

  upstreamRequest.on('error', (error) => {
    sink.onError(error.message || 'Failed to reach inference server.');
    cleanupUpstream();
  });

  upstreamRequest.write(body);
  upstreamRequest.end();

  return { cleanup: cleanupUpstream };
}

// ── Request Queue Processing ───────────────────────────────────
function processQueue() {
  // Drain queue into available slots
  while (activeSlots < maxParallelSlots && requestQueue.length > 0) {
    const entry = requestQueue.shift();

    // Update queue positions for remaining waiters
    for (let i = 0; i < requestQueue.length; i++) {
      const queued = requestQueue[i];
      if (queued.type === 'ws' && queued.ws.readyState === 1) {
        wsSend(queued.ws, { type: 'queued', position: i + 1 });
      } else if (queued.type === 'sse' && !queued.disconnected) {
        queued.res.write(`data: ${JSON.stringify({ type: 'queued', position: i + 1 })}\n\n`);
      }
    }

    // Skip disconnected clients
    if (entry.type === 'ws' && entry.ws.readyState !== 1) continue;
    if (entry.type === 'sse' && entry.disconnected) continue;

    activeSlots++;
    entry.inFlight = true;

    const onComplete = () => {
      if (entry.inFlight) {
        entry.inFlight = false;
        activeSlots = Math.max(0, activeSlots - 1);
      }
      processQueue();
    };

    if (entry.type === 'ws') {
      const handle = streamUpstreamToSink(entry.params, {
        onDelta: (delta, channel) => wsSend(entry.ws, { type: 'delta', delta, channel }),
        onDone: () => { wsSend(entry.ws, { type: 'done' }); entry.cleanupRef = null; onComplete(); },
        onError: (msg) => { wsSend(entry.ws, { type: 'error', message: msg }); entry.cleanupRef = null; onComplete(); },
        // Backpressure: pause upstream if WS send buffer exceeds 64KB
        shouldPause: () => entry.ws.bufferedAmount > 65536,
      });
      entry.cleanupRef = handle.cleanup;
    } else if (entry.type === 'sse') {
      const handle = streamUpstreamToSink(entry.params, {
        onDelta: (delta, channel) => {
          if (!entry.disconnected) entry.res.write(`data: ${JSON.stringify({ type: 'delta', delta, channel })}\n\n`);
        },
        onDone: () => {
          if (!entry.disconnected) { entry.res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`); entry.res.end(); }
          entry.cleanupRef = null;
          onComplete();
        },
        onError: (msg) => {
          if (!entry.disconnected) { entry.res.write(`data: ${JSON.stringify({ type: 'error', message: msg })}\n\n`); entry.res.end(); }
          entry.cleanupRef = null;
          onComplete();
        },
      });
      entry.cleanupRef = handle.cleanup;
    }
  }
}

/**
 * Estimate message complexity for priority ordering.
 * Shorter conversations get higher priority (lower score = processed first).
 */
function estimateComplexity(params) {
  const messages = params?.messages;
  if (!Array.isArray(messages)) return 1;
  // Total character count across all messages as a rough proxy
  let totalChars = 0;
  for (const m of messages) {
    totalChars += (typeof m.content === 'string' ? m.content.length : 0);
  }
  // Normalize: <500 chars = priority 0, <2000 = 1, <8000 = 2, else 3
  if (totalChars < 500) return 0;
  if (totalChars < 2000) return 1;
  if (totalChars < 8000) return 2;
  return 3;
}

function enqueueRequest(entry) {
  if (requestQueue.length >= MAX_QUEUE_SIZE) {
    return false;
  }
  entry.priority = estimateComplexity(entry.params);

  // Insert in priority order (lower priority value = higher priority)
  let insertIdx = requestQueue.length;
  for (let i = 0; i < requestQueue.length; i++) {
    if ((requestQueue[i].priority ?? 1) > entry.priority) {
      insertIdx = i;
      break;
    }
  }
  requestQueue.splice(insertIdx, 0, entry);
  processQueue();
  return true;
}

websocketServer.on('connection', (ws) => {
  if (activeWebSocketConnections >= MAX_WS_CONNECTIONS) {
    ws.close(1008, 'Connection limit exceeded.');
    return;
  }

  const clientIp = ws._clientIp || '';
  activeWebSocketConnections += 1;
  wsConnectionsByIp.set(clientIp, (wsConnectionsByIp.get(clientIp) || 0) + 1);

  // ── Heartbeat: detect dead connections ──
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  let lastRequestAt = 0;
  let activeEntry = null;

  ws.on('message', (raw, isBinary) => {
    const now = Date.now();
    if (isBinary) {
      wsSend(ws, { type: 'error', message: 'Binary websocket messages are not supported.' });
      return;
    }
    if (!isInferenceReady()) {
      wsSend(ws, { type: 'error', message: 'Inference server is not ready yet.' });
      return;
    }

    let params;
    try {
      params = JSON.parse(raw.toString());
    } catch {
      wsSend(ws, { type: 'error', message: 'Invalid JSON payload.' });
      return;
    }

    if (!Array.isArray(params.messages) || params.messages.length === 0) {
      wsSend(ws, { type: 'error', message: 'The websocket payload must include a non-empty messages array.' });
      return;
    }
    if (now - lastRequestAt < STREAM_REQUEST_COOLDOWN_MS) {
      wsSend(ws, { type: 'error', message: 'Requests are arriving too quickly. Please retry shortly.' });
      return;
    }

    lastRequestAt = now;
    totalRequests += 1;

    // ── Tool-augmented chat via WebSocket ──────────────────
    if (shouldUseTools(params)) {
      (async () => {
        try {
          const parsed = { ...params };
          delete parsed.tools_enabled;
          if (Array.isArray(parsed.messages) && !parsed.messages.some((m) => m.role === 'system')) {
            parsed.messages.unshift({ role: 'system', content: 'You are a helpful assistant.' });
          }
          const toolPayload = injectTools(parsed);
          let currentPayload = toolPayload;

          for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
            const upstreamResponse = await callInferenceNonStreaming(currentPayload);

            if (upstreamResponse.status >= 400) {
              wsSend(ws, { type: 'error', message: upstreamResponse.data?.error || `Upstream error ${upstreamResponse.status}` });
              return;
            }

            if (!hasToolCalls(upstreamResponse.data)) {
              const content = upstreamResponse.data.choices?.[0]?.message?.content || '';
              const reasoning = upstreamResponse.data.choices?.[0]?.message?.reasoning_content;
              if (reasoning) wsSend(ws, { type: 'delta', delta: reasoning, channel: 'reasoning' });
              wsSend(ws, { type: 'delta', delta: content });
              wsSend(ws, { type: 'done' });
              return;
            }

            const assistantMsg = upstreamResponse.data.choices[0].message;
            log(`[chat-tools-ws] Round ${round + 1}: ${assistantMsg.tool_calls.map(tc => tc.function?.name).join(', ')}`);
            const { assistantMessage, toolResultMessages } = await executeToolCalls(assistantMsg);
            currentPayload = buildFollowUpPayload(currentPayload, assistantMessage, toolResultMessages);
          }

          // Final call: strip tools, convert tool messages to text
          const finalPayload = buildFinalPayload(currentPayload);
          const finalResp = await callInferenceNonStreaming(finalPayload);
          const content = finalResp.data?.choices?.[0]?.message?.content || '';
          const reasoning = finalResp.data?.choices?.[0]?.message?.reasoning_content;
          if (reasoning) wsSend(ws, { type: 'delta', delta: reasoning, channel: 'reasoning' });
          wsSend(ws, { type: 'delta', delta: content });
          wsSend(ws, { type: 'done' });
        } catch (err) {
          log(`[chat-tools-ws] Error: ${err.message}`);
          wsSend(ws, { type: 'error', message: `Tool error: ${err.message}` });
        }
      })();
      return;
    }

    const entry = { type: 'ws', ws, params, cleanupRef: null, inFlight: false };
    activeEntry = entry;

    if (!enqueueRequest(entry)) {
      wsSend(ws, { type: 'error', message: 'Queue full, try later' });
      return;
    }

    const position = requestQueue.indexOf(entry);
    if (position >= 0) {
      wsSend(ws, { type: 'queued', position: position + 1 });
    }
  });

  const closeConnection = () => {
    if (activeWebSocketConnections > 0) {
      activeWebSocketConnections -= 1;
    }
    const count = wsConnectionsByIp.get(clientIp) || 0;
    if (count <= 1) {
      wsConnectionsByIp.delete(clientIp);
    } else {
      wsConnectionsByIp.set(clientIp, count - 1);
    }
    // Remove any pending queued entries for this ws
    for (let i = requestQueue.length - 1; i >= 0; i--) {
      if (requestQueue[i].type === 'ws' && requestQueue[i].ws === ws) {
        requestQueue.splice(i, 1);
      }
    }
    if (activeEntry?.inFlight && activeEntry.cleanupRef) {
      activeEntry.cleanupRef();
      activeEntry.cleanupRef = null;
      activeEntry.inFlight = false;
      activeSlots = Math.max(0, activeSlots - 1);
      processQueue();
    }
  };

  ws.on('close', closeConnection);
  ws.on('error', closeConnection);
});

// ── WebSocket heartbeat: ping every 30s, terminate unresponsive ──
const WS_HEARTBEAT_INTERVAL = 30_000;
const wsHeartbeat = setInterval(() => {
  websocketServer.clients.forEach((ws) => {
    if (!ws.isAlive) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, WS_HEARTBEAT_INTERVAL);
wsHeartbeat.unref();

function activateProvider(mode) {
  if (!MODES[mode]) throw new Error(`Unknown mode: ${mode}`);

  const config = MODES[mode];
  if (!config.baseURL || !config.apiKey) {
    throw new Error(`Provider "${mode}" is not configured. Set ENOWXAI_BASE_URL and ENOWXAI_API_KEY in .env.`);
  }

  currentMode = mode;
  log(`✓ ${mode} provider ready via ${config.baseURL}`);
}

function deactivateProvider() {
  currentMode = null;
}

async function switchMode(mode) {
  if (mode === currentMode) return { status: 'ok', mode, message: 'Already running' };

  deactivateProvider();
  activateProvider(mode);
  return { status: 'ok', mode, message: `Switched to ${MODES[mode].label}` };
}

// ── Auth helpers ────────────────────────────────────────────────
function isLocalhost(req) {
  const addr = req.socket.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function isAuthorizedMutation(req) {
  if (CONTROL_API_KEY) {
    const auth = req.headers['authorization'] || '';
    return auth === `Bearer ${CONTROL_API_KEY}`;
  }
  return isLocalhost(req);
}

// ── Control API Server ─────────────────────────────────────────
const controlServer = createServer(async (req, res) => {
  // ── Security headers ─────────────────────────────────────────
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '0'); // Disabled — modern CSP is preferred
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  // ── CORS ─────────────────────────────────────────────────────
  const origin = getCorsOrigin(req.headers.origin || '');
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${CONTROL_PORT}`);

  if (SUPPORTED_PROXY_GET_PATHS.has(url.pathname) && req.method === 'GET') {
    if (!isInferenceReady()) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Inference server is not ready yet.' }));
    }

    if (await maybeServeCachedProxyRequest(url.pathname, { method: 'GET' }, res)) {
      return;
    }

    return proxyInferenceRequest(url.pathname, { method: 'GET' }, res);
  }

  if (SUPPORTED_PROXY_POST_PATHS.has(url.pathname) && req.method === 'POST') {
    if (!isInferenceReady()) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Inference server is not ready yet.' }));
    }

    try {
      let rawBody = await readRequestBody(req);

      // Cloud providers may reject payloads without a system message.
      // Inject a default one when missing.
      if (url.pathname === '/v1/chat/completions') {
        try {
          const parsed = JSON.parse(rawBody);
          if (Array.isArray(parsed.messages) && !parsed.messages.some((m) => m.role === 'system')) {
            parsed.messages.unshift({ role: 'system', content: 'You are a helpful assistant.' });
          }

          // ── Tool-augmented chat ──────────────────────────────
          // When dashboard sends tools_enabled: true, intercept the request
          // to inject tool definitions and handle tool execution server-side.
          if (shouldUseTools(parsed)) {
            try {
              return await handleToolAugmentedChat(parsed, res);
            } catch (toolErr) {
              log(`[chat-tools] Error: ${toolErr.message}`);
              // Fall through to normal proxy on tool error
              delete parsed.tools_enabled;
              rawBody = JSON.stringify(parsed);
            }
          } else {
            rawBody = JSON.stringify(parsed);
          }
        } catch { /* leave rawBody as-is if not valid JSON */ }
      }

      if (await maybeServeCachedProxyRequest(url.pathname, { method: 'POST', body: rawBody }, res)) {
        return;
      }
      return proxyInferenceRequest(url.pathname, { method: 'POST', body: rawBody }, res);
    } catch (error) {
      const statusCode = error.message === 'Payload too large' ? 413 : 400;
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: error.message || 'Invalid request body.' }));
    }
  }

  // GET /status
  if (url.pathname === '/status' && req.method === 'GET') {
    const healthy = await checkInferenceHealth();
    return sendJson(req, res, 200, {
      mode: currentMode,
      label: currentMode ? MODES[currentMode].label : null,
      type: 'cloud',
      healthy,
    });
  }

  // GET /health
  if (url.pathname === '/health' && req.method === 'GET') {
    const healthy = await checkInferenceHealth();
    return sendJson(req, res, healthy ? 200 : 503, {
      healthy,
      mode: currentMode,
      type: 'cloud',
    }, { 'Cache-Control': 'no-store, max-age=0' });
  }

  // POST /switch?mode=enowxai
  if (url.pathname === '/switch' && req.method === 'POST') {
    if (!isAuthorizedMutation(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Forbidden' }));
    }

    const mode = url.searchParams.get('mode');
    if (!mode || !MODES[mode]) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: `Invalid mode. Use: ${Object.keys(MODES).join(', ')}` }));
    }

    try {
      const result = await switchMode(mode);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // GET /metrics
  if (url.pathname === '/metrics' && req.method === 'GET') {
    return sendJson(req, res, 200, {
      inference: {
        type: 'cloud',
        active_connections: activeWebSocketConnections,
        queue_depth: requestQueue.length,
        active_slots: activeSlots,
        max_parallel_slots: maxParallelSlots,
        total_requests: totalRequests,
        uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
      },
      provider: {
        mode: currentMode || 'offline',
        model: currentMode ? MODES[currentMode].model : null,
        baseURL: currentMode ? MODES[currentMode].baseURL : null,
      },
      cache: getCacheStats(),
    });
  }

  // POST /stop
  if (url.pathname === '/stop' && req.method === 'POST') {
    if (!isAuthorizedMutation(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Forbidden' }));
    }

    deactivateProvider();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'stopped' }));
  }

  // POST /restart-gateway
  if (url.pathname === '/restart-gateway' && req.method === 'POST') {
    if (!isAuthorizedMutation(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Forbidden' }));
    }

    try {
      const result = await restartEnowxaiGateway();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // POST /manager/chat/sse — SSE fallback for WebSocket
  if ((url.pathname === '/manager/chat/sse' || url.pathname === '/chat/sse') && req.method === 'POST') {
    if (!isInferenceReady()) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Inference server is not ready yet.' }));
    }

    let rawBody = '';
    let bodyRejected = false;
    req.on('data', (chunk) => {
      rawBody += chunk;
      if (rawBody.length > 256 * 1024) {
        bodyRejected = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
        req.destroy();
      }
    });

    req.on('end', () => {
      if (bodyRejected) return;
      let params;
      try {
        params = JSON.parse(rawBody);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON payload.' }));
      }

      if (!Array.isArray(params.messages) || params.messages.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'The payload must include a non-empty messages array.' }));
      }

      // ── Tool-augmented SSE chat ──────────────────────────
      if (shouldUseTools(params)) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': getCorsOrigin(req.headers.origin || ''),
        });
        (async () => {
          try {
            const parsed = { ...params };
            delete parsed.tools_enabled;
            if (!parsed.messages.some((m) => m.role === 'system')) {
              parsed.messages.unshift({ role: 'system', content: 'You are a helpful assistant.' });
            }
            const toolPayload = injectTools(parsed);
            let currentPayload = toolPayload;

            for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
              const upstreamResponse = await callInferenceNonStreaming(currentPayload);

              if (upstreamResponse.status >= 400) {
                res.write(`data: ${JSON.stringify({ type: 'error', message: upstreamResponse.data?.error || `Upstream error ${upstreamResponse.status}` })}\n\n`);
                return res.end();
              }

              if (!hasToolCalls(upstreamResponse.data)) {
                const content = upstreamResponse.data.choices?.[0]?.message?.content || '';
                const reasoning = upstreamResponse.data.choices?.[0]?.message?.reasoning_content;
                if (reasoning) res.write(`data: ${JSON.stringify({ type: 'delta', delta: reasoning, channel: 'reasoning' })}\n\n`);
                res.write(`data: ${JSON.stringify({ type: 'delta', delta: content })}\n\n`);
                res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
                return res.end();
              }

              const assistantMsg = upstreamResponse.data.choices[0].message;
              log(`[chat-tools-sse] Round ${round + 1}: ${assistantMsg.tool_calls.map(tc => tc.function?.name).join(', ')}`);
              const { assistantMessage, toolResultMessages } = await executeToolCalls(assistantMsg);
              currentPayload = buildFollowUpPayload(currentPayload, assistantMessage, toolResultMessages);
            }

            // Final call: strip tools, convert tool messages to text
            const finalPayload = buildFinalPayload(currentPayload);
            const finalResp = await callInferenceNonStreaming(finalPayload);
            const finalContent = finalResp.data?.choices?.[0]?.message?.content || '';
            const finalReasoning = finalResp.data?.choices?.[0]?.message?.reasoning_content;
            if (finalReasoning) res.write(`data: ${JSON.stringify({ type: 'delta', delta: finalReasoning, channel: 'reasoning' })}\n\n`);
            res.write(`data: ${JSON.stringify({ type: 'delta', delta: finalContent })}\n\n`);
            res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
            res.end();
          } catch (err) {
            log(`[chat-tools-sse] Error: ${err.message}`);
            res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
            res.end();
          }
        })();
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': getCorsOrigin(req.headers.origin || ''),
      });

      const entry = { type: 'sse', res, params, disconnected: false, cleanupRef: null, inFlight: false };

      req.on('close', () => {
        entry.disconnected = true;
        // Remove from queue if still pending
        const idx = requestQueue.indexOf(entry);
        if (idx !== -1) requestQueue.splice(idx, 1);
        if (entry.cleanupRef) {
          entry.cleanupRef();
          entry.cleanupRef = null;
        }
        if (entry.inFlight) {
          entry.inFlight = false;
          activeSlots = Math.max(0, activeSlots - 1);
          processQueue();
        }
      });

      if (!enqueueRequest(entry)) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: 'Queue full, try later' })}\n\n`);
        res.end();
        return;
      }

      const position = requestQueue.indexOf(entry);
      if (position >= 0) {
        res.write(`data: ${JSON.stringify({ type: 'queued', position: position + 1 })}\n\n`);
      }
    });

    return;
  }

  // ── API Routes (auth, conversations, rooms, sharing) ─────────
  if (url.pathname.startsWith('/api/')) {
    try {
      const handled = await routeApiRequest(url, req, res);
      if (handled) return;
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

attachWebSocketBridge(controlServer);

// ── Server tuning ──────────────────────────────────────────────
controlServer.keepAliveTimeout = 65_000;   // Slightly above typical proxy/CDN timeout (60s)
controlServer.headersTimeout = 66_000;     // Must be > keepAliveTimeout
controlServer.maxHeadersCount = 50;        // Limit header count for security

// ── Startup ────────────────────────────────────────────────────
controlServer.listen(CONTROL_PORT, () => {
  log(`═══ Chat Room X — Cloud Inference Manager ═══`);
  log(`Control API: http://localhost:${CONTROL_PORT}`);
  log(`Mode:        Cloud-only (no local inference)`);
  log(`Provider:    ${ENOWXAI_BASE_URL || '(not configured)'}`);
  log(`Endpoints:`);
  log(`  GET  /v1/models      — Proxy models endpoint`);
  log(`  POST /v1/chat/completions — Proxy OpenAI chat completions`);
  log(`  POST /v1/responses   — Proxy OpenAI responses API`);
  log(`  POST /v1/messages    — Proxy Anthropic messages API`);
  log(`  GET  /status         — Current mode info`);
  log(`  GET  /health         — Provider health check`);
  log(`  GET  /metrics        — Inference metrics`);
  log(`  POST /switch?mode=X  — Switch mode (${Object.keys(MODES).join('|')})`);
  log(`  POST /stop           — Deactivate provider`);
  log(`  WS   /ws/chat        — Streaming chat bridge`);
  log(``);
});

// Activate cloud provider immediately
const startMode = process.argv[2] || 'enowxai';
try {
  activateProvider(startMode);
} catch (err) {
  log(`Failed to start: ${err.message}`);
  process.exit(1);
}

// ── Process error handlers ─────────────────────────────────────
process.on('unhandledRejection', (reason, promise) => {
  log(`Unhandled rejection: ${reason instanceof Error ? reason.stack || reason.message : reason}`);
  // Don't crash — log and continue. Critical rejections should be caught at source.
});

process.on('uncaughtException', (err) => {
  log(`Uncaught exception: ${err.stack || err.message}`);
  closeDatabase();
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
  log('Shutting down...');
  closeDatabase();
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('Shutting down...');
  closeDatabase();
  process.exit(0);
});
