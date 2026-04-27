/**
 * Reactive Agent — LangChain-powered autonomous agent
 *
 * Each agent in the room becomes a "reactive agent" that:
 * 1. Observes the conversation stream
 * 2. Decides whether to respond (relevance scoring)
 * 3. Chooses tools and actions autonomously
 * 4. Can propose ideas, respond to proposals, delegate work
 *
 * This replaces the simple "parse JSON → execute actions" loop with
 * a LangChain ReAct-style agent that reasons about what to do.
 */

import { HumanMessage, SystemMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import { createAgentModel, createRouterModel } from './chatModelAdapter.js';
import { createWorkspaceTools, createCollaborationTools } from './workspaceTools.js';
import { createAdvancedTools } from './advancedTools.js';
import { createInternetTools } from './internetTools.js';
import { createUtilityTools } from './utilityTools.js';
import { createBrowserTools } from './browserTools.js';
import { createSemanticSearchTools } from './semanticSearchTools.js';
import { createMcpTools } from './mcpTools.js';
import { createSkillTools } from './skillTools.js';

const MAX_TOOL_ITERATIONS = 20;
const MAX_TRUNCATION_CONTINUES = 3;
const SKILL_TOOL_NAMES_SET = new Set(['search_skills', 'read_skill', 'list_skill_files', 'memory', 'manage_todo_list']);
const MUTATING_TOOL_NAMES = new Set(['write_file', 'update_file', 'multi_replace_file', 'delete_file']);
const RELEVANCE_THRESHOLD = 0.3;
const SIMPLE_QUERY_MAX_WORDS = 12;
const SIMPLE_QUERY_MAX_CHARS = 80;

/**
 * Detect whether a user message is "simple" — greetings, acknowledgments,
 * short questions, or casual chat that doesn't need tools or deep reasoning.
 * Returns true if the message can be handled with a lightweight LLM call.
 */
export function isSimpleQuery(content) {
  const text = String(content || '').trim();
  if (!text) return true;

  const words = text.split(/\s+/);
  // Long messages are never simple
  if (words.length > SIMPLE_QUERY_MAX_WORDS || text.length > SIMPLE_QUERY_MAX_CHARS) return false;

  // Messages with @mentions, file paths, or code blocks are complex
  if (/@\w/.test(text) || /\/[\w.]+/.test(text) || /```/.test(text)) return false;

  // Messages requesting action verbs are complex
  const actionPatterns = /\b(create|build|write|implement|fix|debug|refactor|deploy|test|review|plan|analyze|design|update|delete|add|remove|install|configure|setup|migrate|optimize)\b/i;
  if (actionPatterns.test(text)) return false;

  // Greeting / acknowledgment patterns (multi-language)
  const simplePatterns = /^(hi|hello|hey|yo|sup|thanks|thank you|thx|ok|okay|cool|nice|great|good|awesome|keren|mantap|siap|oke|bagus|makasih|terima kasih|lanjut|done|got it|understood|noted|sure|yes|no|yep|nope|alright|right|hmm|haha|lol|broo?|bro|woi|halo|hai)\b/i;
  if (simplePatterns.test(text)) return true;

  // Very short messages (≤4 words) without action verbs are likely simple
  if (words.length <= 4) return true;

  // Questions that are short and don't reference files/code
  if (text.endsWith('?') && words.length <= 8) return true;

  return false;
}

const KNOWN_TOOL_NAMES = new Set([
  'list_files',
  'read_file',
  'write_file',
  'update_file',
  'multi_replace_file',
  'delete_file',
  'run_python',
  'grep_search',
  'file_search',
  'run_in_terminal',
  'manage_todo_list',
  'memory',
  'get_changed_files',
  'fetch_webpage',
  'propose',
  'respond_to_proposal',
  'think_aloud',
  'delegate',
  'search_skills',
  'read_skill',
  'list_skill_files',
  // Internet tools
  'web_search',
  'web_fetch',
  'http_request',
  // Utility tools
  'calculator',
  'image_info',
  // Browser tools
  'browser_open',
  'browser_click',
  'browser_type',
  'browser_screenshot',
  'browser_read',
  // Semantic search
  'semantic_search',
]);

export function getRoleOperatingGuidance(agent) {
  const agentName = String(agent?.name || '').toLowerCase();

  if (agentName === 'planner') {
    return [
      'ORIENT: Read the request carefully. Use list_files and read_file to understand the current workspace state.',
      'RESEARCH: Use search_skills ONCE with 2-3 keywords from the task. If no relevant skill is found, use web_search to find documentation or solutions online. Do NOT retry search_skills with different keywords.',
      'THINK: Use think_aloud to share your analysis — what needs to be built, key decisions, and risks.',
      'PLAN: Write a clear plan in notes/plan.md with numbered steps, file structure, and technology choices. Order steps by dependency — foundational files first, dependent files after. Each step should produce ONE verifiable file or change.',
      'DELEGATE: Hand off implementation to @coder with a clear scope. Instruct coder to implement ONE file at a time, verify it works, then proceed to the next.',
      'BOUNDARIES: Do NOT write production code in src/ unless the user explicitly asks you to implement directly. NEVER delegate to yourself (@planner). If the user asks YOU a question, answer it directly.',
      'STOP CONDITION: If you receive a handoff but the task is already complete (plan exists, code is written, review is done), say "Task is complete" and STOP. Do NOT create another handoff. The pipeline ends when there is no new work.',
    ];
  }

  if (agentName === 'coder') {
    return [
      'ORIENT: Read the plan in notes/plan.md and any existing workspace files before writing code. Use grep_search to find patterns and file_search to locate files by name.',
      'RESEARCH: Use search_skills ONCE with keywords matching the implementation task. If no relevant skill is found, use web_search to find docs/examples online, then web_fetch to read relevant pages. Do NOT retry search_skills with different keywords.',
      'IMPLEMENT: Follow the plan step by step. Implement ONE file at a time in dependency order (e.g. styles.css before index.html that imports it). After writing each file, VERIFY it before moving to the next — re-read it, check for errors, run tests if applicable. Do NOT generate all files in a single batch.',
      'LARGE FILES: For large files (HTML pages, full components), split into multiple write_file calls — e.g. write the HTML structure first, then use update_file to add CSS and JS sections. Never try to write more than ~200 lines in a single write_file call.',
      'BATCH EDITS: Use multi_replace_file to apply multiple edits across files in a single call — more efficient than calling update_file repeatedly.',
      'TERMINAL: Use run_in_terminal to run build scripts, linters, tests, or npm/yarn commands. Provide an explanation of what the command does.',
      'VERIFY: After writing, re-read your files to check for obvious errors. Use run_in_terminal to run tests or linters if available.',
      'MEMORY: Use memory(command="view") to check for context from previous sessions. Use memory(command="create") to save important decisions for future sessions.',
      'HANDOFF: When implementation is complete, delegate to @reviewer for quality check.',
      'BOUNDARIES: Do NOT write review notes or plans. Do NOT hand work off to yourself.',
      'STOP CONDITION: If you receive a handoff but you have NO new code to write (no changes requested, task already implemented), say "No changes needed" and STOP. Do NOT hand off to @reviewer if you made zero file changes.',
    ];
  }

  if (agentName === 'reviewer') {
    return [
      'ORIENT: Read the plan in notes/plan.md to understand what was intended.',
      'INSPECT: Read all implementation files in src/ carefully. Use grep_search to find patterns across files. Check for correctness, completeness, and quality.',
      'RESEARCH: Use search_skills ONCE with keywords like "code review" or the relevant domain. If no relevant skill is found, skip and proceed to INSPECT. Do NOT retry search_skills with different keywords.',
      'EVALUATE: Check for bugs, edge cases, and consistency. Use run_in_terminal to run tests or linters. Use get_changed_files to review diffs.',
      'DECIDE: If CRITICAL issues are found, delegate back to @coder with specific fix instructions. If approved, state approval clearly and STOP.',
      'BOUNDARIES: Do NOT create or overwrite production code in src/ unless the user explicitly asks for a code fix as part of review.',
      'STOP CONDITION: After you approve the work, the pipeline ENDS. Do NOT hand off to anyone. If you already reviewed and approved this work, say "Already reviewed and approved" and STOP. Do NOT hand off to @coder just to say there are no changes.',
    ];
  }

  if (agentName === 'scribe') {
    return [
      'ORIENT: Read the conversation history and workspace files to understand what happened.',
      'SUMMARIZE: Write concise summaries, changelogs, and status updates in notes/ or README.md.',
      'DOCUMENT: Capture key decisions, architecture choices, and progress milestones.',
      'BOUNDARIES: Do NOT change implementation files unless the user explicitly asks you to.',
    ];
  }

  return [
    'ORIENT: Understand the current workspace state and what is being asked.',
    'RESEARCH: Use search_skills ONCE to find relevant domain knowledge. If no relevant skill is found, skip and proceed. Do NOT retry search_skills with different keywords.',
    'EXECUTE: Stay within your role and build on existing files.',
    'BOUNDARIES: Only change implementation files when clearly part of your responsibility.',
  ];
}

export function getAllowedCollaborationToolNames(agent) {
  const agentName = String(agent?.name || '').toLowerCase();

  if (agentName === 'planner') {
    return new Set(['propose', 'think_aloud', 'delegate', 'spawn_agent']);
  }

  if (agentName === 'coder') {
    return new Set(['think_aloud', 'delegate']);
  }

  if (agentName === 'reviewer') {
    return new Set(['respond_to_proposal', 'think_aloud']);
  }

  if (agentName === 'scribe') {
    return new Set(['think_aloud']);
  }

  return new Set(['propose', 'respond_to_proposal', 'think_aloud', 'delegate']);
}

/**
 * Build the reactive system prompt for an agent.
 * This prompt makes the agent aware of the room context and its collaboration capabilities.
 */
function buildReactiveSystemPrompt(agent, roomContext) {
  const agentList = roomContext.agents
    .map((a) => `@${a.name}: ${a.role}${a.name === agent.name ? ' (you)' : ''}`)
    .join(', ');
  const roleGuidance = getRoleOperatingGuidance(agent)
    .map((line, index) => `${index + 1}. ${line}`)
    .join('\n');

  const parts = [
    agent.system_prompt || `You are ${agent.name}.`,
    `\nRoom: ${roomContext.roomName}${roomContext.roomDescription ? ` — ${roomContext.roomDescription}` : ''}`,
    `Team: ${agentList}`,
    `\nResource Limits:`,
    `- Tool budget: ${MAX_TOOL_ITERATIONS} tool calls per turn. Skill lookups (search_skills, read_skill) are free and don't count.`,
    `- Output limit: ~8192 tokens per LLM response. If you get cut off, the system auto-continues up to ${MAX_TRUNCATION_CONTINUES} times.`,
    `- Strategy: Break large work into multiple small tool calls. Write files in chunks (~150 lines each). Use write_file for new files, update_file to append/modify.`,
    `- If you run out of budget mid-task, summarize what's done and what remains so the next agent (or a retry) can pick up.`,
    `\nWorkflow:\n${roleGuidance}`,
    '\nRules: Be concise. Use @agent to delegate. Read before writing. Only claim work you actually did with tools. NEVER mention your own @name — you cannot delegate to yourself.',
    '\nLanguage: ALWAYS reply in the same language the user used. If the user writes in Indonesian, reply in Indonesian. If in English, reply in English.',
  ];

  if (roomContext.privateMemory) {
    parts.push(`\nMemory:\n${formatPrivateMemoryForPrompt(roomContext.privateMemory)}`);
  }

  return parts.join('\n');
}

/**
 * Determine if an agent should respond to a new message.
 * Uses a lightweight heuristic + optional LLM check for ambiguous cases.
 */
export function shouldAgentRespond(agent, message, roomContext) {
  const content = String(message.content || '').toLowerCase();
  const agentName = agent.name.toLowerCase();

  // Always respond if directly mentioned
  if (content.includes(`@${agentName}`)) {
    return { respond: true, reason: 'directly_mentioned', priority: 1.0 };
  }

  // Always respond if it's a handoff to this agent
  if (message.event_type === 'handoff' && content.includes(`@${agentName}`)) {
    return { respond: true, reason: 'handoff_target', priority: 1.0 };
  }

  // Respond to proposals if agent is a reviewer or was requested
  if (message.event_type === 'proposal') {
    if (content.includes('@all') || content.includes(`@${agentName}`)) {
      return { respond: true, reason: 'proposal_review_requested', priority: 0.9 };
    }
    if (agent.role.toLowerCase().includes('review')) {
      return { respond: true, reason: 'reviewer_sees_proposal', priority: 0.7 };
    }
  }

  // Role-based relevance scoring
  const roleKeywords = extractRoleKeywords(agent);
  const contentWords = content.split(/\s+/);
  const matchCount = roleKeywords.filter((kw) => contentWords.some((w) => w.includes(kw))).length;
  const relevanceScore = roleKeywords.length > 0 ? matchCount / roleKeywords.length : 0;

  if (relevanceScore >= RELEVANCE_THRESHOLD) {
    return { respond: true, reason: 'role_relevant', priority: relevanceScore };
  }

  // Planner responds to user messages that don't mention specific agents
  if (agent.name === 'planner' && message.sender_type === 'user') {
    const mentionsOther = roomContext.agents.some(
      (a) => a.name !== 'planner' && content.includes(`@${a.name.toLowerCase()}`),
    );
    if (!mentionsOther) {
      return { respond: true, reason: 'planner_default', priority: 0.5 };
    }
  }

  return { respond: false, reason: 'not_relevant', priority: 0 };
}

/**
 * Extract keywords from an agent's role description for relevance matching.
 */
function extractRoleKeywords(agent) {
  const roleWords = (agent.role || '').toLowerCase().split(/\s+/);
  const promptWords = (agent.system_prompt || '').toLowerCase().split(/\s+/);
  const stopWords = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'you', 'your', 'this', 'that', 'it', 'its', 'as', 'from', 'into',
  ]);

  return [...new Set([...roleWords, ...promptWords])]
    .filter((w) => w.length > 3 && !stopWords.has(w))
    .slice(0, 20);
}

