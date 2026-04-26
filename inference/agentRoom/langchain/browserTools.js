/**
 * LangChain Structured Tools — Browser Automation
 *
 * Gives agents the ability to interact with web pages using Playwright.
 * Inspired by GitHub Copilot's browser tools (open_browser_page, read_page,
 * click_element, type_in_page, screenshot_page).
 *
 *   - browser_open:      Open a URL and get page content/snapshot
 *   - browser_click:     Click an element by CSS selector or text
 *   - browser_type:      Type text into an input field
 *   - browser_screenshot: Capture a screenshot of the page
 *   - browser_read:      Read the current page content as text
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { join } from 'path';

// ── Constants ──────────────────────────────────────────────────
const BROWSER_TIMEOUT_MS = 30_000;
const MAX_PAGE_TEXT_LENGTH = 50_000;
const SCREENSHOT_DIR = 'screenshots';

// ── Lazy Playwright loader ─────────────────────────────────────
// Playwright is heavy — only import when first needed
let _playwright = null;
let _browser = null;
let _context = null;
let _page = null;

async function getPlaywright() {
  if (!_playwright) {
    try {
      _playwright = await import('playwright');
    } catch {
      try {
        // Fallback: try playwright-core
        _playwright = await import('playwright-core');
      } catch {
        throw new Error(
          'Playwright is not installed. Run: npx playwright install chromium'
        );
      }
    }
  }
  return _playwright;
}

async function ensureBrowser() {
  if (_browser?.isConnected()) return;

  const pw = await getPlaywright();
  _browser = await pw.chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
    ],
  });
  _context = await _browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
  });
}

async function ensurePage() {
  await ensureBrowser();
  if (!_page || _page.isClosed()) {
    _page = await _context.newPage();
  }
  return _page;
}

/**
 * Extract readable text from the page.
 */
async function extractPageText(page, maxLength = MAX_PAGE_TEXT_LENGTH) {
  const text = await page.evaluate(() => {
    // Remove non-content elements
    const remove = document.querySelectorAll('script, style, nav, header, footer, aside, noscript, iframe, svg');
    remove.forEach((el) => el.remove());
    return document.body?.innerText || '';
  });
  return text.slice(0, maxLength);
}

/**
 * Get a structured snapshot of interactive elements on the page.
 */
async function getPageSnapshot(page) {
  return page.evaluate(() => {
    const elements = [];
    const selectors = 'a, button, input, textarea, select, [role="button"], [onclick]';
    const els = document.querySelectorAll(selectors);
    let count = 0;
    for (const el of els) {
      if (count >= 50) break; // Limit to 50 interactive elements
      const tag = el.tagName.toLowerCase();
      const text = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').trim().slice(0, 80);
      const href = el.getAttribute('href') || '';
      const type = el.getAttribute('type') || '';
      const name = el.getAttribute('name') || '';
      const id = el.id || '';
      const classes = el.className?.toString().slice(0, 60) || '';

      if (!text && !href && !name && !id) continue;

      let selector = tag;
      if (id) selector = `#${id}`;
      else if (name) selector = `${tag}[name="${name}"]`;
      else if (text && tag === 'button') selector = `button:has-text("${text.slice(0, 30)}")`;
      else if (href) selector = `a[href="${href.slice(0, 80)}"]`;

      elements.push({ tag, text, href: href.slice(0, 100), type, selector, id, name });
      count++;
    }
    return {
      title: document.title,
      url: location.href,
      elements,
    };
  });
}

// ── SSRF Protection ────────────────────────────────────────────
const BLOCKED_HOSTS = new Set([
  'localhost', '127.0.0.1', '0.0.0.0', '::1',
  'metadata.google.internal', '169.254.169.254',
]);

function isBlockedUrl(urlStr) {
  try {
    const url = new URL(urlStr);
    if (BLOCKED_HOSTS.has(url.hostname)) return true;
    const prefixes = ['10.', '172.16.', '172.17.', '172.18.', '172.19.', '172.20.',
      '172.21.', '172.22.', '172.23.', '172.24.', '172.25.', '172.26.',
      '172.27.', '172.28.', '172.29.', '172.30.', '172.31.', '192.168.'];
    return prefixes.some((p) => url.hostname.startsWith(p));
  } catch {
    return true;
  }
}

// ── Cleanup on process exit ────────────────────────────────────
process.on('exit', () => { _browser?.close().catch(() => {}); });
process.on('SIGINT', () => { _browser?.close().catch(() => {}); process.exit(); });

// ── Tool Factory ───────────────────────────────────────────────

/**
 * Create browser automation tools for the agent room.
 *
 * @param {string} workspacePath - Absolute path to workspace (for screenshots)
 * @param {Object} context
 * @returns {DynamicStructuredTool[]}
 */
