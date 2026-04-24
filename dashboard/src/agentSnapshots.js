/**
 * agentSnapshots.js — Workspace versioning/snapshots UI for agent rooms.
 * Renders a compact snapshot list inside the workspace sidebar.
 */

import { listAgentRoomSnapshots, createAgentRoomSnapshot, deleteAgentRoomSnapshot, getAgentRoomSnapshot } from './authClient.js';
import { rs, escapeHtml } from './roomsUtils.js';
import { showToast } from './utils.js';

let _snapshots = [];
let _loading = false;

function formatSnapshotTime(ts) {
  if (!ts) return '';
  const ms = Number(ts) < 1e11 ? Number(ts) * 1000 : Number(ts);
  const d = new Date(ms);
  const now = Date.now();
  const diff = now - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatSize(bytes) {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export function renderSnapshotSection(container) {
  if (!container) return;

  // The container is now a <details class="sidebar-accordion"> element
  const summaryHtml = `
    <summary class="sidebar-accordion-header">
      <span class="sidebar-accordion-icon">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="12" height="12" rx="2"/><path d="M8 5v6M5 8h6"/></svg>
      </span>
      <span class="sidebar-accordion-title">Snapshots</span>
      <span class="sidebar-accordion-badge"${_snapshots.length === 0 ? ' hidden' : ''}>${_snapshots.length}</span>
      <span class="sidebar-accordion-chevron">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5L6 7.5L9 4.5"/></svg>
      </span>
    </summary>
  `;

  const bodyHtml = `
    <div class="sidebar-accordion-body">
      <div class="snapshot-create-row">
        <input type="text" class="snapshot-label-input" placeholder="Snapshot label…" maxlength="120" />
        <button type="button" class="snapshot-create-btn" title="Create snapshot">📷</button>
      </div>
      <div class="snapshot-list">
        ${_loading ? '<div class="snapshot-loading">Loading…</div>' : ''}
        ${!_loading && _snapshots.length === 0 ? '<div class="snapshot-empty">No snapshots yet</div>' : ''}
        ${_snapshots.map(s => `
          <div class="snapshot-item" data-id="${escapeHtml(s.id)}">
            <div class="snapshot-item-top">
              <span class="snapshot-item-label" title="${escapeHtml(s.description || s.label)}">${escapeHtml(s.label)}</span>
              <button type="button" class="snapshot-delete-btn" data-id="${escapeHtml(s.id)}" title="Delete">×</button>
            </div>
            <div class="snapshot-item-meta">
              <span>${s.file_count} files</span>
              <span>${formatSize(s.total_size)}</span>
              <span>${formatSnapshotTime(s.created_at)}</span>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;

  container.innerHTML = summaryHtml + bodyHtml;

  // Bind create
  const input = container.querySelector('.snapshot-label-input');
  const createBtn = container.querySelector('.snapshot-create-btn');
  if (createBtn && input) {
    createBtn.addEventListener('click', () => handleCreateSnapshot(input, container));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleCreateSnapshot(input, container);
    });
  }

  // Bind delete
  container.querySelectorAll('.snapshot-delete-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleDeleteSnapshot(btn.dataset.id, container);
    });
  });

  // Bind detail view on click
  container.querySelectorAll('.snapshot-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.closest('.snapshot-delete-btn')) return;
      handleViewSnapshot(item.dataset.id, container);
    });
  });
}

async function handleCreateSnapshot(input, container) {
  const label = input.value.trim();
  if (!label) { showToast('Enter a snapshot label', 'error'); return; }
  if (!rs.currentAgentRoomId) return;

  try {
    input.disabled = true;
    await createAgentRoomSnapshot(rs.currentAgentRoomId, label);
    input.value = '';
    showToast('Snapshot created');
    await loadSnapshots(container);
  } catch (err) {
    showToast(err.message || 'Failed to create snapshot', 'error');
  } finally {
    input.disabled = false;
    input.focus();
  }
}

async function handleDeleteSnapshot(snapshotId, container) {
  if (!rs.currentAgentRoomId || !snapshotId) return;
  try {
    await deleteAgentRoomSnapshot(rs.currentAgentRoomId, snapshotId);
    showToast('Snapshot deleted');
    await loadSnapshots(container);
  } catch (err) {
    showToast(err.message || 'Failed to delete snapshot', 'error');
  }
}

async function handleViewSnapshot(snapshotId, container) {
  if (!rs.currentAgentRoomId || !snapshotId) return;
  try {
    const data = await getAgentRoomSnapshot(rs.currentAgentRoomId, snapshotId);
    const snapshot = data?.snapshot;
    if (!snapshot) return;

    const files = snapshot.snapshot_data?.files || [];
    const detail = container.querySelector('.snapshot-detail-overlay');
    if (detail) detail.remove();

    const overlay = document.createElement('div');
    overlay.className = 'snapshot-detail-overlay';
    overlay.innerHTML = `
      <div class="snapshot-detail-header">
        <strong>${escapeHtml(snapshot.label)}</strong>
        <button type="button" class="snapshot-detail-close" title="Close">×</button>
      </div>
      ${snapshot.description ? `<div class="snapshot-detail-desc">${escapeHtml(snapshot.description)}</div>` : ''}
      <div class="snapshot-detail-meta">${files.length} files · ${formatSize(snapshot.total_size)} · by ${escapeHtml(snapshot.created_by || 'unknown')}</div>
      <div class="snapshot-detail-files">
        ${files.map(f => `<div class="snapshot-file-row"><span>📄 ${escapeHtml(f.path)}</span><span>${formatSize(f.size)}</span></div>`).join('')}
        ${files.length === 0 ? '<div class="snapshot-empty">No files recorded</div>' : ''}
      </div>
    `;
    container.querySelector('.sidebar-accordion-body')?.appendChild(overlay);

    overlay.querySelector('.snapshot-detail-close')?.addEventListener('click', () => overlay.remove());
  } catch (err) {
    showToast(err.message || 'Failed to load snapshot', 'error');
  }
}

export async function loadSnapshots(container) {
  if (!rs.currentAgentRoomId) { _snapshots = []; renderSnapshotSection(container); return; }
  _loading = true;
  renderSnapshotSection(container);
  try {
    const data = await listAgentRoomSnapshots(rs.currentAgentRoomId);
    _snapshots = data?.snapshots || [];
  } catch {
    _snapshots = [];
  }
  _loading = false;
  renderSnapshotSection(container);
}

export function clearSnapshots() {
  _snapshots = [];
}
