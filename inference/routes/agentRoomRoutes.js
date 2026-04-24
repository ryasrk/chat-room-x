import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { promises as fs } from 'fs';
import { basename, dirname, extname, join } from 'path';
import { fileURLToPath } from 'url';

import {
  addRoomSkill,
  canAccessAgentRoom,
  clearAgentRoomMemory,
  createAgentRoomAgent,
  createAgentRoomTask,
  createAgentRoomWithDefaults,
  createSnapshot,
  deleteAgentRoomAgent,
  deleteSnapshot,
  getAgentRoom,
  getAgentRoomAgent,
  getAgentRoomFileReview,
  getAgentRoomMemory,
  getAgentRoomTask,
  getAgentRoomTokenHistory,
  getAgentRoomTokenSummary,
  getSnapshot,
  listAgentRoomAgents,
  listAgentRoomLogs,
  listAgentRoomMemories,
  listAgentRoomMessages,
  listAgentRoomTasks,
  listAgentRoomsByOwner,
  listRoomSkills,
  listSnapshots,
  removeRoomSkill,
  saveAgentRoomLog,
  saveAgentRoomMemory,
  saveAgentRoomMessage,
  upsertAgentRoomFileReview,
  updateAgentRoomConfig,
  updateAgentRoomAgent,
  updateAgentRoomTask,
  uuid,
  deleteAgentRoom,
} from '../db/database.js';
import { buildDefaultAgents } from '../agentRoom/defaultAgents.js';
import { listAvailableSkills, getSkillContent, readSkillDataFile } from '../agentRoom/skillLoader.js';
import { ensureWorkspace, listFiles, readFile, safePath, updateFile, writeFile } from '../agentRoom/fileTools.js';
import { ensureWorkspacePythonEnv, runWorkspacePythonFile } from '../agentRoom/workspaceRuntime.js';
import { fetchProviderModelsForUi, getProviderPresetsForUi } from '../agentRoom/modelRouter.js';
import { agentRoomOrchestrator } from '../agentRoom/orchestrator.js';
import { broadcastAgentRoomEvent } from '../agentRoom/wsBridge.js';
import { sendJson, readBody } from './apiRouter.js';

const VALID_PROVIDERS = new Set(['enowxai', 'openai', 'anthropic', 'custom', 'tier', '']);
const VALID_ORCHESTRATION_MODES = new Set(['reactive', 'legacy']);
const VALID_AGENT_TOOLS = new Set(['list_files', 'read_file', 'write_file', 'update_file', 'run_python']);
const VALID_TASK_STATUSES = new Set(['todo', 'in_progress', 'blocked', 'done']);
const VALID_TASK_PRIORITIES = new Set(['low', 'medium', 'high']);
const VALID_FILE_REVIEW_STATUSES = new Set(['draft', 'in_review', 'changes_requested', 'approved', 'promoted']);
const VALID_TOOL_CALLING_MODES = new Set(['auto', 'native', 'text']);
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

const FILE_DOWNLOAD_MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.py': 'text/x-python; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.tsx': 'text/plain; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
};

function getDownloadMimeType(filePath) {
  return FILE_DOWNLOAD_MIME_TYPES[extname(String(filePath || '')).toLowerCase()] || 'application/octet-stream';
}

function sanitizeMcpHeaders(rawHeaders) {
  if (!rawHeaders || typeof rawHeaders !== 'object' || Array.isArray(rawHeaders)) {
    return undefined;
  }

  const headers = Object.fromEntries(
    Object.entries(rawHeaders)
      .map(([key, value]) => [String(key).trim().slice(0, 120), String(value).trim().slice(0, 2000)])
      .filter(([key, value]) => key && value)
      .filter(([key]) => !FORBIDDEN_MCP_HEADER_NAMES.has(key.toLowerCase())),
  );

  return Object.keys(headers).length > 0 ? headers : undefined;
}

function sanitizeMcpServers(rawServers) {
  if (!Array.isArray(rawServers)) {
    return [];
  }

  return rawServers
    .map((server, index) => {
      if (!server || typeof server !== 'object') {
        return null;
      }

      const transport = typeof server.transport === 'string'
        ? server.transport.trim().toLowerCase()
        : 'streamable_http';
      if (transport !== 'streamable_http' && transport !== 'stdio') {
        return null;
      }

      const id = typeof server.id === 'string' && server.id.trim()
        ? server.id.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, 60)
        : `server_${index + 1}`;

      const sanitized = {
        id,
        transport,
      };

      if (transport === 'streamable_http') {
        if (typeof server.url !== 'string' || !server.url.trim()) {
          return null;
        }
        sanitized.url = server.url.trim().slice(0, 1000);

        const headers = sanitizeMcpHeaders(server.headers);
        if (headers) {
          sanitized.headers = headers;
        }
      } else {
        if (typeof server.command !== 'string' || !server.command.trim()) {
          return null;
        }
        sanitized.command = server.command.trim().slice(0, 300);
        sanitized.args = Array.isArray(server.args)
          ? server.args.map((arg) => String(arg).trim().slice(0, 300)).filter(Boolean)
          : [];
        if (typeof server.cwd === 'string' && server.cwd.trim()) {
          sanitized.cwd = server.cwd.trim().slice(0, 500);
        }
        if (server.env && typeof server.env === 'object' && !Array.isArray(server.env)) {
          sanitized.env = Object.fromEntries(
            Object.entries(server.env)
              .map(([key, value]) => [String(key).trim().slice(0, 120), String(value).trim().slice(0, 1000)])
              .filter(([key, value]) => key && value),
          );
        }
      }

      if (Array.isArray(server.allowed_tools)) {
        sanitized.allowed_tools = server.allowed_tools
          .map((tool) => String(tool).trim().slice(0, 120))
          .filter(Boolean);
      }

      return sanitized;
    })
    .filter(Boolean);
}

