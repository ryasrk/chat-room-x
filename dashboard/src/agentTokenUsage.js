/**
 * Agent Token Usage — displays per-agent token consumption
 * with cumulative totals and recent history.
 */

import { getAgentRoomTokenUsage } from './authClient.js';
import { rs, escapeHtml } from './roomsUtils.js';

/** @type {{summary: Array, history: Array}} */
let tokenData = { summary: [], history: [] };

export async function loadTokenUsage() {
  if (!rs.currentAgentRoomId) return;

  try {
    const data = await getAgentRoomTokenUsage(rs.currentAgentRoomId, 50);
    tokenData = { summary: data.summary || [], history: data.history || [] };
  } catch {
    tokenData = { summary: [], history: [] };
  }

  renderTokenUsage();
}

export function addRealtimeTokenUsage(agentName, usage) {
  if (!usage || !usage.total_tokens) return;

  // Update summary in-place for real-time feel
  const existing = tokenData.summary.find((s) => s.agent_name === agentName);
  if (existing) {
    existing.prompt_tokens += Number(usage.prompt_tokens) || 0;
    existing.completion_tokens += Number(usage.completion_tokens) || 0;
    existing.total_tokens += Number(usage.total_tokens) || 0;
    existing.call_count += 1;
  } else {
    tokenData.summary.push({
      agent_name: agentName,
      prompt_tokens: Number(usage.prompt_tokens) || 0,
      completion_tokens: Number(usage.completion_tokens) || 0,
      total_tokens: Number(usage.total_tokens) || 0,
      call_count: 1,
    });
  }

  renderTokenUsage();
}

export function renderTokenUsage() {
  const container = rs.panel?.querySelector('#agent-room-token-usage');
  if (!container) return;

  if (tokenData.summary.length === 0) {
    container.innerHTML = '<p class="empty-state">No token usage recorded yet. Usage will appear after agents process messages.</p>';
    return;
  }

  const grandTotal = tokenData.summary.reduce((sum, s) => sum + s.total_tokens, 0);
  const grandCalls = tokenData.summary.reduce((sum, s) => sum + s.call_count, 0);

  container.innerHTML = `
    <div class="token-usage-summary">
      <div class="token-usage-total">
        <span class="token-usage-total-label">Total</span>
        <span class="token-usage-total-value">${formatTokenCount(grandTotal)}</span>
        <span class="token-usage-total-meta">${grandCalls} call${grandCalls !== 1 ? 's' : ''}</span>
      </div>
      <div class="token-usage-bars">
        ${tokenData.summary.map((s) => {
          const pct = grandTotal > 0 ? Math.round((s.total_tokens / grandTotal) * 100) : 0;
          return `
            <div class="token-usage-bar-row">
              <span class="token-usage-bar-label">@${escapeHtml(s.agent_name)}</span>
              <div class="token-usage-bar-track">
                <div class="token-usage-bar-fill" style="width: ${pct}%"></div>
              </div>
              <span class="token-usage-bar-value">${formatTokenCount(s.total_tokens)}</span>
              <span class="token-usage-bar-meta">${s.call_count} call${s.call_count !== 1 ? 's' : ''}</span>
            </div>
          `;
        }).join('')}
      </div>
    </div>
    ${tokenData.history.length > 0 ? `
      <details class="token-usage-history">
        <summary>Recent calls (${tokenData.history.length})</summary>
        <div class="token-usage-history-list">
          ${tokenData.history.slice(0, 20).map((h) => `
            <div class="token-usage-history-row">
              <span class="token-usage-history-agent">@${escapeHtml(h.agent_name)}</span>
              <span class="token-usage-history-tokens">${formatTokenCount(h.total_tokens)}</span>
              <span class="token-usage-history-model">${escapeHtml(h.model || 'unknown')}</span>
              <span class="token-usage-history-time">${new Date(Number(h.created_at) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            </div>
          `).join('')}
        </div>
      </details>
    ` : ''}
  `;
}

function formatTokenCount(count) {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}
