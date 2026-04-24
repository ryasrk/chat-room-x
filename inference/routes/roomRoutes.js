/**
 * Room Routes — /api/rooms/*
 * Project room CRUD, membership, and messaging.
 */

import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  uuid, createRoomWithOwner, getProjectRoom, getUserRooms, deleteProjectRoom,
  getRoomMembers, isRoomMember, joinRoomByInvite, leaveRoom,
  saveRoomMessage, getRoomMessages, getRoomMemberRole, getAgentRoomByProjectRoomId, deleteAgentRoom,
} from '../db/database.js';
import { ensureProjectAgentRoom } from '../agentRoom/projectRoomLink.js';
import { listAgentRoomAgents, listAgentRoomLogs, listAgentRoomMessages, listAgentRoomTasks } from '../db/database.js';
import { sendJson, readBody } from './apiRouter.js';

/** Generate a weak ETag from message count + last message timestamp */
function messagesEtag(messages) {
  const last = messages.length > 0 ? messages[messages.length - 1].created_at || messages[messages.length - 1].id : '0';
  return `W/"msgs-${messages.length}-${last}"`;
}
import { randomBytes } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const AGENT_WORKSPACES_ROOT = join(PROJECT_ROOT, 'data', 'agent-workspaces');

function generateInviteCode() {
  return randomBytes(4).toString('hex'); // 8-char hex code
}

async function removeAgentWorkspace(workspacePath) {
  if (!workspacePath || typeof workspacePath !== 'string') return;
  if (!workspacePath.startsWith(AGENT_WORKSPACES_ROOT)) return;
  await fs.rm(workspacePath, { recursive: true, force: true });
}

function sanitizeLinkedAgentRoom(room) {
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
    project_room_id: room.project_room_id,
  };
}

/**
 * @param {string} path
 * @param {URL} url
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @returns {Promise<boolean>}
 */
