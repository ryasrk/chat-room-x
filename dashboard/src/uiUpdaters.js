/**
 * UI Updaters — functions that refresh DOM based on shared state.
 * Depends on: appState, tokenCounter, utils.
 */

import { state, SYSTEM_PROMPT_TEMPLATES } from './appState.js';
import { calculateContextUsage, getSessionStats, formatTokenCount } from './tokenCounter.js';

const $ = (sel) => document.querySelector(sel);

const contextFill = $('#context-fill');
const contextLabel = $('#context-label');
const tokenInfo = $('#token-info');
const sendBtn = $('#send-btn');
const userInput = $('#user-input');
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
const localePreview = $('#locale-preview');
const reasoningToggleBtn = $('#reasoning-toggle-btn');
const promptTemplateSelect = $('#prompt-template');

export function updateContextBar() {
  const usage = calculateContextUsage(state.messages, state.settings.systemPrompt, state.settings.maxContext);
  const pct = Math.min(usage.percentage, 100);
  contextFill.style.width = `${pct}%`;
  contextLabel.textContent = `${Math.round(pct)}%`;
  contextFill.className = 'context-fill';
  if (usage.warning === 'critical') contextFill.classList.add('critical');
  else if (usage.warning === 'high') contextFill.classList.add('high');
  else if (usage.warning === 'approaching') contextFill.classList.add('approaching');
}

export function updateTokenInfo() {
  const stats = getSessionStats();
  tokenInfo.textContent = `${state.messages.length} msgs • ${formatTokenCount(stats.totalTokens)} tokens`;
}

export function updateSendButton() {
  sendBtn.disabled = !userInput.value.trim() || state.isStreaming;
}

export function updateReasoningControls() {
  const enabled = Boolean(state.settings.enableThinking);
  if (enableThinkingInput) enableThinkingInput.checked = enabled;
  if (reasoningToggleBtn) {
    reasoningToggleBtn.textContent = enabled ? 'Reasoning On' : 'Reasoning Off';
    reasoningToggleBtn.classList.toggle('active', enabled);
    reasoningToggleBtn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    reasoningToggleBtn.setAttribute('aria-label', enabled ? 'Disable reasoning generation' : 'Enable reasoning generation');
  }
}

export function updateLocalePreview() {
  if (!localePreview) return;
  const now = new Date();
  const locale = state.settings.language === 'auto' ? (navigator.language || 'en-US') : state.settings.language;
  const tz = state.settings.timezone === 'auto' ? Intl.DateTimeFormat().resolvedOptions().timeZone : state.settings.timezone;
  const datetime = now.toLocaleString(locale, {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZone: tz, timeZoneName: 'long',
  });
  localePreview.textContent = `${datetime}\nTimezone: ${tz}\nLanguage: ${locale}`;
}

export function syncPromptTemplate() {
  if (!promptTemplateSelect) return;
  const match = SYSTEM_PROMPT_TEMPLATES.findIndex((t) => t.prompt === state.settings.systemPrompt);
  promptTemplateSelect.value = match >= 0 ? String(match) : '';
}

export function populatePromptTemplates() {
  if (!promptTemplateSelect) return;
  promptTemplateSelect.innerHTML = '<option value="">Custom</option>';
  SYSTEM_PROMPT_TEMPLATES.forEach((t, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = t.name;
    promptTemplateSelect.appendChild(opt);
  });
}

export function populateTimezones() {
  if (!userTimezoneSelect) return;
  const timezones = Intl.supportedValuesOf('timeZone');
  const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
  timezones.forEach((tz) => {
    const opt = document.createElement('option');
    opt.value = tz;
    opt.textContent = tz.replace(/_/g, ' ');
    userTimezoneSelect.appendChild(opt);
  });
  const autoTzOpt = userTimezoneSelect.querySelector('[value="auto"]');
  if (autoTzOpt) autoTzOpt.textContent = `Auto-detect (${detected})`;
  const autoLangOpt = userLanguageSelect?.querySelector('[value="auto"]');
  if (autoLangOpt) autoLangOpt.textContent = `Auto-detect (${navigator.language})`;
}

export function applySettingsToUi() {
  if (tempSlider) { tempSlider.value = String(state.settings.temperature); }
  if (tempValue) { tempValue.textContent = String(state.settings.temperature); }
  updateReasoningControls();
  if (maxTokensInput) maxTokensInput.value = String(state.settings.maxTokens);
  if (ctxWindowInput) ctxWindowInput.value = String(state.settings.maxContext);
  if (autoCompactInput) autoCompactInput.checked = state.settings.autoCompactEnabled !== false;
  if (systemPromptInput) systemPromptInput.value = state.settings.systemPrompt;
  if (showThinkingInput) showThinkingInput.checked = Boolean(state.settings.showThinking);
  if (apiEndpointInput) apiEndpointInput.value = state.settings.apiEndpoint;
  if (providerModelInput) providerModelInput.value = state.settings.model || '';
  if (userLanguageSelect) userLanguageSelect.value = state.settings.language;
  if (userTimezoneSelect) userTimezoneSelect.value = state.settings.timezone;
  updateLocalePreview();
  syncPromptTemplate();
}
