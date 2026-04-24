/**
 * roomsUtils.js — Shared constants, state, and utility functions for the Rooms UI modules.
 *
 * All room modules (roomsUI, agentSidebar, agentConfigModal) import the `rs` state
 * object and read/write its properties directly. This avoids prop-drilling while
 * keeping a single source of truth.
 */

// ── Constants ──────────────────────────────────────────────────
export const ROOM_POLL_INTERVAL_MS = 3000;
export const WS_RECONNECT_DELAY_MS = 1500;
export const MAX_LOGS = 200;
export const MAX_PROGRESS_ENTRIES = 50;
export const SCROLL_BOTTOM_THRESHOLD = 60;
export const MENTION_MENU_MAX = 6;
export const MENTION_BLUR_DELAY_MS = 150;

// ── Shared mutable state (`rs` = room state) ──────────────────
// Every room module imports `rs` and reads/writes properties directly.
export const rs = {
  currentRoomId: null,
  currentRoomMode: 'team',       // 'team' | 'agent'
  currentAgentRoomId: null,
  roomPollTimer: null,
  panel: null,                   // the root DOM element (#view-rooms)
  selectedListRoomId: null,
  agentSocket: null,
  currentAgentMembers: [],
  mentionSelectedIdx: -1,

  // Agent room workspace
  agentRoomLogs: [],
  agentRoomTasks: [],
  agentRoomFiles: [],
  agentRoomSelectedFile: null,
  agentRoomFileContent: '',
  agentRoomFileReview: null,
  agentRoomPreviewMode: 'code',
  agentRoomExecutionResult: null,
  agentRoomProgressTimeline: [],
  agentRoomFileAuthors: new Map(),
  agentRoomConnectionState: 'idle',
  agentRoomReconnectTimer: null,
  agentRoomOrchestrationMode: 'reactive',
  agentRoomAutonomyLevel: 2,
  sidebarCollapsed: false,
  seenMessageIds: new Set(),
};

// ── Cached DOM element for escapeHtml ──────────────────────────
const _escapeDiv = document.createElement('div');

export function escapeHtml(str) {
  _escapeDiv.textContent = str || '';
  return _escapeDiv.innerHTML;
}

export function sanitizeClassToken(value, fallback = 'idle') {
  return /^[a-z0-9_-]+$/i.test(value || '') ? value : fallback;
}

// ── File type utilities ──────────────────────────────────────────
export const FILE_ICONS = {
  js: '📜', mjs: '📜', cjs: '📜',
  ts: '🔷', tsx: '🔷', jsx: '⚛️',
  py: '🐍', rb: '💎', go: '🔵',
  rs: '🦀', java: '☕', kt: '🟣',
  html: '🌐', css: '🎨', scss: '🎨',
  json: '📋', yaml: '📋', yml: '📋', toml: '📋',
  md: '📝', txt: '📄', csv: '📊',
  sh: '🖥️', bash: '🖥️', zsh: '🖥️',
  sql: '🗃️', graphql: '🔗',
  dockerfile: '🐳', docker: '🐳',
  svg: '🖼️', png: '🖼️', jpg: '🖼️',
  lock: '🔒', env: '🔐',
  test: '🧪', spec: '🧪',
  directory: '📁',
};

export function getFileIcon(path, type = 'file') {
  if (type === 'directory') return FILE_ICONS.directory;
  const name = path.split('/').pop().toLowerCase();
  if (name === 'dockerfile') return FILE_ICONS.dockerfile;
  if (name.includes('.test.') || name.includes('.spec.')) return FILE_ICONS.test;
  const ext = name.split('.').pop();
  return FILE_ICONS[ext] || '📄';
}

export function getFileLanguage(path) {
  const ext = path.split('.').pop().toLowerCase();
  const langMap = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', tsx: 'typescript', jsx: 'javascript',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
    java: 'java', kt: 'kotlin', swift: 'swift',
    html: 'html', css: 'css', scss: 'scss',
    json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
    md: 'markdown', sql: 'sql', sh: 'bash',
    dockerfile: 'dockerfile',
  };
  return langMap[ext] || 'text';
}

export function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

export function renderCodeWithLineNumbers(content) {
  const lines = content.split('\n');
  const gutterWidth = String(lines.length).length;
  return lines.map((line, i) => {
    const num = String(i + 1).padStart(gutterWidth, ' ');
    return `<span class="code-line"><span class="line-number">${num}</span><span class="line-content">${escapeHtml(line)}</span></span>`;
  }).join('\n');
}