function normalizeResponseContent(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && typeof part.text === 'string') return part.text;
      return '';
    }).join('');
  }

  return String(content || '');
}

/**
 * Strip self-mentions from an agent's response.
 * Small local models sometimes generate "@planner" when they ARE planner.
 * This removes leading self-mentions and cleans up the text.
 */
export function stripSelfMentions(text, agentName) {
  if (!text || !agentName) return text;
  const pattern = new RegExp(`@${agentName}\\b[,:]?\\s*`, 'gi');
  return text.replace(pattern, '').trim();
}

export function getToolCallingMode(agent) {
  const configuredMode = String(agent?.provider_config?.tool_calling_mode || '').trim().toLowerCase();
  if (configuredMode === 'native' || configuredMode === 'text' || configuredMode === 'auto') {
    return configuredMode;
  }

  const provider = String(agent?.provider_config?.provider || '').trim().toLowerCase();
  if (provider === 'anthropic') {
    return 'text';
  }

  if (!provider && !process.env.ENOWXAI_BASE_URL) {
    return 'text';
  }

  return 'auto';
}

function shouldFallbackToTextTools(error, toolCallingMode) {
  if (toolCallingMode !== 'auto') {
    return false;
  }

  const message = String(error?.message || '').toLowerCase();
  if (!message) {
    return false;
  }

  return (
    message.includes('tool')
    || message.includes('function_call')
    || message.includes('tool_choice')
    || message.includes('parallel_tool_calls')
    || message.includes('unsupported')
  );
}

function extractNativeToolCalls(message) {
  if (!message || !Array.isArray(message.tool_calls)) {
    return [];
  }

  return message.tool_calls
    .filter((toolCall) => toolCall && typeof toolCall === 'object' && toolCall.name)
    .map((toolCall, index) => ({
      id: toolCall.id || `${toolCall.name}_${index}`,
      name: toolCall.name,
      args: toolCall.args || {},
      type: 'tool_call',
    }));
}

function normalizeNativeToolCall(toolCall, validToolNames = new Set()) {
  if (!toolCall || typeof toolCall !== 'object') {
    return null;
  }

  if (!validToolNames.has(toolCall.name)) {
    return null;
  }

  if (!KNOWN_TOOL_NAMES.has(toolCall.name)) {
    return {
      tool: toolCall.name,
      id: toolCall.id,
      ...(toolCall.args || {}),
    };
  }

  const normalized = normalizeToolCall({
    tool: toolCall.name,
    id: toolCall.id,
    args: toolCall.args || {},
  });

  if (!normalized) {
    return null;
  }

  return {
    ...normalized,
    id: toolCall.id || normalized.id,
  };
}

function formatToolMessageContent(result) {
  if (typeof result === 'string') {
    return result;
  }

  return JSON.stringify(result);
}

function normalizeToolExecutionResult(result) {
  if (typeof result === 'string') {
    const trimmed = result.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && typeof parsed.error === 'string' && parsed.error.trim()) {
          return {
            error: parsed.error.trim(),
            result: parsed,
          };
        }

        return { result: parsed };
      } catch {
        return { result };
      }
    }
  }

  if (result && typeof result === 'object' && typeof result.error === 'string' && result.error.trim()) {
    return {
      error: result.error.trim(),
      result,
    };
  }

  return { result };
}

function buildTextToolFollowUpMessage(toolResults) {
  const hadErrors = toolResults.some((toolResult) => typeof toolResult?.error === 'string' && toolResult.error.trim());
  const errorGuidance = hadErrors
    ? '\nAt least one tool failed. Correct the invalid arguments or choose a different valid tool before continuing.'
    : '';

  return `[system] Tool results:\n${formatToolResultsForPrompt(toolResults)}\n\nContinue working on the task. In text tool mode, your next response must either:\n1. include at least one JSON tool block for the next concrete action, or\n2. provide the final answer if the task is complete.\nDo not only describe intended future actions.${errorGuidance}`;
}

