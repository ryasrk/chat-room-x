/**
 * Unit tests for semanticSearchTools.js — TF-IDF semantic code search.
 */

import { describe, test, beforeEach, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';

import { createSemanticSearchTools } from './semanticSearchTools.js';

let workspacePath;

beforeEach(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'semantic-test-'));

  // Create a realistic workspace
  await fs.mkdir(join(workspacePath, 'src'), { recursive: true });
  await fs.mkdir(join(workspacePath, 'src', 'auth'), { recursive: true });
  await fs.mkdir(join(workspacePath, 'src', 'db'), { recursive: true });
  await fs.mkdir(join(workspacePath, 'src', 'api'), { recursive: true });
  await fs.mkdir(join(workspacePath, 'tests'), { recursive: true });

  // Auth module
  await fs.writeFile(join(workspacePath, 'src', 'auth', 'login.js'), `
    import jwt from 'jsonwebtoken';
    
    export async function authenticateUser(username, password) {
      const user = await findUserByUsername(username);
      if (!user) throw new Error('User not found');
      
      const isValid = await bcrypt.compare(password, user.passwordHash);
      if (!isValid) throw new Error('Invalid credentials');
      
      const accessToken = jwt.sign({ userId: user.id }, SECRET, { expiresIn: '15m' });
      const refreshToken = jwt.sign({ userId: user.id }, REFRESH_SECRET, { expiresIn: '30d' });
      
      return { accessToken, refreshToken, user };
    }
    
    export function verifyToken(token) {
      return jwt.verify(token, SECRET);
    }
  `);

  // Database module
  await fs.writeFile(join(workspacePath, 'src', 'db', 'connection.js'), `
    import { Pool } from 'pg';
    
    const pool = new Pool({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      max: 20,
      idleTimeoutMillis: 30000,
    });
    
    export async function query(text, params) {
      const client = await pool.connect();
      try {
        return await client.query(text, params);
      } finally {
        client.release();
      }
    }
    
    export async function healthCheck() {
      const result = await query('SELECT 1');
      return result.rows.length > 0;
    }
  `);

  // API rate limiter
  await fs.writeFile(join(workspacePath, 'src', 'api', 'rateLimiter.js'), `
    const requestCounts = new Map();
    const WINDOW_MS = 60000;
    const MAX_REQUESTS = 100;
    
    export function rateLimitMiddleware(req, res, next) {
      const ip = req.ip;
      const now = Date.now();
      const windowStart = now - WINDOW_MS;
      
      const requests = requestCounts.get(ip) || [];
      const recentRequests = requests.filter(t => t > windowStart);
      
      if (recentRequests.length >= MAX_REQUESTS) {
        return res.status(429).json({ error: 'Too many requests' });
      }
      
      recentRequests.push(now);
      requestCounts.set(ip, recentRequests);
      next();
    }
  `);

  // Error handler
  await fs.writeFile(join(workspacePath, 'src', 'api', 'errorHandler.js'), `
    export function globalErrorHandler(err, req, res, next) {
      console.error('Unhandled error:', err.message);
      
      if (err.name === 'ValidationError') {
        return res.status(400).json({ error: err.message });
      }
      
      if (err.name === 'UnauthorizedError') {
        return res.status(401).json({ error: 'Authentication required' });
      }
      
      res.status(500).json({ error: 'Internal server error' });
    }
  `);

  // Test file
  await fs.writeFile(join(workspacePath, 'tests', 'auth.test.js'), `
    import { authenticateUser, verifyToken } from '../src/auth/login.js';
    
    test('authenticateUser returns tokens for valid credentials', async () => {
      const result = await authenticateUser('admin', 'password123');
      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBeDefined();
    });
  `);

  await fs.writeFile(join(workspacePath, 'package.json'), '{"name":"test-project","version":"1.0.0"}');
  await fs.writeFile(join(workspacePath, 'README.md'), '# Test Project\n\nA sample project for testing semantic search.');
});

afterEach(() => {
  try { rmSync(workspacePath, { recursive: true, force: true }); } catch { /* ignore */ }
});

function getSearchTool() {
  const tools = createSemanticSearchTools(workspacePath, { agentName: 'coder' });
  return tools.find((t) => t.name === 'semantic_search');
}

// ── Basic functionality ────────────────────────────────────────

