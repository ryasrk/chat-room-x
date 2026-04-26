/**
 * Export Manager — chat export (Markdown/JSON/text), share link generation,
 * and share import processing.
 */

import { state } from './appState.js';
import {
  createConversation as createStoredConversation, saveConversation,
  exportAsMarkdown, exportAsJSON, exportAsText,
  generateShareData, importShareData,
} from './chatStorage.js';
import { generateTitle } from './conversationManager.js';
import { showToast } from './utils.js';
import { openModal, closeModal } from './modalManager.js';

const $ = (sel) => document.querySelector(sel);
const exportModal = $('#export-modal');
const importShareModal = $('#import-share-modal');
const importShareInput = $('#import-share-input');

let _loadConversationById = null;

export function initExportManager({ loadConversationById }) {
  _loadConversationById = loadConversationById;
}

// ── Export ─────────────────────────────────────────────────────

export function exportChat(format) {
  if (format === 'share') { handleShare(); return; }
  if (format === 'import-share') { handleImportShare(); return; }

  const conv = {
    id: state.conversationId || 'export',
    title: generateTitle(state.messages.find((m) => m.role === 'user')?.content || 'Chat'),
    messages: state.messages,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    mode: state.mode,
  };

  let content, filename, mime;
  if (format === 'markdown') {
    content = exportAsMarkdown(conv); filename = `chat_${Date.now()}.md`; mime = 'text/markdown';
  } else if (format === 'json') {
    content = exportAsJSON(conv); filename = `chat_${Date.now()}.json`; mime = 'application/json';
  } else {
    content = exportAsText(conv); filename = `chat_${Date.now()}.txt`; mime = 'text/plain';
  }

  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
  closeModal(exportModal);
}

// ── Share ───────────────────────────────────────────────────────

function buildShareHtml(conv) {
  const msgs = conv.messages.map((m) => {
    const role = m.role === 'user' ? 'You' : 'Cloud AI';
    const escaped = m.content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<div style="margin:8px 0;padding:10px;border-radius:8px;background:${m.role === 'user' ? '#1a3a5c' : '#1c1c2e'}"><strong>${role}</strong><pre style="white-space:pre-wrap;margin:6px 0 0;font-family:inherit">${escaped}</pre></div>`;
  }).join('');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${conv.title}</title><style>body{background:#0d1117;color:#e6edf3;font-family:-apple-system,sans-serif;max-width:720px;margin:0 auto;padding:20px}</style></head><body><h2>${conv.title}</h2><p style="color:#8b949e">Exported from Tenrary-X Cloud</p>${msgs}</body></html>`;
}

function handleShare() {
  const conv = {
    id: state.conversationId || 'export',
    title: generateTitle(state.messages.find((m) => m.role === 'user')?.content || 'Chat'),
    messages: state.messages,
    createdAt: Date.now(), updatedAt: Date.now(), mode: state.mode,
  };
  const encoded = generateShareData(conv);

  if (navigator.share) {
    navigator.share({
      title: `Tenrary-X: ${conv.title}`,
      text: `Check out this Tenrary-X conversation: ${conv.title}`,
      url: `${location.origin}${location.pathname}?share=${encoded}`,
    }).catch(() => {});
  } else {
    const htmlSnippet = buildShareHtml(conv);
    navigator.clipboard.writeText(htmlSnippet).then(() => {
      showToast('Share HTML copied to clipboard', 'success');
    }).catch(() => {
      navigator.clipboard.writeText(encoded).then(() => {
        showToast('Share data copied to clipboard', 'success');
      }).catch(() => { showToast('Failed to copy share data', 'error'); });
    });
  }
  closeModal(exportModal);
}

// ── Import Share ────────────────────────────────────────────────

export function handleImportShare() {
  closeModal(exportModal);
  if (importShareInput) importShareInput.value = '';
  openModal(importShareModal, null);
  setTimeout(() => importShareInput?.focus(), 100);
}

export function processImportShare(encoded) {
  if (!encoded || !encoded.trim()) return;
  const data = importShareData(encoded.trim());
  if (!data) { showToast('Invalid share data. Please check the string and try again.', 'error'); return; }

  const ts = Date.now();
  const conv = createStoredConversation(data.title || 'Shared Chat');
  conv.messages = data.messages.map((m) => ({
    role: m.role, content: m.content, timestamp: m.timestamp || ts,
  }));
  saveConversation(conv).then(() => _loadConversationById?.(conv.id)).catch(() => showToast('Failed to import shared conversation', 'error'));
}

export function checkShareUrl() {
  const params = new URLSearchParams(location.search);
  const shareParam = params.get('share');
  if (!shareParam) return;
  const data = importShareData(shareParam);
  if (!data) return;
  const ts = Date.now();
  const conv = createStoredConversation(data.title || 'Shared Chat');
  conv.messages = data.messages.map((m) => ({
    role: m.role, content: m.content, timestamp: m.timestamp || ts,
  }));
  saveConversation(conv).then(() => {
    _loadConversationById?.(conv.id);
    history.replaceState(null, '', location.pathname);
  }).catch(() => showToast('Failed to import shared conversation', 'error'));
}
