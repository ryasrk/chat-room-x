import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile as readFileFromFs, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createCollaborationTools, createWorkspaceTools } from './workspaceTools.js';

function getTool(tools, name) {
  return tools.find((tool) => tool.name === name);
}

test('planner can write planning notes but not implementation files', async (t) => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'workspace-tools-planner-'));

  t.after(async () => {
    await rm(workspacePath, { recursive: true, force: true });
  });

  const tools = createWorkspaceTools(workspacePath, { agentName: 'planner' });
  const writeFileTool = getTool(tools, 'write_file');

  const notesResult = JSON.parse(await writeFileTool.func({ path: 'notes/plan.md', content: '# Plan\n' }));
  assert.equal(notesResult.path, 'notes/plan.md');

  const sourceResult = JSON.parse(await writeFileTool.func({ path: 'src/calculator.js', content: 'export const ok = true;\n' }));
  assert.match(sourceResult.error, /Planner cannot write implementation files/i);
});

test('coder can write implementation files in src', async (t) => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'workspace-tools-coder-'));

  t.after(async () => {
    await rm(workspacePath, { recursive: true, force: true });
  });

  const tools = createWorkspaceTools(workspacePath, { agentName: 'coder' });
  const writeFileTool = getTool(tools, 'write_file');

  const result = JSON.parse(await writeFileTool.func({
    path: 'src/calculator.js',
    content: 'export function add(a, b) { return a + b; }\n',
  }));

  assert.equal(result.path, 'src/calculator.js');
  const source = await readFileFromFs(join(workspacePath, 'src', 'calculator.js'), 'utf8');
  assert.match(source, /export function add/);
});

test('reviewer cannot update implementation files in src', async (t) => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'workspace-tools-reviewer-'));

  t.after(async () => {
    await rm(workspacePath, { recursive: true, force: true });
  });

  const coderTools = createWorkspaceTools(workspacePath, { agentName: 'coder' });
  await getTool(coderTools, 'write_file').func({
    path: 'src/calculator.js',
    content: 'export const version = 1;\n',
  });

  const reviewerTools = createWorkspaceTools(workspacePath, { agentName: 'reviewer' });
  const updateResult = JSON.parse(await getTool(reviewerTools, 'update_file').func({
    path: 'src/calculator.js',
    old_str: 'version = 1',
    new_str: 'version = 2',
  }));

  assert.match(updateResult.error, /Reviewer cannot write implementation files/i);
});

test('coder can execute python files while planner cannot', async (t) => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'workspace-tools-python-'));

  t.after(async () => {
    await rm(workspacePath, { recursive: true, force: true });
  });

  const coderTools = createWorkspaceTools(workspacePath, { agentName: 'coder' });
  await getTool(coderTools, 'write_file').func({
    path: 'src/check.py',
    content: 'print("python tool ok")\n',
  });

  const coderRunResult = JSON.parse(await getTool(coderTools, 'run_python').func({
    path: 'src/check.py',
  }));
  assert.equal(coderRunResult.exitCode, 0);
  assert.match(coderRunResult.stdout, /python tool ok/);

  const plannerTools = createWorkspaceTools(workspacePath, { agentName: 'planner' });
  const plannerRunResult = JSON.parse(await getTool(plannerTools, 'run_python').func({
    path: 'src/check.py',
  }));
  assert.match(plannerRunResult.error, /Python execution capability/i);
});

test('delegate rejects missing or unknown targets instead of posting malformed handoffs', async () => {
  const postedMessages = [];
  const tools = createCollaborationTools({
    roomId: 'room-1',
    agentName: 'planner',
    postMessage: async (sender, content, eventType) => {
      postedMessages.push({ sender, content, eventType });
    },
    getAgentNames: () => ['planner', 'coder', 'reviewer'],
  });

  const delegateTool = getTool(tools, 'delegate');
  const missingTarget = JSON.parse(await delegateTool.func({ task: 'Implement src/calculator.js' }));
  const unknownTarget = JSON.parse(await delegateTool.func({ to_agent: 'ghost', task: 'Implement src/calculator.js' }));

  assert.match(missingTarget.error, /target agent is required/i);
  assert.match(unknownTarget.error, /unknown target agent/i);
  assert.equal(postedMessages.length, 0);
});

test('propose rejects missing titles instead of posting malformed proposals', async () => {
  const postedMessages = [];
  const tools = createCollaborationTools({
    roomId: 'room-1',
    agentName: 'planner',
    postMessage: async (sender, content, eventType) => {
      postedMessages.push({ sender, content, eventType });
    },
    getAgentNames: () => ['planner', 'coder', 'reviewer'],
  });

  const proposeTool = getTool(tools, 'propose');
  const result = JSON.parse(await proposeTool.func({ content: 'Build the calculator in small steps.' }));

  assert.match(result.error, /title is required/i);
  assert.equal(postedMessages.length, 0);
});