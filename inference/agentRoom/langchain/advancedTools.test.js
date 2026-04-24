import { describe, test, beforeEach, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';

import { createAdvancedTools } from './advancedTools.js';

let workspacePath;

beforeEach(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'adv-tools-test-'));
  // Create a basic workspace structure
  await fs.mkdir(join(workspacePath, 'src'), { recursive: true });
  await fs.mkdir(join(workspacePath, 'notes'), { recursive: true });
  await fs.writeFile(join(workspacePath, 'src', 'index.js'), 'const hello = "world";\nconsole.log(hello);\n');
  await fs.writeFile(join(workspacePath, 'src', 'utils.js'), 'export function add(a, b) {\n  return a + b;\n}\n\nexport function multiply(a, b) {\n  return a * b;\n}\n');
  await fs.writeFile(join(workspacePath, 'notes', 'plan.md'), '# Plan\n\n1. Build the thing\n2. Test the thing\n');
  await fs.writeFile(join(workspacePath, 'README.md'), '# Test Project\n\nA test workspace.\n');
  await fs.writeFile(join(workspacePath, 'package.json'), '{"name": "test", "version": "1.0.0"}\n');
});

afterEach(() => {
  try {
    rmSync(workspacePath, { recursive: true, force: true });
  } catch { /* ignore */ }
});

function getTool(tools, name) {
  return tools.find((t) => t.name === name);
}

// ── grep_search ──────────────────────────────────────────────

describe('grep_search', () => {
  test('finds plain text matches across files', async () => {
    const tools = createAdvancedTools(workspacePath, { agentName: 'coder' });
    const grep = getTool(tools, 'grep_search');
    const result = JSON.parse(await grep.func({ query: 'hello' }));
    assert.ok(result.matches.length > 0);
    assert.ok(result.matches.some((m) => m.path === 'src/index.js'));
  });

  test('supports regex patterns', async () => {
    const tools = createAdvancedTools(workspacePath, { agentName: 'coder' });
    const grep = getTool(tools, 'grep_search');
    const result = JSON.parse(await grep.func({ query: 'function\\s+\\w+', isRegexp: true }));
    assert.ok(result.matches.length > 0);
    assert.ok(result.matches.some((m) => m.path === 'src/utils.js'));
  });

  test('filters by includePattern', async () => {
    const tools = createAdvancedTools(workspacePath, { agentName: 'coder' });
    const grep = getTool(tools, 'grep_search');
    const result = JSON.parse(await grep.func({ query: 'hello', includePattern: '*.md' }));
    // "hello" is only in index.js, not in .md files
    assert.equal(result.matches.length, 0);
  });

  test('returns line numbers', async () => {
    const tools = createAdvancedTools(workspacePath, { agentName: 'coder' });
    const grep = getTool(tools, 'grep_search');
    const result = JSON.parse(await grep.func({ query: 'console.log' }));
    assert.ok(result.matches.length > 0);
    const match = result.matches.find((m) => m.path === 'src/index.js');
    assert.ok(match);
    assert.equal(match.line, 2);
  });

  test('returns empty for no matches', async () => {
    const tools = createAdvancedTools(workspacePath, { agentName: 'coder' });
    const grep = getTool(tools, 'grep_search');
    const result = JSON.parse(await grep.func({ query: 'nonexistent_string_xyz' }));
    assert.equal(result.matches.length, 0);
  });

  test('rejects invalid regex', async () => {
    const tools = createAdvancedTools(workspacePath, { agentName: 'coder' });
    const grep = getTool(tools, 'grep_search');
    const result = JSON.parse(await grep.func({ query: '[invalid', isRegexp: true }));
    assert.ok(result.error);
  });
});

// ── file_search ──────────────────────────────────────────────

describe('file_search', () => {
  test('finds files by glob pattern', async () => {
    const tools = createAdvancedTools(workspacePath, { agentName: 'coder' });
    const search = getTool(tools, 'file_search');
    const result = JSON.parse(await search.func({ query: '*.js' }));
    assert.ok(result.files.length >= 2);
    assert.ok(result.files.some((f) => f.includes('index.js')));
    assert.ok(result.files.some((f) => f.includes('utils.js')));
  });

  test('finds files in subdirectories', async () => {
    const tools = createAdvancedTools(workspacePath, { agentName: 'coder' });
    const search = getTool(tools, 'file_search');
    // Create a nested file to test ** glob
    await fs.mkdir(join(workspacePath, 'src', 'lib'), { recursive: true });
    await fs.writeFile(join(workspacePath, 'src', 'lib', 'deep.js'), 'export const x = 1;\n');
    const result = JSON.parse(await search.func({ query: 'src/**/*.js' }));
    assert.ok(result.files.length >= 1, `Expected files in src/**, got: ${JSON.stringify(result.files)}`);
    assert.ok(result.files.some((f) => f.includes('deep.js')));
  });

  test('finds specific filenames', async () => {
    const tools = createAdvancedTools(workspacePath, { agentName: 'coder' });
    const search = getTool(tools, 'file_search');
    const result = JSON.parse(await search.func({ query: 'package.json' }));
    assert.ok(result.files.length >= 1);
    assert.ok(result.files.some((f) => f === 'package.json'));
  });

  test('returns empty for no matches', async () => {
    const tools = createAdvancedTools(workspacePath, { agentName: 'coder' });
    const search = getTool(tools, 'file_search');
    const result = JSON.parse(await search.func({ query: '*.xyz' }));
    assert.equal(result.files.length, 0);
  });
});

