/**
 * Tenrary-X Chat Dashboard — Main coordinator
 * Wires modules together and registers top-level event listeners.
 */

// ── Module Imports ─────────────────────────────────────────────
import { state } from './appState.js';
import { isMobileViewport, autoResize } from './utils.js';
import {
  updateContextBar, updateTokenInfo, updateSendButton, updateReasoningControls,
  updateLocalePreview, populateTimezones, populatePromptTemplates, syncPromptTemplate,
  applySettingsToUi,
} from './uiUpdaters.js';
import {
  activeModal, openModal, closeModal, syncPlusMenuState, closePlusMenu,
  syncSidebarBackdrop, closeSidebar, handleModalTabTrap,
} from './modalManager.js';
import { sendMessage, loadConversationById, startNewConversation, initChatApi } from './chatApi.js';
import { regenerateLastResponse } from './messageRenderer.js';
import { refreshSidebar, initSidebarManager } from './sidebarManager.js';
import { exportChat, checkShareUrl, processImportShare, initExportManager } from './exportManager.js';
import { renderAttachedFiles, handleFileAttach } from './fileManager.js';
import {
  initSearchManager, showCommandAutocomplete, hideCommandAutocomplete,
  navigateAutocomplete, selectAutocompleteItem, openMsgSearch, closeMsgSearch,
} from './searchManager.js';
import { ConnectionManager } from './connectionManager.js';
import { initShortcuts, getShortcutsList } from './keyboardShortcuts.js';
import { listConversations, getActiveConversationId } from './chatStorage.js';
import { searchConversations, renderConversationList } from './conversationManager.js';
import { formatTokenCount, getAnalyticsSummary } from './tokenCounter.js';
import { resolveModeModel } from './providerConfig.js';
import { fetchEnowxProviderModels, pickPreferredProviderModel } from './providerModels.js';
import { showToast } from './utils.js';
import { persistDraft, loadDraft, clearDraft, persistSessionState, loadSessionState, showRecoveryBanner, clearSessionState, loadAgentRoomState, clearAgentRoomState } from './sessionRecovery.js';
import { renderObservabilityCards, recordLatency, recordError } from './observabilityPanel.js';

// Side-effect imports — register their own DOM event listeners on load
import './playgroundManager.js';
import { preloadRenderingLibs } from './lazyLibs.js';

// ── Auth & Rooms ───────────────────────────────────────────
import { initAuthUI, showAuthModal, onLoginSuccess } from './authUI.js';
import { isAuthenticated, getCurrentUser } from './authClient.js';
import { createRoomsView, initRoomsUI, refreshRoomsList, cleanupRooms, openRoomChat, openAgentRoomChat, closeRoomChat } from './roomsUI.js';

// ── DOM Refs ───────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const statusIndicator = $('#status-indicator');
const userInput = $('#user-input');
const sendBtn = $('#send-btn');
const stopBtn = $('#stop-btn');
const modeSelect = $('#mode-select');
const modeBadge = $('#mode-badge');
const settingsBtn = $('#settings-btn');
const settingsModal = $('#settings-modal');
const settingsClose = $('#settings-close');
const shortcutsBtn = $('#shortcuts-btn');
const shortcutsModal = $('#shortcuts-modal');
const shortcutsClose = $('#shortcuts-close');
const shortcutsList = $('#shortcuts-list');
const exportBtn = $('#export-btn');
const exportModal = $('#export-modal');
const exportClose = $('#export-close');
const analyticsBtn = $('#analytics-btn');
const analyticsModal = $('#analytics-modal');
const analyticsClose = $('#analytics-close');
const analyticsContent = $('#analytics-content');
const themeToggle = $('#theme-toggle');
const voiceBtn = $('#voice-btn');
const sidebar = $('#sidebar');
const sidebarBackdrop = $('#sidebar-backdrop');
const sidebarToggle = $('#sidebar-toggle');
const newChatBtn = $('#new-chat-btn');
const searchInput = $('#search-conversations');
const conversationListEl = $('#conversation-list');
const tempSlider = $('#temp-slider');
const tempValue = $('#temp-value');
const enableThinkingInput = $('#enable-thinking');
const maxTokensInput = $('#max-tokens');
const ctxWindowInput = $('#ctx-window');
const autoCompactInput = $('#auto-compact');
const systemPromptInput = $('#system-prompt');
const showThinkingInput = $('#show-thinking');
const apiEndpointInput = $('#api-endpoint');
const providerModelInput = $('#provider-model');
const userLanguageSelect = $('#user-language');
const userTimezoneSelect = $('#user-timezone');
const restartGatewayBtn = $('#restart-gateway-btn');
const plusBtn = $('#plus-btn');
const plusMenu = $('#plus-menu');
const reasoningToggleBtn = $('#reasoning-toggle-btn');
const fileUploadDoc = $('#file-upload-doc');
const fileUploadImg = $('#file-upload-img');

