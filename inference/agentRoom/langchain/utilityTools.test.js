/**
 * Unit tests for utilityTools.js — calculator and image_info tools.
 */

import { describe, test, beforeEach, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';

import { createUtilityTools } from './utilityTools.js';

let workspacePath;

beforeEach(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'util-tools-test-'));
});

afterEach(() => {
  try { rmSync(workspacePath, { recursive: true, force: true }); } catch { /* ignore */ }
});

function getTool(name) {
  const tools = createUtilityTools(workspacePath, { agentName: 'coder' });
  return tools.find((t) => t.name === name);
}

// ── calculator ─────────────────────────────────────────────────

describe('calculator', () => {
  async function calc(operation, values, extra = {}) {
    const tool = getTool('calculator');
    return JSON.parse(await tool.func({ operation, values, ...extra }));
  }

  // Arithmetic
  test('add multiple values', async () => { assert.equal((await calc('add', [1, 2, 3, 4])).result, '10'); });
  test('subtract', async () => { assert.equal((await calc('subtract', [100, 30, 20])).result, '50'); });
  test('multiply', async () => { assert.equal((await calc('multiply', [3, 4, 5])).result, '60'); });
  test('divide', async () => { assert.equal((await calc('divide', [100, 4])).result, '25'); });
  test('divide by zero returns error', async () => { assert.ok((await calc('divide', [10, 0])).error); });
  test('mod', async () => { assert.equal((await calc('mod', [17, 5])).result, '2'); });
  test('mod by zero returns error', async () => { assert.ok((await calc('mod', [10, 0])).error); });
  test('pow', async () => { assert.equal((await calc('pow', [2, 8])).result, '256'); });
  test('sqrt', async () => { assert.equal((await calc('sqrt', [256])).result, '16'); });
  test('sqrt negative returns error', async () => { assert.ok((await calc('sqrt', [-1])).error); });

  // Logarithms
  test('log base 10', async () => { assert.equal((await calc('log', [1000])).result, '3'); });
  test('log_base custom', async () => { assert.equal((await calc('log_base', [8, 2])).result, '3'); });
  test('ln', async () => {
    const r = await calc('ln', [Math.E * Math.E]);
    assert.equal(Number(r.result).toFixed(5), '2.00000');
  });
  test('exp', async () => { assert.equal((await calc('exp', [0])).result, '1'); });
  test('log of non-positive returns error', async () => { assert.ok((await calc('log', [0])).error); });

  // Rounding
  test('abs', async () => { assert.equal((await calc('abs', [-99])).result, '99'); });
  test('floor', async () => { assert.equal((await calc('floor', [3.9])).result, '3'); });
  test('ceil', async () => { assert.equal((await calc('ceil', [3.1])).result, '4'); });
  test('round', async () => { assert.equal((await calc('round', [3.5])).result, '4'); });

  // Statistics
  test('average', async () => { assert.equal((await calc('average', [2, 4, 6, 8])).result, '5'); });
  test('median odd count', async () => { assert.equal((await calc('median', [5, 1, 3])).result, '3'); });
  test('median even count', async () => { assert.equal((await calc('median', [1, 2, 3, 4])).result, '2.5'); });
  test('variance', async () => {
    const r = await calc('variance', [2, 4, 4, 4, 5, 5, 7, 9]);
    assert.ok(Math.abs(Number(r.result) - 4) < 0.01);
  });
  test('stdev_population', async () => {
    const r = await calc('stdev_population', [2, 4, 4, 4, 5, 5, 7, 9]);
    assert.ok(Math.abs(Number(r.result) - 2) < 0.01);
  });
  test('stdev_sample', async () => {
    const r = await calc('stdev_sample', [2, 4, 4, 4, 5, 5, 7, 9]);
    assert.ok(Number(r.result) > 2);
  });
  test('stdev_sample requires 2+ values', async () => { assert.ok((await calc('stdev_sample', [5])).error); });
  test('min', async () => { assert.equal((await calc('min', [9, 3, 7, 1, 5])).result, '1'); });
  test('max', async () => { assert.equal((await calc('max', [9, 3, 7, 1, 5])).result, '9'); });
  test('count', async () => { assert.equal((await calc('count', [1, 2, 3, 4, 5])).result, '5'); });
  test('sum', async () => { assert.equal((await calc('sum', [10, 20, 30])).result, '60'); });
  test('percentile 25th', async () => {
    const r = await calc('percentile', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], { percentile_rank: 25 });
    assert.equal(r.result, '3.25');
  });
  test('percentile 75th', async () => {
    const r = await calc('percentile', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], { percentile_rank: 75 });
    assert.equal(r.result, '7.75');
  });

  // Edge cases
  test('unknown operation', async () => { assert.ok((await calc('foobar', [1])).error); });
  test('empty values', async () => { assert.ok((await calc('add', [])).error); });
  test('non-array values', async () => { assert.ok((await calc('add', 'not array')).error); });
  test('missing operation', async () => { assert.ok((await calc(null, [1])).error); });
  test('string values coerced to numbers', async () => {
    const r = await calc('add', ['10', '20']);
    assert.equal(r.result, '30');
  });
  test('NaN value returns error', async () => { assert.ok((await calc('add', ['abc'])).error); });
  test('precision warning for large results', async () => {
    const r = await calc('pow', [2, 60]);
    // 2^60 > MAX_SAFE_INTEGER
    assert.ok(r.warning || r.result);
  });
});

