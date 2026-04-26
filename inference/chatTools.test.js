/**
 * Unit tests for chatTools.js — server-side tool execution for regular chat.
 * Covers: shouldUseTools, injectTools, buildFollowUpPayload, buildFinalPayload,
 *         executeToolCalls, hasToolCalls, search providers, web_fetch, calculator.
 */

import { describe, test, beforeEach, mock } from 'bun:test';
import assert from 'node:assert/strict';

import {
  shouldUseTools,
  injectTools,
  buildFollowUpPayload,
  buildFinalPayload,
  executeToolCalls,
  hasToolCalls,
  CHAT_TOOL_DEFINITIONS,
} from './chatTools.js';

// ── shouldUseTools ─────────────────────────────────────────────

describe('shouldUseTools', () => {
  test('returns true when tools_enabled is true', () => {
    assert.equal(shouldUseTools({ tools_enabled: true }), true);
  });

  test('returns false when tools_enabled is false', () => {
    assert.equal(shouldUseTools({ tools_enabled: false }), false);
  });

  test('returns false when tools_enabled is missing', () => {
    assert.equal(shouldUseTools({ messages: [] }), false);
  });

  test('returns false for null/undefined', () => {
    assert.equal(shouldUseTools(null), false);
    assert.equal(shouldUseTools(undefined), false);
  });

  test('returns false for non-boolean truthy values', () => {
    assert.equal(shouldUseTools({ tools_enabled: 1 }), false);
    assert.equal(shouldUseTools({ tools_enabled: 'true' }), false);
  });
});

// ── injectTools ────────────────────────────────────────────────

describe('injectTools', () => {
  test('adds tool definitions and sets stream to false', () => {
    const parsed = { messages: [{ role: 'user', content: 'hi' }], tools_enabled: true, stream: true };
    const result = injectTools(parsed);

    assert.ok(Array.isArray(result.tools));
    assert.ok(result.tools.length >= 3); // web_search, web_fetch, calculator
    assert.equal(result.stream, false);
    assert.equal(result.tool_choice, 'auto');
    assert.equal(result.tools_enabled, undefined); // stripped
  });

  test('preserves original messages', () => {
    const msgs = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }];
    const result = injectTools({ messages: msgs, tools_enabled: true });
    assert.deepEqual(result.messages, msgs);
  });

  test('does not mutate original object', () => {
    const original = { messages: [], tools_enabled: true, stream: true };
    const result = injectTools(original);
    assert.equal(original.tools_enabled, true); // unchanged
    assert.equal(original.stream, true); // unchanged
    assert.equal(result.tools_enabled, undefined);
  });

  test('tool definitions have correct structure', () => {
    const result = injectTools({ messages: [], tools_enabled: true });
    for (const tool of result.tools) {
      assert.equal(tool.type, 'function');
      assert.ok(tool.function.name);
      assert.ok(tool.function.description);
      assert.ok(tool.function.parameters);
      assert.equal(tool.function.parameters.type, 'object');
    }
  });
});

// ── CHAT_TOOL_DEFINITIONS ──────────────────────────────────────

describe('CHAT_TOOL_DEFINITIONS', () => {
  test('includes web_search', () => {
    const ws = CHAT_TOOL_DEFINITIONS.find((t) => t.function.name === 'web_search');
    assert.ok(ws);
    assert.ok(ws.function.parameters.properties.query);
    assert.ok(ws.function.parameters.required.includes('query'));
  });

  test('includes web_fetch', () => {
    const wf = CHAT_TOOL_DEFINITIONS.find((t) => t.function.name === 'web_fetch');
    assert.ok(wf);
    assert.ok(wf.function.parameters.properties.url);
    assert.ok(wf.function.parameters.required.includes('url'));
  });

  test('includes calculator', () => {
    const calc = CHAT_TOOL_DEFINITIONS.find((t) => t.function.name === 'calculator');
    assert.ok(calc);
    assert.ok(calc.function.parameters.properties.operation);
    assert.ok(calc.function.parameters.properties.values);
  });
});

// ── hasToolCalls ───────────────────────────────────────────────