// ── Connection Manager ─────────────────────────────────────────
const connMgr = new ConnectionManager();
connMgr.onStateChange((newState) => {
  const labels = {
    connected: '● Connected',
    disconnected: '● Disconnected',
    reconnecting: '● Reconnecting...',
    streaming: '● Generating...',
  };
  const classes = { connected: 'online', disconnected: 'offline', reconnecting: 'offline', streaming: 'streaming' };
  statusIndicator.className = `status ${classes[newState] || 'offline'}`;
  statusIndicator.textContent = labels[newState] || '● Unknown';
});
connMgr.startHealthPolling('/manager/health', 10000);

// ── Module Init (inject cross-module dependencies) ─────────────
initChatApi({ connMgr, renderAttachedFiles, refreshSidebar });
initSidebarManager({ loadConversationById, startNewConversation, processImportShare });
initExportManager({ loadConversationById });
initSearchManager({ sendMessage, updateSendButton });

async function showEnowxModelList() {
  try {
    const models = await fetchEnowxProviderModels();

    if (models.length === 0) {
      showToast('EnowxAI mode enabled, but no models were returned.', 'error');
      return;
    }

    if (providerModelInput) {
      const previousValue = state.settings.model || providerModelInput.value || '';
      providerModelInput.innerHTML = '<option value="">Auto / Default</option>';

      models.forEach((model) => {
        const option = document.createElement('option');
        option.value = model;
        option.textContent = model;
        providerModelInput.appendChild(option);
      });

      const defaultModel = resolveModeModel('enowxai', '');
      const nextValue = pickPreferredProviderModel({
        models,
        previousValue,
        defaultModel,
      });
      state.settings.model = nextValue;
      providerModelInput.value = nextValue;
    }

    showToast(`Loaded ${models.length} EnowxAI models into Provider Model settings.`, 'success');
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'Failed to load enowxai models.', 'error');
  }
}

// ── Mode Select ────────────────────────────────────────────────
modeSelect.addEventListener('change', async () => {
  const newMode = modeSelect.value;
  modeBadge.textContent = newMode;
  connMgr.setState('reconnecting');
  try {
    const res = await fetch(`/manager/switch?mode=${newMode}`, { method: 'POST', signal: AbortSignal.timeout(35000) });
    const data = await res.json();
    if (data.status === 'ok') {
      state.mode = newMode;
      state.settings.apiEndpoint = '/v1/chat/completions';
      connMgr.setState('connected');
      if (newMode === 'enowxai') {
        await showEnowxModelList();
      }
    } else {
      connMgr.setState('disconnected');
    }
  } catch {
    state.mode = newMode;
    state.settings.apiEndpoint = '/v1/chat/completions';
    connMgr.setState('disconnected');
  }
});

// ── Sidebar ────────────────────────────────────────────────────
sidebarToggle.addEventListener('click', () => {
  sidebar.classList.toggle('collapsed');
  syncSidebarBackdrop();
});
sidebarBackdrop.addEventListener('click', () => closeSidebar());
newChatBtn.addEventListener('click', startNewConversation);