function sanitizeProviderConfig(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const config = {};
  if (raw.provider && typeof raw.provider === 'string') {
    if (!VALID_PROVIDERS.has(raw.provider)) return {};
    config.provider = raw.provider;
  }
  if (raw.base_url && typeof raw.base_url === 'string') {
    config.base_url = raw.base_url.trim().slice(0, 500);
  }
  if (raw.api_key && typeof raw.api_key === 'string') {
    config.api_key = raw.api_key.trim().slice(0, 500);
  }
  if (raw.model && typeof raw.model === 'string') {
    config.model = raw.model.trim().slice(0, 200);
  }
  if (typeof raw.max_tokens === 'number' && raw.max_tokens > 0 && raw.max_tokens <= 128000) {
    config.max_tokens = Math.floor(raw.max_tokens);
  }
  if (typeof raw.temperature === 'number' && raw.temperature >= 0 && raw.temperature <= 2) {
    config.temperature = raw.temperature;
  }
  if (typeof raw.tool_calling_mode === 'string') {
    const mode = raw.tool_calling_mode.trim().toLowerCase();
    if (VALID_TOOL_CALLING_MODES.has(mode)) {
      config.tool_calling_mode = mode;
    }
  }
  const mcpServers = sanitizeMcpServers(raw.mcp_servers);
  if (mcpServers.length > 0) {
    config.mcp_servers = mcpServers;
  }
  return config;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const AGENT_WORKSPACES_ROOT = join(PROJECT_ROOT, 'data', 'agent-workspaces');
const MESSAGE_RATE_LIMIT_MS = 1500;
const recentMessageByUserRoom = new Map();

async function removeAgentWorkspace(workspacePath) {
  if (!workspacePath || typeof workspacePath !== 'string') return;
  if (!workspacePath.startsWith(AGENT_WORKSPACES_ROOT)) return;
  await fs.rm(workspacePath, { recursive: true, force: true });
}

function sanitizeRoomConfig(raw) {
  const mode = typeof raw?.orchestration_mode === 'string'
    ? raw.orchestration_mode.trim().toLowerCase()
    : 'reactive';
  const levelValue = raw?.autonomy_level;
  const autonomyLevel = Number.isFinite(Number(levelValue))
    ? Math.floor(Number(levelValue))
    : 2;

  return {
    orchestration_mode: VALID_ORCHESTRATION_MODES.has(mode) ? mode : 'reactive',
    autonomy_level: Math.min(3, Math.max(0, autonomyLevel)),
  };
}

function sanitizeAgentTools(rawTools) {
  if (!Array.isArray(rawTools)) {
    return [];
  }

  const tools = rawTools.map((tool) => String(tool).trim()).filter(Boolean);
  if (tools.some((tool) => !VALID_AGENT_TOOLS.has(tool))) {
    throw new Error('tools contain an unsupported tool name');
  }

  return [...new Set(tools)];
}

function sanitizeAgentRoom(room) {
  return {
    id: room.id,
    owner_id: room.owner_id,
    name: room.name,
    description: room.description,
    workspace_id: room.workspace_id,
    workspace_path: `workspace:${room.workspace_id}`,
    orchestration_mode: room.orchestration_mode || 'reactive',
    autonomy_level: Number.isFinite(Number(room.autonomy_level)) ? Number(room.autonomy_level) : 2,
    is_active: room.is_active,
    created_at: room.created_at,
    updated_at: room.updated_at,
    agent_count: room.agent_count,
    message_count: room.message_count,
  };
}

function sanitizeTaskPayload(raw, existing = null) {
  const title = raw?.title !== undefined ? String(raw.title || '').trim() : existing?.title || '';
  const details = raw?.details !== undefined ? String(raw.details || '').trim() : existing?.details || '';
  const status = raw?.status !== undefined ? String(raw.status || '').trim().toLowerCase() : existing?.status || 'todo';
  const priority = raw?.priority !== undefined ? String(raw.priority || '').trim().toLowerCase() : existing?.priority || 'medium';
  const assigneeName = raw?.assignee_name !== undefined ? String(raw.assignee_name || '').trim().toLowerCase() : existing?.assignee_name || '';

  if (!title) {
    throw new Error('title is required');
  }
  if (title.length > 160) {
    throw new Error('title must be 1-160 characters');
  }
  if (details.length > 4000) {
    throw new Error('details must be 0-4000 characters');
  }
  if (!VALID_TASK_STATUSES.has(status)) {
    throw new Error('status must be todo, in_progress, blocked, or done');
  }
  if (!VALID_TASK_PRIORITIES.has(priority)) {
    throw new Error('priority must be low, medium, or high');
  }
  if (assigneeName && !/^[a-z][a-z0-9_-]{1,31}$/.test(assigneeName)) {
    throw new Error('assignee_name must match an existing agent-style name');
  }

  return {
    title,
    details,
    status,
    priority,
    assignee_name: assigneeName,
  };
}

function sanitizeFileReviewPayload(raw) {
  const path = String(raw?.path || '').trim();
  const status = String(raw?.status || '').trim().toLowerCase();
  const summary = String(raw?.summary || '').trim();

  if (!path) {
    throw new Error('path is required');
  }
  if (!VALID_FILE_REVIEW_STATUSES.has(status)) {
    throw new Error('status must be draft, in_review, changes_requested, approved, or promoted');
  }
  if (summary.length > 2000) {
    throw new Error('summary must be 0-2000 characters');
  }

  return { path, status, summary };
}

function getAccessibleRoomOrReject(roomId, userId, res) {
  const room = getAgentRoom(roomId);
  if (!room || !canAccessAgentRoom(room, userId)) {
    sendJson(res, 404, { error: 'Agent room not found' });
    return null;
  }
  ensureWorkspace(room.workspace_path);
  return room;
}

function requireRoomOwner(room, userId, res) {
  if (!room || room.owner_id !== userId) {
    sendJson(res, 403, { error: 'Only the room owner can perform this action' });
    return false;
  }
  return true;
}

async function seedWorkspace(room, agents) {
  ensureWorkspace(AGENT_WORKSPACES_ROOT);
  ensureWorkspace(room.workspace_path);
  await fs.mkdir(join(room.workspace_path, 'src'), { recursive: true });
  await fs.mkdir(join(room.workspace_path, 'notes'), { recursive: true });

  const readmePath = join(room.workspace_path, 'README.md');
  if (!existsSync(readmePath)) {
    await fs.writeFile(readmePath, [
      `# ${room.name}`,
      '',
      room.description || 'AI Agent Room workspace.',
      '',
      '## Agents',
      ...agents.map((agent) => `- @${agent.name}: ${agent.role}`),
      '',
      '## Suggested workflow',
      '- Ask @planner to break down the task.',
      '- Ask @coder to implement files in src/.',
      '- Ask @reviewer to inspect the outputs.',
      '- Ask @scribe to summarize results in notes/.',
      '',
    ].join('\n'), 'utf-8');
  }

  await ensureWorkspacePythonEnv(room.workspace_path);
}

function streamWorkspaceZip(workspacePath, roomName, res) {
  const zip = spawn('zip', ['-r', '-', '.'], { cwd: workspacePath });

  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${roomName.replace(/[^a-zA-Z0-9_-]+/g, '_') || 'agent-room'}-workspace.zip"`,
  });

  zip.stdout.pipe(res);
  zip.stderr.on('data', () => {});
  zip.on('error', () => {
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'zip command is not available on the server' });
    } else {
      res.destroy();
    }
  });
  zip.on('close', (code) => {
    if (code !== 0 && !res.writableEnded) {
      res.destroy();
    }
  });
}

