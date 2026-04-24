/**
 * LangChain Structured Tools — Advanced Workspace Operations
 *
 * Replicates key capabilities from GitHub Copilot's tool system:
 *   - grep_search: Fast text/regex search across workspace files
 *   - file_search: Glob-pattern file discovery
 *   - run_terminal: Sandboxed shell command execution
 *   - manage_todo: Task tracking within agent turns
 *   - read_memory / write_memory: Persistent notes across sessions
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { promises as fs } from 'fs';
import { join, relative, basename, extname } from 'path';
import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { safePath } from '../fileTools.js';
import { assertAgentCanWritePath, getAgentPolicy } from '../agentPolicy.js';

// ── Constants ──────────────────────────────────────────────────
const MAX_GREP_RESULTS = 50;
const MAX_GREP_LINE_LENGTH = 500;
const MAX_FILE_SEARCH_RESULTS = 100;
const MAX_TERMINAL_OUTPUT = 64 * 1024; // 64 KB
const TERMINAL_TIMEOUT_MS = 30_000; // 30 seconds
const MEMORY_DIR = '.memory';
const MAX_MEMORY_FILE_SIZE = 32 * 1024; // 32 KB per memory file
const MAX_MEMORY_FILES = 20;

// Binary/large file extensions to skip during grep
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.pyc', '.pyo', '.class', '.o', '.so', '.dll', '.dylib',
  '.exe', '.bin', '.dat', '.db', '.sqlite',
  '.onnx', '.pt', '.pth', '.h5', '.pb', '.tflite',
  '.lock',
]);

// Directories to skip during search
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.venv', '__pycache__', '.next',
  'dist', 'build', '.cache', 'coverage', '.tox', 'venv',
  'env', '.mypy_cache', '.pytest_cache', '.ruff_cache',
]);

// Blocked terminal commands for security
const BLOCKED_COMMANDS = new Set([
  'rm -rf /', 'rm -rf /*', 'mkfs', 'dd if=', ':(){', 'fork',
  'chmod -R 777 /', 'curl | sh', 'wget | sh', 'curl | bash', 'wget | bash',
]);

const BLOCKED_COMMAND_PREFIXES = [
  'sudo ', 'su ', 'passwd ', 'useradd ', 'userdel ', 'groupadd ',
  'mount ', 'umount ', 'fdisk ', 'mkfs.',
  'systemctl ', 'service ',
  'iptables ', 'ufw ',
  'ssh ', 'scp ',
];

// ── Helpers ────────────────────────────────────────────────────

function shouldSkipFile(filePath) {
  const ext = extname(filePath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

function shouldSkipDir(dirName) {
  return dirName.startsWith('.') || SKIP_DIRS.has(dirName);
}

/**
 * Recursively collect file paths from a directory.
 */
async function collectFiles(dir, rootDir, maxDepth = 8, depth = 0) {
  if (depth > maxDepth) return [];
  const results = [];

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length > 2000) break; // Safety cap

      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name)) continue;
        const subFiles = await collectFiles(fullPath, rootDir, maxDepth, depth + 1);
        results.push(...subFiles);
      } else if (entry.isFile()) {
        results.push(relative(rootDir, fullPath));
      }
    }
  } catch {
    // Permission denied or similar — skip
  }

  return results;
}

/**
 * Simple glob pattern matching (supports *, **, ?)
 */
function matchGlob(filePath, pattern) {
  // Convert glob to regex
  let regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape special regex chars (except * and ?)
    .replace(/\*\*/g, '{{GLOBSTAR}}')       // Placeholder for **
    .replace(/\*/g, '[^/]*')                // * matches anything except /
    .replace(/\?/g, '[^/]')                 // ? matches single char except /
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');    // ** matches anything including /

  return new RegExp(`^${regex}$`, 'i').test(filePath);
}