let _searchDebounce = null;
searchInput.addEventListener('input', () => {
  clearTimeout(_searchDebounce);
  _searchDebounce = setTimeout(async () => {
    const convs = await listConversations();
    const filtered = searchInput.value ? searchConversations(searchInput.value, convs) : convs;
    conversationListEl.innerHTML = renderConversationList(filtered, state.conversationId);
  }, 200);
});

// ── Settings Modal ─────────────────────────────────────────────
settingsBtn.addEventListener('click', () => openModal(settingsModal, settingsBtn));
settingsClose.addEventListener('click', () => closeModal(settingsModal));
settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) closeModal(settingsModal); });

document.querySelectorAll('.settings-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.settings-tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.settings-panel').forEach((p) => (p.hidden = true));
    tab.classList.add('active');
    const panel = document.querySelector(`[data-panel="${tab.dataset.tab}"]`);
    if (panel) panel.hidden = false;
    if (tab.dataset.tab === 'locale') updateLocalePreview();
  });
});

// ── Settings Fields ────────────────────────────────────────────
tempSlider.addEventListener('input', () => {
  state.settings.temperature = parseFloat(tempSlider.value);
  tempValue.textContent = tempSlider.value;
});
enableThinkingInput.addEventListener('change', () => {
  state.settings.enableThinking = enableThinkingInput.checked;
  updateReasoningControls();
});
maxTokensInput.addEventListener('change', () => { state.settings.maxTokens = parseInt(maxTokensInput.value) || 1024; });
ctxWindowInput.addEventListener('change', () => {
  state.settings.maxContext = parseInt(ctxWindowInput.value) || 65536;
  updateContextBar();
});
autoCompactInput?.addEventListener('change', () => {
  state.settings.autoCompactEnabled = autoCompactInput.checked;
});
systemPromptInput.addEventListener('change', () => {
  state.settings.systemPrompt = systemPromptInput.value;
  syncPromptTemplate();
});
showThinkingInput.addEventListener('change', () => { state.settings.showThinking = showThinkingInput.checked; });
apiEndpointInput.addEventListener('change', () => { state.settings.apiEndpoint = apiEndpointInput.value; });
providerModelInput?.addEventListener('change', () => { state.settings.model = providerModelInput.value; });
userLanguageSelect.addEventListener('change', () => { state.settings.language = userLanguageSelect.value; updateLocalePreview(); });
userTimezoneSelect.addEventListener('change', () => { state.settings.timezone = userTimezoneSelect.value; updateLocalePreview(); });

