/**
 * Advanced Markdown Renderer for Chat Dashboard
 * XSS-safe rendering with code highlighting, LaTeX math, tables,
 * thinking blocks, mermaid diagrams, and streaming-safe partial parsing.
 *
 * External dependencies (loaded globally via CDN):
 *   - hljs       (highlight.js)
 *   - katex      (KaTeX)
 *   - mermaid    (Mermaid)
 *
 * Security: Two-layer XSS protection:
 *   1. escapeHtml() runs FIRST on raw input
 *   2. DOMPurify sanitizes final HTML output (defense-in-depth)
 */

import DOMPurify from 'dompurify';

// Configure DOMPurify — allow safe HTML elements used by our renderer
const PURIFY_CONFIG = {
  ALLOWED_TAGS: [
    'p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'span', 'div',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li', 'blockquote', 'hr', 'a',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'details', 'summary',
    'sup', 'sub', 'mark',
    // KaTeX elements
    'math', 'semantics', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub',
    'mfrac', 'mover', 'munder', 'msqrt', 'mtext', 'annotation',
  ],
  ALLOWED_ATTR: [
    'class', 'id', 'href', 'target', 'rel', 'title', 'aria-label',
    'data-lang', 'data-mermaid', 'open', 'colspan', 'rowspan',
    'style', // KaTeX uses inline styles
  ],
  ALLOW_DATA_ATTR: false,
  ADD_ATTR: ['target'],
};

// ── HTML entity escaping (XSS layer — runs FIRST) ─────────────

const ENTITY_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (ch) => ENTITY_MAP[ch]);
}

// ── Sentinel helpers ───────────────────────────────────────────
// We replace protected regions with unique sentinels so later regex
// passes don't corrupt them.
// H3 fix: sentinels are now scoped per-render via a context object
// to prevent concurrent render corruption.

function createSentinelContext() {
  return { counter: 0, map: new Map() };
}

function sentinel(html, ctx) {
  const key = `\x00SENTINEL_${ctx.counter++}\x00`;
  ctx.map.set(key, html);
  return key;
}

function restoreSentinels(text, ctx) {
  let result = text;
  // Iterate until no sentinels remain (handles nested)
  let safety = 0;
  while (result.includes('\x00SENTINEL_') && safety++ < 200) {
    for (const [key, value] of ctx.map) {
      if (result.includes(key)) {
        result = result.split(key).join(value);
        ctx.map.delete(key);
      }
    }
  }
  return result;
}

// ── Thinking block extraction ──────────────────────────────────

/**
 * Strip <think>…</think> blocks, returning separated thinking and content.
 * Handles streaming where the closing tag may not yet exist.
 */
export function stripThinking(text) {
  const thinkRegex = /<think>([\s\S]*?)<\/think>/gi;
  const parts = [];
  let match;
  while ((match = thinkRegex.exec(text)) !== null) {
    parts.push(match[1].trim());
  }

  // Handle unclosed <think> at end of streaming text
  const unclosedMatch = text.match(/<think>([\s\S]*)$/i);
  if (unclosedMatch && !/<\/think>/i.test(unclosedMatch[0])) {
    parts.push(unclosedMatch[1].trim());
  }

  const content = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/i, '') // remove unclosed trailing think
    .trim();

  return {
    thinking: parts.join('\n\n'),
    content,
  };
}

/**
 * Render thinking blocks as collapsible <details> elements.
 */
export function renderThinkingBlock(text) {
  const { thinking } = stripThinking(text);
  if (!thinking) return '';

  const thinkingCtx = createSentinelContext();
  const rendered = renderInlineMarkdown(escapeHtml(thinking), thinkingCtx);
  const restoredRendered = restoreSentinels(rendered, thinkingCtx);
  return (
    '<details class="thinking-block">' +
    '<summary class="thinking-summary">Thinking...</summary>' +
    `<div class="thinking-content">${restoredRendered}</div>` +
    '</details>'
  );
}

// ── Code highlighting ──────────────────────────────────────────

/**
 * Syntax-highlight a code string. Falls back to escaped plain text.
 */
