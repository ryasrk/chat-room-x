/**
 * Agent Room — xb Progress Store
 *
 * In-memory store that tracks the progress of xb (deep-work model) tasks.
 * Used by xa (router model) to report progress when users ask "how's it going?"
 *
 * Each entry tracks:
 * - status: 'working' | 'done' | 'error'
 * - step: human-readable description of current step
 * - toolCalls: list of tool calls made so far
 * - startedAt: timestamp when work started
 * - updatedAt: timestamp of last update
 * - result: final result (when done)
 */

/** @type {Map<string, Map<string, XbProgress>>} roomId → agentName → progress */
const store = new Map();

/**
 * @typedef {Object} XbProgress
 * @property {'working' | 'done' | 'error'} status
 * @property {string} step - Current step description
 * @property {Array<{tool: string, status: string, timestamp: number}>} toolCalls
 * @property {number} startedAt
 * @property {number} updatedAt
 * @property {string|null} result - Final message (when done)
 * @property {string|null} error - Error message (when error)
 */

function getKey(roomId, agentName) {
  if (!store.has(roomId)) store.set(roomId, new Map());
  return store.get(roomId);
}

/**
 * Start tracking a new xb task.
 */
export function startXbTask(roomId, agentName, description = 'Processing request...') {
  const room = getKey(roomId);
  room.set(agentName, {
    status: 'working',
    step: description,
    toolCalls: [],
    startedAt: Date.now(),
    updatedAt: Date.now(),
    result: null,
    error: null,
  });
}

/**
 * Update the current step of an xb task.
 */
export function updateXbStep(roomId, agentName, step) {
  const room = getKey(roomId);
  const progress = room.get(agentName);
  if (!progress) return;
  progress.step = step;
  progress.updatedAt = Date.now();
}

/**
 * Record a tool call in the xb task.
 */
export function recordXbToolCall(roomId, agentName, toolName, status = 'success') {
  const room = getKey(roomId);
  const progress = room.get(agentName);
  if (!progress) return;
  progress.toolCalls.push({ tool: toolName, status, timestamp: Date.now() });
  progress.updatedAt = Date.now();
}

/**
 * Mark an xb task as complete.
 */
export function completeXbTask(roomId, agentName, resultMessage = '') {
  const room = getKey(roomId);
  const progress = room.get(agentName);
  if (!progress) return;
  progress.status = 'done';
  progress.result = resultMessage;
  progress.updatedAt = Date.now();
}

/**
 * Mark an xb task as failed.
 */
export function failXbTask(roomId, agentName, errorMessage = 'Task failed') {
  const room = getKey(roomId);
  const progress = room.get(agentName);
  if (!progress) return;
  progress.status = 'error';
  progress.error = errorMessage;
  progress.updatedAt = Date.now();
}

/**
 * Get the current progress of an xb task.
 * @returns {XbProgress|null}
 */
export function getXbProgress(roomId, agentName) {
  return store.get(roomId)?.get(agentName) || null;
}

/**
 * Get a human-readable progress summary for xa to report.
 * @returns {string}
 */
export function getXbProgressSummary(roomId, agentName) {
  const progress = getXbProgress(roomId, agentName);
  if (!progress) return 'No active task.';

  if (progress.status === 'done') {
    const elapsed = Math.round((progress.updatedAt - progress.startedAt) / 1000);
    return `Task completed in ${elapsed}s. ${progress.toolCalls.length} tool calls made.`;
  }

  if (progress.status === 'error') {
    return `Task failed: ${progress.error || 'unknown error'}`;
  }

  // Working
  const elapsed = Math.round((Date.now() - progress.startedAt) / 1000);
  const toolCount = progress.toolCalls.length;
  const lastTool = toolCount > 0 ? progress.toolCalls[toolCount - 1].tool : null;
  const parts = [`Working for ${elapsed}s`];
  if (progress.step) parts.push(`— ${progress.step}`);
  if (toolCount > 0) parts.push(`(${toolCount} tool calls${lastTool ? `, last: ${lastTool}` : ''})`);
  return parts.join(' ');
}

/**
 * Get all active xb tasks in a room.
 * @returns {Array<{agentName: string, progress: XbProgress}>}
 */
export function getActiveXbTasks(roomId) {
  const room = store.get(roomId);
  if (!room) return [];
  const active = [];
  for (const [agentName, progress] of room) {
    if (progress.status === 'working') {
      active.push({ agentName, progress });
    }
  }
  return active;
}

/**
 * Clean up completed/failed tasks older than maxAge (default: 5 minutes).
 */
export function cleanupXbTasks(maxAge = 5 * 60 * 1000) {
  const cutoff = Date.now() - maxAge;
  for (const [roomId, room] of store) {
    for (const [agentName, progress] of room) {
      if (progress.status !== 'working' && progress.updatedAt < cutoff) {
        room.delete(agentName);
      }
    }
    if (room.size === 0) store.delete(roomId);
  }
}
