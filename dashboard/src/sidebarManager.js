/**
 * Sidebar Manager — conversation list, context menu, rename/move/new-project/
 * delete-project modals, and import-share modal handler.
 */

import { state } from './appState.js';
import {
  listConversations, loadConversation, autoSave,
  deleteConversation as deleteStoredConversation,
} from './chatStorage.js';
import {
  renderConversationList, createFolder, deleteFolder, getFolders,
  syncFoldersFromConversations,
} from './conversationManager.js';
import { escapeHtml, showToast } from './utils.js';
import { openModal, closeModal } from './modalManager.js';

const $ = (sel) => document.querySelector(sel);

const conversationListEl = $('#conversation-list');
const contextMenu = $('#conv-context-menu');
const newFolderBtn = $('#new-folder-btn');
const newProjectModal = $('#new-project-modal');
const newProjectNameInput = $('#new-project-name');
const newProjectCreateBtn = $('#new-project-create');
const newProjectCancelBtn = $('#new-project-cancel');
const renameModal = $('#rename-modal');
const renameModalInput = $('#rename-modal-input');
const renameModalConfirmBtn = $('#rename-modal-confirm');
const renameModalCancelBtn = $('#rename-modal-cancel');
const moveFolderModal = $('#move-folder-modal');
const moveFolderList = $('#move-folder-list');
const moveFolderNewInput = $('#move-folder-new-input');
const moveFolderConfirmBtn = $('#move-folder-confirm');
const moveFolderCancelBtn = $('#move-folder-cancel');
const importShareConfirmBtn = $('#import-share-confirm');
const importShareCancelBtn = $('#import-share-cancel');
const importShareInput = $('#import-share-input');
const importShareModal = $('#import-share-modal');
const deleteProjectModal = $('#delete-project-modal');
const deleteProjectNameEl = $('#delete-project-name');
const deleteProjectConfirmBtn = $('#delete-project-confirm');
const deleteProjectCancelBtn = $('#delete-project-cancel');

// These are injected at init to avoid circular deps with chatApi.js
let _loadConversationById = null;
let _startNewConversation = null;
let _processImportShare = null;

export function initSidebarManager({ loadConversationById, startNewConversation, processImportShare }) {
  _loadConversationById = loadConversationById;
  _startNewConversation = startNewConversation;
  _processImportShare = processImportShare;
}

// ── Sidebar Render ─────────────────────────────────────────────

export async function refreshSidebar() {
  const convs = await listConversations();
  syncFoldersFromConversations(convs);
  const activeId = state.conversationId;
  if (!conversationListEl) return;
  conversationListEl.innerHTML = renderConversationList(convs, activeId);

  conversationListEl.querySelectorAll('[data-conv-id]').forEach((el) => {
    el.addEventListener('click', () => _loadConversationById?.(el.dataset.convId));
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); showContextMenu(e, el.dataset.convId); });

    const delBtn = el.querySelector('.conv-delete');
    if (delBtn) {
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await deleteStoredConversation(el.dataset.convId);
        if (el.dataset.convId === state.conversationId) _startNewConversation?.();
        refreshSidebar();
      });
    }
  });

  conversationListEl.querySelectorAll('.folder-header').forEach((header) => {
    header.addEventListener('click', (e) => {
      if (e.target.closest('.folder-delete')) return;
      header.classList.toggle('collapsed');
      const folder = header.dataset.folder;
      const content = conversationListEl.querySelector(`.folder-content[data-folder="${folder}"]`);
      if (content) content.hidden = header.classList.contains('collapsed');
      const toggle = header.querySelector('.folder-toggle');
      if (toggle) toggle.textContent = header.classList.contains('collapsed') ? '▸' : '▾';
    });
    const delBtn = header.querySelector('.folder-delete');
    if (delBtn) {
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openDeleteProjectModal(header.dataset.folder);
      });
    }
  });
}