export function highlightCode(code, language) {
  const escaped = escapeHtml(code);

  if (typeof hljs === 'undefined') {
    return `<code class="hljs">${escaped}</code>`;
  }

  try {
    if (language && hljs.getLanguage(language)) {
      const result = hljs.highlight(code, { language, ignoreIllegals: true });
      return `<code class="hljs language-${escapeHtml(language)}">${result.value}</code>`;
    }
    const result = hljs.highlightAuto(code);
    return `<code class="hljs">${result.value}</code>`;
  } catch {
    return `<code class="hljs">${escaped}</code>`;
  }
}

// ── Fenced code blocks (``` … ```) ────────────────────────────

const MERMAID_ID_PREFIX = 'mermaid-';
let _mermaidCounter = 0;

function renderCodeBlocks(text, ctx) {
  // Match complete fenced code blocks
  return text.replace(
    /```(\w*)\n([\s\S]*?)```/g,
    (_match, lang, code) => {
      const trimmed = code.replace(/\n$/, '');
      const langLower = lang.toLowerCase();

      // Mermaid diagram
      if (langLower === 'mermaid') {
        const id = `${MERMAID_ID_PREFIX}${_mermaidCounter++}`;
        const escapedCode = escapeHtml(trimmed);
        return sentinel(
          `<div class="mermaid-container">` +
          `<pre class="mermaid" id="${id}">${escapedCode}</pre>` +
          `</div>`,
          ctx
        );
      }

      const highlighted = highlightCode(trimmed, langLower || undefined);
      const langLabel = langLower ? `<span class="code-lang">${escapeHtml(langLower)}</span>` : '';
      // H2 fix: use data-copy attribute instead of inline onclick handler
      return sentinel(
        `<div class="code-block-wrapper">` +
        (langLabel ? `<div class="code-block-header">${langLabel}</div>` : '') +
        `<pre class="code-block">${highlighted}<button class="copy-btn" data-copy>Copy</button></pre>` +
        `</div>`,
        ctx
      );
    }
  );
}

/**
 * Handle unclosed code blocks at end of streaming text.
 * Shows them as in-progress code blocks.
 */