// ── run_in_terminal ──────────────────────────────────────────

describe('run_in_terminal', () => {
  test('executes shell commands and returns output', async () => {
    const tools = createAdvancedTools(workspacePath, { agentName: 'coder' });
    const terminal = getTool(tools, 'run_in_terminal');
    assert.ok(terminal, 'coder should have run_in_terminal');
    const result = JSON.parse(await terminal.func({ command: 'echo "hello world"', explanation: 'test echo' }));
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes('hello world'));
  });

  test('runs in workspace directory', async () => {
    const tools = createAdvancedTools(workspacePath, { agentName: 'coder' });
    const terminal = getTool(tools, 'run_in_terminal');
    const result = JSON.parse(await terminal.func({ command: 'ls src/', explanation: 'list src' }));
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes('index.js'));
  });

  test('captures stderr and non-zero exit codes', async () => {
    const tools = createAdvancedTools(workspacePath, { agentName: 'coder' });
    const terminal = getTool(tools, 'run_in_terminal');
    const result = JSON.parse(await terminal.func({ command: 'ls nonexistent_dir_xyz', explanation: 'test error' }));
    assert.ok(result.exitCode !== 0);
    assert.ok(result.stderr.length > 0);
  });

  test('is not available for planner', async () => {
    const tools = createAdvancedTools(workspacePath, { agentName: 'planner' });
    const terminal = getTool(tools, 'run_in_terminal');
    assert.equal(terminal, undefined, 'planner should not have run_in_terminal');
  });

  test('is available for reviewer', async () => {
    const tools = createAdvancedTools(workspacePath, { agentName: 'reviewer' });
    const terminal = getTool(tools, 'run_in_terminal');
    assert.ok(terminal, 'reviewer should have run_in_terminal');
  });

  test('blocks dangerous commands', async () => {
    const tools = createAdvancedTools(workspacePath, { agentName: 'coder' });
    const terminal = getTool(tools, 'run_in_terminal');
    const result = JSON.parse(await terminal.func({ command: 'sudo rm -rf /', explanation: 'dangerous' }));
    assert.ok(result.error);
  });
});

// ── manage_todo_list ─────────────────────────────────────────

describe('manage_todo_list', () => {
  test('sets a full todo list via todoList array', async () => {
    const tools = createAdvancedTools(workspacePath, { agentName: 'coder' });
    const todo = getTool(tools, 'manage_todo_list');

    const result = JSON.parse(await todo.func({
      todoList: [
        { id: 1, title: 'Write code', status: 'not-started' },
        { id: 2, title: 'Write tests', status: 'not-started' },
      ],
    }));
    assert.equal(result.todoList.length, 2);
    assert.equal(result.todoList[0].title, 'Write code');
  });

  test('replaces entire list on subsequent calls', async () => {
    const tools = createAdvancedTools(workspacePath, { agentName: 'coder' });
    const todo = getTool(tools, 'manage_todo_list');

    await todo.func({
      todoList: [{ id: 1, title: 'Task 1', status: 'not-started' }],
    });

    const result = JSON.parse(await todo.func({
      todoList: [
        { id: 1, title: 'Task 1', status: 'completed' },
        { id: 2, title: 'Task 2', status: 'in-progress' },
      ],
    }));
    assert.equal(result.todoList.length, 2);
    assert.equal(result.todoList[0].status, 'completed');
  });

  test('returns error for empty todoList', async () => {
    const tools = createAdvancedTools(workspacePath, { agentName: 'coder' });
    const todo = getTool(tools, 'manage_todo_list');
    const result = JSON.parse(await todo.func({ todoList: [] }));
    assert.ok(result.error || result.todoList.length === 0);
  });
});

// ── memory (unified) ─────────────────────────────────────────

