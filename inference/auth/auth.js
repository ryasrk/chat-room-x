/**
 * Tenrary-X Authentication Module
 * JWT access/refresh tokens, Bun.password native hashing, middleware.
 * Uses Bun.password (native async bcrypt) instead of bcryptjs for non-blocking hashing.
 */

import jwt from 'jsonwebtoken';
import { createHash, randomUUID } from 'crypto';
import {
  createUser, findUserByUsername, findUserByEmail, findUserById,
  saveRefreshToken, findRefreshToken, revokeRefreshToken, revokeAllUserTokens,
  uuid,
} from '../db/database.js';

// ── Config ─────────────────────────────────────────────────────
const INSECURE_DEFAULTS = new Set([
  'tenrary-x-access-secret-change-me',
  'tenrary-x-refresh-secret-change-me',
  'change-me', 'secret', 'password', '',
]);

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'tenrary-x-access-secret-change-me';
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'tenrary-x-refresh-secret-change-me';

// Warn loudly (and block in production) if using default secrets
if (INSECURE_DEFAULTS.has(ACCESS_SECRET) || INSECURE_DEFAULTS.has(REFRESH_SECRET)) {
  const msg = '[SECURITY] JWT secrets are using insecure defaults! Set JWT_ACCESS_SECRET and JWT_REFRESH_SECRET environment variables.';
  if (process.env.NODE_ENV === 'production') {
    console.error(`\x1b[31m✖ FATAL: ${msg}\x1b[0m`);
    process.exit(1);
  } else {
    console.warn(`\x1b[33m⚠ WARNING: ${msg} (allowed in development)\x1b[0m`);
  }
}

const ACCESS_EXPIRY = '15m';
const REFRESH_EXPIRY_SECONDS = 30 * 24 * 60 * 60; // 30 days
const BCRYPT_ROUNDS = 12;
const USERNAME_RE = /^[a-zA-Z0-9_]{3,30}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

// ── Helpers ────────────────────────────────────────────────────

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function sanitizeUser(user) {
  if (!user) return null;
  const { password_hash, ...safe } = user;
  return safe;
}

// ── Password ───────────────────────────────────────────────────

export async function hashPassword(password) {
  return Bun.password.hash(password, { algorithm: 'bcrypt', cost: BCRYPT_ROUNDS });
}

export async function verifyPassword(password, hash) {
  return Bun.password.verify(password, hash);
}

export function validatePassword(password) {
  const errors = [];
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    errors.push(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (!/[A-Z]/.test(password)) errors.push('Must contain an uppercase letter');
  if (!/[0-9]/.test(password)) errors.push('Must contain a digit');
  return errors;
}

// ── Token Creation ─────────────────────────────────────────────

export function createAccessToken(userId, username) {
  return jwt.sign(
    { sub: userId, username, type: 'access' },
    ACCESS_SECRET,
    { expiresIn: ACCESS_EXPIRY, issuer: 'tenrary-x' },
  );
}

export function createRefreshToken(userId) {
  const jti = randomUUID();
  const token = jwt.sign(
    { sub: userId, type: 'refresh', jti },
    REFRESH_SECRET,
    { expiresIn: REFRESH_EXPIRY_SECONDS, issuer: 'tenrary-x' },
  );

  // Store hash in DB for revocation
  const tokenHash = hashToken(token);
  const expiresAt = Math.floor(Date.now() / 1000) + REFRESH_EXPIRY_SECONDS;
  saveRefreshToken(jti, userId, tokenHash, expiresAt);

  return token;
}

export function createTokenPair(userId, username) {
  return {
    access_token: createAccessToken(userId, username),
    refresh_token: createRefreshToken(userId),
    token_type: 'Bearer',
    expires_in: 900, // 15 minutes in seconds
  };
}

// ── Token Verification ─────────────────────────────────────────

export function verifyAccessToken(token) {
  try {
    const payload = jwt.verify(token, ACCESS_SECRET, { issuer: 'tenrary-x' });
    if (payload.type !== 'access') return null;
    return payload;
  } catch {
    return null;
  }
}

export function verifyRefreshTokenAndRotate(token) {
  try {
    const payload = jwt.verify(token, REFRESH_SECRET, { issuer: 'tenrary-x' });
    if (payload.type !== 'refresh') return { error: 'Invalid token type' };

    const tokenHash = hashToken(token);
    const stored = findRefreshToken(tokenHash);
    if (!stored) return { error: 'Token revoked or not found' };

    // Revoke old token (one-time use)
    revokeRefreshToken(stored.id);

    // Issue new pair
    const user = findUserById(payload.sub);
    if (!user) return { error: 'User not found' };

    return { tokens: createTokenPair(user.id, user.username), user: sanitizeUser(user) };
  } catch (err) {
    if (err.name === 'TokenExpiredError') return { error: 'Refresh token expired' };
    return { error: 'Invalid refresh token' };
  }
}

// ── Registration ───────────────────────────────────────────────

export async function register(username, email, password, displayName) {
  // Validate
  if (!username || !USERNAME_RE.test(username)) {
    return { error: 'Username must be 3-30 characters (letters, numbers, underscores)' };
  }
  if (!email || !EMAIL_RE.test(email)) {
    return { error: 'Invalid email address' };
  }
  const pwErrors = validatePassword(password);
  if (pwErrors.length > 0) {
    return { error: pwErrors.join('. ') };
  }

  // Check uniqueness
  if (findUserByUsername(username)) {
    return { error: 'Username already taken' };
  }
  if (findUserByEmail(email)) {
    return { error: 'Email already registered' };
  }

  // Create user
  const id = uuid();
  const passwordHash = await hashPassword(password);
  createUser(id, username, email, passwordHash, displayName || username);

  const user = findUserById(id);
  const tokens = createTokenPair(id, username);

  return { user: sanitizeUser(user), tokens };
}

// ── Login ──────────────────────────────────────────────────────

export async function login(usernameOrEmail, password) {
  const user = usernameOrEmail.includes('@')
    ? findUserByEmail(usernameOrEmail)
    : findUserByUsername(usernameOrEmail);

  if (!user) return { error: 'Invalid credentials' };
  if (!await verifyPassword(password, user.password_hash)) return { error: 'Invalid credentials' };

  const tokens = createTokenPair(user.id, user.username);
  return { user: sanitizeUser(user), tokens };
}

// ── Logout ─────────────────────────────────────────────────────

export function logout(refreshToken) {
  if (!refreshToken) return;
  const tokenHash = hashToken(refreshToken);
  const stored = findRefreshToken(tokenHash);
  if (stored) revokeRefreshToken(stored.id);
}

export function logoutAll(userId) {
  revokeAllUserTokens(userId);
}

// ── Middleware Helper ──────────────────────────────────────────

/**
 * Extract Bearer token from Authorization header.
 * @param {import('http').IncomingMessage} req
 * @returns {string|null}
 */
export function extractBearerToken(req) {
  const auth = req.headers['authorization'] || '';
  if (!auth.startsWith('Bearer ')) return null;
  return auth.slice(7).trim();
}

/**
 * Authenticate request — attaches req.user if valid.
 * Returns null on success, error string on failure.
 * @param {import('http').IncomingMessage} req
 * @returns {string|null} Error message or null
 */
export function authenticateRequest(req) {
  const token = extractBearerToken(req);
  if (!token) return 'Missing authorization token';

  const payload = verifyAccessToken(token);
  if (!payload) return 'Invalid or expired token';

  const user = findUserById(payload.sub);
  if (!user) return 'User not found';

  req.user = sanitizeUser(user);
  return null;
}
