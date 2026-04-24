/**
 * observabilityPanel.js — Health dashboard cards for queue depth, latency, error rates,
 * and attachment grounding with citation references.
 */

import { state } from './appState.js';
import { getSessionStats, formatTokenCount } from './tokenCounter.js';
import { getStreamState } from './chatApi.js';
import { escapeHtml } from './utils.js';

// ── Attachment Grounding ───────────────────────────────────────

const _attachmentIndex = new Map(); // filename → { chunks: string[], tokenCount: number }

/**
 * Index an attached file into chunks for citation grounding.
 */
export function indexAttachment(fileName, content) {
  if (!fileName || !content) return;
  const CHUNK_SIZE = 500;
  const chunks = [];
  for (let i = 0; i < content.length; i += CHUNK_SIZE) {
    chunks.push(content.slice(i, i + CHUNK_SIZE));
  }
  _attachmentIndex.set(fileName, {
    chunks,
    tokenCount: Math.ceil(content.length / 4),
    indexedAt: Date.now(),
  });
}

/**
 * Find which attachment chunk a citation refers to.
 */
export function findCitation(query) {
  if (!query || query.length < 10) return null;
  const queryLower = query.toLowerCase();

  for (const [fileName, data] of _attachmentIndex) {
    for (let i = 0; i < data.chunks.length; i++) {
      if (data.chunks[i].toLowerCase().includes(queryLower)) {
        return { fileName, chunkIndex: i, preview: data.chunks[i].slice(0, 200) };
      }
    }
  }
  return null;
}

/**
 * Get all indexed attachments summary.
 */
export function getAttachmentIndex() {
  const entries = [];
  for (const [fileName, data] of _attachmentIndex) {
    entries.push({ fileName, chunks: data.chunks.length, tokens: data.tokenCount, indexedAt: data.indexedAt });
  }
  return entries;
}

export function clearAttachmentIndex() {
  _attachmentIndex.clear();
}

// ── Observability Metrics ──────────────────────────────────────

let _errorLog = [];
let _latencyLog = [];
const MAX_LOG_SIZE = 100;

export function recordError(error, context = '') {
  _errorLog.push({ message: String(error?.message || error), context, timestamp: Date.now() });
  if (_errorLog.length > MAX_LOG_SIZE) _errorLog = _errorLog.slice(-MAX_LOG_SIZE);
}

export function recordLatency(durationMs, label = 'request') {
  _latencyLog.push({ duration: durationMs, label, timestamp: Date.now() });
  if (_latencyLog.length > MAX_LOG_SIZE) _latencyLog = _latencyLog.slice(-MAX_LOG_SIZE);
}

function getRecentErrors(windowMs = 300_000) {
  const cutoff = Date.now() - windowMs;
  return _errorLog.filter(e => e.timestamp > cutoff);
}

function getRecentLatencies(windowMs = 300_000) {
  const cutoff = Date.now() - windowMs;
  return _latencyLog.filter(l => l.timestamp > cutoff);
}

function avgLatency(entries) {
  if (!entries.length) return 0;
  return Math.round(entries.reduce((s, e) => s + e.duration, 0) / entries.length);
}

function p95Latency(entries) {
  if (!entries.length) return 0;
  const sorted = entries.map(e => e.duration).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.95)] || sorted[sorted.length - 1];
}

// ── Render Health Dashboard ────────────────────────────────────

export function renderObservabilityCards(container) {
  if (!container) return;

  const stats = getSessionStats();
  const streamState = getStreamState();
  const recentErrors = getRecentErrors();
  const recentLatencies = getRecentLatencies();
  const attachments = getAttachmentIndex();

  const errorRate = recentErrors.length;
  const avg = avgLatency(recentLatencies);
  const p95 = p95Latency(recentLatencies);

  container.innerHTML = `
    <div class="obs-cards">
      <div class="obs-card">
        <div class="obs-card-label">Stream</div>
        <div class="obs-card-value obs-stream-${escapeHtml(streamState?.state || 'idle')}">${escapeHtml(streamState?.state || 'idle')}</div>
        <div class="obs-card-detail">${streamState?.tokenCount || 0} tokens</div>
      </div>
      <div class="obs-card">
        <div class="obs-card-label">Session Tokens</div>
        <div class="obs-card-value">${formatTokenCount(stats.totalTokens)}</div>
        <div class="obs-card-detail">${stats.messageCount} messages</div>
      </div>
      <div class="obs-card">
        <div class="obs-card-label">Latency</div>
        <div class="obs-card-value">${avg}ms</div>
        <div class="obs-card-detail">p95: ${p95}ms</div>
      </div>
      <div class="obs-card ${errorRate > 3 ? 'obs-card-warn' : ''}">
        <div class="obs-card-label">Errors (5m)</div>
        <div class="obs-card-value">${errorRate}</div>
        <div class="obs-card-detail">${recentErrors.length > 0 ? escapeHtml(recentErrors[recentErrors.length - 1].message.slice(0, 40)) : 'None'}</div>
      </div>
      ${attachments.length > 0 ? `
        <div class="obs-card obs-card-wide">
          <div class="obs-card-label">Grounded Attachments</div>
          <div class="obs-card-detail">
            ${attachments.map(a => `<span class="obs-attachment-tag" title="${a.chunks} chunks, ~${formatTokenCount(a.tokens)} tokens">📎 ${escapeHtml(a.fileName)}</span>`).join(' ')}
          </div>
        </div>
      ` : ''}
    </div>
  `;
}
