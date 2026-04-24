import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, readFile as readFileFromFs, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

import { runReactiveAgentTurn } from './reactiveAgent.js';
import {
  __resetMcpClientFactoryForTests,
  __resetMcpClientRegistryForTests,
  __setMcpClientFactoryForTests,
} from '../mcpToolRegistry.js';

function createAgent(name, role, model, baseUrl, tools = ['list_files', 'read_file', 'write_file', 'update_file']) {
  return {
    name,
    role,
    model_tier: 'worker',
    system_prompt: `You are ${name}.`,
    tools,
    provider_config: {
      provider: 'custom',
      base_url: baseUrl,
      model,
      api_key: 'test-key',
      max_tokens: 1024,
      temperature: 0,
    },
  };
}

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

async function startFakeModelServer(responsesByModel) {
  const responseIndexes = new Map();
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

      const configured = responsesByModel[parsed.model];
      const response = Array.isArray(configured)
        ? configured[Math.min(responseIndexes.get(parsed.model) || 0, configured.length - 1)]
        : configured;
      responseIndexes.set(parsed.model, (responseIndexes.get(parsed.model) || 0) + 1);
      if (!response) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `No fake response configured for model ${parsed.model}` }));
        return;
      }

      if (response && typeof response === 'object' && Number.isInteger(response.statusCode) && response.statusCode >= 400) {
        res.writeHead(response.statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response.body || { error: 'Synthetic failure' }));
        return;
      }

      const normalized = typeof response === 'string'
        ? {
            role: 'assistant',
            content: response,
          }
        : {
            role: response.role || 'assistant',
            content: response.content ?? '',
            ...(Array.isArray(response.tool_calls) ? { tool_calls: response.tool_calls } : {}),
          };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        model: parsed.model,
        choices: [{ message: normalized }],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 18,
          total_tokens: 30,
        },
      }));
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

function createRoomContext(workspacePath, agents) {
  return {
    roomId: 'room-test',
    roomName: 'Calculator Room',
    roomDescription: 'Agents collaborate to plan, build, and review a simple calculator.',
    workspacePath,
    workspaceListing: '[workspace root]',
    privateMemory: '',
    agents,
  };
}

function appendTurn(history, agentName, toolMessages, result) {
  for (const message of toolMessages) {
    history.push(message);
  }

  history.push({
    sender_type: 'agent',
    sender_name: agentName,
    content: result.message,
    event_type: 'message',
  });
}

