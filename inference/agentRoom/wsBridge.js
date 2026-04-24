import { WebSocketServer } from 'ws';
import { encode as msgpackEncode } from '@msgpack/msgpack';

import { verifyAccessToken } from '../auth/auth.js';
import { canAccessAgentRoom, findUserById, getAgentRoom } from '../db/database.js';

const agentRoomWss = new WebSocketServer({
  noServer: true,
  maxPayload: 128 * 1024,
  handleProtocols(protocols) {
    // Prefer msgpack if client supports it, otherwise no subprotocol
    if (protocols.has(MSGPACK_SUBPROTOCOL)) return MSGPACK_SUBPROTOCOL;
    return false;
  },
});

// ── MessagePack Protocol ───────────────────────────────────────
// Clients that request the 'msgpack' subprotocol receive binary MessagePack
// frames instead of JSON text frames. This reduces payload size ~40% and
// encode/decode time ~2-5× compared to JSON.stringify/parse.
const MSGPACK_SUBPROTOCOL = 'msgpack';
const roomSockets = new Map();
const roomUserSocketCounts = new Map();
const DASHBOARD_ORIGIN = process.env.DASHBOARD_ORIGIN || '';
const NGROK_DOMAIN = process.env.NGROK_DOMAIN || '';
const MAX_ROOM_SOCKETS_PER_USER = 3;

function isAllowedDashboardOrigin(origin) {
  if (!origin) return true;

  const allowedOrigins = [];

  if (DASHBOARD_ORIGIN) {
    allowedOrigins.push(
      ...DASHBOARD_ORIGIN.split(',').map((v) => v.trim()).filter(Boolean),
    );
  }

  // Auto-allow ngrok domain when configured
  if (NGROK_DOMAIN) {
    allowedOrigins.push(`https://${NGROK_DOMAIN}`, `http://${NGROK_DOMAIN}`);
  }

  if (allowedOrigins.length > 0) {
    return allowedOrigins.includes(origin);
  }

  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
}

function wsSend(ws, payload) {
  if (ws.readyState !== ws.OPEN) return;
  try {
    if (ws._useMsgpack) {
      ws.send(msgpackEncode(payload));
    } else {
      ws.send(JSON.stringify(payload));
    }
  } catch {
    // Ignore broken sockets.
  }
}

function addSocket(roomId, ws) {
  const set = roomSockets.get(roomId) || new Set();
  set.add(ws);
  roomSockets.set(roomId, set);
}

function removeSocket(roomId, ws) {
  const set = roomSockets.get(roomId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) {
    roomSockets.delete(roomId);
  }

  const countKey = `${roomId}:${ws._agentRoomUserId || ''}`;
  const count = roomUserSocketCounts.get(countKey) || 0;
  if (count <= 1) {
    roomUserSocketCounts.delete(countKey);
  } else {
    roomUserSocketCounts.set(countKey, count - 1);
  }
}

export function broadcastAgentRoomEvent(roomId, type, payload = {}) {
  const sockets = roomSockets.get(roomId);
  if (!sockets || sockets.size === 0) return;

  const data = { type, room_id: roomId, ...payload };

  // Pre-encode once per format to avoid re-encoding per socket
  let jsonMsg = null;
  let binaryMsg = null;

  for (const ws of sockets) {
    if (ws.readyState !== ws.OPEN) {
      removeSocket(roomId, ws);
      continue;
    }
    try {
      if (ws._useMsgpack) {
        if (!binaryMsg) binaryMsg = msgpackEncode(data);
        ws.send(binaryMsg);
      } else {
        if (!jsonMsg) jsonMsg = JSON.stringify(data);
        ws.send(jsonMsg);
      }
    } catch {
      removeSocket(roomId, ws);
    }
  }
}

agentRoomWss.on('connection', (ws, req, client) => {
  const roomId = client.roomId;
  const countKey = `${roomId}:${client.user.id}`;
  const currentCount = roomUserSocketCounts.get(countKey) || 0;
  if (currentCount >= MAX_ROOM_SOCKETS_PER_USER) {
    ws.close(1008, 'Too many Agent Room connections for this user.');
    return;
  }

  // Detect MessagePack subprotocol negotiation (set by handleProtocols)
  ws._useMsgpack = ws.protocol === MSGPACK_SUBPROTOCOL;
  ws._agentRoomUserId = client.user.id;
  roomUserSocketCounts.set(countKey, currentCount + 1);
  addSocket(roomId, ws);

  wsSend(ws, {
    type: 'agent_room:connected',
    room_id: roomId,
    user: {
      id: client.user.id,
      username: client.user.username,
      display_name: client.user.display_name,
    },
  });

  // Mark alive on pong
  ws._isAlive = true;
  ws.on('pong', () => { ws._isAlive = true; });

  const cleanup = () => removeSocket(roomId, ws);
  ws.on('close', cleanup);
  ws.on('error', cleanup);
});

// Ping/pong heartbeat — detect dead connections every 30s
const WS_HEARTBEAT_INTERVAL = 30_000;
const _heartbeatTimer = setInterval(() => {
  for (const ws of agentRoomWss.clients) {
    if (ws._isAlive === false) {
      ws.terminate();
      continue;
    }
    ws._isAlive = false;
    ws.ping();
  }
}, WS_HEARTBEAT_INTERVAL);
_heartbeatTimer.unref(); // Don't prevent process exit

export function handleAgentRoomUpgrade(req, socket, head) {
  const url = new URL(req.url, 'http://localhost');
  const roomId = url.searchParams.get('room_id') || '';
  const token = url.searchParams.get('token') || '';
  const origin = req.headers.origin || '';

  if (!roomId || !token) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return false;
  }

  if (!isAllowedDashboardOrigin(origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return false;
  }

  const payload = verifyAccessToken(token);
  if (!payload) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return false;
  }

  const user = findUserById(payload.sub);
  if (!user) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return false;
  }

  const room = getAgentRoom(roomId);
  if (!room || !canAccessAgentRoom(room, user.id)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return false;
  }

  agentRoomWss.handleUpgrade(req, socket, head, (ws) => {
    agentRoomWss.emit('connection', ws, req, { user, roomId });
  });

  return true;
}