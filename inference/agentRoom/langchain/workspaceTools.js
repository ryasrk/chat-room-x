/**
 * LangChain Structured Tools — Workspace File Operations
 *
 * Wraps the existing fileTools into LangChain StructuredTool instances.
 * Each tool has a Zod-like schema for input validation and can be bound
 * to any LangChain agent.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { listFiles, readFile, writeFile, updateFile } from '../fileTools.js';
import { assertAgentCanRunPython, assertAgentCanWritePath, getAgentPolicy } from '../agentPolicy.js';
import { runWorkspacePythonFile } from '../workspaceRuntime.js';

function normalizeWorkspacePath(path) {
  return String(path || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\//, '');
}

function isAllowedRoot(path, roots) {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

/**
 * Create workspace file tools scoped to a specific workspace path.
 *
 * @param {string} workspacePath - Absolute path to the agent room workspace
 * @param {Object} context
 * @param {string} context.agentName
 * @returns {DynamicStructuredTool[]}
 */
export function createWorkspaceTools(workspacePath, context = {}) {
  const agentPolicy = getAgentPolicy({
    agentName: context.agentName,
    allowedTools: context.allowedTools,
  });

  const listFilesTool = new DynamicStructuredTool({
    name: 'list_files',
    description: 'List files and directories in the workspace. Returns an array of entries with path and type.',
    schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path within workspace to list. Defaults to "." for root.',
          default: '.',
        },
      },
    },
    func: async ({ path = '.' }) => {
      try {
        const entries = await listFiles(workspacePath, path, 4);
        return JSON.stringify(entries.slice(0, 80), null, 2);
      } catch (error) {
        return JSON.stringify({ error: error.message });
      }
    },
  });

  const readFileTool = new DynamicStructuredTool({
    name: 'read_file',
    description: 'Read the contents of a file in the workspace.',
    schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path to the file to read.',
        },
      },
      required: ['path'],
    },
    func: async ({ path }) => {
      try {
        const result = await readFile(workspacePath, path);
        return typeof result === 'string' ? result : JSON.stringify(result);
      } catch (error) {
        return JSON.stringify({ error: error.message });
      }
    },
  });

  const writeFileTool = new DynamicStructuredTool({
    name: 'write_file',
    description: 'Create or overwrite a file in the workspace with the given content.',
    schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path for the file to write.',
        },
        content: {
          type: 'string',
          description: 'Content to write to the file.',
        },
      },
      required: ['path', 'content'],
    },
    func: async ({ path, content }) => {
      try {
        assertAgentCanWritePath(agentPolicy, path);
        const result = await writeFile(workspacePath, path, content);
        return JSON.stringify(result);
      } catch (error) {
        return JSON.stringify({ error: error.message });
      }
    },
  });

  const updateFileTool = new DynamicStructuredTool({
    name: 'update_file',
    description: 'Update a file by replacing an exact string match with new content.',
    schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path to the file to update.',
        },
        old_str: {
          type: 'string',
          description: 'Exact string to find and replace.',
        },
        new_str: {
          type: 'string',
          description: 'Replacement string.',
        },
      },
      required: ['path', 'old_str', 'new_str'],
    },
    func: async ({ path, old_str, new_str }) => {
      try {
        assertAgentCanWritePath(agentPolicy, path);
        const result = await updateFile(workspacePath, path, old_str, new_str);
        return JSON.stringify(result);
      } catch (error) {
        return JSON.stringify({ error: error.message });
      }
    },
  });

  const runPythonTool = new DynamicStructuredTool({
    name: 'run_python',
    description: 'Execute a Python file from the workspace using the room-specific .venv and return stdout, stderr, and exit code.',
    schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path to the Python file to execute.',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional command-line arguments passed to the Python file.',
          default: [],
        },
      },
      required: ['path'],
    },
    func: async ({ path, args = [] }) => {
      try {
        assertAgentCanRunPython(agentPolicy);
        const result = await runWorkspacePythonFile(workspacePath, path, args);
        return JSON.stringify(result);
      } catch (error) {
        return JSON.stringify({ error: error.message });
      }
    },
  });

  return [listFilesTool, readFileTool, writeFileTool, updateFileTool, runPythonTool];
}

