/**
 * Agent Handoff Visualization — renders a visual timeline of agent-to-agent
 * handoffs and interactions in the Agent Room sidebar.
 */

import { rs, escapeHtml, sanitizeClassToken } from './roomsUtils.js';

/**
 * @typedef {Object} HandoffEntry
 * @property {string} from
 * @property {string} to
 * @property {string} content
 * @property {number} timestamp
 */

/** @type {HandoffEntry[]} */
let handoffTimeline = [];

const AGENT_COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#6366f1',
];

function getAgentColor(agentName) {
  const agents = rs.currentAgentMembers || [];
  const idx = agents.findIndex((a) => a.name === agentName);
  return AGENT_COLORS[idx >= 0 ? idx % AGENT_COLORS.length : 0];
}

export function resetHandoffTimeline() {
  handoffTimeline = [];
}

export function addHandoffEvent(from, to, content, timestamp) {
  handoffTimeline.push({
    from: String(from || '').toLowerCase(),
    to: String(to || '').toLowerCase(),
    content: String(content || '').slice(0, 200),
    timestamp: timestamp || Math.floor(Date.now() / 1000),
  });

  // Keep last 30 handoffs
  if (handoffTimeline.length > 30) {
    handoffTimeline = handoffTimeline.slice(-30);
  }

  renderHandoffTimeline();
}

export function extractHandoffsFromMessage(message) {
  if (message.event_type !== 'handoff' || message.sender_type !== 'agent') return;

  const agents = rs.currentAgentMembers || [];
  const validNames = new Set(agents.map((a) => a.name.toLowerCase()));
  const mentions = [...String(message.content || '').matchAll(/@([a-z][a-z0-9_-]{1,31})/gi)];

  for (const match of mentions) {
    const targetName = match[1].toLowerCase();
    if (validNames.has(targetName) && targetName !== message.sender_name?.toLowerCase()) {
      addHandoffEvent(
        message.sender_name,
        targetName,
        message.content,
        message.created_at || Math.floor(Date.now() / 1000),
      );
    }
  }
}

export function renderHandoffTimeline() {
  const container = rs.panel?.querySelector('#agent-room-handoff-viz');
  if (!container) return;

  if (handoffTimeline.length === 0) {
    container.innerHTML = '<p class="empty-state">No handoffs yet. Handoffs appear when agents delegate tasks to each other.</p>';
    return;
  }

  const agents = [...new Set(handoffTimeline.flatMap((h) => [h.from, h.to]))].sort();

  container.innerHTML = `
    <div class="handoff-legend">
      ${agents.map((name) => `
        <span class="handoff-legend-item">
          <span class="handoff-legend-dot" style="background: ${getAgentColor(name)}"></span>
          @${escapeHtml(name)}
        </span>
      `).join('')}
    </div>
    <div class="handoff-timeline">
      ${handoffTimeline.map((h) => {
        const fromColor = getAgentColor(h.from);
        const toColor = getAgentColor(h.to);
        const time = new Date(h.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const preview = h.content.length > 80 ? h.content.slice(0, 80) + '…' : h.content;

        return `
          <div class="handoff-entry">
            <div class="handoff-arrow">
              <span class="handoff-node" style="background: ${fromColor}">@${escapeHtml(h.from)}</span>
              <span class="handoff-connector" aria-hidden="true">→</span>
              <span class="handoff-node" style="background: ${toColor}">@${escapeHtml(h.to)}</span>
              <span class="handoff-time">${escapeHtml(time)}</span>
            </div>
            <div class="handoff-preview">${escapeHtml(preview)}</div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}
