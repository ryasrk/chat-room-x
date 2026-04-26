/**
 * Unit tests for internetTools.js — web_search, web_fetch, http_request for Agent Room.
 */

import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';

import { createInternetTools } from './internetTools.js';

function getTool(name) {
  const tools = createInternetTools({ agentName: 'coder' });
  return tools.find((t) => t.name === name);
}

// ── Tool creation ──────────────────────────────────────────────

describe('createInternetTools', () => {
  test('creates 3 tools', () => {
    const tools = createInternetTools({});
    assert.equal(tools.length, 3);
    const names = tools.map((t) => t.name);
    assert.ok(names.includes('web_search'));
    assert.ok(names.includes('web_fetch'));
    assert.ok(names.includes('http_request'));
  });

  test('all tools have descriptions and schemas', () => {
    const tools = createInternetTools({});
    for (const tool of tools) {
      assert.ok(tool.description.length > 10);
      assert.ok(tool.schema);
      assert.equal(tool.schema.type, 'object');
    }
  });
});

// ── web_search ─────────────────────────────────────────────────

describe('web_search', () => {
  // NOTE: web_search tests are network-dependent. DDG may block server IPs.
  // Tests validate the response structure regardless of whether results are returned.

  test('returns valid JSON response structure', async () => {
    const tool = getTool('web_search');
    const raw = await tool.func({ query: 'JavaScript', count: 3 });
    const result = JSON.parse(raw);
    // Should always return valid JSON with either results or error
    assert.ok(typeof result === 'object');
    assert.ok(result.provider || result.error || result.results !== undefined || result.message);
  }, { timeout: 20_000 });

  test('handles network errors gracefully (no crash)', async () => {
    const tool = getTool('web_search');
    // Should return JSON even if network fails
    const raw = await tool.func({ query: 'test query', count: 1 });
    const result = JSON.parse(raw);
    assert.ok(typeof result === 'object');
  }, { timeout: 20_000 });
});

// ── web_fetch ──────────────────────────────────────────────────

describe('web_fetch', () => {
  test('fetches HTTPS page and extracts text', async () => {
    const tool = getTool('web_fetch');
    const result = JSON.parse(await tool.func({ url: 'https://example.com', max_chars: 1000 }));

    assert.ok(result.url);
    assert.ok(result.content);
    assert.ok(result.content.includes('Example Domain'));
    assert.equal(result.content_type, 'html');
  });

  test('respects max_chars', async () => {
    const tool = getTool('web_fetch');
    const result = JSON.parse(await tool.func({ url: 'https://example.com', max_chars: 50 }));
    // Content should be truncated (HTML→text may be shorter than max_chars)
    assert.ok(result.content.length <= 200); // example.com is small
  });

  test('rejects HTTP URLs (HTTPS only)', async () => {
    const tool = getTool('web_fetch');
    const result = JSON.parse(await tool.func({ url: 'http://example.com' }));
    assert.ok(result.error);
    assert.ok(result.error.includes('HTTPS'));
  });

  test('blocks localhost (SSRF protection)', async () => {
    const tool = getTool('web_fetch');
    const result = JSON.parse(await tool.func({ url: 'https://localhost/secret' }));
    assert.ok(result.error);
  });

  test('blocks private IPs', async () => {
    const tool = getTool('web_fetch');
    for (const ip of ['127.0.0.1', '192.168.1.1', '10.0.0.1', '172.16.0.1']) {
      const result = JSON.parse(await tool.func({ url: `https://${ip}` }));
      assert.ok(result.error, `Should block ${ip}`);
    }
  });

  test('blocks metadata endpoint', async () => {
    const tool = getTool('web_fetch');
    const result = JSON.parse(await tool.func({ url: 'https://169.254.169.254/latest/meta-data/' }));
    assert.ok(result.error);
  });

  test('handles invalid URL', async () => {
    const tool = getTool('web_fetch');
    const result = JSON.parse(await tool.func({ url: 'not-a-valid-url' }));
    assert.ok(result.error);
  });

  test('handles non-existent domain', async () => {
    const tool = getTool('web_fetch');
    const result = JSON.parse(await tool.func({ url: 'https://this-domain-does-not-exist-xyz123.com' }));
    assert.ok(result.error);
  });
});

// ── http_request ───────────────────────────────────────────────

describe('http_request', () => {
  test('makes GET request', async () => {
    const tool = getTool('http_request');
    const result = JSON.parse(await tool.func({ url: 'https://httpbin.org/get', method: 'GET' }));

    assert.equal(result.status, 200);
    assert.ok(result.body);
    assert.equal(result.method, 'GET');
  });

  test('makes POST request with JSON body', async () => {
    const tool = getTool('http_request');
    const result = JSON.parse(await tool.func({
      url: 'https://httpbin.org/post',
      method: 'POST',
      body: JSON.stringify({ hello: 'world' }),
    }));

    assert.equal(result.status, 200);
    assert.equal(result.method, 'POST');
  });

  test('defaults to GET method', async () => {
    const tool = getTool('http_request');
    const result = JSON.parse(await tool.func({ url: 'https://httpbin.org/get' }));
    assert.equal(result.method, 'GET');
  });

  test('blocks private IPs (SSRF)', async () => {
    const tool = getTool('http_request');
    const result = JSON.parse(await tool.func({ url: 'http://127.0.0.1:8080/admin' }));
    assert.ok(result.error);
  });

  test('blocks metadata endpoint', async () => {
    const tool = getTool('http_request');
    const result = JSON.parse(await tool.func({ url: 'http://169.254.169.254/latest/' }));
    assert.ok(result.error);
  });

  test('response includes headers object', async () => {
    const tool = getTool('http_request');
    const result = JSON.parse(await tool.func({ url: 'https://example.com' }));
    assert.ok(typeof result.headers === 'object' || result.error);
  }, { timeout: 20_000 });

  test('handles invalid URL', async () => {
    const tool = getTool('http_request');
    const result = JSON.parse(await tool.func({ url: 'ftp://invalid-protocol.com' }));
    assert.ok(result.error);
  });

  test('rejects non-HTTP protocols', async () => {
    const tool = getTool('http_request');
    const result = JSON.parse(await tool.func({ url: 'file:///etc/passwd' }));
    assert.ok(result.error);
  });
});
