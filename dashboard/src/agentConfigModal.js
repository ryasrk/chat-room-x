/**
 * agentConfigModal.js — Agent add/edit/delete modal and provider configuration.
 *
 * Extracted from roomsUI.js to keep files under 800 lines.
 */

import {
  getProjectAgentRoomDetails, getProviderPresets, getAgentProviderModels,
  addAgentToRoom, updateAgentInRoom, deleteAgentFromRoom,
} from './authClient.js';
import { showToast } from './utils.js';
import { showConfirm } from './confirmModal.js';
import { fetchEnowxProviderModels, pickPreferredProviderModel } from './providerModels.js';
import { rs, escapeHtml } from './roomsUtils.js';

// ── Provider Config Cache ──────────────────────────────────────

let _cachedProviderPresets = null;
let _enowxModelsPromise = null;

export async function loadRoomProviderPresets() {
  if (_cachedProviderPresets) return _cachedProviderPresets;
  try {
    const data = await getProviderPresets();
    _cachedProviderPresets = data.presets || {};
  } catch { _cachedProviderPresets = {}; }
  return _cachedProviderPresets;
}

async function loadEnowxModelsIntoPresets() {
  try {
    const freshModels = await getAgentProviderModels('enowxai');
    const models = Array.isArray(freshModels?.models) ? freshModels.models : [];
    if (models.length > 0) {
      if (!_cachedProviderPresets) _cachedProviderPresets = {};
      _cachedProviderPresets = {
        ..._cachedProviderPresets,
        enowxai: { ...(_cachedProviderPresets.enowxai || {}), models },
      };
      return models;
    }
  } catch {
    // Fall through to cached/preset fallback.
  }

  const existing = _cachedProviderPresets?.enowxai?.models;
  if (Array.isArray(existing) && existing.length > 0) return existing;

  try {
    const fresh = await getProviderPresets();
    const models = fresh?.presets?.enowxai?.models;
    if (Array.isArray(models) && models.length > 0) {
      _cachedProviderPresets = fresh.presets || {};
      return models;
    }
  } catch {
    // Fall back to direct client-side fetch below.
  }

  if (_enowxModelsPromise) return _enowxModelsPromise;

  _enowxModelsPromise = fetchEnowxProviderModels()
    .then((models) => {
      if (!_cachedProviderPresets) _cachedProviderPresets = {};
      _cachedProviderPresets = {
        ..._cachedProviderPresets,
        enowxai: { ...(_cachedProviderPresets.enowxai || {}), models },
      };
      return models;
    })
    .finally(() => { _enowxModelsPromise = null; });

  return _enowxModelsPromise;
}

export async function updateRoomProviderFields(panel, provider) {
  if (!panel) return;

  // Load enowx models dynamically when enowxai provider is selected
  if (provider === 'enowxai') {
    try { await loadEnowxModelsIntoPresets(); } catch { /* silent */ }
  }

  const apiKeyGroup = panel.querySelector('#agent-api-key-group');
  const baseUrlGroup = panel.querySelector('#agent-base-url-group');
  const modelSelectGroup = panel.querySelector('#agent-model-select-group');
  const modelTextGroup = panel.querySelector('#agent-model-text-group');
  const maxTokensGroup = panel.querySelector('#agent-max-tokens-group');
  const temperatureGroup = panel.querySelector('#agent-temperature-group');
  const modelSelect = panel.querySelector('#agent-model-select-input');
  const modelText = panel.querySelector('#agent-model-text-input');
  const baseUrlInput = panel.querySelector('#agent-base-url-input');
  const maxTokensInput = panel.querySelector('#agent-max-tokens-input');
  const tempInput = panel.querySelector('#agent-temperature-input');

  // Hide all optional fields first
  if (apiKeyGroup) apiKeyGroup.style.display = 'none';
  if (baseUrlGroup) baseUrlGroup.style.display = 'none';
  if (modelSelectGroup) modelSelectGroup.style.display = 'none';
  if (modelTextGroup) modelTextGroup.style.display = 'none';
  if (maxTokensGroup) maxTokensGroup.style.display = 'none';
  if (temperatureGroup) temperatureGroup.style.display = 'none';
  if (modelSelect) modelSelect.innerHTML = '';
  if (modelText) modelText.value = '';

  if (provider === 'tier' || !provider) return;

  // Show max tokens + temperature for all providers
  if (maxTokensGroup) maxTokensGroup.style.display = '';
  if (temperatureGroup) temperatureGroup.style.display = '';

  const preset = _cachedProviderPresets?.[provider] || {};

  if (apiKeyGroup) apiKeyGroup.style.display = '';
  if (provider === 'custom') {
    if (baseUrlGroup) baseUrlGroup.style.display = '';
  }
  if (baseUrlInput && preset.base_url) baseUrlInput.placeholder = preset.base_url;

  const models = preset.models || [];
  if (models.length > 0) {
    const previousValue = modelText?.value || modelSelect?.value || '';
    if (modelSelectGroup) modelSelectGroup.style.display = '';
    if (modelTextGroup) modelTextGroup.style.display = 'none';
    if (modelSelect) {
      modelSelect.innerHTML = models.map(m =>
        `<option value="${m}" ${m === preset.default_model ? 'selected' : ''}>${m}</option>`
      ).join('');
      modelSelect.value = pickPreferredProviderModel({
        models,
        previousValue,
        defaultModel: preset.default_model || '',
      });
      if (modelText) modelText.value = modelSelect.value;
    }
  } else {
    if (modelSelectGroup) modelSelectGroup.style.display = 'none';
    if (modelTextGroup) modelTextGroup.style.display = '';
    if (modelText) modelText.placeholder = preset.default_model || 'model-name';
  }

  if (maxTokensInput && !maxTokensInput.value) maxTokensInput.value = preset.default_max_tokens || 4096;
  if (tempInput && !tempInput.value) tempInput.value = preset.default_temperature ?? 0.3;
}

