/**
 * Search Manager — command autocomplete, in-page message search, and
 * live Markdown preview in the input area.
 */

import { renderMarkdown } from './markdownRenderer.js';
import { getCommands } from './pluginManager.js';
import { state } from './appState.js';
import { escapeHtml, autoResize } from './utils.js';

const $ = (sel) => document.querySelector(sel);
const messagesEl = $('#messages');
const userInput = $('#user-input');
const msgSearchBar = $('#msg-search-bar');
const msgSearchInput = $('#msg-search-input');
const msgSearchCount = $('#msg-search-count');
const msgSearchPrev = $('#msg-search-prev');
const msgSearchNext = $('#msg-search-next');
const msgSearchClose = $('#msg-search-close');
const inputPreview = $('#input-preview');

// Injected via initSearchManager to break circular dep with chatApi
let _sendMessage = null;
let _updateSendButton = null;

export function initSearchManager({ sendMessage, updateSendButton }) {
  _sendMessage = sendMessage;
  _updateSendButton = updateSendButton;
}

// ── Command Autocomplete ───────────────────────────────────────

let autocompleteEl = null;
let autocompleteSelectedIdx = -1;

function createAutocompleteEl() {
  if (autocompleteEl) return autocompleteEl;
  autocompleteEl = document.createElement('div');
  autocompleteEl.className = 'command-autocomplete';
  autocompleteEl.hidden = true;
  const inputWrapper = document.querySelector('.input-wrapper');
  if (inputWrapper) {
    inputWrapper.style.position = 'relative';
    inputWrapper.appendChild(autocompleteEl);
  }
  return autocompleteEl;
}

export function showCommandAutocomplete(filter) {
  const el = createAutocompleteEl();
  const cmds = getCommands();
  const query = filter.slice(1).toLowerCase();
  const matches = query ? cmds.filter((c) => c.command.toLowerCase().startsWith(query)) : cmds;

  if (matches.length === 0) { el.hidden = true; return; }

  autocompleteSelectedIdx = -1;
  el.innerHTML = matches.map((c, i) =>
    `<div class="command-item" data-idx="${i}" data-cmd="/${c.command}">
      <span class="command-name">/${c.command}</span>
      <span class="command-desc">${escapeHtml(c.description)}</span>
    </div>`
  ).join('');
  el.hidden = false;

  el.querySelectorAll('.command-item').forEach((item) => {
    item.addEventListener('click', () => {
      if (userInput) { userInput.value = item.dataset.cmd + ' '; autoResize(userInput); }
      hideCommandAutocomplete();
      userInput?.focus();
      _updateSendButton?.();
    });
  });
}

export function hideCommandAutocomplete() {
  if (autocompleteEl) { autocompleteEl.hidden = true; autocompleteSelectedIdx = -1; }
}

export function navigateAutocomplete(direction) {
  if (!autocompleteEl || autocompleteEl.hidden) return false;
  const items = autocompleteEl.querySelectorAll('.command-item');
  if (items.length === 0) return false;
  items.forEach((it) => it.classList.remove('selected'));
  autocompleteSelectedIdx += direction;
  if (autocompleteSelectedIdx < 0) autocompleteSelectedIdx = items.length - 1;
  if (autocompleteSelectedIdx >= items.length) autocompleteSelectedIdx = 0;
  items[autocompleteSelectedIdx].classList.add('selected');
  items[autocompleteSelectedIdx].scrollIntoView({ block: 'nearest' });
  return true;
}

export function selectAutocompleteItem() {
  if (!autocompleteEl || autocompleteEl.hidden || autocompleteSelectedIdx < 0) return false;
  const items = autocompleteEl.querySelectorAll('.command-item');
  if (autocompleteSelectedIdx < items.length) {
    if (userInput) { userInput.value = items[autocompleteSelectedIdx].dataset.cmd + ' '; autoResize(userInput); }
    hideCommandAutocomplete();
    _updateSendButton?.();
    return true;
  }
  return false;
}

// ── Message Search (Ctrl+F in messages) ───────────────────────

let searchMatches = [];
let searchCurrentIdx = -1;

function clearSearchHighlights() {
  messagesEl?.querySelectorAll('mark.search-highlight').forEach((mark) => {
    const parent = mark.parentNode;
    parent.replaceChild(document.createTextNode(mark.textContent), mark);
    parent.normalize();
  });
  searchMatches = [];
  searchCurrentIdx = -1;
  if (msgSearchCount) msgSearchCount.textContent = '';
}