/**
 * @param {string} path
 * @param {URL} url
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @returns {Promise<boolean>}
 */
export async function handleAgentRoomRoute(path, url, req, res) {
  const userId = req.user.id;

  // Provider presets for the dashboard UI
  if (path === '/api/agent-rooms/provider-presets' && req.method === 'GET') {
    sendJson(res, 200, { presets: await getProviderPresetsForUi() }, { 'Cache-Control': 'public, max-age=300' });
    return true;
  }

  if (path === '/api/agent-rooms/provider-models' && req.method === 'GET') {
    const provider = String(url.searchParams.get('provider') || '').trim().toLowerCase();
    sendJson(res, 200, { provider, models: await fetchProviderModelsForUi(provider) }, { 'Cache-Control': 'public, max-age=120' });
    return true;
  }

  if (path === '/api/agent-rooms' && req.method === 'GET') {
    const rooms = listAgentRoomsByOwner(userId).map(sanitizeAgentRoom);
    sendJson(res, 200, { rooms });
    return true;
  }

  if (path === '/api/agent-rooms' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      const description = String(body.description || '').trim();
      const roomConfig = sanitizeRoomConfig(body);

      if (name.length < 2 || name.length > 80) {
        sendJson(res, 400, { error: 'Room name must be 2-80 characters' });
        return true;
      }

      ensureWorkspace(AGENT_WORKSPACES_ROOT);
      const roomId = uuid();
      const workspaceId = uuid();
      const workspacePath = join(AGENT_WORKSPACES_ROOT, workspaceId);
      const agents = buildDefaultAgents(uuid);

      createAgentRoomWithDefaults({
        id: roomId,
        owner_id: userId,
        name,
        description,
        workspace_id: workspaceId,
        workspace_path: workspacePath,
        orchestration_mode: roomConfig.orchestration_mode,
        autonomy_level: roomConfig.autonomy_level,
      }, agents);

      const room = getAgentRoom(roomId);
      await seedWorkspace(room, agents);
      saveAgentRoomLog(roomId, 'system', 'info', 'Agent room initialized', { workspace_id: workspaceId });

      sendJson(res, 201, {
        room: sanitizeAgentRoom(room),
        agents: listAgentRoomAgents(roomId),
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Failed to create agent room' });
    }
    return true;
  }

  const tasksMatch = path.match(/^\/api\/agent-rooms\/([^/]+)\/tasks$/);
  if (tasksMatch && req.method === 'GET') {
    const room = getAccessibleRoomOrReject(tasksMatch[1], userId, res);
    if (!room) return true;

    sendJson(res, 200, { tasks: listAgentRoomTasks(room.id) });
    return true;
  }

  if (tasksMatch && req.method === 'POST') {
    const room = getAccessibleRoomOrReject(tasksMatch[1], userId, res);
    if (!room) return true;
    if (!requireRoomOwner(room, userId, res)) return true;

    try {
      const body = await readBody(req);
      const task = createAgentRoomTask(room.id, {
        ...sanitizeTaskPayload(body),
        created_by: req.user.username || req.user.display_name || userId,
      });
      saveAgentRoomLog(room.id, 'system', 'info', `Created task ${task.title}`, {
        task_id: task.id,
        status: task.status,
        priority: task.priority,
      });
      sendJson(res, 201, { task, tasks: listAgentRoomTasks(room.id) });
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Failed to create task' });
    }
    return true;
  }

  const singleTaskMatch = path.match(/^\/api\/agent-rooms\/([^/]+)\/tasks\/([^/]+)$/);
  if (singleTaskMatch && req.method === 'PATCH') {
    const room = getAccessibleRoomOrReject(singleTaskMatch[1], userId, res);
    if (!room) return true;
    if (!requireRoomOwner(room, userId, res)) return true;

    const existing = getAgentRoomTask(room.id, singleTaskMatch[2]);
    if (!existing) {
      sendJson(res, 404, { error: 'Task not found' });
      return true;
    }

    try {
      const body = await readBody(req);
      const updated = updateAgentRoomTask(room.id, existing.id, sanitizeTaskPayload(body, existing));
      saveAgentRoomLog(room.id, 'system', 'info', `Updated task ${updated.title}`, {
        task_id: updated.id,
        status: updated.status,
        priority: updated.priority,
      });
      sendJson(res, 200, { task: updated, tasks: listAgentRoomTasks(room.id) });
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Failed to update task' });
    }
    return true;
  }

  const roomMatch = path.match(/^\/api\/agent-rooms\/([^/]+)$/);
  if (roomMatch && req.method === 'GET') {
    const room = getAccessibleRoomOrReject(roomMatch[1], userId, res);
    if (!room) return true;

    sendJson(res, 200, {
      room: sanitizeAgentRoom(room),
      agents: listAgentRoomAgents(room.id),
      messages: listAgentRoomMessages(room.id, 100),
      logs: listAgentRoomLogs(room.id, 100),
    });
    return true;
  }

  if (roomMatch && req.method === 'DELETE') {
    const room = getAgentRoom(roomMatch[1]);
    const result = deleteAgentRoom(roomMatch[1], userId);
    if (result.changes === 0) {
      sendJson(res, 404, { error: 'Agent room not found' });
      return true;
    }
    if (room?.workspace_path) {
      removeAgentWorkspace(room.workspace_path).catch((err) => {
        console.error('[agent-room-delete] Failed to remove workspace:', err);
      });
    }
    sendJson(res, 200, { ok: true });
    return true;
  }

  const roomConfigMatch = path.match(/^\/api\/agent-rooms\/([^/]+)\/config$/);
  if (roomConfigMatch && req.method === 'PATCH') {
    const room = getAccessibleRoomOrReject(roomConfigMatch[1], userId, res);
    if (!room) return true;
    if (!requireRoomOwner(room, userId, res)) return true;

    try {
      const body = await readBody(req);
      const config = sanitizeRoomConfig({
        orchestration_mode: body.orchestration_mode ?? room.orchestration_mode,
        autonomy_level: body.autonomy_level ?? room.autonomy_level,
      });

      updateAgentRoomConfig(room.id, config);
      saveAgentRoomLog(room.id, 'system', 'info', 'Updated agent room config', config);

      sendJson(res, 200, {
        room: sanitizeAgentRoom(getAgentRoom(room.id)),
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Failed to update room config' });
    }
    return true;
  }

  const messageMatch = path.match(/^\/api\/agent-rooms\/([^/]+)\/message$/);
  if (messageMatch && req.method === 'POST') {
    const room = getAccessibleRoomOrReject(messageMatch[1], userId, res);
    if (!room) return true;

    try {
      const body = await readBody(req);
      const content = String(body.content || '').trim();
      if (!content) {
        sendJson(res, 400, { error: 'content is required' });
        return true;
      }

      const rateKey = `${userId}:${room.id}`;
      const now = Date.now();
      const lastMessageAt = recentMessageByUserRoom.get(rateKey) || 0;
      if (now - lastMessageAt < MESSAGE_RATE_LIMIT_MS) {
        sendJson(res, 429, { error: 'Messages are arriving too quickly. Please retry shortly.' });
        return true;
      }
      recentMessageByUserRoom.set(rateKey, now);

      agentRoomOrchestrator.handleUserMessage(room.id, req.user, content).catch((error) => {
        saveAgentRoomLog(room.id, 'system', 'error', 'Agent workflow failed');
      });

      sendJson(res, 202, { queued: true });
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Failed to queue message' });
    }
    return true;
  }

  const cancelMatch = path.match(/^\/api\/agent-rooms\/([^/]+)\/cancel$/);
  if (cancelMatch && req.method === 'POST') {
    const room = getAccessibleRoomOrReject(cancelMatch[1], userId, res);
    if (!room) return true;

    try {
      agentRoomOrchestrator.cancelRoom(room.id);
      sendJson(res, 200, { cancelled: true });
    } catch (error) {
      sendJson(res, 500, { error: error.message || 'Failed to cancel agent work' });
    }
    return true;
  }

  const messagesMatch = path.match(/^\/api\/agent-rooms\/([^/]+)\/messages$/);
  if (messagesMatch && req.method === 'GET') {
    const room = getAccessibleRoomOrReject(messagesMatch[1], userId, res);
    if (!room) return true;

    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 200);
    sendJson(res, 200, { messages: listAgentRoomMessages(room.id, limit) });
    return true;
  }

  const logsMatch = path.match(/^\/api\/agent-rooms\/([^/]+)\/logs$/);
  if (logsMatch && req.method === 'GET') {
    const room = getAccessibleRoomOrReject(logsMatch[1], userId, res);
    if (!room) return true;

    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 200);
    sendJson(res, 200, { logs: listAgentRoomLogs(room.id, limit) });
    return true;
  }

  const agentsMatch = path.match(/^\/api\/agent-rooms\/([^/]+)\/agents$/);
  if (agentsMatch && req.method === 'GET') {
    const room = getAccessibleRoomOrReject(agentsMatch[1], userId, res);
    if (!room) return true;

    sendJson(res, 200, { agents: listAgentRoomAgents(room.id) });
    return true;
  }

  if (agentsMatch && req.method === 'POST') {
    const room = getAccessibleRoomOrReject(agentsMatch[1], userId, res);
    if (!room) return true;
    if (!requireRoomOwner(room, userId, res)) return true;

    try {
      const body = await readBody(req);
      const name = String(body.name || '').trim().toLowerCase();
      const role = String(body.role || '').trim();
      const modelTier = String(body.model_tier || '').trim();
      const systemPrompt = String(body.system_prompt || '').trim();
      const tools = sanitizeAgentTools(body.tools);
      const providerConfig = sanitizeProviderConfig(body.provider_config);
      const routerConfig = sanitizeProviderConfig(body.router_config);

      if (!/^[a-z][a-z0-9_-]{1,31}$/.test(name)) {
        sendJson(res, 400, { error: 'Agent name must be 2-32 chars using letters, numbers, underscores, hyphens' });
        return true;
      }
      if (!role) {
        sendJson(res, 400, { error: 'role is required' });
        return true;
      }
      if (!['brain', 'worker', 'cheap_worker'].includes(modelTier)) {
        sendJson(res, 400, { error: 'model_tier must be brain, worker, or cheap_worker' });
        return true;
      }

      createAgentRoomAgent(room.id, name, role, modelTier, systemPrompt, tools, providerConfig, routerConfig);
      sendJson(res, 201, { agents: listAgentRoomAgents(room.id) });
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Failed to add agent' });
    }
    return true;
  }

  const singleAgentMatch = path.match(/^\/api\/agent-rooms\/([^/]+)\/agents\/([^/]+)$/);
  if (singleAgentMatch && req.method === 'PATCH') {
    const room = getAccessibleRoomOrReject(singleAgentMatch[1], userId, res);
    if (!room) return true;
    if (!requireRoomOwner(room, userId, res)) return true;

    const agentName = singleAgentMatch[2].toLowerCase();
    const existing = getAgentRoomAgent(room.id, agentName, { includeSecrets: true });
    if (!existing) {
      sendJson(res, 404, { error: `Agent "${agentName}" not found in this room` });
      return true;
    }

    try {
      const body = await readBody(req);
      const role = body.role !== undefined ? String(body.role).trim() : existing.role;
      const modelTier = body.model_tier !== undefined ? String(body.model_tier).trim() : existing.model_tier;
      const systemPrompt = body.system_prompt !== undefined ? String(body.system_prompt).trim() : existing.system_prompt;
      const tools = body.tools !== undefined
        ? sanitizeAgentTools(body.tools)
        : existing.tools;
      const providerConfig = body.provider_config !== undefined
        ? sanitizeProviderConfig(body.provider_config)
        : existing.provider_config;
      const routerConfig = body.router_config !== undefined
        ? sanitizeProviderConfig(body.router_config)
        : existing.router_config;

      if (!role) {
        sendJson(res, 400, { error: 'role cannot be empty' });
        return true;
      }
      if (!['brain', 'worker', 'cheap_worker'].includes(modelTier)) {
        sendJson(res, 400, { error: 'model_tier must be brain, worker, or cheap_worker' });
        return true;
      }

      updateAgentRoomAgent(room.id, agentName, { role, model_tier: modelTier, system_prompt: systemPrompt, tools, provider_config: providerConfig, router_config: routerConfig });
      sendJson(res, 200, { agents: listAgentRoomAgents(room.id) });
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Failed to update agent' });
    }
    return true;
  }

  if (singleAgentMatch && req.method === 'DELETE') {
    const room = getAccessibleRoomOrReject(singleAgentMatch[1], userId, res);
    if (!room) return true;
    if (!requireRoomOwner(room, userId, res)) return true;

    const agentName = singleAgentMatch[2].toLowerCase();
    const result = deleteAgentRoomAgent(room.id, agentName);
    if (result.changes === 0) {
      sendJson(res, 404, { error: `Agent "${agentName}" not found in this room` });
      return true;
    }
    sendJson(res, 200, { agents: listAgentRoomAgents(room.id) });
    return true;
  }

  const filesMatch = path.match(/^\/api\/agent-rooms\/([^/]+)\/files$/);
  if (filesMatch && req.method === 'GET') {
    const room = getAccessibleRoomOrReject(filesMatch[1], userId, res);
    if (!room) return true;

    try {
      const pathParam = url.searchParams.get('path') || '.';
      const files = await listFiles(room.workspace_path, pathParam, 5);
      sendJson(res, 200, { files });
    } catch (error) {
      sendJson(res, 400, { error: 'Failed to list files' });
    }
    return true;
  }

  const fileReadMatch = path.match(/^\/api\/agent-rooms\/([^/]+)\/file$/);
  if (fileReadMatch && req.method === 'GET') {
    const room = getAccessibleRoomOrReject(fileReadMatch[1], userId, res);
    if (!room) return true;

    try {
      const filePath = url.searchParams.get('path') || '';
      if (!filePath) {
        sendJson(res, 400, { error: 'path is required' });
        return true;
      }
      const file = await readFile(room.workspace_path, filePath);
      sendJson(res, 200, { file });
    } catch (error) {
      sendJson(res, 400, { error: 'Failed to read file' });
    }
    return true;
  }

  // ── Agent Memories ──────────────────────────────────────────────
  const memoriesMatch = path.match(/^\/api\/agent-rooms\/([^/]+)\/memories$/);
  if (memoriesMatch && req.method === 'GET') {
    const room = getAccessibleRoomOrReject(memoriesMatch[1], userId, res);
    if (!room) return true;

    sendJson(res, 200, { memories: listAgentRoomMemories(room.id) });
    return true;
  }

  const singleMemoryMatch = path.match(/^\/api\/agent-rooms\/([^/]+)\/memories\/([^/]+)$/);
  if (singleMemoryMatch && req.method === 'GET') {
    const room = getAccessibleRoomOrReject(singleMemoryMatch[1], userId, res);
    if (!room) return true;

    const agentName = singleMemoryMatch[2].toLowerCase();
    const memory = getAgentRoomMemory(room.id, agentName);
    sendJson(res, 200, { memory: memory || { agent_name: agentName, memory_text: '', updated_at: null } });
    return true;
  }

  if (singleMemoryMatch && req.method === 'PUT') {
    const room = getAccessibleRoomOrReject(singleMemoryMatch[1], userId, res);
    if (!room) return true;
    if (!requireRoomOwner(room, userId, res)) return true;

    try {
      const body = await readBody(req);
      const agentName = singleMemoryMatch[2].toLowerCase();
      const memoryText = String(body.memory_text || '').trim();
      saveAgentRoomMemory(room.id, agentName, memoryText);
      sendJson(res, 200, { memory: getAgentRoomMemory(room.id, agentName) });
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Failed to update memory' });
    }
    return true;
  }

  if (singleMemoryMatch && req.method === 'DELETE') {
    const room = getAccessibleRoomOrReject(singleMemoryMatch[1], userId, res);
    if (!room) return true;
    if (!requireRoomOwner(room, userId, res)) return true;

    const agentName = singleMemoryMatch[2].toLowerCase();
    clearAgentRoomMemory(room.id, agentName);
    sendJson(res, 200, { ok: true });
    return true;
  }

  // ── Token Usage ───────────────────────────────────────────────
  const tokenUsageMatch = path.match(/^\/api\/agent-rooms\/([^/]+)\/token-usage$/);
  if (tokenUsageMatch && req.method === 'GET') {
    const room = getAccessibleRoomOrReject(tokenUsageMatch[1], userId, res);
    if (!room) return true;

    const summary = getAgentRoomTokenSummary(room.id);
    const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);
    const history = getAgentRoomTokenHistory(room.id, limit);
    sendJson(res, 200, { summary, history });
    return true;
  }

  const fileReviewMatch = path.match(/^\/api\/agent-rooms\/([^/]+)\/file-review$/);
  if (fileReviewMatch && req.method === 'GET') {
    const room = getAccessibleRoomOrReject(fileReviewMatch[1], userId, res);
    if (!room) return true;

    try {
      const filePath = String(url.searchParams.get('path') || '').trim();
      if (!filePath) {
        sendJson(res, 400, { error: 'path is required' });
        return true;
      }

      const resolvedPath = safePath(room.workspace_path, filePath);
      const stat = await fs.stat(resolvedPath);
      if (!stat.isFile()) {
        sendJson(res, 400, { error: 'Requested path is not a file' });
        return true;
      }

      sendJson(res, 200, {
        review: getAgentRoomFileReview(room.id, filePath) || {
          room_id: room.id,
          file_path: filePath,
          status: 'draft',
          summary: '',
          updated_by: '',
          created_at: null,
          updated_at: null,
        },
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Failed to load file review state' });
    }
    return true;
  }

  if (fileReviewMatch && req.method === 'POST') {
    const room = getAccessibleRoomOrReject(fileReviewMatch[1], userId, res);
    if (!room) return true;
    if (!requireRoomOwner(room, userId, res)) return true;

    try {
      const body = await readBody(req);
      const payload = sanitizeFileReviewPayload(body);
      const resolvedPath = safePath(room.workspace_path, payload.path);
      const stat = await fs.stat(resolvedPath);
      if (!stat.isFile()) {
        sendJson(res, 400, { error: 'Requested path is not a file' });
        return true;
      }

      const existing = getAgentRoomFileReview(room.id, payload.path);
      if (payload.status === 'promoted' && existing?.status !== 'approved') {
        sendJson(res, 400, { error: 'Only approved files can be promoted' });
        return true;
      }

      const review = upsertAgentRoomFileReview(room.id, payload.path, {
        status: payload.status,
        summary: payload.summary,
        updated_by: req.user.username || req.user.display_name || userId,
      });

      saveAgentRoomLog(room.id, 'system', 'info', `Updated review gate for ${payload.path}`, {
        path: payload.path,
        review_status: payload.status,
      });

      sendJson(res, 200, { review });
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Failed to update file review state' });
    }
    return true;
  }

  const fileDownloadMatch = path.match(/^\/api\/agent-rooms\/([^/]+)\/file\/download$/);
  if (fileDownloadMatch && req.method === 'GET') {
    const room = getAccessibleRoomOrReject(fileDownloadMatch[1], userId, res);
    if (!room) return true;

    try {
      const filePath = url.searchParams.get('path') || '';
      if (!filePath) {
        sendJson(res, 400, { error: 'path is required' });
        return true;
      }

      const resolvedPath = safePath(room.workspace_path, filePath);
      const stat = await fs.stat(resolvedPath);
      if (!stat.isFile()) {
        sendJson(res, 400, { error: 'Requested path is not a file' });
        return true;
      }

      const buffer = await fs.readFile(resolvedPath);
      res.writeHead(200, {
        'Content-Type': getDownloadMimeType(filePath),
        'Content-Length': buffer.byteLength,
        'Content-Disposition': `attachment; filename="${basename(filePath).replace(/[^a-zA-Z0-9._-]+/g, '_') || 'workspace-file'}"`,
      });
      res.end(buffer);
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Failed to download file' });
    }
    return true;
  }

  const pythonRunMatch = path.match(/^\/api\/agent-rooms\/([^/]+)\/python\/run$/);
  if (pythonRunMatch && req.method === 'POST') {
    const room = getAccessibleRoomOrReject(pythonRunMatch[1], userId, res);
    if (!room) return true;

    try {
      const body = await readBody(req);
      const filePath = String(body.path || '').trim();
      if (!filePath) {
        sendJson(res, 400, { error: 'path is required' });
        return true;
      }

      const args = Array.isArray(body.args) ? body.args : [];
      const result = await runWorkspacePythonFile(room.workspace_path, filePath, args);
      saveAgentRoomLog(room.id, 'system', result.exitCode === 0 ? 'info' : 'error', `Executed python ${filePath}`, {
        tool: 'run_python',
        path: filePath,
        exit_code: result.exitCode,
      });
      sendJson(res, 200, { result });
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Failed to run python file' });
    }
    return true;
  }

  const fileWriteMatch = path.match(/^\/api\/agent-rooms\/([^/]+)\/files\/write$/);
  if (fileWriteMatch && req.method === 'POST') {
    const room = getAccessibleRoomOrReject(fileWriteMatch[1], userId, res);
    if (!room) return true;

    try {
      const body = await readBody(req);
      const result = await writeFile(room.workspace_path, String(body.path || ''), String(body.content || ''));
      saveAgentRoomLog(room.id, 'user', 'info', `Manual write to ${result.path}`);
      sendJson(res, 200, { result });
    } catch (error) {
      sendJson(res, 400, { error: 'Failed to write file' });
    }
    return true;
  }

  const fileUpdateMatch = path.match(/^\/api\/agent-rooms\/([^/]+)\/files\/update$/);
  if (fileUpdateMatch && req.method === 'POST') {
    const room = getAccessibleRoomOrReject(fileUpdateMatch[1], userId, res);
    if (!room) return true;

    try {
      const body = await readBody(req);
      const result = await updateFile(
        room.workspace_path,
        String(body.path || ''),
        String(body.old_str || ''),
        String(body.new_str || ''),
      );
      saveAgentRoomLog(room.id, 'user', 'info', `Manual update to ${result.path}`);
      sendJson(res, 200, { result });
    } catch (error) {
      sendJson(res, 400, { error: 'Failed to update file' });
    }
    return true;
  }

  const downloadMatch = path.match(/^\/api\/agent-rooms\/([^/]+)\/download$/);
  if (downloadMatch && req.method === 'GET') {
    const room = getAccessibleRoomOrReject(downloadMatch[1], userId, res);
    if (!room) return true;

    streamWorkspaceZip(room.workspace_path, room.name, res);
    return true;
  }

  // ── Workspace Snapshots ────────────────────────────────────────

  const snapshotsMatch = path.match(/^\/api\/agent-rooms\/([^/]+)\/snapshots$/);
  if (snapshotsMatch && req.method === 'GET') {
    const room = getAccessibleRoomOrReject(snapshotsMatch[1], userId, res);
    if (!room) return true;
    const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);
    sendJson(res, 200, { snapshots: listSnapshots(room.id, limit) });
    return true;
  }

  if (snapshotsMatch && req.method === 'POST') {
    const room = getAccessibleRoomOrReject(snapshotsMatch[1], userId, res);
    if (!room) return true;
    try {
      const body = await readBody(req);
      const label = String(body.label || '').trim();
      if (!label || label.length > 120) {
        sendJson(res, 400, { error: 'Label is required (max 120 chars)' });
        return true;
      }
      const description = String(body.description || '').trim().slice(0, 500);
      // Collect current workspace file manifest
      const files = await listFiles(room.workspace_path, '.');
      const fileList = (files || []).map(f => ({ path: f.name || f.path, size: f.size || 0 }));
      const snapshot = createSnapshot(room.id, label, description, fileList, req.user.username || userId);
      saveAgentRoomLog(room.id, 'system', 'info', `Snapshot created: ${label}`, { snapshot_id: snapshot?.id });
      sendJson(res, 201, { snapshot });
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Failed to create snapshot' });
    }
    return true;
  }

  const snapshotDetailMatch = path.match(/^\/api\/agent-rooms\/([^/]+)\/snapshots\/([^/]+)$/);
  if (snapshotDetailMatch && req.method === 'GET') {
    const room = getAccessibleRoomOrReject(snapshotDetailMatch[1], userId, res);
    if (!room) return true;
    const snapshot = getSnapshot(room.id, snapshotDetailMatch[2]);
    if (!snapshot) { sendJson(res, 404, { error: 'Snapshot not found' }); return true; }
    sendJson(res, 200, { snapshot });
    return true;
  }

  if (snapshotDetailMatch && req.method === 'DELETE') {
    const room = getAccessibleRoomOrReject(snapshotDetailMatch[1], userId, res);
    if (!room) return true;
    const deleted = deleteSnapshot(room.id, snapshotDetailMatch[2]);
    if (!deleted) { sendJson(res, 404, { error: 'Snapshot not found' }); return true; }
    sendJson(res, 200, { ok: true });
    return true;
  }

  // ── Skills: global catalog ─────────────────────────────────────
  if (path === '/api/skills' && req.method === 'GET') {
    const skills = await listAvailableSkills();
    sendJson(res, 200, { skills }, { 'Cache-Control': 'public, max-age=600' });
    return true;
  }

  const skillDetailMatch = path.match(/^\/api\/skills\/([^/]+)$/);
  if (skillDetailMatch && req.method === 'GET') {
    const skill = await getSkillContent(skillDetailMatch[1]);
    if (!skill) { sendJson(res, 404, { error: 'Skill not found' }); return true; }
    sendJson(res, 200, { skill: { id: skillDetailMatch[1], ...skill } });
    return true;
  }

  const skillDataMatch = path.match(/^\/api\/skills\/([^/]+)\/data\/([^/]+)$/);
  if (skillDataMatch && req.method === 'GET') {
    const data = await readSkillDataFile(skillDataMatch[1], skillDataMatch[2]);
    if (data === null) { sendJson(res, 404, { error: 'Data file not found' }); return true; }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(data);
    return true;
  }

  // ── Skills: room-level assignment ──────────────────────────────
  const roomSkillsMatch = path.match(/^\/api\/agent-rooms\/([^/]+)\/skills$/);
  if (roomSkillsMatch && req.method === 'GET') {
    const room = getAccessibleRoomOrReject(roomSkillsMatch[1], userId, res);
    if (!room) return true;
    const assigned = listRoomSkills(room.id);
    // Enrich with skill metadata
    const catalog = await listAvailableSkills();
    const catalogMap = Object.fromEntries(catalog.map((s) => [s.id, s]));
    const skills = assigned.map((row) => ({
      ...row,
      ...(catalogMap[row.skill_id] || { name: row.skill_id, description: '' }),
    }));
    sendJson(res, 200, { skills });
    return true;
  }

  if (roomSkillsMatch && req.method === 'POST') {
    const room = getAccessibleRoomOrReject(roomSkillsMatch[1], userId, res);
    if (!room) return true;
    const body = await readBody(req);
    const { skillId } = body;
    if (!skillId) { sendJson(res, 400, { error: 'skillId required' }); return true; }
    // Verify skill exists
    const skill = await getSkillContent(skillId);
    if (!skill) { sendJson(res, 404, { error: 'Skill not found in catalog' }); return true; }
    addRoomSkill(room.id, skillId, userId);
    sendJson(res, 200, { ok: true });
    return true;
  }

  const roomSkillDetailMatch = path.match(/^\/api\/agent-rooms\/([^/]+)\/skills\/([^/]+)$/);
  if (roomSkillDetailMatch && req.method === 'DELETE') {
    const room = getAccessibleRoomOrReject(roomSkillDetailMatch[1], userId, res);
    if (!room) return true;
    const removed = removeRoomSkill(room.id, roomSkillDetailMatch[2]);
    if (!removed) { sendJson(res, 404, { error: 'Skill not assigned to this room' }); return true; }
    sendJson(res, 200, { ok: true });
    return true;
  }

  // ── Rework Decision ──────────────────────────────────────────
  // User responds to a rework decision prompt from the quality gate.
  const reworkDecisionMatch = path.match(/^\/api\/agent-rooms\/([^/]+)\/rework-decision$/);
  if (reworkDecisionMatch && req.method === 'POST') {
    const room = getAccessibleRoomOrReject(reworkDecisionMatch[1], userId, res);
    if (!room) return true;

    try {
      const body = await readBody(req);
      const decision = String(body?.decision || '').trim().toLowerCase();
      if (!['continue', 'accept', 'stop'].includes(decision)) {
        sendJson(res, 400, { error: 'Decision must be "continue", "accept", or "stop".' });
        return true;
      }

      agentRoomOrchestrator.resolveReworkDecision(room.id, decision);

      // Post a system message so the decision is visible in chat
      const labels = { continue: '🔄 User chose to continue rework', accept: '✅ User accepted current implementation', stop: '⏹️ User stopped the workflow' };
      saveAgentRoomMessage(room.id, 'user', req.user.username, labels[decision], 'system');
      broadcastAgentRoomEvent(room.id, 'agent_room:message', {
        message: {
          sender_type: 'user',
          sender_name: req.user.username,
          content: labels[decision],
          event_type: 'system',
          created_at: Math.floor(Date.now() / 1000),
        },
      });

      sendJson(res, 200, { ok: true, decision });
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Failed to process rework decision' });
    }
    return true;
  }

  return false;
}
