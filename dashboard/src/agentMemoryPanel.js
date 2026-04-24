/**
 * Agent Memory Panel — displays and manages per-agent private memories
 * in the Agent Room AI page.
 */

import { getAgentRoomMemories, updateAgentRoomMemory, clearAgentRoomMemory } from './authClient.js';
import { rs, escapeHtml } from './roomsUtils.js';
import { showToast } from './utils.js';

/** @type {Array<{agent_name: string, memory_text: string, updated_at: number|null}>} */
let memories = [];

export async function loadAgentMemories() {
  if (!rs.currentAgentRoomId) return;

  try {
    const data = await getAgentRoomMemories(rs.currentAgentRoomId);
    memories = data.memories || [];
  } catch {
    memories = [];
  }

  renderAgentMemories();
}

export function renderAgentMemories() {
  const container = rs.panel?.querySelector('#agent-room-memory-list');
  if (!container) return;

  const agents = rs.currentAgentMembers || [];

  if (agents.length === 0) {
    container.innerHTML = '<p class="empty-state">No agents in this room yet.</p>';
    return;
  }

  container.innerHTML = agents.map((agent) => {
    const mem = memories.find((m) => m.agent_name === agent.name);
    const text = mem?.memory_text || '';
    const updatedAt = mem?.updated_at
      ? new Date(Number(mem.updated_at) * 1000).toLocaleString()
      : 'never';
    const hasMemory = text.length > 0;

    return `
      <div class="agent-memory-card" data-agent-memory="${escapeHtml(agent.name)}">
        <div class="agent-memory-header">
          <span class="agent-memory-name">@${escapeHtml(agent.name)}</span>
          <span class="agent-memory-meta">${hasMemory ? `Updated ${escapeHtml(updatedAt)}` : 'No memory yet'}</span>
        </div>
        <textarea class="agent-memory-text" rows="4" placeholder="Agent's private memory will appear here after it processes messages..."
          data-agent-name="${escapeHtml(agent.name)}">${escapeHtml(text)}</textarea>
        <div class="agent-memory-actions">
          <button type="button" class="btn-sm btn-secondary agent-memory-save" data-agent-name="${escapeHtml(agent.name)}">Save</button>
          <button type="button" class="btn-sm btn-danger agent-memory-clear" data-agent-name="${escapeHtml(agent.name)}" ${!hasMemory ? 'disabled' : ''}>Clear</button>
        </div>
      </div>
    `;
  }).join('');
}

export async function saveAgentMemory(agentName) {
  if (!rs.currentAgentRoomId || !agentName) return;

  const textarea = rs.panel?.querySelector(`.agent-memory-text[data-agent-name="${CSS.escape(agentName)}"]`);
  if (!textarea) return;

  try {
    await updateAgentRoomMemory(rs.currentAgentRoomId, agentName, textarea.value);
    showToast(`Memory for @${agentName} saved.`, 'success');
    await loadAgentMemories();
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'Failed to save memory.', 'error');
  }
}

export async function clearAgentMemoryAction(agentName) {
  if (!rs.currentAgentRoomId || !agentName) return;

  try {
    await clearAgentRoomMemory(rs.currentAgentRoomId, agentName);
    showToast(`Memory for @${agentName} cleared.`, 'success');
    await loadAgentMemories();
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'Failed to clear memory.', 'error');
  }
}
