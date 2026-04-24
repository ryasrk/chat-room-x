const MCP_TOOL_PREFIX = 'mcp__';
const FORBIDDEN_MCP_HEADER_NAMES = new Set([
  'accept',
  'connection',
  'content-length',
  'content-type',
  'host',
  'keep-alive',
  'last-event-id',
  'mcp-protocol-version',
  'mcp-session-id',
  'transfer-encoding',
]);

let mcpClientFactory = createDefaultMcpClient;
const mcpClientRegistry = new Map();

function normalizeString(value, limit = 200) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function normalizeStringArray(values, itemLimit = 200) {
  if (!Array.isArray(values)) {
    return [];
  }

  return values.map((value) => normalizeString(value, itemLimit)).filter(Boolean);
}

function normalizeHttpHeaders(rawHeaders) {
  if (!rawHeaders || typeof rawHeaders !== 'object' || Array.isArray(rawHeaders)) {
    return undefined;
  }

  const headers = Object.fromEntries(
    Object.entries(rawHeaders)
      .map(([key, value]) => [normalizeString(key, 120), normalizeString(value, 2000)])
      .filter(([key, value]) => key && value)
      .filter(([key]) => !FORBIDDEN_MCP_HEADER_NAMES.has(key.toLowerCase())),
  );

  return Object.keys(headers).length > 0 ? headers : undefined;
}

function normalizeMcpServerConfigs(providerConfig) {
  const servers = Array.isArray(providerConfig?.mcp_servers) ? providerConfig.mcp_servers : [];

  return servers
    .map((server, index) => {
      if (!server || typeof server !== 'object') {
        return null;
      }

      const transport = normalizeString(server.transport || 'streamable_http', 40).toLowerCase();
      if (transport !== 'streamable_http' && transport !== 'stdio') {
        return null;
      }

      const id = normalizeString(server.id || `server_${index + 1}`, 60).toLowerCase().replace(/[^a-z0-9_-]+/g, '_');
      if (!id) {
        return null;
      }

      const normalized = {
        id,
        transport,
        allowed_tools: normalizeStringArray(server.allowed_tools, 120),
      };

      if (transport === 'streamable_http') {
        const url = normalizeString(server.url, 1000);
        if (!url) {
          return null;
        }
        normalized.url = url;

        const headers = normalizeHttpHeaders(server.headers);
        if (headers) {
          normalized.headers = headers;
        }
      } else {
        const command = normalizeString(server.command, 300);
        if (!command) {
          return null;
        }
        normalized.command = command;
        normalized.args = normalizeStringArray(server.args, 300);

        const cwd = normalizeString(server.cwd, 500);
        if (cwd) {
          normalized.cwd = cwd;
        }

        if (server.env && typeof server.env === 'object' && !Array.isArray(server.env)) {
          normalized.env = Object.fromEntries(
            Object.entries(server.env)
              .map(([key, value]) => [normalizeString(key, 120), normalizeString(value, 1000)])
              .filter(([key, value]) => key && value),
          );
        }
      }

      return normalized;
    })
    .filter(Boolean);
}

function buildServerKey(serverConfig) {
  return JSON.stringify(serverConfig);
}

function formatMcpToolName(serverId, toolName) {
  return `${MCP_TOOL_PREFIX}${serverId}__${toolName}`;
}

function parseMcpToolName(prefixedName) {
  const name = normalizeString(prefixedName, 300);
  if (!name.startsWith(MCP_TOOL_PREFIX)) {
    return null;
  }

  const remainder = name.slice(MCP_TOOL_PREFIX.length);
  const separatorIndex = remainder.indexOf('__');
  if (separatorIndex <= 0 || separatorIndex === remainder.length - 2) {
    return null;
  }

  return {
    serverId: remainder.slice(0, separatorIndex),
    toolName: remainder.slice(separatorIndex + 2),
  };
}

function isToolAllowed(serverConfig, toolName) {
  if (!Array.isArray(serverConfig.allowed_tools) || serverConfig.allowed_tools.length === 0) {
    return true;
  }

  return serverConfig.allowed_tools.includes(toolName);
}

function getToolSchema(tool) {
  if (tool?.inputSchema && typeof tool.inputSchema === 'object') {
    return tool.inputSchema;
  }

  if (tool?.input_schema && typeof tool.input_schema === 'object') {
    return tool.input_schema;
  }

  return {
    type: 'object',
    properties: {},
  };
}

