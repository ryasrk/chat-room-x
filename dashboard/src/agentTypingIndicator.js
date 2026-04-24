/**
 * Agent Typing Indicator — shows animated "thinking" indicators
 * when agents are actively running in the Agent Room chat.
 */

import { rs, escapeHtml } from './roomsUtils.js';

/** @type {Map<string, {timestamp: number, activity: string}>} agent name → status info */
const activeAgents = new Map();
const STALE_TIMEOUT_MS = 120_000; // 2 minutes

const TOOL_ACTIVITY_LABELS = {
  list_files: 'exploring workspace',
  read_file: 'reading files',
  write_file: 'writing code',
  update_file: 'editing code',
  run_python: 'running Python',
  search_skills: 'searching skills',
  read_skill: 'reading skill guide',
  think_aloud: 'reasoning',
  propose: 'creating proposal',
  delegate: 'delegating work',
  respond_to_proposal: 'reviewing proposal',
};

export function setAgentTypingStatus(agentName, status) {
  const name = String(agentName || '').toLowerCase();
  if (!name) return;

  if (status === 'running') {
    activeAgents.set(name, { timestamp: Date.now(), activity: 'thinking' });
  } else {
    activeAgents.delete(name);
  }

  renderTypingIndicator();
}

/**
 * Update the activity label for a running agent (called from progress events).
 */
export function setAgentActivity(agentName, toolName) {
  const name = String(agentName || '').toLowerCase();
  if (!name || !activeAgents.has(name)) return;

  const entry = activeAgents.get(name);
  entry.activity = TOOL_ACTIVITY_LABELS[toolName] || toolName || 'working';
  entry.timestamp = Date.now();
  renderTypingIndicator();
}

export function clearAllTypingIndicators() {
  activeAgents.clear();
  renderTypingIndicator();
}

export function renderTypingIndicator() {
  const container = rs.panel?.querySelector('#agent-typing-indicator');
  if (!container) return;

  // Prune stale entries
  const now = Date.now();
  for (const [name, entry] of activeAgents) {
    if (now - entry.timestamp > STALE_TIMEOUT_MS) {
      activeAgents.delete(name);
    }
  }

  if (activeAgents.size === 0) {
    container.hidden = true;
    container.innerHTML = '';
    return;
  }

  const entries = [...activeAgents.entries()].sort(([a], [b]) => a.localeCompare(b));
  const parts = entries.map(([name, entry]) => {
    const activity = entry.activity || 'thinking';
    return `<span class="typing-agent">@${escapeHtml(name)}</span> <span class="typing-activity">${escapeHtml(activity)}</span>`;
  });
  const label = parts.join(' · ');

  container.hidden = false;
  container.innerHTML = `
    <span class="typing-dots" aria-hidden="true">
      <span class="typing-dot"></span>
      <span class="typing-dot"></span>
      <span class="typing-dot"></span>
    </span>
    <span class="typing-label">${label}</span>
  `;
}
