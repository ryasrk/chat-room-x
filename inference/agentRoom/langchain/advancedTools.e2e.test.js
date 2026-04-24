/**
 * E2E Tests for Advanced Tools
 *
 * Tests realistic multi-tool agent workflows — the kind of tool chains
 * an actual coder/planner/reviewer agent would execute during a session.
 * Each test simulates a complete agent workflow using multiple tools together.
 */

import { describe, test, beforeEach, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import { join } from 'path';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { execSync } from 'child_process';

import { createAdvancedTools } from './advancedTools.js';

// ── Shared helpers ───────────────────────────────────────────

let workspacePath;

function getTools(agentName = 'coder', opts = {}) {
  return createAdvancedTools(workspacePath, { agentName, ...opts });
}

function getTool(tools, name) {
  return tools.find((t) => t.name === name);
}

async function invoke(tools, name, args = {}) {
  const tool = getTool(tools, name);
  assert.ok(tool, `Tool "${name}" not found`);
  const raw = await tool.func(args);
  try { return JSON.parse(raw); } catch { return raw; }
}

beforeEach(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'e2e-tools-'));
  // Realistic project structure
  await fs.mkdir(join(workspacePath, 'src', 'utils'), { recursive: true });
  await fs.mkdir(join(workspacePath, 'src', 'components'), { recursive: true });
  await fs.mkdir(join(workspacePath, 'tests'), { recursive: true });
  await fs.mkdir(join(workspacePath, 'docs'), { recursive: true });

  await fs.writeFile(join(workspacePath, 'package.json'),
    '{"name":"my-app","version":"1.0.0","scripts":{"test":"echo ok"}}\n');
  await fs.writeFile(join(workspacePath, 'src', 'index.js'),
    'import { add } from "./utils/math.js";\n\nconsole.log(add(2, 3));\n');
  await fs.writeFile(join(workspacePath, 'src', 'utils', 'math.js'),
    'export function add(a, b) {\n  return a + b;\n}\n\nexport function subtract(a, b) {\n  return a - b;\n}\n');
  await fs.writeFile(join(workspacePath, 'src', 'utils', 'string.js'),
    'export function capitalize(str) {\n  return str.charAt(0).toUpperCase() + str.slice(1);\n}\n\n// TODO: add trim helper\n');
  await fs.writeFile(join(workspacePath, 'src', 'components', 'Button.jsx'),
    'export function Button({ label, onClick }) {\n  return <button onClick={onClick}>{label}</button>;\n}\n');
  await fs.writeFile(join(workspacePath, 'tests', 'math.test.js'),
    'import { add, subtract } from "../src/utils/math.js";\n\ntest("add", () => { expect(add(1,2)).toBe(3); });\n');
  await fs.writeFile(join(workspacePath, 'docs', 'API.md'),
    '# API Reference\n\n## Math Utils\n\n- `add(a, b)` — returns sum\n- `subtract(a, b)` — returns difference\n');
  await fs.writeFile(join(workspacePath, 'README.md'),
    '# My App\n\nA sample project for testing.\n');
});

