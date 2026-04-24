import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeProviderModelsResponse,
  pickPreferredProviderModel,
} from './providerModels.js';

test('normalizeProviderModelsResponse extracts model ids from supported payload shapes', () => {
  assert.deepEqual(
    normalizeProviderModelsResponse({
      data: [
        { id: 'claude-opus-4.6' },
        { id: 'gpt-5.4' },
        { id: '' },
      ],
    }),
    ['claude-opus-4.6', 'gpt-5.4'],
  );

  assert.deepEqual(
    normalizeProviderModelsResponse({
      models: [
        { id: 'gemini-2.5-pro' },
        'gpt-5.1',
      ],
    }),
    ['gemini-2.5-pro', 'gpt-5.1'],
  );
});

test('pickPreferredProviderModel keeps previous selection when available and falls back deterministically', () => {
  const models = ['claude-opus-4.6', 'gpt-5.4', 'gemini-2.5-pro'];

  assert.equal(
    pickPreferredProviderModel({
      models,
      previousValue: 'gpt-5.4',
      defaultModel: 'claude-opus-4.6',
    }),
    'gpt-5.4',
  );

  assert.equal(
    pickPreferredProviderModel({
      models,
      previousValue: 'missing-model',
      defaultModel: 'claude-opus-4.6',
    }),
    'claude-opus-4.6',
  );

  assert.equal(
    pickPreferredProviderModel({
      models,
      previousValue: 'missing-model',
      defaultModel: 'also-missing',
    }),
    'claude-opus-4.6',
  );

  assert.equal(
    pickPreferredProviderModel({
      models: [],
      previousValue: 'gpt-5.4',
      defaultModel: 'claude-opus-4.6',
    }),
    '',
  );
});