function isCommandBlocked(command) {
  const trimmed = command.trim();
  if (BLOCKED_COMMANDS.has(trimmed)) return true;
  return BLOCKED_COMMAND_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function trimOutput(output) {
  if (typeof output !== 'string' || output.length <= MAX_TERMINAL_OUTPUT) {
    return output || '';
  }
  return `${output.slice(0, MAX_TERMINAL_OUTPUT)}\n... output truncated (${output.length} bytes total) ...`;
}

// ── Tool Factories ─────────────────────────────────────────────

/**
 * Create advanced workspace tools.
 *
 * @param {string} workspacePath - Absolute path to the agent room workspace
 * @param {Object} context
 * @param {string} context.agentName
 * @param {Object} [context.todoState] - Shared todo state object (mutated in place)
 * @returns {DynamicStructuredTool[]}
 */
export function createAdvancedTools(workspacePath, context = {}) {
  const agentPolicy = getAgentPolicy({
    agentName: context.agentName,
    allowedTools: context.allowedTools,
  });

  // Shared todo state — persists across tool calls within a single agent turn
  const todoState = context.todoState || { items: [] };

  // ── grep_search ────────────────────────────────────────────
  const grepSearchTool = new DynamicStructuredTool({
    name: 'grep_search',
    description:
      'Fast text search across workspace files. Searches file contents for a pattern (plain text or regex). ' +
      'Returns matching lines with file paths and line numbers. ' +
      'Use includePattern to narrow search to specific files or directories (e.g., "src/**/*.js").',
    schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The text or regex pattern to search for. Case-insensitive by default.',
        },
        isRegexp: {
          type: 'boolean',
          description: 'Whether the query is a regular expression. Default: false.',
          default: false,
        },
        includePattern: {
          type: 'string',
          description: 'Optional glob pattern to filter which files to search (e.g., "src/**/*.js", "*.md"). Searches all files if omitted.',
          default: '',
        },
        maxResults: {
          type: 'number',
          description: `Maximum number of matching lines to return. Default: ${MAX_GREP_RESULTS}.`,
          default: MAX_GREP_RESULTS,
        },
      },
      required: ['query'],
    },
    func: async ({ query, isRegexp = false, includePattern = '', maxResults = MAX_GREP_RESULTS }) => {
      try {
        if (!query || typeof query !== 'string') {
          return JSON.stringify({ error: 'Query is required.' });
        }

        let pattern;
        try {
          pattern = isRegexp ? new RegExp(query, 'i') : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        } catch (err) {
          return JSON.stringify({ error: `Invalid regex: ${err.message}` });
        }

        const allFiles = await collectFiles(workspacePath, workspacePath);
        const filesToSearch = includePattern
          ? allFiles.filter((f) => matchGlob(f, includePattern))
          : allFiles;

        const matches = [];
        const cap = Math.min(maxResults, MAX_GREP_RESULTS);

        for (const relPath of filesToSearch) {
          if (matches.length >= cap) break;
          if (shouldSkipFile(relPath)) continue;

          try {
            const fullPath = join(workspacePath, relPath);
            const stat = await fs.stat(fullPath);
            if (stat.size > 1024 * 1024) continue; // Skip files > 1 MB

            const content = await fs.readFile(fullPath, 'utf-8');
            const lines = content.split('\n');

            for (let i = 0; i < lines.length; i++) {
              if (matches.length >= cap) break;
              if (pattern.test(lines[i])) {
                const lineText = lines[i].length > MAX_GREP_LINE_LENGTH
                  ? lines[i].slice(0, MAX_GREP_LINE_LENGTH) + '...'
                  : lines[i];
                matches.push({
                  path: relPath,
                  line: i + 1,
                  content: lineText.trimEnd(),
                });
              }
            }
          } catch {
            // Skip unreadable files
          }
        }

        if (matches.length === 0) {
          return JSON.stringify({ matches: [], message: 'No matches found.' });
        }

        return JSON.stringify({
          matches,
          total: matches.length,
          truncated: matches.length >= cap,
        });
      } catch (error) {
        return JSON.stringify({ error: error.message });
      }
    },
  });

  // ── file_search ────────────────────────────────────────────
  const fileSearchTool = new DynamicStructuredTool({
    name: 'file_search',
    description:
      'Search for files in the workspace by name or glob pattern. ' +
      'Returns matching file paths. Use when you know the filename pattern but not the location. ' +
      'Examples: "*.test.js", "**/*.py", "package.json", "src/**/index.*"',
    schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Glob pattern to match file paths (e.g., "**/*.py", "src/**/index.*", "*.config.js").',
        },
        maxResults: {
          type: 'number',
          description: `Maximum number of results. Default: ${MAX_FILE_SEARCH_RESULTS}.`,
          default: MAX_FILE_SEARCH_RESULTS,
        },
      },
      required: ['query'],
    },
    func: async ({ query, maxResults = MAX_FILE_SEARCH_RESULTS }) => {
      try {
        if (!query || typeof query !== 'string') {
          return JSON.stringify({ error: 'Query pattern is required.' });
        }

        const allFiles = await collectFiles(workspacePath, workspacePath);
        const cap = Math.min(maxResults, MAX_FILE_SEARCH_RESULTS);
        const matches = [];

        for (const relPath of allFiles) {
          if (matches.length >= cap) break;
          // Match against full relative path and also just the filename
          if (matchGlob(relPath, query) || matchGlob(basename(relPath), query)) {
            matches.push(relPath);
          }
        }

        return JSON.stringify({
          files: matches,
          total: matches.length,
          truncated: matches.length >= cap,
        });
      } catch (error) {
        return JSON.stringify({ error: error.message });
      }
    },
  });

  // ── run_in_terminal (Copilot-aligned) ───────────────────────
  const runInTerminalTool = new DynamicStructuredTool({
    name: 'run_in_terminal',
    description:
      'Execute a shell command in the workspace directory. Returns stdout, stderr, and exit code. ' +
      'Use for running build scripts, linters, tests, git commands, npm/yarn, and other CLI tools. ' +
      'Provide an explanation of what the command does — it will be logged for auditability. ' +
      'Commands run with a 30-second timeout by default. Output is capped at 64 KB. ' +
      'Blocked: sudo, system administration, network tools, and destructive commands.',
    schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute (e.g., "npm test", "git status", "ls -la src/").',
        },
        explanation: {
          type: 'string',
          description: 'A one-sentence description of what the command does. Logged for auditability.',
          default: '',
        },
        timeout: {
          type: 'number',
          description: `Timeout in milliseconds. Default: ${TERMINAL_TIMEOUT_MS} (30s). Max: 60000 (60s).`,
          default: TERMINAL_TIMEOUT_MS,
        },
      },
      required: ['command'],
    },
    func: async ({ command, explanation = '', timeout = TERMINAL_TIMEOUT_MS }) => {
      try {
        if (!agentPolicy.canRunTerminal) {
          return JSON.stringify({ error: 'This agent does not have terminal execution permission.' });
        }

        if (!command || typeof command !== 'string') {
          return JSON.stringify({ error: 'Command is required.' });
        }

        const trimmedCommand = command.trim();
        if (!trimmedCommand) {
          return JSON.stringify({ error: 'Command cannot be empty.' });
        }

        if (isCommandBlocked(trimmedCommand)) {
          return JSON.stringify({ error: 'This command is blocked for security reasons.' });
        }

        if (explanation) {
          console.log(`[terminal] ${explanation} → ${trimmedCommand}`);
        }

        const effectiveTimeout = Math.min(Math.max(timeout || TERMINAL_TIMEOUT_MS, 1000), 60_000);

        return new Promise((resolve) => {
          execFile('/bin/sh', ['-c', trimmedCommand], {
            cwd: workspacePath,
            timeout: effectiveTimeout,
            maxBuffer: MAX_TERMINAL_OUTPUT,
            env: {
              ...process.env,
              CI: 'true',
              TERM: 'dumb',
              GIT_TERMINAL_PROMPT: '0',
              GIT_PAGER: 'cat',
              PAGER: 'cat',
            },
          }, (error, stdout, stderr) => {
            const exitCode = error?.code ?? (error ? 1 : 0);
            const timedOut = error?.killed || false;

            resolve(JSON.stringify({
              exitCode,
              stdout: trimOutput(stdout),
              stderr: trimOutput(stderr),
              timedOut,
              command: trimmedCommand,
            }));
          });
        });
      } catch (error) {
        return JSON.stringify({ error: error.message });
      }
    },
  });

  // ── manage_todo_list (Copilot-aligned) ──────────────────────
  const manageTodoListTool = new DynamicStructuredTool({
    name: 'manage_todo_list',
    description:
      'Manage a structured todo list to track progress and plan tasks. ' +
      'Provide the COMPLETE todoList array each time — all items, both existing and new. ' +
      'Each item has id (number), title (string, 3-7 words), and status. ' +
      'Statuses: "not-started", "in-progress" (max 1 at a time), "completed". ' +
      'Mark todos completed as soon as they are done. Do not batch completions.',
    schema: {
      type: 'object',
      properties: {
        todoList: {
          type: 'array',
          description: 'Complete array of ALL todo items. Must include ALL items — both existing and new.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'number', description: 'Unique identifier. Sequential starting from 1.' },
              title: { type: 'string', description: 'Concise action-oriented label (3-7 words).' },
              status: {
                type: 'string',
                enum: ['not-started', 'in-progress', 'completed'],
                description: 'not-started | in-progress (max 1) | completed',
              },
            },
            required: ['id', 'title', 'status'],
          },
        },
      },
      required: ['todoList'],
    },
    func: async ({ todoList }) => {
      try {
        if (!Array.isArray(todoList)) {
          return JSON.stringify({ error: 'todoList array is required.' });
        }
        todoState.items = todoList.map((item, idx) => ({
          id: item.id || idx + 1,
          title: String(item.title || '').trim(),
          status: ['not-started', 'in-progress', 'completed'].includes(item.status) ? item.status : 'not-started',
        }));
        return JSON.stringify({ todoList: todoState.items, message: `Todo list updated with ${todoState.items.length} items.` });
      } catch (error) {
        return JSON.stringify({ error: error.message });
      }
    },
  });

  // ── memory (Copilot-aligned unified tool) ───────────────────
  const memoryTool = new DynamicStructuredTool({
    name: 'memory',
    description:
      'Manage persistent memory notes stored in .memory/ directory. Persists across sessions. ' +
      'Commands: "view" (read file or list directory), "create" (new file, fails if exists), ' +
      '"str_replace" (replace exact string in file), "insert" (insert text at line number), ' +
      '"delete" (remove file). Max 32 KB per file, 20 files total.',
    schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          enum: ['view', 'create', 'str_replace', 'insert', 'delete'],
          description: 'The operation to perform.',
        },
        path: {
          type: 'string',
          description: 'Filename within .memory/ (e.g., "plan.md"). Use "." to list all files with "view".',
          default: '.',
        },
        file_text: {
          type: 'string',
          description: 'Required for "create". The content of the file to create.',
        },
        old_str: {
          type: 'string',
          description: 'Required for "str_replace". The exact string to find (must appear exactly once).',
        },
        new_str: {
          type: 'string',
          description: 'Required for "str_replace". The replacement string.',
        },
        insert_line: {
          type: 'number',
          description: 'Required for "insert". 0-based line number to insert at. 0 = before first line.',
        },
        insert_text: {
          type: 'string',
          description: 'Required for "insert". The text to insert.',
        },
      },
      required: ['command'],
    },
    func: async ({ command, path = '.', file_text, old_str, new_str, insert_line, insert_text }) => {
      try {
        const memoryDir = join(workspacePath, MEMORY_DIR);

        // ── view ──
        if (command === 'view') {
          if (!existsSync(memoryDir)) {
            return JSON.stringify({ files: [], message: 'No memory files exist yet.' });
          }
          if (!path || path === '.') {
            const entries = await fs.readdir(memoryDir, { withFileTypes: true });
            const files = entries.filter((e) => e.isFile()).map((e) => e.name);
            return JSON.stringify({ files, total: files.length });
          }
          const resolved = safePath(memoryDir, basename(path));
          const content = await fs.readFile(resolved, 'utf-8');
          return content;
        }

        // Write commands need doc permission
        if (!agentPolicy.canWriteDocumentation) {
          return JSON.stringify({ error: 'This agent does not have memory write permission.' });
        }

        const fileName = basename(path || '');
        if (!fileName || fileName === '.') {
          return JSON.stringify({ error: 'A filename is required (e.g., "plan.md").' });
        }
        const filePath = join(memoryDir, fileName);

        // ── create ──
        if (command === 'create') {
          if (!file_text || typeof file_text !== 'string') {
            return JSON.stringify({ error: 'file_text is required for "create".' });
          }
          if (Buffer.byteLength(file_text, 'utf-8') > MAX_MEMORY_FILE_SIZE) {
            return JSON.stringify({ error: `Content too large (max ${MAX_MEMORY_FILE_SIZE / 1024} KB).` });
          }
          await fs.mkdir(memoryDir, { recursive: true });
          const entries = await fs.readdir(memoryDir);
          if (entries.includes(fileName)) {
            return JSON.stringify({ error: `File "${fileName}" already exists. Use str_replace to modify it.` });
          }
          if (entries.length >= MAX_MEMORY_FILES) {
            return JSON.stringify({ error: `Maximum ${MAX_MEMORY_FILES} memory files reached.` });
          }
          await fs.writeFile(filePath, file_text, 'utf-8');
          return JSON.stringify({ path: fileName, created: true });
        }

        // ── str_replace ──
        if (command === 'str_replace') {
          if (typeof old_str !== 'string' || typeof new_str !== 'string') {
            return JSON.stringify({ error: 'old_str and new_str are required for "str_replace".' });
          }
          const content = await fs.readFile(filePath, 'utf-8');
          const count = content.split(old_str).length - 1;
          if (count === 0) return JSON.stringify({ error: 'old_str not found in file.' });
          if (count > 1) return JSON.stringify({ error: `old_str found ${count} times. Must appear exactly once.` });
          const updated = content.replace(old_str, new_str);
          if (Buffer.byteLength(updated, 'utf-8') > MAX_MEMORY_FILE_SIZE) {
            return JSON.stringify({ error: 'Result would exceed max file size.' });
          }
          await fs.writeFile(filePath, updated, 'utf-8');
          return JSON.stringify({ path: fileName, replaced: true });
        }

        // ── insert ──
        if (command === 'insert') {
          if (typeof insert_line !== 'number' || typeof insert_text !== 'string') {
            return JSON.stringify({ error: 'insert_line and insert_text are required for "insert".' });
          }
          await fs.mkdir(memoryDir, { recursive: true });
          let content = '';
          if (existsSync(filePath)) {
            content = await fs.readFile(filePath, 'utf-8');
          }
          const lines = content.split('\n');
          const idx = Math.max(0, Math.min(insert_line, lines.length));
          lines.splice(idx, 0, insert_text);
          const updated = lines.join('\n');
          if (Buffer.byteLength(updated, 'utf-8') > MAX_MEMORY_FILE_SIZE) {
            return JSON.stringify({ error: 'Result would exceed max file size.' });
          }
          await fs.writeFile(filePath, updated, 'utf-8');
          return JSON.stringify({ path: fileName, inserted: true, atLine: idx });
        }

        // ── delete ──
        if (command === 'delete') {
          if (!existsSync(filePath)) {
            return JSON.stringify({ error: `Memory file "${fileName}" not found.` });
          }
          await fs.unlink(filePath);
          return JSON.stringify({ path: fileName, deleted: true });
        }

        return JSON.stringify({ error: `Unknown command: ${command}` });
      } catch (error) {
        return JSON.stringify({ error: error.message });
      }
    },
  });

  // ── get_changed_files (git diff) ───────────────────────────
  const getChangedFilesTool = new DynamicStructuredTool({
    name: 'get_changed_files',
    description:
      'Get git diffs of current file changes in the workspace. ' +
      'Returns staged, unstaged, or all changed files with their diff content. ' +
      'Useful for reviewing changes before commits.',
    schema: {
      type: 'object',
      properties: {
        sourceControlState: {
          type: 'string',
          enum: ['staged', 'unstaged', 'all'],
          description: 'Filter by git state. Default: "all".',
          default: 'all',
        },
      },
    },
    func: async ({ sourceControlState = 'all' }) => {
      try {
        let gitCmd;
        if (sourceControlState === 'staged') {
          gitCmd = 'git diff --cached --stat && echo "---DIFF---" && git diff --cached';
        } else if (sourceControlState === 'unstaged') {
          gitCmd = 'git diff --stat && echo "---DIFF---" && git diff';
        } else {
          gitCmd = 'git status --short && echo "---DIFF---" && git diff && echo "---STAGED---" && git diff --cached';
        }

        return new Promise((resolve) => {
          execFile('/bin/sh', ['-c', gitCmd], {
            cwd: workspacePath,
            timeout: 15_000,
            maxBuffer: MAX_TERMINAL_OUTPUT,
            env: { ...process.env, GIT_PAGER: 'cat', PAGER: 'cat' },
          }, (error, stdout, stderr) => {
            if (error && !stdout) {
              resolve(JSON.stringify({ error: stderr || error.message || 'Not a git repository.' }));
              return;
            }
            resolve(JSON.stringify({
              state: sourceControlState,
              output: trimOutput(stdout),
              stderr: stderr ? trimOutput(stderr) : '',
            }));
          });
        });
      } catch (error) {
        return JSON.stringify({ error: error.message });
      }
    },
  });

  // ── fetch_webpage ──────────────────────────────────────────
  const fetchWebpageTool = new DynamicStructuredTool({
    name: 'fetch_webpage',
    description:
      'Fetch the main text content from a web page URL. Useful for reading documentation, ' +
      'API references, or any public web page. Returns plain text (HTML tags stripped). ' +
      'Max response: 64 KB. Timeout: 15 seconds.',
    schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to fetch (must start with http:// or https://).',
        },
        query: {
          type: 'string',
          description: 'Optional: what you are looking for on the page (used for context, not filtering).',
          default: '',
        },
      },
      required: ['url'],
    },
    func: async ({ url, query = '' }) => {
      try {
        if (!url || typeof url !== 'string') {
          return JSON.stringify({ error: 'URL is required.' });
        }
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
          return JSON.stringify({ error: 'URL must start with http:// or https://.' });
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15_000);

        try {
          const response = await fetch(url, {
            signal: controller.signal,
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; AgentRoom/1.0)',
              'Accept': 'text/html,text/plain,application/json',
            },
          });
          clearTimeout(timeoutId);

          if (!response.ok) {
            return JSON.stringify({ error: `HTTP ${response.status}: ${response.statusText}` });
          }

          const contentType = response.headers.get('content-type') || '';
          let text = await response.text();

          // Strip HTML tags for HTML responses
          if (contentType.includes('html')) {
            // Remove script/style blocks first
            text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
            text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
            text = text.replace(/<nav[\s\S]*?<\/nav>/gi, '');
            text = text.replace(/<footer[\s\S]*?<\/footer>/gi, '');
            // Strip remaining tags
            text = text.replace(/<[^>]+>/g, ' ');
            // Clean up whitespace
            text = text.replace(/\s+/g, ' ').replace(/\n\s*\n/g, '\n').trim();
          }

          // Trim to max size
          text = trimOutput(text);

          return JSON.stringify({
            url,
            contentType: contentType.split(';')[0].trim(),
            length: text.length,
            content: text,
            ...(query ? { query } : {}),
          });
        } catch (fetchError) {
          clearTimeout(timeoutId);
          if (fetchError.name === 'AbortError') {
            return JSON.stringify({ error: 'Request timed out (15s).' });
          }
          return JSON.stringify({ error: fetchError.message });
        }
      } catch (error) {
        return JSON.stringify({ error: error.message });
      }
    },
  });

  // ── Build tool list based on agent permissions ─────────────
  const tools = [
    grepSearchTool,
    fileSearchTool,
    manageTodoListTool,
    memoryTool,          // unified: view is always available
    getChangedFilesTool,
    fetchWebpageTool,
  ];

  // Terminal access — only for agents with canRunTerminal
  if (agentPolicy.canRunTerminal) {
    tools.push(runInTerminalTool);
  }

  return tools;
}