// ── xa Router Classification ───────────────────────────────────

import { getXbProgressSummary, getActiveXbTasks } from '../progressStore.js';

/** JS heuristic for progress-check queries (0ms, 0 cost). */
const PROGRESS_PATTERNS = /\b(progress|status|how.?s it|gimana|udah|sudah|done yet|finished|selesai|update|lagi ngapain|mengerjakan apa|ngerjain apa|kerja apa|sedang apa|lagi apa|sampai mana|what.?s happening|what are you (doing|working)|are you done|still working|any update)\b/i;

export function isProgressQuery(content) {
  // Strip @mentions before checking — "@planner mengerjakan apa?" is a progress query
  const stripped = content.replace(/@\w+/g, '').trim();
  return PROGRESS_PATTERNS.test(stripped) || PROGRESS_PATTERNS.test(content);
}

const XA_CLASSIFY_PROMPT = `You are a message router for an AI agent team. Classify the user's message.

Reply with EXACTLY one word:
- CHAT — greetings, thanks, acknowledgments, casual conversation, simple questions about yourself
- PROGRESS — asking about current work status, what agents are doing, are they done yet. Even if an @agent is mentioned, if the question is about their STATUS (not asking them to DO something), it's PROGRESS.
- DELEGATE — requests that need tools, file operations, code generation, analysis, planning, or deep reasoning

Examples:
"hi" → CHAT
"thanks!" → CHAT
"keren broo" → CHAT
"how's it going?" → PROGRESS
"udah selesai?" → PROGRESS
"what are you working on?" → PROGRESS
"@planner mengerjakan apa?" → PROGRESS
"@coder lagi ngapain?" → PROGRESS
"@planner sampai mana?" → PROGRESS
"any updates?" → PROGRESS
"create a file" → DELEGATE
"@coder fix the bug" → DELEGATE
"@planner buat rencana" → DELEGATE

Reply with one word only: CHAT, PROGRESS, or DELEGATE`;

/**
 * Use the xa (router) model to classify a message.
 * Returns: 'chat' | 'progress' | 'delegate'
 * Falls back to JS heuristic if xa fails or is unavailable.
 *
 * @param {Object} agent - Agent definition with router_config
 * @param {string} userContent - Raw user message content
 * @param {string} [roomId] - Room ID for progress checking
 * @returns {Promise<'chat' | 'progress' | 'delegate'>}
 */
export async function classifyWithRouter(agent, userContent, roomId = '') {
  // Fast-path: obvious cases skip the LLM entirely
  if (isProgressQuery(userContent) && roomId) {
    const activeTasks = getActiveXbTasks(roomId);
    if (activeTasks.length > 0) return 'progress';
  }
  if (isSimpleQuery(userContent)) return 'chat';

  // If no router config, fall back to heuristic (always delegate for non-simple)
  if (!agent.router_config || Object.keys(agent.router_config).length === 0) {
    return 'delegate';
  }

  const routerModel = createRouterModel(agent);

  try {
    const messages = [
      new SystemMessage(XA_CLASSIFY_PROMPT),
      new HumanMessage(userContent),
    ];
    const result = await routerModel.invoke(messages);
    const raw = normalizeResponseContent(result.content).trim().toUpperCase();

    if (raw.includes('CHAT')) return 'chat';
    if (raw.includes('PROGRESS')) {
      // Only return progress if there are active tasks
      if (roomId && getActiveXbTasks(roomId).length > 0) return 'progress';
      return 'chat'; // No active tasks, treat as chat
    }
    if (raw.includes('DELEGATE')) {
      // Safety check: if the JS heuristic says it's a progress query, override LLM
      if (isProgressQuery(userContent) && roomId && getActiveXbTasks(roomId).length > 0) {
        console.log(`[${agent.name}] xa classify override: LLM said DELEGATE but JS heuristic says PROGRESS`);
        return 'progress';
      }
      return 'delegate';
    }
    // Ambiguous response — default to delegate (safer)
    console.log(`[${agent.name}] xa classify ambiguous: "${raw}" → defaulting to delegate`);
    return 'delegate';
  } catch (error) {
    console.error(`[${agent.name}] xa classify failed:`, error.message, '→ falling back to delegate');
    return 'delegate';
  }
}

/**
 * Lightweight agent turn handled entirely by xa (router model).
 * Used for chat/greetings/simple questions — no tools, no workspace listing.
 */
export async function runSimpleAgentTurn({ agent, roomContext, input, conversationHistory }) {
  const routerModel = createRouterModel(agent);

  // Minimal system prompt — just identity and recent context
  const agentList = roomContext.agents
    .map((a) => `@${a.name}`)
    .join(', ');
  const systemPrompt = `${agent.system_prompt || `You are ${agent.name}.`}\nRoom: ${roomContext.roomName}. Team: ${agentList}.\nRespond naturally and concisely. No tools available in this mode.\nIMPORTANT: Reply in the same language the user used. If they write in Indonesian, reply in Indonesian.`;

  const messages = [new SystemMessage(systemPrompt)];

  // Only include last 3 messages for context (not 8)
  const recentHistory = conversationHistory.slice(-3);
  for (const msg of recentHistory) {
    if (msg.sender_type === 'user') {
      messages.push(new HumanMessage(`[${msg.sender_name}]: ${msg.content}`));
    } else if (msg.sender_type === 'agent') {
      if (msg.sender_name === agent.name) {
        messages.push(new AIMessage(msg.content));
      } else {
        messages.push(new HumanMessage(`[@${msg.sender_name}]: ${msg.content}`));
      }
    }
  }

  messages.push(new HumanMessage(input));

  try {
    const result = await routerModel.invoke(messages);
    const rawContent = normalizeResponseContent(result.content);
    const content = stripSelfMentions(rawContent, agent.name);
    const usage = result.additional_kwargs?.usage || {};

    console.log(`[${agent.name}] xa turn — ${usage.total_tokens || 0} tokens (router model)`);

    return {
      message: content || 'Got it.',
      toolResults: [],
      handoffs: [],
      privateMemory: '',
      usage: {
        prompt_tokens: usage.prompt_tokens || 0,
        completion_tokens: usage.completion_tokens || 0,
        total_tokens: usage.total_tokens || 0,
        model: result.additional_kwargs?.model || '',
        provider: result.additional_kwargs?.provider || '',
      },
      confidence: 0.8,
    };
  } catch (error) {
    console.error(`[${agent.name}] xa turn failed:`, error.message);
    return {
      message: 'Got it.',
      toolResults: [],
      handoffs: [],
      privateMemory: '',
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, model: '', provider: '' },
      confidence: 0.5,
    };
  }
}

/**
 * xa reports xb's progress — used when user asks "how's it going?" while xb is working.
 * Uses the router model to format a natural progress report.
 */
export async function runProgressCheckTurn({ agent, roomContext, input, conversationHistory }) {
  const routerModel = createRouterModel(agent);
  const roomId = roomContext.roomId;

  // Gather progress for all active xb tasks in this room
  const activeTasks = getActiveXbTasks(roomId);
  const progressLines = activeTasks.map(({ agentName, progress: _p }) =>
    `@${agentName}: ${getXbProgressSummary(roomId, agentName)}`
  );

  // Also check this agent's own progress
  const ownProgress = getXbProgressSummary(roomId, agent.name);
  if (!activeTasks.some((t) => t.agentName === agent.name)) {
    progressLines.unshift(`@${agent.name}: ${ownProgress}`);
  }

  const progressContext = progressLines.length > 0
    ? progressLines.join('\n')
    : 'No active tasks at the moment.';

  const systemPrompt = `${agent.system_prompt || `You are ${agent.name}.`}
Room: ${roomContext.roomName}.
The user is asking about work progress. Report the status naturally and concisely.
IMPORTANT: Reply in the same language the user used. If they write in Indonesian, reply in Indonesian.
Current task status:
${progressContext}`;

  const messages = [new SystemMessage(systemPrompt)];

  // Only last 2 messages for context
  const recentHistory = conversationHistory.slice(-2);
  for (const msg of recentHistory) {
    if (msg.sender_type === 'user') {
      messages.push(new HumanMessage(`[${msg.sender_name}]: ${msg.content}`));
    } else if (msg.sender_type === 'agent' && msg.sender_name === agent.name) {
      messages.push(new AIMessage(msg.content));
    }
  }
  messages.push(new HumanMessage(input));

  try {
    const result = await routerModel.invoke(messages);
    const rawContent = normalizeResponseContent(result.content);
    const content = stripSelfMentions(rawContent, agent.name);
    const usage = result.additional_kwargs?.usage || {};

    console.log(`[${agent.name}] xa progress check — ${usage.total_tokens || 0} tokens`);

    return {
      message: content || progressContext,
      toolResults: [],
      handoffs: [],
      privateMemory: '',
      usage: {
        prompt_tokens: usage.prompt_tokens || 0,
        completion_tokens: usage.completion_tokens || 0,
        total_tokens: usage.total_tokens || 0,
        model: result.additional_kwargs?.model || '',
        provider: result.additional_kwargs?.provider || '',
      },
      confidence: 0.8,
    };
  } catch (error) {
    console.error(`[${agent.name}] xa progress check failed:`, error.message);
    // Fallback: return raw progress data
    return {
      message: progressContext,
      toolResults: [],
      handoffs: [],
      privateMemory: '',
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, model: '', provider: '' },
      confidence: 0.5,
    };
  }
}

