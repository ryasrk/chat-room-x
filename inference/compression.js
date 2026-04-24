/**
 * HTTP Response Compression Utility
 * Supports Brotli (preferred, ~14-21% smaller than gzip) with gzip fallback.
 * Only compresses responses above a size threshold.
 */

import { brotliCompress, gzip, constants } from 'zlib';
import { promisify } from 'util';

const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

/** Brotli quality level 4 — faster than gzip with smaller output */
const BROTLI_OPTIONS = {
  params: {
    [constants.BROTLI_PARAM_QUALITY]: 4,
  },
};

/** Minimum response size (bytes) to bother compressing */
const MIN_COMPRESS_SIZE = 1024;

/**
 * Determine the best compression encoding the client accepts.
 * Prefers Brotli over gzip.
 * @param {import('http').IncomingMessage} req
 * @returns {'br' | 'gzip' | null}
 */
export function bestEncoding(req) {
  const accept = req?.headers?.['accept-encoding'] || '';
  if (accept.includes('br')) return 'br';
  if (accept.includes('gzip')) return 'gzip';
  return null;
}

/** @deprecated Use bestEncoding() instead */
export function acceptsGzip(req) {
  const accept = req?.headers?.['accept-encoding'] || '';
  return accept.includes('gzip');
}

/**
 * Compress a buffer using the specified encoding.
 * @param {Buffer} buf
 * @param {'br' | 'gzip'} encoding
 * @returns {Promise<Buffer>}
 */
async function compress(buf, encoding) {
  if (encoding === 'br') return brotliAsync(buf, BROTLI_OPTIONS);
  return gzipAsync(buf);
}

/**
 * Send a JSON response with Brotli/gzip compression.
 * Falls back to uncompressed if the client doesn't accept either
 * or the payload is too small to benefit from compression.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {number} statusCode
 * @param {any} data
 * @param {Record<string, string>} [extraHeaders]
 */
export async function sendCompressedJson(req, res, statusCode, data, extraHeaders = {}) {
  const json = JSON.stringify(data);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    ...extraHeaders,
  };

  const encoding = bestEncoding(req);

  if (json.length >= MIN_COMPRESS_SIZE && encoding) {
    try {
      const compressed = await compress(Buffer.from(json, 'utf-8'), encoding);
      headers['Content-Encoding'] = encoding;
      headers['Content-Length'] = String(compressed.length);
      headers['Vary'] = 'Accept-Encoding';
      res.writeHead(statusCode, headers);
      res.end(compressed);
      return;
    } catch {
      // Fall through to uncompressed on error
    }
  }

  headers['Content-Length'] = String(Buffer.byteLength(json, 'utf-8'));
  res.writeHead(statusCode, headers);
  res.end(json);
}
