/**
 * Lazy Library Loader
 * Defers loading of heavy CDN libraries (highlight.js, KaTeX, Mermaid)
 * until they're actually needed — typically when the first message is rendered.
 *
 * Saves ~200-400ms on initial page load by not parsing/executing these
 * libraries until a code block, math equation, or diagram appears.
 */

const loaded = new Map();

/**
 * Load a script from a URL, returning a promise that resolves when loaded.
 * Deduplicates concurrent requests for the same URL.
 * @param {string} url
 * @param {string} [integrity]
 * @returns {Promise<void>}
 */
function loadScript(url, integrity) {
  if (loaded.has(url)) return loaded.get(url);

  const promise = new Promise((resolve, reject) => {
    // Check if already in DOM (e.g. from HTML)
    const existing = document.querySelector(`script[src="${url}"]`);
    if (existing) {
      // Already loaded or loading — wait for it
      if (existing.dataset.loaded === '1') { resolve(); return; }
      existing.addEventListener('load', () => { existing.dataset.loaded = '1'; resolve(); });
      existing.addEventListener('error', reject);
      return;
    }

    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    if (integrity) {
      script.integrity = integrity;
      script.crossOrigin = 'anonymous';
    }
    script.addEventListener('load', () => { script.dataset.loaded = '1'; resolve(); });
    script.addEventListener('error', () => reject(new Error(`Failed to load: ${url}`)));
    document.head.appendChild(script);
  });

  loaded.set(url, promise);
  return promise;
}

/**
 * Load a stylesheet from a URL.
 * @param {string} url
 * @param {string} [integrity]
 * @returns {Promise<void>}
 */
function loadStylesheet(url, integrity) {
  if (loaded.has(url)) return loaded.get(url);

  const promise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`link[href="${url}"]`);
    if (existing) { resolve(); return; }

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = url;
    if (integrity) {
      link.integrity = integrity;
      link.crossOrigin = 'anonymous';
    }
    link.addEventListener('load', resolve);
    link.addEventListener('error', () => reject(new Error(`Failed to load: ${url}`)));
    document.head.appendChild(link);
  });

  loaded.set(url, promise);
  return promise;
}

// ── Library URLs & Integrity Hashes ────────────────────────────

const HLJS_JS = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js';
const HLJS_JS_INTEGRITY = 'sha384-F/bZzf7p3Joyp5psL90p/p89AZJsndkSoGwRpXcZhleCWhd8SnRuoYo4d0yirjJp';
const HLJS_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css';
const HLJS_CSS_INTEGRITY = 'sha384-wH75j6z1lH97ZOpMOInqhgKzFkAInZPPSPlZpYKYTOqsaizPvhQZmAtLcPKXpLyH';

const KATEX_JS = 'https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js';
const KATEX_JS_INTEGRITY = 'sha384-XjKyOOlGwcjNTAIQHIpgOno0Hl1YQqzUOEleOLALmuqehneUG+vnGctmUb0ZY0l8';
const KATEX_CSS = 'https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css';
const KATEX_CSS_INTEGRITY = 'sha384-n8MVd4RsNIU0tAv4ct0nTaAbDJwPJzDEaqSD1odI+WdtXRGWt2kTvGFasHpSy3SV';

const MERMAID_JS = 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js';
const MERMAID_JS_INTEGRITY = 'sha384-enVdc7lTHDGtpROV85t9+VqPC2EyyB0hsRD0MrvQnHUsHmTHIz2D8SPP4EnBkstH';

// ── Public API ─────────────────────────────────────────────────

/** Ensure highlight.js is loaded. Call before using `hljs`. */
export async function ensureHighlightJs() {
  await Promise.all([
    loadStylesheet(HLJS_CSS, HLJS_CSS_INTEGRITY),
    loadScript(HLJS_JS, HLJS_JS_INTEGRITY),
  ]);
}

/** Ensure KaTeX is loaded. Call before using `katex`. */
export async function ensureKatex() {
  await Promise.all([
    loadStylesheet(KATEX_CSS, KATEX_CSS_INTEGRITY),
    loadScript(KATEX_JS, KATEX_JS_INTEGRITY),
  ]);
}

/** Ensure Mermaid is loaded. Call before using `mermaid`. */
export async function ensureMermaid() {
  await loadScript(MERMAID_JS, MERMAID_JS_INTEGRITY);
}

/**
 * Preload all rendering libraries in the background.
 * Call this after the first user interaction or when idle.
 */
export function preloadRenderingLibs() {
  // Use requestIdleCallback if available, otherwise setTimeout
  const schedule = typeof requestIdleCallback === 'function'
    ? requestIdleCallback
    : (fn) => setTimeout(fn, 200);

  schedule(() => {
    ensureHighlightJs().catch(() => {});
    ensureKatex().catch(() => {});
    ensureMermaid().catch(() => {});
  });
}
