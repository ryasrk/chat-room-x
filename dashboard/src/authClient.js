/**
 * Auth Client — handles registration, login, token management, and session state.
 * Stores tokens in localStorage. Auto-refreshes access tokens before expiry.
 */

const TOKEN_KEY = 'tenrary_auth_tokens';
const USER_KEY = 'tenrary_auth_user';

let _refreshTimer = null;
let _onAuthChange = null;

// ── Token Storage ──────────────────────────────────────────────

function getStoredTokens() {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function storeTokens(tokens) {
  localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens));
  scheduleRefresh(tokens.expires_in || 900);
}

function clearTokens() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  if (_refreshTimer) clearTimeout(_refreshTimer);
}

function getStoredUser() {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function storeUser(user) {
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

// ── API Helpers ────────────────────────────────────────────────

async function apiPost(path, body, auth = false) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) {
    const tokens = getStoredTokens();
    if (tokens?.access_token) {
      headers['Authorization'] = `Bearer ${tokens.access_token}`;
    }
  }

  const res = await fetch(path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/** In-flight GET request deduplication map */
const _inflightGets = new Map();

async function apiGet(path) {
  // Deduplicate concurrent GET requests to the same path
  if (_inflightGets.has(path)) {
    return _inflightGets.get(path);
  }

  const promise = (async () => {
    const tokens = getStoredTokens();
    const headers = {};
    if (tokens?.access_token) {
      headers['Authorization'] = `Bearer ${tokens.access_token}`;
    }

    const res = await fetch(path, { headers });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  })();

  _inflightGets.set(path, promise);
  try {
    return await promise;
  } finally {
    _inflightGets.delete(path);
  }
}

async function apiGetBlob(path) {
  const tokens = getStoredTokens();
  const headers = {};
  if (tokens?.access_token) {
    headers['Authorization'] = `Bearer ${tokens.access_token}`;
  }

  const res = await fetch(path, { headers });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }

  return {
    blob: await res.blob(),
    disposition: res.headers.get('content-disposition') || '',
  };
}

async function apiDelete(path) {
  const tokens = getStoredTokens();
  const headers = {};
  if (tokens?.access_token) {
    headers['Authorization'] = `Bearer ${tokens.access_token}`;
  }

  const res = await fetch(path, { method: 'DELETE', headers });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function apiPatch(path, body) {
  const tokens = getStoredTokens();
  const headers = { 'Content-Type': 'application/json' };
  if (tokens?.access_token) {
    headers['Authorization'] = `Bearer ${tokens.access_token}`;
  }

  const res = await fetch(path, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function apiPut(path, body) {
  const tokens = getStoredTokens();
  const headers = { 'Content-Type': 'application/json' };
  if (tokens?.access_token) {
    headers['Authorization'] = `Bearer ${tokens.access_token}`;
  }

  const res = await fetch(path, {
    method: 'PUT',
    headers,
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ── Token Refresh ──────────────────────────────────────────────

function scheduleRefresh(expiresInSeconds) {
  if (_refreshTimer) clearTimeout(_refreshTimer);
  // Refresh 60 seconds before expiry
  const ms = Math.max((expiresInSeconds - 60) * 1000, 10000);
  _refreshTimer = setTimeout(refreshAccessToken, ms);
}

async function refreshAccessToken() {
  const tokens = getStoredTokens();
  if (!tokens?.refresh_token) {
    handleLogout();
    return;
  }

  try {
    const data = await apiPost('/api/auth/refresh', { refresh_token: tokens.refresh_token });
    storeTokens(data.tokens);
    storeUser(data.user);
  } catch {
    handleLogout();
  }
}

function handleLogout() {
  clearTokens();
  if (_onAuthChange) _onAuthChange(null);
}

// ── Public API ─────────────────────────────────────────────────

export function onAuthChange(callback) {
  _onAuthChange = callback;
}

export function isAuthenticated() {
  return !!getStoredTokens()?.access_token;
}

export function getCurrentUser() {
  return getStoredUser();
}

export function getAccessToken() {
  return getStoredTokens()?.access_token || null;
}

export async function registerUser(username, email, password, displayName) {
  const data = await apiPost('/api/auth/register', {
    username, email, password, display_name: displayName,
  });
  storeTokens(data.tokens);
  storeUser(data.user);
  if (_onAuthChange) _onAuthChange(data.user);
  return data.user;
}

export async function loginUser(username, password) {
  const data = await apiPost('/api/auth/login', { username, password });
  storeTokens(data.tokens);
  storeUser(data.user);
  if (_onAuthChange) _onAuthChange(data.user);
  return data.user;
}

export async function logoutUser() {
  const tokens = getStoredTokens();
  try {
    if (tokens?.refresh_token) {
      await apiPost('/api/auth/logout', { refresh_token: tokens.refresh_token });
    }
  } catch { /* ignore */ }
  handleLogout();
}

export async function updateProfile(fields) {
  const data = await apiPatch('/api/auth/profile', fields);
  storeUser(data.user);
  if (_onAuthChange) _onAuthChange(data.user);
  return data.user;
}

export async function changePassword(currentPassword, newPassword) {
  return apiPost('/api/auth/change-password', {
    current_password: currentPassword,
    new_password: newPassword,
  }, true);
}

// ── Conversation Sync ──────────────────────────────────────────

export async function syncConversations() {
  return apiGet('/api/conversations');
}

export async function syncSaveConversation(conv) {
  return apiPost('/api/conversations', conv, true);
}

export async function syncLoadConversation(id) {
  return apiGet(`/api/conversations/${id}`);
}

export async function syncDeleteConversation(id) {
  return apiDelete(`/api/conversations/${id}`);
}

// ── Share ──────────────────────────────────────────────────────

export async function createShareLink(conversationId, accessLevel = 'read', expiresInHours = null) {
  return apiPost('/api/share', {
    conversation_id: conversationId,
    access_level: accessLevel,
    expires_in_hours: expiresInHours,
  }, true);
}

export async function viewSharedChat(shareToken) {
  return apiGet(`/api/share/${shareToken}`);
}

export async function revokeShare(shareId) {
  return apiDelete(`/api/share/${shareId}`);
}

export async function getConversationShares(conversationId) {
  return apiGet(`/api/share/conversation/${conversationId}`);
}

// ── Rooms ──────────────────────────────────────────────────────

export async function listRooms() {
  return apiGet('/api/rooms');
}

export async function createRoom(name, description, category = 'team') {
  return apiPost('/api/rooms', { name, description, category }, true);
}

export async function joinRoom(inviteCode) {
  return apiPost('/api/rooms/join', { invite_code: inviteCode }, true);
}

export async function getRoom(roomId) {
  return apiGet(`/api/rooms/${roomId}`);
}

export async function getProjectAgentRoomDetails(roomId) {
  return apiGet(`/api/rooms/${roomId}/agent-room`);
}

export async function leaveRoomApi(roomId) {
  return apiPost(`/api/rooms/${roomId}/leave`, {}, true);
}

export async function deleteRoom(roomId) {
  return apiDelete(`/api/rooms/${roomId}`);
}

export async function getRoomMessages(roomId, limit = 50, before = null, ifNoneMatch = null) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (before) params.set('before', String(before));
  const path = `/api/rooms/${roomId}/messages?${params}`;

  // Support conditional requests with ETag
  if (ifNoneMatch) {
    const tokens = getStoredTokens();
    const headers = {};
    if (tokens?.access_token) headers['Authorization'] = `Bearer ${tokens.access_token}`;
    headers['If-None-Match'] = ifNoneMatch;

    const res = await fetch(path, { headers });
    if (res.status === 304) return null; // Not Modified
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    // Attach ETag to response for caller to cache
    const etag = res.headers.get('etag');
    if (etag) data._etag = etag;
    return data;
  }

  return apiGet(path);
}

export async function sendRoomMessage(roomId, content, messageType = 'text') {
  return apiPost(`/api/rooms/${roomId}/messages`, { content, message_type: messageType }, true);
}

// ── Agent Rooms ───────────────────────────────────────────────

export async function listAgentRooms() {
  return apiGet('/api/agent-rooms');
}

export async function createAgentRoom(name, description = '') {
  return apiPost('/api/agent-rooms', { name, description }, true);
}

export async function getAgentRoomDetails(roomId) {
  return apiGet(`/api/agent-rooms/${roomId}`);
}

export async function deleteAgentRoomApi(roomId) {
  return apiDelete(`/api/agent-rooms/${roomId}`);
}

export async function sendAgentRoomMessage(roomId, content) {
  return apiPost(`/api/agent-rooms/${roomId}/message`, { content }, true);
}

export async function submitReworkDecision(roomId, decision) {
  return apiPost(`/api/agent-rooms/${roomId}/rework-decision`, { decision }, true);
}

export async function getAgentRoomMessages(roomId, limit = 100) {
  return apiGet(`/api/agent-rooms/${roomId}/messages?limit=${encodeURIComponent(String(limit))}`);
}

export async function getAgentRoomLogs(roomId, limit = 100) {
  return apiGet(`/api/agent-rooms/${roomId}/logs?limit=${encodeURIComponent(String(limit))}`);
}

export async function getAgentRoomAgents(roomId) {
  return apiGet(`/api/agent-rooms/${roomId}/agents`);
}

export async function getAgentRoomTasks(roomId) {
  return apiGet(`/api/agent-rooms/${roomId}/tasks`);
}

export async function createAgentRoomTask(roomId, { title, details = '', priority = 'medium', assignee_name = '' }) {
  return apiPost(`/api/agent-rooms/${roomId}/tasks`, { title, details, priority, assignee_name }, true);
}

export async function updateAgentRoomTask(roomId, taskId, fields) {
  return apiPatch(`/api/agent-rooms/${roomId}/tasks/${encodeURIComponent(taskId)}`, fields);
}

export async function addAgentToRoom(roomId, { name, role, model_tier, system_prompt = '', tools = [], provider_config = {}, router_config = {} }) {
  return apiPost(`/api/agent-rooms/${roomId}/agents`, { name, role, model_tier, system_prompt, tools, provider_config, router_config }, true);
}

export async function getProviderPresets() {
  return apiGet('/api/agent-rooms/provider-presets');
}

export async function getAgentProviderModels(provider) {
  return apiGet(`/api/agent-rooms/provider-models?provider=${encodeURIComponent(provider)}`);
}

export async function updateAgentInRoom(roomId, agentName, fields) {
  return apiPatch(`/api/agent-rooms/${roomId}/agents/${encodeURIComponent(agentName)}`, fields);
}

export async function deleteAgentFromRoom(roomId, agentName) {
  return apiDelete(`/api/agent-rooms/${roomId}/agents/${encodeURIComponent(agentName)}`);
}

export async function getAgentRoomFiles(roomId, path = '.') {
  return apiGet(`/api/agent-rooms/${roomId}/files?path=${encodeURIComponent(path)}`);
}

export async function getAgentRoomFile(roomId, path) {
  return apiGet(`/api/agent-rooms/${roomId}/file?path=${encodeURIComponent(path)}`);
}

export async function getAgentRoomFileReview(roomId, path) {
  return apiGet(`/api/agent-rooms/${roomId}/file-review?path=${encodeURIComponent(path)}`);
}

export async function updateAgentRoomFileReview(roomId, path, status, summary = '') {
  return apiPost(`/api/agent-rooms/${roomId}/file-review`, { path, status, summary }, true);
}

// ── Agent Memories ──────────────────────────────────────────────
export async function getAgentRoomMemories(roomId) {
  return apiGet(`/api/agent-rooms/${roomId}/memories`);
}

export async function getAgentRoomMemory(roomId, agentName) {
  return apiGet(`/api/agent-rooms/${roomId}/memories/${encodeURIComponent(agentName)}`);
}

export async function updateAgentRoomMemory(roomId, agentName, memoryText) {
  return apiPut(`/api/agent-rooms/${roomId}/memories/${encodeURIComponent(agentName)}`, { memory_text: memoryText });
}

export async function clearAgentRoomMemory(roomId, agentName) {
  return apiDelete(`/api/agent-rooms/${roomId}/memories/${encodeURIComponent(agentName)}`);
}

// ── Token Usage ─────────────────────────────────────────────────
export async function getAgentRoomTokenUsage(roomId, limit = 50) {
  return apiGet(`/api/agent-rooms/${roomId}/token-usage?limit=${encodeURIComponent(String(limit))}`);
}

// ── Orchestration Config ────────────────────────────────────────
export async function updateAgentRoomConfig(roomId, config) {
  return apiPatch(`/api/agent-rooms/${roomId}/config`, config);
}

export async function writeAgentRoomFile(roomId, path, content) {
  return apiPost(`/api/agent-rooms/${roomId}/files/write`, { path, content }, true);
}

export async function updateAgentRoomFile(roomId, path, oldStr, newStr) {
  return apiPost(`/api/agent-rooms/${roomId}/files/update`, {
    path,
    old_str: oldStr,
    new_str: newStr,
  }, true);
}

export async function downloadAgentRoomWorkspace(roomId) {
  const { blob, disposition } = await apiGetBlob(`/api/agent-rooms/${roomId}/download`);
  const match = disposition.match(/filename="?([^";]+)"?/i);
  return {
    blob,
    fileName: match?.[1] || `agent-room-${roomId}.zip`,
  };
}

export async function runAgentRoomPython(roomId, path, args = []) {
  return apiPost(`/api/agent-rooms/${roomId}/python/run`, { path, args }, true);
}

export async function downloadAgentRoomFile(roomId, path) {
  const { blob, disposition } = await apiGetBlob(`/api/agent-rooms/${roomId}/file/download?path=${encodeURIComponent(path)}`);
  const match = disposition.match(/filename="?([^";]+)"?/i);
  return {
    blob,
    fileName: match?.[1] || String(path || 'workspace-file').split('/').pop() || 'workspace-file',
  };
}

// ── Workspace Snapshots ────────────────────────────────────────

export async function listAgentRoomSnapshots(roomId, limit = 50) {
  return apiGet(`/api/agent-rooms/${roomId}/snapshots?limit=${limit}`, true);
}

export async function createAgentRoomSnapshot(roomId, label, description = '') {
  return apiPost(`/api/agent-rooms/${roomId}/snapshots`, { label, description }, true);
}

export async function getAgentRoomSnapshot(roomId, snapshotId) {
  return apiGet(`/api/agent-rooms/${roomId}/snapshots/${snapshotId}`, true);
}

export async function deleteAgentRoomSnapshot(roomId, snapshotId) {
  return apiDelete(`/api/agent-rooms/${roomId}/snapshots/${snapshotId}`, true);
}

// ── Skills ─────────────────────────────────────────────────────

export async function listSkillsCatalog() {
  return apiGet('/api/skills', true);
}

export async function getSkillDetail(skillId) {
  return apiGet(`/api/skills/${skillId}`, true);
}

export async function listRoomSkills(roomId) {
  return apiGet(`/api/agent-rooms/${roomId}/skills`, true);
}

export async function addRoomSkill(roomId, skillId) {
  return apiPost(`/api/agent-rooms/${roomId}/skills`, { skillId }, true);
}

export async function removeRoomSkill(roomId, skillId) {
  return apiDelete(`/api/agent-rooms/${roomId}/skills/${skillId}`, true);
}

// ── Init ───────────────────────────────────────────────────────

export function initAuth() {
  const tokens = getStoredTokens();
  if (tokens?.access_token) {
    scheduleRefresh(tokens.expires_in || 900);
  }
  return getStoredUser();
}