function collectRoomProviderConfig(panel) {
  const provider = panel?.querySelector('#agent-provider-input')?.value || 'tier';
  if (provider === 'tier') return {};

  const config = { provider };
  const apiKey = panel.querySelector('#agent-api-key-input')?.value.trim();
  const baseUrl = panel.querySelector('#agent-base-url-input')?.value.trim();
  const modelSelect = panel.querySelector('#agent-model-select-input');
  const modelText = panel.querySelector('#agent-model-text-input')?.value.trim();
  const maxTokens = panel.querySelector('#agent-max-tokens-input')?.value;
  const temperature = panel.querySelector('#agent-temperature-input')?.value;

  if (apiKey) config.api_key = apiKey;
  if (baseUrl) config.base_url = baseUrl;

  const selectGroup = panel.querySelector('#agent-model-select-group');
  if (selectGroup && selectGroup.style.display !== 'none' && modelSelect?.value) {
    config.model = modelSelect.value;
  } else if (modelText) {
    config.model = modelText;
  }

  if (maxTokens && !isNaN(maxTokens)) config.max_tokens = parseInt(maxTokens, 10);
  if (temperature && !isNaN(temperature)) config.temperature = parseFloat(temperature);

  return config;
}

// ── Router Config (xa) ─────────────────────────────────────────

function updateRouterProviderFields(panel, provider) {
  if (!panel) return;
  const baseUrlGroup = panel.querySelector('#router-base-url-group');
  const apiKeyGroup = panel.querySelector('#router-api-key-group');
  const modelGroup = panel.querySelector('#router-model-group');
  const maxTokensGroup = panel.querySelector('#router-max-tokens-group');
  const baseUrlInput = panel.querySelector('#router-base-url-input');
  const modelInput = panel.querySelector('#router-model-input');
  const maxTokensInput = panel.querySelector('#router-max-tokens-input');

  // Hide all first
  if (baseUrlGroup) baseUrlGroup.style.display = 'none';
  if (apiKeyGroup) apiKeyGroup.style.display = 'none';
  if (modelGroup) modelGroup.style.display = 'none';
  if (maxTokensGroup) maxTokensGroup.style.display = 'none';

  if (!provider) return;

  // Show relevant fields
  if (modelGroup) modelGroup.style.display = '';
  if (maxTokensGroup) maxTokensGroup.style.display = '';

  if (provider === 'custom') {
    if (baseUrlGroup) baseUrlGroup.style.display = '';
    if (apiKeyGroup) apiKeyGroup.style.display = '';
  } else if (provider === 'enowxai' || provider === 'openai') {
    if (apiKeyGroup) apiKeyGroup.style.display = '';
    if (provider === 'enowxai') {
      if (modelInput) modelInput.placeholder = 'gemini-3.1-flash-lite';
    }
  }
}

function collectRouterConfig(panel) {
  const provider = panel?.querySelector('#router-provider-input')?.value || '';
  if (!provider) return {};

  const config = { provider };
  const baseUrl = panel.querySelector('#router-base-url-input')?.value.trim();
  const apiKey = panel.querySelector('#router-api-key-input')?.value.trim();
  const model = panel.querySelector('#router-model-input')?.value.trim();
  const maxTokens = panel.querySelector('#router-max-tokens-input')?.value;

  if (baseUrl) config.base_url = baseUrl;
  if (apiKey) config.api_key = apiKey;
  if (model) config.model = model;
  if (maxTokens && !isNaN(maxTokens)) config.max_tokens = parseInt(maxTokens, 10);
  config.temperature = 0.1; // Router always uses low temperature

  return config;
}