test('agents can plan, hand off, implement, and review a simple calculator with tools', async (t) => {
  const fakeResponses = {
    'planner-model': [
      '```json',
      JSON.stringify({ tool: 'think_aloud', thought: 'I will create a short plan and hand implementation to @coder.' }),
      '```',
      '```json',
      JSON.stringify({
        tool: 'write_file',
        path: 'notes/plan.md',
        content: '# Calculator Plan\n- Build add and subtract helpers.\n- Export calculate(operation, a, b).\n- Ask @reviewer to validate behavior.\n',
      }),
      '```',
      '```json',
      JSON.stringify({
        tool: 'propose',
        title: 'Simple calculator scope',
        content: 'Implement add/subtract first and keep unsupported operations explicit.',
        request_review_from: ['reviewer'],
      }),
      '```',
      '```json',
      JSON.stringify({
        tool: 'delegate',
        to_agent: 'coder',
        task: 'Implement src/calculator.js with add, subtract, and calculate.',
        context: 'Read notes/plan.md before coding.',
      }),
      '```',
      'Plan saved in notes/plan.md. @coder please implement the calculator next.',
    ].join('\n'),
    'coder-model': [
      '```json',
      JSON.stringify({ tool: 'read_file', path: 'notes/plan.md' }),
      '```',
      '```json',
      JSON.stringify({
        tool: 'write_file',
        path: 'src/calculator.js',
        content: [
          'export function add(a, b) {',
          '  return a + b;',
          '}',
          '',
          'export function subtract(a, b) {',
          '  return a - b;',
          '}',
          '',
          'export function calculate(operation, a, b) {',
          "  if (operation === 'add') return add(a, b);",
          "  if (operation === 'subtract') return subtract(a, b);",
          "  throw new Error('Unsupported operation');",
          '}',
          '',
        ].join('\n'),
      }),
      '```',
      '```json',
      JSON.stringify({
        tool: 'delegate',
        to_agent: 'reviewer',
        task: 'Review src/calculator.js for correctness and edge cases.',
        context: 'Confirm add/subtract behavior and unsupported operation handling.',
      }),
      '```',
      'Implemented src/calculator.js and handed review to @reviewer.',
    ].join('\n'),
    'reviewer-model': [
      '```json',
      JSON.stringify({ tool: 'read_file', path: 'src/calculator.js' }),
      '```',
      '```json',
      JSON.stringify({
        tool: 'respond_to_proposal',
        verdict: 'approve',
        reasoning: 'The calculator stays within the proposed add/subtract scope and handles unsupported operations explicitly.',
      }),
      '```',
      '```json',
      JSON.stringify({
        tool: 'write_file',
        path: 'notes/review.md',
        content: '# Review\n- add works\n- subtract works\n- unsupported operations throw a clear error\n',
      }),
      '```',
      'Review complete. The calculator implementation is correct and the notes are saved in notes/review.md.',
    ].join('\n'),
  };

  const server = await startFakeModelServer(fakeResponses);
  const workspacePath = await mkdtemp(join(tmpdir(), 'agent-room-calculator-'));

  t.after(async () => {
    await server.close();
    await rm(workspacePath, { recursive: true, force: true });
  });

  const agents = [
    createAgent('planner', 'Breaks work into steps and coordinates implementation.', 'planner-model', server.baseUrl),
    createAgent('coder', 'Implements code and updates files in the workspace.', 'coder-model', server.baseUrl),
    createAgent('reviewer', 'Reviews proposals and checks quality risks.', 'reviewer-model', server.baseUrl),
  ];

  const roomContext = createRoomContext(workspacePath, agents);
  const conversationHistory = [
    {
      sender_type: 'user',
      sender_name: 'alice',
      content: 'Please plan and build a simple calculator, then review it as a team.',
      event_type: 'message',
    },
  ];

  const postedMessages = [];
  const postMessage = async (senderName, content, eventType = 'message') => {
    const message = {
      sender_type: 'agent',
      sender_name: senderName,
      content,
      event_type: eventType,
    };
    postedMessages.push(message);
    return message;
  };

  const plannerResult = await runReactiveAgentTurn({
    agent: agents[0],
    roomContext,
    input: 'New room message from user alice: Please plan and build a simple calculator, then review it as a team.',
    conversationHistory,
    postMessage,
  });

  const plannerMessages = postedMessages.splice(0);
  appendTurn(conversationHistory, 'planner', plannerMessages, plannerResult);

  assert.equal(plannerResult.handoffs.length, 1);
  assert.equal(plannerResult.handoffs[0].agentName, 'coder');
  assert.match(plannerResult.handoffs[0].message, /@coder/i);
  assert.match(plannerResult.handoffs[0].message, /calculator/i);
  assert.deepEqual(
    plannerResult.toolResults.map((result) => result.tool),
    ['think_aloud', 'write_file', 'propose', 'delegate'],
  );
  assert.equal(plannerResult.toolResults[1].params.path, 'notes/plan.md');
  assert.ok(plannerMessages.some((message) => message.event_type === 'thinking'));
  assert.ok(plannerMessages.some((message) => message.event_type === 'proposal'));
  assert.ok(plannerMessages.some((message) => message.event_type === 'handoff'));
  assert.match(plannerResult.message, /notes\/plan\.md/);

  const coderResult = await runReactiveAgentTurn({
    agent: agents[1],
    roomContext,
    input: plannerResult.handoffs[0].message,
    conversationHistory,
    postMessage,
  });

  const coderMessages = postedMessages.splice(0);
  appendTurn(conversationHistory, 'coder', coderMessages, coderResult);

  assert.equal(coderResult.handoffs.length, 1);
  assert.equal(coderResult.handoffs[0].agentName, 'reviewer');
  assert.match(coderResult.handoffs[0].message, /@reviewer/i);
  assert.deepEqual(
    coderResult.toolResults.map((result) => result.tool),
    ['read_file', 'write_file', 'delegate'],
  );
  assert.equal(coderResult.toolResults[0].params.path, 'notes/plan.md');
  assert.equal(coderResult.toolResults[1].params.path, 'src/calculator.js');
  assert.ok(coderMessages.some((message) => message.event_type === 'handoff'));

  const reviewerResult = await runReactiveAgentTurn({
    agent: agents[2],
    roomContext,
    input: coderResult.handoffs[0].message,
    conversationHistory,
    postMessage,
  });

  const reviewerMessages = postedMessages.splice(0);
  appendTurn(conversationHistory, 'reviewer', reviewerMessages, reviewerResult);

  assert.deepEqual(
    reviewerResult.toolResults.map((result) => result.tool),
    ['read_file', 'respond_to_proposal', 'write_file'],
  );
  assert.equal(reviewerResult.toolResults[0].params.path, 'src/calculator.js');
  assert.ok(reviewerMessages.some((message) => message.event_type === 'proposal_response'));
  assert.ok(reviewerMessages.some((message) => /APPROVE:/i.test(message.content)));

  const planContent = await readFileFromFs(join(workspacePath, 'notes', 'plan.md'), 'utf8');
  const calculatorSource = await readFileFromFs(join(workspacePath, 'src', 'calculator.js'), 'utf8');
  const reviewContent = await readFileFromFs(join(workspacePath, 'notes', 'review.md'), 'utf8');

  assert.match(planContent, /Calculator Plan/);
  assert.match(calculatorSource, /export function calculate/);
  assert.match(reviewContent, /unsupported operations throw a clear error/i);

  const calculatorModule = await import(pathToFileURL(join(workspacePath, 'src', 'calculator.js')).href);
  assert.equal(calculatorModule.add(2, 3), 5);
  assert.equal(calculatorModule.subtract(7, 4), 3);
  assert.equal(calculatorModule.calculate('add', 10, 5), 15);
  assert.throws(() => calculatorModule.calculate('multiply', 2, 3), /Unsupported operation/);

  assert.equal(server.requests.length, 3);
  assert.deepEqual(
    server.requests.map((request) => request.model),
    ['planner-model', 'coder-model', 'reviewer-model'],
  );
  assert.ok(server.requests[1].messages.some((message) => String(message.content).includes('notes/plan.md')));
  assert.ok(server.requests[2].messages.some((message) => String(message.content).includes('src/calculator.js')));
});