/**
 * Run a single agent turn using LangChain ReAct-style reasoning.
 *
 * The agent:
 * 1. Receives the conversation context
 * 2. Reasons about what to do
 * 3. Optionally uses tools (file ops, proposals, delegation)
 * 4. Returns its response and any handoffs
 */
export async function runReactiveAgentTurn({
  agent,
  roomContext,
  input,
  conversationHistory,
  postMessage,
  onToolUse,
  onThinking,
  signal,
}) {
  // Build tools
  const workspaceTools = createWorkspaceTools(roomContext.workspacePath, {
    agentName: agent.name,
    allowedTools: agent.tools || [],
  });
  const collaborationTools = createCollaborationTools({
    roomId: roomContext.roomId,
    agentName: agent.name,
    postMessage,
    getAgentNames: () => roomContext.agents.map((a) => a.name),
    spawnAgent: roomContext.spawnAgent || null,
  }).filter((tool) => getAllowedCollaborationToolNames(agent).has(tool.name));

  // Filter workspace tools based on agent's allowed tools
  const allowedToolNames = new Set(agent.tools || ['list_files', 'read_file', 'write_file', 'update_file', 'multi_replace_file', 'delete_file']);
  const filteredWorkspaceTools = workspaceTools.filter((t) => allowedToolNames.has(t.name));
  const advancedTools = createAdvancedTools(roomContext.workspacePath, {
    agentName: agent.name,
    allowedTools: agent.tools || [],
  });
  const mcpTools = await createMcpTools(agent.provider_config);
  const skillTools = createSkillTools({
    allowedSkillIds: roomContext.allowedSkillIds || null,
  });
  const internetTools = createInternetTools({ agentName: agent.name });
  const utilityTools = createUtilityTools(roomContext.workspacePath, { agentName: agent.name });
  const browserTools = createBrowserTools(roomContext.workspacePath, { agentName: agent.name });
  const semanticTools = createSemanticSearchTools(roomContext.workspacePath, { agentName: agent.name });
  const allTools = [...filteredWorkspaceTools, ...advancedTools, ...collaborationTools, ...skillTools, ...mcpTools, ...internetTools, ...utilityTools, ...browserTools, ...semanticTools];
  console.log(`[${agent.name}] Tools bound: ${allTools.map(t => t.name).join(', ')} (${allTools.length} total, ${skillTools.length} skill tools)`);
  const toolCallingMode = getToolCallingMode(agent);
  const baseModel = createAgentModel(agent);
  const nativeModel = baseModel.bindTools(allTools);
  let nativeToolCallingEnabled = toolCallingMode !== 'text';

  // Build the system prompt
  const systemPrompt = buildReactiveSystemPrompt(agent, roomContext);

  // Build conversation messages for LangChain
  const messages = [
    new SystemMessage(systemPrompt),
  ];

  // ── Adaptive Context Window Management ──────────────────────
  // Split history into "old" (summarized) and "recent" (full detail).
  // This preserves critical context while keeping token usage manageable.
  const RECENT_MESSAGE_COUNT = 8;
  const recentHistory = conversationHistory.slice(-RECENT_MESSAGE_COUNT);
  const olderHistory = conversationHistory.slice(0, -RECENT_MESSAGE_COUNT);

  // Summarize older messages into a compact context block
  if (olderHistory.length > 0) {
    const summaryLines = [];
    const agentActions = new Map();
    const keyDecisions = [];

    for (const msg of olderHistory) {
      const sender = msg.sender_type === 'user' ? msg.sender_name : `@${msg.sender_name}`;
      const preview = String(msg.content || '').slice(0, 120).replace(/\n/g, ' ');

      if (msg.event_type === 'handoff') {
        summaryLines.push(`  ${sender} → handoff: ${preview}`);
      } else if (msg.event_type === 'proposal' || msg.event_type === 'proposal_response') {
        keyDecisions.push(`  ${sender}: ${preview}`);
      } else if (msg.sender_type === 'agent') {
        const actions = agentActions.get(msg.sender_name) || [];
        actions.push(preview);
        agentActions.set(msg.sender_name, actions);
      }
    }

    // Build compact summary
    const parts = [`[system] Conversation summary (${olderHistory.length} earlier messages):`];
    if (keyDecisions.length > 0) {
      parts.push('Key decisions:');
      parts.push(...keyDecisions.slice(-4));
    }
    for (const [agentName, actions] of agentActions) {
      parts.push(`@${agentName} actions: ${actions.slice(-2).join(' → ')}`);
    }
    if (summaryLines.length > 0) {
      parts.push('Handoffs:');
      parts.push(...summaryLines.slice(-4));
    }

    messages.push(new HumanMessage(parts.join('\n')));
  }

  // Add recent conversation history in full detail
  for (const msg of recentHistory) {
    if (msg.sender_type === 'user') {
      messages.push(new HumanMessage(`[${msg.sender_name}]: ${msg.content}`));
    } else if (msg.sender_type === 'agent') {
      if (msg.sender_name === agent.name) {
        messages.push(new AIMessage(msg.content));
      } else {
        messages.push(new HumanMessage(`[@${msg.sender_name}]: ${msg.content}`));
      }
    } else if (msg.sender_type === 'system') {
      messages.push(new HumanMessage(`[system]: ${msg.content}`));
    }
  }

  // Add the current input
  messages.push(new HumanMessage(input));

  // ── Lazy Context Loading ─────────────────────────────────────
  // Only include workspace listing, tool descriptions, and workflow reminder
  // when the input suggests the agent needs to do actual work (not just chat).
  // This saves ~300-500 tokens on conversational turns.
  const needsWorkContext = !isSimpleQuery(
    // Extract the raw user content from the formatted input
    input.split('\n').slice(1, -2).join('\n').trim(),
  );

  if (needsWorkContext) {
    // ── Smart Workspace Listing ─────────────────────────────────
    const workspaceListing = roomContext.workspaceListing || '[empty workspace]';
    const workspaceLines = workspaceListing.split('\n').filter(Boolean);
    const MAX_WORKSPACE_LINES = 50;

    let filteredListing;
    if (workspaceLines.length <= MAX_WORKSPACE_LINES) {
      filteredListing = workspaceListing;
    } else {
      const taskWords = new Set(
        input.toLowerCase().split(/\s+/)
          .filter((w) => w.length > 3)
          .map((w) => w.replace(/[^a-z0-9]/g, ''))
          .filter(Boolean),
      );
      const keyPatterns = ['plan.md', 'review.md', 'README', 'src/', 'notes/', 'index', 'main', 'app', 'config'];
      const relevantLines = [];
      const otherLines = [];

      for (const line of workspaceLines) {
        const lower = line.toLowerCase();
        const isKey = keyPatterns.some((p) => lower.includes(p.toLowerCase()));
        const isRelevant = [...taskWords].some((w) => lower.includes(w));
        if (isKey || isRelevant) {
          relevantLines.push(line);
        } else {
          otherLines.push(line);
        }
      }

      const remaining = MAX_WORKSPACE_LINES - relevantLines.length;
      const shown = [...relevantLines, ...otherLines.slice(0, Math.max(remaining, 10))];
      const hidden = workspaceLines.length - shown.length;
      filteredListing = shown.join('\n') + (hidden > 0 ? `\n... and ${hidden} more files (use list_files to explore)` : '');
    }

    messages.push(new HumanMessage(`[system] Workspace:\n${filteredListing}`));

    // Add compact tool descriptions
    const toolDescriptions = allTools
      .map((t) => `- ${t.name}: ${t.description}`)
      .join('\n');
    messages.push(new HumanMessage(
      nativeToolCallingEnabled
        ? `[system] Tools:\n${toolDescriptions}\n\nUse native tool calling. Fallback: \`\`\`json\n{"tool": "name", ...params}\n\`\`\``
        : `[system] Tools (text mode):\n${toolDescriptions}\n\nUse JSON blocks: \`\`\`json\n{"tool": "name", ...params}\n\`\`\``,
    ));

    // Compact workflow reminder
    messages.push(new HumanMessage(
      '[system] Workflow: ORIENT → RESEARCH (search_skills ONCE) → EXECUTE. If search_skills returns no results, skip RESEARCH and go straight to EXECUTE. Do NOT call search_skills more than once per turn.',
    ));
  }

  // Run the agent with tool execution loop
  const toolResults = [];
  const handoffs = [];
  const usageAccumulator = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, model: '', provider: '' };
  let finalMessage = '';
  let executedToolCount = 0;
  const seenResponseSignatures = new Set();
  let explicitToolRetryCount = 0;
  let postToolRetryCount = 0;
  let truncationContinueCount = 0;

  // ── Tool Result Cache ───────────────────────────────────────
  // Cache read-only tool results within this turn to avoid redundant LLM calls.
  const CACHEABLE_TOOLS = new Set(['list_files', 'read_file', 'search_skills', 'read_skill', 'list_skill_files', 'grep_search', 'file_search', 'memory', 'web_search', 'web_fetch', 'calculator', 'image_info', 'semantic_search', 'browser_read']);
  const toolResultCache = new Map();

  try {
    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
      // Check if the work has been cancelled
      if (signal?.aborted) {
        return {
          message: '⏹ Work was stopped by the user.',
          handoffs: [],
          toolResults,
          privateMemory: '',
          confidence: 0,
          usage: usageAccumulator,
        };
      }

      let result;
      try {
        if (onThinking) {
          const budgetLeft = MAX_TOOL_ITERATIONS - executedToolCount;
          onThinking(agent.name, iteration === 0
            ? `Thinking... (${budgetLeft} tool calls remaining)`
            : `Thinking (step ${iteration + 1}/${MAX_TOOL_ITERATIONS}, ${budgetLeft} tools left)...`);
        }
        const invokeOpts = signal ? { signal } : undefined;
        result = await (nativeToolCallingEnabled ? nativeModel : baseModel).invoke(messages, invokeOpts);
      } catch (error) {
        if (signal?.aborted) {
          return {
            message: '⏹ Work was stopped by the user.',
            handoffs: [],
            toolResults,
            privateMemory: '',
            confidence: 0,
            usage: usageAccumulator,
          };
        }
        if (!nativeToolCallingEnabled || !shouldFallbackToTextTools(error, toolCallingMode)) {
          throw error;
        }

        nativeToolCallingEnabled = false;
        messages.push(new HumanMessage('[system] Native tool calling is unavailable for this provider. Use the documented JSON tool blocks for the rest of this turn.'));
        result = await baseModel.invoke(messages, signal ? { signal } : undefined);
      }

      // Accumulate token usage from this LLM call
      const iterUsage = result.additional_kwargs?.usage;
      if (iterUsage) {
        usageAccumulator.prompt_tokens += Number(iterUsage.prompt_tokens) || 0;
        usageAccumulator.completion_tokens += Number(iterUsage.completion_tokens) || 0;
        usageAccumulator.total_tokens += Number(iterUsage.total_tokens) || 0;
      }
      if (!usageAccumulator.model && result.additional_kwargs?.model) {
        usageAccumulator.model = result.additional_kwargs.model;
      }
      if (!usageAccumulator.provider && result.additional_kwargs?.provider) {
        usageAccumulator.provider = result.additional_kwargs.provider;
      }

      // ── Auto-continue on max_tokens truncation ──────────────────
      // When the LLM hits its output token limit, we try to salvage any
      // completed tool calls from the partial response, execute them,
      // then ask the LLM to continue where it left off.
      const finishReason = result.additional_kwargs?.finishReason;
      if (finishReason === 'length') {
        // First, try to extract and execute any COMPLETE tool calls from the truncated response
        const truncatedContent = normalizeResponseContent(result.content);
        const truncatedNativeToolCalls = extractNativeToolCalls(result);
        const truncatedValidToolNames = new Set(allTools.map((tool) => tool.name));
        const truncatedNormalized = truncatedNativeToolCalls
          .map((tc) => normalizeNativeToolCall(tc, truncatedValidToolNames))
          .filter(Boolean);
        const salvageableToolCalls = truncatedNormalized.length > 0
          ? truncatedNormalized
          : extractToolCalls(truncatedContent);

        if (salvageableToolCalls.length > 0) {
          console.log(`[${agent.name}] Salvaged ${salvageableToolCalls.length} tool call(s) from truncated response`);
          messages.push(result);

          // Execute the salvaged tool calls
          for (const toolCall of salvageableToolCalls) {
            const tool = allTools.find((t) => t.name === toolCall.tool);
            if (!tool) continue;
            try {
              if (onToolUse) onToolUse(agent.name, toolCall.tool, toolCall);
              const toolResult = await tool.func(toolCall);
              const normalized = normalizeToolExecutionResult(toolResult);
              toolResults.push(normalized.error
                ? { tool: toolCall.tool, error: normalized.error, result: normalized.result, params: toolCall }
                : { tool: toolCall.tool, result: normalized.result, params: toolCall });
              const nativeTC = truncatedNormalized.find((c) => c.id === toolCall.id);
              if (nativeTC?.id) {
                messages.push(new ToolMessage({
                  content: normalized.error || formatToolMessageContent(normalized.result),
                  tool_call_id: nativeTC.id,
                }));
              }
              if (MUTATING_TOOL_NAMES.has(toolCall.tool)) {
                toolResultCache.clear();
              }
              if (!SKILL_TOOL_NAMES_SET.has(toolCall.tool)) {
                executedToolCount += 1;
              }
            } catch (err) {
              console.log(`[${agent.name}] Salvaged tool ${toolCall.tool} failed: ${err.message}`);
            }
          }
          // Reset truncation counter — we made progress
          truncationContinueCount = 0;
        }

        if (truncationContinueCount < MAX_TRUNCATION_CONTINUES) {
          truncationContinueCount += 1;
          if (salvageableToolCalls.length === 0) {
            messages.push(result);
          }
          const budgetLeft = MAX_TOOL_ITERATIONS - executedToolCount;
          messages.push(new HumanMessage(
            `[system] Your response was cut off by the output token limit (continuation ${truncationContinueCount}/${MAX_TRUNCATION_CONTINUES}). `
            + `You have ${budgetLeft} tool calls remaining. `
            + 'Continue EXACTLY where you left off. Do NOT repeat what you already wrote. '
            + 'If you were in the middle of a tool call, complete just that tool call. '
            + 'If you were writing a file, use update_file to append the remaining content instead of rewriting the whole file.',
          ));
          console.log(`[${agent.name}] Auto-continuing: truncated (iteration ${iteration + 1}, continue ${truncationContinueCount}/${MAX_TRUNCATION_CONTINUES}, ${budgetLeft} tools left)`);
          if (onThinking) {
            onThinking(agent.name, `Continuing (truncated ${truncationContinueCount}/${MAX_TRUNCATION_CONTINUES}, ${budgetLeft} tools left)...`);
          }
          continue;
        } else {
          // Exhausted continuation budget — treat partial content as final
          console.log(`[${agent.name}] Max truncation continues reached (${MAX_TRUNCATION_CONTINUES}), treating partial response as final`);
        }
      }

      const content = normalizeResponseContent(result.content);
      const nativeToolCalls = extractNativeToolCalls(result);
      const validToolNames = new Set(allTools.map((tool) => tool.name));
      const normalizedNativeToolCalls = nativeToolCalls
        .map((toolCall) => normalizeNativeToolCall(toolCall, validToolNames))
        .filter(Boolean);
      const toolCalls = normalizedNativeToolCalls.length > 0
        ? normalizedNativeToolCalls
        : extractToolCalls(content);
      const cleanMessage = normalizedNativeToolCalls.length > 0
        ? content.trim()
        : removeToolBlocks(content).trim();
      const responseSignature = JSON.stringify({ cleanMessage, toolCalls });

      if (seenResponseSignatures.has(responseSignature)) {
        if (cleanMessage) {
          finalMessage = cleanMessage;
        }
        break;
      }
      seenResponseSignatures.add(responseSignature);

      messages.push(result);

      const handoffCountBefore = handoffs.length;
      if (cleanMessage) {
        finalMessage = cleanMessage;
        collectHandoffs(handoffs, cleanMessage, agent.name, roomContext.agents);
      }

      if (toolCalls.length === 0) {
        if (shouldRequestExplicitToolActions({
          cleanMessage,
          toolResults,
          explicitToolRetryCount,
          toolCallingMode,
        })) {
          explicitToolRetryCount += 1;
          messages.push(new HumanMessage('[system] You described intended actions but did not invoke any tools. Reply again with the next concrete JSON tool block or tool blocks only. Do not describe future steps without calling the tool needed to perform them.'));
          continue;
        }
        break;
      }

      const remainingBudget = MAX_TOOL_ITERATIONS - executedToolCount;
      if (remainingBudget <= 0) {
        break;
      }

      const currentToolResults = [];
      for (const toolCall of toolCalls.slice(0, remainingBudget)) {
        // Check abort before each tool execution
        if (signal?.aborted) {
          return {
            message: '⏹ Work was stopped by the user.',
            handoffs: [],
            toolResults,
            privateMemory: '',
            confidence: 0,
            usage: usageAccumulator,
          };
        }

        const tool = allTools.find((t) => t.name === toolCall.tool);
        const nativeToolCall = normalizedNativeToolCalls.find((candidate) => candidate.id === toolCall.id);
        if (!tool) {
          const unknown = { tool: toolCall.tool, error: 'Unknown tool' };
          toolResults.push(unknown);
          currentToolResults.push(unknown);
          if (nativeToolCall?.id) {
            messages.push(new ToolMessage({
              content: 'Unknown tool',
              tool_call_id: nativeToolCall.id,
            }));
          }
          continue;
        }

        try {
          if (onToolUse) {
            onToolUse(agent.name, toolCall.tool, toolCall);
          }

          // Check cache for read-only tools
          const cacheKey = CACHEABLE_TOOLS.has(toolCall.tool)
            ? `${toolCall.tool}:${JSON.stringify(toolCall)}`
            : null;
          const cachedResult = cacheKey ? toolResultCache.get(cacheKey) : undefined;

          const toolResult = cachedResult !== undefined
            ? cachedResult
            : await tool.func(toolCall);

          // Store in cache for read-only tools
          if (cacheKey && cachedResult === undefined) {
            toolResultCache.set(cacheKey, toolResult);
          }

          const normalizedToolResult = normalizeToolExecutionResult(toolResult);
          const recordedResult = normalizedToolResult.error
            ? { tool: toolCall.tool, error: normalizedToolResult.error, result: normalizedToolResult.result, params: toolCall }
            : { tool: toolCall.tool, result: normalizedToolResult.result, params: toolCall };
          toolResults.push(recordedResult);
          currentToolResults.push(recordedResult);
          if (nativeToolCall?.id) {
            messages.push(new ToolMessage({
              content: normalizedToolResult.error || formatToolMessageContent(normalizedToolResult.result),
              tool_call_id: nativeToolCall.id,
            }));
          }
        } catch (error) {
          const failure = { tool: toolCall.tool, error: 'Tool execution failed', params: toolCall };
          toolResults.push(failure);
          currentToolResults.push(failure);
          if (nativeToolCall?.id) {
            messages.push(new ToolMessage({
              content: 'Tool execution failed',
              tool_call_id: nativeToolCall.id,
            }));
          }
        }

        // Invalidate cache when workspace is mutated
        if (MUTATING_TOOL_NAMES.has(toolCall.tool) || toolCall.tool === 'run_in_terminal') {
          toolResultCache.clear();
        }

        // Skill tools are free context-gathering — don't count against budget
        if (!SKILL_TOOL_NAMES_SET.has(toolCall.tool)) {
          executedToolCount += 1;
        }

        // Reset truncation counter after successful tool execution —
        // if the agent gets truncated again, it's a fresh context
        if (!currentToolResults[currentToolResults.length - 1]?.error) {
          truncationContinueCount = 0;
        }
      }

      if (normalizedNativeToolCalls.length === 0) {
        messages.push(new HumanMessage(buildTextToolFollowUpMessage(currentToolResults)));
      }

      if (normalizedNativeToolCalls.length > 0) {
        if (executedToolCount >= MAX_TOOL_ITERATIONS) {
          break;
        }
        continue;
      }

      const handoffsAdded = handoffs.length > handoffCountBefore;
      if (!shouldContinueAfterToolRound(toolCalls, currentToolResults, cleanMessage, handoffsAdded)) {
        if (shouldRequestPostToolActions({
          cleanMessage,
          toolCalls,
          toolResults,
          handoffsAdded,
          postToolRetryCount,
          toolCallingMode,
        })) {
          postToolRetryCount += 1;
          continue;
        }
        break;
      }

      if (executedToolCount >= MAX_TOOL_ITERATIONS) {
        break;
      }
    }
    // ── Self-Reflection Loop ──────────────────────────────────
    // After the main tool loop, give the agent one chance to review its own work.
    // Only triggers when the agent actually did meaningful work (wrote/updated files).
    const mutatingTools = toolResults.filter(
      (r) => !r.error && MUTATING_TOOL_NAMES.has(r.tool),
    );
    if (finalMessage && mutatingTools.length > 0 && executedToolCount < MAX_TOOL_ITERATIONS - 2) {
      const fileList = mutatingTools.map((r) => r.params?.path || 'unknown').join(', ');
      messages.push(new HumanMessage(
        `[system] Self-review checkpoint. You wrote/updated: ${fileList}.\n`
        + 'Before finalizing, briefly check:\n'
        + '1. Did you miss any files or steps from the plan?\n'
        + '2. Are there obvious errors in what you wrote?\n'
        + '3. Should you hand off to another agent?\n'
        + 'If everything looks good, confirm and provide your final message. '
        + 'If you spot an issue, fix it now with a tool call.',
      ));

      try {
        const reflectionResult = await (nativeToolCallingEnabled ? nativeModel : baseModel).invoke(messages);
        const reflectionUsage = reflectionResult.additional_kwargs?.usage;
        if (reflectionUsage) {
          usageAccumulator.prompt_tokens += Number(reflectionUsage.prompt_tokens) || 0;
          usageAccumulator.completion_tokens += Number(reflectionUsage.completion_tokens) || 0;
          usageAccumulator.total_tokens += Number(reflectionUsage.total_tokens) || 0;
        }

        const reflectionContent = normalizeResponseContent(reflectionResult.content);
        const reflectionNativeToolCalls = extractNativeToolCalls(reflectionResult);
        const reflectionToolCalls = reflectionNativeToolCalls.length > 0
          ? reflectionNativeToolCalls.map((tc) => normalizeNativeToolCall(tc, new Set(allTools.map((t) => t.name)))).filter(Boolean)
          : extractToolCalls(reflectionContent);
        const reflectionClean = reflectionNativeToolCalls.length > 0
          ? reflectionContent.trim()
          : removeToolBlocks(reflectionContent).trim();

        // Execute any correction tool calls from reflection
        for (const toolCall of reflectionToolCalls.slice(0, 3)) {
          const tool = allTools.find((t) => t.name === toolCall.tool);
          if (!tool) continue;
          try {
            if (onToolUse) onToolUse(agent.name, toolCall.tool, toolCall);
            const toolResult = await tool.func(toolCall);
            const normalized = normalizeToolExecutionResult(toolResult);
            toolResults.push(
              normalized.error
                ? { tool: toolCall.tool, error: normalized.error, result: normalized.result, params: toolCall }
                : { tool: toolCall.tool, result: normalized.result, params: toolCall },
            );
          } catch {
            toolResults.push({ tool: toolCall.tool, error: 'Tool execution failed', params: toolCall });
          }
        }

        // Update final message with reflection output
        if (reflectionClean) {
          finalMessage = reflectionClean;
        }
        collectHandoffs(handoffs, reflectionContent, agent.name, roomContext.agents);
      } catch {
        // Reflection failed — keep original finalMessage, not critical
      }
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[${agent.name}] Agent turn failed:`, errMsg);
    if (error?.stack) console.error(`[${agent.name}] Stack:`, error.stack);

    // Provide a user-friendly but informative error message
    const isTimeout = /timed? ?out/i.test(errMsg);
    const isApiError = /Model API error|status(Code)?.*[45]\d\d/i.test(errMsg);
    const isConnectionError = /ECONNREFUSED|ECONNRESET|ENOTFOUND|socket hang up/i.test(errMsg);
    const isAborted = /aborted|cancelled/i.test(errMsg);

    if (isAborted) {
      finalMessage = '⏹ Work was stopped.';
    } else if (isTimeout) {
      finalMessage = '⏱ The request to the AI provider timed out. The server might be overloaded — please try again in a moment.';
    } else if (isConnectionError) {
      finalMessage = `🔌 Could not connect to the AI provider. Please check that the provider is running and accessible.\n\nError: ${errMsg}`;
    } else if (isApiError) {
      finalMessage = `⚠️ The AI provider returned an error:\n\n\`${errMsg}\`\n\nThis usually means the model is temporarily unavailable or the request was rejected.`;
    } else {
      finalMessage = `❌ I encountered an error while working on that task.\n\nError: \`${errMsg}\`\n\nPlease try again or check the server logs for details.`;
    }
  }

  if (!finalMessage) {
    finalMessage = `${agent.name} completed ${toolResults.length} action(s).`;
  }

  // Strip self-mentions — small models sometimes generate @planner when they ARE planner
  finalMessage = stripSelfMentions(finalMessage, agent.name);

  // ── Confidence Scoring ──────────────────────────────────────
  // Heuristic confidence based on tool success rate, reflection, and completeness.
  const confidence = computeConfidence(toolResults, finalMessage, handoffs);

  return {
    message: finalMessage,
    toolResults,
    handoffs,
    privateMemory: buildPrivateMemoryFromTurn(input, finalMessage, toolResults),
    usage: usageAccumulator,
    confidence,
  };
}

