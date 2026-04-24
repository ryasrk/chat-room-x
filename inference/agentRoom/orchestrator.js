import { LangChainAgentRoomOrchestrator } from './langchain/orchestratorEngine.js';

function unique(values) {
  return [...new Set(values)];
}

function decodeJsonString(value) {
  try {
    return JSON.parse(`"${value}"`);
  } catch {
    return value;
  }
}

function extractJsonStringField(source, fieldName) {
  const pattern = new RegExp(`"${fieldName}"\\s*:\\s*"((?:\\\\\\\\.|[^"\\\\])*)"`, 'i');
  const match = String(source || '').match(pattern);
  return match ? decodeJsonString(match[1]) : '';
}

export function parseMentions(content, validNames = []) {
  if (!content) return [];
  const valid = new Set(validNames.map((name) => name.toLowerCase()));
  const matches = [...content.matchAll(/(^|\s)@([a-zA-Z][a-zA-Z0-9_-]{1,31})\b/g)];
  const result = [];
  for (const match of matches) {
    const name = match[2].toLowerCase();
    if (valid.size === 0 || valid.has(name)) {
      result.push(name);
    }
  }
  return unique(result);
}

export function parseAgentResponse(rawContent) {
  const trimmed = String(rawContent || '').trim();
  const fenced = trimmed.match(/```json\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;

  try {
    const parsed = JSON.parse(candidate);
    return {
      message: typeof parsed.message === 'string' ? parsed.message : '',
      actions: Array.isArray(parsed.actions) ? parsed.actions : [],
      handoffs: Array.isArray(parsed.handoffs) ? parsed.handoffs : [],
      private_memory: typeof parsed.private_memory === 'string' ? parsed.private_memory : '',
    };
  } catch {
    return {
      message: extractJsonStringField(candidate, 'message') || trimmed,
      actions: [],
      handoffs: parseMentions(candidate),
      private_memory: extractJsonStringField(candidate, 'private_memory'),
    };
  }
}

export const agentRoomOrchestrator = new LangChainAgentRoomOrchestrator();