/**
 * xb Progress Bar — shows real-time progress when the deep-work model (xb)
 * is running in the background after xa acknowledged the request.
 *
 * Listens to `agent_room:xb_progress` WebSocket events and renders
 * a compact progress indicator above the typing indicator.
 */

import { rs, escapeHtml } from './roomsUtils.js';

/** @type {Map<string, {step: string, status: string, toolCount: number, startedAt: number}>} */
const activeTasks = new Map();

/**
 * Handle an xb_progress event from the WebSocket.
 * @param {{agent_name: string, step: string, status?: string, tool?: string, tool_count?: number, timestamp: number}} payload
 */
export function handleXbProgress(payload) {
  const name = String(payload.agent_name || '').toLowerCase();
  if (!name) return;

  const status = payload.status || 'running';

  if (status === 'started') {
    activeTasks.set(name, {
      step: payload.step || 'Starting...',
      status: 'running',
      toolCount: 0,
      startedAt: payload.timestamp || Math.floor(Date.now() / 1000),
    });
  } else if (status === 'completed' || status === 'failed') {
    activeTasks.delete(name);
  } else {
    // Running — update step
    const task = activeTasks.get(name);
    if (task) {
      task.step = payload.step || task.step;
      if (payload.tool) {
        task.toolCount += 1;
      }
      if (payload.tool_count !== undefined) {
        task.toolCount = payload.tool_count;
      }
    }
  }

  renderXbProgressBar();
}

/**
 * Clear all xb progress (e.g., on room switch or disconnect).
 */
export function clearXbProgress() {
  activeTasks.clear();
  renderXbProgressBar();
}

function renderXbProgressBar() {
  const container = rs.panel?.querySelector('#xb-progress-bar');
  if (!container) return;

  if (activeTasks.size === 0) {
    container.hidden = true;
    container.innerHTML = '';
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const entries = [...activeTasks.entries()].sort(([a], [b]) => a.localeCompare(b));

  const html = entries.map(([name, task]) => {
    const elapsed = Math.max(0, now - task.startedAt);
    const elapsedLabel = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
    const toolLabel = task.toolCount > 0 ? ` · ${task.toolCount} tool${task.toolCount !== 1 ? 's' : ''}` : '';

    return `
      <div class="xb-task">
        <div class="xb-task-header">
          <span class="xb-task-agent">@${escapeHtml(name)}</span>
          <span class="xb-task-meta">${escapeHtml(elapsedLabel)}${toolLabel}</span>
        </div>
        <div class="xb-task-step">
          <span class="xb-spinner" aria-hidden="true"></span>
          <span class="xb-step-text">${escapeHtml(task.step)}</span>
        </div>
      </div>
    `;
  }).join('');

  container.hidden = false;
  container.innerHTML = html;
}
