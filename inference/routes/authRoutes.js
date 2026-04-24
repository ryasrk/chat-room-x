/**
 * Auth Routes — /api/auth/*
 * Registration, login, token refresh, logout.
 */

import { register, login, logout, logoutAll, verifyRefreshTokenAndRotate, authenticateRequest } from '../auth/auth.js';
import { sendJson, readBody } from './apiRouter.js';
import { updateUser, findUserById } from '../db/database.js';
import { hashPassword, verifyPassword, validatePassword } from '../auth/auth.js';
import { createRateLimiter } from '../rateLimit.js';

// ── Rate Limiters ──────────────────────────────────────────────
// Login: 5 attempts per 30 seconds per IP
const loginLimiter = createRateLimiter({ windowMs: 30 * 1000, maxHits: 10, message: 'Too many login attempts. Try again in 30 seconds.' });
// Register: 3 accounts per hour per IP (spam protection)
const registerLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, maxHits: 3, message: 'Too many registrations. Try again later.' });
// Refresh: 20 per 15 minutes per IP
const refreshLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, maxHits: 20, message: 'Too many token refresh requests.' });

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
}

function checkRateLimit(limiter, req, res) {
  const ip = getClientIp(req);
  const result = limiter.check(ip);
  if (!result.allowed) {
    const retryAfterSec = Math.ceil(result.retryAfterMs / 1000);
    sendJson(res, 429, { error: limiter.message }, { 'Retry-After': String(retryAfterSec) });
    return false;
  }
  return true;
}

// Body size limits — auth payloads are small (username+password+email ≈ 200 bytes)
const AUTH_BODY_LIMIT = 4 * 1024;       // 4 KB for login/register/refresh/logout
const PROFILE_BODY_LIMIT = 64 * 1024;   // 64 KB for profile (base64 avatar data URLs)

/**
 * @param {string} path
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @returns {Promise<boolean>}
 */
export async function handleAuthRoute(path, req, res) {

  // POST /api/auth/register
  if (path === '/api/auth/register' && req.method === 'POST') {
    if (!checkRateLimit(registerLimiter, req, res)) return true;
    try {
      const body = await readBody(req, AUTH_BODY_LIMIT);
      const { username, email, password, display_name } = body;

      if (!username || !email || !password) {
        sendJson(res, 400, { error: 'username, email, and password are required' });
        return true;
      }

      const result = await register(username, email, password, display_name);
      if (result.error) {
        sendJson(res, 400, { error: result.error });
        return true;
      }

      sendJson(res, 201, { user: result.user, tokens: result.tokens });
    } catch (err) {
      sendJson(res, 400, { error: err.message || 'Registration failed' });
    }
    return true;
  }

  // POST /api/auth/login
  if (path === '/api/auth/login' && req.method === 'POST') {
    if (!checkRateLimit(loginLimiter, req, res)) return true;
    try {
      const body = await readBody(req, AUTH_BODY_LIMIT);
      const { username, password } = body;

      if (!username || !password) {
        sendJson(res, 400, { error: 'username and password are required' });
        return true;
      }

      const result = await login(username, password);
      if (result.error) {
        sendJson(res, 401, { error: result.error });
        return true;
      }

      sendJson(res, 200, { user: result.user, tokens: result.tokens });
    } catch (err) {
      sendJson(res, 400, { error: err.message || 'Login failed' });
    }
    return true;
  }

  // POST /api/auth/refresh
  if (path === '/api/auth/refresh' && req.method === 'POST') {
    if (!checkRateLimit(refreshLimiter, req, res)) return true;
    try {
      const body = await readBody(req, AUTH_BODY_LIMIT);
      const { refresh_token } = body;

      if (!refresh_token) {
        sendJson(res, 400, { error: 'refresh_token is required' });
        return true;
      }

      const result = verifyRefreshTokenAndRotate(refresh_token);
      if (result.error) {
        sendJson(res, 401, { error: result.error });
        return true;
      }

      sendJson(res, 200, { user: result.user, tokens: result.tokens });
    } catch (err) {
      sendJson(res, 400, { error: err.message || 'Token refresh failed' });
    }
    return true;
  }

  // POST /api/auth/logout
  if (path === '/api/auth/logout' && req.method === 'POST') {
    try {
      const body = await readBody(req, AUTH_BODY_LIMIT);
      logout(body.refresh_token);
      sendJson(res, 200, { ok: true });
    } catch {
      sendJson(res, 200, { ok: true });
    }
    return true;
  }

  // POST /api/auth/logout-all (requires auth)
  if (path === '/api/auth/logout-all' && req.method === 'POST') {
    const authError = authenticateRequest(req);
    if (authError) {
      sendJson(res, 401, { error: authError });
      return true;
    }
    logoutAll(req.user.id);
    sendJson(res, 200, { ok: true });
    return true;
  }

  // PATCH /api/auth/profile (requires auth)
  if (path === '/api/auth/profile' && req.method === 'PATCH') {
    const authError = authenticateRequest(req);
    if (authError) {
      sendJson(res, 401, { error: authError });
      return true;
    }

    try {
      const body = await readBody(req, PROFILE_BODY_LIMIT);
      const updates = {};
      if (body.display_name !== undefined) updates.display_name = String(body.display_name).slice(0, 50);
      if (body.avatar_url !== undefined) {
        const url = String(body.avatar_url);
        // Allow data URLs (base64 avatars) up to 50KB, regular URLs up to 500 chars
        const maxLen = url.startsWith('data:') ? 50_000 : 500;
        updates.avatar_url = url.slice(0, maxLen);
      }

      if (Object.keys(updates).length === 0) {
        sendJson(res, 400, { error: 'No valid fields to update' });
        return true;
      }

      updateUser(req.user.id, updates);
      const user = findUserById(req.user.id);
      const { password_hash, ...safe } = user;
      sendJson(res, 200, { user: safe });
    } catch (err) {
      sendJson(res, 400, { error: err.message || 'Update failed' });
    }
    return true;
  }

  // POST /api/auth/change-password (requires auth)
  if (path === '/api/auth/change-password' && req.method === 'POST') {
    const authError = authenticateRequest(req);
    if (authError) {
      sendJson(res, 401, { error: authError });
      return true;
    }

    try {
      const body = await readBody(req, AUTH_BODY_LIMIT);
      const { current_password, new_password } = body;

      if (!current_password || !new_password) {
        sendJson(res, 400, { error: 'current_password and new_password are required' });
        return true;
      }

      const user = findUserById(req.user.id);
      if (!await verifyPassword(current_password, user.password_hash)) {
        sendJson(res, 401, { error: 'Current password is incorrect' });
        return true;
      }

      const pwErrors = validatePassword(new_password);
      if (pwErrors.length > 0) {
        sendJson(res, 400, { error: pwErrors.join('. ') });
        return true;
      }

      updateUser(req.user.id, { password_hash: await hashPassword(new_password) });
      logoutAll(req.user.id);
      sendJson(res, 200, { ok: true, message: 'Password changed. All sessions revoked.' });
    } catch (err) {
      sendJson(res, 400, { error: err.message || 'Password change failed' });
    }
    return true;
  }

  return false;
}