/**
 * Compute a confidence score (0-1) for an agent's turn output.
 * Based on: tool success rate, presence of handoffs, message quality signals.
 */
export function computeConfidence(toolResults, message, handoffs) {
  let score = 0.5; // baseline

  // Tool success rate
  const totalTools = toolResults.length;
  if (totalTools > 0) {
    const successCount = toolResults.filter((r) => !r.error).length;
    const successRate = successCount / totalTools;
    score += (successRate - 0.5) * 0.3; // ±0.15
  }

  // Did the agent produce meaningful output?
  const msgLength = String(message || '').length;
  if (msgLength > 200) score += 0.1;
  if (msgLength > 500) score += 0.05;
  if (msgLength < 50) score -= 0.1;

  // Did the agent use write tools (actually did work)?
  const wroteFiles = toolResults.some((r) => !r.error && (r.tool === 'write_file' || r.tool === 'update_file'));
  if (wroteFiles) score += 0.1;

  // Did the agent hand off properly?
  if (handoffs.length > 0) score += 0.05;

  // Uncertainty signals in message
  const uncertaintyPatterns = [/\bnot sure\b/i, /\bmight\b/i, /\bpossibly\b/i, /\bi think\b/i, /\bunsure\b/i];
  const uncertaintyCount = uncertaintyPatterns.filter((p) => p.test(message || '')).length;
  score -= uncertaintyCount * 0.05;

  // Error signals
  const errorPatterns = [/\berror\b/i, /\bfailed\b/i, /\bcouldn't\b/i, /\bunable to\b/i];
  const errorCount = errorPatterns.filter((p) => p.test(message || '')).length;
  score -= errorCount * 0.05;

  return Math.max(0, Math.min(1, Math.round(score * 100) / 100));
}

/**
 * Extract JSON tool call blocks from agent response.
 */
export function extractToolCalls(content) {
  const calls = [];
  const trimmedContent = String(content || '').trim();
  const leadingJson = extractLeadingJsonObject(trimmedContent);

  try {
    pushNormalizedToolCalls(calls, JSON.parse(trimmedContent));
  } catch {
    // Not a single JSON payload; continue with fenced/inline extraction.
  }

  if (leadingJson) {
    try {
      pushNormalizedToolCalls(calls, JSON.parse(leadingJson));
    } catch {
      // Ignore invalid leading JSON and continue with other strategies.
    }
  }

  const fencedPattern = /```json\s*([\s\S]*?)```/gi;
  let match;

  while ((match = fencedPattern.exec(content)) !== null) {
    try {
      pushNormalizedToolCalls(calls, JSON.parse(match[1].trim()));
    } catch {
      // Skip malformed JSON
    }
  }

  // Also try inline JSON objects
  const inlinePattern = /\{[^{}]*"tool"\s*:\s*"[^"]+?"[^{}]*\}/g;
  while ((match = inlinePattern.exec(content)) !== null) {
    try {
      pushNormalizedToolCalls(calls, JSON.parse(match[0]));
    } catch {
      // Skip
    }
  }

  return calls;
}

function pushNormalizedToolCalls(calls, parsed) {
  const items = Array.isArray(parsed) ? parsed : [parsed];

  for (const item of items) {
    const normalized = normalizeToolCall(item);
    if (!normalized) continue;

    const duplicate = calls.some((call) => (
      call.tool === normalized.tool
      && (call.path || '') === (normalized.path || '')
      && (call.to_agent || '') === (normalized.to_agent || '')
    ));

    if (!duplicate) {
      calls.push(normalized);
    }
  }
}

function normalizeToolCall(rawCall) {
  if (!rawCall || typeof rawCall !== 'object' || Array.isArray(rawCall)) {
    return null;
  }

  const nestedArgs = getNestedToolArgs(rawCall);
  const source = nestedArgs ? { ...rawCall, ...nestedArgs } : { ...rawCall };
  const tool = normalizeToolName(source);
  if (!tool || !KNOWN_TOOL_NAMES.has(tool)) {
    return null;
  }

  const normalized = { tool };

  if (tool === 'list_files' || tool === 'read_file' || tool === 'write_file' || tool === 'update_file' || tool === 'run_python') {
    const path = deriveWorkspaceToolPath(source);
    if (path) {
      normalized.path = path;
    }
  }

  if (tool === 'run_python') {
    const args = pickArray(source, ['args', 'argv', 'arguments', 'parameters']);
    if (args.length > 0) {
      normalized.args = args;
    }
  }

  if (tool === 'write_file') {
    const content = pickString(source, ['content', 'contents', 'text', 'value', 'data', 'body'], { preserveWhitespace: true });
    if (content) {
      normalized.content = content;
    }
  }

  if (tool === 'update_file') {
    const oldStr = pickString(source, ['old_str', 'oldString', 'old_text', 'oldText', 'find', 'search', 'from'], { preserveWhitespace: true });
    const newStr = pickString(source, ['new_str', 'newString', 'new_text', 'newText', 'replace', 'replacement', 'to'], { preserveWhitespace: true });
    if (oldStr) {
      normalized.old_str = oldStr;
    }
    if (newStr) {
      normalized.new_str = newStr;
    }
  }

  if (tool === 'propose') {
    const title = pickString(source, ['title', 'proposal_title', 'proposalTitle', 'heading', 'topic', 'name', 'subject']);
    const content = pickString(source, ['content', 'proposal', 'description', 'message', 'details', 'body'], { preserveWhitespace: true });
    const reviewers = pickArray(source, ['request_review_from', 'requestReviewFrom', 'reviewers', 'requested_reviewers', 'requestedReviewers', 'review_from', 'review_with', 'reviewWith']);
    if (title) normalized.title = title;
    if (content) normalized.content = content;
    if (reviewers.length > 0) {
      normalized.request_review_from = reviewers.map((value) => stripAgentPrefix(value));
    }
  }

  if (tool === 'respond_to_proposal') {
    const verdict = pickString(source, ['verdict', 'decision', 'status']);
    const reasoning = pickString(source, ['reasoning', 'reason', 'message', 'content'], { preserveWhitespace: true });
    const suggestions = pickString(source, ['suggestions', 'changes', 'feedback'], { preserveWhitespace: true });
    if (verdict) normalized.verdict = verdict;
    if (reasoning) normalized.reasoning = reasoning;
    if (suggestions) normalized.suggestions = suggestions;
  }

  if (tool === 'think_aloud') {
    const thought = pickString(source, ['thought', 'thinking', 'reasoning', 'message', 'content'], { preserveWhitespace: true });
    if (thought) {
      normalized.thought = thought;
    }
  }

  if (tool === 'delegate') {
    const rawTask = pickString(source, ['task', 'instruction', 'instructions', 'message', 'request', 'objective', 'work', 'prompt']);
    const inferredDelegation = inferDelegationTarget(rawTask);
    const toAgent = pickString(source, ['to_agent', 'toAgent', 'agent', 'agent_name', 'agentName', 'target', 'target_agent', 'recipient', 'assignee', 'delegate_to', 'delegateTo', 'to']) || inferredDelegation.toAgent;
    const task = inferredDelegation.task;
    const taskContext = pickString(source, ['context', 'details', 'notes', 'background']);
    if (toAgent) normalized.to_agent = stripAgentPrefix(toAgent);
    if (task) normalized.task = task;
    if (taskContext) normalized.context = taskContext;
  }

  if (tool === 'list_files' && !normalized.path) {
    normalized.path = '.';
  }

  return normalized;
}

function normalizeToolName(source) {
  if (typeof source.tool === 'string' && source.tool.trim()) {
    return source.tool.trim();
  }

  if (source.tool && typeof source.tool === 'object' && typeof source.tool.name === 'string') {
    return source.tool.name.trim();
  }

  for (const key of ['name', 'action', 'type']) {
    if (typeof source[key] === 'string' && KNOWN_TOOL_NAMES.has(source[key].trim())) {
      return source[key].trim();
    }
  }

  return '';
}

function getNestedToolArgs(source) {
  for (const key of ['args', 'arguments', 'input', 'parameters', 'params', 'payload']) {
    const value = source[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value;
    }
  }

  return null;
}

function deriveWorkspaceToolPath(source) {
  const directPath = pickString(source, [
    'path',
    'file_path',
    'filePath',
    'filepath',
    'file',
    'target_path',
    'targetPath',
    'output_path',
    'outputPath',
    'location',
    'destination',
  ]);
  const directory = pickString(source, ['directory', 'dir', 'folder', 'parent', 'parent_path', 'parentPath']);
  const filename = pickString(source, ['filename', 'file_name', 'fileName', 'name']);

  if (directory && filename) {
    return `${stripEdgeSlashes(directory)}/${stripLeadingSlashes(filename)}`;
  }

  if (directPath) {
    return directPath;
  }

  if (filename) {
    return filename;
  }

  return '';
}

function inferDelegationTarget(rawTask) {
  const taskText = String(rawTask || '').trim();
  if (!taskText) {
    return { toAgent: '', task: '' };
  }

  const mentionMatch = taskText.match(/^@([a-zA-Z][a-zA-Z0-9_-]{1,31})\b[:\s-]*(.*)$/s);
  if (!mentionMatch) {
    return { toAgent: '', task: taskText };
  }

  return {
    toAgent: mentionMatch[1],
    task: mentionMatch[2].trim() || taskText,
  };
}

function pickString(source, keys, options = {}) {
  const preserveWhitespace = options.preserveWhitespace === true;

  for (const key of keys) {
    if (typeof source[key] === 'string' && source[key].trim()) {
      return preserveWhitespace ? source[key] : source[key].trim();
    }
  }

  return '';
}

function pickArray(source, keys) {
  for (const key of keys) {
    const value = source[key];
    if (Array.isArray(value)) {
      return value.map((item) => String(item).trim()).filter(Boolean);
    }
    if (typeof value === 'string' && value.trim()) {
      return value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
    }
  }

  return [];
}

function stripAgentPrefix(value) {
  return String(value || '').trim().replace(/^@+/, '').toLowerCase();
}

function stripLeadingSlashes(value) {
  return String(value || '').trim().replace(/^[/\\]+/, '');
}

function stripEdgeSlashes(value) {
  return stripLeadingSlashes(String(value || '').trim()).replace(/[/\\]+$/, '');
}

/**
 * Remove tool JSON blocks from the message to get clean text.
 */
function removeToolBlocks(content) {
  const trimmedContent = String(content || '').trim();
  const leadingJson = extractLeadingJsonObject(trimmedContent);

  try {
    const parsed = JSON.parse(trimmedContent);
    const normalized = [];
    pushNormalizedToolCalls(normalized, parsed);
    if (normalized.length > 0) {
      return '';
    }
  } catch {
    // Not a standalone JSON payload.
  }

  if (leadingJson) {
    try {
      const normalized = [];
      pushNormalizedToolCalls(normalized, JSON.parse(leadingJson));
      if (normalized.length > 0) {
        return trimmedContent.slice(leadingJson.length).trim();
      }
    } catch {
      // Fall through to regex stripping.
    }
  }

  return content
    .replace(/```json\s*[\s\S]*?```/gi, '')
    .replace(/\{[^{}]*"tool"\s*:\s*"[^"]+?"[^{}]*\}/g, '')
    .trim();
}

function collectHandoffs(handoffs, message, currentAgentName, agents) {
  const mentionPattern = /(^|[^@\w])@([a-zA-Z][a-zA-Z0-9_-]{1,31})\b/g;
  const mentions = [...String(message || '').matchAll(mentionPattern)];
  const validAgentNames = new Set(agents.map((agent) => agent.name.toLowerCase()));
  const seen = new Set(handoffs.map((handoff) => `${handoff.agentName}:${handoff.message}`));

  for (const match of mentions) {
    const name = match[2].toLowerCase();
    if (name === currentAgentName.toLowerCase() || !validAgentNames.has(name)) {
      continue;
    }

    const key = `${name}:${message}`;
    if (seen.has(key)) {
      continue;
    }

    handoffs.push({ agentName: name, message });
    seen.add(key);
  }
}

function formatToolResultsForPrompt(toolResults) {
  return toolResults.map((result) => {
    if (result.error) {
      return `- ${result.tool}: ERROR ${result.error}`;
    }

    const output = typeof result.result === 'string'
      ? truncateForPrompt(result.result)
      : truncateForPrompt(JSON.stringify(result.result));
    return `- ${result.tool}: OK ${output}`;
  }).join('\n');
}

function truncateForPrompt(value, limit = 1200) {
  const text = String(value || '');
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function extractLeadingJsonObject(content) {
  const text = String(content || '').trimStart();
  if (!text.startsWith('{')) {
    return '';
  }

  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\') {
      escapeNext = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === '{') {
      depth += 1;
      continue;
    }

    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(0, index + 1);
      }
    }
  }

  return '';
}