describe('hasToolCalls', () => {
  test('returns true for finish_reason tool_calls', () => {
    assert.equal(hasToolCalls({
      choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: '1', function: { name: 'web_search', arguments: '{}' } }] } }],
    }), true);
  });

  test('returns true when tool_calls array is non-empty', () => {
    assert.equal(hasToolCalls({
      choices: [{ finish_reason: 'stop', message: { tool_calls: [{ id: '1', function: { name: 'calc', arguments: '{}' } }] } }],
    }), true);
  });

  test('returns false for normal stop response', () => {
    assert.equal(hasToolCalls({
      choices: [{ finish_reason: 'stop', message: { content: 'Hello!' } }],
    }), false);
  });

  test('returns false for empty tool_calls', () => {
    assert.equal(hasToolCalls({
      choices: [{ finish_reason: 'stop', message: { tool_calls: [] } }],
    }), false);
  });

  test('returns false for null/undefined', () => {
    assert.equal(hasToolCalls(null), false);
    assert.equal(hasToolCalls(undefined), false);
    assert.equal(hasToolCalls({}), false);
  });
});

// ── buildFollowUpPayload ───────────────────────────────────────

describe('buildFollowUpPayload', () => {
  test('appends assistant and tool messages', () => {
    const original = {
      messages: [{ role: 'user', content: 'search prabowo' }],
      tools_enabled: true,
      tools: [{ type: 'function', function: { name: 'web_search' } }],
    };
    const assistantMsg = {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{"query":"prabowo"}' } }],
    };
    const toolResults = [{ role: 'tool', tool_call_id: 'c1', content: '{"results":[]}' }];

    const result = buildFollowUpPayload(original, assistantMsg, toolResults);

    assert.equal(result.messages.length, 3); // user + assistant + tool
    assert.equal(result.messages[1].role, 'assistant');
    assert.equal(result.messages[2].role, 'tool');
    assert.equal(result.stream, true);
    assert.equal(result.tools_enabled, undefined); // stripped
  });
});

// ── buildFinalPayload ──────────────────────────────────────────

describe('buildFinalPayload', () => {
  test('strips tools and converts tool messages to text', () => {
    const payload = {
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'search prabowo' },
        {
          role: 'assistant', content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{"query":"prabowo"}' } }],
        },
        { role: 'tool', tool_call_id: 'c1', content: JSON.stringify({ query: 'prabowo', results: [{ title: 'Article 1', url: 'https://example.com', snippet: 'News about Prabowo' }] }) },
      ],
      tools: [{ type: 'function', function: { name: 'web_search' } }],
      tool_choice: 'auto',
    };

    const result = buildFinalPayload(payload);

    // No tools
    assert.equal(result.tools, undefined);
    assert.equal(result.tool_choice, undefined);
    assert.equal(result.stream, false);

    // No tool role messages
    assert.ok(!result.messages.some((m) => m.role === 'tool'));

    // Assistant message converted to text with search results
    const assistantMsg = result.messages.find((m) => m.role === 'assistant');
    assert.ok(assistantMsg);
    assert.ok(assistantMsg.content.includes('web_search'));
    assert.ok(assistantMsg.content.includes('Article 1'));
    assert.ok(assistantMsg.content.includes('https://example.com'));

    // Has follow-up user instruction
    const lastMsg = result.messages[result.messages.length - 1];
    assert.equal(lastMsg.role, 'user');
    assert.ok(lastMsg.content.includes('search results'));
  });

  test('handles calculator results', () => {
    const payload = {
      messages: [
        { role: 'user', content: 'what is 2+2' },
        {
          role: 'assistant', content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'calculator', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'c1', content: JSON.stringify({ operation: 'add', result: '4' }) },
      ],
    };

    const result = buildFinalPayload(payload);
    const assistantMsg = result.messages.find((m) => m.role === 'assistant');
    assert.ok(assistantMsg.content.includes('add'));
    assert.ok(assistantMsg.content.includes('4'));
  });

  test('handles web_fetch results', () => {
    const payload = {
      messages: [
        { role: 'user', content: 'read this page' },
        {
          role: 'assistant', content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'web_fetch', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'c1', content: JSON.stringify({ url: 'https://example.com', content: 'Page content here' }) },
      ],
    };

    const result = buildFinalPayload(payload);
    const assistantMsg = result.messages.find((m) => m.role === 'assistant');
    assert.ok(assistantMsg.content.includes('Page content here'));
  });

  test('handles tool errors gracefully', () => {
    const payload = {
      messages: [
        { role: 'user', content: 'search something' },
        {
          role: 'assistant', content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'c1', content: JSON.stringify({ error: 'Network timeout' }) },
      ],
    };

    const result = buildFinalPayload(payload);
    const assistantMsg = result.messages.find((m) => m.role === 'assistant');
    assert.ok(assistantMsg.content.includes('Network timeout'));
  });

  test('preserves non-tool messages', () => {
    const payload = {
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'Hi there!' },
        { role: 'user', content: 'search prabowo' },
        {
          role: 'assistant', content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'c1', content: '{"results":[]}' },
      ],
    };

    const result = buildFinalPayload(payload);
    assert.equal(result.messages[0].role, 'system');
    assert.equal(result.messages[0].content, 'You are helpful.');
    assert.equal(result.messages[1].role, 'user');
    assert.equal(result.messages[2].role, 'assistant');
    assert.equal(result.messages[2].content, 'Hi there!');
  });
});

