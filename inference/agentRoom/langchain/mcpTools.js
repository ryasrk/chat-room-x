import { DynamicStructuredTool } from '@langchain/core/tools';

import { callMcpTool, listMcpToolDefinitions } from '../mcpToolRegistry.js';

export async function createMcpTools(providerConfig) {
  const definitions = await listMcpToolDefinitions(providerConfig);

  return definitions.map((definition) => new DynamicStructuredTool({
    name: definition.name,
    description: definition.description,
    schema: definition.schema,
    func: async (input) => callMcpTool(providerConfig, definition.name, input),
  }));
}