// ── Restart Gateway Button ─────────────────────────────────────
if (restartGatewayBtn) {
  restartGatewayBtn.addEventListener('click', async () => {
    const originalText = restartGatewayBtn.textContent;
    const originalDisabled = restartGatewayBtn.disabled;
    
    try {
      restartGatewayBtn.disabled = true;
      restartGatewayBtn.textContent = '⏳ Restarting...';
      
      const response = await fetch('/restart-gateway', { 
        method: 'POST',
        signal: AbortSignal.timeout(30000)
      });
      
      const data = await response.json();
      
      if (response.ok) {
        showToast('Gateway restart initiated. Reconnecting...', 'success');
        // Give the gateway time to restart
        setTimeout(() => {
          connMgr.setState('reconnecting');
          connMgr.startHealthPolling('/manager/health', 10000);
        }, 1500);
      } else {
        showToast(data.error || 'Failed to restart gateway', 'error');
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Failed to restart gateway', 'error');
    } finally {
      restartGatewayBtn.textContent = originalText;
      restartGatewayBtn.disabled = originalDisabled;
    }
  });
}

// ── Shortcuts Modal ────────────────────────────────────────────
function openShortcutsModal(trigger = shortcutsBtn) {
  shortcutsList.innerHTML = getShortcutsList()
    .map((s) => `<div class="shortcut-item"><kbd>${s.combo}</kbd><span>${s.description}</span></div>`)
    .join('');
  openModal(shortcutsModal, trigger);
}
shortcutsBtn.addEventListener('click', () => openShortcutsModal(shortcutsBtn));
shortcutsClose.addEventListener('click', () => closeModal(shortcutsModal));
shortcutsModal.addEventListener('click', (e) => { if (e.target === shortcutsModal) closeModal(shortcutsModal); });



// ── Export Modal ───────────────────────────────────────────────
exportBtn.addEventListener('click', () => openModal(exportModal, exportBtn));
exportClose.addEventListener('click', () => closeModal(exportModal));
exportModal.addEventListener('click', (e) => { if (e.target === exportModal) closeModal(exportModal); });
document.querySelectorAll('.export-option').forEach((btn) => {
  btn.addEventListener('click', () => exportChat(btn.dataset.format));
});

// ── Analytics Modal ────────────────────────────────────────────
analyticsBtn.addEventListener('click', () => {
  const summary = getAnalyticsSummary();
  analyticsContent.innerHTML = `
    <div class="analytics-card"><div class="label">Today</div><div class="value">${formatTokenCount(summary.today.total)}</div><div class="sub">${summary.today.count} requests</div></div>
    <div class="analytics-card"><div class="label">This Week</div><div class="value">${formatTokenCount(summary.week.total)}</div><div class="sub">${summary.week.count} requests</div></div>
    <div class="analytics-card"><div class="label">All Time</div><div class="value">${formatTokenCount(summary.allTime.total)}</div><div class="sub">${summary.allTime.count} requests</div></div>
    <div class="analytics-card"><div class="label">By Provider</div><div class="value">&nbsp;</div><div class="sub">EnowxAI: ${formatTokenCount(summary.byMode.enowxai)}<br>OpenAI: ${formatTokenCount(summary.byMode.openai)}<br>Anthropic: ${formatTokenCount(summary.byMode.anthropic)}</div></div>
  `;
  // Render observability health cards below analytics
  let obsContainer = analyticsContent.querySelector('.obs-section');
  if (!obsContainer) {
    obsContainer = document.createElement('div');
    obsContainer.className = 'obs-section';
    analyticsContent.appendChild(obsContainer);
  }
  renderObservabilityCards(obsContainer);
  openModal(analyticsModal, analyticsBtn);
});
analyticsClose.addEventListener('click', () => closeModal(analyticsModal));
analyticsModal.addEventListener('click', (e) => { if (e.target === analyticsModal) closeModal(analyticsModal); });

// ── Voice Input ────────────────────────────────────────────────
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;

if (!SpeechRecognition) {
  if (voiceBtn) voiceBtn.hidden = true;
} else {
  voiceBtn.addEventListener('click', () => {
    if (recognition) { recognition.stop(); return; }
    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = state.settings.language === 'auto' ? (navigator.language || 'en-US') : state.settings.language;
    voiceBtn.classList.add('recording');
    recognition.onresult = (event) => {
      let transcript = '';
      for (let i = event.resultIndex; i < event.results.length; i++) transcript += event.results[i][0].transcript;
      if (!recognition._finalLen) recognition._finalLen = userInput.value.length;
      userInput.value = userInput.value.slice(0, recognition._finalLen) + transcript;
      autoResize(userInput);
      updateSendButton();
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) recognition._finalLen = userInput.value.length;
      }
    };
    recognition.onend = () => { voiceBtn.classList.remove('recording'); recognition = null; };
    recognition.onerror = () => { voiceBtn.classList.remove('recording'); recognition = null; };
    recognition.start();
  });
}

// ── Theme Toggle ───────────────────────────────────────────────
themeToggle.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  themeToggle.textContent = next === 'light' ? '\u2600\uFE0F' : '\uD83C\uDF19';
  localStorage.setItem('theme', next);
});

// ── Suggestion Chips ───────────────────────────────────────────
document.querySelectorAll('.suggestion-chip').forEach((chip) => {
  chip.addEventListener('click', () => sendMessage(chip.dataset.prompt));
});

