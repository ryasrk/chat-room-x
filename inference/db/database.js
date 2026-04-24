/**
 * Tenrary-X Database Layer
 * SQLite via bun:sqlite — native, zero-overhead, synchronous, WAL mode, parameterized queries only.
 * Migrated from better-sqlite3 for 3-6× faster read performance.
 */

import { Database } from 'bun:sqlite';
import { readFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { LRUCache } from './lruCache.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const DATA_DIR = join(PROJECT_ROOT, 'data');
const DB_PATH = join(DATA_DIR, 'tenrary.db');
const SCHEMA_PATH = join(__dirname, 'schema.sql');

// Ensure data directory exists
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

// ── Initialize Database ────────────────────────────────────────
const db = new Database(DB_PATH, { create: true });
db.run('PRAGMA journal_mode = WAL');
db.run('PRAGMA synchronous = NORMAL');   // Safe with WAL, 2-3× faster writes
db.run('PRAGMA foreign_keys = ON');
db.run('PRAGMA busy_timeout = 5000');
db.run('PRAGMA cache_size = -64000');    // 64 MB page cache (default ~2 MB)
db.run('PRAGMA mmap_size = 268435456');  // 256 MB memory-mapped I/O
db.run('PRAGMA temp_store = MEMORY');    // Temp tables in RAM instead of disk

// ── Read-Only Connection ───────────────────────────────────────
// WAL mode allows concurrent readers. A separate read-only connection
// avoids blocking writes and benefits from its own page cache.
const readDb = new Database(DB_PATH, { readonly: true });
readDb.run('PRAGMA journal_mode = WAL');
readDb.run('PRAGMA cache_size = -32000');   // 32 MB read cache
readDb.run('PRAGMA mmap_size = 268435456');
readDb.run('PRAGMA temp_store = MEMORY');

// ── LRU Caches (hot-path reads) ───────────────────────────────
const userCache = new LRUCache(500, 120_000);       // Users: 2 min TTL
const conversationCache = new LRUCache(200, 60_000); // Conversations: 1 min TTL
const roomCache = new LRUCache(100, 60_000);         // Rooms: 1 min TTL

const agentRoomColumns = db.query(`PRAGMA table_info(agent_rooms)`).all();
if (agentRoomColumns.length > 0 && !agentRoomColumns.some((column) => column.name === 'project_room_id')) {
  db.exec('ALTER TABLE agent_rooms ADD COLUMN project_room_id TEXT REFERENCES project_rooms(id) ON DELETE CASCADE');
}
if (agentRoomColumns.length > 0 && !agentRoomColumns.some((column) => column.name === 'orchestration_mode')) {
  db.exec("ALTER TABLE agent_rooms ADD COLUMN orchestration_mode TEXT DEFAULT 'reactive'");
}
if (agentRoomColumns.length > 0 && !agentRoomColumns.some((column) => column.name === 'autonomy_level')) {
  db.exec('ALTER TABLE agent_rooms ADD COLUMN autonomy_level INTEGER DEFAULT 2');
}

// Migrate agent_room_agents: add router_config_json column for dual-model (xa/xb) architecture
const agentColumns = db.query('PRAGMA table_info(agent_room_agents)').all();
if (agentColumns.length > 0 && !agentColumns.some((c) => c.name === 'router_config_json')) {
  db.exec("ALTER TABLE agent_room_agents ADD COLUMN router_config_json TEXT DEFAULT '{}'");
}

// Backfill: set all agents with empty router_config to use cloud xa router
// This ensures existing rooms benefit from the xa/xb dual-model architecture
// Only run if the table already exists (fresh DB will be created by schema.sql below)
if (agentColumns.length > 0) {
  const routerModel = process.env.ENOWXAI_ROUTER_MODEL || 'gemini-2.5-flash';
  const defaultRouterConfig = JSON.stringify({
    provider: 'enowxai',
    model: routerModel,
    max_tokens: 512,
    temperature: 0.1,
  });
  const backfilled = db.run(
    `UPDATE agent_room_agents SET router_config_json = ? WHERE router_config_json = '{}' OR router_config_json IS NULL OR router_config_json = ''`,
    [defaultRouterConfig],
  );
  if (backfilled.changes > 0) {
    console.log(`[db] Backfilled ${backfilled.changes} agent(s) with default xa router config (cloud: ${routerModel})`);
  }
}

// Migrate agent_room_messages: add artifacts column
const msgColumns = db.query('PRAGMA table_info(agent_room_messages)').all();
if (msgColumns.length > 0 && !msgColumns.some((c) => c.name === 'artifacts')) {
  db.exec('ALTER TABLE agent_room_messages ADD COLUMN artifacts TEXT DEFAULT NULL');
}

// Run schema
const schema = readFileSync(SCHEMA_PATH, 'utf-8');
db.exec(schema);
db.exec('CREATE INDEX IF NOT EXISTS idx_agent_rooms_project_room_id ON agent_rooms(project_room_id)');

/** @returns {string} A new UUID */
export function uuid() {
  return randomUUID();
}

// ── Prepared Statements ────────────────────────────────────────

// Users
const stmts = {
  createUser: db.query(`
    INSERT INTO users (id, username, email, password_hash, display_name)
    VALUES (?, ?, ?, ?, ?)
  `),
  findUserByUsername: readDb.query(`SELECT * FROM users WHERE username = ?`),
  findUserByEmail: readDb.query(`SELECT * FROM users WHERE email = ?`),
  findUserById: readDb.query(`SELECT * FROM users WHERE id = ?`),
  findUserPublic: readDb.query(`SELECT id, username, display_name, avatar_url, created_at FROM users WHERE id = ?`),
  updateDisplayName: db.query(`UPDATE users SET display_name = ?, updated_at = unixepoch() WHERE id = ?`),
  updateAvatar: db.query(`UPDATE users SET avatar_url = ?, updated_at = unixepoch() WHERE id = ?`),
  updatePassword: db.query(`UPDATE users SET password_hash = ?, updated_at = unixepoch() WHERE id = ?`),

  // Refresh tokens
  saveRefreshToken: db.query(`
    INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at)
    VALUES (?, ?, ?, ?)
  `),
  findRefreshToken: readDb.query(`SELECT * FROM refresh_tokens WHERE token_hash = ? AND revoked = 0`),
  revokeRefreshToken: db.query(`UPDATE refresh_tokens SET revoked = 1 WHERE id = ?`),
  revokeAllUserTokens: db.query(`UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?`),
  cleanupExpiredTokens: db.query(`DELETE FROM refresh_tokens WHERE expires_at < unixepoch() OR revoked = 1`),

  // Conversations
  saveConversation: db.query(`
    INSERT INTO conversations (id, user_id, title, messages, folder_id, updated_at)
    VALUES (?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      messages = excluded.messages,
      folder_id = excluded.folder_id,
      updated_at = unixepoch()
  `),
  getConversation: readDb.query(`SELECT * FROM conversations WHERE id = ?`),
  getUserConversations: readDb.query(`
    SELECT id, user_id, title, folder_id, is_shared, created_at, updated_at
    FROM conversations WHERE user_id = ? ORDER BY updated_at DESC
  `),
  deleteConversation: db.query(`DELETE FROM conversations WHERE id = ? AND user_id = ?`),
  updateConversationShare: db.query(`
    UPDATE conversations SET is_shared = ?, share_token = ? WHERE id = ?
  `),

  // Shared chats
  createSharedChat: db.query(`
    INSERT INTO shared_chats (id, conversation_id, shared_by, share_token, access_level, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  getSharedChat: readDb.query(`
    SELECT sc.*, c.title, c.messages, u.username AS shared_by_username
    FROM shared_chats sc
    JOIN conversations c ON c.id = sc.conversation_id
    JOIN users u ON u.id = sc.shared_by
    WHERE sc.share_token = ?
  `),
  deleteSharedChat: db.query(`DELETE FROM shared_chats WHERE id = ? AND shared_by = ?`),
  getConversationShares: readDb.query(`SELECT * FROM shared_chats WHERE conversation_id = ?`),
  cleanupExpiredShares: db.query(`DELETE FROM shared_chats WHERE expires_at IS NOT NULL AND expires_at < unixepoch()`),

  // Project rooms
  createProjectRoom: db.query(`
    INSERT INTO project_rooms (id, name, description, category, owner_id, invite_code)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  getProjectRoom: readDb.query(`SELECT * FROM project_rooms WHERE id = ?`),
  getRoomByInviteCode: readDb.query(`SELECT * FROM project_rooms WHERE invite_code = ? AND is_active = 1`),
  getUserRooms: readDb.query(`
    SELECT pr.*, rm.role, rm.joined_at,
      (SELECT COUNT(*) FROM room_members WHERE room_id = pr.id) AS member_count
    FROM project_rooms pr
    JOIN room_members rm ON rm.room_id = pr.id
    WHERE rm.user_id = ? AND pr.is_active = 1
    ORDER BY rm.joined_at DESC
  `),
  deleteProjectRoom: db.query(`UPDATE project_rooms SET is_active = 0 WHERE id = ? AND owner_id = ?`),

  // Room members
  addRoomMember: db.query(`
    INSERT OR IGNORE INTO room_members (room_id, user_id, role) VALUES (?, ?, ?)
  `),
  removeRoomMember: db.query(`DELETE FROM room_members WHERE room_id = ? AND user_id = ?`),
  getRoomMembers: readDb.query(`
    SELECT rm.*, u.username, u.display_name, u.avatar_url
    FROM room_members rm
    JOIN users u ON u.id = rm.user_id
    WHERE rm.room_id = ?
    ORDER BY rm.joined_at ASC
  `),
  isRoomMember: readDb.query(`SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?`),
  getRoomMemberRole: readDb.query(`SELECT role FROM room_members WHERE room_id = ? AND user_id = ?`),

  // Room messages
  saveRoomMessage: db.query(`
    INSERT INTO room_messages (id, room_id, user_id, content, message_type)
    VALUES (?, ?, ?, ?, ?)
  `),
  getRoomMessages: readDb.query(`
    SELECT rm.*, u.username, u.display_name, u.avatar_url
    FROM room_messages rm
    JOIN users u ON u.id = rm.user_id
    WHERE rm.room_id = ? AND rm.created_at < ?
    ORDER BY rm.created_at DESC
    LIMIT ?
  `),
  getLatestRoomMessages: readDb.query(`
    SELECT rm.*, u.username, u.display_name, u.avatar_url
    FROM room_messages rm
    JOIN users u ON u.id = rm.user_id
    WHERE rm.room_id = ?
    ORDER BY rm.created_at DESC
    LIMIT ?
  `),

  // Agent rooms
  createAgentRoom: db.query(`
    INSERT INTO agent_rooms (
      id, owner_id, project_room_id, name, description, workspace_id, workspace_path, orchestration_mode, autonomy_level
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getAgentRoom: readDb.query(`SELECT * FROM agent_rooms WHERE id = ? AND is_active = 1`),
  getAgentRoomForUser: readDb.query(`SELECT * FROM agent_rooms WHERE id = ? AND owner_id = ? AND is_active = 1`),
  getAgentRoomByProjectRoomId: readDb.query(`
    SELECT * FROM agent_rooms
    WHERE project_room_id = ? AND is_active = 1
  `),
  listAgentRoomsByOwner: readDb.query(`
    SELECT ar.*,
      (SELECT COUNT(*) FROM agent_room_agents ara WHERE ara.room_id = ar.id) AS agent_count,
      (SELECT COUNT(*) FROM agent_room_messages arm WHERE arm.room_id = ar.id) AS message_count
    FROM agent_rooms ar
    WHERE ar.owner_id = ? AND ar.is_active = 1
    ORDER BY ar.updated_at DESC
  `),
  touchAgentRoom: db.query(`UPDATE agent_rooms SET updated_at = unixepoch() WHERE id = ?`),
  updateAgentRoomConfig: db.query(`
    UPDATE agent_rooms
    SET orchestration_mode = ?, autonomy_level = ?, updated_at = unixepoch()
    WHERE id = ?
  `),
  deleteAgentRoom: db.query(`UPDATE agent_rooms SET is_active = 0, updated_at = unixepoch() WHERE id = ? AND owner_id = ?`),

  // Agent room agents
  createAgentRoomAgent: db.query(`
    INSERT INTO agent_room_agents (id, room_id, name, role, model_tier, system_prompt, tools_json, provider_config_json, router_config_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  listAgentRoomAgents: readDb.query(`
    SELECT * FROM agent_room_agents
    WHERE room_id = ?
    ORDER BY created_at ASC
  `),
  getAgentRoomAgent: readDb.query(`
    SELECT * FROM agent_room_agents
    WHERE room_id = ? AND name = ?
  `),
  updateAgentRoomAgentStatus: db.query(`
    UPDATE agent_room_agents
    SET status = ?, updated_at = unixepoch()
    WHERE room_id = ? AND name = ?
  `),
  updateAgentRoomAgent: db.query(`
    UPDATE agent_room_agents
    SET role = ?, model_tier = ?, system_prompt = ?, tools_json = ?, provider_config_json = ?, router_config_json = ?, updated_at = unixepoch()
    WHERE room_id = ? AND name = ?
  `),
  deleteAgentRoomAgent: db.query(`
    DELETE FROM agent_room_agents WHERE room_id = ? AND name = ?
  `),

  // Agent room messages
  saveAgentRoomMessage: db.query(`
    INSERT INTO agent_room_messages (id, room_id, sender_type, sender_name, content, event_type, artifacts)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  listAgentRoomMessages: readDb.query(`
    SELECT * FROM agent_room_messages
    WHERE room_id = ?
    ORDER BY created_at DESC, rowid DESC
    LIMIT ?
  `),

  // Agent room memories
  getAgentRoomMemory: readDb.query(`
    SELECT memory_text, updated_at
    FROM agent_room_memories
    WHERE room_id = ? AND agent_name = ?
  `),
  saveAgentRoomMemory: db.query(`
    INSERT INTO agent_room_memories (room_id, agent_name, memory_text, updated_at)
    VALUES (?, ?, ?, unixepoch())
    ON CONFLICT(room_id, agent_name) DO UPDATE SET
      memory_text = excluded.memory_text,
      updated_at = unixepoch()
  `),
  listAgentRoomMemories: readDb.query(`
    SELECT agent_name, memory_text, updated_at
    FROM agent_room_memories
    WHERE room_id = ?
    ORDER BY updated_at DESC
  `),
  clearAgentRoomMemory: db.query(`
    DELETE FROM agent_room_memories
    WHERE room_id = ? AND agent_name = ?
  `),

  // Agent room token usage
  saveAgentRoomTokenUsage: db.query(`
    INSERT INTO agent_room_token_usage (id, room_id, agent_name, prompt_tokens, completion_tokens, total_tokens, model, provider)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getAgentRoomTokenSummary: readDb.query(`
    SELECT agent_name,
           SUM(prompt_tokens) AS prompt_tokens,
           SUM(completion_tokens) AS completion_tokens,
           SUM(total_tokens) AS total_tokens,
           COUNT(*) AS call_count
    FROM agent_room_token_usage
    WHERE room_id = ?
    GROUP BY agent_name
    ORDER BY total_tokens DESC
  `),
  getAgentRoomTokenHistory: readDb.query(`
    SELECT id, agent_name, prompt_tokens, completion_tokens, total_tokens, model, provider, created_at
    FROM agent_room_token_usage
    WHERE room_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `),

  // Agent room logs
  saveAgentRoomLog: db.query(`
    INSERT INTO agent_room_logs (id, room_id, agent_name, level, message, meta_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  listAgentRoomLogs: readDb.query(`
    SELECT * FROM agent_room_logs
    WHERE room_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `),

  // Agent room tasks
  createAgentRoomTask: db.query(`
    INSERT INTO agent_room_tasks (id, room_id, title, details, status, priority, assignee_name, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  listAgentRoomTasks: readDb.query(`
    SELECT * FROM agent_room_tasks
    WHERE room_id = ?
    ORDER BY
      CASE status
        WHEN 'in_progress' THEN 0
        WHEN 'blocked' THEN 1
        WHEN 'todo' THEN 2
        ELSE 3
      END,
      CASE priority
        WHEN 'high' THEN 0
        WHEN 'medium' THEN 1
        ELSE 2
      END,
      updated_at DESC,
      created_at DESC
  `),
  getAgentRoomTask: readDb.query(`
    SELECT * FROM agent_room_tasks
    WHERE room_id = ? AND id = ?
  `),
  updateAgentRoomTask: db.query(`
    UPDATE agent_room_tasks
    SET title = ?, details = ?, status = ?, priority = ?, assignee_name = ?, updated_at = unixepoch()
    WHERE room_id = ? AND id = ?
  `),

  // Agent room file review gates
  getAgentRoomFileReview: readDb.query(`
    SELECT * FROM agent_room_file_reviews
    WHERE room_id = ? AND file_path = ?
  `),
  upsertAgentRoomFileReview: db.query(`
    INSERT INTO agent_room_file_reviews (room_id, file_path, status, summary, updated_by)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(room_id, file_path) DO UPDATE SET
      status = excluded.status,
      summary = excluded.summary,
      updated_by = excluded.updated_by,
      updated_at = unixepoch()
  `),

  // Workspace snapshots
  createSnapshot: db.query(`
    INSERT INTO agent_room_snapshots (id, room_id, label, description, file_count, total_size, snapshot_data, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  listSnapshots: readDb.query(`
    SELECT id, room_id, label, description, file_count, total_size, created_by, created_at
    FROM agent_room_snapshots
    WHERE room_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `),
  getSnapshot: readDb.query(`
    SELECT * FROM agent_room_snapshots
    WHERE room_id = ? AND id = ?
  `),
  deleteSnapshot: db.query(`
    DELETE FROM agent_room_snapshots
    WHERE room_id = ? AND id = ?
  `),

  // ── Room Skills ──────────────────────────────────────────────
  addRoomSkill: db.query(`
    INSERT OR IGNORE INTO agent_room_skills (id, room_id, skill_id, added_by)
    VALUES (?, ?, ?, ?)
  `),
  removeRoomSkill: db.query(`
    DELETE FROM agent_room_skills WHERE room_id = ? AND skill_id = ?
  `),
  listRoomSkills: readDb.query(`
    SELECT skill_id, added_by, added_at FROM agent_room_skills
    WHERE room_id = ? ORDER BY added_at ASC
  `),
};

// ── Transactions ───────────────────────────────────────────────
const createRoomWithOwner = db.transaction((id, name, description, category, ownerId, inviteCode) => {
  stmts.createProjectRoom.run(id, name, description, category, ownerId, inviteCode);
  stmts.addRoomMember.run(id, ownerId, 'owner');
  stmts.saveRoomMessage.run(uuid(), id, ownerId, `Room "${name}" created`, 'system');
});

const joinRoomByInvite = db.transaction((inviteCode, userId) => {
  const room = stmts.getRoomByInviteCode.get(inviteCode);
  if (!room) return { error: 'Invalid invite code' };

  const existing = stmts.isRoomMember.get(room.id, userId);
  if (existing) return { error: 'Already a member', room };

  stmts.addRoomMember.run(room.id, userId, 'member');
  const user = stmts.findUserById.get(userId);
  stmts.saveRoomMessage.run(uuid(), room.id, userId, `${user?.display_name || user?.username} joined the room`, 'system');
  return { room };
});

const leaveRoom = db.transaction((roomId, userId) => {
  const role = stmts.getRoomMemberRole.get(roomId, userId);
  if (!role) return { error: 'Not a member' };
  if (role.role === 'owner') return { error: 'Owner cannot leave. Transfer ownership or delete the room.' };

  stmts.removeRoomMember.run(roomId, userId);
  const user = stmts.findUserById.get(userId);
  stmts.saveRoomMessage.run(uuid(), roomId, userId, `${user?.display_name || user?.username} left the room`, 'system');
  return { ok: true };
});

const createAgentRoomWithDefaults = db.transaction((room, agents = []) => {
  stmts.createAgentRoom.run(
    room.id,
    room.owner_id,
    room.project_room_id || null,
    room.name,
    room.description || '',
    room.workspace_id,
    room.workspace_path,
    room.orchestration_mode || 'reactive',
    Number.isFinite(Number(room.autonomy_level)) ? Math.floor(Number(room.autonomy_level)) : 2,
  );

  for (const agent of agents) {
    stmts.createAgentRoomAgent.run(
      agent.id,
      room.id,
      agent.name,
      agent.role,
      agent.model_tier,
      agent.system_prompt || '',
      JSON.stringify(agent.tools || []),
      JSON.stringify(agent.provider_config || {}),
      JSON.stringify(agent.router_config || {}),
    );
  }

  stmts.saveAgentRoomMessage.run(uuid(), room.id, 'system', 'system', `Agent room "${room.name}" created`, 'system', null);
});

// ── Exported API ───────────────────────────────────────────────

// Users
export function createUser(id, username, email, passwordHash, displayName) {
  return stmts.createUser.run(id, username, email, passwordHash, displayName || username);
}
export function findUserByUsername(username) {
  const cached = userCache.get(`uname:${username}`);
  if (cached !== undefined) return cached;
  const row = stmts.findUserByUsername.get(username) || null;
  if (row) userCache.set(`uname:${username}`, row);
  return row;
}
export function findUserByEmail(email) {
  return stmts.findUserByEmail.get(email) || null;
}
export function findUserById(id) {
  const cached = userCache.get(`uid:${id}`);
  if (cached !== undefined) return cached;
  const row = stmts.findUserById.get(id) || null;
  if (row) userCache.set(`uid:${id}`, row);
  return row;
}
export function findUserPublic(id) {
  const cached = userCache.get(`upub:${id}`);
  if (cached !== undefined) return cached;
  const row = stmts.findUserPublic.get(id) || null;
  if (row) userCache.set(`upub:${id}`, row);
  return row;
}
export function updateUser(id, fields) {
  // Look up username before invalidation (may be cached or in DB)
  const existing = stmts.findUserById.get(id);
  if (fields.display_name !== undefined) stmts.updateDisplayName.run(fields.display_name, id);
  if (fields.avatar_url !== undefined) stmts.updateAvatar.run(fields.avatar_url, id);
  if (fields.password_hash !== undefined) stmts.updatePassword.run(fields.password_hash, id);
  // Invalidate all cached variants for this user
  userCache.invalidatePrefix(`uid:${id}`);
  userCache.invalidatePrefix(`upub:${id}`);
  if (existing?.username) userCache.invalidate(`uname:${existing.username}`);
}

// Refresh tokens
export function saveRefreshToken(id, userId, tokenHash, expiresAt) {
  return stmts.saveRefreshToken.run(id, userId, tokenHash, expiresAt);
}
export function findRefreshToken(tokenHash) {
  return stmts.findRefreshToken.get(tokenHash) || null;
}
export function revokeRefreshToken(id) {
  return stmts.revokeRefreshToken.run(id);
}
export function revokeAllUserTokens(userId) {
  return stmts.revokeAllUserTokens.run(userId);
}
export function cleanupExpiredTokens() {
  return stmts.cleanupExpiredTokens.run();
}

// Conversations
export function saveConversation(id, userId, title, messages, folderId) {
  const msgJson = typeof messages === 'string' ? messages : JSON.stringify(messages);
  conversationCache.invalidate(`conv:${id}`);
  return stmts.saveConversation.run(id, userId, title, msgJson, folderId || null);
}
export function getConversation(id) {
  const cached = conversationCache.get(`conv:${id}`);
  if (cached !== undefined) return cached;
  const row = stmts.getConversation.get(id);
  if (row) {
    row.messages = JSON.parse(row.messages || '[]');
    conversationCache.set(`conv:${id}`, row);
  }
  return row || null;
}
export function getUserConversations(userId) {
  return stmts.getUserConversations.all(userId);
}
export function deleteConversation(id, userId) {
  conversationCache.invalidate(`conv:${id}`);
  return stmts.deleteConversation.run(id, userId);
}

// Shared chats
export function createSharedChat(conversationId, sharedBy, accessLevel = 'read', expiresAt = null) {
  const id = uuid();
  const shareToken = randomUUID().replace(/-/g, '').slice(0, 16);
  stmts.createSharedChat.run(id, conversationId, sharedBy, shareToken, accessLevel, expiresAt);
  stmts.updateConversationShare.run(1, shareToken, conversationId);
  return { id, shareToken };
}
export function getSharedChat(shareToken) {
  const row = stmts.getSharedChat.get(shareToken);
  if (row) row.messages = JSON.parse(row.messages || '[]');
  return row || null;
}
export function deleteSharedChat(id, userId) {
  return stmts.deleteSharedChat.run(id, userId);
}
export function getConversationShares(conversationId) {
  return stmts.getConversationShares.all(conversationId);
}
export function cleanupExpiredShares() {
  return stmts.cleanupExpiredShares.run();
}

// Project rooms
export { createRoomWithOwner, joinRoomByInvite, leaveRoom };

export function getProjectRoom(id) {
  const cached = roomCache.get(`room:${id}`);
  if (cached !== undefined) return cached;
  const row = stmts.getProjectRoom.get(id) || null;
  if (row) roomCache.set(`room:${id}`, row);
  return row;
}
export function getUserRooms(userId) {
  return stmts.getUserRooms.all(userId);
}
export function deleteProjectRoom(id, ownerId) {
  return stmts.deleteProjectRoom.run(id, ownerId);
}
export function getRoomMembers(roomId) {
  return stmts.getRoomMembers.all(roomId);
}
export function isRoomMember(roomId, userId) {
  const cacheKey = `member:${roomId}:${userId}`;
  const cached = roomCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const result = !!stmts.isRoomMember.get(roomId, userId);
  roomCache.set(cacheKey, result);
  return result;
}
export function getRoomMemberRole(roomId, userId) {
  const row = stmts.getRoomMemberRole.get(roomId, userId);
  return row?.role || null;
}

// Room messages
export function saveRoomMessage(roomId, userId, content, messageType = 'text') {
  const id = uuid();
  stmts.saveRoomMessage.run(id, roomId, userId, content, messageType);
  return id;
}
export function getRoomMessages(roomId, limit = 50, before = null) {
  if (before) {
    return stmts.getRoomMessages.all(roomId, before, limit).reverse();
  }
  return stmts.getLatestRoomMessages.all(roomId, limit).reverse();
}

// Agent rooms
export { createAgentRoomWithDefaults };

export function getAgentRoom(id) {
  return stmts.getAgentRoom.get(id) || null;
}

export function getAgentRoomForUser(id, ownerId) {
  return stmts.getAgentRoomForUser.get(id, ownerId) || null;
}

export function getAgentRoomByProjectRoomId(projectRoomId) {
  return stmts.getAgentRoomByProjectRoomId.get(projectRoomId) || null;
}

export function canAccessAgentRoom(room, userId) {
  if (!room) return false;
  if (room.owner_id === userId) return true;
  if (room.project_room_id) return isRoomMember(room.project_room_id, userId);
  return false;
}

export function listAgentRoomsByOwner(ownerId) {
  return stmts.listAgentRoomsByOwner.all(ownerId);
}

export function touchAgentRoom(id) {
  return stmts.touchAgentRoom.run(id);
}

export function updateAgentRoomConfig(id, { orchestration_mode, autonomy_level }) {
  const mode = orchestration_mode === 'legacy' ? 'legacy' : 'reactive';
  const level = Math.min(3, Math.max(0, Math.floor(Number(autonomy_level ?? 2))));
  return stmts.updateAgentRoomConfig.run(mode, level, id);
}

export function deleteAgentRoom(id, ownerId) {
  return stmts.deleteAgentRoom.run(id, ownerId);
}

export function createAgentRoomAgent(roomId, name, role, modelTier, systemPrompt = '', tools = [], providerConfig = {}, routerConfig = {}) {
  const id = uuid();
  stmts.createAgentRoomAgent.run(id, roomId, name, role, modelTier, systemPrompt, JSON.stringify(tools), JSON.stringify(providerConfig), JSON.stringify(routerConfig));
  touchAgentRoom(roomId);
  return id;
}

function serializeProviderConfig(providerConfig, includeSecrets = false) {
  const config = providerConfig && typeof providerConfig === 'object'
    ? { ...providerConfig }
    : {};

  if (includeSecrets) {
    return config;
  }

  const hasApiKey = typeof config.api_key === 'string' && config.api_key.length > 0;
  delete config.api_key;

  return hasApiKey
    ? { ...config, has_api_key: true }
    : config;
}

function serializeAgentRoomAgent(row, includeSecrets = false) {
  if (!row) return null;
  return {
    ...row,
    tools_json: undefined,
    provider_config_json: undefined,
    router_config_json: undefined,
    tools: JSON.parse(row.tools_json || '[]'),
    provider_config: serializeProviderConfig(JSON.parse(row.provider_config_json || '{}'), includeSecrets),
    router_config: serializeProviderConfig(JSON.parse(row.router_config_json || '{}'), includeSecrets),
  };
}

export function listAgentRoomAgents(roomId, options = {}) {
  const includeSecrets = options.includeSecrets === true;
  return stmts.listAgentRoomAgents.all(roomId).map((row) => serializeAgentRoomAgent(row, includeSecrets));
}

export function getAgentRoomAgent(roomId, name, options = {}) {
  const includeSecrets = options.includeSecrets === true;
  return serializeAgentRoomAgent(stmts.getAgentRoomAgent.get(roomId, name), includeSecrets);
}

export function updateAgentRoomAgentStatus(roomId, name, status) {
  return stmts.updateAgentRoomAgentStatus.run(status, roomId, name);
}

export function updateAgentRoomAgent(roomId, name, { role, model_tier, system_prompt, tools, provider_config, router_config }) {
  const result = stmts.updateAgentRoomAgent.run(
    role,
    model_tier,
    system_prompt || '',
    JSON.stringify(tools || []),
    JSON.stringify(provider_config || {}),
    JSON.stringify(router_config || {}),
    roomId,
    name,
  );
  if (result.changes > 0) touchAgentRoom(roomId);
  return result;
}

export function deleteAgentRoomAgent(roomId, name) {
  const result = stmts.deleteAgentRoomAgent.run(roomId, name);
  if (result.changes > 0) touchAgentRoom(roomId);
  return result;
}

export function saveAgentRoomMessage(roomId, senderType, senderName, content, eventType = 'message', artifacts = null) {
  const id = uuid();
  const artifactsJson = artifacts && artifacts.length > 0 ? JSON.stringify(artifacts) : null;
  stmts.saveAgentRoomMessage.run(id, roomId, senderType, senderName, content, eventType, artifactsJson);
  touchAgentRoom(roomId);
  return id;
}

export function listAgentRoomMessages(roomId, limit = 100) {
  return stmts.listAgentRoomMessages.all(roomId, limit).reverse().map((msg) => {
    if (msg.artifacts) {
      try { msg.artifacts = JSON.parse(msg.artifacts); } catch { msg.artifacts = null; }
    }
    return msg;
  });
}

export function getAgentRoomMemory(roomId, agentName) {
  return stmts.getAgentRoomMemory.get(roomId, agentName) || null;
}

export function saveAgentRoomMemory(roomId, agentName, memoryText) {
  const value = String(memoryText || '').slice(0, 4000);
  stmts.saveAgentRoomMemory.run(roomId, agentName, value);
  touchAgentRoom(roomId);
}

export function listAgentRoomMemories(roomId) {
  return stmts.listAgentRoomMemories.all(roomId);
}

export function clearAgentRoomMemory(roomId, agentName) {
  stmts.clearAgentRoomMemory.run(roomId, agentName);
  touchAgentRoom(roomId);
}

export function saveAgentRoomTokenUsage(roomId, agentName, usage = {}, model = '', provider = '') {
  const id = uuid();
  stmts.saveAgentRoomTokenUsage.run(
    id,
    roomId,
    agentName,
    Number(usage.prompt_tokens) || 0,
    Number(usage.completion_tokens) || 0,
    Number(usage.total_tokens) || 0,
    String(model || ''),
    String(provider || ''),
  );
  return id;
}

export function getAgentRoomTokenSummary(roomId) {
  return stmts.getAgentRoomTokenSummary.all(roomId);
}

export function getAgentRoomTokenHistory(roomId, limit = 50) {
  return stmts.getAgentRoomTokenHistory.all(roomId, limit);
}

export function saveAgentRoomLog(roomId, agentName, level, message, meta = {}) {
  const id = uuid();
  stmts.saveAgentRoomLog.run(id, roomId, agentName, level, message, JSON.stringify(meta));
  touchAgentRoom(roomId);
  return id;
}

export function listAgentRoomLogs(roomId, limit = 200) {
  return stmts.listAgentRoomLogs.all(roomId, limit).reverse().map((row) => ({
    ...row,
    meta: JSON.parse(row.meta_json || '{}'),
  }));
}

export function createAgentRoomTask(roomId, fields = {}) {
  const id = uuid();
  stmts.createAgentRoomTask.run(
    id,
    roomId,
    String(fields.title || '').trim(),
    String(fields.details || '').trim(),
    String(fields.status || 'todo').trim(),
    String(fields.priority || 'medium').trim(),
    String(fields.assignee_name || '').trim(),
    String(fields.created_by || '').trim(),
  );
  touchAgentRoom(roomId);
  return stmts.getAgentRoomTask.get(roomId, id) || null;
}

export function listAgentRoomTasks(roomId) {
  return stmts.listAgentRoomTasks.all(roomId);
}

export function getAgentRoomTask(roomId, taskId) {
  return stmts.getAgentRoomTask.get(roomId, taskId) || null;
}

export function updateAgentRoomTask(roomId, taskId, fields = {}) {
  const existing = getAgentRoomTask(roomId, taskId);
  if (!existing) {
    return null;
  }

  stmts.updateAgentRoomTask.run(
    fields.title !== undefined ? String(fields.title || '').trim() : existing.title,
    fields.details !== undefined ? String(fields.details || '').trim() : existing.details,
    fields.status !== undefined ? String(fields.status || '').trim() : existing.status,
    fields.priority !== undefined ? String(fields.priority || '').trim() : existing.priority,
    fields.assignee_name !== undefined ? String(fields.assignee_name || '').trim() : existing.assignee_name,
    roomId,
    taskId,
  );
  touchAgentRoom(roomId);
  return getAgentRoomTask(roomId, taskId);
}

export function getAgentRoomFileReview(roomId, filePath) {
  return stmts.getAgentRoomFileReview.get(roomId, filePath) || null;
}

export function upsertAgentRoomFileReview(roomId, filePath, fields = {}) {
  const normalizedPath = String(filePath || '').trim();
  stmts.upsertAgentRoomFileReview.run(
    roomId,
    normalizedPath,
    String(fields.status || 'draft').trim(),
    String(fields.summary || '').trim(),
    String(fields.updated_by || '').trim(),
  );
  touchAgentRoom(roomId);
  return getAgentRoomFileReview(roomId, normalizedPath);
}

// ── Workspace Snapshots ────────────────────────────────────────

export function createSnapshot(roomId, label, description = '', fileList = [], createdBy = '') {
  const id = uuid();
  const fileCount = fileList.length;
  const totalSize = fileList.reduce((sum, f) => sum + (f.size || 0), 0);
  const snapshotData = JSON.stringify({ files: fileList });
  stmts.createSnapshot.run(id, roomId, String(label).trim(), String(description).trim(), fileCount, totalSize, snapshotData, String(createdBy).trim());
  touchAgentRoom(roomId);
  return stmts.getSnapshot.get(roomId, id) || null;
}

export function listSnapshots(roomId, limit = 50) {
  return stmts.listSnapshots.all(roomId, limit);
}

export function getSnapshot(roomId, snapshotId) {
  const row = stmts.getSnapshot.get(roomId, snapshotId);
  if (!row) return null;
  try { row.snapshot_data = JSON.parse(row.snapshot_data); } catch { row.snapshot_data = { files: [] }; }
  return row;
}

export function deleteSnapshot(roomId, snapshotId) {
  const info = stmts.deleteSnapshot.run(roomId, snapshotId);
  return info.changes > 0;
}

// ── Room Skills ────────────────────────────────────────────────

export function addRoomSkill(roomId, skillId, addedBy) {
  const id = uuid();
  stmts.addRoomSkill.run(id, roomId, skillId, addedBy);
  touchAgentRoom(roomId);
  return id;
}

export function removeRoomSkill(roomId, skillId) {
  const info = stmts.removeRoomSkill.run(roomId, skillId);
  touchAgentRoom(roomId);
  return info.changes > 0;
}

export function listRoomSkills(roomId) {
  return stmts.listRoomSkills.all(roomId);
}

// Periodic cleanup
export function runCleanup() {
  cleanupExpiredTokens();
  cleanupExpiredShares();
}

// Run cleanup every 30 minutes
const cleanupTimer = setInterval(runCleanup, 30 * 60 * 1000);
cleanupTimer.unref();

// Cache diagnostics
export function getCacheStats() {
  return {
    user: userCache.stats(),
    conversation: conversationCache.stats(),
    room: roomCache.stats(),
  };
}

/** Close both database connections. Call on graceful shutdown. */
export function closeDatabase() {
  try { readDb.close(); } catch { /* already closed */ }
  try { db.close(); } catch { /* already closed */ }
}

export default db;
