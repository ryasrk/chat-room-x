/**
 * Unit tests for auth/auth.js — JWT authentication, password hashing, registration, login.
 */

import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';

import {
  hashPassword,
  verifyPassword,
  validatePassword,
  createAccessToken,
  createTokenPair,
  verifyAccessToken,
  verifyRefreshTokenAndRotate,
  register,
  login,
  logout,
} from './auth.js';

// ── Password Hashing ───────────────────────────────────────────

describe('hashPassword / verifyPassword', () => {
  test('hashes and verifies correctly', async () => {
    const hash = await hashPassword('MyPassword123');
    assert.ok(hash);
    assert.ok(hash.length > 20);
    assert.notEqual(hash, 'MyPassword123');

    const valid = await verifyPassword('MyPassword123', hash);
    assert.equal(valid, true);
  });

  test('rejects wrong password', async () => {
    const hash = await hashPassword('CorrectPassword1');
    const valid = await verifyPassword('WrongPassword1', hash);
    assert.equal(valid, false);
  });

  test('produces different hashes for same password (salt)', async () => {
    const h1 = await hashPassword('SamePassword1');
    const h2 = await hashPassword('SamePassword1');
    assert.notEqual(h1, h2); // Different salts
  });
});

// ── Password Validation ────────────────────────────────────────

describe('validatePassword', () => {
  test('accepts valid password', () => {
    const errors = validatePassword('StrongPass1');
    assert.equal(errors.length, 0);
  });

  test('rejects short password', () => {
    const errors = validatePassword('Ab1');
    assert.ok(errors.some((e) => e.includes('8 characters')));
  });

  test('rejects missing uppercase', () => {
    const errors = validatePassword('lowercase123');
    assert.ok(errors.some((e) => e.includes('uppercase')));
  });

  test('rejects missing digit', () => {
    const errors = validatePassword('NoDigitsHere');
    assert.ok(errors.some((e) => e.includes('digit')));
  });

  test('rejects empty password', () => {
    const errors = validatePassword('');
    assert.ok(errors.length > 0);
  });

  test('rejects null/undefined', () => {
    assert.ok(validatePassword(null).length > 0);
    assert.ok(validatePassword(undefined).length > 0);
  });

  test('accepts exactly 8 chars with uppercase and digit', () => {
    const errors = validatePassword('Abcdefg1');
    assert.equal(errors.length, 0);
  });
});

// ── JWT Token Creation ─────────────────────────────────────────

describe('createAccessToken', () => {
  test('creates a valid JWT', () => {
    const token = createAccessToken('user-123', 'testuser');
    assert.ok(token);
    assert.ok(token.split('.').length === 3); // JWT has 3 parts
  });

  test('token can be verified', () => {
    const token = createAccessToken('user-123', 'testuser');
    const payload = verifyAccessToken(token);
    assert.ok(payload);
    assert.equal(payload.sub, 'user-123');
    assert.equal(payload.username, 'testuser');
    assert.equal(payload.type, 'access');
  });
});

describe('createTokenPair', () => {
  test('returns access and refresh tokens', async () => {
    // Need a real user for FK constraint on refresh_tokens
    const username = `tokenpair_${Date.now()}`;
    const reg = await register(username, `${username}@test.com`, 'ValidPass1');
    const pair = createTokenPair(reg.user.id, username);
    assert.ok(pair.access_token);
    assert.ok(pair.refresh_token);
    assert.equal(pair.token_type, 'Bearer');
    assert.equal(pair.expires_in, 900);
  });

  test('access token is verifiable', async () => {
    const username = `tokenpair2_${Date.now()}`;
    const reg = await register(username, `${username}@test.com`, 'ValidPass1');
    const pair = createTokenPair(reg.user.id, username);
    const payload = verifyAccessToken(pair.access_token);
    assert.equal(payload.sub, reg.user.id);
    assert.equal(payload.username, username);
  });
});

// ── Token Verification ─────────────────────────────────────────

describe('verifyAccessToken', () => {
  test('returns payload for valid token', () => {
    const token = createAccessToken('u1', 'user1');
    const payload = verifyAccessToken(token);
    assert.ok(payload);
    assert.equal(payload.sub, 'u1');
  });

  test('returns null for invalid token', () => {
    assert.equal(verifyAccessToken('invalid.token.here'), null);
  });

  test('returns null for empty string', () => {
    assert.equal(verifyAccessToken(''), null);
  });

  test('returns null for expired token', async () => {
    // Create a token that's already expired (hack: sign with 0s expiry)
    const jwtMod = await import('jsonwebtoken');
    const token = jwtMod.default.sign(
      { sub: 'u1', type: 'access' },
      process.env.JWT_ACCESS_SECRET || 'tenrary-x-access-secret-change-me',
      { expiresIn: '0s', issuer: 'tenrary-x' },
    );
    // Wait a tick for it to expire
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(verifyAccessToken(token), null);
  });

  test('returns null for refresh token (wrong type)', async () => {
    const username = `wrongtype_${Date.now()}`;
    const reg = await register(username, `${username}@test.com`, 'ValidPass1');
    // Refresh token has type: 'refresh', should be rejected by verifyAccessToken
    assert.equal(verifyAccessToken(reg.tokens.refresh_token), null);
  });
});

