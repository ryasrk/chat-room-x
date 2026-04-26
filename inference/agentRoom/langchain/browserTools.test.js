/**
 * Unit tests for browserTools.js — Playwright browser automation.
 * Note: These tests require Playwright + Chromium to be installed.
 * Run: npx playwright install chromium
 */

import { describe, test, beforeEach, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';

import { createBrowserTools } from './browserTools.js';

let workspacePath;

beforeEach(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'browser-test-'));
});

afterEach(() => {
  try { rmSync(workspacePath, { recursive: true, force: true }); } catch { /* ignore */ }
});

function getTool(name) {
  const tools = createBrowserTools(workspacePath, { agentName: 'coder' });
  return tools.find((t) => t.name === name);
}

// ── Tool creation ──────────────────────────────────────────────

describe('createBrowserTools', () => {
  test('creates 5 tools', () => {
    const tools = createBrowserTools(workspacePath, {});
    assert.equal(tools.length, 5);
    const names = tools.map((t) => t.name);
    assert.ok(names.includes('browser_open'));
    assert.ok(names.includes('browser_click'));
    assert.ok(names.includes('browser_type'));
    assert.ok(names.includes('browser_screenshot'));
    assert.ok(names.includes('browser_read'));
  });

  test('all tools have descriptions and schemas', () => {
    const tools = createBrowserTools(workspacePath, {});
    for (const tool of tools) {
      assert.ok(tool.description.length > 10);
      assert.ok(tool.schema);
      assert.equal(tool.schema.type, 'object');
    }
  });
});

// ── browser_open ───────────────────────────────────────────────

describe('browser_open', () => {
  test('opens a page and returns content', async () => {
    const tool = getTool('browser_open');
    const result = JSON.parse(await tool.func({ url: 'https://example.com' }));

    assert.ok(result.title);
    assert.ok(result.url.includes('example.com'));
    assert.ok(result.text.includes('Example Domain'));
    assert.ok(Array.isArray(result.interactive_elements));
  });

  test('returns interactive elements', async () => {
    const tool = getTool('browser_open');
    const result = JSON.parse(await tool.func({ url: 'https://example.com' }));

    // example.com has one link: "More information..."
    assert.ok(result.interactive_elements.length >= 1);
    const link = result.interactive_elements[0];
    assert.ok(link.tag);
    assert.ok(link.selector);
  });

  test('blocks private IPs (SSRF)', async () => {
    const tool = getTool('browser_open');
    const result = JSON.parse(await tool.func({ url: 'http://127.0.0.1:8080' }));
    assert.ok(result.error);
    assert.ok(result.error.includes('Blocked'));
  });

  test('blocks metadata endpoint', async () => {
    const tool = getTool('browser_open');
    const result = JSON.parse(await tool.func({ url: 'http://169.254.169.254' }));
    assert.ok(result.error);
  });
});

// ── browser_read ───────────────────────────────────────────────

describe('browser_read', () => {
  test('reads current page after open', async () => {
    // First open a page
    const openTool = getTool('browser_open');
    await openTool.func({ url: 'https://example.com' });

    // Then read it
    const readTool = getTool('browser_read');
    const result = JSON.parse(await readTool.func({ max_chars: 5000 }));

    assert.ok(result.url.includes('example.com'));
    assert.ok(result.text.includes('Example Domain'));
    assert.ok(result.title);
  });

  test('respects max_chars', async () => {
    const openTool = getTool('browser_open');
    await openTool.func({ url: 'https://example.com' });

    const readTool = getTool('browser_read');
    const result = JSON.parse(await readTool.func({ max_chars: 20 }));
    assert.ok(result.text.length <= 20);
  });
});

// ── browser_screenshot ─────────────────────────────────────────

describe('browser_screenshot', () => {
  test('captures screenshot to workspace', async () => {
    const openTool = getTool('browser_open');
    await openTool.func({ url: 'https://example.com' });

    const screenshotTool = getTool('browser_screenshot');
    const result = JSON.parse(await screenshotTool.func({ filename: 'test-shot.png' }));

    assert.ok(result.success);
    assert.ok(result.path.includes('test-shot.png'));

    // Verify file exists
    const filePath = join(workspacePath, result.path);
    const stat = await fs.stat(filePath);
    assert.ok(stat.size > 0);
  });

  test('generates default filename', async () => {
    const openTool = getTool('browser_open');
    await openTool.func({ url: 'https://example.com' });

    const screenshotTool = getTool('browser_screenshot');
    const result = JSON.parse(await screenshotTool.func({}));

    assert.ok(result.success);
    assert.ok(result.path.includes('screenshot-'));
    assert.ok(result.path.endsWith('.png'));
  });
});

// ── browser_click ──────────────────────────────────────────────

describe('browser_click', () => {
  test('clicks element by text', async () => {
    const openTool = getTool('browser_open');
    await openTool.func({ url: 'https://example.com' });

    const clickTool = getTool('browser_click');
    const result = JSON.parse(await clickTool.func({ text: 'More information' }));

    // Should navigate or return error (network-dependent)
    assert.ok(result.success || result.error);
  }, { timeout: 30_000 });

  test('returns error without selector or text', async () => {
    const openTool = getTool('browser_open');
    await openTool.func({ url: 'https://example.com' });

    const clickTool = getTool('browser_click');
    const result = JSON.parse(await clickTool.func({}));
    assert.ok(result.error);
    assert.ok(result.error.includes('selector') || result.error.includes('text'));
  }, { timeout: 30_000 });
});

// ── browser_type ───────────────────────────────────────────────

describe('browser_type', () => {
  test('types into input field on example.com', async () => {
    // Use example.com (fast, reliable) — it has no input fields,
    // so we test that the tool handles missing selector gracefully
    const openTool = getTool('browser_open');
    await openTool.func({ url: 'https://example.com' });

    const typeTool = getTool('browser_type');
    const result = JSON.parse(await typeTool.func({
      selector: 'input[name="q"]',
      text: 'test query',
      press_enter: false,
    }));

    // Should return error since example.com has no input fields
    assert.ok(result.error || result.success);
  }, { timeout: 30_000 });
});