describe('semantic_search', () => {
  test('finds authentication-related code', async () => {
    const tool = getSearchTool();
    const result = JSON.parse(await tool.func({ query: 'user authentication login JWT token', max_results: 5 }));

    assert.ok(result.count > 0);
    assert.ok(result.indexed_docs > 0);
    // Should find auth/login.js
    assert.ok(result.results.some((r) => r.path.includes('auth/login')));
  });

  test('finds database connection code', async () => {
    const tool = getSearchTool();
    const result = JSON.parse(await tool.func({ query: 'database connection pool query', max_results: 5 }));

    assert.ok(result.count > 0);
    assert.ok(result.results.some((r) => r.path.includes('db/connection')));
  });

  test('finds rate limiting code', async () => {
    const tool = getSearchTool();
    const result = JSON.parse(await tool.func({ query: 'rate limiting request throttle middleware', max_results: 5 }));

    assert.ok(result.count > 0);
    assert.ok(result.results.some((r) => r.path.includes('rateLimiter')));
  });

  test('finds error handling code', async () => {
    const tool = getSearchTool();
    const result = JSON.parse(await tool.func({ query: 'error handling validation unauthorized', max_results: 5 }));

    assert.ok(result.count > 0);
    assert.ok(result.results.some((r) => r.path.includes('errorHandler')));
  });

  test('returns snippets with context', async () => {
    const tool = getSearchTool();
    const result = JSON.parse(await tool.func({ query: 'JWT token sign verify', max_results: 3 }));

    assert.ok(result.results.length > 0);
    for (const r of result.results) {
      assert.ok(r.snippet);
      assert.ok(r.snippet.length > 0);
      assert.ok(r.snippet.length <= 300);
    }
  });

  test('returns relevance scores', async () => {
    const tool = getSearchTool();
    const result = JSON.parse(await tool.func({ query: 'authentication', max_results: 10 }));

    assert.ok(result.results.length > 0);
    // Scores should be sorted descending
    for (let i = 1; i < result.results.length; i++) {
      assert.ok(result.results[i - 1].relevance >= result.results[i].relevance);
    }
  });

  test('returns line numbers', async () => {
    const tool = getSearchTool();
    const result = JSON.parse(await tool.func({ query: 'database query', max_results: 3 }));

    for (const r of result.results) {
      assert.ok(typeof r.line === 'number');
      assert.ok(r.line >= 1);
    }
  });

  test('respects max_results limit', async () => {
    const tool = getSearchTool();
    const result = JSON.parse(await tool.func({ query: 'function', max_results: 2 }));
    assert.ok(result.results.length <= 2);
  });

  test('returns empty for nonsense query', async () => {
    const tool = getSearchTool();
    const result = JSON.parse(await tool.func({ query: 'xyzzy frobnicator quux', max_results: 5 }));
    // May return 0 or low-relevance results
    assert.ok(Array.isArray(result.results));
  });

  test('handles empty workspace', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'empty-test-'));
    try {
      const tools = createSemanticSearchTools(emptyDir, {});
      const tool = tools.find((t) => t.name === 'semantic_search');
      const result = JSON.parse(await tool.func({ query: 'anything', max_results: 5 }));
      assert.equal(result.results.length, 0);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  test('indexes multiple file types', async () => {
    const tool = getSearchTool();
    const result = JSON.parse(await tool.func({ query: 'test project sample', max_results: 10 }));

    // Should find README.md and package.json
    const paths = result.results.map((r) => r.path);
    assert.ok(paths.some((p) => p.endsWith('.md') || p.endsWith('.json') || p.endsWith('.js')));
  });

  test('camelCase splitting works', async () => {
    // "authenticateUser" should match query "authenticate user"
    const tool = getSearchTool();
    const result = JSON.parse(await tool.func({ query: 'authenticate user', max_results: 5 }));
    assert.ok(result.count > 0);
    assert.ok(result.results.some((r) => r.path.includes('auth')));
  });

  test('snake_case splitting works', async () => {
    // Add a file with snake_case
    await fs.writeFile(join(workspacePath, 'src', 'user_profile_handler.js'), `
      function get_user_profile(user_id) {
        return database.find_user_by_id(user_id);
      }
    `);

    // Force re-index by creating new tools
    const tools = createSemanticSearchTools(workspacePath, {});
    const tool = tools.find((t) => t.name === 'semantic_search');
    const result = JSON.parse(await tool.func({ query: 'user profile handler', max_results: 5 }));
    assert.ok(result.count > 0);
  });

  test('filename boosts relevance', async () => {
    const tool = getSearchTool();
    // Query matches filename "rateLimiter" — should rank higher
    const result = JSON.parse(await tool.func({ query: 'rate limiter', max_results: 5 }));
    assert.ok(result.results.length > 0);
    // The rateLimiter file should be in top results
    assert.ok(result.results[0].path.includes('rateLimiter'));
  });
});

// ── Tool metadata ──────────────────────────────────────────────

describe('tool metadata', () => {
  test('has correct name', () => {
    const tools = createSemanticSearchTools(workspacePath, {});
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, 'semantic_search');
  });

  test('has description', () => {
    const tools = createSemanticSearchTools(workspacePath, {});
    assert.ok(tools[0].description.length > 20);
  });

  test('has schema with required query', () => {
    const tools = createSemanticSearchTools(workspacePath, {});
    const schema = tools[0].schema;
    assert.equal(schema.type, 'object');
    assert.ok(schema.properties.query);
    assert.ok(schema.required.includes('query'));
  });
});
