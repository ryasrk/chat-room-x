/**
 * Message Renderer — DOM creation for chat messages, branch navigation,
 * streaming indicator, edit, and regenerate.
 */

import { state } from './appState.js';
import { renderMarkdown, stripThinking, renderThinkingBlock } from './markdownRenderer.js';
import { escapeHtml, normalizeContent, autoResize } from './utils.js';
import { updateContextBar, updateTokenInfo } from './uiUpdaters.js';

const $ = (sel) => document.querySelector(sel);
const messagesEl = $('#messages');
const userInput = $('#user-input');
const chatContainer = $('#chat-container');

function scrollToBottom() {
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

// ── Branch Navigation ──────────────────────────────────────────

export function addBranchNavToEl(msgEl, msg) {
  if (!msg || !msg.branches || msg.branches.length <= 1) return;

  const nav = document.createElement('div');
  nav.className = 'branch-nav';

  const prevBtn = document.createElement('button');
  prevBtn.className = 'branch-prev';
  prevBtn.title = 'Previous version';
  prevBtn.textContent = '←';

  const info = document.createElement('span');
  info.className = 'branch-info';
  info.textContent = `${(msg.activeBranch ?? 0) + 1}/${msg.branches.length}`;

  const nextBtn = document.createElement('button');
  nextBtn.className = 'branch-next';
  nextBtn.title = 'Next version';
  nextBtn.textContent = '→';

  // Branch tree dots — visual indicator of all branches
  const dots = document.createElement('span');
  dots.className = 'branch-dots';
  function renderDots() {
    dots.innerHTML = msg.branches.map((_, i) =>
      `<span class="branch-dot${i === msg.activeBranch ? ' active' : ''}" data-idx="${i}" title="Version ${i + 1}"></span>`
    ).join('');
  }
  renderDots();

  dots.addEventListener('click', (e) => {
    const dot = e.target.closest('.branch-dot');
    if (!dot) return;
    const idx = parseInt(dot.dataset.idx, 10);
    if (idx >= 0 && idx < msg.branches.length) {
      msg.activeBranch = idx;
      updateBranchView();
    }
  });

  function updateBranchView() {
    const branch = msg.branches[msg.activeBranch];
    const contentEl = msgEl.querySelector('.message-content');
    const { thinking, content: mainContent } = stripThinking(branch.content);
    let html = '';
    if (thinking && state.settings.showThinking) {
      html += renderThinkingBlock(branch.content);
    }
    html += renderMarkdown(mainContent || branch.content);
    contentEl.innerHTML = html;

    const statsEl = msgEl.querySelector('.message-stats');
    if (statsEl && branch.stats) statsEl.textContent = branch.stats;

    info.textContent = `${msg.activeBranch + 1}/${msg.branches.length}`;
    prevBtn.disabled = msg.activeBranch === 0;
    nextBtn.disabled = msg.activeBranch === msg.branches.length - 1;
    renderDots();

    msg.content = branch.content;
    msg.stats = branch.stats;
  }

  prevBtn.addEventListener('click', () => {
    if (msg.activeBranch > 0) { msg.activeBranch--; updateBranchView(); }
  });
  nextBtn.addEventListener('click', () => {
    if (msg.activeBranch < msg.branches.length - 1) { msg.activeBranch++; updateBranchView(); }
  });

  prevBtn.disabled = (msg.activeBranch ?? 0) === 0;
  nextBtn.disabled = (msg.activeBranch ?? 0) === msg.branches.length - 1;

  nav.appendChild(prevBtn);
  nav.appendChild(dots);
  nav.appendChild(info);
  nav.appendChild(nextBtn);
  msgEl.querySelector('.message-body').appendChild(nav);
}

/**
 * Create a continuation card — shown when a conversation was interrupted.
 */
export function createContinuationCard(lastContent, onContinue) {
  const card = document.createElement('div');
  card.className = 'continuation-card';
  const preview = (lastContent || '').slice(0, 120).replace(/\n/g, ' ');
  card.innerHTML = `
    <div class="continuation-card-body">
      <span class="continuation-icon">↩️</span>
      <div class="continuation-text">
        <strong>Continue from where you left off?</strong>
        <span class="continuation-preview">${escapeHtml(preview)}…</span>
      </div>
      <button type="button" class="continuation-btn">Continue</button>
    </div>
  `;
  card.querySelector('.continuation-btn')?.addEventListener('click', () => {
    card.remove();
    onContinue?.();
  });
  return card;
}

// ── Message Element ────────────────────────────────────────────

export function createMessageEl(role, content, stats = null, images = [], msgData = {}) {
  content = normalizeContent(content);

  const div = document.createElement('div');
  div.className = `message ${role}${msgData.pinned ? ' pinned' : ''}`;

  const avatar = role === 'user' ? 'U' : 'AI';
  const roleName = role === 'user' ? 'You' : 'Cloud AI';
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  let renderedContent;
  if (role === 'user') {
    renderedContent = `<p>${escapeHtml(content)}</p>`;
    if (images && images.length > 0) {
      renderedContent += images
        .filter((img) => img.dataUrl && img.dataUrl.startsWith('data:image/'))
        .map((img) => `<img src="${img.dataUrl}" class="chat-image" alt="uploaded image: ${escapeHtml(img.name)}" loading="lazy" />`)
        .join('');
    }
  } else {
    const { thinking, content: mainContent } = stripThinking(content);
    let thinkingHtml = '';
    if (thinking && state.settings.showThinking) {
      thinkingHtml = renderThinkingBlock(content);
    }
    renderedContent = thinkingHtml + renderMarkdown(mainContent || content);
  }

  div.innerHTML = `
    <div class="message-avatar">${avatar}</div>
    <div class="message-body">
      <div class="message-meta">
        <span class="message-role">${roleName}</span>
        <span class="message-time">${time}</span>
        <button class="pin-msg-btn" title="Pin message">📌</button>
        ${role === 'user' ? '<button class="edit-msg-btn" title="Edit">Edit</button>' : '<button class="regen-btn" title="Regenerate">Redo</button>'}
        ${role === 'assistant' ? '<button class="reaction-btn" data-reaction="up" title="Good response">👍</button><button class="reaction-btn" data-reaction="down" title="Poor response">👎</button>' : ''}
      </div>
      <div class="message-content">${renderedContent}</div>
      <div class="message-actions">
        <button class="copy-msg-btn" title="Copy message">📋 Copy</button>
      </div>
      ${stats ? `<div class="message-stats">${stats}</div>` : ''}
    </div>
  `;

  // Code copy buttons
  div.querySelectorAll('.copy-btn, [data-copy]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const wrapper = btn.closest('.code-block-wrapper');
      const code = wrapper?.querySelector('pre code')?.textContent || wrapper?.querySelector('pre')?.textContent || '';
      navigator.clipboard.writeText(code).then(() => {
        btn.textContent = 'Copied!';
        setTimeout(() => (btn.textContent = 'Copy'), 2000);
      }).catch(() => {
        btn.textContent = 'Failed';
        setTimeout(() => (btn.textContent = 'Copy'), 2000);
      });
    });
  });

  // Edit button
  const editBtn = div.querySelector('.edit-msg-btn');
  if (editBtn) {
    editBtn.addEventListener('click', () => editMessage(div, content));
  }

  // Regen button — importRegenerateLastResponse is resolved lazily via live ESM binding
  const regenBtn = div.querySelector('.regen-btn');
  if (regenBtn) {
    regenBtn.addEventListener('click', () => regenerateLastResponse());
  }

  // Copy message button
  const copyMsgBtn = div.querySelector('.copy-msg-btn');
  if (copyMsgBtn) {
    copyMsgBtn.addEventListener('click', async () => {
      const contentEl = div.querySelector('.message-content');
      const text = contentEl?.innerText || contentEl?.textContent || content;
      try {
        await navigator.clipboard.writeText(text);
        copyMsgBtn.textContent = '✅';
        setTimeout(() => { copyMsgBtn.textContent = '📋 Copy'; }, 2000);
      } catch {
        copyMsgBtn.textContent = '❌';
        setTimeout(() => { copyMsgBtn.textContent = '📋 Copy'; }, 2000);
      }
    });
  }

  // Pin button
  const pinBtn = div.querySelector('.pin-msg-btn');
  if (pinBtn) {
    if (msgData.pinned) pinBtn.classList.add('active');
    pinBtn.addEventListener('click', () => {
      div.classList.toggle('pinned');
      pinBtn.classList.toggle('active');
      const msgRef = div._msgRef;
      if (msgRef) msgRef.pinned = div.classList.contains('pinned');
    });
  }

  // Reaction buttons
  div.querySelectorAll('.reaction-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const reaction = btn.dataset.reaction;
      const msgRef = div._msgRef;
      const isActive = btn.classList.contains('active');
      div.querySelectorAll('.reaction-btn').forEach((b) => b.classList.remove('active'));
      if (!isActive) {
        btn.classList.add('active');
        if (msgRef) msgRef.reaction = reaction;
      } else {
        if (msgRef) delete msgRef.reaction;
      }
    });
  });

  if (msgData.reaction) {
    const activeBtn = div.querySelector(`.reaction-btn[data-reaction="${msgData.reaction}"]`);
    if (activeBtn) activeBtn.classList.add('active');
  }

  // Store direct reference to message object for index-free lookups
  div._msgRef = msgData;

  addBranchNavToEl(div, msgData);
  return div;
}