// ── Context Menu ───────────────────────────────────────────────

let _contextMenuConvId = null;

function showContextMenu(event, convId) {
  if (!contextMenu) return;
  _contextMenuConvId = convId;
  contextMenu.hidden = false;
  contextMenu.style.top = `${event.clientY}px`;
  contextMenu.style.left = `${event.clientX}px`;
  requestAnimationFrame(() => {
    const rect = contextMenu.getBoundingClientRect();
    if (rect.right > window.innerWidth) contextMenu.style.left = `${window.innerWidth - rect.width - 4}px`;
    if (rect.bottom > window.innerHeight) contextMenu.style.top = `${window.innerHeight - rect.height - 4}px`;
  });
}

function hideContextMenu() {
  if (contextMenu) contextMenu.hidden = true;
  _contextMenuConvId = null;
}

document.addEventListener('click', () => hideContextMenu());
document.addEventListener('contextmenu', (e) => {
  if (!e.target.closest('.conv-item')) hideContextMenu();
});

if (contextMenu) {
  contextMenu.addEventListener('click', async (e) => {
    const action = e.target.dataset?.action;
    if (!action || !_contextMenuConvId) return;
    e.stopPropagation();
    const convId = _contextMenuConvId;
    hideContextMenu();
    if (action === 'rename') openRenameModal(convId);
    else if (action === 'move-folder') openMoveFolderModal(convId);
    else if (action === 'delete') {
      await deleteStoredConversation(convId);
      if (convId === state.conversationId) _startNewConversation?.();
      refreshSidebar();
    }
  });
}

// ── Rename Modal ───────────────────────────────────────────────

let _renameTargetId = null;

function openRenameModal(convId) {
  _renameTargetId = convId;
  if (renameModalInput) renameModalInput.value = '';
  openModal(renameModal, null);
  setTimeout(() => renameModalInput?.focus(), 100);
}

async function handleRenameConfirm() {
  const newTitle = renameModalInput?.value?.trim();
  if (!newTitle || !_renameTargetId) return;
  const conv = await loadConversation(_renameTargetId);
  if (conv) {
    conv.title = newTitle;
    await autoSave(conv);
    refreshSidebar();
    showToast('Conversation renamed', 'success');
  }
  closeModal(renameModal);
  _renameTargetId = null;
}

if (renameModalConfirmBtn) renameModalConfirmBtn.addEventListener('click', handleRenameConfirm);
if (renameModalCancelBtn) renameModalCancelBtn.addEventListener('click', () => { closeModal(renameModal); _renameTargetId = null; });
if (renameModalInput) {
  renameModalInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); handleRenameConfirm(); } });
}

// ── Move to Folder Modal ───────────────────────────────────────

let _moveFolderTargetId = null;
let _moveFolderSelected = null;

export function openMoveFolderModal(convId) {
  _moveFolderTargetId = convId;
  _moveFolderSelected = null;
  if (moveFolderNewInput) moveFolderNewInput.value = '';
  if (moveFolderList) {
    const folders = getFolders();
    if (folders.length === 0) {
      moveFolderList.innerHTML = '<p class="modal-desc" style="margin:0;font-size:0.85rem;color:var(--text-muted)">No folders yet. Create one below.</p>';
    } else {
      moveFolderList.innerHTML = folders.map((f) =>
        `<button class="move-folder-option" type="button" data-folder="${escapeHtml(f)}">${escapeHtml(f)}</button>`
      ).join('');
      moveFolderList.querySelectorAll('.move-folder-option').forEach((btn) => {
        btn.addEventListener('click', () => {
          moveFolderList.querySelectorAll('.move-folder-option').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
          _moveFolderSelected = btn.dataset.folder;
          if (moveFolderNewInput) moveFolderNewInput.value = '';
        });
      });
    }
  }
  openModal(moveFolderModal, null);
}