afterEach(() => {
  try { rmSync(workspacePath, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ═════════════════════════════════════════════════════════════
// E2E Workflow 1: Coder explores codebase then tracks progress
// ═════════════════════════════════════════════════════════════

describe('E2E: coder explore + plan workflow', () => {
  test('grep → file_search → todo → memory: discover TODOs, plan work, save context', async () => {
    const tools = getTools('coder');

    // Step 1: Agent greps for TODOs across the codebase
    const grepResult = await invoke(tools, 'grep_search', { query: 'TODO' });
    assert.ok(grepResult.matches.length > 0, 'Should find TODO comments');
    const todoMatch = grepResult.matches.find((m) => m.path.includes('string.js'));
    assert.ok(todoMatch, 'Should find TODO in string.js');

    // Step 2: Agent searches for all util files to understand scope
    const fileResult = await invoke(tools, 'file_search', { query: 'src/utils/*.js' });
    assert.ok(fileResult.files.length >= 2, 'Should find math.js and string.js');

    // Step 3: Agent creates a todo list based on findings
    const todoResult = await invoke(tools, 'manage_todo_list', {
      todoList: [
        { id: 1, title: 'Add trim helper to string.js', status: 'in-progress' },
        { id: 2, title: 'Write tests for string utils', status: 'not-started' },
        { id: 3, title: 'Update API docs', status: 'not-started' },
      ],
    });
    assert.equal(todoResult.todoList.length, 3);
    assert.equal(todoResult.todoList[0].status, 'in-progress');

    // Step 4: Agent saves exploration context to memory for next session
    const memResult = await invoke(tools, 'memory', {
      command: 'create',
      path: 'session-context.md',
      file_text: `# Session Context\n\nFound TODO in ${todoMatch.path} at line ${todoMatch.line}.\nUtil files: ${fileResult.files.join(', ')}\n`,
    });
    assert.ok(memResult.created);

    // Step 5: Verify memory persists — agent reads it back
    const memContent = await invoke(tools, 'memory', { command: 'view', path: 'session-context.md' });
    assert.ok(memContent.includes('string.js'));
    assert.ok(memContent.includes('TODO'));
  });
});

// ═════════════════════════════════════════════════════════════
// E2E Workflow 2: Coder uses terminal + git in a real repo
// ═════════════════════════════════════════════════════════════

describe('E2E: coder terminal + git workflow', () => {
  test('run_in_terminal → get_changed_files: init repo, make changes, check diff', async () => {
    const tools = getTools('coder');

    // Step 1: Init a git repo in the workspace
    const initResult = await invoke(tools, 'run_in_terminal', {
      command: 'git init && git add -A && git commit -m "initial"',
      explanation: 'Initialize git repo with initial commit',
    });
    assert.equal(initResult.exitCode, 0, `git init failed: ${initResult.stderr}`);

    // Step 2: Verify clean state — no changes
    const cleanDiff = await invoke(tools, 'get_changed_files', { sourceControlState: 'all' });
    assert.ok(!cleanDiff.error, `Unexpected error: ${cleanDiff.error}`);
    // After fresh commit, diff output should be empty or minimal
    assert.ok(cleanDiff.output !== undefined);

    // Step 3: Agent modifies a file via terminal (simulating a write)
    const writeResult = await invoke(tools, 'run_in_terminal', {
      command: 'echo "export function divide(a, b) { return a / b; }" >> src/utils/math.js',
      explanation: 'Add divide function to math utils',
    });
    assert.equal(writeResult.exitCode, 0);

    // Step 4: Check unstaged changes — should show the diff
    const unstaged = await invoke(tools, 'get_changed_files', { sourceControlState: 'unstaged' });
    assert.ok(!unstaged.error);
    assert.ok(unstaged.output.includes('math.js'), 'Diff should mention math.js');
    assert.ok(unstaged.output.includes('divide'), 'Diff should show the new function');

    // Step 5: Stage and check staged changes
    await invoke(tools, 'run_in_terminal', {
      command: 'git add src/utils/math.js',
      explanation: 'Stage modified math.js',
    });
    const staged = await invoke(tools, 'get_changed_files', { sourceControlState: 'staged' });
    assert.ok(!staged.error);
    assert.ok(staged.output.includes('divide'), 'Staged diff should show divide');

    // Step 6: Verify terminal blocks dangerous commands
    const blocked = await invoke(tools, 'run_in_terminal', {
      command: 'sudo rm -rf /',
      explanation: 'This should be blocked',
    });
    assert.ok(blocked.error, 'Dangerous command should be blocked');
  });
});

// ═════════════════════════════════════════════════════════════
// E2E Workflow 3: Memory full lifecycle (create → insert → str_replace → view → delete)
// ═════════════════════════════════════════════════════════════

describe('E2E: memory full lifecycle', () => {
  test('create → insert → str_replace → view → delete: complete memory CRUD', async () => {
    const tools = getTools('coder');

    // Step 1: Create initial architecture decision record
    const created = await invoke(tools, 'memory', {
      command: 'create',
      path: 'decisions.md',
      file_text: '# Architecture Decisions\n\n## ADR-001: Use Express\nWe chose Express for the HTTP server.\n',
    });
    assert.ok(created.created);

    // Step 2: Insert a new ADR at line 4 (after the first ADR header)
    const inserted = await invoke(tools, 'memory', {
      command: 'insert',
      path: 'decisions.md',
      insert_line: 5,
      insert_text: '\n## ADR-002: Use PostgreSQL\nWe chose PostgreSQL for the database.',
    });
    assert.ok(inserted.inserted);
    assert.equal(inserted.atLine, 5);

    // Step 3: Verify both ADRs are present
    const content1 = await invoke(tools, 'memory', { command: 'view', path: 'decisions.md' });
    assert.ok(content1.includes('ADR-001'));
    assert.ok(content1.includes('ADR-002'));
    assert.ok(content1.includes('PostgreSQL'));

    // Step 4: str_replace to update a decision
    const replaced = await invoke(tools, 'memory', {
      command: 'str_replace',
      path: 'decisions.md',
      old_str: 'We chose Express for the HTTP server.',
      new_str: 'We chose Fastify for the HTTP server (migrated from Express).',
    });
    assert.ok(replaced.replaced);

    // Step 5: Verify the replacement
    const content2 = await invoke(tools, 'memory', { command: 'view', path: 'decisions.md' });
    assert.ok(content2.includes('Fastify'));
    assert.ok(!content2.includes('We chose Express'));

    // Step 6: str_replace fails on non-unique string
    await invoke(tools, 'memory', {
      command: 'str_replace',
      path: 'decisions.md',
      old_str: 'We chose',  // appears twice now
      new_str: 'Selected',
    }).then((r) => {
      assert.ok(r.error, 'Should fail when old_str matches multiple times');
      assert.ok(r.error.includes('2 times'));
    });

    // Step 7: List memory files
    const listing = await invoke(tools, 'memory', { command: 'view', path: '.' });
    assert.ok(listing.files.includes('decisions.md'));
    assert.equal(listing.total, 1);

    // Step 8: Delete the file
    const deleted = await invoke(tools, 'memory', { command: 'delete', path: 'decisions.md' });
    assert.ok(deleted.deleted);

    // Step 9: Verify it's gone
    const afterDelete = await invoke(tools, 'memory', { command: 'view', path: '.' });
    assert.equal(afterDelete.files.length, 0);
  });
});

// ═════════════════════════════════════════════════════════════
// E2E Workflow 4: Planner agent — read-only exploration + planning
// ═════════════════════════════════════════════════════════════

describe('E2E: planner agent permission boundaries', () => {
  test('planner can search, plan, and write memory but cannot run terminal', async () => {
    const tools = getTools('planner');
    const toolNames = tools.map((t) => t.name);

    // Step 1: Planner CAN search the codebase
    const grepResult = await invoke(tools, 'grep_search', { query: 'function', isRegexp: false });
    assert.ok(grepResult.matches.length > 0, 'Planner should be able to grep');

    // Step 2: Planner CAN search for files
    const fileResult = await invoke(tools, 'file_search', { query: '*.jsx' });
    assert.ok(fileResult.files.length >= 1, 'Should find Button.jsx');

    // Step 3: Planner CAN manage todos
    const todoResult = await invoke(tools, 'manage_todo_list', {
      todoList: [
        { id: 1, title: 'Design API schema', status: 'in-progress' },
        { id: 2, title: 'Define data models', status: 'not-started' },
      ],
    });
    assert.equal(todoResult.todoList.length, 2);

    // Step 4: Planner CAN write memory (has canWriteDocumentation)
    const memCreate = await invoke(tools, 'memory', {
      command: 'create',
      path: 'plan.md',
      file_text: '# Implementation Plan\n\n1. Design API\n2. Build endpoints\n',
    });
    assert.ok(memCreate.created);

    // Step 5: Planner CANNOT run terminal
    assert.ok(!toolNames.includes('run_in_terminal'), 'Planner should not have terminal');

    // Step 6: Planner CAN still use get_changed_files and fetch_webpage
    assert.ok(toolNames.includes('get_changed_files'));
    assert.ok(toolNames.includes('fetch_webpage'));
  });
});

// ═════════════════════════════════════════════════════════════
// E2E Workflow 5: Reviewer agent — code review with grep + terminal + git
// ═════════════════════════════════════════════════════════════

describe('E2E: reviewer code review workflow', () => {
  test('grep → terminal → get_changed_files → memory: review code quality', async () => {
    const tools = getTools('reviewer');

    // Step 1: Init git repo and make a change to review
    await invoke(tools, 'run_in_terminal', {
      command: 'git init && git add -A && git commit -m "initial"',
      explanation: 'Setup repo for review',
    });
    // Simulate a bad change — add console.log (code smell)
    await invoke(tools, 'run_in_terminal', {
      command: 'echo "console.log(\'DEBUG: temp\');" >> src/utils/math.js',
      explanation: 'Simulate bad code change',
    });

    // Step 2: Reviewer checks the diff
    const diff = await invoke(tools, 'get_changed_files', { sourceControlState: 'unstaged' });
    assert.ok(diff.output.includes('console.log'), 'Diff should show the debug log');

    // Step 3: Reviewer greps for all console.log statements
    const logs = await invoke(tools, 'grep_search', { query: 'console.log', isRegexp: false });
    assert.ok(logs.matches.length >= 2, 'Should find console.log in index.js and math.js');

    // Step 4: Reviewer runs linter/check via terminal
    const check = await invoke(tools, 'run_in_terminal', {
      command: 'grep -rn "console.log" src/ | wc -l',
      explanation: 'Count console.log occurrences',
    });
    assert.equal(check.exitCode, 0);
    const count = parseInt(check.stdout.trim());
    assert.ok(count >= 2, `Expected >=2 console.logs, got ${count}`);

    // Step 5: Reviewer saves findings to memory
    const findings = await invoke(tools, 'memory', {
      command: 'create',
      path: 'review-findings.md',
      file_text: `# Code Review Findings\n\n- Found ${count} console.log statements in src/\n- DEBUG log in math.js should be removed\n`,
    });
    assert.ok(findings.created);

    // Step 6: Verify findings are readable
    const saved = await invoke(tools, 'memory', { command: 'view', path: 'review-findings.md' });
    assert.ok(saved.includes('console.log'));
    assert.ok(saved.includes('math.js'));
  });
});

// ═════════════════════════════════════════════════════════════
// E2E Workflow 6: Shared todoState persists across tool calls within a turn
// ═════════════════════════════════════════════════════════════

describe('E2E: todo state persistence within agent turn', () => {
  test('todo state shared across multiple tool invocations via same context', async () => {
    // Simulate shared todoState like reactiveAgent does
    const sharedTodo = { items: [] };
    const tools = getTools('coder', { todoState: sharedTodo });

    // Step 1: Agent sets initial plan
    const plan = await invoke(tools, 'manage_todo_list', {
      todoList: [
        { id: 1, title: 'Read existing code', status: 'completed' },
        { id: 2, title: 'Write new feature', status: 'in-progress' },
        { id: 3, title: 'Run tests', status: 'not-started' },
      ],
    });
    assert.equal(plan.todoList.length, 3);

    // Step 2: Verify shared state was mutated
    assert.equal(sharedTodo.items.length, 3);
    assert.equal(sharedTodo.items[0].status, 'completed');
    assert.equal(sharedTodo.items[1].status, 'in-progress');

    // Step 3: Agent updates progress (Copilot pattern: send FULL list each time)
    const updated = await invoke(tools, 'manage_todo_list', {
      todoList: [
        { id: 1, title: 'Read existing code', status: 'completed' },
        { id: 2, title: 'Write new feature', status: 'completed' },
        { id: 3, title: 'Run tests', status: 'in-progress' },
      ],
    });
    assert.equal(updated.todoList[1].status, 'completed');
    assert.equal(updated.todoList[2].status, 'in-progress');

    // Step 4: Shared state reflects latest
    assert.equal(sharedTodo.items[1].status, 'completed');
    assert.equal(sharedTodo.items[2].status, 'in-progress');

    // Step 5: Invalid status gets normalized to 'not-started'
    const normalized = await invoke(tools, 'manage_todo_list', {
      todoList: [{ id: 1, title: 'Bad status', status: 'invalid-status' }],
    });
    assert.equal(normalized.todoList[0].status, 'not-started');
  });
});

// ═════════════════════════════════════════════════════════════
// E2E Workflow 7: Full feature implementation session
// ═════════════════════════════════════════════════════════════

describe('E2E: full feature implementation session', () => {
  test('todo → grep → terminal → memory → get_changed_files: implement, verify, document', async () => {
    const tools = getTools('coder');

    // Step 1: Plan the work
    await invoke(tools, 'manage_todo_list', {
      todoList: [
        { id: 1, title: 'Find existing math utils', status: 'in-progress' },
        { id: 2, title: 'Add subtract test', status: 'not-started' },
        { id: 3, title: 'Verify tests pass', status: 'not-started' },
        { id: 4, title: 'Save session notes', status: 'not-started' },
      ],
    });

    // Step 2: Search for existing subtract function
    const grepResult = await invoke(tools, 'grep_search', {
      query: 'function subtract',
    });
    assert.ok(grepResult.matches.length > 0);
    const targetFile = grepResult.matches[0].path;
    assert.ok(targetFile.includes('math.js'));

    // Step 3: Init git, write a test file, run it
    await invoke(tools, 'run_in_terminal', {
      command: 'git init && git add -A && git commit -m "initial"',
      explanation: 'Init repo',
    });

    await invoke(tools, 'run_in_terminal', {
      command: `cat > tests/subtract.test.js << 'EOF'
import { subtract } from "../src/utils/math.js";
if (subtract(10, 4) !== 6) { console.error("FAIL"); process.exit(1); }
console.log("PASS: subtract(10,4) = 6");
EOF`,
      explanation: 'Write subtract test',
    });

    // Step 4: Run the test
    const testRun = await invoke(tools, 'run_in_terminal', {
      command: 'node tests/subtract.test.js',
      explanation: 'Run subtract test',
    });
    assert.equal(testRun.exitCode, 0, `Test failed: ${testRun.stderr}`);
    assert.ok(testRun.stdout.includes('PASS'));

    // Step 5: Check what changed
    const changes = await invoke(tools, 'get_changed_files', { sourceControlState: 'unstaged' });
    assert.ok(changes.output !== undefined);

    // Step 6: Save session notes
    const notes = await invoke(tools, 'memory', {
      command: 'create',
      path: 'session-log.md',
      file_text: `# Session Log\n\n- Found subtract in ${targetFile}\n- Added test: tests/subtract.test.js\n- Test result: PASS\n`,
    });
    assert.ok(notes.created);

    // Step 7: Update todo — mark all done
    const finalTodo = await invoke(tools, 'manage_todo_list', {
      todoList: [
        { id: 1, title: 'Find existing math utils', status: 'completed' },
        { id: 2, title: 'Add subtract test', status: 'completed' },
        { id: 3, title: 'Verify tests pass', status: 'completed' },
        { id: 4, title: 'Save session notes', status: 'completed' },
      ],
    });
    const allDone = finalTodo.todoList.every((t) => t.status === 'completed');
    assert.ok(allDone, 'All todos should be completed');
  });
});