test('reactive agent normalizes aliased tool args and strips duplicate handoff mentions', async (t) => {
  const fakeResponses = {
    'planner-model': [
      '```json',
      JSON.stringify({ tool: 'write_file', params: { filePath: 'notes/plan.md', contents: '# Plan\n- Build calculator\n' } }),
      '```',
      '```json',
      JSON.stringify({ tool: 'delegate', arguments: { to: '@coder', instructions: 'Implement src/calculator.js', details: 'Read notes/plan.md first.' } }),
      '```',
      'Plan written to notes/plan.md. @coder please implement the calculator.',
    ].join('\n'),
  };

  const server = await startFakeModelServer(fakeResponses);
  const workspacePath = await mkdtemp(join(tmpdir(), 'agent-room-normalize-'));

  t.after(async () => {
    await server.close();
    await rm(workspacePath, { recursive: true, force: true });
  });

  const agents = [
    createAgent('planner', 'Breaks work into steps and coordinates implementation.', 'planner-model', server.baseUrl),
    createAgent('coder', 'Implements code and updates files in the workspace.', 'coder-model', server.baseUrl),
  ];

  const postedMessages = [];
  const postMessage = async (senderName, content, eventType = 'message') => {
    const message = {
      sender_type: 'agent',
      sender_name: senderName,
      content,
      event_type: eventType,
    };
    postedMessages.push(message);
    return message;
  };

  const result = await runReactiveAgentTurn({
    agent: agents[0],
    roomContext: createRoomContext(workspacePath, agents),
    input: 'New room message from user alice: Please build a simple calculator.',
    conversationHistory: [],
    postMessage,
  });

  assert.deepEqual(
    result.toolResults.map((toolResult) => toolResult.params),
    [
      { tool: 'write_file', path: 'notes/plan.md', content: '# Plan\n- Build calculator\n' },
      { tool: 'delegate', to_agent: 'coder', task: 'Implement src/calculator.js', context: 'Read notes/plan.md first.' },
    ],
  );
  assert.equal(result.handoffs.length, 1);
  assert.equal(result.handoffs[0].agentName, 'coder');
  assert.ok(postedMessages.some((message) => message.event_type === 'handoff' && /^@coder\b/.test(message.content)));
  assert.ok(postedMessages.every((message) => !message.content.includes('@@coder')));

  const planContent = await readFileFromFs(join(workspacePath, 'notes', 'plan.md'), 'utf8');
  assert.match(planContent, /Build calculator/);
});