function populateRouterConfig(panel, routerConfig) {
  if (!panel || !routerConfig) return;
  const providerInput = panel.querySelector('#router-provider-input');
  const baseUrlInput = panel.querySelector('#router-base-url-input');
  const apiKeyInput = panel.querySelector('#router-api-key-input');
  const modelInput = panel.querySelector('#router-model-input');
  const maxTokensInput = panel.querySelector('#router-max-tokens-input');

  if (providerInput) providerInput.value = routerConfig.provider || '';
  if (baseUrlInput) baseUrlInput.value = routerConfig.base_url || '';
  if (apiKeyInput) apiKeyInput.value = routerConfig.api_key || '';
  if (modelInput) modelInput.value = routerConfig.model || '';
  if (maxTokensInput) maxTokensInput.value = routerConfig.max_tokens || '';

  updateRouterProviderFields(panel, routerConfig.provider || '');
}

// ── Tab Switching ──────────────────────────────────────────────

function initAgentConfigTabs(panel) {
  const tabs = panel?.querySelectorAll('.agent-config-tab');
  const panels = panel?.querySelectorAll('.agent-config-tab-panel');
  if (!tabs || !panels) return;

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === target));
      panels.forEach((p) => p.classList.toggle('active', p.dataset.tabPanel === target));
    });
  });

  // Router provider change handler
  const routerProviderInput = panel.querySelector('#router-provider-input');
  if (routerProviderInput) {
    routerProviderInput.addEventListener('change', () => {
      updateRouterProviderFields(panel, routerProviderInput.value);
    });
  }
}

let _tabsInitialized = false;

// ── Modal Open / Close / Submit ────────────────────────────────

/**
 * Open the agent config modal in 'add' or 'edit' mode.
 * @param {'add'|'edit'} mode
 * @param {object|null} agent — existing agent data (for edit mode)
 * @param {function} renderAgentMembers — callback to re-render pills after save/delete
 */
export async function openAgentConfigModal(mode = 'add', agent = null, renderAgentMembers = () => {}) {
  const panel = rs.panel;
  const modal = panel?.querySelector('#agent-config-modal');
  const title = panel?.querySelector('#agent-config-title');
  const form = panel?.querySelector('#agent-config-form');
  const modeInput = panel?.querySelector('#agent-config-mode');
  const originalNameInput = panel?.querySelector('#agent-config-original-name');
  const nameInput = panel?.querySelector('#agent-name-input');
  const roleInput = panel?.querySelector('#agent-role-input');
  const tierInput = panel?.querySelector('#agent-tier-input');
  const promptInput = panel?.querySelector('#agent-prompt-input');
  const deleteBtn = panel?.querySelector('#agent-config-delete');
  const submitBtn = panel?.querySelector('#agent-config-submit');
  const providerInput = panel?.querySelector('#agent-provider-input');
  if (!modal || !form) return;

  await loadRoomProviderPresets();
  form.reset();
  modeInput.value = mode;

  if (mode === 'edit' && agent) {
    title.textContent = `Edit @${agent.name}`;
    originalNameInput.value = agent.name;
    nameInput.value = agent.name;
    nameInput.disabled = true;
    roleInput.value = agent.role || '';
    tierInput.value = agent.model_tier || 'worker';
    promptInput.value = agent.system_prompt || '';
    deleteBtn.style.display = '';
    submitBtn.textContent = 'Save Changes';

    const tools = agent.tools || [];
    form.querySelectorAll('input[name="agent-tool"]').forEach((cb) => {
      cb.checked = tools.includes(cb.value);
    });

    // Populate provider config
    const pc = agent.provider_config || {};
    if (providerInput) providerInput.value = pc.provider || 'tier';
    const apiKeyInput = panel?.querySelector('#agent-api-key-input');
    const baseUrlInput = panel?.querySelector('#agent-base-url-input');
    const maxTokensInput = panel?.querySelector('#agent-max-tokens-input');
    const tempInput = panel?.querySelector('#agent-temperature-input');
    const modelSelect = panel?.querySelector('#agent-model-select-input');
    const modelText = panel?.querySelector('#agent-model-text-input');
    if (apiKeyInput) apiKeyInput.value = pc.api_key || '';
    if (baseUrlInput) baseUrlInput.value = pc.base_url || '';
    if (maxTokensInput) maxTokensInput.value = pc.max_tokens || '';
    if (tempInput) tempInput.value = pc.temperature ?? '';
    await updateRoomProviderFields(panel, pc.provider || 'tier');
    if (pc.model) {
      if (modelSelect) modelSelect.value = pc.model;
      if (modelText) modelText.value = pc.model;
    }

    // Populate router config (xa)
    populateRouterConfig(panel, agent.router_config || {});
  } else {
    title.textContent = 'Add AI Bot';
    originalNameInput.value = '';
    nameInput.disabled = false;
    deleteBtn.style.display = 'none';
    submitBtn.textContent = 'Add Bot';
    if (providerInput) providerInput.value = 'tier';
    updateRoomProviderFields(panel, 'tier');
    // Reset router config
    populateRouterConfig(panel, {});
  }

  // Initialize tabs once, reset to first tab on every open
  if (!_tabsInitialized) {
    initAgentConfigTabs(panel);
    _tabsInitialized = true;
  }
  const firstTab = panel.querySelector('.agent-config-tab[data-tab="identity"]');
  if (firstTab) firstTab.click();

  modal.style.display = 'flex';
}