// ── Registration ───────────────────────────────────────────────

describe('register', () => {
  test('registers a new user', async () => {
    const username = `testuser_${Date.now()}`;
    const result = await register(username, `${username}@test.com`, 'ValidPass1', 'Test User');

    assert.ok(result.user);
    assert.ok(result.tokens);
    assert.equal(result.user.username, username);
    assert.ok(!result.user.password_hash); // Should be sanitized
    assert.ok(result.tokens.access_token);
    assert.ok(result.tokens.refresh_token);
  });

  test('rejects invalid username', async () => {
    const result = await register('ab', 'ab@test.com', 'ValidPass1');
    assert.ok(result.error);
    assert.ok(result.error.includes('Username'));
  });

  test('rejects invalid email', async () => {
    const result = await register('validuser', 'not-an-email', 'ValidPass1');
    assert.ok(result.error);
    assert.ok(result.error.includes('email'));
  });

  test('rejects weak password', async () => {
    const result = await register('validuser2', 'valid2@test.com', 'weak');
    assert.ok(result.error);
  });

  test('rejects duplicate username', async () => {
    const username = `dupuser_${Date.now()}`;
    await register(username, `${username}@test.com`, 'ValidPass1');
    const result = await register(username, `${username}2@test.com`, 'ValidPass1');
    assert.ok(result.error);
    assert.ok(result.error.includes('Username'));
  });

  test('rejects duplicate email', async () => {
    const email = `dupemail_${Date.now()}@test.com`;
    await register(`user1_${Date.now()}`, email, 'ValidPass1');
    const result = await register(`user2_${Date.now()}`, email, 'ValidPass1');
    assert.ok(result.error);
    assert.ok(result.error.includes('Email'));
  });

  test('rejects special characters in username', async () => {
    const result = await register('user@name!', 'special@test.com', 'ValidPass1');
    assert.ok(result.error);
  });
});

// ── Login ──────────────────────────────────────────────────────

describe('login', () => {
  test('logs in with correct credentials', async () => {
    const username = `loginuser_${Date.now()}`;
    await register(username, `${username}@test.com`, 'ValidPass1', 'Login User');

    const result = await login(username, 'ValidPass1');
    assert.ok(result.user);
    assert.ok(result.tokens);
    assert.equal(result.user.username, username);
  });

  test('logs in with email', async () => {
    const username = `emaillogin_${Date.now()}`;
    const email = `${username}@test.com`;
    await register(username, email, 'ValidPass1');

    const result = await login(email, 'ValidPass1');
    assert.ok(result.user);
    assert.equal(result.user.username, username);
  });

  test('rejects wrong password', async () => {
    const username = `wrongpw_${Date.now()}`;
    await register(username, `${username}@test.com`, 'ValidPass1');

    const result = await login(username, 'WrongPassword1');
    assert.ok(result.error);
    assert.equal(result.error, 'Invalid credentials');
  });

  test('rejects non-existent user', async () => {
    const result = await login('nonexistent_user_xyz', 'AnyPass1');
    assert.ok(result.error);
    assert.equal(result.error, 'Invalid credentials');
  });
});

// ── Token Refresh ──────────────────────────────────────────────

describe('verifyRefreshTokenAndRotate', () => {
  test('rotates refresh token', async () => {
    const username = `refresh_${Date.now()}`;
    const reg = await register(username, `${username}@test.com`, 'ValidPass1');

    const result = verifyRefreshTokenAndRotate(reg.tokens.refresh_token);
    assert.ok(result.tokens);
    assert.ok(result.user);
    assert.ok(result.tokens.access_token);
    assert.ok(result.tokens.refresh_token);
    // New tokens should be different
    assert.notEqual(result.tokens.refresh_token, reg.tokens.refresh_token);
  });

  test('rejects already-used refresh token (one-time use)', async () => {
    const username = `onetime_${Date.now()}`;
    const reg = await register(username, `${username}@test.com`, 'ValidPass1');

    // First use — should succeed
    const first = verifyRefreshTokenAndRotate(reg.tokens.refresh_token);
    assert.ok(first.tokens);

    // Second use — should fail (revoked)
    const second = verifyRefreshTokenAndRotate(reg.tokens.refresh_token);
    assert.ok(second.error);
  });

  test('rejects invalid token', () => {
    const result = verifyRefreshTokenAndRotate('invalid.token.here');
    assert.ok(result.error);
  });
});

// ── Logout ─────────────────────────────────────────────────────

describe('logout', () => {
  test('revokes refresh token', async () => {
    const username = `logout_${Date.now()}`;
    const reg = await register(username, `${username}@test.com`, 'ValidPass1');

    logout(reg.tokens.refresh_token);

    // Token should now be revoked
    const result = verifyRefreshTokenAndRotate(reg.tokens.refresh_token);
    assert.ok(result.error);
  });

  test('handles null token gracefully', () => {
    // Should not throw
    logout(null);
    logout(undefined);
    logout('');
  });
});