test('reactive agent continues after an exploratory tool call to finish the handoff', async (t) => {
  const fakeResponses = {
    'planner-model': [
      [
        '```json',
        JSON.stringify({ tool: 'list_files', path: '.' }),
        '```',
        'I listed the files and directories in the workspace to understand the current state before planning the calculator.',
      ].join('\n'),
      [
        '```json',
        JSON.stringify({ tool: 'write_file', path: 'notes/plan.md', content: '# Calculator Plan\n- Build calculator UI\n- Hand implementation to @coder\n' }),
        '```',
        '```json',
        JSON.stringify({ tool: 'delegate', to_agent: 'coder', task: 'Implement src/calculator.js', context: 'Use notes/plan.md as the spec.' }),
        '```',
        'Plan saved in notes/plan.md. @coder please implement the calculator.',
      ].join('\n'),
    ],
  };
  const server = await startFakeModelServer(fakeResponses);
  const workspacePath = await mkdtemp(join(tmpdir(), 'agent-room-follow-up-'));

  t.after(async () => {
    await server.close();
    await rm(workspacePath, { recursive: true, force: true });
  });

  const agents = [
    createAgent('planner', 'Breaks work into steps and coordinates implementation.', 'planner-model', server.baseUrl),
    createAgent('coder', 'Implements code and updates files in the workspace.', 'coder-model', server.baseUrl),
  ];

  const postedMessages = [];
  const postMessage = async (senderName, content, eventType = 'message') => {
    const message = {
      sender_type: 'agent',
      sender_name: senderName,
      content,
      event_type: eventType,
    };
    postedMessages.push(message);
    return message;
  };

  const result = await runReactiveAgentTurn({
    agent: agents[0],
    roomContext: createRoomContext(workspacePath, agents),
    input: 'New room message from user alice: Please plan and build a calculator.',
    conversationHistory: [],
    postMessage,
  });

  assert.deepEqual(
    result.toolResults.map((toolResult) => toolResult.tool),
    ['list_files', 'write_file', 'delegate'],
  );
  assert.equal(result.handoffs.length, 1);
  assert.equal(result.handoffs[0].agentName, 'coder');
  assert.match(result.message, /notes\/plan\.md/);
  assert.equal(server.requests.length, 2);

  const planContent = await readFileFromFs(join(workspacePath, 'notes', 'plan.md'), 'utf8');
  assert.match(planContent, /Calculator Plan/);
  assert.ok(postedMessages.some((message) => message.event_type === 'handoff'));
});

test('reactive agent retries once when text mode narrates intent without invoking tools', async (t) => {
  const fakeResponses = {
    'planner-model': [
      'I will create a plan file and then hand the calculator implementation to @coder.',
      [
        '```json',
        JSON.stringify({ tool: 'write_file', path: 'notes/plan.md', content: '# Calculator Plan\n- Build calculator\n' }),
        '```',
        '```json',
        JSON.stringify({ tool: 'delegate', to_agent: 'coder', task: 'Implement src/calculator.js', context: 'Use notes/plan.md.' }),
        '```',
        'Plan saved in notes/plan.md. @coder please implement the calculator.',
      ].join('\n'),
    ],
  };

  const server = await startFakeModelServer(fakeResponses);
  const workspacePath = await mkdtemp(join(tmpdir(), 'agent-room-text-retry-'));

  t.after(async () => {
    await server.close();
    await rm(workspacePath, { recursive: true, force: true });
  });

  const agents = [
    createAgent('planner', 'Breaks work into steps and coordinates implementation.', 'planner-model', server.baseUrl),
    createAgent('coder', 'Implements code and updates files in the workspace.', 'coder-model', server.baseUrl),
  ];
  agents[0].provider_config.tool_calling_mode = 'text';

  const result = await runReactiveAgentTurn({
    agent: agents[0],
    roomContext: createRoomContext(workspacePath, agents),
    input: 'New room message from user alice: Please plan and build a calculator.',
    conversationHistory: [],
    postMessage: async () => null,
  });

  assert.deepEqual(
    result.toolResults.map((toolResult) => toolResult.tool),
    ['write_file', 'delegate'],
  );
  assert.ok(result.handoffs.some((handoff) => handoff.agentName === 'coder'));
  assert.equal(server.requests.length, 2);
  assert.ok(server.requests[1].messages.some((message) => String(message.content).includes('did not invoke any tools')));
});

test('reactive agent retries once when a text-mode tool call fails and a correction is possible', async (t) => {
  const fakeResponses = {
    'planner-model': [
      [
        '```json',
        JSON.stringify({ tool: 'write_file', path: 'notes', content: '# Calculator Plan\n- Build calculator\n' }),
        '```',
        'I attempted to save the plan.',
      ].join('\n'),
      [
        '```json',
        JSON.stringify({ tool: 'write_file', path: 'notes/plan.md', content: '# Calculator Plan\n- Build calculator\n' }),
        '```',
        '```json',
        JSON.stringify({ tool: 'delegate', to_agent: 'coder', task: 'Implement src/calculator.js', context: 'Use notes/plan.md.' }),
        '```',
        'Plan saved in notes/plan.md. @coder please implement the calculator.',
      ].join('\n'),
    ],
  };

  const server = await startFakeModelServer(fakeResponses);
  const workspacePath = await mkdtemp(join(tmpdir(), 'agent-room-tool-failure-retry-'));

  t.after(async () => {
    await server.close();
    await rm(workspacePath, { recursive: true, force: true });
  });

  await mkdir(join(workspacePath, 'notes'), { recursive: true });

  const agents = [
    createAgent('planner', 'Breaks work into steps and coordinates implementation.', 'planner-model', server.baseUrl),
    createAgent('coder', 'Implements code and updates files in the workspace.', 'coder-model', server.baseUrl),
  ];
  agents[0].provider_config.tool_calling_mode = 'text';

  const result = await runReactiveAgentTurn({
    agent: agents[0],
    roomContext: createRoomContext(workspacePath, agents),
    input: 'New room message from user alice: Please plan and build a calculator.',
    conversationHistory: [],
    postMessage: async () => null,
  });

  assert.deepEqual(
    result.toolResults.map((toolResult) => toolResult.tool),
    ['write_file', 'write_file', 'delegate'],
  );
  assert.ok(result.toolResults[0].error);
  assert.ok(result.handoffs.some((handoff) => handoff.agentName === 'coder'));
  assert.equal(server.requests.length, 2);
  assert.ok(server.requests[1].messages.some((message) => String(message.content).includes('Tool results')));
});

