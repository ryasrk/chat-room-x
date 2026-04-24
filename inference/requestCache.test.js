import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCacheKey,
  CACHE_TTLS,
  RequestCache,
  shouldCacheRequest,
} from './requestCache.js';

test('shouldCacheRequest caches models and non-streaming provider calls', () => {
  assert.equal(shouldCacheRequest('/v1/models', 'GET'), true);
  assert.equal(shouldCacheRequest('/v1/chat/completions', 'POST', JSON.stringify({ stream: false })), true);
  assert.equal(shouldCacheRequest('/v1/responses', 'POST', JSON.stringify({ stream: false })), true);
  assert.equal(shouldCacheRequest('/v1/messages', 'POST', JSON.stringify({ stream: false })), true);
});

test('shouldCacheRequest skips streaming and unknown paths', () => {
  assert.equal(shouldCacheRequest('/v1/chat/completions', 'POST', JSON.stringify({ stream: true })), false);
  assert.equal(shouldCacheRequest('/v1/embeddings', 'POST', JSON.stringify({ stream: false })), false);
  assert.equal(shouldCacheRequest('/health', 'GET'), false);
});

test('buildCacheKey is stable for identical requests', () => {
  const first = buildCacheKey('/v1/models', 'GET');
  const second = buildCacheKey('/v1/models', 'GET');
  const different = buildCacheKey('/v1/chat/completions', 'POST', '{"stream":false}');

  assert.equal(first, second);
  assert.notEqual(first, different);
});

test('RequestCache coalesces concurrent work and caches the result', async () => {
  const cache = new RequestCache();
  let computeCalls = 0;

  const compute = async () => {
    computeCalls += 1;
    return { ok: true };
  };

  const [first, second] = await Promise.all([
    cache.getOrCompute('key', CACHE_TTLS['/v1/models'], compute),
    cache.getOrCompute('key', CACHE_TTLS['/v1/models'], compute),
  ]);

  assert.equal(computeCalls, 1);
  assert.equal(first.value.ok, true);
  assert.equal(second.value.ok, true);

  const third = await cache.getOrCompute('key', CACHE_TTLS['/v1/models'], async () => ({ ok: false }));
  assert.equal(third.source, 'cache');
  assert.equal(third.value.ok, true);
});