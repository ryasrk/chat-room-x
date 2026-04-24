/**
 * File Manager — file attachment (docs + images) and drag-and-drop uploads.
 * Exports renderAttachedFiles so chatApi.js can call it via init.
 */

import { state } from './appState.js';
import { escapeHtml, showToast } from './utils.js';
import { indexAttachment } from './observabilityPanel.js';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED_DOC_TYPES = new Set([
  'text/plain', 'text/markdown', 'application/json', 'text/csv',
  'application/pdf', 'text/x-python', 'application/javascript',
  'application/typescript', 'video/mp2t',
]);
const ALLOWED_DOC_EXTENSIONS = new Set(['.txt', '.md', '.json', '.csv', '.pdf', '.py', '.js', '.ts']);

const fileUploadDoc = document.querySelector('#file-upload-doc');
const fileUploadImg = document.querySelector('#file-upload-img');
const chatContainer = document.querySelector('#chat-container');
const chatMain = document.querySelector('.chat-main') || chatContainer;

// ── Attach ─────────────────────────────────────────────────────

export function handleFileAttach(input) {
  const files = Array.from(input.files);
  const isImageInput = input === fileUploadImg;

  files.forEach((file) => {
    if (file.size > MAX_FILE_SIZE) {
      showToast(`File "${file.name}" exceeds the 10 MB limit`, 'error');
      return;
    }
    if (isImageInput) {
      if (!file.type.startsWith('image/')) {
        showToast(`File "${file.name}" is not a valid image`, 'error');
        return;
      }
    } else {
      const ext = '.' + file.name.split('.').pop().toLowerCase();
      if (!ALLOWED_DOC_TYPES.has(file.type) && !ALLOWED_DOC_EXTENSIONS.has(ext)) {
        showToast(`File "${file.name}" has an unsupported type`, 'error');
        return;
      }
    }
    if (state.attachedFiles.some((f) => f.name === file.name)) return;
    state.attachedFiles.push(file);

    // Index text-based files for citation grounding
    if (!file.type.startsWith('image/') && file.size < 1_000_000) {
      file.text().then(text => indexAttachment(file.name, text)).catch(() => {});
    }
  });

  renderAttachedFiles();
  input.value = '';
}

// ── Render ─────────────────────────────────────────────────────

export function renderAttachedFiles() {
  let container = document.querySelector('.attached-files');

  if (state.attachedFiles.length === 0) {
    container?.remove();
    return;
  }

  if (!container) {
    container = document.createElement('div');
    container.className = 'attached-files';
    const wrapper = document.querySelector('.input-wrapper');
    const toolbar = wrapper?.querySelector('.input-toolbar');
    if (wrapper && toolbar) {
      wrapper.insertBefore(container, toolbar);
    }
  }

  container.innerHTML = state.attachedFiles
    .map((f, i) => `<span class="attached-file">${escapeHtml(f.name)}<button class="remove-file" data-idx="${i}" title="Remove">×</button></span>`)
    .join('');

  container.querySelectorAll('.remove-file').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.attachedFiles.splice(parseInt(btn.dataset.idx, 10), 1);
      renderAttachedFiles();
    });
  });
}

// ── Drag & Drop ────────────────────────────────────────────────

if (chatMain) {
  chatMain.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    chatMain.classList.add('drag-over');
  });

  chatMain.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    chatMain.classList.remove('drag-over');
  });

  chatMain.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    chatMain.classList.remove('drag-over');
    Array.from(e.dataTransfer.files).forEach((file) => {
      if (file.size > MAX_FILE_SIZE) { showToast(`File "${file.name}" exceeds 10MB limit`, 'error'); return; }
      if (state.attachedFiles.some((f) => f.name === file.name)) return;
      state.attachedFiles.push(file);
    });
    renderAttachedFiles();
  });
}

// ── Input Change Listeners ─────────────────────────────────────

if (fileUploadDoc) fileUploadDoc.addEventListener('change', () => handleFileAttach(fileUploadDoc));
if (fileUploadImg) fileUploadImg.addEventListener('change', () => handleFileAttach(fileUploadImg));
