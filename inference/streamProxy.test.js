import assert from 'node:assert/strict';
import test from 'node:test';

import { buildChatCompletionPayload, parseSseLine, splitSseLines } from './streamProxy.js';

test('buildChatCompletionPayload forces streaming mode', () => {
  const payload = JSON.parse(buildChatCompletionPayload({
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 256,
    temperature: 0.3,
  }));

  assert.equal(payload.stream, true);
  assert.equal(payload.max_tokens, 256);
  assert.equal(payload.temperature, 0.3);
  // System message is auto-injected if missing
  assert.equal(payload.messages[0].role, 'system');
  assert.equal(payload.messages[1].role, 'user');
  assert.equal(payload.messages[1].content, 'hello');
});

test('buildChatCompletionPayload preserves existing system message', () => {
  const payload = JSON.parse(buildChatCompletionPayload({
    messages: [
      { role: 'system', content: 'Custom system prompt' },
      { role: 'user', content: 'hello' },
    ],
  }));

  assert.equal(payload.messages.length, 2);
  assert.equal(payload.messages[0].content, 'Custom system prompt');
});

test('buildChatCompletionPayload forwards chat template kwargs', () => {
  const payload = JSON.parse(buildChatCompletionPayload({
    messages: [{ role: 'user', content: 'hello' }],
    chat_template_kwargs: { enable_thinking: false },
  }));

  assert.deepEqual(payload.chat_template_kwargs, { enable_thinking: false });
});

test('buildChatCompletionPayload forwards provider-specific fields', () => {
  const payload = JSON.parse(buildChatCompletionPayload({
    messages: [{ role: 'user', content: 'hello' }],
    model: 'claude-opus-4.6',
    reasoning_effort: 'high',
  }));

  assert.equal(payload.model, 'claude-opus-4.6');
  assert.equal(payload.reasoning_effort, 'high');
});

test('splitSseLines keeps incomplete tail in the buffer', () => {
  const result = splitSseLines('', 'data: {"choices":[{"delta":{"content":"Hel"}}]}\npartial');

  assert.deepEqual(result.lines, ['data: {"choices":[{"delta":{"content":"Hel"}}]}']);
  assert.equal(result.buffer, 'partial');
});

test('parseSseLine extracts assistant deltas', () => {
  const event = parseSseLine('data: {"choices":[{"delta":{"content":"hello"}}]}');

  assert.deepEqual(event, { type: 'delta', channel: 'content', delta: 'hello' });
});

test('parseSseLine extracts reasoning deltas', () => {
  const event = parseSseLine('data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}');

  assert.deepEqual(event, { type: 'delta', channel: 'reasoning', delta: 'thinking' });
});

test('parseSseLine detects completion sentinel', () => {
  assert.deepEqual(parseSseLine('data: [DONE]'), { type: 'done' });
});