function renderPartialCodeBlock(text, ctx) {
  const unclosedMatch = text.match(/```(\w*)\n([\s\S]*)$/);
  if (!unclosedMatch) return text;

  const lang = unclosedMatch[1].toLowerCase();
  const code = unclosedMatch[2];
  const highlighted = highlightCode(code, lang || undefined);
  const langLabel = lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : '';

  const before = text.slice(0, unclosedMatch.index);
  const block =
    `<div class="code-block-wrapper streaming">` +
    (langLabel ? `<div class="code-block-header">${langLabel}<span class="streaming-indicator">…</span></div>` : '') +
    `<pre class="code-block">${highlighted}</pre>` +
    `</div>`;

  return before + sentinel(block, ctx);
}

// ── LaTeX math rendering ───────────────────────────────────────

/**
 * Render LaTeX expressions using KaTeX.
 * Handles both $$block$$ and $inline$ math.
 */

// Reverse HTML-entity escaping inside math expressions so KaTeX receives
// valid LaTeX (e.g. &#39; → ', &amp; → &, &lt; → <, &gt; → >).
function decodeMathEntities(expr) {
  return expr
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Balance curly braces so stray `}` or unclosed `{` don't break KaTeX.
function balanceBraces(expr) {
  let depth = 0;
  const chars = [];
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    // Skip escaped braces \{ and \}
    if (ch === '\\' && (expr[i + 1] === '{' || expr[i + 1] === '}')) {
      chars.push(ch, expr[i + 1]);
      i++;
      continue;
    }
    if (ch === '{') { depth++; chars.push(ch); }
    else if (ch === '}') {
      if (depth > 0) { depth--; chars.push(ch); }
      // else skip the unmatched }
    } else {
      chars.push(ch);
    }
  }
  // Close any unclosed {
  while (depth-- > 0) chars.push('}');
  return chars.join('');
}

function prepareMathExpr(expr) {
  return balanceBraces(decodeMathEntities(expr.trim()));
}

export function renderMath(text, ctx) {
  if (typeof katex === 'undefined') return text;

  // Block math: $$…$$
  text = text.replace(/\$\$([\s\S]*?)\$\$/g, (_match, expr) => {
    try {
      return sentinel(katex.renderToString(prepareMathExpr(expr), {
        displayMode: true,
        throwOnError: true,
        output: 'htmlAndMathml',
      }), ctx);
    } catch {
      return `<span class="math-error" title="Invalid LaTeX">${escapeHtml(expr.trim())}</span>`;
    }
  });

  // Inline math: $…$ (but not $$ and not inside words like price$10)
  text = text.replace(/(?<!\$|\w)\$(?!\$)((?:[^$\\]|\\.)+?)\$(?!\$|\d)/g, (_match, expr) => {
    try {
      return sentinel(katex.renderToString(prepareMathExpr(expr), {
        displayMode: false,
        throwOnError: true,
        output: 'htmlAndMathml',
      }), ctx);
    } catch {
      return `<span class="math-error" title="Invalid LaTeX">${escapeHtml(expr.trim())}</span>`;
    }
  });

  return text;
}

// ── Markdown tables ────────────────────────────────────────────

/**
 * Parse and render a markdown table string to HTML <table>.
 */
export function renderTable(text, ctx) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return text;

  const parseRow = (line) =>
    line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());

  // Detect alignment row (second line with ---/:--- etc.)
  const isSeparator = (line) => /^\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/.test(line);

  if (!isSeparator(lines[1])) return text;

  const headers = parseRow(lines[0]);
  const aligns = parseRow(lines[1]).map((cell) => {
    if (cell.startsWith(':') && cell.endsWith(':')) return 'center';
    if (cell.endsWith(':')) return 'right';
    return 'left';
  });

  let html = '<div class="table-wrapper"><table class="md-table"><thead><tr>';
  for (let i = 0; i < headers.length; i++) {
    const align = aligns[i] || 'left';
    html += `<th style="text-align:${align}">${renderInlineMarkdown(headers[i], ctx)}</th>`;
  }
  html += '</tr></thead><tbody>';

  for (let r = 2; r < lines.length; r++) {
    if (!lines[r].trim()) continue;
    const cells = parseRow(lines[r]);
    html += '<tr>';
    for (let i = 0; i < headers.length; i++) {
      const align = aligns[i] || 'left';
      const cellContent = cells[i] !== undefined ? cells[i] : '';
      html += `<td style="text-align:${align}">${renderInlineMarkdown(cellContent, ctx)}</td>`;
    }
    html += '</tr>';
  }

  html += '</tbody></table></div>';
  return html;
}

function renderTables(text, ctx) {
  // Match blocks of lines that look like a table
  return text.replace(
    /((?:^\|.+\|$\n?){2,})/gm,
    (tableBlock) => sentinel(renderTable(tableBlock, ctx), ctx)
  );
}

// ── Inline markdown transforms ─────────────────────────────────

function renderInlineMarkdown(text, ctx) {
  // Inline code (protect first)
  text = text.replace(/`([^`]+)`/g, (_m, code) =>
    sentinel(`<code class="inline-code">${escapeHtml(code)}</code>`, ctx)
  );

  // Bold + italic
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  // Bold
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic
  text = text.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
  // Strikethrough
  text = text.replace(/~~(.+?)~~/g, '<del>$1</del>');

  // C2 fix: Auto-linkify URLs — strip trailing punctuation that's not part of the URL
  text = text.replace(
    /(?<!")(?<!')\b(https?:\/\/[^\s<>\])"']+?)([.,)!?:;]*)(?=\s|$|<)/g,
    (_match, url, trailing) => {
      const safeUrl = escapeHtml(url);
      return sentinel(`<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeUrl}</a>`, ctx) + trailing;
    }
  );

  return text;
}

// ── Block-level markdown ───────────────────────────────────────

function renderBlockElements(text, ctx) {
  const lines = text.split('\n');
  const result = [];
  let inList = false;
  let listType = null;
  let listItems = [];

  function flushList() {
    if (!inList) return;
    const tag = listType === 'ol' ? 'ol' : 'ul';
    result.push(`<${tag}>${listItems.join('')}</${tag}>`);
    listItems = [];
    inList = false;
    listType = null;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Headings
    const headingMatch = line.match(/^(#{2,4})\s+(.+)$/);
    if (headingMatch) {
      flushList();
      const level = headingMatch[1].length;
      result.push(`<h${level}>${renderInlineMarkdown(headingMatch[2], ctx)}</h${level}>`);
      continue;
    }

    // Horizontal rule
    if (/^-{3,}$/.test(line.trim()) || /^\*{3,}$/.test(line.trim()) || /^_{3,}$/.test(line.trim())) {
      flushList();
      result.push('<hr>');
      continue;
    }

    // Blockquote
    if (line.startsWith('&gt; ') || line.startsWith('&gt;')) {
      flushList();
      const quoteContent = line.replace(/^&gt;\s?/, '');
      // Collect consecutive blockquote lines
      let quoteBlock = quoteContent;
      while (i + 1 < lines.length && (lines[i + 1].startsWith('&gt; ') || lines[i + 1].startsWith('&gt;'))) {
        i++;
        quoteBlock += '\n' + lines[i].replace(/^&gt;\s?/, '');
      }
      result.push(`<blockquote>${renderInlineMarkdown(quoteBlock, ctx)}</blockquote>`);
      continue;
    }

    // Unordered list
    const ulMatch = line.match(/^(\s*)[-*+]\s+(.+)$/);
    if (ulMatch) {
      if (!inList || listType !== 'ul') {
        flushList();
        inList = true;
        listType = 'ul';
      }
      listItems.push(`<li>${renderInlineMarkdown(ulMatch[2], ctx)}</li>`);
      continue;
    }

    // Ordered list
    const olMatch = line.match(/^(\s*)\d+\.\s+(.+)$/);
    if (olMatch) {
      if (!inList || listType !== 'ol') {
        flushList();
        inList = true;
        listType = 'ol';
      }
      listItems.push(`<li>${renderInlineMarkdown(olMatch[2], ctx)}</li>`);
      continue;
    }

    // Regular line
    flushList();
    if (line.trim() === '') {
      result.push('');
    } else {
      result.push(renderInlineMarkdown(line, ctx));
    }
  }

  flushList();
  return result.join('\n');
}

// ── Paragraph wrapping ─────────────────────────────────────────

function wrapParagraphs(html) {
  // Split on double newlines and wrap plain text groups in <p>
  const blocks = html.split(/\n{2,}/);
  return blocks
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return '';
      // Don't wrap if it's already a block-level element
      if (/^<(?:h[1-6]|ul|ol|li|blockquote|hr|pre|div|table|details|p)/i.test(trimmed)) {
        return trimmed;
      }
      // Don't wrap sentinels that resolve to block elements
      if (/^\x00SENTINEL_\d+\x00$/.test(trimmed)) {
        return trimmed;
      }
      return `<p>${trimmed.replace(/\n/g, '<br>')}</p>`;
    })
    .join('\n');
}

// ── Mermaid post-render ────────────────────────────────────────

function triggerMermaidRender() {
  if (typeof mermaid === 'undefined') return;
  try {
    mermaid.run({ querySelector: '.mermaid:not([data-processed])' });
  } catch {
    // silently ignore — mermaid may not be initialized yet
  }
}

// ── Main render pipeline ───────────────────────────────────────

/**
 * Render a markdown string (typically an LLM response) to safe HTML.
 * Handles streaming partial text gracefully.
 *
 * @param {string} text  Raw markdown text
 * @returns {string}     Sanitized HTML string
 */
export function renderMarkdown(text) {
  if (!text) return '';

  // H3 fix: create a per-render sentinel context
  const ctx = createSentinelContext();

  // 1. Extract thinking blocks
  const thinkingHtml = renderThinkingBlock(text);
  const { content } = stripThinking(text);

  // 2. Escape HTML entities FIRST (XSS protection)
  let html = escapeHtml(content);

  // 3. Fenced code blocks (before other transforms to protect contents)
  html = renderCodeBlocks(html, ctx);
  html = renderPartialCodeBlock(html, ctx);

  // 4. Math rendering (before inline transforms eat the $)
  html = renderMath(html, ctx);

  // 5. Tables
  html = renderTables(html, ctx);

  // 6. Block-level elements (headings, lists, blockquotes, hr)
  html = renderBlockElements(html, ctx);

  // 7. Paragraph wrapping
  html = wrapParagraphs(html);

  // 8. Restore all protected regions
  html = restoreSentinels(html, ctx);

  // 9. Prepend thinking block if present
  if (thinkingHtml) {
    html = thinkingHtml + html;
  }

  // 10. DOMPurify sanitization (defense-in-depth — catches anything escapeHtml missed)
  html = DOMPurify.sanitize(html, PURIFY_CONFIG);

  // 11. Schedule mermaid rendering (next tick so DOM is updated)
  queueMicrotask(triggerMermaidRender);

  return html;
}