function shouldContinueAfterToolRound(toolCalls, toolResults, cleanMessage, handoffsAdded) {
  if (toolCalls.length === 0) {
    return false;
  }

  const hadToolErrors = toolResults.some((toolResult) => typeof toolResult?.error === 'string' && toolResult.error.trim());
  if (hadToolErrors) {
    return true;
  }

  if (!cleanMessage) {
    return true;
  }

  if (handoffsAdded) {
    return false;
  }

  const readOnlyTools = new Set(['list_files', 'read_file', 'search_skills', 'read_skill', 'list_skill_files', 'web_search', 'web_fetch', 'calculator', 'image_info', 'semantic_search', 'browser_read', 'browser_open']);
  return toolCalls.every((toolCall) => readOnlyTools.has(toolCall.tool));
}

function shouldRequestPostToolActions({ cleanMessage, toolCalls, toolResults, handoffsAdded, postToolRetryCount, toolCallingMode }) {
  if (toolCallingMode !== 'text') {
    return false;
  }

  if (postToolRetryCount >= 1) {
    return false;
  }

  if (toolResults.length >= MAX_TOOL_ITERATIONS) {
    return false;
  }

  const usedExplicitDelegate = toolCalls.some((toolCall) => toolCall.tool === 'delegate');
  if (usedExplicitDelegate) {
    return false;
  }

  const readOnlyTools = new Set(['list_files', 'read_file', 'search_skills', 'read_skill', 'list_skill_files', 'web_search', 'web_fetch', 'calculator', 'image_info', 'semantic_search', 'browser_read', 'browser_open']);
  const usedMutatingTool = toolCalls.some((toolCall) => !readOnlyTools.has(toolCall.tool));
  if (!usedMutatingTool) {
    return false;
  }

  if (!handoffsAdded && !cleanMessageSuggestsMoreActions(cleanMessage)) {
    return false;
  }

  return cleanMessageSuggestsMoreActions(cleanMessage);
}

