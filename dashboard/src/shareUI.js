/**
 * Share UI — Share chat modal, shared chat viewer.
 */

import { createShareLink, viewSharedChat, getConversationShares, revokeShare } from './authClient.js';
import { isAuthenticated } from './authClient.js';
import { showToast } from './utils.js';

let _shareModal = null;

export function createShareModal() {
  const modal = document.createElement('div');
  modal.id = 'share-modal';
  modal.className = 'modal-overlay';
  modal.style.display = 'none';
  modal.innerHTML = `
    <div class="modal modal-sm">
      <div class="modal-header-row">
        <h3>🔗 Share Chat</h3>
        <button class="modal-close-btn" id="share-modal-close">×</button>
      </div>
      <div class="share-options">
        <div class="form-group">
          <label>Access Level</label>
          <select id="share-access-level">
            <option value="read">Read Only</option>
            <option value="collaborate">Collaborative</option>
          </select>
        </div>
        <div class="form-group">
          <label>Expires In</label>
          <select id="share-expires">
            <option value="">Never</option>
            <option value="1">1 hour</option>
            <option value="24">24 hours</option>
            <option value="168">7 days</option>
            <option value="720">30 days</option>
          </select>
        </div>
        <button id="share-create-btn" class="btn-primary" style="width:100%">Generate Share Link</button>
      </div>
      <div id="share-result" class="share-result" hidden>
        <label>Share Link</label>
        <div class="share-link-row">
          <input type="text" id="share-link-input" readonly />
          <button id="share-copy-btn" class="btn-sm btn-secondary">📋 Copy</button>
        </div>
      </div>
      <div id="share-existing" class="share-existing">
        <h4>Active Shares</h4>
        <div id="share-list"></div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  _shareModal = modal;

  // Wire events
  modal.querySelector('#share-modal-close').addEventListener('click', hideShareModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) hideShareModal(); });

  modal.querySelector('#share-create-btn').addEventListener('click', async () => {
    const convId = _shareModal.dataset.conversationId;
    if (!convId) return;

    const accessLevel = modal.querySelector('#share-access-level').value;
    const expiresHours = modal.querySelector('#share-expires').value || null;

    try {
      const data = await createShareLink(convId, accessLevel, expiresHours ? parseInt(expiresHours, 10) : null);
      const shareUrl = `${window.location.origin}/shared/${data.share_token}`;

      const resultEl = modal.querySelector('#share-result');
      resultEl.hidden = false;
      modal.querySelector('#share-link-input').value = shareUrl;

      showToast('Share link created!', 'success');
      await loadExistingShares(convId);
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  modal.querySelector('#share-copy-btn').addEventListener('click', async () => {
    const input = modal.querySelector('#share-link-input');
    try {
      await navigator.clipboard.writeText(input.value);
      showToast('Link copied!', 'success');
    } catch {
      input.select();
      document.execCommand('copy');
      showToast('Link copied!', 'success');
    }
  });

  return modal;
}

export function showShareModal(conversationId) {
  if (!_shareModal) createShareModal();
  if (!isAuthenticated()) {
    showToast('Sign in to share chats', 'warning');
    return;
  }
  _shareModal.dataset.conversationId = conversationId;
  _shareModal.querySelector('#share-result').hidden = true;
  _shareModal.style.display = 'flex';
  loadExistingShares(conversationId);
}

export function hideShareModal() {
  if (_shareModal) _shareModal.style.display = 'none';
}

async function loadExistingShares(conversationId) {
  const listEl = _shareModal.querySelector('#share-list');
  try {
    const data = await getConversationShares(conversationId);
    const shares = data.shares || [];

    if (shares.length === 0) {
      listEl.innerHTML = '<div class="share-empty">No active shares</div>';
      return;
    }

    listEl.innerHTML = shares.map((s) => {
      const created = new Date(s.created_at * 1000).toLocaleDateString();
      const expires = s.expires_at ? new Date(s.expires_at * 1000).toLocaleDateString() : 'Never';
      return `
        <div class="share-item">
          <div class="share-item-info">
            <span class="share-item-token">${s.share_token}</span>
            <span class="share-item-meta">${s.access_level} · expires ${expires} · created ${created}</span>
          </div>
          <button class="btn-sm btn-danger share-revoke-btn" data-share-id="${s.id}">Revoke</button>
        </div>
      `;
    }).join('');

    listEl.querySelectorAll('.share-revoke-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await revokeShare(btn.dataset.shareId);
          showToast('Share revoked', 'success');
          await loadExistingShares(conversationId);
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });
  } catch {
    listEl.innerHTML = '<div class="share-empty">Failed to load shares</div>';
  }
}

// ── Shared Chat Viewer ─────────────────────────────────────────

export async function renderSharedChatView(shareToken) {
  try {
    const data = await viewSharedChat(shareToken);

    const viewer = document.createElement('div');
    viewer.className = 'shared-chat-viewer';
    viewer.innerHTML = `
      <div class="shared-chat-header">
        <h2>📄 ${escapeHtml(data.title || 'Shared Chat')}</h2>
        <p class="shared-chat-meta">Shared by <strong>${escapeHtml(data.shared_by)}</strong> · ${data.access_level} access</p>
        <a href="/" class="btn-secondary btn-sm">← Back to Tenrary-X</a>
      </div>
      <div class="shared-chat-messages">
        ${(data.messages || []).map((m) => `
          <div class="shared-msg shared-msg-${m.role || 'user'}">
            <div class="shared-msg-role">${m.role === 'assistant' ? '🤖 Assistant' : '👤 User'}</div>
            <div class="shared-msg-content">${escapeHtml(m.content || '')}</div>
          </div>
        `).join('')}
      </div>
    `;

    document.getElementById('app').innerHTML = '';
    document.getElementById('app').appendChild(viewer);
  } catch (err) {
    document.getElementById('app').innerHTML = `
      <div class="shared-chat-viewer">
        <div class="shared-chat-header">
          <h2>❌ Shared Chat Not Found</h2>
          <p>${escapeHtml(err.message)}</p>
          <a href="/" class="btn-secondary btn-sm">← Back to Tenrary-X</a>
        </div>
      </div>
    `;
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}
