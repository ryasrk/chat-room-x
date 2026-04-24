/**
 * Orchestration Mode Switcher — UI to toggle between reactive/legacy modes
 * and adjust autonomy level with a slider.
 */

import { updateAgentRoomConfig } from './authClient.js';
import { rs, escapeHtml } from './roomsUtils.js';
import { showToast } from './utils.js';

const AUTONOMY_LABELS = [
  { level: 0, label: 'Manual', desc: 'Agents respond only when directly mentioned.' },
  { level: 1, label: 'Guided', desc: 'Agents follow handoffs and direct mentions. Minimal autonomy.' },
  { level: 2, label: 'Balanced', desc: 'Agents react to relevant messages and delegate proactively.' },
  { level: 3, label: 'Autonomous', desc: 'Maximum autonomy — agents self-organize and chain tasks.' },
];

const MODE_LABELS = {
  reactive: { label: 'Reactive', desc: 'Agents observe the conversation and respond based on relevance, mentions, and role.' },
  legacy: { label: 'Legacy', desc: 'Simple turn-based mode — one agent per cycle, explicit mentions only.' },
};

export function renderOrchestrationConfig() {
  const container = rs.panel?.querySelector('#agent-room-orchestration-config');
  if (!container) return;

  const mode = rs.agentRoomOrchestrationMode || 'reactive';
  const autonomy = rs.agentRoomAutonomyLevel ?? 2;
  const autonomyInfo = AUTONOMY_LABELS[autonomy] || AUTONOMY_LABELS[2];

  container.innerHTML = `
    <div class="orch-config-row">
      <div class="orch-config-group">
        <label class="orch-config-label" for="orch-mode-select">Orchestration Mode</label>
        <select id="orch-mode-select" class="orch-config-select">
          <option value="reactive" ${mode === 'reactive' ? 'selected' : ''}>Reactive — multi-agent, relevance-based</option>
          <option value="legacy" ${mode === 'legacy' ? 'selected' : ''}>Legacy — single-agent, turn-based</option>
        </select>
        <p class="orch-config-hint">${escapeHtml(MODE_LABELS[mode]?.desc || '')}</p>
      </div>
      <div class="orch-config-group">
        <label class="orch-config-label" for="orch-autonomy-slider">
          Autonomy Level: <strong id="orch-autonomy-value">${escapeHtml(autonomyInfo.label)} (${autonomy})</strong>
        </label>
        <input type="range" id="orch-autonomy-slider" min="0" max="3" step="1" value="${autonomy}" class="orch-config-slider" />
        <p class="orch-config-hint" id="orch-autonomy-desc">${escapeHtml(autonomyInfo.desc)}</p>
      </div>
    </div>
    <div class="orch-config-preview">
      <span class="orch-config-preview-label">Effect:</span>
      <span id="orch-config-preview-text">${escapeHtml(getConfigPreview(mode, autonomy))}</span>
    </div>
  `;
}

function getConfigPreview(mode, autonomy) {
  if (mode === 'legacy') {
    return '1 agent per cycle, 1 turn per agent, 4 max cycles.';
  }
  const maxCycles = 6 + (autonomy * 3);
  const maxAgentsPerCycle = Math.min(autonomy + 1, 4);
  const maxTurnsPerAgent = Math.min(autonomy, 3) || 1;
  return `Up to ${maxAgentsPerCycle} agents/cycle, ${maxTurnsPerAgent} turns/agent, ${maxCycles} max cycles.`;
}

export async function handleOrchestrationModeChange(mode) {
  if (!rs.currentAgentRoomId) return;

  try {
    const data = await updateAgentRoomConfig(rs.currentAgentRoomId, { orchestration_mode: mode });
    rs.agentRoomOrchestrationMode = data.room?.orchestration_mode || mode;
    rs.agentRoomAutonomyLevel = data.room?.autonomy_level ?? rs.agentRoomAutonomyLevel;
    renderOrchestrationConfig();
    showToast(`Mode set to ${MODE_LABELS[mode]?.label || mode}.`, 'success');
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'Failed to update mode.', 'error');
  }
}

export async function handleAutonomyLevelChange(level) {
  if (!rs.currentAgentRoomId) return;

  const numLevel = Number(level);
  const autonomyInfo = AUTONOMY_LABELS[numLevel] || AUTONOMY_LABELS[2];

  // Update preview immediately for responsiveness
  const valueEl = rs.panel?.querySelector('#orch-autonomy-value');
  const descEl = rs.panel?.querySelector('#orch-autonomy-desc');
  const previewEl = rs.panel?.querySelector('#orch-config-preview-text');
  if (valueEl) valueEl.textContent = `${autonomyInfo.label} (${numLevel})`;
  if (descEl) descEl.textContent = autonomyInfo.desc;
  if (previewEl) previewEl.textContent = getConfigPreview(rs.agentRoomOrchestrationMode || 'reactive', numLevel);

  try {
    const data = await updateAgentRoomConfig(rs.currentAgentRoomId, { autonomy_level: numLevel });
    rs.agentRoomAutonomyLevel = data.room?.autonomy_level ?? numLevel;
    rs.agentRoomOrchestrationMode = data.room?.orchestration_mode || rs.agentRoomOrchestrationMode;
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'Failed to update autonomy level.', 'error');
  }
}
