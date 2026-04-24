import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import {
  createAgentRoomWithDefaults,
  getAgentRoomByProjectRoomId,
  uuid,
} from '../db/database.js';
import { buildDefaultAgents } from './defaultAgents.js';
import { ensureWorkspace } from './fileTools.js';
import { ensureWorkspacePythonEnv } from './workspaceRuntime.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const AGENT_WORKSPACES_ROOT = join(PROJECT_ROOT, 'data', 'agent-workspaces');

async function seedWorkspace(room, agents) {
  ensureWorkspace(AGENT_WORKSPACES_ROOT);
  ensureWorkspace(room.workspace_path);
  await fs.mkdir(join(room.workspace_path, 'src'), { recursive: true });
  await fs.mkdir(join(room.workspace_path, 'notes'), { recursive: true });

  const readmePath = join(room.workspace_path, 'README.md');
  await fs.writeFile(readmePath, [
    `# ${room.name}`,
    '',
    room.description || 'Linked AI Agent project room workspace.',
    '',
    '## Agents',
    ...agents.map((agent) => `- @${agent.name}: ${agent.role}`),
    '',
    'Use mentions like `@planner`, `@coder`, and `@reviewer` in this room.',
    '',
  ].join('\n'), 'utf-8');

  await ensureWorkspacePythonEnv(room.workspace_path);
}

export async function ensureProjectAgentRoom(projectRoom) {
  const existing = getAgentRoomByProjectRoomId(projectRoom.id);
  if (existing) return existing;

  const roomId = uuid();
  const workspaceId = uuid();
  const workspacePath = join(AGENT_WORKSPACES_ROOT, workspaceId);
  const agents = buildDefaultAgents(uuid);

  createAgentRoomWithDefaults({
    id: roomId,
    owner_id: projectRoom.owner_id,
    project_room_id: projectRoom.id,
    name: projectRoom.name,
    description: projectRoom.description || '',
    workspace_id: workspaceId,
    workspace_path: workspacePath,
  }, agents);

  const created = getAgentRoomByProjectRoomId(projectRoom.id);
  await seedWorkspace(created, agents);
  return created;
}