// ── Streaming Indicator ────────────────────────────────────────

export function addStreamingIndicator() {
  const div = document.createElement('div');
  div.className = 'message assistant streaming';
  div.id = 'streaming-msg';
  const modeSelect = document.querySelector('#mode-select');
  const modelLabel = modeSelect?.options[modeSelect.selectedIndex]?.text || state.mode || 'AI';
  div.innerHTML = `
    <div class="message-avatar">AI</div>
    <div class="message-body">
      <div class="message-meta">
        <span class="message-role">${modelLabel}</span>
        <span class="message-time">${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
      <div class="message-content"><div class="thinking-dots"><span></span><span></span><span></span></div></div>
      <div class="live-stats"></div>
    </div>
  `;
  messagesEl.appendChild(div);
  scrollToBottom();
  return div;
}

// ── Edit & Regenerate ──────────────────────────────────────────

export function editMessage(msgEl, originalContent) {
  if (state.isStreaming) return;
  const msgIndex = Array.from(messagesEl.children).indexOf(msgEl);
  if (msgIndex < 0) return;

  // Track edit revision history on the message
  const msg = state.messages[msgIndex];
  if (msg) {
    if (!msg.editHistory) msg.editHistory = [];
    msg.editHistory.push({
      content: originalContent,
      timestamp: Date.now(),
    });
  }

  userInput.value = originalContent;
  autoResize(userInput);
  userInput.focus();

  while (messagesEl.children.length > msgIndex) {
    messagesEl.removeChild(messagesEl.lastChild);
  }
  state.messages = state.messages.slice(0, msgIndex);
  updateContextBar();
  updateTokenInfo();
}

export function regenerateLastResponse() {
  if (state.isStreaming || state.messages.length < 2) return;

  const lastMsg = state.messages[state.messages.length - 1];
  if (lastMsg.role !== 'assistant') return;

  if (!lastMsg.branches) {
    lastMsg.branches = [{ content: lastMsg.content, stats: lastMsg.stats, timestamp: lastMsg.timestamp }];
    lastMsg.activeBranch = 0;
  }

  state._pendingBranches = lastMsg.branches;
  state.messages.pop();
  messagesEl.removeChild(messagesEl.lastChild);

  const lastUserMsg = state.messages[state.messages.length - 1];
  if (lastUserMsg?.role === 'user') {
    // Imported lazily to avoid circular reference at module evaluation time
    import('./chatApi.js').then(({ sendToAPI }) => sendToAPI()).catch(() => { /* module load failure is non-recoverable */ });
  }
}