test('reviewer cannot write implementation files through the reactive agent workspace tools', async (t) => {
  const fakeResponses = {
    'reviewer-model': [
      [
        '```json',
        JSON.stringify({ tool: 'write_file', path: 'src/calculator.js', content: 'export const broken = true;\n' }),
        '```',
        'Attempted to write the implementation file.',
      ].join('\n'),
    ],
  };

  const server = await startFakeModelServer(fakeResponses);
  const workspacePath = await mkdtemp(join(tmpdir(), 'agent-room-reviewer-write-'));

  t.after(async () => {
    await server.close();
    await rm(workspacePath, { recursive: true, force: true });
  });

  const agents = [
    createAgent('reviewer', 'Reviews proposals and checks quality risks.', 'reviewer-model', server.baseUrl),
  ];

  const result = await runReactiveAgentTurn({
    agent: agents[0],
    roomContext: createRoomContext(workspacePath, agents),
    input: 'New room message from user alice: Review the calculator implementation.',
    conversationHistory: [],
    postMessage: async () => null,
  });

  assert.equal(result.toolResults.length, 1);
  assert.equal(result.toolResults[0].tool, 'write_file');
  assert.match(result.toolResults[0].error || '', /Reviewer cannot write implementation files/i);
});

test('agents can plan, hand off, implement, and review a simple calculator with native tool calls', async (t) => {
  const fakeResponses = {
    'planner-model': [
      {
        content: '',
        tool_calls: [
          createToolCall('planner-think', 'think_aloud', { thought: 'I will create a short plan and hand implementation to @coder.' }),
          createToolCall('planner-write', 'write_file', {
            path: 'notes/plan.md',
            content: '# Calculator Plan\n- Build add and subtract helpers.\n- Export calculate(operation, a, b).\n- Ask @reviewer to validate behavior.\n',
          }),
          createToolCall('planner-propose', 'propose', {
            title: 'Simple calculator scope',
            content: 'Implement add/subtract first and keep unsupported operations explicit.',
            request_review_from: ['reviewer'],
          }),
          createToolCall('planner-delegate', 'delegate', {
            to_agent: 'coder',
            task: 'Implement src/calculator.js with add, subtract, and calculate.',
            context: 'Read notes/plan.md before coding.',
          }),
        ],
      },
      {
        content: 'Plan saved in notes/plan.md. @coder please implement the calculator next.',
      },
    ],
    'coder-model': [
      {
        content: '',
        tool_calls: [
          createToolCall('coder-read', 'read_file', { path: 'notes/plan.md' }),
          createToolCall('coder-write', 'write_file', {
            path: 'src/calculator.js',
            content: [
              'export function add(a, b) {',
              '  return a + b;',
              '}',
              '',
              'export function subtract(a, b) {',
              '  return a - b;',
              '}',
              '',
              'export function calculate(operation, a, b) {',
              "  if (operation === 'add') return add(a, b);",
              "  if (operation === 'subtract') return subtract(a, b);",
              "  throw new Error('Unsupported operation');",
              '}',
              '',
            ].join('\n'),
          }),
          createToolCall('coder-delegate', 'delegate', {
            to_agent: 'reviewer',
            task: 'Review src/calculator.js for correctness and edge cases.',
            context: 'Confirm add/subtract behavior and unsupported operation handling.',
          }),
        ],
      },
      {
        content: 'Implemented src/calculator.js and handed review to @reviewer.',
      },
    ],
    'reviewer-model': [
      {
        content: '',
        tool_calls: [
          createToolCall('reviewer-read', 'read_file', { path: 'src/calculator.js' }),
          createToolCall('reviewer-respond', 'respond_to_proposal', {
            verdict: 'approve',
            reasoning: 'The calculator stays within the proposed add/subtract scope and handles unsupported operations explicitly.',
          }),
          createToolCall('reviewer-write', 'write_file', {
            path: 'notes/review.md',
            content: '# Review\n- add works\n- subtract works\n- unsupported operations throw a clear error\n',
          }),
        ],
      },
      {
        content: 'Review complete. The calculator implementation is correct and the notes are saved in notes/review.md.',
      },
    ],
  };

  const server = await startFakeModelServer(fakeResponses);
  const workspacePath = await mkdtemp(join(tmpdir(), 'agent-room-native-calculator-'));

  t.after(async () => {
    await server.close();
    await rm(workspacePath, { recursive: true, force: true });
  });

  const agents = [
    createAgent('planner', 'Breaks work into steps and coordinates implementation.', 'planner-model', server.baseUrl),
    createAgent('coder', 'Implements code and updates files in the workspace.', 'coder-model', server.baseUrl),
    createAgent('reviewer', 'Reviews proposals and checks quality risks.', 'reviewer-model', server.baseUrl),
  ];

  const roomContext = createRoomContext(workspacePath, agents);
  const conversationHistory = [
    {
      sender_type: 'user',
      sender_name: 'alice',
      content: 'Please plan and build a simple calculator, then review it as a team.',
      event_type: 'message',
    },
  ];

  const postedMessages = [];
  const postMessage = async (senderName, content, eventType = 'message') => {
    const message = {
      sender_type: 'agent',
      sender_name: senderName,
      content,
      event_type: eventType,
    };
    postedMessages.push(message);
    return message;
  };

  const plannerResult = await runReactiveAgentTurn({
    agent: agents[0],
    roomContext,
    input: 'New room message from user alice: Please plan and build a simple calculator, then review it as a team.',
    conversationHistory,
    postMessage,
  });

  const plannerMessages = postedMessages.splice(0);
  appendTurn(conversationHistory, 'planner', plannerMessages, plannerResult);

  assert.equal(plannerResult.handoffs.length, 1);
  assert.equal(plannerResult.handoffs[0].agentName, 'coder');
  assert.deepEqual(
    plannerResult.toolResults.map((result) => result.tool),
    ['think_aloud', 'write_file', 'propose', 'delegate'],
  );

  const coderResult = await runReactiveAgentTurn({
    agent: agents[1],
    roomContext,
    input: plannerResult.handoffs[0].message,
    conversationHistory,
    postMessage,
  });

  const coderMessages = postedMessages.splice(0);
  appendTurn(conversationHistory, 'coder', coderMessages, coderResult);

  assert.equal(coderResult.handoffs.length, 1);
  assert.equal(coderResult.handoffs[0].agentName, 'reviewer');
  assert.deepEqual(
    coderResult.toolResults.map((result) => result.tool),
    ['read_file', 'write_file', 'delegate'],
  );

  const reviewerResult = await runReactiveAgentTurn({
    agent: agents[2],
    roomContext,
    input: coderResult.handoffs[0].message,
    conversationHistory,
    postMessage,
  });

  const reviewerMessages = postedMessages.splice(0);
  appendTurn(conversationHistory, 'reviewer', reviewerMessages, reviewerResult);

  assert.deepEqual(
    reviewerResult.toolResults.map((result) => result.tool),
    ['read_file', 'respond_to_proposal', 'write_file'],
  );

  const planContent = await readFileFromFs(join(workspacePath, 'notes', 'plan.md'), 'utf8');
  const calculatorSource = await readFileFromFs(join(workspacePath, 'src', 'calculator.js'), 'utf8');
  const reviewContent = await readFileFromFs(join(workspacePath, 'notes', 'review.md'), 'utf8');

  assert.match(planContent, /Calculator Plan/);
  assert.match(calculatorSource, /export function calculate/);
  assert.match(reviewContent, /unsupported operations throw a clear error/i);

  const calculatorModule = await import(pathToFileURL(join(workspacePath, 'src', 'calculator.js')).href);
  assert.equal(calculatorModule.add(2, 3), 5);
  assert.equal(calculatorModule.subtract(7, 4), 3);
  assert.equal(calculatorModule.calculate('add', 10, 5), 15);
  assert.throws(() => calculatorModule.calculate('multiply', 2, 3), /Unsupported operation/);

  assert.equal(server.requests.length, 6);
  assert.equal(server.requests[0].tools.length > 0, true);
  assert.ok(server.requests[1].messages.some((message) => message.role === 'tool' && message.tool_call_id === 'planner-write'));
  assert.ok(server.requests[3].messages.some((message) => message.role === 'tool' && message.tool_call_id === 'coder-write'));
  assert.ok(server.requests[5].messages.some((message) => message.role === 'tool' && message.tool_call_id === 'reviewer-write'));
});

