// keyboardShortcuts.js — Keyboard shortcut manager for chatbot dashboard

const shortcuts = new Map();
let currentContext = 'default';
let listenerAttached = false;

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta']);

const BROWSER_DEFAULTS_TO_PREVENT = new Set([
  'ctrl+n', 'ctrl+shift+delete', 'ctrl+e', 'ctrl+k', 'ctrl+r',
]);

/**
 * Normalize a combo string to a canonical lowercase form.
 * e.g. "Ctrl+Shift+N" → "ctrl+shift+n"
 */
function normalizeCombo(combo) {
  return combo
    .split('+')
    .map(part => {
      const p = part.trim().toLowerCase();
      if (p === 'cmd' || p === 'meta') return 'meta';
      if (p === 'ctrl' || p === 'control') return 'ctrl';
      return p;
    })
    .sort((a, b) => {
      const order = { ctrl: 0, alt: 1, shift: 2, meta: 3 };
      const oa = order[a] ?? 4;
      const ob = order[b] ?? 4;
      return oa - ob;
    })
    .join('+');
}

/**
 * Build the combo string from a KeyboardEvent.
 */
function comboFromEvent(e) {
  const parts = [];
  if (e.ctrlKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  if (e.metaKey) parts.push('meta');

  if (e.key && !MODIFIER_KEYS.has(e.key)) {
    let key = e.key.toLowerCase();
    // Normalize special keys
    if (key === ' ') key = 'space';
    if (key === 'arrowup') key = 'up';
    if (key === 'arrowdown') key = 'down';
    if (key === 'arrowleft') key = 'left';
    if (key === 'arrowright') key = 'right';
    parts.push(key);
  }

  return parts.join('+');
}

/**
 * Check if the active element is a text input or contenteditable.
 */
export function isInputFocused() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
  if (el.isContentEditable) return true;
  return false;
}

/**
 * Global keydown handler.
 */
function handleKeyDown(e) {
  // Ignore events with no key (dead keys, IME) or standalone modifier presses
  if (!e.key || MODIFIER_KEYS.has(e.key)) return;

  const combo = comboFromEvent(e);
  const entry = shortcuts.get(combo);
  if (!entry) return;

  // Context check: if the shortcut specifies a context, it must match current
  if (entry.context && entry.context !== currentContext) return;

  // Prevent browser default for known conflicts
  if (BROWSER_DEFAULTS_TO_PREVENT.has(combo)) {
    e.preventDefault();
    e.stopPropagation();
  }

  // Let the handler decide if it should run; pass event for flexibility
  const result = entry.handler(e);

  // If handler explicitly returns false, don't prevent default (already handled above for conflicts)
  if (result !== false && !BROWSER_DEFAULTS_TO_PREVENT.has(combo)) {
    e.preventDefault();
  }
}

/**
 * Register a keyboard shortcut.
 *
 * @param {string} combo - Key combination, e.g. "Ctrl+Enter", "Escape", "?"
 * @param {(e: KeyboardEvent) => any} handler - Callback. Return false to allow default.
 * @param {Object} [opts]
 * @param {string} [opts.description] - Human-readable description for help modal.
 * @param {string} [opts.context] - Only active when currentContext matches. null = always active.
 */
export function registerShortcut(combo, handler, { description = '', context = null } = {}) {
  const key = normalizeCombo(combo);
  shortcuts.set(key, { combo, handler, description, context });
}

/**
 * Remove a registered shortcut.
 *
 * @param {string} combo - The combo string used during registration.
 */
export function unregisterShortcut(combo) {
  shortcuts.delete(normalizeCombo(combo));
}

/**
 * Set the active context for context-aware shortcuts.
 *
 * @param {string} context - e.g. "default", "modal-open", "streaming", "composing"
 */
export function setContext(context) {
  currentContext = context;
}

/**
 * Returns the list of registered shortcuts for rendering a help modal.
 *
 * @returns {Array<{combo: string, description: string}>}
 */
