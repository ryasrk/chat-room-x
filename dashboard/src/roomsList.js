/**
 * roomsList.js — Room list rendering, create/join modals, and dropdown menus.
 *
 * Reads/writes the shared `rs` state from roomsUtils.js.
 */

import {
  listRooms, createRoom, joinRoom, getRoom, leaveRoomApi, deleteRoom,
} from './authClient.js';
import { isAuthenticated } from './authClient.js';
import { showToast } from './utils.js';
import { showConfirm } from './confirmModal.js';
import { rs, escapeHtml } from './roomsUtils.js';

// ── Room list rendering ────────────────────────────────────────

function applyActiveRoomCard() {
  if (!rs.panel) return;
  rs.panel.querySelectorAll('.room-card').forEach((card) => {
    card.classList.toggle('is-active', card.dataset.roomId === rs.selectedListRoomId);
  });
}

/**
 * Refresh the rooms list from the API and render room cards.
 * @param {object} handlers — { onOpenTeamRoom, onOpenAgentRoom }
 */
export async function refreshRoomsList(handlers = {}) {
  if (!isAuthenticated() || !rs.panel) return;
  const listEl = rs.panel.querySelector('#rooms-list');

  try {
    const data = await listRooms();
    const rooms = data.rooms || [];

    if (rooms.length === 0) {
      listEl.innerHTML = '<div class="rooms-empty">No rooms yet. Create one or join with an invite code.</div>';
      return;
    }

    listEl.innerHTML = rooms.map((r) => {
      const catLabel = r.category === 'ai-agents' ? 'AI Agent' : 'Team';
      const catIcon = r.category === 'ai-agents'
        ? '<svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="2" width="10" height="12" rx="2"/><circle cx="6.5" cy="6.5" r="1"/><circle cx="9.5" cy="6.5" r="1"/><path d="M6 10h4"/></svg>'
        : '<svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="5" r="2.5"/><path d="M1 14a5 5 0 0 1 10 0"/><circle cx="11.5" cy="5.5" r="2"/><path d="M15 14a3.5 3.5 0 0 0-5-3.2"/></svg>';
      const activeClass = r.id === rs.selectedListRoomId ? ' is-active' : '';
      const actionHint = r.category === 'ai-agents' ? 'mention-based workspace' : 'team chat';
      const isOwner = r.role === 'owner';
      return `
      <div class="room-card${activeClass}" data-room-id="${r.id}" data-room-category="${r.category}">
        <div class="room-card-icon">${catIcon}</div>
        <div class="room-card-info">
          <div class="room-card-name">${escapeHtml(r.name)}</div>
          <div class="room-card-meta"><span class="room-card-category">${catLabel}</span> · ${r.member_count || 0} members · ${r.role}</div>
          <div class="room-card-hint">${actionHint}</div>
        </div>
        <div class="room-card-actions">
          <button class="room-card-menu-btn" data-room-menu="${r.id}" title="Room settings" aria-label="Room settings">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="3" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="8" cy="13" r="1.5"/></svg>
          </button>
          <div class="room-card-dropdown" data-room-dropdown="${r.id}" hidden>
            <button class="room-card-dropdown-item" data-action="leave" data-room-id="${r.id}">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2H13V14H10"/><path d="M6 8H1"/><path d="M3.5 5.5L1 8L3.5 10.5"/></svg>
              Leave Room
            </button>
            ${isOwner ? `<button class="room-card-dropdown-item room-card-dropdown-danger" data-action="delete" data-room-id="${r.id}">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h12"/><path d="M5 4V2.5A1.5 1.5 0 0 1 6.5 1h3A1.5 1.5 0 0 1 11 2.5V4"/><path d="M3.5 4l.7 9.1a1.5 1.5 0 0 0 1.5 1.4h4.6a1.5 1.5 0 0 0 1.5-1.4L12.5 4"/></svg>
              Delete Room
            </button>` : ''}
          </div>
        </div>
      </div>`;
    }).join('');

    // Card click → open room
    listEl.querySelectorAll('.room-card').forEach((card) => {
      card.addEventListener('click', async (e) => {
        if (e.target.closest('.room-card-menu-btn') || e.target.closest('.room-card-dropdown')) return;
        rs.selectedListRoomId = card.dataset.roomId;
        applyActiveRoomCard();
        if (card.dataset.roomCategory === 'ai-agents') {
          handlers.onOpenAgentRoom?.(card.dataset.roomId);
          return;
        }
        handlers.onOpenTeamRoom?.(card.dataset.roomId);
      });
    });

    // 3-dot menu toggle
    listEl.querySelectorAll('.room-card-menu-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const roomId = btn.dataset.roomMenu;
        const dropdown = listEl.querySelector(`[data-room-dropdown="${roomId}"]`);
        listEl.querySelectorAll('.room-card-dropdown').forEach((d) => {
          if (d !== dropdown) d.hidden = true;
        });
        if (dropdown) dropdown.hidden = !dropdown.hidden;
      });
    });

    // Dropdown action handlers
    listEl.querySelectorAll('.room-card-dropdown-item').forEach((item) => {
      item.addEventListener('click', async (e) => {
        e.stopPropagation();
        const action = item.dataset.action;
        const roomId = item.dataset.roomId;
        const dropdown = item.closest('.room-card-dropdown');
        if (dropdown) dropdown.hidden = true;

        if (action === 'leave') {
          const confirmed = await showConfirm({
            title: 'Leave Room',
            message: 'Are you sure you want to leave this room? You will need an invite to rejoin.',
            confirmText: 'Leave',
            variant: 'danger',
          });
          if (!confirmed) return;
          try {
            await leaveRoomApi(roomId);
            showToast('Left room successfully', 'success');
            if (rs.currentRoomId === roomId) handlers.onCloseRoom?.();
            await refreshRoomsList(handlers);
          } catch (err) {
            showToast(err.message || 'Failed to leave room', 'error');
          }
        }

        if (action === 'delete') {
          const confirmed = await showConfirm({
            title: 'Delete Room',
            message: 'Are you sure you want to permanently delete this room? All messages and data will be lost. This cannot be undone.',
            confirmText: 'Delete',
            variant: 'danger',
          });
          if (!confirmed) return;
          try {
            await deleteRoom(roomId);
            showToast('Room deleted', 'success');
            if (rs.currentRoomId === roomId) handlers.onCloseRoom?.();
            await refreshRoomsList(handlers);
          } catch (err) {
            showToast(err.message || 'Failed to delete room', 'error');
          }
        }
      });
    });

    // Close dropdowns when clicking outside
    function closeAllDropdowns(e) {
      if (!e.target.closest('.room-card-menu-btn') && !e.target.closest('.room-card-dropdown')) {
        listEl.querySelectorAll('.room-card-dropdown').forEach((d) => { d.hidden = true; });
      }
    }
    document.removeEventListener('click', listEl._closeDropdowns);
    listEl._closeDropdowns = closeAllDropdowns;
    document.addEventListener('click', closeAllDropdowns);
  } catch (err) {
    listEl.innerHTML = `<div class="rooms-empty">Failed to load rooms: ${escapeHtml(err.message)}</div>`;
  }
}

