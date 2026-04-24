/**
 * Chat Storage & Export Module
 * localStorage persistence with IndexedDB fallback, debounced auto-save,
 * multi-conversation management, and Markdown/JSON/text export.
 * Storage keys are scoped per user to prevent cross-user data leaks.
 */

let _userId = null;
const STORAGE_KEY_BASE = 'tenrary_conversations';
const ACTIVE_KEY_BASE = 'tenrary_active_conversation';
const MAX_CONVERSATIONS = 50;
const DEBOUNCE_MS = 500;
const IDB_NAME = 'tenrary_chat_db';
const IDB_STORE = 'conversations';
const IDB_VERSION = 1;

function storageKey() {
  return _userId ? `${STORAGE_KEY_BASE}_${_userId}` : STORAGE_KEY_BASE;
}
function activeKey() {
  return _userId ? `${ACTIVE_KEY_BASE}_${_userId}` : ACTIVE_KEY_BASE;
}

/**
 * Set the current user ID for scoped storage.
 * Call on login. Pass null on logout.
 */
export function setStorageUser(userId) {
  _userId = userId;
}

/**
 * Clear all conversation data for the current user scope.
 * Call on logout to prevent cross-user data leaks.
 */
export function clearUserData() {
  try { localStorage.removeItem(storageKey()); } catch { /* ignore */ }
  try { localStorage.removeItem(activeKey()); } catch { /* ignore */ }
  _idbFallback = false;
  _idbReady = null;
}

// ── Helpers ────────────────────────────────────────────────────

function generateId() {
  return `conv_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function now() {
  return Date.now();
}

// ── IndexedDB fallback ─────────────────────────────────────────

let _idbFallback = false;
let _idbReady = null;

function openIDB() {
  if (_idbReady) return _idbReady;
  _idbReady = new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _idbReady;
}

async function idbGetAll() {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const store = tx.objectStore(IDB_STORE);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(id) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const store = tx.objectStore(IDB_STORE);
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(conversation) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    const store = tx.objectStore(IDB_STORE);
    const req = store.put(conversation);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete(id) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    const store = tx.objectStore(IDB_STORE);
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ── Storage layer (localStorage → IndexedDB fallback) ──────────

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty']);

function readAllLocal() {
  try {
    const raw = localStorage.getItem(storageKey());
    if (!raw) return Object.create(null);
    const parsed = JSON.parse(raw);
    // H1 fix: filter prototype pollution keys and use null-prototype container
    const safe = Object.create(null);
    for (const key of Object.keys(parsed)) {
      if (!DANGEROUS_KEYS.has(key)) {
        safe[key] = parsed[key];
      }
    }
    return safe;
  } catch {
    return Object.create(null);
  }
}

function writeAllLocal(conversations) {
  try {
    const json = JSON.stringify(conversations);
    localStorage.setItem(storageKey(), json);
    _idbFallback = false;
    return true;
  } catch (e) {
    // QuotaExceededError or similar — switch to IndexedDB
    if (e instanceof DOMException) {
      _idbFallback = true;
    }
    return false;
  }
}

async function readAll() {
  if (_idbFallback) {
    const list = await idbGetAll();
    const map = Object.create(null);
    for (const c of list) map[c.id] = c;
    return map;
  }
  return readAllLocal();
}

async function writeOne(conversation) {
  if (_idbFallback) {
    await idbPut(conversation);
    return;
  }
  const all = readAllLocal();
  all[conversation.id] = conversation;
  const ok = writeAllLocal(all);
  if (!ok) {
    // Fell back to IDB mid-write — migrate and retry
    await migrateToIDB(all);
    await idbPut(conversation);
  }
}

async function removeOne(id) {
  if (_idbFallback) {
    await idbDelete(id);
    return;
  }
  const all = readAllLocal();
  delete all[id];
  writeAllLocal(all);
}

async function migrateToIDB(conversations) {
  _idbFallback = true;
  const entries = Object.values(conversations);
  for (const c of entries) {
    await idbPut(c);
  }
  try {
    localStorage.removeItem(storageKey());
  } catch { /* ignore */ }
}

// ── Pruning ────────────────────────────────────────────────────

async function pruneIfNeeded() {
  const all = await readAll();
  const ids = Object.keys(all);
  if (ids.length <= MAX_CONVERSATIONS) return;

  const sorted = ids
    .map((id) => ({ id, updatedAt: all[id].updatedAt ?? 0 }))
    .sort((a, b) => a.updatedAt - b.updatedAt);

  const toRemove = sorted.slice(0, ids.length - MAX_CONVERSATIONS);
  for (const { id } of toRemove) {
    await removeOne(id);
  }
}

// ── Public API ─────────────────────────────────────────────────

export function createConversation(title = 'New Chat') {
  const ts = now();
  return {
    id: generateId(),
    title,
    messages: [],
    createdAt: ts,
    updatedAt: ts,
    mode: 'enowxai',
    folder: '',
    settings: {},
  };
}

export async function saveConversation(conversation) {
  const updated = { ...conversation, updatedAt: now() };
  await writeOne(updated);
  await pruneIfNeeded();
  return updated;
}

export async function loadConversation(id) {
  if (_idbFallback) {
    return idbGet(id);
  }
  const all = readAllLocal();
  return all[id] ?? null;
}

export async function listConversations() {
  const all = await readAll();
  return Object.values(all)
    .map((c) => ({
      id: c.id,
      title: typeof c.title === 'string' ? c.title : String(c.title || 'Untitled'),
      updatedAt: c.updatedAt || 0,
      messageCount: c.messages ? c.messages.length : 0,
      folder: c.folder || '',
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteConversation(id) {
  await removeOne(id);
  const activeId = getActiveConversationId();
  if (activeId === id) {
    try { localStorage.removeItem(activeKey()); } catch { /* ignore */ }
  }
}

// ── Active conversation tracking ───────────────────────────────

export function getActiveConversationId() {
  try {
    return localStorage.getItem(activeKey()) ?? null;
  } catch {
    return null;
  }
}

export function setActiveConversationId(id) {
  try {
    if (id == null) {
      localStorage.removeItem(activeKey());
    } else {
      localStorage.setItem(activeKey(), id);
    }
  } catch { /* ignore */ }
}

// ── Debounced auto-save ────────────────────────────────────────

let _autoSaveTimer = null;

export function autoSave(conversation) {
  clearTimeout(_autoSaveTimer);
  _autoSaveTimer = setTimeout(() => {
    // H4 fix: catch and log unresolved promise errors
    saveConversation(conversation).catch((err) => console.error('Auto-save failed:', err));
  }, DEBOUNCE_MS);
}

// ── Export formats ─────────────────────────────────────────────

export function exportAsMarkdown(conversation) {
  const lines = [`# ${conversation.title}`, ''];
  const created = new Date(conversation.createdAt).toLocaleString();
  lines.push(`*Created: ${created}*`, '');
  if (conversation.mode) {
    lines.push(`**Mode:** ${conversation.mode}`, '');
  }
  lines.push('---', '');

  for (const msg of conversation.messages) {
    const role = msg.role === 'user' ? '🧑 **User**' : '🤖 **Assistant**';
    const time = msg.timestamp
      ? ` *(${new Date(msg.timestamp).toLocaleTimeString()})*`
      : '';
    lines.push(`### ${role}${time}`, '');
    lines.push(msg.content, '');

    if (msg.stats) {
      const parts = [];
      if (msg.stats.tokens) parts.push(`${msg.stats.tokens} tokens`);
      if (msg.stats.tokensPerSecond) parts.push(`${msg.stats.tokensPerSecond.toFixed(1)} tok/s`);
      if (msg.stats.duration) parts.push(`${(msg.stats.duration / 1000).toFixed(2)}s`);
      if (parts.length) {
        lines.push(`> ${parts.join(' · ')}`, '');
      }
    }
  }

  return lines.join('\n');
}