describe('memory', () => {
  test('create + view: creates a file and reads it back', async () => {
    const tools = createAdvancedTools(workspacePath, { agentName: 'coder' });
    const mem = getTool(tools, 'memory');

    const createResult = JSON.parse(await mem.func({ command: 'create', path: 'context.md', file_text: '# Context\n\nImportant decision: use React.' }));
    assert.ok(createResult.created);

    const content = await mem.func({ command: 'view', path: 'context.md' });
    assert.ok(content.includes('Important decision'));
  });

  test('view lists all files when path is "."', async () => {
    const tools = createAdvancedTools(workspacePath, { agentName: 'coder' });
    const mem = getTool(tools, 'memory');

    await mem.func({ command: 'create', path: 'file1.md', file_text: 'one' });
    await mem.func({ command: 'create', path: 'file2.md', file_text: 'two' });

    const result = JSON.parse(await mem.func({ command: 'view', path: '.' }));
    assert.ok(result.files.includes('file1.md'));
    assert.ok(result.files.includes('file2.md'));
  });

  test('create fails if file already exists', async () => {
    const tools = createAdvancedTools(workspacePath, { agentName: 'coder' });
    const mem = getTool(tools, 'memory');

    await mem.func({ command: 'create', path: 'dup.md', file_text: 'first' });
    const result = JSON.parse(await mem.func({ command: 'create', path: 'dup.md', file_text: 'second' }));
    assert.ok(result.error);
    assert.ok(result.error.includes('already exists'));
  });

  test('str_replace replaces exact string', async () => {
    const tools = createAdvancedTools(workspacePath, { agentName: 'coder' });
    const mem = getTool(tools, 'memory');

    await mem.func({ command: 'create', path: 'plan.md', file_text: 'Use React for frontend.' });
    const result = JSON.parse(await mem.func({ command: 'str_replace', path: 'plan.md', old_str: 'React', new_str: 'Vue' }));
    assert.ok(result.replaced);

    const content = await mem.func({ command: 'view', path: 'plan.md' });
    assert.ok(content.includes('Vue'));
    assert.ok(!content.includes('React'));
  });

  test('delete removes a file', async () => {
    const tools = createAdvancedTools(workspacePath, { agentName: 'coder' });
    const mem = getTool(tools, 'memory');

    await mem.func({ command: 'create', path: 'temp.md', file_text: 'temporary' });
    const delResult = JSON.parse(await mem.func({ command: 'delete', path: 'temp.md' }));
    assert.ok(delResult.deleted);

    const readResult = JSON.parse(await mem.func({ command: 'view', path: 'temp.md' }));
    assert.ok(readResult.error);
  });

  test('view returns empty list when no memory exists', async () => {
    const tools = createAdvancedTools(workspacePath, { agentName: 'coder' });
    const mem = getTool(tools, 'memory');
    const result = JSON.parse(await mem.func({ command: 'view', path: '.' }));
    assert.equal(result.files.length, 0);
  });
});

// ── get_changed_files ────────────────────────────────────────

describe('get_changed_files', () => {
  test('returns git status for a git repo', async () => {
    const tools = createAdvancedTools(workspacePath, { agentName: 'coder' });
    const gitTool = getTool(tools, 'get_changed_files');
    assert.ok(gitTool, 'get_changed_files should exist');
    // Workspace is a temp dir, not a git repo — should return error
    const result = JSON.parse(await gitTool.func({ sourceControlState: 'all' }));
    assert.ok(result.error || result.output !== undefined);
  });
});

// ── fetch_webpage ────────────────────────────────────────────

describe('fetch_webpage', () => {
  test('rejects invalid URLs', async () => {
    const tools = createAdvancedTools(workspacePath, { agentName: 'coder' });
    const fetchTool = getTool(tools, 'fetch_webpage');
    assert.ok(fetchTool, 'fetch_webpage should exist');
    const result = JSON.parse(await fetchTool.func({ url: 'not-a-url' }));
    assert.ok(result.error);
  });

  test('requires url parameter', async () => {
    const tools = createAdvancedTools(workspacePath, { agentName: 'coder' });
    const fetchTool = getTool(tools, 'fetch_webpage');
    const result = JSON.parse(await fetchTool.func({ url: '' }));
    assert.ok(result.error);
  });
});

// ── agent policy enforcement ─────────────────────────────────

describe('agent policy enforcement', () => {
  test('planner gets core tools but NOT run_in_terminal', async () => {
    const tools = createAdvancedTools(workspacePath, { agentName: 'planner' });
    const names = tools.map((t) => t.name);
    assert.ok(names.includes('grep_search'));
    assert.ok(names.includes('file_search'));
    assert.ok(names.includes('manage_todo_list'));
    assert.ok(names.includes('memory'));
    assert.ok(names.includes('get_changed_files'));
    assert.ok(names.includes('fetch_webpage'));
    assert.ok(!names.includes('run_in_terminal'));
  });

  test('coder gets all tools including run_in_terminal', async () => {
    const tools = createAdvancedTools(workspacePath, { agentName: 'coder' });
    const names = tools.map((t) => t.name);
    assert.ok(names.includes('grep_search'));
    assert.ok(names.includes('file_search'));
    assert.ok(names.includes('run_in_terminal'));
    assert.ok(names.includes('manage_todo_list'));
    assert.ok(names.includes('memory'));
    assert.ok(names.includes('get_changed_files'));
    assert.ok(names.includes('fetch_webpage'));
  });

  test('reviewer gets run_in_terminal', async () => {
    const tools = createAdvancedTools(workspacePath, { agentName: 'reviewer' });
    const names = tools.map((t) => t.name);
    assert.ok(names.includes('run_in_terminal'));
  });

  test('default agent gets tools without run_in_terminal', async () => {
    const tools = createAdvancedTools(workspacePath, { agentName: 'unknown_agent' });
    const names = tools.map((t) => t.name);
    assert.ok(names.includes('grep_search'));
    assert.ok(names.includes('file_search'));
    assert.ok(names.includes('manage_todo_list'));
    assert.ok(names.includes('memory'));
    assert.ok(!names.includes('run_in_terminal'));
  });
});