async function handleMoveFolderConfirm() {
  if (!_moveFolderTargetId) return;
  const newFolderName = moveFolderNewInput?.value?.trim();
  let selectedFolder = _moveFolderSelected ?? '';
  if (newFolderName) { selectedFolder = newFolderName; createFolder(newFolderName); }
  const conv = await loadConversation(_moveFolderTargetId);
  if (conv) {
    conv.folder = selectedFolder;
    await autoSave(conv);
    refreshSidebar();
    showToast(selectedFolder ? `Moved to "${selectedFolder}"` : 'Moved to General', 'success');
  }
  closeModal(moveFolderModal);
  _moveFolderTargetId = null;
  _moveFolderSelected = null;
}

if (moveFolderConfirmBtn) moveFolderConfirmBtn.addEventListener('click', handleMoveFolderConfirm);
if (moveFolderCancelBtn) {
  moveFolderCancelBtn.addEventListener('click', () => {
    closeModal(moveFolderModal); _moveFolderTargetId = null; _moveFolderSelected = null;
  });
}
if (moveFolderNewInput) {
  moveFolderNewInput.addEventListener('input', () => {
    if (moveFolderNewInput.value.trim()) {
      moveFolderList?.querySelectorAll('.move-folder-option').forEach((b) => b.classList.remove('active'));
      _moveFolderSelected = null;
    }
  });
  moveFolderNewInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); handleMoveFolderConfirm(); } });
}

// ── Import Share Modal ─────────────────────────────────────────

if (importShareConfirmBtn) {
  importShareConfirmBtn.addEventListener('click', () => {
    const encoded = importShareInput?.value ?? '';
    _processImportShare?.(encoded);
    closeModal(importShareModal);
  });
}
if (importShareCancelBtn) importShareCancelBtn.addEventListener('click', () => closeModal(importShareModal));
if (importShareInput) {
  importShareInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); importShareConfirmBtn?.click(); }
  });
}

// ── New Project Modal ──────────────────────────────────────────

export function openNewProjectModal() {
  if (!newProjectModal) return;
  if (newProjectNameInput) newProjectNameInput.value = '';
  openModal(newProjectModal, newFolderBtn);
  setTimeout(() => newProjectNameInput?.focus(), 100);
}

function handleCreateProject() {
  const name = newProjectNameInput?.value?.trim();
  if (!name) return;
  const success = createFolder(name);
  closeModal(newProjectModal);
  if (success) { refreshSidebar(); showToast(`Project "${name}" created`, 'success'); }
  else showToast(`Project "${name}" already exists`, 'error');
}

if (newFolderBtn) newFolderBtn.addEventListener('click', openNewProjectModal);
if (newProjectCreateBtn) newProjectCreateBtn.addEventListener('click', handleCreateProject);
if (newProjectCancelBtn) newProjectCancelBtn.addEventListener('click', () => closeModal(newProjectModal));
if (newProjectNameInput) {
  newProjectNameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); handleCreateProject(); } });
}

// ── Delete Project Modal ───────────────────────────────────────

let _pendingDeleteFolder = null;

export function openDeleteProjectModal(folderName) {
  _pendingDeleteFolder = folderName;
  if (deleteProjectNameEl) deleteProjectNameEl.textContent = folderName;
  openModal(deleteProjectModal, null);
}

if (deleteProjectConfirmBtn) {
  deleteProjectConfirmBtn.addEventListener('click', () => {
    if (!_pendingDeleteFolder) return;
    deleteFolder(_pendingDeleteFolder);
    showToast(`Project "${_pendingDeleteFolder}" deleted`, 'success');
    _pendingDeleteFolder = null;
    closeModal(deleteProjectModal);
    refreshSidebar();
  });
}
if (deleteProjectCancelBtn) {
  deleteProjectCancelBtn.addEventListener('click', () => {
    _pendingDeleteFolder = null;
    closeModal(deleteProjectModal);
  });
}