test('reactive agent falls back to text-mode tools when auto native calling is rejected by the provider', async (t) => {
  const fakeResponses = {
    'planner-model': [
      {
        statusCode: 400,
        body: { error: 'This model does not support tools.' },
      },
      [
        '```json',
        JSON.stringify({ tool: 'write_file', path: 'notes/plan.md', content: '# Plan\n- Build calculator\n' }),
        '```',
        '```json',
        JSON.stringify({ tool: 'delegate', to_agent: 'coder', task: 'Implement src/calculator.js', context: 'Read notes/plan.md first.' }),
        '```',
        'Plan saved in notes/plan.md. @coder please implement the calculator.',
      ].join('\n'),
    ],
  };

  const server = await startFakeModelServer(fakeResponses);
  const workspacePath = await mkdtemp(join(tmpdir(), 'agent-room-auto-fallback-'));

  t.after(async () => {
    await server.close();
    await rm(workspacePath, { recursive: true, force: true });
  });

  const agents = [
    createAgent('planner', 'Breaks work into steps and coordinates implementation.', 'planner-model', server.baseUrl),
    createAgent('coder', 'Implements code and updates files in the workspace.', 'coder-model', server.baseUrl),
  ];

  const postedMessages = [];
  const postMessage = async (senderName, content, eventType = 'message') => {
    const message = {
      sender_type: 'agent',
      sender_name: senderName,
      content,
      event_type: eventType,
    };
    postedMessages.push(message);
    return message;
  };

  const result = await runReactiveAgentTurn({
    agent: agents[0],
    roomContext: createRoomContext(workspacePath, agents),
    input: 'New room message from user alice: Please plan and build a simple calculator.',
    conversationHistory: [],
    postMessage,
  });

  assert.equal(server.requests.length, 2);
  assert.equal(server.requests[0].tools.length > 0, true);
  assert.equal('tools' in server.requests[1], false);
  assert.deepEqual(
    result.toolResults.map((toolResult) => toolResult.tool),
    ['write_file', 'delegate'],
  );
  assert.equal(result.handoffs.length, 1);
  assert.equal(result.handoffs[0].agentName, 'coder');

  const planContent = await readFileFromFs(join(workspacePath, 'notes', 'plan.md'), 'utf8');
  assert.match(planContent, /Build calculator/);
});

