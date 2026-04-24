/**
 * Chat API — streaming message sending (WebSocket with SSE fallback),
 * persistence, and conversation load/start.
 */

import { state } from './appState.js';
import { renderMarkdown, stripThinking, renderThinkingBlock } from './markdownRenderer.js';
import {
  createConversation as createStoredConversation, loadConversation, autoSave,
  setActiveConversationId, getActiveConversationId,
} from './chatStorage.js';
import { categorizeError } from './connectionManager.js';
import { createStreamStateMachine, StreamState } from './streamStateMachine.js';
import { estimateTokens, updateSessionStats, recordUsage, getSessionStats, formatTokenCount } from './tokenCounter.js';
import {
  generateTitle, generateTitleViaLLM, generateTitleFallback, getActiveConversation,
} from './conversationManager.js';
import { executeCommand } from './pluginManager.js';
import { escapeHtml, readFileAsDataURL, normalizeContent, autoResize, showToast } from './utils.js';
import { updateContextBar, updateTokenInfo, updateSendButton } from './uiUpdaters.js';
import { createMessageEl, addBranchNavToEl, regenerateLastResponse, addStreamingIndicator } from './messageRenderer.js';
import { buildModeRequestPayload, resolveModeModel } from './providerConfig.js';

const $ = (sel) => document.querySelector(sel);
const messagesEl = $('#messages');
const welcomeEl = $('#welcome');
const userInput = $('#user-input');
const sendBtn = $('#send-btn');
const stopBtn = $('#stop-btn');
const chatContainer = $('#chat-container');
const inputPreview = $('#input-preview');
const modeSelect = $('#mode-select');

function scrollToBottom() {
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

function getQueuePosition(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 999) return null;
  return n;
}

