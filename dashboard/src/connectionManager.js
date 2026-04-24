/**
 * Retry Logic, Error Handling & Connection Management
 * for Tenrary-X Chat Dashboard.
 *
 * Exports: fetchWithRetry, isRetryableError, getBackoffDelay,
 *          ConnectionManager, MessageQueue, categorizeError
 */

// ── Constants ──────────────────────────────────────────────────

const DEFAULT_MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const BACKOFF_MULTIPLIER = 2;
const MAX_DELAY_MS = 8000;
const JITTER_FACTOR = 0.3; // ±30% jitter

const RETRYABLE_STATUS = new Set([429, 502, 503]);
const NON_RETRYABLE_STATUS = new Set([400, 401, 403, 404, 405, 422]);

// ── Error Categorization ───────────────────────────────────────

/**
 * Categorize an error into a structured object.
 * @param {Error}    error
 * @param {Response} [response]
 * @returns {{ type: string, message: string, retryable: boolean }}
 */
export function categorizeError(error, response) {
  if (error && error.name === 'AbortError') {
    return { type: 'abort', message: 'Request was cancelled.', retryable: false };
  }

  if (error && error.name === 'TimeoutError') {
    return { type: 'timeout', message: 'Request timed out.', retryable: true };
  }

  if (response) {
    if (response.status === 429) {
      return { type: 'server', message: 'Server busy — rate limited.', retryable: true };
    }
    if (response.status >= 500) {
      return { type: 'server', message: `Server error (${response.status}).`, retryable: RETRYABLE_STATUS.has(response.status) };
    }
    if (response.status >= 400) {
      return { type: 'server', message: `Client error (${response.status}).`, retryable: false };
    }
  }

  if (error instanceof TypeError) {
    // fetch throws TypeError for network failures
    return { type: 'network', message: 'Network error — check your connection.', retryable: true };
  }

  return { type: 'unknown', message: error?.message || 'An unknown error occurred.', retryable: false };
}

// ── Retry Helpers ──────────────────────────────────────────────

/**
 * Check whether an error / response pair is retryable.
 * @param {Error}    error
 * @param {Response} [response]
 * @returns {boolean}
 */
export function isRetryableError(error, response) {
  if (error && error.name === 'AbortError') return false;

  if (response) {
    if (RETRYABLE_STATUS.has(response.status)) return true;
    if (NON_RETRYABLE_STATUS.has(response.status)) return false;
  }

  // Network errors (TypeError from fetch) are retryable
  if (error instanceof TypeError) return true;

  // Timeout errors are retryable
  if (error && error.name === 'TimeoutError') return true;

  return false;
}

/**
 * Compute exponential-backoff delay with jitter.
 * @param {number} attempt  Zero-based attempt index (0 = first retry)
 * @returns {number} Milliseconds to wait
 */
export function getBackoffDelay(attempt) {
  const exponential = Math.min(
    BASE_DELAY_MS * Math.pow(BACKOFF_MULTIPLIER, attempt),
    MAX_DELAY_MS,
  );
  // Add ±JITTER_FACTOR random jitter to prevent thundering herd
  const jitter = exponential * JITTER_FACTOR * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(exponential + jitter));
}

// ── fetchWithRetry ─────────────────────────────────────────────

/**
 * Fetch with automatic exponential-backoff retry.
 *
 * @param {string|URL}  url
 * @param {RequestInit}  [options={}]
 * @param {object}       [retryOpts]
 * @param {number}       [retryOpts.maxRetries=3]
 * @param {AbortSignal}  [retryOpts.signal]
 * @returns {Promise<Response>}
 */
export async function fetchWithRetry(url, options = {}, { maxRetries = DEFAULT_MAX_RETRIES, signal } = {}) {
  let lastError;
  let lastResponse;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Bail immediately if the caller already aborted
    if (signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }

    try {
      const fetchOptions = { ...options };
      if (signal) fetchOptions.signal = signal;

      const response = await fetch(url, fetchOptions);

      // Success — return as-is (caller decides what to do with non-2xx)
      if (response.ok) return response;

      // Non-retryable status — return immediately
      if (!isRetryableError(null, response)) return response;

      // Retryable status but last attempt — return the response
      if (attempt === maxRetries) return response;

      lastResponse = response;
    } catch (error) {
      // Never retry aborts
      if (error.name === 'AbortError') throw error;

      if (!isRetryableError(error) || attempt === maxRetries) {
        throw error;
      }

      lastError = error;
    }

    // Wait before retrying
    const delay = getBackoffDelay(attempt);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, delay);
      // If signal aborts while waiting, stop immediately
      if (signal) {
        const onAbort = () => {
          clearTimeout(timer);
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        };
        if (signal.aborted) {
          clearTimeout(timer);
          reject(new DOMException('The operation was aborted.', 'AbortError'));
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        // Clean up listener when timer fires
        const origResolve = resolve;
        resolve = () => {
          signal.removeEventListener('abort', onAbort);
          origResolve();
        };
      }
    });
  }

  // Should not reach here, but safety net
  if (lastResponse) return lastResponse;
  throw lastError || new Error('fetchWithRetry: exhausted retries');
}

