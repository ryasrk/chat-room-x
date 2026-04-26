/**
 * LangChain Structured Tools — Utility Operations
 *
 * General-purpose tools that enhance agent accuracy and capabilities.
 * Inspired by NullClaw's calculator and image_info tools.
 *
 *   - calculator:   Precise mathematical operations (arithmetic, statistics, logarithms)
 *   - image_info:   Read image file metadata (format, dimensions, size)
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { promises as fs } from 'fs';
import { join, extname } from 'path';
import { safePath } from '../fileTools.js';

// ── Calculator Constants ───────────────────────────────────────
const MAX_EXACT_INTEGER = Number.MAX_SAFE_INTEGER; // 9,007,199,254,740,991

// ── Calculator Operations ──────────────────────────────────────

const OPERATIONS = {
  // Arithmetic
  add:       (vals) => vals.reduce((a, b) => a + b, 0),
  subtract:  (vals) => vals.reduce((a, b) => a - b),
  multiply:  (vals) => vals.reduce((a, b) => a * b, 1),
  divide:    (vals) => { if (vals[1] === 0) throw new Error('Division by zero'); return vals[0] / vals[1]; },
  mod:       (vals) => { if (vals[1] === 0) throw new Error('Modulo by zero'); return vals[0] % vals[1]; },
  pow:       (vals) => Math.pow(vals[0], vals[1]),
  sqrt:      (vals) => { if (vals[0] < 0) throw new Error('Square root of negative number'); return Math.sqrt(vals[0]); },

  // Logarithms & Exponentials
  log:       (vals) => { if (vals[0] <= 0) throw new Error('Log of non-positive number'); return Math.log10(vals[0]); },
  log_base:  (vals) => { if (vals[0] <= 0 || vals[1] <= 0 || vals[1] === 1) throw new Error('Invalid log_base args'); return Math.log(vals[0]) / Math.log(vals[1]); },
  ln:        (vals) => { if (vals[0] <= 0) throw new Error('Ln of non-positive number'); return Math.log(vals[0]); },
  exp:       (vals) => Math.exp(vals[0]),

  // Rounding
  abs:       (vals) => Math.abs(vals[0]),
  floor:     (vals) => Math.floor(vals[0]),
  ceil:      (vals) => Math.ceil(vals[0]),
  round:     (vals) => Math.round(vals[0]),

  // Statistics
  average:   (vals) => vals.reduce((a, b) => a + b, 0) / vals.length,
  median:    (vals) => {
    const sorted = [...vals].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  },
  variance:  (vals) => {
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    return vals.reduce((sum, v) => sum + (v - mean) ** 2, 0) / vals.length;
  },
  stdev_population: (vals) => {
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    return Math.sqrt(vals.reduce((sum, v) => sum + (v - mean) ** 2, 0) / vals.length);
  },
  stdev_sample: (vals) => {
    if (vals.length < 2) throw new Error('Sample stdev requires at least 2 values');
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    return Math.sqrt(vals.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (vals.length - 1));
  },
  min:       (vals) => Math.min(...vals),
  max:       (vals) => Math.max(...vals),
  count:     (vals) => vals.length,
  sum:       (vals) => vals.reduce((a, b) => a + b, 0),
  percentile: null, // handled separately (needs percentile_rank)
};

function computePercentile(vals, rank) {
  if (rank < 0 || rank > 100) throw new Error('Percentile rank must be 0-100');
  const sorted = [...vals].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const idx = (rank / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  // Linear interpolation
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower);
}

/**
 * Format a number for display — avoid unnecessary precision.
 */
function formatResult(value) {
  if (Number.isInteger(value) && Math.abs(value) <= MAX_EXACT_INTEGER) {
    return value.toString();
  }
  // Use fixed notation for reasonable numbers, scientific for very large/small
  if (Math.abs(value) >= 1e-6 && Math.abs(value) < 1e15) {
    const fixed = value.toFixed(10).replace(/\.?0+$/, '');
    return fixed;
  }
  return value.toExponential(6);
}

// ── Image Format Detection ─────────────────────────────────────