export function exportAsJSON(conversation) {
  return JSON.stringify(conversation, null, 2);
}

export function exportAsText(conversation) {
  const lines = [conversation.title, '='.repeat(conversation.title.length), ''];

  for (const msg of conversation.messages) {
    const label = msg.role === 'user' ? 'User' : 'Assistant';
    const time = msg.timestamp
      ? ` [${new Date(msg.timestamp).toLocaleTimeString()}]`
      : '';
    lines.push(`${label}${time}:`);
    lines.push(msg.content);
    lines.push('');
  }

  return lines.join('\n');
}

// ── Import ─────────────────────────────────────────────────────

export function importFromJSON(jsonString) {
  let data;
  try {
    data = JSON.parse(jsonString);
  } catch {
    throw new Error('Invalid JSON');
  }

  if (!data || typeof data !== 'object') {
    throw new Error('Invalid conversation format');
  }

  const ts = now();
  // C3 fix: always generate a new ID; preserve imported ID as originalId
  return {
    id: generateId(),
    originalId: data.id && typeof data.id === 'string' ? data.id : undefined,
    title: typeof data.title === 'string' ? data.title : 'Imported Chat',
    messages: Array.isArray(data.messages)
      ? data.messages.map((m) => ({
          role: typeof m.role === 'string' ? m.role : 'user',
          content: typeof m.content === 'string' ? m.content : String(m.content ?? ''),
          timestamp: typeof m.timestamp === 'number' ? m.timestamp : ts,
          stats: m.stats && typeof m.stats === 'object' ? m.stats : undefined,
        }))
      : [],
    createdAt: typeof data.createdAt === 'number' ? data.createdAt : ts,
    updatedAt: ts,
    mode: typeof data.mode === 'string' ? data.mode : 'enowxai',
    settings: data.settings && typeof data.settings === 'object' ? { ...data.settings } : {},
  };
}

// ── Share / Import ─────────────────────────────────────────────

export function generateShareData(conversation) {
  const shareData = {
    version: 1,
    title: conversation.title,
    messages: conversation.messages.map(m => ({
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
    })),
    exportedAt: Date.now(),
    model: 'cloud',
  };
  return btoa(unescape(encodeURIComponent(JSON.stringify(shareData))));
}

export function importShareData(encoded) {
  try {
    const json = decodeURIComponent(escape(atob(encoded)));
    const data = JSON.parse(json);
    if (!data.version || !Array.isArray(data.messages)) throw new Error('Invalid format');
    return data;
  } catch {
    return null;
  }
}