function highlightSearchMatches(query) {
  clearSearchHighlights();
  if (!query || !messagesEl) return;

  const lowerQuery = query.toLowerCase();
  const walker = document.createTreeWalker(messagesEl, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.parentElement.closest('.msg-search-bar')) return NodeFilter.FILTER_REJECT;
      if (node.parentElement.closest('.message-content')) return NodeFilter.FILTER_ACCEPT;
      return NodeFilter.FILTER_REJECT;
    },
  });

  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  textNodes.forEach((textNode) => {
    const text = textNode.textContent;
    const lowerText = text.toLowerCase();
    let idx = lowerText.indexOf(lowerQuery);
    if (idx === -1) return;

    const frag = document.createDocumentFragment();
    let lastIdx = 0;
    while (idx !== -1) {
      if (idx > lastIdx) frag.appendChild(document.createTextNode(text.slice(lastIdx, idx)));
      const mark = document.createElement('mark');
      mark.className = 'search-highlight';
      mark.textContent = text.slice(idx, idx + query.length);
      frag.appendChild(mark);
      lastIdx = idx + query.length;
      idx = lowerText.indexOf(lowerQuery, lastIdx);
    }
    if (lastIdx < text.length) frag.appendChild(document.createTextNode(text.slice(lastIdx)));
    textNode.parentNode.replaceChild(frag, textNode);
  });

  searchMatches = Array.from(messagesEl.querySelectorAll('mark.search-highlight'));
  if (searchMatches.length > 0) {
    searchCurrentIdx = 0;
    searchMatches[0].classList.add('current');
    searchMatches[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  if (msgSearchCount) {
    msgSearchCount.textContent = searchMatches.length > 0
      ? `${searchCurrentIdx + 1}/${searchMatches.length}`
      : 'No results';
  }
}

function navigateSearch(direction) {
  if (searchMatches.length === 0) return;
  searchMatches[searchCurrentIdx]?.classList.remove('current');
  searchCurrentIdx = (searchCurrentIdx + direction + searchMatches.length) % searchMatches.length;
  searchMatches[searchCurrentIdx].classList.add('current');
  searchMatches[searchCurrentIdx].scrollIntoView({ block: 'center', behavior: 'smooth' });
  if (msgSearchCount) msgSearchCount.textContent = `${searchCurrentIdx + 1}/${searchMatches.length}`;
}

export function openMsgSearch() {
  if (msgSearchBar) msgSearchBar.hidden = false;
  msgSearchInput?.focus();
  msgSearchInput?.select();
}

export function closeMsgSearch() {
  if (msgSearchBar) msgSearchBar.hidden = true;
  clearSearchHighlights();
  if (msgSearchInput) msgSearchInput.value = '';
}

// ── Message Search Event Listeners ────────────────────────────

let _msgSearchDebounce = null;
if (msgSearchInput) {
  msgSearchInput.addEventListener('input', () => {
    clearTimeout(_msgSearchDebounce);
    _msgSearchDebounce = setTimeout(() => highlightSearchMatches(msgSearchInput.value.trim()), 200);
  });
  msgSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); navigateSearch(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') { e.preventDefault(); closeMsgSearch(); }
  });
}

if (msgSearchPrev) msgSearchPrev.addEventListener('click', () => navigateSearch(-1));
if (msgSearchNext) msgSearchNext.addEventListener('click', () => navigateSearch(1));
if (msgSearchClose) msgSearchClose.addEventListener('click', closeMsgSearch);

// ── Markdown Preview in Input ──────────────────────────────────

const MD_PATTERN = /(`{1,3}|#{1,6}\s|\*{1,2}[^*]|\[.*\]\(|^>\s|^-\s|^\d+\.\s|~~|__)/m;

let _previewDebounce = null;
if (userInput && inputPreview) {
  userInput.addEventListener('input', () => {
    clearTimeout(_previewDebounce);
    _previewDebounce = setTimeout(() => {
      const text = userInput.value;
      if (!text.trim() || !MD_PATTERN.test(text)) {
        inputPreview.hidden = true;
        inputPreview.innerHTML = '';
        return;
      }
      inputPreview.innerHTML = renderMarkdown(text);
      inputPreview.hidden = false;
    }, 300);
  });
}
