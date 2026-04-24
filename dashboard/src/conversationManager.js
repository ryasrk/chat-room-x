// conversationManager.js — Multi-conversation management for chatbot dashboard

// ── State ──────────────────────────────────────────────────────

let _conversations = new Map();
let _activeId = null;
let _folders = new Set(['General']);
let _userId = null;

const FOLDERS_KEY_BASE = 'tenrary_folders';

function foldersKey() {
  return _userId ? `${FOLDERS_KEY_BASE}_${_userId}` : FOLDERS_KEY_BASE;
}

/**
 * Set the current user ID for scoped storage.
 */
export function setConversationUser(userId) {
  _userId = userId;
}

/**
 * Clear all in-memory conversation state.
 * Call on logout to prevent cross-user data leaks.
 */
export function clearAllConversations() {
  _conversations.clear();
  _activeId = null;
  _folders = new Set(['General']);
  try { localStorage.removeItem(foldersKey()); } catch { /* ignore */ }
}

function loadFolders() {
  try {
    const raw = localStorage.getItem(foldersKey());
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        _folders = new Set(['General', ...parsed.filter(f => typeof f === 'string')]);
      }
    }
  } catch { /* ignore */ }
}

function saveFolders() {
  try {
    localStorage.setItem(foldersKey(), JSON.stringify([..._folders]));
  } catch { /* ignore */ }
}

// Load persisted folders on module init
loadFolders();

// ── Helpers ────────────────────────────────────────────────────