function extractTitleSource(messageLike) {
  const raw = normalizeContent(messageLike || '');
  if (!raw) return '';

  return raw
    .replace(/\[Attached[^\]]*\]/g, ' ')
    .replace(/---[^\n]*---\n?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// connMgr is provided via init to avoid the circular dep with main.js
let _connMgr = null;
let _renderAttachedFiles = null;
let _refreshSidebar = null;

const CONTEXT_COMPACT_THRESHOLD = 0.8;
const MIN_MESSAGES_FOR_COMPACTION = 8;
const PRESERVE_RECENT_MESSAGES = 8;

let _streamSM = null;

export function initChatApi({ connMgr, renderAttachedFiles, refreshSidebar }) {
  _connMgr = connMgr;
  _renderAttachedFiles = renderAttachedFiles;
  _refreshSidebar = refreshSidebar;

  _streamSM = createStreamStateMachine({
    onStateChange({ prev, current, error }) {
      const indicator = document.querySelector('.stream-state-indicator');
      if (indicator) {
        indicator.dataset.state = current;
        indicator.textContent = current === StreamState.QUEUED ? `Queued${_streamSM?.queuePosition ? ` #${_streamSM.queuePosition}` : ''}` :
          current === StreamState.STREAMING ? 'Streaming…' :
          current === StreamState.FINALIZING ? 'Finalizing…' :
          current === StreamState.ERROR ? 'Error' : '';
        indicator.hidden = current === StreamState.IDLE || current === StreamState.DONE;
      }
    },
    onWatchdogTimeout({ state: s, elapsed }) {
      console.warn(`[Stream] Watchdog timeout in ${s} after ${elapsed}ms`);
      showToast(`Stream stalled in ${s} state — retrying…`, 'error');
    },
    onDeadlock({ sinceLastActivity }) {
      console.warn(`[Stream] Possible deadlock — no activity for ${sinceLastActivity}ms`);
    },
  });
}

/**
 * Get the current stream state machine for external inspection.
 */
export function getStreamState() {
  return _streamSM ? { state: _streamSM.state, tokenCount: _streamSM.tokenCount, isActive: _streamSM.isActive } : null;
}

function estimateContextUsage(messages) {
  const systemPromptTokens = state.settings.systemPrompt ? estimateTokens(state.settings.systemPrompt) : 0;
  const messageTokens = messages.reduce((total, msg) => {
    const content = normalizeContent(msg.content);
    return total + estimateTokens(content) + 4;
  }, 0);
  return systemPromptTokens + messageTokens;
}

/**
 * Build a structured compact summary organized by category:
 * facts, decisions, tasks, constraints, questions.
 */
function buildCompactSummary(messages) {
  const categories = { facts: [], decisions: [], tasks: [], constraints: [], questions: [], context: [] };

  for (const msg of messages) {
    const content = normalizeContent(msg.content).replace(/\s+/g, ' ').trim();
    if (!content) continue;
    const role = msg.role === 'user' ? 'User' : (msg.role === 'assistant' ? 'Assistant' : 'System');
    const snippet = content.slice(0, 250);

    // Simple heuristic categorization
    const lower = content.toLowerCase();
    if (lower.includes('must') || lower.includes('require') || lower.includes('constraint') || lower.includes('always') || lower.includes('never')) {
      categories.constraints.push(`- ${role}: ${snippet}`);
    } else if (lower.includes('decide') || lower.includes('chose') || lower.includes('agreed') || lower.includes('let\'s go with') || lower.includes('we\'ll use')) {
      categories.decisions.push(`- ${role}: ${snippet}`);
    } else if (lower.includes('todo') || lower.includes('task') || lower.includes('implement') || lower.includes('create') || lower.includes('build') || lower.includes('fix')) {
      categories.tasks.push(`- ${role}: ${snippet}`);
    } else if (content.includes('?') || lower.includes('how') || lower.includes('what') || lower.includes('why')) {
      categories.questions.push(`- ${role}: ${snippet}`);
    } else if (msg.role === 'assistant' && content.length > 100) {
      categories.facts.push(`- ${snippet}`);
    } else {
      categories.context.push(`- ${role}: ${snippet}`);
    }
  }

  // Cap each category
  const MAX_PER_CAT = 6;
  const sections = [];
  if (categories.constraints.length) sections.push(`**Constraints:**\n${categories.constraints.slice(0, MAX_PER_CAT).join('\n')}`);
  if (categories.decisions.length) sections.push(`**Decisions:**\n${categories.decisions.slice(0, MAX_PER_CAT).join('\n')}`);
  if (categories.tasks.length) sections.push(`**Tasks:**\n${categories.tasks.slice(0, MAX_PER_CAT).join('\n')}`);
  if (categories.facts.length) sections.push(`**Key Facts:**\n${categories.facts.slice(0, MAX_PER_CAT).join('\n')}`);
  if (categories.questions.length) sections.push(`**Open Questions:**\n${categories.questions.slice(0, MAX_PER_CAT).join('\n')}`);
  if (categories.context.length && sections.length < 3) sections.push(`**Context:**\n${categories.context.slice(0, MAX_PER_CAT).join('\n')}`);

  if (sections.length === 0) {
    return 'Previous conversation was compacted. No textual content was available in older turns.';
  }

  return `Structured conversation memory (${messages.length} messages compacted):\n\n${sections.join('\n\n')}`;
}

function renderMessagesFromState() {
  messagesEl.innerHTML = '';
  for (const msg of state.messages) {
    messagesEl.appendChild(createMessageEl(msg.role, msg.content, msg.stats, msg.images, msg));
  }
  scrollToBottom();
}

function compactConversationIfNeeded() {
  if (state.settings.autoCompactEnabled === false) return false;
  const maxContext = Number(state.settings.maxContext) || 65536;
  const used = estimateContextUsage(state.messages);
  if (used < Math.floor(maxContext * CONTEXT_COMPACT_THRESHOLD)) return false;
  if (state.messages.length < MIN_MESSAGES_FOR_COMPACTION) return false;

  const splitIndex = Math.max(2, state.messages.length - PRESERVE_RECENT_MESSAGES);
  const olderMessages = state.messages.slice(0, splitIndex);
  const recentMessages = state.messages.slice(splitIndex);
  if (olderMessages.length === 0 || recentMessages.length === 0) return false;

  // Pin protection — preserve pinned messages from compaction
  const pinnedFromOlder = olderMessages.filter(m => m.pinned);
  const compactableOlder = olderMessages.filter(m => !m.pinned);

  const summaryMessage = {
    role: 'system',
    content: `[Compacted Memory]\n${buildCompactSummary(compactableOlder)}\n[/Compacted Memory]`,
    timestamp: Date.now(),
    compacted: true,
    compactedCount: compactableOlder.length,
  };

  state.messages = [summaryMessage, ...pinnedFromOlder, ...recentMessages];
  renderMessagesFromState();
  const pinnedNote = pinnedFromOlder.length > 0 ? ` (${pinnedFromOlder.length} pinned preserved)` : '';
  showToast(`Context compacted: ${compactableOlder.length} messages summarized${pinnedNote}.`);
  return true;
}

/**
 * Get a preview of what compaction would produce (for UI display).
 */
export function getCompactionPreview() {
  const maxContext = Number(state.settings.maxContext) || 65536;
  const used = estimateContextUsage(state.messages);
  const threshold = Math.floor(maxContext * CONTEXT_COMPACT_THRESHOLD);
  const splitIndex = Math.max(2, state.messages.length - PRESERVE_RECENT_MESSAGES);
  const olderMessages = state.messages.slice(0, splitIndex);
  const pinnedCount = olderMessages.filter(m => m.pinned).length;
  const compactableCount = olderMessages.length - pinnedCount;

  return {
    totalMessages: state.messages.length,
    usedTokens: used,
    maxTokens: maxContext,
    percentage: maxContext > 0 ? Math.round((used / maxContext) * 100) : 0,
    threshold: Math.round(CONTEXT_COMPACT_THRESHOLD * 100),
    wouldCompact: used >= threshold && state.messages.length >= MIN_MESSAGES_FOR_COMPACTION,
    compactableCount,
    pinnedCount,
    preserveCount: PRESERVE_RECENT_MESSAGES,
  };
}

// ── Persistence ────────────────────────────────────────────────

export function persistCurrentConversation() {
  const firstUserMsg = state.messages.find((m) => m.role === 'user');
  const titleSeed = extractTitleSource(firstUserMsg?.displayContent || firstUserMsg?.content) || 'Chat';

  if (!state.conversationId) {
    const conv = createStoredConversation(generateTitleFallback(titleSeed || 'New Chat'));
    state.conversationId = conv.id;
    setActiveConversationId(conv.id);
  }
  const conv = {
    id: state.conversationId,
    title: generateTitleFallback(titleSeed || 'Chat'),
    messages: state.messages,
    updatedAt: Date.now(),
    mode: state.mode,
    folder: state.folder || '',
    settings: state.settings,
  };
  autoSave(conv);
  _refreshSidebar?.();
}

export async function loadConversationById(id) {
  if (state.isStreaming) return;
  const conv = await loadConversation(id);
  if (!conv) return;

  const { applySettingsToUi } = await import('./uiUpdaters.js');

  state.conversationId = conv.id;
  state.messages = conv.messages || [];
  state.folder = conv.folder || '';
  state.settings = { ...state.settings, ...(conv.settings || {}) };
  setActiveConversationId(id);
  applySettingsToUi();

  messagesEl.innerHTML = '';
  if (state.messages.length > 0) {
    welcomeEl.classList.add('hidden');
    state.messages.forEach((msg) => {
      messagesEl.appendChild(createMessageEl(msg.role, msg.content, msg.stats, msg.images, msg));
    });
    scrollToBottom();
  } else {
    welcomeEl.classList.remove('hidden');
  }

  updateContextBar();
  updateTokenInfo();
  _refreshSidebar?.();
}

export function startNewConversation() {
  if (state.isStreaming) {
    showToast('A response is still generating. Showing the ongoing chat.');
    scrollToBottom();
    return;
  }
  state.messages = [];
  state.conversationId = null;
  state.folder = '';
  messagesEl.innerHTML = '';
  welcomeEl.classList.remove('hidden');
  userInput.value = '';
  updateContextBar();
  updateTokenInfo();
  _refreshSidebar?.();
}

// ── Send Message ───────────────────────────────────────────────

export async function sendMessage(userText) {
  if (state.isStreaming || !userText.trim()) return;

  const trimmed = userText.trim();
  if (trimmed.startsWith('/')) {
    const cmdResult = executeCommand(trimmed);
    if (cmdResult) {
      const { hideCommandAutocomplete } = await import('./searchManager.js');
      hideCommandAutocomplete();
      userInput.value = '';
      autoResize(userInput);
      updateSendButton();
      if (cmdResult.type === 'system') {
        welcomeEl.classList.add('hidden');
        messagesEl.appendChild(createMessageEl('assistant', cmdResult.content));
        scrollToBottom();
      } else if (cmdResult.type === 'action') {
        if (cmdResult.action === 'clear') startNewConversation();
        if (cmdResult.action === 'stats') {
          const stats = getSessionStats();
          const activeModel = resolveModeModel(state.mode, state.settings.model);
          const modeLabel = activeModel ? `${state.mode} (${activeModel})` : state.mode;
          const content = `**Session Statistics:**\n- Messages: ${state.messages.length}\n- Total tokens: ${formatTokenCount(stats.totalTokens)}\n- Mode: ${modeLabel}`;
          welcomeEl.classList.add('hidden');
          messagesEl.appendChild(createMessageEl('assistant', content));
          scrollToBottom();
        }
        if (cmdResult.action === 'switch-mode') {
          modeSelect.value = cmdResult.data;
          modeSelect.dispatchEvent(new Event('change'));
        }
      }
      return;
    }
  }

  state.isStreaming = true;
  welcomeEl.classList.add('hidden');

  userInput.value = '';
  autoResize(userInput);
  updateSendButton();

  if (inputPreview) {
    inputPreview.hidden = true;
    inputPreview.innerHTML = '';
  }

  let fullContent = userText;
  let imageDataUrls = [];
  if (state.attachedFiles.length > 0) {
    const fileTexts = await Promise.all(
      state.attachedFiles.map(async (file) => {
        if (file.type.startsWith('image/')) {
          const dataUrl = await readFileAsDataURL(file);
          imageDataUrls.push({ name: file.name, dataUrl });
          return `[Attached image: ${file.name}]`;
        }
        try {
          const text = await file.text();
          return `--- ${file.name} ---\n${text}`;
        } catch {
          return `[Attached file: ${file.name}]`;
        }
      })
    );
    fullContent = userText + '\n\n' + fileTexts.join('\n\n');
    state.attachedFiles = [];
    _renderAttachedFiles?.();
  }

  const userMsg = { role: 'user', content: fullContent, displayContent: userText, timestamp: Date.now(), images: imageDataUrls };
  state.messages.push(userMsg);
  messagesEl.appendChild(createMessageEl('user', userText, null, imageDataUrls));
  scrollToBottom();

  if (state.messages.filter((m) => m.role === 'user').length === 1) {
    const title = await generateTitle(userText, {
      apiEndpoint: state.settings.apiEndpoint,
      mode: state.mode,
      enableThinking: state.settings.enableThinking,
      selectedModel: state.settings.model,
    });
    const conv = getActiveConversation();
    if (conv) conv.title = title;
    state._pendingAutoTitle = userText;
  }

  compactConversationIfNeeded();

  updateContextBar();
  await sendToAPI();
}

// ── Streaming API ──────────────────────────────────────────────

export async function sendToAPI() {
  state.isStreaming = true;
  state.abortController = new AbortController();
  _connMgr?.setState('streaming');
  _streamSM?.reset();
  _streamSM?.transition(StreamState.QUEUED);
  sendBtn.disabled = true;
  stopBtn.hidden = false;

  const streamEl = addStreamingIndicator();
  const contentEl = streamEl.querySelector('.message-content');
  const liveStatsEl = streamEl.querySelector('.live-stats');

  const apiMessages = [];
  if (state.settings.systemPrompt) {
    const now = new Date();
    const locale = state.settings.language === 'auto' ? (navigator.language || 'en-US') : state.settings.language;
    const tz = state.settings.timezone === 'auto' ? Intl.DateTimeFormat().resolvedOptions().timeZone : state.settings.timezone;
    const datetime = now.toLocaleString(locale, {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      timeZone: tz, timeZoneName: 'long',
    });
    apiMessages.push({ role: 'system', content: `${state.settings.systemPrompt}\n\nCurrent date and time: ${datetime}\nTimezone: ${tz}\nUser language: ${locale}` });
  }
  apiMessages.push(...state.messages.slice(-20).map((m) => ({ role: m.role, content: m.content })));

  const startTime = performance.now();
  let fullContent = '';
  let reasoningContent = '';
  let tokenCount = 0;

  const statsInterval = setInterval(() => {
    const elapsed = (performance.now() - startTime) / 1000;
    const tps = tokenCount > 0 ? (tokenCount / elapsed).toFixed(1) : '0';
    if (liveStatsEl) liveStatsEl.textContent = `${tokenCount} tokens • ${tps} t/s`;
  }, 500);

  try {
    const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProto}//${location.host}/manager/ws/chat`;

    function renderStream(showCursor = true) {
      const streamedContent = reasoningContent
        ? `<think>${reasoningContent}</think>\n\n${fullContent}`
        : fullContent;
      const { thinking, content: mainContent } = stripThinking(streamedContent);
      let html = '';
      if (thinking && state.settings.showThinking) html += renderThinkingBlock(streamedContent);
      html += renderMarkdown(mainContent || fullContent);
      if (showCursor) html += '<span class="stream-cursor"></span>';
      contentEl.innerHTML = html;
      scrollToBottom();
    }

    const requestPayload = buildModeRequestPayload(state.mode, {
      messages: apiMessages,
      max_tokens: state.settings.maxTokens,
      temperature: state.settings.temperature,
      chat_template_kwargs: { enable_thinking: state.settings.enableThinking },
    }, {
      enableThinking: state.settings.enableThinking,
      selectedModel: state.settings.model,
    });

    let useSSE = false;
    try {
      await new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        let pendingRender = 0;
        let settled = false;
        let aborted = false;

        const scheduleRender = () => {
          if (pendingRender) return;
          pendingRender = requestAnimationFrame(() => { pendingRender = 0; renderStream(true); });
        };
        const cleanup = () => {
          state.abortController?.signal.removeEventListener('abort', onAbort);
          if (pendingRender) { cancelAnimationFrame(pendingRender); pendingRender = 0; }
        };
        const resolveOnce = () => { if (settled) return; settled = true; cleanup(); resolve(); };
        const rejectOnce = (e) => { if (settled) return; settled = true; cleanup(); reject(e); };

        const onAbort = () => {
          aborted = true;
          if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.close(1000, 'cancelled');
          rejectOnce(new DOMException('The operation was aborted.', 'AbortError'));
        };
        state.abortController.signal.addEventListener('abort', onAbort);

        ws.onopen = () => ws.send(JSON.stringify(requestPayload));

        ws.onmessage = (event) => {
          if (aborted || settled) return;
          let msg;
          try { msg = JSON.parse(event.data); } catch { return; }
          if (msg.type === 'queued') {
            const queuePos = getQueuePosition(msg.position);
            _streamSM?.transition(StreamState.QUEUED, queuePos);
            contentEl.innerHTML = queuePos
              ? `<div class="queue-status"><span class="queue-icon">⏳</span><span class="queue-label">Queued</span><span class="queue-badge">#${queuePos}</span></div>`
              : `<div class="queue-status"><span class="queue-icon">⏳</span><span class="queue-label">Queued</span></div>`;
          } else if (msg.type === 'delta' && msg.delta) {
            if (_streamSM?.state !== StreamState.STREAMING) _streamSM?.transition(StreamState.STREAMING);
            if (msg.channel === 'reasoning') reasoningContent += msg.delta;
            else fullContent += msg.delta;
            tokenCount++;
            _streamSM?.recordToken();
            scheduleRender();
          } else if (msg.type === 'done') {
            _streamSM?.transition(StreamState.FINALIZING);
            renderStream(false); resolveOnce(); ws.close(1000, 'complete');
          } else if (msg.type === 'error') {
            _streamSM?.transition(StreamState.ERROR, new Error(msg.message || 'WebSocket stream failed.'));
            rejectOnce(new Error(msg.message || 'WebSocket stream failed.')); ws.close(1011, 'error');
          }
        };

        ws.onclose = (event) => {
          if (settled) return;
          if (aborted) { rejectOnce(new DOMException('The operation was aborted.', 'AbortError')); return; }
          if (fullContent) {
            if (event.code !== 1000) fullContent += '\n\n⚠️ *Response may be truncated (connection closed unexpectedly).*';
            renderStream(false); resolveOnce(); return;
          }
          rejectOnce(new Error(event.reason || 'WebSocket connection closed unexpectedly.'));
        };

        ws.onerror = () => { if (!settled && !aborted) rejectOnce(new Error('WebSocket connection failed.')); };
      });
    } catch (wsErr) {
      if (wsErr.name !== 'AbortError' && !fullContent) useSSE = true;
      else throw wsErr;
    }

    if (useSSE) {
      const sseResponse = await fetch('/manager/chat/sse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestPayload),
        signal: state.abortController.signal,
      });
      if (!sseResponse.ok) {
        throw new Error(await sseResponse.text().catch(() => 'SSE request failed'));
      }
      const reader = sseResponse.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = '';
      let pendingRender = 0;
      const scheduleRender = () => {
        if (pendingRender) return;
        pendingRender = requestAnimationFrame(() => { pendingRender = 0; renderStream(true); });
      };
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          sseBuffer += decoder.decode(value, { stream: true });
          const lines = sseBuffer.split('\n');
          sseBuffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (!data) continue;
            let msg;
            try { msg = JSON.parse(data); } catch { continue; }
            if (msg.type === 'queued') {
              const queuePos = getQueuePosition(msg.position);
              _streamSM?.transition(StreamState.QUEUED, queuePos);
              contentEl.innerHTML = queuePos
                ? `<div class="queue-status"><span class="queue-icon">⏳</span><span class="queue-label">Queued</span><span class="queue-badge">#${queuePos}</span></div>`
                : `<div class="queue-status"><span class="queue-icon">⏳</span><span class="queue-label">Queued</span></div>`;
            } else if (msg.type === 'delta' && msg.delta) {
              if (_streamSM?.state !== StreamState.STREAMING) _streamSM?.transition(StreamState.STREAMING);
              if (msg.channel === 'reasoning') reasoningContent += msg.delta;
              else fullContent += msg.delta;
              tokenCount++;
              _streamSM?.recordToken();
              scheduleRender();
            } else if (msg.type === 'done') {
              _streamSM?.transition(StreamState.FINALIZING);
              renderStream(false); break;
            } else if (msg.type === 'error') {
              _streamSM?.transition(StreamState.ERROR, new Error(msg.message || 'SSE stream failed.'));
              throw new Error(msg.message || 'SSE stream failed.');
            }
          }
        }
      } finally {
        if (pendingRender) cancelAnimationFrame(pendingRender);
        reader.releaseLock();
      }
      if (!fullContent) renderStream(false);
    }

    const elapsed = (performance.now() - startTime) / 1000;
    const tps = tokenCount > 0 ? (tokenCount / elapsed).toFixed(1) : '?';
    streamEl.classList.remove('streaming');
    streamEl.id = '';

    const activeModel = resolveModeModel(state.mode, state.settings.model);
    const statsHtml = activeModel
      ? `${tokenCount} tokens • ${elapsed.toFixed(2)}s • ${tps} t/s • ${state.mode} • ${activeModel}`
      : `${tokenCount} tokens • ${elapsed.toFixed(2)}s • ${tps} t/s • ${state.mode}`;
    const msgBody = streamEl.querySelector('.message-body');
    const actionsEl = document.createElement('div');
    actionsEl.className = 'message-actions';
    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-msg-btn';
    copyBtn.title = 'Copy message';
    copyBtn.textContent = '📋 Copy';
    copyBtn.addEventListener('click', async () => {
      const contentEl = streamEl.querySelector('.message-content');
      const text = contentEl?.innerText || contentEl?.textContent || '';
      try {
        await navigator.clipboard.writeText(text);
        copyBtn.textContent = '✅';
        setTimeout(() => { copyBtn.textContent = '📋 Copy'; }, 2000);
      } catch {
        copyBtn.textContent = '❌';
        setTimeout(() => { copyBtn.textContent = '📋 Copy'; }, 2000);
      }
    });
    actionsEl.appendChild(copyBtn);
    msgBody.appendChild(actionsEl);
    const statsEl = document.createElement('div');
    statsEl.className = 'message-stats';
    statsEl.textContent = statsHtml;
    msgBody.appendChild(statsEl);

    const metaEl = streamEl.querySelector('.message-meta');
    if (metaEl && !metaEl.querySelector('.regen-btn')) {
      const btn = document.createElement('button');
      btn.className = 'regen-btn'; btn.title = 'Regenerate'; btn.textContent = 'Redo';
      btn.addEventListener('click', () => regenerateLastResponse());
      metaEl.appendChild(btn);
    }
    if (metaEl && !metaEl.querySelector('.pin-msg-btn')) {
      const pinBtn = document.createElement('button');
      pinBtn.className = 'pin-msg-btn'; pinBtn.title = 'Pin message'; pinBtn.textContent = '📌';
      pinBtn.addEventListener('click', () => {
        streamEl.classList.toggle('pinned');
        pinBtn.classList.toggle('active');
        const msgRef = streamEl._msgRef;
        if (msgRef) msgRef.pinned = streamEl.classList.contains('pinned');
      });
      metaEl.appendChild(pinBtn);
    }
    if (metaEl && !metaEl.querySelector('.reaction-btn')) {
      ['up', 'down'].forEach((reaction) => {
        const btn = document.createElement('button');
        btn.className = 'reaction-btn'; btn.dataset.reaction = reaction;
        btn.title = reaction === 'up' ? 'Good response' : 'Poor response';
        btn.textContent = reaction === 'up' ? '👍' : '👎';
        btn.addEventListener('click', () => {
          const isActive = btn.classList.contains('active');
          streamEl.querySelectorAll('.reaction-btn').forEach((b) => b.classList.remove('active'));
          const msgRef = streamEl._msgRef;
          if (!isActive) { btn.classList.add('active'); if (msgRef) msgRef.reaction = reaction; }
          else { if (msgRef) delete msgRef.reaction; }
        });
        metaEl.appendChild(btn);
      });
    }

    const newMsg = { role: 'assistant', content: fullContent, timestamp: Date.now(), stats: statsHtml };
    streamEl._msgRef = newMsg;
    if (state._pendingBranches) {
      newMsg.branches = [...state._pendingBranches, { content: fullContent, stats: statsHtml, timestamp: Date.now() }];
      newMsg.activeBranch = newMsg.branches.length - 1;
      state._pendingBranches = null;
      addBranchNavToEl(streamEl, newMsg);
    }
    state.messages.push(newMsg);
    const promptTokensEst = estimateTokens(apiMessages.map((m) => normalizeContent(m.content)).join(''));
    updateSessionStats({ prompt_tokens: promptTokensEst, completion_tokens: tokenCount });
    recordUsage(promptTokensEst, tokenCount, state.mode);

  } catch (err) {
    streamEl.classList.remove('streaming');
    streamEl.id = '';
    if (err.name === 'AbortError') {
      contentEl.innerHTML = '<em class="text-muted">Generation stopped.</em>';
      if (fullContent) state.messages.push({ role: 'assistant', content: fullContent, timestamp: Date.now() });
    } else {
      const errCat = categorizeError(err);
      contentEl.innerHTML = `<span class="error-msg">Error: ${escapeHtml(errCat.message)}</span>`;
      if (errCat.retryable) {
        const retryBtn = document.createElement('button');
        retryBtn.className = 'retry-btn'; retryBtn.textContent = 'Retry';
        retryBtn.addEventListener('click', () => { if (!state.isStreaming) { messagesEl.removeChild(streamEl); sendToAPI(); } });
        contentEl.appendChild(retryBtn);
      }
    }
  } finally {
    clearInterval(statsInterval);
    if (liveStatsEl) liveStatsEl.remove();
    // Finalize stream state machine
    if (_streamSM?.state === StreamState.FINALIZING) _streamSM.transition(StreamState.DONE);
    else if (_streamSM?.isActive) _streamSM.transition(StreamState.DONE);
    if (_streamSM?.state === StreamState.DONE || _streamSM?.state === StreamState.ERROR) _streamSM.transition(StreamState.IDLE);
    state.isStreaming = false;
    state.abortController = null;
    _connMgr?.setState('connected');
    sendBtn.disabled = false;
    stopBtn.hidden = true;
    updateSendButton();
    updateContextBar();
    updateTokenInfo();
    persistCurrentConversation();
    userInput.focus();

    if (state._pendingAutoTitle) {
      const msgText = state._pendingAutoTitle;
      const titleConvId = state.conversationId;
      state._pendingAutoTitle = null;
      generateTitleViaLLM(msgText).then((llmTitle) => {
        // Guard: only apply title if user hasn't switched conversations
        if (llmTitle && state.conversationId === titleConvId) {
          const conv = getActiveConversation();
          if (conv) conv.title = llmTitle;
          persistCurrentConversation();
          _refreshSidebar?.();
        }
      }).catch(() => { /* title generation is best-effort */ });
    }
  }
}