// ── Create / Join modal wiring ─────────────────────────────────

export function initRoomListModals(handlers = {}) {
  if (!rs.panel) return;

  const createBtn = rs.panel.querySelector('#create-room-btn');
  const joinBtn = rs.panel.querySelector('#join-room-btn');
  const createModal = rs.panel.querySelector('#create-room-modal');
  const joinModal = rs.panel.querySelector('#join-room-modal');
  const createForm = rs.panel.querySelector('#create-room-form');
  const joinForm = rs.panel.querySelector('#join-room-form');

  // Create room
  createBtn.addEventListener('click', () => { createModal.style.display = 'flex'; });
  rs.panel.querySelector('#create-room-cancel').addEventListener('click', () => { createModal.style.display = 'none'; });
  createModal.addEventListener('click', (e) => { if (e.target === createModal) createModal.style.display = 'none'; });

  createForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = rs.panel.querySelector('#room-name-input').value.trim();
    const category = rs.panel.querySelector('#room-category-input').value;
    const desc = rs.panel.querySelector('#room-desc-input').value.trim();
    try {
      await createRoom(name, desc, category);
      createModal.style.display = 'none';
      createForm.reset();
      showToast(`Room "${name}" created!`, 'success');
      await refreshRoomsList(handlers);
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Join room
  joinBtn.addEventListener('click', () => { joinModal.style.display = 'flex'; });
  rs.panel.querySelector('#join-room-cancel').addEventListener('click', () => { joinModal.style.display = 'none'; });
  joinModal.addEventListener('click', (e) => { if (e.target === joinModal) joinModal.style.display = 'none'; });

  joinForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = rs.panel.querySelector('#invite-code-input').value.trim();
    try {
      const data = await joinRoom(code);
      joinModal.style.display = 'none';
      joinForm.reset();
      if (data.already_member) {
        showToast('You are already a member of this room', 'warning');
      } else {
        showToast(`Joined room "${data.room?.name}"!`, 'success');
      }
      await refreshRoomsList(handlers);
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

export { applyActiveRoomCard };
