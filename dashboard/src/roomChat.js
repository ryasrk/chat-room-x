import { getRoomMessages, sendRoomMessage, sendAgentRoomMessage, getCurrentUser } from './authClient.js';
import { rs, escapeHtml, getFileIcon } from './roomsUtils.js';
import { renderMarkdown } from './markdownRenderer.js';

/** ETag cache for room message polling — avoids re-rendering unchanged data */
const _roomMessageEtags = new Map();

export async function loadRoomMessages(roomId) {
  if (roomId !== rs.currentRoomId || rs.currentRoomMode !== 'team') return;
  // Skip polling when tab is hidden — saves bandwidth and battery
  if (document.hidden) return;
  try {
    const etag = _roomMessageEtags.get(roomId) || null;
    const result = await getRoomMessages(roomId, 50, null, etag);
    if (result === null) return; // 304 Not Modified — skip re-render
    if (result._etag) _roomMessageEtags.set(roomId, result._etag);
    renderRoomMessages(result.messages || [], 'team');
  } catch { /* silent */ }
}

export function renderRoomMessages(messages, mode) {
  const container = rs.panel?.querySelector('#room-messages');
  if (!container) return;
  const currentUser = getCurrentUser();
  const wasAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 60;

  rs.seenMessageIds.clear();
  messages.forEach((m) => {
    const id = m.id || `${m.sender_name}:${m.created_at}:${(m.content || '').slice(0, 50)}`;
    rs.seenMessageIds.add(id);
  });

  container.innerHTML = messages.map((message) => {
    if (mode === 'agent') {
      const isMe = message.sender_type === 'user' && message.sender_name === currentUser?.username;
      const isSystem = message.sender_type === 'system';
      const author = message.sender_type === 'agent' ? `@${message.sender_name}` : message.sender_name;

      if (isSystem) {
        return `<div class="room-msg room-msg-system">${escapeHtml(message.content)}</div>`;
      }

      const artifactsHtml = (message.artifacts || []).length > 0
        ? `<div class="room-msg-artifacts">${message.artifacts.map((a) => renderArtifactChip(a)).join('')}</div>`
        : '';

      const eventType = normalizeAgentEventType(message.event_type);
      // Agent messages use markdown rendering; user messages use plain text escape
      const contentHtml = message.sender_type === 'agent'
        ? renderMarkdown(message.content)
        : escapeHtml(message.content);

      return `
        <div class="room-msg ${isMe ? 'room-msg-me' : 'room-msg-other'} room-msg-agent-${escapeHtml(message.sender_type || 'user')} room-msg-event-${escapeHtml(eventType.key)} ${message.event_type === 'handoff' ? 'room-msg-handoff' : ''}">
          <div class="room-msg-header">
            <div class="room-msg-author-group">
              <span class="room-msg-author">${escapeHtml(author)}</span>
              <span class="room-msg-type-badge room-msg-type-${escapeHtml(eventType.key)}">${escapeHtml(eventType.label)}</span>
            </div>
            <span class="room-msg-time">${escapeHtml(eventType.meta)}</span>
          </div>
          <div class="room-msg-content">${contentHtml}</div>
          ${artifactsHtml}
        </div>
      `;
    }

    const isMe = message.user_id === currentUser?.id;
    const isSystem = message.message_type === 'system';

    if (isSystem) {
      return `<div class="room-msg room-msg-system">${escapeHtml(message.content)}</div>`;
    }

    const time = new Date(message.created_at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `
      <div class="room-msg ${isMe ? 'room-msg-me' : 'room-msg-other'}">
        <div class="room-msg-header">
          <span class="room-msg-author">${escapeHtml(message.display_name || message.username)}</span>
          <span class="room-msg-time">${time}</span>
        </div>
        <div class="room-msg-content">${escapeHtml(message.content)}</div>
      </div>
    `;
  }).join('');

  if (wasAtBottom) {
    container.scrollTop = container.scrollHeight;
  }
}

export function appendAgentRoomMessage(message) {
  const container = rs.panel?.querySelector('#room-messages');
  if (!container) return;

  const msgId = message.id || `${message.sender_name}:${message.created_at}:${(message.content || '').slice(0, 50)}`;
  if (rs.seenMessageIds.has(msgId)) return;
  rs.seenMessageIds.add(msgId);

  const currentUser = getCurrentUser();
  const isMe = message.sender_type === 'user' && message.sender_name === currentUser?.username;
  const isSystem = message.sender_type === 'system';
  const author = message.sender_type === 'agent' ? `@${message.sender_name}` : message.sender_name;

  let html;
  if (isSystem) {
    html = `<div class="room-msg room-msg-system">${escapeHtml(message.content)}</div>`;
  } else {
    const artifactsHtml = (message.artifacts || []).length > 0
      ? `<div class="room-msg-artifacts">${message.artifacts.map((a) => renderArtifactChip(a)).join('')}</div>`
      : '';

    const eventType = normalizeAgentEventType(message.event_type);
    const contentHtml = message.sender_type === 'agent'
      ? renderMarkdown(message.content)
      : escapeHtml(message.content);

    html = `
      <div class="room-msg ${isMe ? 'room-msg-me' : 'room-msg-other'} room-msg-agent-${escapeHtml(message.sender_type || 'user')} room-msg-event-${escapeHtml(eventType.key)} ${message.event_type === 'handoff' ? 'room-msg-handoff' : ''}">
        <div class="room-msg-header">
          <div class="room-msg-author-group">
            <span class="room-msg-author">${escapeHtml(author)}</span>
            <span class="room-msg-type-badge room-msg-type-${escapeHtml(eventType.key)}">${escapeHtml(eventType.label)}</span>
          </div>
          <span class="room-msg-time">${escapeHtml(eventType.meta)}</span>
        </div>
        <div class="room-msg-content">${contentHtml}</div>
        ${artifactsHtml}
      </div>
    `;
  }

  const wasAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 60;
  container.insertAdjacentHTML('beforeend', html);
  if (wasAtBottom) {
    container.scrollTop = container.scrollHeight;
  }
}

export function appendSkillEvent(payload) {
  const container = rs.panel?.querySelector('#room-messages');
  if (!container) return;

  const agent = payload.agent_name || 'agent';
  const tool = payload.tool || '';
  const meta = payload.meta || {};
  let label = '';
  let detail = '';

  if (tool === 'search_skills') {
    const query = meta.query || '';
    const count = meta.result_count ?? 0;
    const topSkills = (meta.top_skills || []).slice(0, 3);
    label = '🔍 Skill Search';
    detail = `"${query}" → ${count} result${count !== 1 ? 's' : ''}`;
    if (topSkills.length > 0) {
      detail += ` (${topSkills.join(', ')})`;
    }
  } else if (tool === 'read_skill') {
    const skillId = meta.skill_id || '';
    const filePath = meta.file_path || 'SKILL.md';
    const skillName = meta.skill_name || skillId;
    label = '📖 Skill Read';
    detail = filePath === 'SKILL.md'
      ? skillName
      : `${skillName} / ${filePath}`;
  } else if (tool === 'list_skill_files') {
    const skillId = meta.skill_id || '';
    const skillPath = meta.skill_path || '.';
    const count = meta.result_count ?? 0;
    label = '📂 Skill Browse';
    detail = `${skillId}${skillPath !== '.' ? '/' + skillPath : ''} (${count} entries)`;
  } else {
    return;
  }

  const html = `
    <div class="room-msg room-msg-skill-event">
      <span class="skill-event-agent">@${escapeHtml(agent)}</span>
      <span class="skill-event-label">${label}</span>
      <span class="skill-event-detail">${escapeHtml(detail)}</span>
    </div>
  `;

  const wasAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 60;
  container.insertAdjacentHTML('beforeend', html);
  if (wasAtBottom) {
    container.scrollTop = container.scrollHeight;
  }
}

function renderArtifactChip(artifact) {
  const path = artifact?.path || '';
  const label = path.split('/').pop() || path || 'artifact';
  const icon = getFileIcon(path);
  const kind = artifact?.tool === 'write_file' ? 'new file' : 'updated file';
  return `
    <button type="button" class="room-msg-artifact" data-artifact-path="${escapeHtml(path)}" title="${escapeHtml(path)}">
      <span class="room-msg-artifact-icon">${escapeHtml(icon)}</span>
      <span class="room-msg-artifact-copy">
        <span class="room-msg-artifact-name">${escapeHtml(label)}</span>
        <small>${escapeHtml(kind)}</small>
      </span>
    </button>
  `;
}

function normalizeAgentEventType(eventType) {
  const value = String(eventType || 'message').toLowerCase();
  if (value === 'handoff') return { key: 'handoff', label: 'Handoff', meta: 'delegated task' };
  if (value === 'thinking') return { key: 'thinking', label: 'Thinking', meta: 'working through approach' };
  if (value === 'message') return { key: 'message', label: 'Update', meta: 'agent response' };
  return { key: 'message', label: value, meta: 'agent event' };
}
