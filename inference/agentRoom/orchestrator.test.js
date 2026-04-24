import test from 'node:test';
import assert from 'node:assert/strict';

import { parseAgentResponse, parseMentions } from './orchestrator.js';

test('parseMentions returns only valid mentioned agents', () => {
  const mentions = parseMentions(
    'Please ask @planner to outline this, then @coder can implement and @unknown can be ignored.',
    ['planner', 'coder', 'reviewer'],
  );

  assert.deepEqual(mentions, ['planner', 'coder']);
});

test('parseAgentResponse extracts JSON payload from fenced block', () => {
  const parsed = parseAgentResponse([
    '```json',
    JSON.stringify({
      message: '@reviewer Please check the new file.',
      actions: [{ tool: 'write_file', path: 'plan.md', content: '# Plan' }],
      handoffs: ['reviewer'],
    }),
    '```',
  ].join('\n'));

  assert.equal(parsed.message, '@reviewer Please check the new file.');
  assert.equal(parsed.actions.length, 1);
  assert.deepEqual(parsed.handoffs, ['reviewer']);
});