// ── Plus Menu ──────────────────────────────────────────────────
plusBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  plusMenu.hidden = !plusMenu.hidden;
  syncPlusMenuState();
});
reasoningToggleBtn.addEventListener('click', () => {
  state.settings.enableThinking = !state.settings.enableThinking;
  updateReasoningControls();
});
document.addEventListener('click', () => closePlusMenu());
plusMenu.addEventListener('click', (e) => e.stopPropagation());
document.querySelectorAll('.plus-menu-item').forEach((item) => {
  item.addEventListener('click', () => {
    const action = item.dataset.action;
    closePlusMenu();
    if (action === 'upload-doc') fileUploadDoc.click();
    else if (action === 'upload-image') fileUploadImg.click();
  });
});

// ── Send / Stop ────────────────────────────────────────────────
sendBtn.addEventListener('click', () => {
  if (!state.isStreaming && userInput.value.trim()) { clearDraft(); sendMessage(userInput.value); }
});
stopBtn.addEventListener('click', () => state.abortController?.abort());

// ── User Input ─────────────────────────────────────────────────
userInput.addEventListener('input', () => {
  autoResize(userInput);
  updateSendButton();
  persistDraft(userInput.value);
  const val = userInput.value;
  if (val.startsWith('/') && !val.includes('\n')) showCommandAutocomplete(val);
  else hideCommandAutocomplete();
});

userInput.addEventListener('keydown', (e) => {
  const autocompleteEl = document.querySelector('.command-autocomplete');
  const autocompleteVisible = autocompleteEl && !autocompleteEl.hidden;
  if (autocompleteVisible) {
    if (e.key === 'ArrowDown') { e.preventDefault(); navigateAutocomplete(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); navigateAutocomplete(-1); return; }
    if (e.key === 'Tab' || (e.key === 'Enter' && autocompleteEl.querySelector('.command-item.selected'))) {
      e.preventDefault();
      if (selectAutocompleteItem()) return;
    }
    if (e.key === 'Escape') { e.preventDefault(); hideCommandAutocomplete(); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!state.isStreaming && userInput.value.trim()) sendMessage(userInput.value);
  }
});

// ── Custom Events (from keyboard shortcuts) ────────────────────
document.addEventListener('chat:send', () => { if (!state.isStreaming && userInput.value.trim()) sendMessage(userInput.value); });
document.addEventListener('chat:abort', () => state.abortController?.abort());
document.addEventListener('chat:new', startNewConversation);
document.addEventListener('chat:export', () => openModal(exportModal, exportBtn));
document.addEventListener('chat:regenerate', regenerateLastResponse);
document.addEventListener('chat:shortcuts', () => openShortcutsModal(shortcutsBtn));

// ── Global Keyboard ────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'f' && state.messages.length > 0) {
    e.preventDefault(); openMsgSearch(); return;
  }
  if (e.key === 'Escape') {
    const msgSearchBar = $('#msg-search-bar');
    if (msgSearchBar && !msgSearchBar.hidden) { e.preventDefault(); closeMsgSearch(); return; }
    if (plusMenu && !plusMenu.hidden) { e.preventDefault(); closePlusMenu(); plusBtn.focus(); return; }
    if (activeModal) { e.preventDefault(); closeModal(activeModal); return; }
    if (isMobileViewport() && !sidebar.classList.contains('collapsed')) { e.preventDefault(); closeSidebar(); }
    return;
  }
  handleModalTabTrap(e);
});


// ── Init ───────────────────────────────────────────────────────
const savedTheme = localStorage.getItem('theme') || 'dark';
document.documentElement.dataset.theme = savedTheme;
themeToggle.textContent = savedTheme === 'light' ? '\u2600\uFE0F' : '\uD83C\uDF19';

// Auth init
const authUser = initAuthUI();

// Rooms view — inject into DOM
const roomsView = createRoomsView();
const playgroundView = document.getElementById('view-playground');
if (playgroundView) {
  playgroundView.parentNode.insertBefore(roomsView, playgroundView);
}
initRoomsUI();

function syncShellForView(viewName) {
  const isRoomsView = viewName === 'rooms';

  if (sidebar) sidebar.hidden = isRoomsView;
  if (sidebarToggle) sidebarToggle.hidden = isRoomsView;

  if (isRoomsView) {
    closeSidebar();
    if (sidebarBackdrop) sidebarBackdrop.hidden = true;
    return;
  }

  if (sidebar) sidebar.hidden = false;
  if (sidebarToggle) sidebarToggle.hidden = false;
  syncSidebarBackdrop();
}