test('reactive agent retries once after successful text-mode writes when the message still describes next actions', async (t) => {
  const fakeResponses = {
    'coder-model': [
      [
        '```json',
        JSON.stringify({ tool: 'write_file', path: 'notes/planner_plan.txt', content: '# Planner Notes\n- Build calculator\n' }),
        '```',
        '```json',
        JSON.stringify({ tool: 'write_file', path: 'src/calculator.js', content: 'export function add(a, b) {\n  return a + b;\n}\n' }),
        '```',
        'I implemented the calculator files. Next I will ask @reviewer to validate the result and summarize what changed.',
      ].join('\n'),
      [
        '```json',
        JSON.stringify({ tool: 'delegate', to_agent: 'reviewer', task: 'Review src/calculator.js for correctness.', context: 'Check the new calculator implementation and summarize issues if any.' }),
        '```',
        'Implemented src/calculator.js and handed review to @reviewer.',
      ].join('\n'),
    ],
  };

  const server = await startFakeModelServer(fakeResponses);
  const workspacePath = await mkdtemp(join(tmpdir(), 'agent-room-post-write-retry-'));

  t.after(async () => {
    await server.close();
    await rm(workspacePath, { recursive: true, force: true });
  });

  const agents = [
    createAgent('planner', 'Breaks work into steps and coordinates implementation.', 'planner-model', server.baseUrl),
    createAgent('coder', 'Implements code and updates files in the workspace.', 'coder-model', server.baseUrl),
    createAgent('reviewer', 'Reviews proposals and checks quality risks.', 'reviewer-model', server.baseUrl),
  ];
  agents[1].provider_config.tool_calling_mode = 'text';

  const postedMessages = [];
  const postMessage = async (senderName, content, eventType = 'message') => {
    const message = {
      sender_type: 'agent',
      sender_name: senderName,
      content,
      event_type: eventType,
    };
    postedMessages.push(message);
    return message;
  };

  const result = await runReactiveAgentTurn({
    agent: agents[1],
    roomContext: createRoomContext(workspacePath, agents),
    input: 'New room message from @planner (handoff): @coder Implement src/calculator.js and then ask @reviewer to review it.',
    conversationHistory: [],
    postMessage,
  });

  assert.deepEqual(
    result.toolResults.map((toolResult) => toolResult.tool),
    ['write_file', 'write_file', 'delegate'],
  );
  assert.ok(result.handoffs.some((handoff) => handoff.agentName === 'reviewer'));
  assert.equal(server.requests.length, 2);
  assert.ok(server.requests[1].messages.some((message) => String(message.content).includes('Tool results')));
  assert.ok(postedMessages.some((message) => message.event_type === 'handoff'));
});

