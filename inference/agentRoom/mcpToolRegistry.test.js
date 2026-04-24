import test from 'node:test';
import assert from 'node:assert/strict';

import {
  __resetMcpClientFactoryForTests,
  __resetMcpClientRegistryForTests,
  __setMcpClientFactoryForTests,
  buildStreamableHttpRequestInit,
  callMcpTool,
  listMcpToolDefinitions,
} from './mcpToolRegistry.js';

test('buildStreamableHttpRequestInit preserves custom auth headers and filters protocol headers', () => {
  const requestInit = buildStreamableHttpRequestInit({
    headers: {
      Authorization: 'Bearer top-secret',
      'X-Tenant': 'tenant-a',
      'mcp-session-id': 'do-not-override',
      accept: 'application/json',
    },
  });

  assert.deepEqual(requestInit, {
    headers: {
      Authorization: 'Bearer top-secret',
      'X-Tenant': 'tenant-a',
    },
  });
});

test('listMcpToolDefinitions exposes prefixed MCP tools and callMcpTool executes them', async (t) => {
  const requests = [];
  const seenServerConfigs = [];

  __setMcpClientFactoryForTests(async (serverConfig) => ({
    ...(seenServerConfigs.push(serverConfig), {}),
    transport: {
      close: async () => {},
    },
    client: {
      request: async (request) => {
        requests.push({ serverId: serverConfig.id, request });
        if (request.method === 'tools/list') {
          return {
            tools: [
              {
                name: 'search_docs',
                description: 'Search the documentation index.',
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
                text: `Found docs for ${request.params.arguments.query}`,
              },
            ],
          };
        }

        throw new Error(`Unexpected MCP request: ${request.method}`);
      },
    },
  }));

  t.after(() => {
    __resetMcpClientFactoryForTests();
    __resetMcpClientRegistryForTests();
  });

  const providerConfig = {
    mcp_servers: [
      {
        id: 'docs',
        transport: 'streamable_http',
        url: 'http://127.0.0.1:3100/mcp',
        headers: {
          Authorization: 'Bearer docs-token',
          'X-Workspace': 'room-42',
          'mcp-session-id': 'ignored',
        },
      },
    ],
  };

  const tools = await listMcpToolDefinitions(providerConfig);
  assert.deepEqual(tools, [
    {
      name: 'mcp__docs__search_docs',
      description: '[MCP docs] Search the documentation index.',
      schema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
      },
    },
  ]);
  assert.deepEqual(seenServerConfigs, [
    {
      id: 'docs',
      transport: 'streamable_http',
      url: 'http://127.0.0.1:3100/mcp',
      allowed_tools: [],
      headers: {
        Authorization: 'Bearer docs-token',
        'X-Workspace': 'room-42',
      },
    },
  ]);

  const result = await callMcpTool(providerConfig, 'mcp__docs__search_docs', { query: 'native tool calling' });
  assert.match(result, /Found docs for native tool calling/);
  assert.deepEqual(
    requests.map((entry) => [entry.serverId, entry.request.method]),
    [
      ['docs', 'tools/list'],
      ['docs', 'tools/call'],
    ],
  );
});

test('listMcpToolDefinitions honors per-server allowed_tools', async (t) => {
  __setMcpClientFactoryForTests(async () => ({
    transport: {
      close: async () => {},
    },
    client: {
      request: async () => ({
        tools: [
          {
            name: 'search_docs',
            description: 'Search the documentation index.',
            inputSchema: {
              type: 'object',
              properties: { query: { type: 'string' } },
              required: ['query'],
            },
          },
          {
            name: 'delete_docs',
            description: 'Delete the documentation index.',
            inputSchema: {
              type: 'object',
              properties: { id: { type: 'string' } },
              required: ['id'],
            },
          },
        ],
      }),
    },
  }));

  t.after(() => {
    __resetMcpClientFactoryForTests();
    __resetMcpClientRegistryForTests();
  });

  const tools = await listMcpToolDefinitions({
    mcp_servers: [
      {
        id: 'docs',
        transport: 'streamable_http',
        url: 'http://127.0.0.1:3100/mcp',
        allowed_tools: ['search_docs'],
      },
    ],
  });

  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['mcp__docs__search_docs'],
  );
});