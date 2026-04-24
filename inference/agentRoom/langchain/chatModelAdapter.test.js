import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { HumanMessage, ToolMessage } from '@langchain/core/messages';

import { createAgentModel } from './chatModelAdapter.js';
import { createWorkspaceTools } from './workspaceTools.js';

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

async function startFakeModelServer(responses) {
  const requests = [];
  let index = 0;
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
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response(parsed)));
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

test('AgentRoomChatModel bindTools returns AIMessage.tool_calls and preserves tool round-trip messages', async (t) => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'agent-room-chat-model-'));
  const server = await startFakeModelServer([
    (parsed) => ({
      model: parsed.model,
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'I will list the workspace files first.',
            tool_calls: [createToolCall('call_list_files', 'list_files', { path: '.' })],
          },
        },
      ],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 9,
        total_tokens: 21,
      },
    }),
    (parsed) => ({
      model: parsed.model,
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'The workspace has been listed successfully.',
          },
        },
      ],
      usage: {
        prompt_tokens: 15,
        completion_tokens: 8,
        total_tokens: 23,
      },
    }),
  ]);

  t.after(async () => {
    await server.close();
    await rm(workspacePath, { recursive: true, force: true });
  });

  const [listFilesTool] = createWorkspaceTools(workspacePath);
  const model = createAgentModel({
    name: 'planner',
    model_tier: 'worker',
    system_prompt: 'You are planner.',
    provider_config: {
      provider: 'custom',
      base_url: server.baseUrl,
      api_key: 'test-key',
      model: 'planner-model',
      max_tokens: 1024,
      temperature: 0,
    },
  }).bindTools([listFilesTool]);

  const firstResponse = await model.invoke([
    new HumanMessage('List the current workspace files.'),
  ]);

  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].tools.length, 1);
  assert.equal(firstResponse.content, 'I will list the workspace files first.');
  assert.deepEqual(firstResponse.tool_calls, [
    {
      id: 'call_list_files',
      name: 'list_files',
      args: { path: '.' },
      type: 'tool_call',
    },
  ]);

  const secondResponse = await model.invoke([
    new HumanMessage('List the current workspace files.'),
    firstResponse,
    new ToolMessage({
      content: '[{"path":"src","type":"directory"}]',
      tool_call_id: 'call_list_files',
    }),
  ]);

  assert.equal(server.requests.length, 2);
  const assistantMessage = server.requests[1].messages.find((message) => message.role === 'assistant');
  const toolMessage = server.requests[1].messages.find((message) => message.role === 'tool');
  assert.deepEqual(assistantMessage.tool_calls, [createToolCall('call_list_files', 'list_files', { path: '.' })]);
  assert.equal(toolMessage.tool_call_id, 'call_list_files');
  assert.equal(toolMessage.content, '[{"path":"src","type":"directory"}]');
  assert.equal(secondResponse.content, 'The workspace has been listed successfully.');
});