// ── executeToolCalls ───────────────────────────────────────────

describe('executeToolCalls', () => {
  test('executes calculator tool', async () => {
    const assistantMsg = {
      content: null,
      tool_calls: [{
        id: 'call_1',
        function: { name: 'calculator', arguments: JSON.stringify({ operation: 'add', values: [10, 20, 30] }) },
      }],
    };

    const { assistantMessage, toolResultMessages } = await executeToolCalls(assistantMsg);

    assert.equal(assistantMessage.role, 'assistant');
    assert.equal(assistantMessage.tool_calls.length, 1);
    assert.equal(toolResultMessages.length, 1);
    assert.equal(toolResultMessages[0].role, 'tool');
    assert.equal(toolResultMessages[0].tool_call_id, 'call_1');

    const result = JSON.parse(toolResultMessages[0].content);
    assert.equal(result.result, '60');
  });

  test('executes multiple tool calls', async () => {
    const assistantMsg = {
      content: null,
      tool_calls: [
        { id: 'c1', function: { name: 'calculator', arguments: JSON.stringify({ operation: 'multiply', values: [6, 7] }) } },
        { id: 'c2', function: { name: 'calculator', arguments: JSON.stringify({ operation: 'sqrt', values: [144] }) } },
      ],
    };

    const { toolResultMessages } = await executeToolCalls(assistantMsg);
    assert.equal(toolResultMessages.length, 2);

    const r1 = JSON.parse(toolResultMessages[0].content);
    assert.equal(r1.result, '42');

    const r2 = JSON.parse(toolResultMessages[1].content);
    assert.equal(r2.result, '12');
  });

  test('handles unknown tool gracefully', async () => {
    const assistantMsg = {
      content: null,
      tool_calls: [{ id: 'c1', function: { name: 'nonexistent_tool', arguments: '{}' } }],
    };

    const { toolResultMessages } = await executeToolCalls(assistantMsg);
    const result = JSON.parse(toolResultMessages[0].content);
    assert.ok(result.error.includes('Unknown tool'));
  });

  test('handles malformed arguments', async () => {
    const assistantMsg = {
      content: null,
      tool_calls: [{ id: 'c1', function: { name: 'calculator', arguments: 'not json' } }],
    };

    const { toolResultMessages } = await executeToolCalls(assistantMsg);
    const result = JSON.parse(toolResultMessages[0].content);
    assert.ok(result.error); // Should have an error, not crash
  });

  test('preserves assistant content if present', async () => {
    const assistantMsg = {
      content: 'Let me calculate that for you.',
      tool_calls: [{ id: 'c1', function: { name: 'calculator', arguments: JSON.stringify({ operation: 'add', values: [1, 2] }) } }],
    };

    const { assistantMessage } = await executeToolCalls(assistantMsg);
    assert.equal(assistantMessage.content, 'Let me calculate that for you.');
  });
});

// ── Calculator operations ──────────────────────────────────────