// Nav tab switching — include rooms
document.querySelectorAll('.nav-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.nav-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    document.querySelectorAll('.view-panel').forEach((p) => { p.hidden = true; });
    const viewId = `view-${tab.dataset.view}`;
    const panel = document.getElementById(viewId);
    if (panel) panel.hidden = false;
    syncShellForView(tab.dataset.view);
    if (tab.dataset.view === 'rooms' && isAuthenticated()) {
      refreshRoomsList({ onOpenTeamRoom: openRoomChat, onOpenAgentRoom: openAgentRoomChat, onCloseRoom: closeRoomChat });
    } else {
      // Stop room polling and WebSocket when leaving Rooms tab
      cleanupRooms();
    }
  });
});

// On login success — refresh rooms
onLoginSuccess(() => {
  refreshSidebar();
  refreshRoomsList({ onOpenTeamRoom: openRoomChat, onOpenAgentRoom: openAgentRoomChat, onCloseRoom: closeRoomChat });
});

initShortcuts();
populateTimezones();
populatePromptTemplates();
applySettingsToUi();
syncPlusMenuState();

if (isMobileViewport()) sidebar.classList.add('collapsed');
const activeViewTab = document.querySelector('.nav-tab.active');
syncShellForView(activeViewTab?.dataset.view || 'chat');
window.addEventListener('resize', syncSidebarBackdrop);

const lastConvId = getActiveConversationId();
if (lastConvId) loadConversationById(lastConvId);
else refreshSidebar();

// Session recovery — restore draft and show recovery banner if needed
const savedDraft = loadDraft();
if (savedDraft?.text && userInput) {
  userInput.value = savedDraft.text;
  autoResize(userInput);
  updateSendButton();
}

const savedSession = loadSessionState();
if (savedSession?.conversationId && savedSession.wasStreaming) {
  showRecoveryBanner(savedSession, (session) => {
    if (session.conversationId) loadConversationById(session.conversationId);
    clearSessionState();
  }, () => clearSessionState());
}

// Agent Room auto-restore — reopen the last active agent room
const savedAgentRoom = loadAgentRoomState();
if (savedAgentRoom?.projectRoomId && isAuthenticated()) {
  // Switch to Rooms tab and reopen the agent room
  setTimeout(() => {
    const roomsTab = document.querySelector('.nav-tab[data-view="rooms"]');
    if (roomsTab) {
      roomsTab.click();
      // Wait for rooms list to load, then open the saved room
      setTimeout(() => {
        openAgentRoomChat(savedAgentRoom.projectRoomId).catch(() => {
          // Room may have been deleted — clear stale state
          clearAgentRoomState();
        });
      }, 500);
    }
  }, 300);
}

// Persist session state periodically and on unload
setInterval(persistSessionState, 15_000);
window.addEventListener('beforeunload', () => { persistSessionState(); persistDraft(userInput?.value || ''); });

updateContextBar();
updateTokenInfo();
checkShareUrl();

// Auto-fetch provider models on startup (cloud-only mode)
showEnowxModelList().catch(() => {});

// Lazy-load CDN rendering libraries after first user interaction
// (saves ~200-400ms on initial page load)
const triggerPreload = () => {
  preloadRenderingLibs();
  document.removeEventListener('keydown', triggerPreload);
  document.removeEventListener('click', triggerPreload);
  document.removeEventListener('touchstart', triggerPreload);
};
document.addEventListener('keydown', triggerPreload, { once: true, passive: true });
document.addEventListener('click', triggerPreload, { once: true, passive: true });
document.addEventListener('touchstart', triggerPreload, { once: true, passive: true });

// Initialize mermaid when it becomes available (loaded lazily)
if (typeof mermaid !== 'undefined') mermaid.initialize({ startOnLoad: false, theme: 'dark' });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
