const DEFAULT_ENOWXAI_MODEL = import.meta.env.VITE_ENOWXAI_DEFAULT_MODEL || '';

const PROVIDER_MODE_CONFIG = {
  enowxai: {
    model: DEFAULT_ENOWXAI_MODEL,
    reasoningEffort: 'high',
  },
};

export function resolveModeModel(mode, selectedModel = '') {
  const modeConfig = PROVIDER_MODE_CONFIG[mode];

  if (!modeConfig) {
    return '';
  }

  return typeof selectedModel === 'string' && selectedModel.trim()
    ? selectedModel.trim()
    : modeConfig.model;
}

export function buildModeRequestPayload(mode, payload, { enableThinking = false, selectedModel = '' } = {}) {
  const modeConfig = PROVIDER_MODE_CONFIG[mode];

  if (!modeConfig) {
    return { ...payload };
  }

  return {
    ...payload,
    model: resolveModeModel(mode, selectedModel),
    ...(enableThinking ? { reasoning_effort: modeConfig.reasoningEffort } : {}),
  };
}