export function closeAgentConfigModal() {
  const panel = rs.panel;
  const modal = panel?.querySelector('#agent-config-modal');
  const nameInput = panel?.querySelector('#agent-name-input');
  if (modal) modal.style.display = 'none';
  if (nameInput) nameInput.disabled = false;
}

function getAgentConfigFormData() {
  const panel = rs.panel;
  const name = panel?.querySelector('#agent-name-input')?.value.trim().toLowerCase() || '';
  const role = panel?.querySelector('#agent-role-input')?.value.trim() || '';
  const model_tier = panel?.querySelector('#agent-tier-input')?.value || 'worker';
  const system_prompt = panel?.querySelector('#agent-prompt-input')?.value.trim() || '';
  const tools = Array.from(panel?.querySelectorAll('input[name="agent-tool"]:checked') || [])
    .map((cb) => cb.value);
  const provider_config = collectRoomProviderConfig(panel);
  const router_config = collectRouterConfig(panel);
  return { name, role, model_tier, system_prompt, tools, provider_config, router_config };
}

/**
 * Handle agent config form submit (add or update).
 * @param {function} renderAgentMembers — callback to re-render pills
 */
export async function handleAgentConfigSubmit(renderAgentMembers = () => {}) {
  if (!rs.currentAgentRoomId) return;

  const panel = rs.panel;
  const mode = panel?.querySelector('#agent-config-mode')?.value || 'add';
  const originalName = panel?.querySelector('#agent-config-original-name')?.value || '';
  const formData = getAgentConfigFormData();

  try {
    if (mode === 'add') {
      await addAgentToRoom(rs.currentAgentRoomId, formData);
      showToast(`Bot @${formData.name} added!`, 'success');
    } else {
      await updateAgentInRoom(rs.currentAgentRoomId, originalName, {
        role: formData.role,
        model_tier: formData.model_tier,
        system_prompt: formData.system_prompt,
        tools: formData.tools,
        provider_config: formData.provider_config,
        router_config: formData.router_config,
      });
      showToast(`Bot @${originalName} updated!`, 'success');
    }
    closeAgentConfigModal();
    const data = await getProjectAgentRoomDetails(rs.currentRoomId);
    renderAgentMembers(data.agents || []);
  } catch (err) {
    showToast(err.message || 'Failed to save bot', 'error');
  }
}

/**
 * Handle agent config delete button.
 * @param {function} renderAgentMembers — callback to re-render pills
 */
export async function handleAgentConfigDelete(renderAgentMembers = () => {}) {
  if (!rs.currentAgentRoomId) return;

  const panel = rs.panel;
  const originalName = panel?.querySelector('#agent-config-original-name')?.value || '';
  if (!originalName) return;

  const confirmed = await showConfirm({
    title: 'Delete Bot',
    message: `Remove @${originalName} from this room? This cannot be undone.`,
    confirmText: 'Delete',
    variant: 'danger',
  });
  if (!confirmed) return;

  try {
    await deleteAgentFromRoom(rs.currentAgentRoomId, originalName);
    showToast(`Bot @${originalName} removed`, 'success');
    closeAgentConfigModal();
    const data = await getProjectAgentRoomDetails(rs.currentRoomId);
    renderAgentMembers(data.agents || []);
  } catch (err) {
    showToast(err.message || 'Failed to delete bot', 'error');
  }
}