function generateId() {
  return `conv_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function now() {
  return Date.now();
}

function escapeHtml(str) {
  if (typeof str !== 'string') return String(str || '');
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function dispatch(name, detail) {
  document.dispatchEvent(new CustomEvent(name, { detail }));
}

// ── Core API ───────────────────────────────────────────────────

export function createConversation(title = 'New Chat', mode = 'enowxai') {
  const ts = now();
  const conversation = {
    id: generateId(),
    title,
    messages: [],
    createdAt: ts,
    updatedAt: ts,
    mode,
    messageCount: 0,
    folder: '',
  };

  _conversations.set(conversation.id, conversation);
  dispatch('conversation:create', { id: conversation.id, conversation });
  return conversation;
}

export function setFolder(id, folder) {
  const conv = _conversations.get(id);
  if (!conv) return null;

  const updated = { ...conv, folder: folder || '', updatedAt: now() };
  _conversations.set(id, updated);
  dispatch('conversation:folder', { id, folder });
  return updated;
}

export function createFolder(name) {
  if (!name || !name.trim()) return false;
  if (_folders.has(name)) return false;
  _folders.add(name.trim());
  saveFolders();
  dispatch('folder:create', { name: name.trim() });
  return true;
}

export function deleteFolder(name) {
  if (name === 'General') return false;
  if (!_folders.has(name)) return false;
  _folders.delete(name);
  saveFolders();
  // Move conversations from deleted folder to General
  for (const conv of _conversations.values()) {
    if (conv.folder === name) {
      setFolder(conv.id, '');
    }
  }
  dispatch('folder:delete', { name });
  return true;
}

export function getFolders() {
  return [..._folders];
}

export function syncFoldersFromConversations(conversations) {
  let changed = false;
  for (const conv of conversations) {
    if (conv.folder && !_folders.has(conv.folder)) {
      _folders.add(conv.folder);
      changed = true;
    }
  }
  if (changed) saveFolders();
}

export function renameConversation(id, newTitle) {
  const conv = _conversations.get(id);
  if (!conv) return null;

  // H5 fix: create new object instead of mutating
  const updated = { ...conv, title: newTitle, updatedAt: now() };
  _conversations.set(id, updated);
  dispatch('conversation:rename', { id, title: newTitle });
  return updated;
}

export function deleteConversation(id) {
  if (!_conversations.has(id)) return false;

  _conversations.delete(id);
  dispatch('conversation:delete', { id });

  if (_activeId === id) {
    // Switch to the most recent remaining conversation, or clear
    const sorted = sortConversations([..._conversations.values()]);
    _activeId = sorted.length > 0 ? sorted[0].id : null;

    if (_activeId) {
      const next = _conversations.get(_activeId);
      dispatch('conversation:switch', { id: _activeId, conversation: next });
    }
  }

  return true;
}

export function switchConversation(id) {
  const conv = _conversations.get(id);
  if (!conv) return null;

  _activeId = id;
  // H5 fix: create new object instead of mutating
  const updated = { ...conv, updatedAt: now() };
  _conversations.set(id, updated);
  dispatch('conversation:switch', { id, conversation: updated });
  return updated;
}

export function getActiveConversation() {
  if (!_activeId) return null;
  return _conversations.get(_activeId) ?? null;
}

// ── Search / Filter ────────────────────────────────────────────

export function searchConversations(query, conversations) {
  if (!query || !query.trim()) return conversations;

  const q = query.toLowerCase().trim();

  return conversations.filter((conv) => {
    const title = typeof conv.title === 'string' ? conv.title : String(conv.title || '');
    if (title.toLowerCase().includes(q)) return true;

    if (!Array.isArray(conv.messages)) return false;
    return conv.messages.some(
      (msg) => typeof msg.content === 'string' && msg.content.toLowerCase().includes(q),
    );
  });
}

// ── Title Generation ───────────────────────────────────────────

function extractFallbackTitle(firstMessage) {
  if (!firstMessage || typeof firstMessage !== 'string') return 'New Chat';

  const cleaned = firstMessage
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return 'New Chat';

  if (cleaned.length <= 40) return cleaned;

  // Truncate at last word boundary within 40 chars
  const truncated = cleaned.slice(0, 40);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > 20 ? truncated.slice(0, lastSpace) : truncated) + '…';
}

function sanitizeGeneratedTitle(title) {
  if (typeof title !== 'string') return '';

  return title
    .replace(/[\n\r"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function generateTitleFallback(firstMessage) {
  return extractFallbackTitle(firstMessage);
}

export async function generateTitle(firstMessage, options = {}) {
  const fallback = extractFallbackTitle(firstMessage);
  options.onFallback?.(fallback);

  if (!firstMessage || firstMessage.trim().length < 10) return fallback;

  const endpoint = typeof options.apiEndpoint === 'string' && options.apiEndpoint.trim()
    ? options.apiEndpoint.trim()
    : '/v1/chat/completions';

  try {
    const { buildModeRequestPayload } = await import('./providerConfig.js');
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildModeRequestPayload(options.mode, {
        messages: [
          {
            role: 'system',
            content: 'Generate a concise 3-6 word title for this conversation. Return only the title, nothing else.',
          },
          {
            role: 'user',
            content: firstMessage.slice(0, 500),
          },
        ],
        max_tokens: 20,
        temperature: 0.2,
        stream: false,
      }, {
        enableThinking: options.enableThinking,
        selectedModel: options.selectedModel,
      })),
      signal: options.signal,
    });

    if (!response.ok) {
      return fallback;
    }

    const data = await response.json();
    const rawTitle = data?.choices?.[0]?.message?.content ?? '';
    const cleaned = sanitizeGeneratedTitle(rawTitle);

    if (cleaned.length >= 3 && cleaned.length <= 60) return cleaned;
    return fallback;
  } catch {
    return fallback;
  }
}

export async function generateTitleViaLLM(firstMessage, options = {}) {
  return generateTitle(firstMessage, options);
}

// ── Sorting ────────────────────────────────────────────────────

export function sortConversations(conversations) {
  return [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);
}

// ── Rendering ──────────────────────────────────────────────────

export function renderConversationItem(conversation, isActive) {
  const activeClass = isActive ? ' active' : '';
  const rawTitle = typeof conversation.title === 'string' ? conversation.title : '';
  const title = escapeHtml(rawTitle || 'New Chat');
  const timeAgo = formatTimeAgo(conversation.updatedAt);

  return `<div class="conv-item${activeClass}" data-conv-id="${escapeHtml(conversation.id)}">
  <span class="conv-title" title="${title}">${title}</span>
  <span class="conv-time">${timeAgo}</span>
  <button class="conv-delete" title="Delete">×</button>
</div>`;
}

export function renderFolderHeader(name, chatCount) {
  const escaped = escapeHtml(name);
  const isGeneral = name === 'General';
  const deleteBtn = isGeneral ? '' : '<button class="folder-delete" title="Delete project">×</button>';
  return `<div class="folder-header${isGeneral ? ' folder-header--general' : ''}" data-folder="${escaped}">
  <span class="folder-toggle">▾</span>
  <span class="folder-icon">${isGeneral ? '💬' : '📁'}</span>
  <span class="folder-name">${escaped}</span>
  <span class="folder-count">${chatCount}</span>
  ${deleteBtn}
</div>`;
}

export function renderConversationList(conversations, activeId) {
  const sorted = sortConversations(conversations);
  const allFolders = getFolders();
  const hasCustomFolders = allFolders.some((f) => f !== 'General');

  if (sorted.length === 0 && !hasCustomFolders) {
    return '<div class="sidebar-empty"><span class="sidebar-empty-icon">💬</span><p>No conversations yet</p><p class="sidebar-empty-hint">Start a new chat or create a project</p></div>';
  }

  // Group conversations by folder
  const folders = new Map();
  for (const conv of sorted) {
    const folder = conv.folder || 'General';
    if (!folders.has(folder)) folders.set(folder, []);
    folders.get(folder).push(conv);
  }

  let html = '';

  // Ensure General is always present in tree mode
  if (!folders.has('General')) {
    folders.set('General', []);
  }

  // Render "General" first, then alphabetical folders
  const folderNames = [...folders.keys()].sort((a, b) => {
    if (a === 'General') return -1;
    if (b === 'General') return 1;
    return a.localeCompare(b);
  });

  // If only "General" exists and no custom folders, render flat list
  if (folderNames.length <= 1 && !hasCustomFolders) {
    if (sorted.length === 0) {
      return '<div class="sidebar-empty"><span class="sidebar-empty-icon">💬</span><p>No conversations yet</p><p class="sidebar-empty-hint">Start a new chat or create a project</p></div>';
    }
    return sorted
      .map((conv) => renderConversationItem(conv, conv.id === activeId))
      .join('\n');
  }

  for (const name of folderNames) {
    const items = folders.get(name);
    html += `<div class="folder-group">`;
    html += renderFolderHeader(name, items.length);
    html += `<div class="folder-content" data-folder="${escapeHtml(name)}">`;
    if (items.length > 0) {
      html += items
        .map((conv) => renderConversationItem(conv, conv.id === activeId))
        .join('\n');
    } else {
      html += '<div class="folder-empty">No chats yet</div>';
    }
    html += '</div></div>';
  }

  // Show empty folders that have no conversations
  for (const name of allFolders) {
    if (name !== 'General' && !folders.has(name)) {
      html += `<div class="folder-group">`;
      html += renderFolderHeader(name, 0);
      html += `<div class="folder-content" data-folder="${escapeHtml(name)}">`;
      html += '<div class="folder-empty">No chats yet</div>';
      html += '</div></div>';
    }
  }

  return html;
}

// ── Time formatting ────────────────────────────────────────────

export function formatTimeAgo(timestamp) {
  const diff = now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

// ── Bulk operations ────────────────────────────────────────────

export function getAllConversations() {
  return [..._conversations.values()];
}

export function setConversations(conversations) {
  _conversations.clear();
  for (const conv of conversations) {
    _conversations.set(conv.id, conv);
  }
}

export function getConversation(id) {
  return _conversations.get(id) ?? null;
}

export function setActiveId(id) {
  _activeId = id;
}

export function getActiveId() {
  return _activeId;
}
