import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

import { listFiles, readFile, safePath, updateFile, writeFile } from './fileTools.js';

test('safePath rejects path traversal and absolute paths', () => {
  const workspace = mkdtempSync(join(os.tmpdir(), 'agent-room-safe-'));

  assert.throws(() => safePath(workspace, '../outside.txt'), /Path traversal/);
  assert.throws(() => safePath(workspace, '%2E%2E/outside.txt'), /Path traversal/);
  assert.throws(() => safePath(workspace, '/etc/passwd'), /Absolute paths/);
  assert.throws(() => safePath(workspace, '.env'), /not allowed/);

  rmSync(workspace, { recursive: true, force: true });
});

test('writeFile, readFile, updateFile, and listFiles operate inside workspace', async () => {
  const workspace = mkdtempSync(join(os.tmpdir(), 'agent-room-tools-'));

  await writeFile(workspace, 'src/main.txt', 'hello world');
  const file = await readFile(workspace, 'src/main.txt');
  assert.equal(file.content, 'hello world');

  const updateResult = await updateFile(workspace, 'src/main.txt', 'world', 'agent room');
  assert.equal(updateResult.replacements, 1);

  const updated = await readFile(workspace, 'src/main.txt');
  assert.equal(updated.content, 'hello agent room');

  const entries = await listFiles(workspace, '.');
  assert.deepEqual(
    entries.map((entry) => entry.path),
    ['src', 'src/main.txt'],
  );

  rmSync(workspace, { recursive: true, force: true });
});

test('writeFile rejects symlinked parent directories inside the workspace', async () => {
  const workspace = mkdtempSync(join(os.tmpdir(), 'agent-room-symlink-'));
  const outside = mkdtempSync(join(os.tmpdir(), 'agent-room-outside-'));
  const linkPath = join(workspace, 'linked');

  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, linkPath);

  await assert.rejects(
    () => writeFile(workspace, 'linked/escape.txt', 'nope'),
    /Symlinks are not allowed/,
  );

  rmSync(workspace, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});