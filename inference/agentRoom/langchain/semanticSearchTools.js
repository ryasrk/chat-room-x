/**
 * LangChain Structured Tools — Semantic Code Search
 *
 * Provides meaning-based search across workspace files using TF-IDF scoring.
 * Unlike grep_search (exact text match), semantic_search finds code by concept:
 *   - "authentication logic" → finds auth middleware, JWT validation, login handlers
 *   - "error handling" → finds try/catch blocks, error classes, error middleware
 *   - "database connection" → finds DB config, pool setup, query builders
 *
 * Zero external dependencies — no API keys, no embeddings API, works offline.
 * Uses TF-IDF (Term Frequency × Inverse Document Frequency) with:
 *   - camelCase/snake_case splitting for code tokens
 *   - Comment and string extraction for natural language context
 *   - File path scoring (filename matches boost relevance)
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { promises as fs } from 'fs';
import { join, relative, extname, basename } from 'path';

// ── Constants ──────────────────────────────────────────────────
const MAX_RESULTS = 20;
const MAX_FILE_SIZE = 512 * 1024; // 512 KB
const MAX_FILES = 2000;
const MAX_SNIPPET_LENGTH = 300;
const CHUNK_LINES = 20; // Split files into chunks of N lines for granular results

// Extensions to index
const CODE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.scala',
  '.c', '.cpp', '.h', '.hpp', '.cs',
  '.php', '.swift', '.zig',
  '.html', '.css', '.scss', '.less', '.vue', '.svelte',
  '.json', '.yaml', '.yml', '.toml', '.xml',
  '.md', '.txt', '.rst',
  '.sql', '.sh', '.bash', '.zsh',
  '.dockerfile', '.env.example',
]);

// Directories to skip
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.venv', '__pycache__', '.next',
  'dist', 'build', '.cache', 'coverage', '.tox', 'venv',
  'env', '.mypy_cache', '.pytest_cache', '.ruff_cache',
  '.zig-cache', 'zig-out', 'vendor', 'target',
]);

// Common stop words to ignore in scoring
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'must',
  'and', 'or', 'but', 'if', 'then', 'else', 'when', 'while', 'for',
  'of', 'to', 'in', 'on', 'at', 'by', 'from', 'with', 'as', 'into',
  'this', 'that', 'these', 'those', 'it', 'its',
  'not', 'no', 'nor', 'so', 'too', 'very',
  'var', 'let', 'const', 'function', 'return', 'import', 'export',
  'class', 'new', 'true', 'false', 'null', 'undefined', 'void',
]);

// ── Tokenizer ──────────────────────────────────────────────────

/**
 * Tokenize text for TF-IDF — splits camelCase, snake_case, and natural language.
 */
function tokenize(text) {
  if (!text) return [];

  // Split camelCase and PascalCase: "handleUserAuth" → ["handle", "user", "auth"]
  let expanded = text.replace(/([a-z])([A-Z])/g, '$1 $2');
  // Split snake_case: "user_auth_handler" → ["user", "auth", "handler"]
  expanded = expanded.replace(/_/g, ' ');
  // Split on non-alphanumeric
  expanded = expanded.replace(/[^a-zA-Z0-9]+/g, ' ');

  return expanded
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

// ── TF-IDF Engine ──────────────────────────────────────────────

class TfIdfIndex {
  constructor() {
    this.documents = []; // { path, startLine, tokens, text }
    this.df = new Map(); // term → document frequency
    this.totalDocs = 0;
  }

  /**
   * Add a document chunk to the index.
   */
  addDocument(path, startLine, text) {
    const tokens = tokenize(text);
    if (tokens.length === 0) return;

    const doc = { path, startLine, tokens, text };
    this.documents.push(doc);

    // Update document frequency (count unique terms per doc)
    const uniqueTerms = new Set(tokens);
    for (const term of uniqueTerms) {
      this.df.set(term, (this.df.get(term) || 0) + 1);
    }
    this.totalDocs++;
  }

  /**
   * Search the index with a query. Returns ranked results.
   */
  search(query, maxResults = MAX_RESULTS) {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    const scores = [];

    for (let i = 0; i < this.documents.length; i++) {
      const doc = this.documents[i];
      let score = 0;

      // Compute TF-IDF score for each query term
      for (const qToken of queryTokens) {
        // Term frequency in this document
        let tf = 0;
        for (const dToken of doc.tokens) {
          if (dToken === qToken) tf++;
          // Partial match bonus (prefix matching)
          else if (dToken.startsWith(qToken) || qToken.startsWith(dToken)) tf += 0.3;
        }
        if (tf === 0) continue;

        // Inverse document frequency
        const docFreq = this.df.get(qToken) || 0;
        const idf = docFreq > 0 ? Math.log(this.totalDocs / docFreq) : 0;

        // TF-IDF
        const normalizedTf = tf / doc.tokens.length;
        score += normalizedTf * idf;
      }

      // Filename match bonus — if query terms appear in the file path
      const pathTokens = tokenize(doc.path);
      for (const qToken of queryTokens) {
        if (pathTokens.includes(qToken)) score *= 1.5;
      }

      if (score > 0) {
        scores.push({ index: i, score });
      }
    }

    // Sort by score descending
    scores.sort((a, b) => b.score - a.score);

    return scores.slice(0, maxResults).map(({ index, score }) => {
      const doc = this.documents[index];
      // Extract a relevant snippet
      const snippet = extractSnippet(doc.text, queryTokens);
      return {
        path: doc.path,
        line: doc.startLine,
        score: Math.round(score * 1000) / 1000,
        snippet,
      };
    });
  }
}

/**
 * Extract the most relevant snippet from text based on query tokens.
 */
function extractSnippet(text, queryTokens) {
  const lines = text.split('\n');
  let bestLine = 0;
  let bestScore = 0;

  for (let i = 0; i < lines.length; i++) {
    const lineTokens = tokenize(lines[i]);
    let score = 0;
    for (const qt of queryTokens) {
      for (const lt of lineTokens) {
        if (lt === qt) score += 2;
        else if (lt.includes(qt) || qt.includes(lt)) score += 0.5;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestLine = i;
    }
  }

  // Return a few lines around the best match
  const start = Math.max(0, bestLine - 1);
  const end = Math.min(lines.length, bestLine + 4);
  return lines.slice(start, end).join('\n').slice(0, MAX_SNIPPET_LENGTH);
}

// ── File Collector ─────────────────────────────────────────────

async function collectFiles(dir, rootDir, maxDepth = 8, depth = 0) {
  if (depth > maxDepth) return [];
  const results = [];

  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return []; }

  for (const entry of entries) {
    if (entry.name.startsWith('.') && depth > 0) continue;
    if (SKIP_DIRS.has(entry.name)) continue;

    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      const sub = await collectFiles(fullPath, rootDir, maxDepth, depth + 1);
      results.push(...sub);
      if (results.length >= MAX_FILES) break;
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();
      if (!CODE_EXTENSIONS.has(ext) && !entry.name.includes('.')) continue;

      try {
        const stat = await fs.stat(fullPath);
        if (stat.size > MAX_FILE_SIZE) continue;
        results.push(relative(rootDir, fullPath));
      } catch { /* skip */ }

      if (results.length >= MAX_FILES) break;
    }
  }

  return results;
}

