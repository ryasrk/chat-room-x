/**
 * Unit tests for rateLimit.js — sliding-window rate limiter.
 */

import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';

import { createRateLimiter } from './rateLimit.js';

describe('createRateLimiter', () => {
  test('allows requests within limit', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, maxHits: 3 });
    const r1 = limiter.check('ip1');
    assert.equal(r1.allowed, true);
    assert.equal(r1.remaining, 2);

    const r2 = limiter.check('ip1');
    assert.equal(r2.allowed, true);
    assert.equal(r2.remaining, 1);

    const r3 = limiter.check('ip1');
    assert.equal(r3.allowed, true);
    assert.equal(r3.remaining, 0);
  });

  test('blocks requests exceeding limit', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, maxHits: 2 });
    limiter.check('ip1');
    limiter.check('ip1');

    const r3 = limiter.check('ip1');
    assert.equal(r3.allowed, false);
    assert.equal(r3.remaining, 0);
    assert.ok(r3.retryAfterMs > 0);
    assert.ok(r3.retryAfterMs <= 60_000);
  });

  test('tracks different keys independently', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, maxHits: 1 });
    const r1 = limiter.check('ip1');
    assert.equal(r1.allowed, true);

    const r2 = limiter.check('ip2');
    assert.equal(r2.allowed, true);

    const r3 = limiter.check('ip1');
    assert.equal(r3.allowed, false);

    const r4 = limiter.check('ip2');
    assert.equal(r4.allowed, false);
  });

  test('allows requests after window expires', async () => {
    const limiter = createRateLimiter({ windowMs: 50, maxHits: 1 });
    limiter.check('ip1');

    const blocked = limiter.check('ip1');
    assert.equal(blocked.allowed, false);

    // Wait for window to expire
    await new Promise((r) => setTimeout(r, 60));

    const allowed = limiter.check('ip1');
    assert.equal(allowed.allowed, true);
  });

  test('retryAfterMs is accurate', () => {
    const limiter = createRateLimiter({ windowMs: 10_000, maxHits: 1 });
    limiter.check('ip1');

    const blocked = limiter.check('ip1');
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterMs > 9_000);
    assert.ok(blocked.retryAfterMs <= 10_000);
  });

  test('uses default options', () => {
    const limiter = createRateLimiter();
    assert.equal(limiter.message, 'Too many requests, please try again later.');
    // Should allow at least 10 requests
    for (let i = 0; i < 10; i++) {
      assert.equal(limiter.check('ip1').allowed, true);
    }
  });

  test('custom message', () => {
    const limiter = createRateLimiter({ message: 'Slow down!' });
    assert.equal(limiter.message, 'Slow down!');
  });

  test('handles rapid sequential requests', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, maxHits: 100 });
    for (let i = 0; i < 100; i++) {
      assert.equal(limiter.check('ip1').allowed, true);
    }
    assert.equal(limiter.check('ip1').allowed, false);
  });

  test('remaining count decreases correctly', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, maxHits: 5 });
    assert.equal(limiter.check('ip1').remaining, 4);
    assert.equal(limiter.check('ip1').remaining, 3);
    assert.equal(limiter.check('ip1').remaining, 2);
    assert.equal(limiter.check('ip1').remaining, 1);
    assert.equal(limiter.check('ip1').remaining, 0);
    assert.equal(limiter.check('ip1').remaining, 0); // blocked
  });
});