// ── Connection Manager ─────────────────────────────────────────

const VALID_STATES = new Set(['connected', 'disconnected', 'reconnecting', 'streaming']);

export class ConnectionManager {
  /** @type {'connected'|'disconnected'|'reconnecting'|'streaming'} */
  #state = 'disconnected';
  #listeners = new Set();
  #healthInterval = null;
  #healthUrl = null;

  get state() {
    return this.#state;
  }

  /**
   * Update connection state. Notifies all listeners on change.
   * @param {'connected'|'disconnected'|'reconnecting'|'streaming'} newState
   */
  setState(newState) {
    if (!VALID_STATES.has(newState)) return;
    if (newState === this.#state) return;
    const prev = this.#state;
    this.#state = newState;
    for (const cb of this.#listeners) {
      try { cb(newState, prev); } catch { /* listener errors must not propagate */ }
    }
  }

  /**
   * Register a state-change listener.
   * @param {(state: string, prev: string) => void} callback
   * @returns {() => void} Unsubscribe function
   */
  onStateChange(callback) {
    this.#listeners.add(callback);
    return () => this.#listeners.delete(callback);
  }

  /**
   * Ping a health endpoint. Updates state accordingly.
   * @param {string} url
   * @returns {Promise<boolean>} true if healthy
   */
  async checkHealth(url) {
    // Fast offline check
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      this.setState('disconnected');
      return false;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        cache: 'no-store',
      });

      if (res.ok) {
        if (this.#state !== 'streaming') {
          this.setState('connected');
        }
        return true;
      }
      this.setState('disconnected');
      return false;
    } catch {
      this.setState('disconnected');
      return false;
    } finally {
      // M5 fix: always clean up the timeout
      clearTimeout(timeout);
    }
  }

  /**
   * Start periodic health polling.
   * @param {string} url       Health-check endpoint
   * @param {number} [intervalMs=10000]
   */
  startHealthPolling(url, intervalMs = 10_000) {
    this.stopHealthPolling();
    this.#healthUrl = url;

    // Immediate first check
    this.checkHealth(url);

    this.#healthInterval = setInterval(() => {
      // Skip polling while actively streaming or tab is hidden
      if (this.#state === 'streaming') return;
      if (document.hidden) return;
      this.checkHealth(url);
    }, intervalMs);

    // React to browser online/offline events and tab visibility
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.#handleOnline);
      window.addEventListener('offline', this.#handleOffline);
      document.addEventListener('visibilitychange', this.#handleVisibility);
    }
  }

  /** Stop health polling and clean up event listeners. */
  stopHealthPolling() {
    if (this.#healthInterval) {
      clearInterval(this.#healthInterval);
      this.#healthInterval = null;
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.#handleOnline);
      window.removeEventListener('offline', this.#handleOffline);
      document.removeEventListener('visibilitychange', this.#handleVisibility);
    }
  }

  // ── Private event handlers ──

  #handleOnline = () => {
    this.setState('reconnecting');
    if (this.#healthUrl) this.checkHealth(this.#healthUrl);
  };

  #handleOffline = () => {
    this.setState('disconnected');
  };

  /** Resume health check immediately when tab becomes visible again */
  #handleVisibility = () => {
    if (!document.hidden && this.#healthUrl) {
      this.checkHealth(this.#healthUrl);
    }
  };
}

// ── Message Queue ──────────────────────────────────────────────

export class MessageQueue {
  #queue = [];
  #sendFn;

  /**
   * @param {(message: any) => Promise<void>} sendFn
   *   Async function that sends a single message. Called by flush().
   */
  constructor(sendFn) {
    if (typeof sendFn !== 'function') {
      throw new TypeError('MessageQueue requires a send function');
    }
    this.#sendFn = sendFn;
  }

  /**
   * Add a message to the queue.
   * @param {any} message
   */
  enqueue(message) {
    this.#queue.push(message);
  }

  /**
   * Send all queued messages in order.
   * Stops on first failure, keeping unsent messages in the queue.
   * @returns {Promise<number>} Number of messages successfully sent
   */
  async flush() {
    let sent = 0;
    while (this.#queue.length > 0) {
      const message = this.#queue[0];
      try {
        await this.#sendFn(message);
        this.#queue.shift();
        sent++;
      } catch {
        // Stop flushing; remaining messages stay queued
        break;
      }
    }
    return sent;
  }

  /** @returns {number} Number of messages waiting in the queue */
  size() {
    return this.#queue.length;
  }

  /** Remove all queued messages. */
  clear() {
    this.#queue.length = 0;
  }
}