export function createBrowserTools(workspacePath, context = {}) {
  const tools = [];

  // ── browser_open ───────────────────────────────────────────
  tools.push(new DynamicStructuredTool({
    name: 'browser_open',
    description:
      'Open a URL in a headless browser and return the page content and interactive elements. ' +
      'Use for pages that require JavaScript rendering (SPAs, dynamic content). ' +
      'For simple static pages, prefer web_fetch instead.',
    schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'URL to open (http or https).',
        },
        wait_for: {
          type: 'string',
          description: 'Optional CSS selector to wait for before reading content.',
        },
      },
      required: ['url'],
    },
    func: async ({ url, wait_for }) => {
      try {
        if (isBlockedUrl(url)) return JSON.stringify({ error: `Blocked URL: ${url}` });

        const page = await ensurePage();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: BROWSER_TIMEOUT_MS });

        if (wait_for) {
          try { await page.waitForSelector(wait_for, { timeout: 10_000 }); } catch { /* continue */ }
        }

        // Wait a bit for JS to render
        await page.waitForTimeout(1000);

        const text = await extractPageText(page);
        const snapshot = await getPageSnapshot(page);

        return JSON.stringify({
          url: page.url(),
          title: snapshot.title,
          text: text.slice(0, 30_000),
          interactive_elements: snapshot.elements.slice(0, 30),
          element_count: snapshot.elements.length,
        });
      } catch (err) {
        return JSON.stringify({ error: err.message, url });
      }
    },
  }));

  // ── browser_click ──────────────────────────────────────────
  tools.push(new DynamicStructuredTool({
    name: 'browser_click',
    description:
      'Click an element on the current browser page. Use CSS selector or text content to identify the element. ' +
      'Call browser_open first to load a page.',
    schema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector of the element to click (e.g., "#submit-btn", "button.primary").',
        },
        text: {
          type: 'string',
          description: 'Alternative: click element containing this text.',
        },
      },
    },
    func: async ({ selector, text }) => {
      try {
        const page = await ensurePage();
        if (!page.url() || page.url() === 'about:blank') {
          return JSON.stringify({ error: 'No page loaded. Call browser_open first.' });
        }

        if (text) {
          await page.getByText(text, { exact: false }).first().click({ timeout: 10_000 });
        } else if (selector) {
          await page.click(selector, { timeout: 10_000 });
        } else {
          return JSON.stringify({ error: 'Provide either selector or text.' });
        }

        await page.waitForTimeout(1000);
        const snapshot = await getPageSnapshot(page);

        return JSON.stringify({
          success: true,
          url: page.url(),
          title: snapshot.title,
          interactive_elements: snapshot.elements.slice(0, 20),
        });
      } catch (err) {
        return JSON.stringify({ error: err.message });
      }
    },
  }));

  // ── browser_type ───────────────────────────────────────────
  tools.push(new DynamicStructuredTool({
    name: 'browser_type',
    description:
      'Type text into an input field on the current browser page. ' +
      'Optionally press Enter after typing.',
    schema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector of the input field.',
        },
        text: {
          type: 'string',
          description: 'Text to type into the field.',
        },
        press_enter: {
          type: 'boolean',
          description: 'Press Enter after typing. Default: false.',
          default: false,
        },
      },
      required: ['selector', 'text'],
    },
    func: async ({ selector, text, press_enter = false }) => {
      try {
        const page = await ensurePage();
        if (!page.url() || page.url() === 'about:blank') {
          return JSON.stringify({ error: 'No page loaded. Call browser_open first.' });
        }

        await page.fill(selector, text, { timeout: 10_000 });
        if (press_enter) {
          await page.press(selector, 'Enter');
          await page.waitForTimeout(1500);
        }

        const snapshot = await getPageSnapshot(page);
        return JSON.stringify({
          success: true,
          url: page.url(),
          title: snapshot.title,
        });
      } catch (err) {
        return JSON.stringify({ error: err.message });
      }
    },
  }));

  // ── browser_screenshot ─────────────────────────────────────
  tools.push(new DynamicStructuredTool({
    name: 'browser_screenshot',
    description:
      'Capture a screenshot of the current browser page. ' +
      'Saves to the workspace screenshots/ directory. Returns the file path.',
    schema: {
      type: 'object',
      properties: {
        filename: {
          type: 'string',
          description: 'Filename for the screenshot. Default: screenshot-{timestamp}.png.',
        },
        full_page: {
          type: 'boolean',
          description: 'Capture full scrollable page. Default: false (viewport only).',
          default: false,
        },
      },
    },
    func: async ({ filename, full_page = false }) => {
      try {
        const page = await ensurePage();
        if (!page.url() || page.url() === 'about:blank') {
          return JSON.stringify({ error: 'No page loaded. Call browser_open first.' });
        }

        const { promises: fs } = await import('fs');
        const screenshotDir = join(workspacePath, SCREENSHOT_DIR);
        await fs.mkdir(screenshotDir, { recursive: true });

        const fname = filename || `screenshot-${Date.now()}.png`;
        const filePath = join(screenshotDir, fname);

        await page.screenshot({ path: filePath, fullPage: full_page });

        return JSON.stringify({
          success: true,
          path: `${SCREENSHOT_DIR}/${fname}`,
          url: page.url(),
          title: await page.title(),
        });
      } catch (err) {
        return JSON.stringify({ error: err.message });
      }
    },
  }));

  // ── browser_read ───────────────────────────────────────────
  tools.push(new DynamicStructuredTool({
    name: 'browser_read',
    description:
      'Read the current browser page content as text. ' +
      'Returns the visible text and interactive elements. ' +
      'Use after browser_click or browser_type to see updated content.',
    schema: {
      type: 'object',
      properties: {
        max_chars: {
          type: 'number',
          description: 'Maximum characters to return. Default: 30000.',
          default: 30000,
        },
      },
    },
    func: async ({ max_chars = 30_000 }) => {
      try {
        const page = await ensurePage();
        if (!page.url() || page.url() === 'about:blank') {
          return JSON.stringify({ error: 'No page loaded. Call browser_open first.' });
        }

        const text = await extractPageText(page, max_chars);
        const snapshot = await getPageSnapshot(page);

        return JSON.stringify({
          url: page.url(),
          title: snapshot.title,
          text,
          interactive_elements: snapshot.elements.slice(0, 30),
        });
      } catch (err) {
        return JSON.stringify({ error: err.message });
      }
    },
  }));

  return tools;
}