const IMAGE_SIGNATURES = [
  { magic: Buffer.from([0x89, 0x50, 0x4E, 0x47]), format: 'PNG' },
  { magic: Buffer.from([0xFF, 0xD8, 0xFF]),        format: 'JPEG' },
  { magic: Buffer.from('GIF87a'),                   format: 'GIF' },
  { magic: Buffer.from('GIF89a'),                   format: 'GIF' },
  { magic: Buffer.from('RIFF'),                     format: 'WebP', extra: { offset: 8, bytes: Buffer.from('WEBP') } },
  { magic: Buffer.from([0x42, 0x4D]),               format: 'BMP' },
];

function detectImageFormat(buffer) {
  for (const sig of IMAGE_SIGNATURES) {
    if (buffer.length >= sig.magic.length && buffer.subarray(0, sig.magic.length).equals(sig.magic)) {
      if (sig.extra) {
        const { offset, bytes } = sig.extra;
        if (buffer.length >= offset + bytes.length && buffer.subarray(offset, offset + bytes.length).equals(bytes)) {
          return sig.format;
        }
        continue;
      }
      return sig.format;
    }
  }
  return null;
}

/**
 * Extract dimensions from image header bytes.
 */
function getImageDimensions(buffer, format) {
  try {
    switch (format) {
      case 'PNG': {
        if (buffer.length < 24) return null;
        const width = buffer.readUInt32BE(16);
        const height = buffer.readUInt32BE(20);
        return { width, height };
      }
      case 'JPEG': {
        // Scan for SOF0/SOF2 markers
        let offset = 2;
        while (offset < buffer.length - 8) {
          if (buffer[offset] !== 0xFF) break;
          const marker = buffer[offset + 1];
          // SOF0 (0xC0) or SOF2 (0xC2)
          if (marker === 0xC0 || marker === 0xC2) {
            const height = buffer.readUInt16BE(offset + 5);
            const width = buffer.readUInt16BE(offset + 7);
            return { width, height };
          }
          // Skip to next marker
          const segLen = buffer.readUInt16BE(offset + 2);
          offset += 2 + segLen;
        }
        return null;
      }
      case 'GIF': {
        if (buffer.length < 10) return null;
        const width = buffer.readUInt16LE(6);
        const height = buffer.readUInt16LE(8);
        return { width, height };
      }
      case 'WebP': {
        // VP8 chunk starts at offset 12
        if (buffer.length < 30) return null;
        const chunk = buffer.subarray(12, 16).toString('ascii');
        if (chunk === 'VP8 ' && buffer.length >= 30) {
          const width = buffer.readUInt16LE(26) & 0x3FFF;
          const height = buffer.readUInt16LE(28) & 0x3FFF;
          return { width, height };
        }
        if (chunk === 'VP8L' && buffer.length >= 25) {
          const bits = buffer.readUInt32LE(21);
          const width = (bits & 0x3FFF) + 1;
          const height = ((bits >> 14) & 0x3FFF) + 1;
          return { width, height };
        }
        return null;
      }
      case 'BMP': {
        if (buffer.length < 26) return null;
        const width = buffer.readInt32LE(18);
        const height = Math.abs(buffer.readInt32LE(22));
        return { width, height };
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

const EXT_TO_FORMAT = {
  '.png': 'PNG', '.jpg': 'JPEG', '.jpeg': 'JPEG', '.gif': 'GIF',
  '.webp': 'WebP', '.bmp': 'BMP', '.svg': 'SVG', '.ico': 'ICO',
  '.tiff': 'TIFF', '.tif': 'TIFF', '.avif': 'AVIF',
};

// ── Tool Factory ───────────────────────────────────────────────

/**
 * Create utility tools for the agent room.
 *
 * @param {string} workspacePath - Absolute path to workspace
 * @param {Object} context
 * @returns {DynamicStructuredTool[]}
 */
export function createUtilityTools(workspacePath, context = {}) {
  const tools = [];

  // ── calculator ─────────────────────────────────────────────
  tools.push(new DynamicStructuredTool({
    name: 'calculator',
    description:
      'Perform precise mathematical calculations. ' +
      'Operations: add, subtract, multiply, divide, mod, pow, sqrt, ' +
      'log (base 10), log_base (custom base), ln (natural), exp, ' +
      'abs, floor, ceil, round, ' +
      'average, median, variance, stdev_population, stdev_sample, ' +
      'min, max, count, sum, percentile. ' +
      'Use this instead of mental math for accuracy.',
    schema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          description: 'The calculation to perform.',
        },
        values: {
          type: 'array',
          description: 'Numeric values. For binary ops (divide, pow, log_base): [left, right]. For stats: all data points.',
        },
        percentile_rank: {
          type: 'number',
          description: 'Percentile rank 0-100 (required for percentile operation).',
        },
      },
      required: ['operation', 'values'],
    },
    func: async ({ operation, values, percentile_rank }) => {
      try {
        if (!operation || typeof operation !== 'string') {
          return JSON.stringify({ error: 'Missing or invalid operation' });
        }
        if (!Array.isArray(values) || values.length === 0) {
          return JSON.stringify({ error: 'values must be a non-empty array of numbers' });
        }

        const nums = values.map((v) => {
          const n = Number(v);
          if (isNaN(n)) throw new Error(`Invalid number: ${v}`);
          return n;
        });

        const op = operation.toLowerCase();

        if (op === 'percentile') {
          const rank = Number(percentile_rank);
          if (isNaN(rank)) return JSON.stringify({ error: 'percentile_rank is required for percentile operation' });
          const result = computePercentile(nums, rank);
          return JSON.stringify({ operation: op, values: nums, percentile_rank: rank, result: formatResult(result) });
        }

        const fn = OPERATIONS[op];
        if (!fn) {
          return JSON.stringify({ error: `Unknown operation: ${op}. Available: ${Object.keys(OPERATIONS).filter(k => k !== 'percentile').join(', ')}` });
        }

        // Validate minimum values for binary operations
        const binaryOps = new Set(['subtract', 'divide', 'mod', 'pow', 'log_base']);
        if (binaryOps.has(op) && nums.length < 2) {
          return JSON.stringify({ error: `${op} requires at least 2 values` });
        }

        const result = fn(nums);

        // Precision warning
        let warning;
        if (Number.isFinite(result) && Math.abs(result) > MAX_EXACT_INTEGER) {
          warning = 'Result exceeds safe integer range — may have precision loss';
        }

        return JSON.stringify({
          operation: op,
          values: nums,
          result: formatResult(result),
          ...(warning ? { warning } : {}),
        });
      } catch (err) {
        return JSON.stringify({ error: err.message, operation, values });
      }
    },
  }));

  // ── image_info ─────────────────────────────────────────────
  tools.push(new DynamicStructuredTool({
    name: 'image_info',
    description:
      'Read image file metadata: format, dimensions (width × height), and file size. ' +
      'Supports PNG, JPEG, GIF, WebP, BMP. ' +
      'Use to inspect images in the workspace before processing.',
    schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path to the image file within the workspace.',
        },
      },
      required: ['path'],
    },
    func: async ({ path: filePath }) => {
      try {
        // safePath returns absolute path or throws for traversal
        let fullPath;
        try {
          fullPath = safePath(workspacePath, filePath);
        } catch {
          return JSON.stringify({ error: 'Path outside workspace' });
        }
        if (!fullPath) return JSON.stringify({ error: 'Path outside workspace' });

        const stat = await fs.stat(fullPath);

        if (!stat.isFile()) return JSON.stringify({ error: 'Not a file' });
        if (stat.size > 50 * 1024 * 1024) return JSON.stringify({ error: 'File too large (>50 MB)' });

        // Read first 64 KB for header analysis
        const fd = await fs.open(fullPath, 'r');
        const headerBuf = Buffer.alloc(Math.min(stat.size, 65536));
        await fd.read(headerBuf, 0, headerBuf.length, 0);
        await fd.close();

        const detectedFormat = detectImageFormat(headerBuf);
        const ext = extname(filePath).toLowerCase();
        const format = detectedFormat || EXT_TO_FORMAT[ext] || 'unknown';
        const dimensions = detectedFormat ? getImageDimensions(headerBuf, detectedFormat) : null;

        const relativePath = fullPath.startsWith(workspacePath)
          ? fullPath.slice(workspacePath.length).replace(/^\//, '')
          : filePath;

        return JSON.stringify({
          path: relativePath,
          format,
          width: dimensions?.width || null,
          height: dimensions?.height || null,
          size_bytes: stat.size,
          size_human: stat.size < 1024 ? `${stat.size} B`
            : stat.size < 1024 * 1024 ? `${(stat.size / 1024).toFixed(1)} KB`
            : `${(stat.size / (1024 * 1024)).toFixed(1)} MB`,
        });
      } catch (err) {
        return JSON.stringify({ error: err.message, path: filePath });
      }
    },
  }));

  return tools;
}
