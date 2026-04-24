import { createHash } from 'node:crypto';

export const CACHE_TTLS = {
  '/v1/models': 300,
  '/v1/chat/completions': 120,
  '/v1/responses': 120,
  '/v1/messages': 120,
};

export function parseJsonSafely(rawBody) {
  if (typeof rawBody !== 'string' || !rawBody.trim()) return null;

  try {
    return JSON.parse(rawBody);
  } catch {
    return null;
  }
}

export function shouldCacheRequest(pathname, method, rawBody = '') {
  if (method === 'GET') {
    return pathname === '/v1/models';
  }

  if (method !== 'POST' || !(pathname in CACHE_TTLS)) {
    return false;
  }

  const payload = parseJsonSafely(rawBody);
  if (!payload || payload.stream === true) {
    return false;
  }

  return pathname === '/v1/chat/completions'
    || pathname === '/v1/responses'
    || pathname === '/v1/messages';
}

export function buildCacheKey(pathname, method, rawBody = '') {
  return createHash('sha256')
    .update(`${method}:${pathname}:${rawBody}`)
    .digest('hex');
}

export class RequestCache {
  constructor({ redisClient = null, keyPrefix = 'tenrary:enowxai' } = {}) {
    this.redisClient = redisClient;
    this.keyPrefix = keyPrefix;
    this.memoryCache = new Map();
    this.inflight = new Map();
  }

  getCacheKey(key) {
    return `${this.keyPrefix}:${key}`;
  }

  async get(key) {
    const { value, state } = await this._getWithState(key);
    // Return value if fresh or stale (backward compat — callers that use get() directly)
    return (state === 'fresh' || state === 'stale') ? value : null;
  }

  async set(key, value, ttlSeconds) {
    const namespacedKey = this.getCacheKey(key);
    const now = Date.now();

    if (this.redisClient?.isReady) {
      // Store with SWR metadata: freshUntil + staleUntil
      const wrapped = JSON.stringify({
        value,
        freshUntil: now + ttlSeconds * 1000,
        staleUntil: now + ttlSeconds * 2 * 1000, // stale window = 2x TTL
      });
      // Total Redis TTL = stale window (2x)
      await this.redisClient.set(namespacedKey, wrapped, { EX: ttlSeconds * 2 });
      return;
    }

    this.memoryCache.set(namespacedKey, {
      value,
      freshUntil: now + ttlSeconds * 1000,
      staleUntil: now + ttlSeconds * 2 * 1000,
    });
  }

  /**
   * Get a cached value with SWR awareness.
   * Returns { value, state } where state is 'fresh' | 'stale' | null.
   */
  async _getWithState(key) {
    const namespacedKey = this.getCacheKey(key);
    const now = Date.now();

    if (this.redisClient?.isReady) {
      const raw = await this.redisClient.get(namespacedKey);
      if (!raw) return { value: null, state: null };
      try {
        const parsed = JSON.parse(raw);
        // New SWR format
        if (parsed.freshUntil !== undefined) {
          if (now < parsed.freshUntil) return { value: parsed.value, state: 'fresh' };
          if (now < parsed.staleUntil) return { value: parsed.value, state: 'stale' };
          return { value: null, state: null };
        }
        // Legacy format (no SWR metadata) — treat as fresh
        return { value: parsed, state: 'fresh' };
      } catch {
        return { value: null, state: null };
      }
    }

    const cached = this.memoryCache.get(namespacedKey);
    if (!cached) return { value: null, state: null };

    // New SWR format
    if (cached.freshUntil !== undefined) {
      if (now < cached.freshUntil) return { value: cached.value, state: 'fresh' };
      if (now < cached.staleUntil) return { value: cached.value, state: 'stale' };
      this.memoryCache.delete(namespacedKey);
      return { value: null, state: null };
    }

    // Legacy format (expiresAt)
    if (cached.expiresAt && cached.expiresAt <= now) {
      this.memoryCache.delete(namespacedKey);
      return { value: null, state: null };
    }
    return { value: cached.value, state: 'fresh' };
  }

  async getOrCompute(key, ttlSeconds, compute, options = {}) {
    const shouldCache = typeof options.shouldCache === 'function'
      ? options.shouldCache
      : () => true;

    const { value: cached, state } = await this._getWithState(key);

    // Fresh cache hit — return immediately
    if (state === 'fresh' && cached != null) {
      return { value: cached, source: 'cache' };
    }

    // Stale cache hit — return stale data immediately, revalidate in background
    if (state === 'stale' && cached != null) {
      // Background revalidation (fire-and-forget, deduplicated via inflight)
      if (!this.inflight.has(key)) {
        const revalidate = (async () => {
          try {
            const freshValue = await compute();
            if (shouldCache(freshValue)) {
              await this.set(key, freshValue, ttlSeconds);
            }
          } catch {
            // Revalidation failed — stale data continues to be served
          }
        })();
        this.inflight.set(key, revalidate);
        revalidate.finally(() => this.inflight.delete(key));
      }
      return { value: cached, source: 'stale-while-revalidate' };
    }

    // Cache miss — compute synchronously (with request coalescing)
    if (this.inflight.has(key)) {
      return { value: await this.inflight.get(key), source: 'coalesced' };
    }

    const pending = (async () => {
      const freshValue = await compute();
      if (shouldCache(freshValue)) {
        await this.set(key, freshValue, ttlSeconds);
      }
      return freshValue;
    })();

    this.inflight.set(key, pending);

    try {
      return { value: await pending, source: 'fresh' };
    } finally {
      this.inflight.delete(key);
    }
  }
}