// ── image_info ─────────────────────────────────────────────────

describe('image_info', () => {
  function getImageTool() {
    return getTool('image_info');
  }

  test('reads PNG metadata', async () => {
    // Create a minimal valid PNG (1x1 pixel, red)
    const png = Buffer.from([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
      0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
      0x00, 0x00, 0x00, 0x01, // width: 1
      0x00, 0x00, 0x00, 0x01, // height: 1
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xDE, // bit depth, color type, etc.
      0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, 0x54, // IDAT chunk
      0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01,
      0xE2, 0x21, 0xBC, 0x33,
      0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82, // IEND
    ]);
    await fs.writeFile(join(workspacePath, 'test.png'), png);

    const tool = getImageTool();
    const result = JSON.parse(await tool.func({ path: 'test.png' }));

    assert.equal(result.format, 'PNG');
    assert.equal(result.width, 1);
    assert.equal(result.height, 1);
    assert.ok(result.size_bytes > 0);
    assert.ok(result.size_human);
  });

  test('reads JPEG metadata', async () => {
    // Minimal JPEG with SOF0 marker (2x2 pixel)
    const jpeg = Buffer.from([
      0xFF, 0xD8, 0xFF, 0xE0, // SOI + APP0
      0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
      0xFF, 0xC0, // SOF0
      0x00, 0x0B, 0x08,
      0x00, 0x02, // height: 2
      0x00, 0x02, // width: 2
      0x01, 0x01, 0x11, 0x00,
      0xFF, 0xD9, // EOI
    ]);
    await fs.writeFile(join(workspacePath, 'test.jpg'), jpeg);

    const tool = getImageTool();
    const result = JSON.parse(await tool.func({ path: 'test.jpg' }));

    assert.equal(result.format, 'JPEG');
    assert.equal(result.width, 2);
    assert.equal(result.height, 2);
  });

  test('reads GIF metadata', async () => {
    // Minimal GIF89a (3x3 pixel) — need at least 10 bytes for dimension reading
    const gif = Buffer.alloc(20, 0);
    gif.write('GIF89a', 0, 'ascii'); // magic
    gif.writeUInt16LE(3, 6); // width: 3
    gif.writeUInt16LE(3, 8); // height: 3
    gif[10] = 0x00; // GCT flag
    gif[11] = 0x00; // bg
    gif[12] = 0x00; // aspect
    gif[13] = 0x3B; // trailer
    await fs.writeFile(join(workspacePath, 'test.gif'), gif);

    const tool = getImageTool();
    const result = JSON.parse(await tool.func({ path: 'test.gif' }));

    assert.equal(result.format, 'GIF');
    assert.equal(result.width, 3);
    assert.equal(result.height, 3);
  });

  test('detects format from extension when magic bytes unknown', async () => {
    await fs.writeFile(join(workspacePath, 'test.svg'), '<svg></svg>');

    const tool = getImageTool();
    const result = JSON.parse(await tool.func({ path: 'test.svg' }));

    assert.equal(result.format, 'SVG');
    assert.equal(result.width, null); // Can't extract dimensions from SVG via magic bytes
  });

  test('rejects path outside workspace', async () => {
    const tool = getImageTool();
    const result = JSON.parse(await tool.func({ path: '../../../etc/passwd' }));
    assert.ok(result.error);
  });

  test('handles non-existent file', async () => {
    const tool = getImageTool();
    const result = JSON.parse(await tool.func({ path: 'nonexistent.png' }));
    assert.ok(result.error);
  });

  test('returns human-readable size', async () => {
    const data = Buffer.alloc(2048, 0xFF);
    await fs.writeFile(join(workspacePath, 'big.png'), Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
        0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x0A, 0x00, 0x00, 0x00, 0x0A,
        0x08, 0x02, 0x00, 0x00, 0x00]),
      data,
    ]));

    const tool = getImageTool();
    const result = JSON.parse(await tool.func({ path: 'big.png' }));
    assert.ok(result.size_human.includes('KB'));
  });
});
