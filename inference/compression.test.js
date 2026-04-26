/**
 * Unit tests for compression.js — HTTP response compression.
 */

import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';

import { bestEncoding, sendCompressedJson } from './compression.js';

// ── bestEncoding ───────────────────────────────────────────────

describe('bestEncoding', () => {
  test('prefers Brotli when both accepted', () => {
    const req = { headers: { 'accept-encoding': 'gzip, deflate, br' } };
    assert.equal(bestEncoding(req), 'br');
  });

  test('returns gzip when only gzip accepted', () => {
    const req = { headers: { 'accept-encoding': 'gzip, deflate' } };
    assert.equal(bestEncoding(req), 'gzip');
  });

  test('returns null when no compression accepted', () => {
    const req = { headers: { 'accept-encoding': 'identity' } };
    assert.equal(bestEncoding(req), null);
  });

  test('returns null when header missing', () => {
    assert.equal(bestEncoding({ headers: {} }), null);
    assert.equal(bestEncoding({}), null);
    assert.equal(bestEncoding(null), null);
  });

  test('handles br-only', () => {
    const req = { headers: { 'accept-encoding': 'br' } };
    assert.equal(bestEncoding(req), 'br');
  });
});

// ── sendCompressedJson ─────────────────────────────────────────

describe('sendCompressedJson', () => {
  function createMockRes() {
    const written = { statusCode: null, headers: {}, body: null, ended: false };
    return {
      written,
      writeHead(code, headers) { written.statusCode = code; written.headers = headers; },
      end(data) { written.body = data; written.ended = true; },
    };
  }

  test('sends uncompressed for small payloads', async () => {
    const req = { headers: { 'accept-encoding': 'br, gzip' } };
    const res = createMockRes();
    const data = { hello: 'world' };

    await sendCompressedJson(req, res, 200, data);

    assert.equal(res.written.statusCode, 200);
    assert.ok(res.written.headers['Content-Type'].includes('application/json'));
    assert.equal(res.written.headers['Content-Encoding'], undefined); // No compression
    assert.equal(res.written.body, JSON.stringify(data));
  });

  test('compresses large payloads with Brotli', async () => {
    const req = { headers: { 'accept-encoding': 'br, gzip' } };
    const res = createMockRes();
    const data = { content: 'x'.repeat(2000) }; // > 1024 bytes

    await sendCompressedJson(req, res, 200, data);

    assert.equal(res.written.statusCode, 200);
    assert.equal(res.written.headers['Content-Encoding'], 'br');
    assert.equal(res.written.headers['Vary'], 'Accept-Encoding');
    assert.ok(Buffer.isBuffer(res.written.body));
    // Compressed should be smaller than original
    assert.ok(res.written.body.length < JSON.stringify(data).length);
  });

  test('compresses with gzip when Brotli not accepted', async () => {
    const req = { headers: { 'accept-encoding': 'gzip' } };
    const res = createMockRes();
    const data = { content: 'y'.repeat(2000) };

    await sendCompressedJson(req, res, 200, data);

    assert.equal(res.written.headers['Content-Encoding'], 'gzip');
    assert.ok(Buffer.isBuffer(res.written.body));
  });

  test('sends uncompressed when no encoding accepted', async () => {
    const req = { headers: {} };
    const res = createMockRes();
    const data = { content: 'z'.repeat(2000) };

    await sendCompressedJson(req, res, 200, data);

    assert.equal(res.written.headers['Content-Encoding'], undefined);
    assert.equal(typeof res.written.body, 'string');
  });

  test('passes extra headers', async () => {
    const req = { headers: {} };
    const res = createMockRes();

    await sendCompressedJson(req, res, 200, { ok: true }, { 'Cache-Control': 'no-store' });

    assert.equal(res.written.headers['Cache-Control'], 'no-store');
  });

  test('uses correct status code', async () => {
    const req = { headers: {} };
    const res = createMockRes();

    await sendCompressedJson(req, res, 404, { error: 'Not found' });

    assert.equal(res.written.statusCode, 404);
  });

  test('handles empty object', async () => {
    const req = { headers: {} };
    const res = createMockRes();

    await sendCompressedJson(req, res, 200, {});

    assert.equal(res.written.body, '{}');
  });

  test('handles array data', async () => {
    const req = { headers: {} };
    const res = createMockRes();

    await sendCompressedJson(req, res, 200, [1, 2, 3]);

    assert.equal(res.written.body, '[1,2,3]');
  });

  test('handles null data', async () => {
    const req = { headers: {} };
    const res = createMockRes();

    await sendCompressedJson(req, res, 200, null);

    assert.equal(res.written.body, 'null');
  });
});
