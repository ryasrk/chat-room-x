/**
 * Simple LRU Cache for hot database reads.
 * Uses a Map (insertion-ordered) for O(1) get/set/eviction.
 *
 * Typical hit rates for chat apps: 80-95% — eliminates most DB reads
 * for frequently accessed data like users, rooms, and conversations.
 */

export class LRUCache {
  /**
   * @param {number} maxSize - Maximum number of entries
   * @param {number} ttlMs - Time-to-live in milliseconds (0 = no expiry)
   */
  constructor(maxSize = 1000, ttlMs = 60_000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    /** @type {Map<string, { value: any, expiresAt: number }>} */
    this.cache = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Get a cached value. Returns undefined on miss or expiry.
   * @param {string} key
   * @returns {any | undefined}
   */
  get(key) {
    const entry = this.cache.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }

    if (this.ttlMs > 0 && Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.misses++;
      return undefined;
    }

    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);
    this.hits++;
    return entry.value;
  }

  /**
   * Set a cached value. Evicts LRU entry if at capacity.
   * @param {string} key
   * @param {any} value
   */
  set(key, value) {
    // Delete first to refresh insertion order
    this.cache.delete(key);

    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
    }

    this.cache.set(key, {
      value,
      expiresAt: this.ttlMs > 0 ? Date.now() + this.ttlMs : Infinity,
    });
  }

  /**
   * Invalidate a specific key.
   * @param {string} key
   */
  invalidate(key) {
    this.cache.delete(key);
  }

  /**
   * Invalidate all keys matching a prefix.
   * @param {string} prefix
   */
  invalidatePrefix(prefix) {
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  /** Clear all cached entries. */
  clear() {
    this.cache.clear();
  }

  /** @returns {{ size: number, hits: number, misses: number, hitRate: string }} */
  stats() {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? `${((this.hits / total) * 100).toFixed(1)}%` : '0%',
    };
  }
}