// ── Index Cache ────────────────────────────────────────────────
// Cache the index per workspace to avoid re-indexing on every search
const _indexCache = new Map(); // workspacePath → { index, timestamp }
const INDEX_TTL_MS = 60_000; // Re-index after 60 seconds

async function getOrBuildIndex(workspacePath) {
  const cached = _indexCache.get(workspacePath);
  if (cached && Date.now() - cached.timestamp < INDEX_TTL_MS) {
    return cached.index;
  }

  const index = new TfIdfIndex();
  const files = await collectFiles(workspacePath, workspacePath);

  for (const filePath of files) {
    try {
      const content = await fs.readFile(join(workspacePath, filePath), 'utf-8');
      const lines = content.split('\n');

      // Index in chunks for granular results
      for (let i = 0; i < lines.length; i += CHUNK_LINES) {
        const chunk = lines.slice(i, i + CHUNK_LINES).join('\n');
        if (chunk.trim()) {
          index.addDocument(filePath, i + 1, chunk);
        }
      }
    } catch { /* skip unreadable files */ }
  }

  _indexCache.set(workspacePath, { index, timestamp: Date.now() });
  return index;
}

// ── Tool Factory ───────────────────────────────────────────────

/**
 * Create semantic search tools for the agent room.
 *
 * @param {string} workspacePath - Absolute path to workspace
 * @param {Object} context
 * @returns {DynamicStructuredTool[]}
 */
export function createSemanticSearchTools(workspacePath, context = {}) {
  const tools = [];

  // ── semantic_search ────────────────────────────────────────
  tools.push(new DynamicStructuredTool({
    name: 'semantic_search',
    description:
      'Search workspace code by meaning, not just exact text. ' +
      'Finds code related to a concept even if the exact words don\'t appear. ' +
      'Examples: "authentication logic", "error handling", "database queries", ' +
      '"API rate limiting", "file upload processing". ' +
      'Use this when grep_search doesn\'t find what you need, or when you want ' +
      'to understand how a concept is implemented across the codebase.',
    schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural language description of what you\'re looking for. Be descriptive.',
        },
        max_results: {
          type: 'number',
          description: 'Maximum results to return (1-20). Default: 10.',
          default: 10,
        },
      },
      required: ['query'],
    },
    func: async ({ query, max_results = 10 }) => {
      try {
        const maxR = Math.min(Math.max(max_results || 10, 1), MAX_RESULTS);
        const index = await getOrBuildIndex(workspacePath);

        const results = index.search(query, maxR);

        if (results.length === 0) {
          return JSON.stringify({
            query,
            results: [],
            message: `No semantic matches found for: "${query}". Try grep_search for exact text matches.`,
            indexed_docs: index.totalDocs,
          });
        }

        return JSON.stringify({
          query,
          count: results.length,
          indexed_docs: index.totalDocs,
          results: results.map((r) => ({
            path: r.path,
            line: r.line,
            relevance: r.score,
            snippet: r.snippet,
          })),
        });
      } catch (err) {
        return JSON.stringify({ error: err.message, query });
      }
    },
  }));

  return tools;
}
