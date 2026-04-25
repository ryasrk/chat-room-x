/**
 * sessionRecovery.js — Persist drafts, active conversation, and pending stream metadata.
 * Restores state after hard refresh with a recovery banner.
 */

import { state } from './appState.js';

const DRAFT_KEY = 'tenrary_draft';
const SESSION_KEY = 'tenrary_session_state';
const RECOVERY_BANNER_ID = 'session-recovery-banner';

// ── Draft Persistence ──────────────────────────────────────────

let _draftTimer = null;

export function persistDraft(text) {
  if (_draftTimer) clearTimeout(_draftTimer);
  _draftTimer = setTimeout(() => {
    try {
      if (text && text.trim()) {
        localStorage.setItem(DRAFT_KEY, JSON.stringify({
          text: text.trim(),
          conversationId: state.conversationId || null,
          timestamp: Date.now(),
        }));
      } else {
        localStorage.removeItem(DRAFT_KEY);
      }
    } catch { /* ignore */ }
  }, 500);
}

export function loadDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    // Expire drafts older than 24h
    if (Date.now() - (data.timestamp || 0) > 86400_000) {
      localStorage.removeItem(DRAFT_KEY);
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

export function clearDraft() {
  if (_draftTimer) clearTimeout(_draftTimer);
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
}

// ── Session State Persistence ──────────────────────────────────

export function persistSessionState() {
  try {
    const sessionData = {
      conversationId: state.conversationId || null,
      mode: state.mode || 'enowxai',
      messageCount: state.messages?.length || 0,
      wasStreaming: state.isStreaming || false,
      settings: {
        temperature: state.settings?.temperature,
        maxTokens: state.settings?.maxTokens,
        model: state.settings?.model,
        enableThinking: state.settings?.enableThinking,
      },
      timestamp: Date.now(),
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(sessionData));
  } catch { /* ignore */ }
}

export function loadSessionState() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    // Expire sessions older than 4h
    if (Date.now() - (data.timestamp || 0) > 14400_000) {
      localStorage.removeItem(SESSION_KEY);
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

export function clearSessionState() {
  try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
}

// ── Recovery Banner ────────────────────────────────────────────

export function showRecoveryBanner(sessionData, onRestore, onDismiss) {
  removeRecoveryBanner();

  const banner = document.createElement('div');
  banner.id = RECOVERY_BANNER_ID;
  banner.className = 'recovery-banner';
  banner.setAttribute('role', 'alert');

  const wasStreaming = sessionData.wasStreaming;
  const msgCount = sessionData.messageCount || 0;

  banner.innerHTML = `
    <div class="recovery-banner-content">
      <span class="recovery-banner-icon">🔄</span>
      <span class="recovery-banner-text">
        ${wasStreaming ? 'A response was interrupted.' : `Previous session found (${msgCount} messages).`}
        ${sessionData.conversationId ? ' Restore it?' : ''}
      </span>
      <div class="recovery-banner-actions">
        ${sessionData.conversationId ? '<button type="button" class="recovery-restore-btn">Restore</button>' : ''}
        <button type="button" class="recovery-dismiss-btn">Dismiss</button>
      </div>
    </div>
  `;

  const chatContainer = document.querySelector('#chat-container') || document.querySelector('.chat-main');
  if (chatContainer) {
    chatContainer.prepend(banner);
  }

  banner.querySelector('.recovery-restore-btn')?.addEventListener('click', () => {
    removeRecoveryBanner();
    onRestore?.(sessionData);
  });

  banner.querySelector('.recovery-dismiss-btn')?.addEventListener('click', () => {
    removeRecoveryBanner();
    clearSessionState();
    onDismiss?.();
  });

  // Auto-dismiss after 30s
  setTimeout(() => removeRecoveryBanner(), 30_000);
}

export function removeRecoveryBanner() {
  document.getElementById(RECOVERY_BANNER_ID)?.remove();
}

// ── Agent Room State Persistence ───────────────────────────────
// Allows the user to return to an active agent room after closing the browser.

const AGENT_ROOM_KEY = 'tenrary_agent_room_state';

/**
 * Save the currently open agent room so it can be restored on next visit.
 * @param {string} projectRoomId - The project room ID
 * @param {string} roomName - Display name
 */
export function persistAgentRoomState(projectRoomId, roomName) {
  try {
    localStorage.setItem(AGENT_ROOM_KEY, JSON.stringify({
      projectRoomId,
      roomName,
      timestamp: Date.now(),
    }));
  } catch { /* ignore */ }
}

/**
 * Load the previously open agent room state.
 * Returns null if expired (>24h) or not found.
 */
export function loadAgentRoomState() {
  try {
    const raw = localStorage.getItem(AGENT_ROOM_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    // Expire after 24 hours
    if (Date.now() - (data.timestamp || 0) > 86400_000) {
      localStorage.removeItem(AGENT_ROOM_KEY);
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

/**
 * Clear the persisted agent room state (e.g. when user leaves the room).
 */
export function clearAgentRoomState() {
  try { localStorage.removeItem(AGENT_ROOM_KEY); } catch { /* ignore */ }
}
