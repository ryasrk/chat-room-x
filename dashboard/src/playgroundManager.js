/**
 * Playground Manager — isolated prompt playground with history.
 */

import { renderMarkdown, renderThinkingBlock, stripThinking } from './markdownRenderer.js';
import { state } from './appState.js';
import { buildModeRequestPayload } from './providerConfig.js';
import { escapeHtml } from './utils.js';

const $ = (sel) => document.querySelector(sel);
const viewChat = $('#view-chat');
const viewPlayground = $('#view-playground');
const navTabs = document.querySelectorAll('.nav-tab');
const playgroundPrompt = $('#playground-prompt');
const playgroundRun = $('#playground-run');
const playgroundOutput = $('#playground-output');
const playgroundClear = $('#playground-clear');
const playgroundHistory = $('#playground-history');
const pgTemp = $('#pg-temp');
const pgTempVal = $('#pg-temp-val');
const pgMaxTokens = $('#pg-max-tokens');

// ── View Switcher ──────────────────────────────────────────────

export function switchView(viewName) {
  const views = { chat: viewChat, playground: viewPlayground };
  for (const [name, el] of Object.entries(views)) {
    if (el) el.hidden = name !== viewName;
  }
  navTabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.view === viewName));
}

navTabs.forEach((tab) => tab.addEventListener('click', () => switchView(tab.dataset.view)));

// ── Playground ─────────────────────────────────────────────────

let playgroundHistoryData = [];

if (pgTemp) pgTemp.addEventListener('input', () => { if (pgTempVal) pgTempVal.textContent = pgTemp.value; });
if (playgroundRun) playgroundRun.addEventListener('click', runPlayground);
if (playgroundClear) playgroundClear.addEventListener('click', () => { playgroundHistoryData = []; renderPlaygroundHistory(); });

async function runPlayground() {
  if (!playgroundPrompt || !playgroundOutput || !playgroundRun) return;
  const prompt = playgroundPrompt.value.trim();
  if (!prompt) return;

  playgroundRun.disabled = true;
  playgroundRun.innerHTML = '<span class="pg-run-icon">⏳</span> Running...';
  playgroundOutput.innerHTML = '<div class="thinking-dots"><span></span><span></span><span></span></div>';

  try {
    const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProto}//${location.host}/manager/ws/chat`;

    const requestPayload = buildModeRequestPayload(state.mode, {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: parseInt(pgMaxTokens?.value) || 256,
      temperature: parseFloat(pgTemp?.value) || 0.7,
    }, {
      enableThinking: state.settings.enableThinking,
      selectedModel: state.settings.model,
    });

    let fullContent = '';
    let reasoningContent = '';
    const renderOutput = () => {
      const streamedContent = reasoningContent
        ? `<think>${reasoningContent}</think>\n\n${fullContent}`
        : fullContent;
      const { thinking, content } = stripThinking(streamedContent);
      let html = '';
      if (thinking) html += renderThinkingBlock(streamedContent);
      html += renderMarkdown(content || fullContent);
      playgroundOutput.innerHTML = html;
    };
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      let settled = false;

      ws.onopen = () => ws.send(JSON.stringify(requestPayload));

      ws.onmessage = (event) => {
        if (settled) return;
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        if (msg.type === 'queued' && Number.isFinite(msg.position)) {
          playgroundOutput.innerHTML = `<div class="thinking-dots"><span></span><span></span><span></span></div> <em class="text-muted">Queued (position ${msg.position})</em>`;
        } else if (msg.type === 'delta' && msg.delta) {
          if (msg.channel === 'reasoning') reasoningContent += msg.delta;
          else fullContent += msg.delta;
          renderOutput();
        } else if (msg.type === 'done') {
          settled = true; ws.close(1000, 'complete'); resolve();
        } else if (msg.type === 'error') {
          reject(new Error(msg.message || 'WebSocket stream failed.')); ws.close(1011, 'error');
        }
      };

      ws.onclose = (event) => {
        if (settled) return;
        if (fullContent) { settled = true; resolve(); }
        else reject(new Error(event.reason || 'WebSocket connection closed unexpectedly.'));
      };

      ws.onerror = () => { if (!settled) reject(new Error('WebSocket connection failed.')); };
    });

    renderOutput();
    playgroundHistoryData.unshift({
      prompt, output: fullContent,
      temp: pgTemp?.value ?? '0.7',
      maxTokens: pgMaxTokens?.value ?? '256',
      timestamp: Date.now(),
    });
    if (playgroundHistoryData.length > 10) playgroundHistoryData.pop();
    renderPlaygroundHistory();
  } catch (err) {
    playgroundOutput.innerHTML = `<p class="text-danger">Error: ${err.message}</p>`;
  } finally {
    playgroundRun.disabled = false;
    playgroundRun.innerHTML = '<span class="pg-run-icon">▶</span> Run <kbd class="pg-kbd">Ctrl+Enter</kbd>';
  }
}

function renderPlaygroundHistory() {
  if (!playgroundHistory) return;
  playgroundHistory.innerHTML = '';
  if (playgroundHistoryData.length === 0) {
    playgroundHistory.innerHTML = '<em class="text-muted">No history yet</em>';
    return;
  }
  playgroundHistoryData.forEach((item) => {
    const div = document.createElement('div');
    div.className = 'playground-history-item';
    div.innerHTML = `
      <div class="history-prompt">${escapeHtml(item.prompt.substring(0, 50))}${item.prompt.length > 50 ? '...' : ''}</div>
      <div class="history-meta">Temp: ${item.temp} • Max: ${item.maxTokens}</div>
    `;
    div.addEventListener('click', () => {
      if (playgroundPrompt) playgroundPrompt.value = item.prompt;
      if (pgTemp) { pgTemp.value = item.temp; if (pgTempVal) pgTempVal.textContent = item.temp; }
      if (pgMaxTokens) pgMaxTokens.value = item.maxTokens;
      if (playgroundOutput) playgroundOutput.innerHTML = renderMarkdown(item.output);
    });
    playgroundHistory.appendChild(div);
  });
}