function formatMcpToolDescription(serverConfig, tool) {
  const description = normalizeString(tool?.description || 'MCP tool', 500);
  return `[MCP ${serverConfig.id}] ${description}`;
}

function formatMcpToolResult(result) {
  if (!result || typeof result !== 'object') {
    return JSON.stringify(result ?? null);
  }

  if (!Array.isArray(result.content)) {
    return JSON.stringify(result);
  }

  const parts = result.content.map((item) => {
    if (item?.type === 'text' && typeof item.text === 'string') {
      return item.text;
    }

    return JSON.stringify(item);
  }).filter(Boolean);

  return parts.length > 0 ? parts.join('\n') : JSON.stringify(result.content);
}

export function buildStreamableHttpRequestInit(serverConfig) {
  const headers = normalizeHttpHeaders(serverConfig?.headers);
  if (!headers) {
    return undefined;
  }

  return { headers };
}

async function createDefaultMcpClient(serverConfig) {
  const [
    { Client },
    { StdioClientTransport },
    { StreamableHTTPClientTransport },
  ] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/stdio.js'),
    import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
  ]);

  const client = new Client({
    name: 'tenrary-x-agent-room',
    version: '1.0.0',
  });

  const transport = serverConfig.transport === 'stdio'
    ? new StdioClientTransport({
        command: serverConfig.command,
        args: serverConfig.args || [],
        ...(serverConfig.cwd ? { cwd: serverConfig.cwd } : {}),
        ...(serverConfig.env ? { env: serverConfig.env } : {}),
      })
    : new StreamableHTTPClientTransport(new URL(serverConfig.url), {
        ...(buildStreamableHttpRequestInit(serverConfig)
          ? { requestInit: buildStreamableHttpRequestInit(serverConfig) }
          : {}),
      });

  await client.connect(transport);

  return { client, transport };
}

async function getMcpClientEntry(serverConfig) {
  const key = buildServerKey(serverConfig);
  const existing = mcpClientRegistry.get(key);
  if (existing) {
    return existing;
  }

  const created = await mcpClientFactory(serverConfig);
  mcpClientRegistry.set(key, created);
  return created;
}

export async function listMcpToolDefinitions(providerConfig) {
  const serverConfigs = normalizeMcpServerConfigs(providerConfig);
  const definitions = [];

  for (const serverConfig of serverConfigs) {
    try {
      const { client } = await getMcpClientEntry(serverConfig);
      const toolsResult = await client.request({
        method: 'tools/list',
        params: {},
      });

      const tools = Array.isArray(toolsResult?.tools) ? toolsResult.tools : [];
      for (const tool of tools) {
        if (!tool?.name || !isToolAllowed(serverConfig, tool.name)) {
          continue;
        }

        definitions.push({
          name: formatMcpToolName(serverConfig.id, tool.name),
          description: formatMcpToolDescription(serverConfig, tool),
          schema: getToolSchema(tool),
        });
      }
    } catch {
      // Ignore unavailable MCP servers during tool discovery so the room can still operate.
    }
  }

  return definitions;
}

export async function callMcpTool(providerConfig, prefixedToolName, args = {}) {
  const parsedName = parseMcpToolName(prefixedToolName);
  if (!parsedName) {
    throw new Error(`Invalid MCP tool name: ${prefixedToolName}`);
  }

  const serverConfig = normalizeMcpServerConfigs(providerConfig)
    .find((candidate) => candidate.id === parsedName.serverId);
  if (!serverConfig) {
    throw new Error(`Unknown MCP server for tool: ${prefixedToolName}`);
  }
  if (!isToolAllowed(serverConfig, parsedName.toolName)) {
    throw new Error(`MCP tool is not allowed: ${prefixedToolName}`);
  }

  const { client } = await getMcpClientEntry(serverConfig);
  const result = await client.request({
    method: 'tools/call',
    params: {
      name: parsedName.toolName,
      arguments: args,
    },
  });

  return formatMcpToolResult(result);
}

export function __setMcpClientFactoryForTests(factory) {
  mcpClientFactory = factory;
}

export function __resetMcpClientFactoryForTests() {
  mcpClientFactory = createDefaultMcpClient;
}

export function __resetMcpClientRegistryForTests() {
  mcpClientRegistry.clear();
}