export function getShortcutsList() {
  const list = [];
  for (const [, entry] of shortcuts) {
    list.push({ combo: entry.combo, description: entry.description });
  }
  return list.sort((a, b) => a.combo.localeCompare(b.combo));
}

/**
 * Attach the global keydown listener and register default shortcuts.
 */
export function initShortcuts() {
  if (listenerAttached) return;

  registerDefaults();
  document.addEventListener('keydown', handleKeyDown, { capture: true });
  listenerAttached = true;
}

/**
 * Remove the global listener and clear all shortcuts.
 */
export function destroyShortcuts() {
  document.removeEventListener('keydown', handleKeyDown, { capture: true });
  shortcuts.clear();
  currentContext = 'default';
  listenerAttached = false;
}

// ─── Default Shortcuts ─────────────────────────────────────────────────────────

function registerDefaults() {
  // Enter → Send message (only when input focused, not composing)
  registerShortcut('Enter', (e) => {
    if (!isInputFocused()) return false;
    if (currentContext === 'composing') return false;
    document.dispatchEvent(new CustomEvent('chat:send'));
  }, { description: 'Send message' });

  // Shift+Enter → New line (let browser handle it)
  registerShortcut('Shift+Enter', () => {
    return false; // allow default newline behaviour
  }, { description: 'New line in input' });

  // Ctrl+C during streaming → Abort generation
  registerShortcut('Ctrl+C', (e) => {
    if (currentContext !== 'streaming') return false;
    document.dispatchEvent(new CustomEvent('chat:abort'));
  }, { description: 'Abort generation', context: 'streaming' });

  // Escape → Close modal or cancel generation
  registerShortcut('Escape', () => {
    document.dispatchEvent(new CustomEvent('chat:escape'));
  }, { description: 'Close modal / Cancel generation' });

  // / → Focus input (when not already in an input)
  registerShortcut('/', (e) => {
    if (isInputFocused()) return false;
    document.dispatchEvent(new CustomEvent('chat:focus-input'));
  }, { description: 'Focus input' });

  // Ctrl+N → New conversation
  registerShortcut('Ctrl+N', () => {
    document.dispatchEvent(new CustomEvent('chat:new-conversation'));
  }, { description: 'New conversation' });

  // Ctrl+Shift+Delete → Clear current conversation
  registerShortcut('Ctrl+Shift+Delete', () => {
    document.dispatchEvent(new CustomEvent('chat:clear-conversation'));
  }, { description: 'Clear current conversation' });

  // Ctrl+E → Export current chat
  registerShortcut('Ctrl+E', () => {
    document.dispatchEvent(new CustomEvent('chat:export'));
  }, { description: 'Export current chat' });

  // Ctrl+K → Focus search/filter
  registerShortcut('Ctrl+K', () => {
    document.dispatchEvent(new CustomEvent('chat:focus-search'));
  }, { description: 'Focus search / filter conversations' });

  // Up arrow → Edit last sent message (input must be focused and empty)
  registerShortcut('Up', (e) => {
    if (!isInputFocused()) return false;
    const el = document.activeElement;
    const value = el.value ?? el.textContent ?? '';
    if (value.trim().length > 0) return false;
    document.dispatchEvent(new CustomEvent('chat:edit-last'));
  }, { description: 'Edit last sent message (input empty)' });

  // Ctrl+R → Regenerate last response
  registerShortcut('Ctrl+R', () => {
    document.dispatchEvent(new CustomEvent('chat:regenerate'));
  }, { description: 'Regenerate last response' });

  // ? → Show keyboard shortcuts help (when not typing)
  registerShortcut('?', (e) => {
    // shift+/ produces '?' — ignore if user is typing
    if (isInputFocused()) return false;
    document.dispatchEvent(new CustomEvent('chat:show-shortcuts'));
  }, { description: 'Show keyboard shortcuts help' });
}