function shouldRequestExplicitToolActions({ cleanMessage, toolResults, explicitToolRetryCount, toolCallingMode }) {
  if (toolCallingMode !== 'text') {
    return false;
  }

  if (explicitToolRetryCount >= 1) {
    return false;
  }

  if (toolResults.length >= MAX_TOOL_ITERATIONS) {
    return false;
  }

  return cleanMessageSuggestsMoreActions(cleanMessage);
}

function cleanMessageSuggestsMoreActions(cleanMessage) {
  const text = String(cleanMessage || '').toLowerCase();
  if (!text) {
    return false;
  }

  const intentPatterns = [
    /\bi will\b/,
    /\bnext\b/,
    /\bgoing to\b/,
    /\bcreate\b/,
    /\bimplement\b/,
    /\bhand off\b/,
    /\breview\b/,
    /@(?:planner|coder|reviewer|scribe|[a-z][a-z0-9_-]{1,31})/,
  ];

  return intentPatterns.some((pattern) => pattern.test(text));
}

/**
 * Build private memory from a turn's results.
 */
/**
 * Build structured private memory from an agent turn.
 * Memory is organized into categories for better retrieval and learning.
 */
function buildPrivateMemoryFromTurn(input, message, toolResults) {
  const successfulTools = toolResults.filter((r) => !r.error);
  const failedTools = toolResults.filter((r) => r.error);
  const filesWritten = successfulTools
    .filter((r) => r.tool === 'write_file' || r.tool === 'update_file')
    .map((r) => r.params?.path || 'unknown');
  const filesRead = successfulTools
    .filter((r) => r.tool === 'read_file')
    .map((r) => r.params?.path || 'unknown');
  const skillsUsed = successfulTools
    .filter((r) => SKILL_TOOL_NAMES_SET.has(r.tool))
    .map((r) => r.params?.skill_id || r.params?.query || r.tool);

  const memory = {
    last_task: input.slice(0, 300),
    result_summary: message ? message.slice(0, 300) : '',
    tools_used: successfulTools.map((r) => r.tool),
    files_written: filesWritten,
    files_read: filesRead,
    skills_consulted: skillsUsed,
    mistakes: failedTools.map((r) => `${r.tool}: ${r.error}`).slice(0, 5),
    timestamp: Math.floor(Date.now() / 1000),
  };

  return JSON.stringify(memory);
}

/**
 * Parse structured memory from stored JSON, with fallback for legacy text format.
 */
export function parsePrivateMemory(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.last_task) {
      return parsed;
    }
  } catch {
    // Legacy text format — wrap it
  }
  return { last_task: raw, result_summary: '', tools_used: [], files_written: [], files_read: [], skills_consulted: [], mistakes: [] };
}

/**
 * Format structured memory for inclusion in system prompt.
 */
export function formatPrivateMemoryForPrompt(raw) {
  const memory = parsePrivateMemory(raw);
  if (!memory) return '';

  const parts = [];
  if (memory.last_task) parts.push(`Last task: ${memory.last_task}`);
  if (memory.result_summary) parts.push(`Result: ${memory.result_summary}`);
  if (memory.files_written?.length > 0) parts.push(`Files written: ${memory.files_written.join(', ')}`);
  if (memory.files_read?.length > 0) parts.push(`Files read: ${memory.files_read.join(', ')}`);
  if (memory.skills_consulted?.length > 0) parts.push(`Skills used: ${memory.skills_consulted.join(', ')}`);
  if (memory.mistakes?.length > 0) parts.push(`Previous mistakes (avoid repeating): ${memory.mistakes.join('; ')}`);
  return parts.join('\n');
}