describe('calculator via executeToolCalls', () => {
  async function calc(operation, values, extra = {}) {
    const msg = {
      content: null,
      tool_calls: [{ id: 'c1', function: { name: 'calculator', arguments: JSON.stringify({ operation, values, ...extra }) } }],
    };
    const { toolResultMessages } = await executeToolCalls(msg);
    return JSON.parse(toolResultMessages[0].content);
  }

  test('add', async () => { assert.equal((await calc('add', [1, 2, 3])).result, '6'); });
  test('subtract', async () => { assert.equal((await calc('subtract', [10, 3])).result, '7'); });
  test('multiply', async () => { assert.equal((await calc('multiply', [4, 5])).result, '20'); });
  test('divide', async () => { assert.equal((await calc('divide', [10, 4])).result, '2.5'); });
  test('divide by zero', async () => { assert.ok((await calc('divide', [10, 0])).error); });
  test('mod', async () => { assert.equal((await calc('mod', [10, 3])).result, '1'); });
  test('pow', async () => { assert.equal((await calc('pow', [2, 10])).result, '1024'); });
  test('sqrt', async () => { assert.equal((await calc('sqrt', [81])).result, '9'); });
  test('log', async () => { assert.equal((await calc('log', [100])).result, '2'); });
  test('ln', async () => { assert.equal(Number((await calc('ln', [Math.E])).result).toFixed(5), '1.00000'); });
  test('exp', async () => { assert.equal(Number((await calc('exp', [0])).result), 1); });
  test('abs', async () => { assert.equal((await calc('abs', [-42])).result, '42'); });
  test('floor', async () => { assert.equal((await calc('floor', [3.7])).result, '3'); });
  test('ceil', async () => { assert.equal((await calc('ceil', [3.2])).result, '4'); });
  test('round', async () => { assert.equal((await calc('round', [3.5])).result, '4'); });
  test('average', async () => { assert.equal((await calc('average', [10, 20, 30])).result, '20'); });
  test('median odd', async () => { assert.equal((await calc('median', [1, 3, 2])).result, '2'); });
  test('median even', async () => { assert.equal((await calc('median', [1, 2, 3, 4])).result, '2.5'); });
  test('min', async () => { assert.equal((await calc('min', [5, 3, 8, 1])).result, '1'); });
  test('max', async () => { assert.equal((await calc('max', [5, 3, 8, 1])).result, '8'); });
  test('sum', async () => { assert.equal((await calc('sum', [1, 2, 3, 4, 5])).result, '15'); });
  test('count', async () => { assert.equal((await calc('count', [1, 2, 3])).result, '3'); });
  test('percentile', async () => {
    const r = await calc('percentile', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], { percentile_rank: 50 });
    assert.equal(r.result, '5.5');
  });
  test('unknown operation', async () => { assert.ok((await calc('foobar', [1])).error); });
  test('empty values', async () => { assert.ok((await calc('add', [])).error); });
});

// ── Web search (live, DuckDuckGo) ──────────────────────────────

describe('web_search via executeToolCalls', () => {
  test('returns valid JSON structure (network-dependent)', async () => {
    const msg = {
      content: null,
      tool_calls: [{ id: 'c1', function: { name: 'web_search', arguments: JSON.stringify({ query: 'JavaScript', count: 2 }) } }],
    };
    const { toolResultMessages } = await executeToolCalls(msg);
    const result = JSON.parse(toolResultMessages[0].content);
    // Should return valid JSON regardless of network state
    assert.ok(typeof result === 'object');
    assert.ok(result.provider || result.error);
  }, { timeout: 20_000 });
});

// ── Web fetch (live) ───────────────────────────────────────────

describe('web_fetch via executeToolCalls', () => {
  test('fetches a valid HTTPS page', async () => {
    const msg = {
      content: null,
      tool_calls: [{ id: 'c1', function: { name: 'web_fetch', arguments: JSON.stringify({ url: 'https://example.com', max_chars: 1000 }) } }],
    };
    const { toolResultMessages } = await executeToolCalls(msg);
    const result = JSON.parse(toolResultMessages[0].content);

    assert.ok(result.url);
    assert.ok(result.content);
    assert.ok(result.content.includes('Example Domain'));
  });

  test('rejects HTTP URLs', async () => {
    const msg = {
      content: null,
      tool_calls: [{ id: 'c1', function: { name: 'web_fetch', arguments: JSON.stringify({ url: 'http://example.com' }) } }],
    };
    const { toolResultMessages } = await executeToolCalls(msg);
    const result = JSON.parse(toolResultMessages[0].content);
    assert.ok(result.error);
    assert.ok(result.error.includes('HTTPS'));
  });

  test('blocks private IPs', async () => {
    const msg = {
      content: null,
      tool_calls: [{ id: 'c1', function: { name: 'web_fetch', arguments: JSON.stringify({ url: 'https://127.0.0.1' }) } }],
    };
    const { toolResultMessages } = await executeToolCalls(msg);
    const result = JSON.parse(toolResultMessages[0].content);
    assert.ok(result.error);
    assert.ok(result.error.includes('Blocked'));
  });

  test('handles invalid URL', async () => {
    const msg = {
      content: null,
      tool_calls: [{ id: 'c1', function: { name: 'web_fetch', arguments: JSON.stringify({ url: 'not-a-url' }) } }],
    };
    const { toolResultMessages } = await executeToolCalls(msg);
    const result = JSON.parse(toolResultMessages[0].content);
    assert.ok(result.error);
  });
});
