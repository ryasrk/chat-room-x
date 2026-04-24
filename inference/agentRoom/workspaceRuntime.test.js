import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ensureWorkspacePythonEnv, runWorkspacePythonFile } from './workspaceRuntime.js';

test('workspace runtime provisions a per-workspace venv and runs python files inside it', async (t) => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'agent-room-runtime-'));

  t.after(async () => {
    await rm(workspacePath, { recursive: true, force: true });
  });

  await mkdir(join(workspacePath, 'src'), { recursive: true });
  await writeFile(
    join(workspacePath, 'src', 'hello.py'),
    [
      'import sys',
      'print("hello from venv")',
      'print("args=" + ",".join(sys.argv[1:]))',
    ].join('\n'),
    'utf-8',
  );

  const venv = await ensureWorkspacePythonEnv(workspacePath);
  assert.equal(venv.venvPath, '.venv');
  assert.match(venv.pythonBinary, /\.venv\/bin\/python$/);

  const result = await runWorkspacePythonFile(workspacePath, 'src/hello.py', ['one', 'two']);
  assert.equal(result.exitCode, 0);
  assert.equal(result.venvPath, '.venv');
  assert.match(result.stdout, /hello from venv/);
  assert.match(result.stdout, /args=one,two/);
  assert.equal(result.stderr, '');
});

test('workspace runtime rejects non-python files', async (t) => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'agent-room-runtime-filetype-'));

  t.after(async () => {
    await rm(workspacePath, { recursive: true, force: true });
  });

  await mkdir(join(workspacePath, 'src'), { recursive: true });
  await writeFile(join(workspacePath, 'src', 'notes.txt'), 'hello', 'utf-8');

  await assert.rejects(
    () => runWorkspacePythonFile(workspacePath, 'src/notes.txt'),
    /Only \.py files can be executed/,
  );
});