test('reactive agent honors text-only tool mode in provider_config', async (t) => {
  const fakeResponses = {
    'planner-model': [
      [
        '```json',
        JSON.stringify({ tool: 'write_file', path: 'notes/plan.md', content: '# Plan\n- Stay in text tool mode\n' }),
        '```',
        'Plan saved in notes/plan.md.',
      ].join('\n'),
    ],
  };

  const server = await startFakeModelServer(fakeResponses);
  const workspacePath = await mkdtemp(join(tmpdir(), 'agent-room-text-mode-'));

  t.after(async () => {
    await server.close();
    await rm(workspacePath, { recursive: true, force: true });
  });

  const agents = [
    {
      ...createAgent('planner', 'Breaks work into steps and coordinates implementation.', 'planner-model', server.baseUrl),
      provider_config: {
        provider: 'custom',
        base_url: server.baseUrl,
        model: 'planner-model',
        api_key: 'test-key',
        max_tokens: 1024,
        temperature: 0,
        tool_calling_mode: 'text',
      },
    },
  ];

  const result = await runReactiveAgentTurn({
    agent: agents[0],
    roomContext: createRoomContext(workspacePath, agents),
    input: 'New room message from user alice: Create a short plan.',
    conversationHistory: [],
    postMessage: async (senderName, content, eventType = 'message') => ({
      sender_type: 'agent',
      sender_name: senderName,
      content,
      event_type: eventType,
    }),
  });

  assert.equal(server.requests.length, 1);
  assert.equal('tools' in server.requests[0], false);
  assert.deepEqual(result.toolResults.map((toolResult) => toolResult.tool), ['write_file']);

  const planContent = await readFileFromFs(join(workspacePath, 'notes', 'plan.md'), 'utf8');
  assert.match(planContent, /text tool mode/i);
});

test('reactive agent can execute an MCP-backed tool through the native OpenAI-compatible path', async (t) => {
  __setMcpClientFactoryForTests(async () => ({
    transport: {
      close: async () => {},
    },
    client: {
      request: async (request) => {
        if (request.method === 'tools/list') {
          return {
            tools: [
              {
                name: 'search_docs',
                description: 'Search product documentation.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    query: { type: 'string' },
                  },
                  required: ['query'],
                },
              },
            ],
          };
        }

        if (request.method === 'tools/call') {
          return {
            content: [
              {
                type: 'text',
                text: `Docs hit for ${request.params.arguments.query}`,
              },
            ],
          };
        }

        throw new Error(`Unexpected MCP request: ${request.method}`);
      },
    },
  }));

  const fakeResponses = {
    'planner-model': [
      {
        content: '',
        tool_calls: [
          createToolCall('mcp-search', 'mcp__docs__search_docs', { query: 'tool calling' }),
        ],
      },
      {
        content: 'I searched the MCP docs and found the relevant tool-calling guidance.',
      },
    ],
  };

  const server = await startFakeModelServer(fakeResponses);
  const workspacePath = await mkdtemp(join(tmpdir(), 'agent-room-mcp-tool-'));

  t.after(async () => {
    __resetMcpClientFactoryForTests();
    __resetMcpClientRegistryForTests();
    await server.close();
    await rm(workspacePath, { recursive: true, force: true });
  });

  const agents = [
    {
      ...createAgent('planner', 'Finds documentation and reports concise findings.', 'planner-model', server.baseUrl, []),
      provider_config: {
        provider: 'custom',
        base_url: server.baseUrl,
        api_key: 'test-key',
        model: 'planner-model',
        max_tokens: 1024,
        temperature: 0,
        mcp_servers: [
          {
            id: 'docs',
            transport: 'streamable_http',
            url: 'http://127.0.0.1:3100/mcp',
          },
        ],
      },
    },
  ];

  const result = await runReactiveAgentTurn({
    agent: agents[0],
    roomContext: createRoomContext(workspacePath, agents),
    input: 'New room message from user alice: Search the docs for tool calling guidance.',
    conversationHistory: [],
    postMessage: async (senderName, content, eventType = 'message') => ({
      sender_type: 'agent',
      sender_name: senderName,
      content,
      event_type: eventType,
    }),
  });

  assert.equal(server.requests.length, 2);
  assert.ok(server.requests[0].tools.some((tool) => tool.function.name === 'mcp__docs__search_docs'));
  assert.deepEqual(result.toolResults.map((toolResult) => toolResult.tool), ['mcp__docs__search_docs']);
  assert.match(String(result.toolResults[0].result), /Docs hit for tool calling/);
  assert.match(result.message, /searched the MCP docs/i);
});