import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { chatCompletionWithConfig, getProviderPresets } from './modelRouter.js';

function createToolCall(id, name, args) {
  return {
    id,
    type: 'function',
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  };
}

async function startFakeModelServer(responseFactory) {
  const requests = [];
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404).end();
      return;
    }

    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      requests.push(parsed);
      const response = responseFactory(parsed, requests.length - 1);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    }),
  };
}

test('chatCompletionWithConfig sends OpenAI-compatible tools and parses native tool calls', async (t) => {
  const server = await startFakeModelServer((parsed) => ({
    model: parsed.model,
    choices: [
      {
        message: {
          role: 'assistant',
          content: 'I should inspect the workspace first.',
          tool_calls: [createToolCall('call_list_files', 'list_files', { path: '.' })],
        },
      },
    ],
    usage: {
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18,
    },
  }));

  t.after(async () => {
    await server.close();
  });

  const providerConfig = {
    provider: 'custom',
    base_url: server.baseUrl,
    api_key: 'test-key',
    model: 'custom-tool-model',
    max_tokens: 512,
    temperature: 0,
  };

  const result = await chatCompletionWithConfig(
    providerConfig,
    'worker',
    [{ role: 'user', content: 'List the workspace files.' }],
    {
      tools: [
        {
          name: 'list_files',
          description: 'List files in the workspace.',
          schema: {
            type: 'object',
            properties: {
              path: { type: 'string' },
            },
            required: ['path'],
          },
        },
      ],
      toolChoice: 'auto',
      systemPrompt: 'You are a helpful workspace assistant.',
    },
  );

  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].tools.length, 1);
  assert.deepEqual(server.requests[0].tools[0], {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
        },
        required: ['path'],
      },
    },
  });
  assert.equal(server.requests[0].tool_choice, 'auto');
  assert.equal(result.content, 'I should inspect the workspace first.');
  assert.deepEqual(result.toolCalls, [
    {
      id: 'call_list_files',
      name: 'list_files',
      args: { path: '.' },
      type: 'tool_call',
    },
  ]);
});

test('chatCompletionWithConfig preserves legacy content-only behavior when no tools are supplied', async (t) => {
  const server = await startFakeModelServer((parsed) => ({
    model: parsed.model,
    choices: [
      {
        message: {
          role: 'assistant',
          content: 'No tools required for this answer.',
        },
      },
    ],
    usage: {
      prompt_tokens: 5,
      completion_tokens: 6,
      total_tokens: 11,
    },
  }));

  t.after(async () => {
    await server.close();
  });

  const result = await chatCompletionWithConfig(
    {
      provider: 'custom',
      base_url: server.baseUrl,
      api_key: 'test-key',
      model: 'plain-model',
    },
    'worker',
    [{ role: 'user', content: 'Say hello.' }],
    {},
  );

  assert.equal(server.requests.length, 1);
  assert.equal('tools' in server.requests[0], false);
  assert.equal(result.content, 'No tools required for this answer.');
  assert.deepEqual(result.toolCalls, []);
});

test('getProviderPresets exposes enowxai as a first-class provider preset', () => {
  const presets = getProviderPresets();

  assert.ok('enowxai' in presets);
  assert.equal(typeof presets.enowxai.base_url, 'string');
  assert.equal(typeof presets.enowxai.default_model, 'string');
});