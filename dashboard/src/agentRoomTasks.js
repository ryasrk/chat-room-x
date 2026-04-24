import {
  createAgentRoomTask,
  getAgentRoomTasks,
  updateAgentRoomTask,
} from './authClient.js';
import { rs, escapeHtml, sanitizeClassToken } from './roomsUtils.js';
import { showToast } from './utils.js';

const TASK_STATUS_LABELS = {
  todo: 'To do',
  in_progress: 'In progress',
  blocked: 'Blocked',
  done: 'Done',
};

const TASK_PRIORITY_LABELS = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

function getAgentTaskListElement() {
  return rs.panel?.querySelector('#agent-room-task-list') || null;
}

function getTaskAssigneeOptions(selectedValue = '') {
  const options = ['<option value="">Unassigned</option>'];
  for (const agent of rs.currentAgentMembers || []) {
    const name = String(agent?.name || '').trim();
    if (!name) continue;
    options.push(`<option value="${escapeHtml(name)}" ${selectedValue === name ? 'selected' : ''}>@${escapeHtml(name)}</option>`);
  }
  return options.join('');
}

function formatTaskUpdatedAt(updatedAt) {
  if (!updatedAt) return 'Updated just now';
  const date = new Date(Number(updatedAt) * 1000);
  if (Number.isNaN(date.getTime())) return 'Updated just now';
  return `Updated ${date.toLocaleString()}`;
}

export function syncAgentTaskAssigneeOptions() {
  const assigneeSelect = rs.panel?.querySelector('#agent-room-task-assignee');
  if (assigneeSelect) {
    assigneeSelect.innerHTML = getTaskAssigneeOptions(assigneeSelect.value);
  }

  getAgentTaskListElement()?.querySelectorAll('[data-task-assignee-select]').forEach((select) => {
    const currentValue = select.value;
    select.innerHTML = getTaskAssigneeOptions(currentValue);
    select.value = currentValue;
  });
}

export function renderAgentRoomTasks() {
  const listEl = getAgentTaskListElement();
  if (!listEl) return;

  const tasks = Array.isArray(rs.agentRoomTasks) ? rs.agentRoomTasks : [];
  if (tasks.length === 0) {
    listEl.innerHTML = `
      <div class="agent-task-empty">
        <strong>No tasks yet.</strong>
        <span>Create the first structured task for this room.</span>
      </div>
    `;
    syncAgentTaskAssigneeOptions();
    return;
  }

  listEl.innerHTML = tasks.map((task) => `
    <article class="agent-task-item priority-${sanitizeClassToken(task.priority, 'medium')}" data-task-id="${escapeHtml(task.id)}">
      <div class="agent-task-main">
        <div class="agent-task-title-row">
          <h5>${escapeHtml(task.title)}</h5>
          <span class="agent-task-status task-status-${sanitizeClassToken(task.status, 'todo')}">${escapeHtml(TASK_STATUS_LABELS[task.status] || task.status || 'To do')}</span>
        </div>
        <div class="agent-task-meta-row">
          <span class="agent-task-priority">${escapeHtml(TASK_PRIORITY_LABELS[task.priority] || task.priority || 'Medium')} priority</span>
          <span class="agent-task-updated">${escapeHtml(formatTaskUpdatedAt(task.updated_at))}</span>
        </div>
        ${task.details ? `<p class="agent-task-details">${escapeHtml(task.details)}</p>` : ''}
      </div>
      <div class="agent-task-controls">
        <label>
          <span>Status</span>
          <select data-task-status-select data-task-id="${escapeHtml(task.id)}">
            ${Object.entries(TASK_STATUS_LABELS).map(([value, label]) => `<option value="${value}" ${task.status === value ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
        </label>
        <label>
          <span>Assignee</span>
          <select data-task-assignee-select data-task-id="${escapeHtml(task.id)}">
            ${getTaskAssigneeOptions(task.assignee_name || '')}
          </select>
        </label>
      </div>
    </article>
  `).join('');
}

export function hydrateAgentRoomTasks(tasks = []) {
  rs.agentRoomTasks = Array.isArray(tasks) ? tasks : [];
  renderAgentRoomTasks();
}

export function resetAgentRoomTasks() {
  rs.agentRoomTasks = [];
  renderAgentRoomTasks();
}

export async function refreshAgentRoomTasks() {
  if (!rs.currentAgentRoomId) return;
  const data = await getAgentRoomTasks(rs.currentAgentRoomId);
  hydrateAgentRoomTasks(data.tasks || []);
}

export async function handleAgentTaskFormSubmit(event) {
  event.preventDefault();
  if (!rs.currentAgentRoomId) return;

  const form = event.currentTarget;
  const titleInput = form.querySelector('#agent-room-task-title');
  const detailsInput = form.querySelector('#agent-room-task-details');
  const priorityInput = form.querySelector('#agent-room-task-priority');
  const assigneeInput = form.querySelector('#agent-room-task-assignee');

  try {
    const data = await createAgentRoomTask(rs.currentAgentRoomId, {
      title: titleInput?.value || '',
      details: detailsInput?.value || '',
      priority: priorityInput?.value || 'medium',
      assignee_name: assigneeInput?.value || '',
    });
    hydrateAgentRoomTasks(data.tasks || []);
    form.reset();
    syncAgentTaskAssigneeOptions();
    showToast('Task created', 'success');
  } catch (error) {
    showToast(error.message || 'Failed to create task', 'error');
  }
}

async function persistTaskUpdate(taskId, fields) {
  if (!rs.currentAgentRoomId || !taskId) return;
  try {
    const data = await updateAgentRoomTask(rs.currentAgentRoomId, taskId, fields);
    hydrateAgentRoomTasks(data.tasks || []);
  } catch (error) {
    showToast(error.message || 'Failed to update task', 'error');
  }
}

export async function handleAgentTaskListChange(event) {
  const statusSelect = event.target.closest('[data-task-status-select]');
  if (statusSelect) {
    await persistTaskUpdate(statusSelect.dataset.taskId, { status: statusSelect.value });
    return;
  }

  const assigneeSelect = event.target.closest('[data-task-assignee-select]');
  if (assigneeSelect) {
    await persistTaskUpdate(assigneeSelect.dataset.taskId, { assignee_name: assigneeSelect.value });
  }
}