export async function handleRoomRoute(path, url, req, res) {
  const userId = req.user.id;

  // GET /api/rooms — list user's rooms
  if (path === '/api/rooms' && req.method === 'GET') {
    const rooms = getUserRooms(userId);
    sendJson(res, 200, { rooms });
    return true;
  }

  // POST /api/rooms — create a new room
  if (path === '/api/rooms' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { name, description, category } = body;

      if (!name || name.trim().length < 2) {
        sendJson(res, 400, { error: 'Room name must be at least 2 characters' });
        return true;
      }

      const validCategories = ['team', 'ai-agents'];
      const roomCategory = validCategories.includes(category) ? category : 'team';

      const id = uuid();
      const inviteCode = generateInviteCode();
      createRoomWithOwner(id, name.trim(), description || '', roomCategory, userId, inviteCode);

      const room = getProjectRoom(id);
      sendJson(res, 201, { room: { ...room, role: 'owner', member_count: 1 } });
    } catch (err) {
      sendJson(res, 400, { error: err.message || 'Failed to create room' });
    }
    return true;
  }

  // POST /api/rooms/join — join a room by invite code
  if (path === '/api/rooms/join' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { invite_code } = body;

      if (!invite_code) {
        sendJson(res, 400, { error: 'invite_code is required' });
        return true;
      }

      const result = joinRoomByInvite(invite_code.trim(), userId);
      if (result.error && !result.room) {
        sendJson(res, 404, { error: result.error });
        return true;
      }
      if (result.error && result.room) {
        // Already a member — return the room anyway
        sendJson(res, 200, { room: result.room, already_member: true });
        return true;
      }

      const room = getProjectRoom(result.room.id);
      const members = getRoomMembers(result.room.id);
      sendJson(res, 200, { room, members, joined: true });
    } catch (err) {
      sendJson(res, 400, { error: err.message || 'Failed to join room' });
    }
    return true;
  }

  // GET /api/rooms/:id — get room details
  const roomMatch = path.match(/^\/api\/rooms\/([^/]+)$/);
  if (roomMatch && req.method === 'GET') {
    const roomId = roomMatch[1];
    if (!isRoomMember(roomId, userId)) {
      sendJson(res, 403, { error: 'Not a member of this room' });
      return true;
    }
    const room = getProjectRoom(roomId);
    if (!room) {
      sendJson(res, 404, { error: 'Room not found' });
      return true;
    }
    const members = getRoomMembers(roomId);
    const role = getRoomMemberRole(roomId, userId);
    sendJson(res, 200, { room, members, role });
    return true;
  }

  // GET /api/rooms/:id/agent-room — open linked AI agent workspace for an AI Agent room
  const agentRoomMatch = path.match(/^\/api\/rooms\/([^/]+)\/agent-room$/);
  if (agentRoomMatch && req.method === 'GET') {
    const roomId = agentRoomMatch[1];
    if (!isRoomMember(roomId, userId)) {
      sendJson(res, 403, { error: 'Not a member of this room' });
      return true;
    }

    const projectRoom = getProjectRoom(roomId);
    if (!projectRoom) {
      sendJson(res, 404, { error: 'Room not found' });
      return true;
    }
    if (projectRoom.category !== 'ai-agents') {
      sendJson(res, 400, { error: 'This room is not an AI Agent room' });
      return true;
    }

    try {
      const agentRoom = await ensureProjectAgentRoom(projectRoom);
      sendJson(res, 200, {
        room: sanitizeLinkedAgentRoom(agentRoom),
        agents: listAgentRoomAgents(agentRoom.id),
        messages: listAgentRoomMessages(agentRoom.id, 100),
        logs: listAgentRoomLogs(agentRoom.id, 100),
        tasks: listAgentRoomTasks(agentRoom.id),
      });
    } catch (err) {
      console.error('[agent-room] Failed to open AI Agent room:', err);
      sendJson(res, 500, { error: 'Failed to open AI Agent room', detail: err.message });
    }
    return true;
  }

  // DELETE /api/rooms/:id — delete room (owner only)
  const delMatch = path.match(/^\/api\/rooms\/([^/]+)$/);
  if (delMatch && req.method === 'DELETE') {
    const roomId = delMatch[1];
    const linkedAgentRoom = getAgentRoomByProjectRoomId(roomId);
    const result = deleteProjectRoom(roomId, userId);
    if (result.changes === 0) {
      sendJson(res, 403, { error: 'Not the room owner or room not found' });
      return true;
    }

    if (linkedAgentRoom) {
      deleteAgentRoom(linkedAgentRoom.id, userId);
      removeAgentWorkspace(linkedAgentRoom.workspace_path).catch((err) => {
        console.error('[room-delete] Failed to remove linked agent workspace:', err);
      });
    }

    sendJson(res, 200, { ok: true });
    return true;
  }

  // POST /api/rooms/:id/leave — leave a room
  const leaveMatch = path.match(/^\/api\/rooms\/([^/]+)\/leave$/);
  if (leaveMatch && req.method === 'POST') {
    const result = leaveRoom(leaveMatch[1], userId);
    if (result.error) {
      sendJson(res, 400, { error: result.error });
      return true;
    }
    sendJson(res, 200, { ok: true });
    return true;
  }

  // GET /api/rooms/:id/members — list room members
  const membersMatch = path.match(/^\/api\/rooms\/([^/]+)\/members$/);
  if (membersMatch && req.method === 'GET') {
    const roomId = membersMatch[1];
    if (!isRoomMember(roomId, userId)) {
      sendJson(res, 403, { error: 'Not a member of this room' });
      return true;
    }
    const members = getRoomMembers(roomId);
    sendJson(res, 200, { members });
    return true;
  }

  // GET /api/rooms/:id/messages — get room messages
  const msgsMatch = path.match(/^\/api\/rooms\/([^/]+)\/messages$/);
  if (msgsMatch && req.method === 'GET') {
    const roomId = msgsMatch[1];
    if (!isRoomMember(roomId, userId)) {
      sendJson(res, 403, { error: 'Not a member of this room' });
      return true;
    }
    const limit = parseInt(url.searchParams.get('limit') || '50', 10);
    const before = url.searchParams.get('before') || null;
    const messages = getRoomMessages(roomId, Math.min(limit, 100), before ? parseInt(before, 10) : null);

    // ETag-based conditional response — avoid re-sending unchanged data
    const etag = messagesEtag(messages);
    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch && ifNoneMatch === etag) {
      res.writeHead(304, { 'ETag': etag });
      res.end();
      return true;
    }

    sendJson(res, 200, { messages }, { 'ETag': etag, 'Cache-Control': 'private, no-cache' });
    return true;
  }

  // POST /api/rooms/:id/messages — send a message to a room
  const sendMsgMatch = path.match(/^\/api\/rooms\/([^/]+)\/messages$/);
  if (sendMsgMatch && req.method === 'POST') {
    const roomId = sendMsgMatch[1];
    if (!isRoomMember(roomId, userId)) {
      sendJson(res, 403, { error: 'Not a member of this room' });
      return true;
    }

    try {
      const body = await readBody(req);
      const { content, message_type } = body;

      if (!content || !content.trim()) {
        sendJson(res, 400, { error: 'content is required' });
        return true;
      }

      const msgId = saveRoomMessage(roomId, userId, content.trim(), message_type || 'text');
      sendJson(res, 201, {
        id: msgId,
        room_id: roomId,
        user_id: userId,
        username: req.user.username,
        display_name: req.user.display_name,
        content: content.trim(),
        message_type: message_type || 'text',
        created_at: Math.floor(Date.now() / 1000),
      });
    } catch (err) {
      sendJson(res, 400, { error: err.message || 'Failed to send message' });
    }
    return true;
  }

  return false;
}
