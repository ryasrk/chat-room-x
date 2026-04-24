import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeWorkspaceEntriesResponse,
  normalizeWorkspaceFileContentResponse,
} from './agentWorkspaceData.js';

test('normalizeWorkspaceEntriesResponse accepts backend entry objects and keeps empty directories distinct', () => {
  assert.deepEqual(
    normalizeWorkspaceEntriesResponse({
      files: [
        { path: 'src', type: 'directory' },
        { path: 'src/index.html', type: 'file', size: 14 },
        { path: 'notes.md', type: 'file' },
        { path: '', type: 'file' },
      ],
    }),
    [
      { path: 'src', type: 'directory', size: undefined },
      { path: 'src/index.html', type: 'file', size: 14 },
      { path: 'notes.md', type: 'file', size: undefined },
    ],
  );
});

test('normalizeWorkspaceEntriesResponse still supports legacy string arrays', () => {
  assert.deepEqual(
    normalizeWorkspaceEntriesResponse(['src/index.html', './README.md', '']),
    [
      { path: 'src/index.html', type: 'file' },
      { path: 'README.md', type: 'file' },
    ],
  );
});

test('normalizeWorkspaceFileContentResponse unwraps nested file payloads and stringifies object content', () => {
  assert.equal(
    normalizeWorkspaceFileContentResponse({
      file: {
        path: 'src/index.html',
        content: '<h1>Hello</h1>',
      },
    }),
    '<h1>Hello</h1>',
  );

  assert.equal(
    normalizeWorkspaceFileContentResponse({
      file: {
        content: { status: 'ok' },
      },
    }),
    '{\n  "status": "ok"\n}',
  );
});