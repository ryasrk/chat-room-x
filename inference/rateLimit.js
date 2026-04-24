/**
 * Tenrary-X Rate Limiter
 * Lightweight in-memory sliding-window rate limiter for auth endpoints.
 * No external dependencies — uses a Map with periodic cleanup.
 */

/**
 * Create a rate limiter instance.
 * @param {object} opts
 * @param {number} opts.windowMs   — Time window in milliseconds (default: 15 min)
 * @param {number} opts.maxHits    — Max requests per window (default: 10)
 * @param {string} opts.message    — Error message when rate limited
 * @returns {{ check: (key: string) => { allowed: boolean, retryAfterMs: number } }}
 */
export function createRateLimiter({ windowMs = 15 * 60 * 1000, maxHits = 10, message = 'Too many requests, please try again later.' } = {}) {
  /** @type {Map<string, number[]>} */
  const hits = new Map();

  // Periodic cleanup every 5 minutes to prevent memory leaks
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, timestamps] of hits) {
      const valid = timestamps.filter((t) => now - t < windowMs);
      if (valid.length === 0) {
        hits.delete(key);
      } else {
        hits.set(key, valid);
      }
    }
  }, 5 * 60 * 1000);
  cleanupInterval.unref(); // Don't prevent process exit

  return {
    message,

    /**
     * Check if a request is allowed and record the hit.
     * @param {string} key — Typically the client IP address
     * @returns {{ allowed: boolean, retryAfterMs: number, remaining: number }}
     */
    check(key) {
      const now = Date.now();
      const timestamps = hits.get(key) || [];

      // Remove expired timestamps
      const valid = timestamps.filter((t) => now - t < windowMs);

      if (valid.length >= maxHits) {
        const oldestInWindow = valid[0];
        const retryAfterMs = windowMs - (now - oldestInWindow);
        return { allowed: false, retryAfterMs, remaining: 0 };
      }

      valid.push(now);
      hits.set(key, valid);
      return { allowed: true, retryAfterMs: 0, remaining: maxHits - valid.length };
    },
  };
}
