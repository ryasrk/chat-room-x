export function normalizeProviderModelsResponse(data) {
  const rawModels = Array.isArray(data?.data)
    ? data.data
    : Array.isArray(data?.models)
      ? data.models
      : [];

  return rawModels
    .map((entry) => {
      if (typeof entry === 'string') return entry.trim();
      if (entry && typeof entry === 'object' && typeof entry.id === 'string') {
        return entry.id.trim();
      }
      return '';
    })
    .filter(Boolean);
}

export function pickPreferredProviderModel({ models, previousValue = '', defaultModel = '' }) {
  const availableModels = Array.isArray(models) ? models.filter(Boolean) : [];
  const nextPreviousValue = typeof previousValue === 'string' ? previousValue.trim() : '';
  const nextDefaultModel = typeof defaultModel === 'string' ? defaultModel.trim() : '';

  if (nextPreviousValue && availableModels.includes(nextPreviousValue)) {
    return nextPreviousValue;
  }

  if (nextDefaultModel && availableModels.includes(nextDefaultModel)) {
    return nextDefaultModel;
  }

  return availableModels[0] || '';
}

export async function fetchEnowxProviderModels(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('Fetch API is unavailable for loading enowxai models.');
  }

  const response = await fetchImpl('/v1/models', {
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error('Failed to load enowxai models.');
  }

  const data = await response.json();
  return normalizeProviderModelsResponse(data);
}