/**
 * Create collaboration-specific tools for agent interaction.
 *
 * @param {Object} context - Room context
 * @param {string} context.roomId
 * @param {string} context.agentName
 * @param {Function} context.postMessage - Function to post a message to the room
 * @param {Function} context.getAgentNames - Function to get available agent names
 * @returns {DynamicStructuredTool[]}
 */
export function createCollaborationTools(context) {
  const proposeTool = new DynamicStructuredTool({
    name: 'propose',
    description: 'Create a formal proposal for other agents to review. Use this when you have an idea, plan, or decision that needs team input.',
    schema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Short title for the proposal.',
        },
        content: {
          type: 'string',
          description: 'Detailed proposal content.',
        },
        request_review_from: {
          type: 'array',
          items: { type: 'string' },
          description: 'Agent names to request review from. Use ["all"] for everyone.',
          default: ['all'],
        },
      },
      required: ['title', 'content'],
    },
    func: async ({ title, content, request_review_from = ['all'] }) => {
      const cleanTitle = String(title || '').trim();
      if (!cleanTitle) {
        return JSON.stringify({ error: 'Title is required for proposals. Provide a short descriptive title.' });
      }
      const cleanContent = String(content || '').trim();
      if (!cleanContent) {
        return JSON.stringify({ error: 'Content is required for proposals. Describe the proposal in detail.' });
      }
      const requestedReviewers = Array.isArray(request_review_from) && request_review_from.length > 0
        ? request_review_from
        : ['all'];
      const reviewerMentions = requestedReviewers[0] === 'all'
        ? '@all'
        : requestedReviewers.map((name) => `@${String(name).toLowerCase()}`).join(' ');
      const proposalMessage = `Proposal: ${cleanTitle}\n\n${cleanContent}\n\nReview requested from: ${reviewerMentions}`;
      await context.postMessage(context.agentName, proposalMessage, 'proposal');
      return `Proposal "${cleanTitle}" posted. Awaiting review from: ${reviewerMentions}`;
    },
  });

  const respondToProposalTool = new DynamicStructuredTool({
    name: 'respond_to_proposal',
    description: 'Respond to a proposal from another agent with approval, rejection, or suggestions.',
    schema: {
      type: 'object',
      properties: {
        verdict: {
          type: 'string',
          enum: ['approve', 'reject', 'suggest_changes'],
          description: 'Your verdict on the proposal.',
        },
        reasoning: {
          type: 'string',
          description: 'Explanation for your verdict.',
        },
        suggestions: {
          type: 'string',
          description: 'Specific suggestions if verdict is suggest_changes.',
          default: '',
        },
      },
      required: ['verdict', 'reasoning'],
    },
    func: async ({ verdict, reasoning, suggestions = '' }) => {
      let message = `${verdict.toUpperCase()}: ${reasoning}`;
      if (suggestions) message += `\n\nSuggestions: ${suggestions}`;
      await context.postMessage(context.agentName, message, 'proposal_response');
      return `Response posted: ${verdict}`;
    },
  });

  const thinkAloudTool = new DynamicStructuredTool({
    name: 'think_aloud',
    description: 'Share your reasoning process with the room. Use this to make your thought process visible to other agents and the user.',
    schema: {
      type: 'object',
      properties: {
        thought: {
          type: 'string',
          description: 'Your current thinking or reasoning.',
        },
      },
      required: ['thought'],
    },
    func: async ({ thought }) => {
      await context.postMessage(context.agentName, `Thinking: ${thought}`, 'thinking');
      return 'Thought shared with room.';
    },
  });

  const delegateTool = new DynamicStructuredTool({
    name: 'delegate',
    description: 'Delegate a specific task to another agent with clear instructions.',
    schema: {
      type: 'object',
      properties: {
        to_agent: {
          type: 'string',
          description: 'Name of the agent to delegate to.',
        },
        task: {
          type: 'string',
          description: 'Clear description of the task to delegate.',
        },
        context: {
          type: 'string',
          description: 'Additional context or files the agent should look at.',
          default: '',
        },
      },
      required: ['to_agent', 'task'],
    },
    func: async ({ to_agent, task, context: taskContext = '' }) => {
      const targetAgent = String(to_agent || '').trim().replace(/^@+/, '').toLowerCase();
      if (!targetAgent) {
        return JSON.stringify({ error: 'Target agent is required. Specify to_agent with a valid agent name (e.g. "coder").' });
      }
      const knownAgents = typeof context.getAgentNames === 'function' ? context.getAgentNames() : [];
      if (knownAgents.length > 0 && !knownAgents.some((name) => name.toLowerCase() === targetAgent)) {
        return JSON.stringify({ error: `Unknown target agent "${targetAgent}". Available agents: ${knownAgents.join(', ')}` });
      }
      const cleanTask = String(task || '').trim();
      if (!cleanTask) {
        return JSON.stringify({ error: 'Task description is required. Describe what the target agent should do.' });
      }
      let message = `@${targetAgent} ${cleanTask}`;
      if (taskContext) message += `\n\n**Context:** ${taskContext}`;
      await context.postMessage(context.agentName, message, 'handoff');
      return `Task delegated to @${targetAgent}`;
    },
  });

  const spawnAgentTool = new DynamicStructuredTool({
    name: 'spawn_agent',
    description: 'Dynamically create a new specialist agent in the room. Use when the current team lacks expertise for a specific sub-task (e.g., a "tester" for writing tests, a "devops" for deployment scripts). Only planner can spawn agents.',
    schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Short lowercase name for the new agent (e.g., "tester", "devops", "designer").',
        },
        role: {
          type: 'string',
          description: 'One-sentence description of what this agent does.',
        },
        system_prompt: {
          type: 'string',
          description: 'System prompt defining the agent personality and instructions.',
        },
        model_tier: {
          type: 'string',
          enum: ['brain', 'worker'],
          description: 'Model tier: "brain" for complex reasoning, "worker" for fast implementation.',
          default: 'worker',
        },
        tools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tools the agent can use: list_files, read_file, write_file, update_file, run_python.',
          default: ['list_files', 'read_file', 'write_file'],
        },
        initial_task: {
          type: 'string',
          description: 'Optional first task to delegate to the new agent immediately.',
          default: '',
        },
      },
      required: ['name', 'role', 'system_prompt'],
    },
    func: async ({ name, role, system_prompt, model_tier = 'worker', tools = ['list_files', 'read_file', 'write_file'], initial_task = '' }) => {
      // Only planner can spawn agents
      const callerName = String(context.agentName || '').toLowerCase();
      if (callerName !== 'planner') {
        return JSON.stringify({ status: 'denied', reason: 'Only planner can spawn new agents. Ask @planner to spawn the agent for you.' });
      }

      const agentName = String(name || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
      if (!agentName || agentName.length > 20) {
        return JSON.stringify({ status: 'error', reason: 'Agent name must be 1-20 lowercase alphanumeric characters.' });
      }

      // Check if agent already exists
      const knownAgents = typeof context.getAgentNames === 'function' ? context.getAgentNames() : [];
      if (knownAgents.some((n) => n.toLowerCase() === agentName)) {
        return JSON.stringify({ status: 'exists', reason: `Agent "${agentName}" already exists in this room.` });
      }

      // Limit spawned agents per room
      if (knownAgents.length >= 8) {
        return JSON.stringify({ status: 'limit', reason: 'Maximum 8 agents per room. Remove an agent before spawning a new one.' });
      }

      const ALLOWED_TOOLS = new Set(['list_files', 'read_file', 'write_file', 'update_file', 'run_python']);
      const validTools = (Array.isArray(tools) ? tools : ['list_files', 'read_file', 'write_file'])
        .filter((t) => ALLOWED_TOOLS.has(t));

      // Use the spawnAgent callback provided by the orchestrator
      if (typeof context.spawnAgent !== 'function') {
        return JSON.stringify({ status: 'error', reason: 'Agent spawning is not available in this room configuration.' });
      }

      try {
        await context.spawnAgent({
          name: agentName,
          role: String(role || '').trim(),
          system_prompt: String(system_prompt || '').trim(),
          model_tier: model_tier === 'brain' ? 'brain' : 'worker',
          tools: validTools,
        });

        let result = `Agent @${agentName} spawned successfully with role: ${role}`;
        if (initial_task) {
          await context.postMessage(context.agentName, `@${agentName} ${initial_task}`, 'handoff');
          result += `\nInitial task delegated: ${initial_task}`;
        }
        return result;
      } catch (err) {
        return JSON.stringify({ status: 'error', reason: `Failed to spawn agent: ${err.message}` });
      }
    },
  });

  return [proposeTool, respondToProposalTool, thinkAloudTool, delegateTool, spawnAgentTool];
}
