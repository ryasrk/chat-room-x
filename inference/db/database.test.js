/**
 * Unit tests for db/database.js — SQLite database layer.
 * Tests user CRUD, conversations, rooms, agent rooms, and cache behavior.
 */

import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';

import {
  uuid,
  createUser, findUserByUsername, findUserByEmail, findUserById,
  updateUser,
  saveConversation, getConversation, getUserConversations, deleteConversation,
  saveRefreshToken, findRefreshToken, revokeRefreshToken, revokeAllUserTokens,
  createRoomWithOwner, getProjectRoom, getUserRooms, deleteProjectRoom,
  getRoomMembers, isRoomMember, leaveRoom,
  saveRoomMessage, getRoomMessages,
  createAgentRoomWithDefaults, getAgentRoom, listAgentRoomsByOwner, deleteAgentRoom,
  getCacheStats,
} from './database.js';

// ── uuid ───────────────────────────────────────────────────────

describe('uuid', () => {
  test('generates unique IDs', () => {
    const id1 = uuid();
    const id2 = uuid();
    assert.ok(id1);
    assert.ok(id2);
    assert.notEqual(id1, id2);
  });

  test('generates valid UUID format', () => {
    const id = uuid();
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

// ── Users ──────────────────────────────────────────────────────

describe('User CRUD', () => {
  test('creates and finds user by username', () => {
    const id = uuid();
    const username = `dbtest_${Date.now()}`;
    createUser(id, username, `${username}@test.com`, 'hash123', 'DB Test');

    const user = findUserByUsername(username);
    assert.ok(user);
    assert.equal(user.id, id);
    assert.equal(user.username, username);
    assert.equal(user.display_name, 'DB Test');
  });

  test('finds user by email', () => {
    const id = uuid();
    const email = `dbemail_${Date.now()}@test.com`;
    createUser(id, `user_${Date.now()}`, email, 'hash123', 'Email User');

    const user = findUserByEmail(email);
    assert.ok(user);
    assert.equal(user.email, email);
  });

  test('finds user by ID', () => {
    const id = uuid();
    createUser(id, `byid_${Date.now()}`, `byid_${Date.now()}@test.com`, 'hash', 'By ID');

    const user = findUserById(id);
    assert.ok(user);
    assert.equal(user.id, id);
  });

  test('returns null for non-existent user', () => {
    assert.equal(findUserByUsername('nonexistent_xyz_123'), null);
    assert.equal(findUserByEmail('nonexistent@xyz.com'), null);
    assert.equal(findUserById('nonexistent-id'), null);
  });

  test('updates display name via updateUser', () => {
    const id = uuid();
    const username = `update_${Date.now()}`;
    createUser(id, username, `${username}@test.com`, 'hash', 'Old Name');

    updateUser(id, { display_name: 'New Name' });
    const user = findUserById(id);
    assert.equal(user.display_name, 'New Name');
  });

  test('updates avatar via updateUser', () => {
    const id = uuid();
    const username = `avatar_${Date.now()}`;
    createUser(id, username, `${username}@test.com`, 'hash', 'Avatar User');

    updateUser(id, { avatar_url: 'https://example.com/avatar.png' });
    const user = findUserById(id);
    assert.equal(user.avatar_url, 'https://example.com/avatar.png');
  });
});

// ── Conversations ──────────────────────────────────────────────

describe('Conversations', () => {
  test('saves and retrieves conversation', () => {
    const userId = uuid();
    const username = `conv_${Date.now()}`;
    createUser(userId, username, `${username}@test.com`, 'hash', 'Conv User');

    const convId = uuid();
    const messages = JSON.stringify([{ role: 'user', content: 'Hello' }]);
    saveConversation(convId, userId, 'Test Chat', messages, null);

    const conv = getConversation(convId);
    assert.ok(conv);
    assert.equal(conv.title, 'Test Chat');
    assert.equal(conv.user_id, userId);
  });

  test('lists user conversations', () => {
    const userId = uuid();
    const username = `convlist_${Date.now()}`;
    createUser(userId, username, `${username}@test.com`, 'hash', 'List User');

    saveConversation(uuid(), userId, 'Chat 1', '[]', null);
    saveConversation(uuid(), userId, 'Chat 2', '[]', null);

    const convs = getUserConversations(userId);
    assert.ok(convs.length >= 2);
  });

  test('deletes conversation', () => {
    const userId = uuid();
    const username = `convdel_${Date.now()}`;
    createUser(userId, username, `${username}@test.com`, 'hash', 'Del User');

    const convId = uuid();
    saveConversation(convId, userId, 'To Delete', '[]', null);
    assert.ok(getConversation(convId));

    deleteConversation(convId, userId);
    assert.equal(getConversation(convId), null);
  });

  test('upserts conversation (update on conflict)', () => {
    const userId = uuid();
    const username = `upsert_${Date.now()}`;
    createUser(userId, username, `${username}@test.com`, 'hash', 'Upsert User');

    const convId = uuid();
    saveConversation(convId, userId, 'Original Title', '[]', null);
    saveConversation(convId, userId, 'Updated Title', '[{"role":"user","content":"hi"}]', null);

    const conv = getConversation(convId);
    assert.equal(conv.title, 'Updated Title');
  });
});

// ── Refresh Tokens ─────────────────────────────────────────────

describe('Refresh Tokens', () => {
  function makeUser() {
    const id = uuid();
    createUser(id, `rt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, `rt_${Date.now()}@test.com`, 'hash', 'RT User');
    return id;
  }

  test('saves and finds refresh token', () => {
    const userId = makeUser();
    const tokenId = uuid();
    const hash = `hash_${Date.now()}`;
    const expiresAt = Math.floor(Date.now() / 1000) + 86400;

    saveRefreshToken(tokenId, userId, hash, expiresAt);
    const found = findRefreshToken(hash);
    assert.ok(found);
    assert.equal(found.user_id, userId);
  });

  test('revokes refresh token', () => {
    const userId = makeUser();
    const tokenId = uuid();
    const ts = Date.now();
    const hash = `revoke_${ts}_${Math.random().toString(36).slice(2)}`;
    const expiresAt = Math.floor(ts / 1000) + 86400;

    saveRefreshToken(tokenId, userId, hash, expiresAt);
    revokeRefreshToken(tokenId);

    const found = findRefreshToken(hash);
    assert.equal(found, null);
  });

  test('revokes all user tokens', () => {
    const userId = makeUser();
    const ts = Date.now();
    const hash1 = `all1_${ts}_${Math.random().toString(36).slice(2)}`;
    const hash2 = `all2_${ts}_${Math.random().toString(36).slice(2)}`;
    const expiresAt = Math.floor(ts / 1000) + 86400;

    saveRefreshToken(uuid(), userId, hash1, expiresAt);
    saveRefreshToken(uuid(), userId, hash2, expiresAt);

    revokeAllUserTokens(userId);

    assert.equal(findRefreshToken(hash1), null);
    assert.equal(findRefreshToken(hash2), null);
  });
});

// ── Project Rooms ──────────────────────────────────────────────

describe('Project Rooms', () => {
  test('createRoomWithOwner returns a room object', () => {
    const userId = uuid();
    createUser(userId, `room_${Date.now()}`, `room_${Date.now()}@test.com`, 'hash', 'Room User');

    const room = createRoomWithOwner(`Room_${Date.now()}`, 'A test room', 'team', userId);
    assert.ok(room);
    assert.ok(room.id);
    assert.ok(room.invite_code);
  });

  test('getProjectRoom retrieves created room', () => {
    const userId = uuid();
    createUser(userId, `roomget_${Date.now()}`, `roomget_${Date.now()}@test.com`, 'hash', 'Room Get');

    const room = createRoomWithOwner(`Room_${Date.now()}`, 'desc', 'team', userId);
    const fetched = getProjectRoom(room.id);
    assert.ok(fetched);
    assert.equal(fetched.owner_id, userId);
  });

  test('getUserRooms lists rooms for user', () => {
    const userId = uuid();
    createUser(userId, `roomlist_${Date.now()}`, `roomlist_${Date.now()}@test.com`, 'hash', 'Room List');

    createRoomWithOwner(`Room_${Date.now()}`, 'desc', 'team', userId);
    const rooms = getUserRooms(userId);
    assert.ok(rooms.length >= 1);
  });

  test('isRoomMember returns true for owner', () => {
    const userId = uuid();
    createUser(userId, `member_${Date.now()}`, `member_${Date.now()}@test.com`, 'hash', 'Member');

    const room = createRoomWithOwner(`Room_${Date.now()}`, 'desc', 'team', userId);
    assert.ok(isRoomMember(room.id, userId));
  });
});

// ── Agent Rooms ────────────────────────────────────────────────

describe('Agent Rooms', () => {
  function makeRoom(userId) {
    const roomId = uuid();
    const wsId = uuid();
    createAgentRoomWithDefaults({
      id: roomId,
      owner_id: userId,
      name: `Room ${Date.now()}`,
      description: 'test',
      workspace_id: wsId,
      workspace_path: `/tmp/ws-${wsId}`,
    });
    return roomId;
  }

  test('creates and retrieves agent room', () => {
    const userId = uuid();
    createUser(userId, `agent_${Date.now()}`, `agent_${Date.now()}@test.com`, 'hash', 'Agent User');

    const roomId = makeRoom(userId);
    const room = getAgentRoom(roomId);
    assert.ok(room);
    assert.equal(room.owner_id, userId);
  });

  test('lists user agent rooms', () => {
    const userId = uuid();
    createUser(userId, `agentlist_${Date.now()}`, `agentlist_${Date.now()}@test.com`, 'hash', 'Agent List');

    makeRoom(userId);
    makeRoom(userId);

    const rooms = listAgentRoomsByOwner(userId);
    assert.ok(rooms.length >= 2);
  });

  test('deletes agent room', () => {
    const userId = uuid();
    createUser(userId, `agentdel_${Date.now()}`, `agentdel_${Date.now()}@test.com`, 'hash', 'Agent Del');

    const roomId = makeRoom(userId);
    assert.ok(getAgentRoom(roomId));

    deleteAgentRoom(roomId, userId);
    const room = getAgentRoom(roomId);
    assert.ok(!room || room.is_active === 0);
  });
});

// ── Cache Stats ────────────────────────────────────────────────

describe('getCacheStats', () => {
  test('returns cache statistics object', () => {
    const stats = getCacheStats();
    assert.ok(typeof stats === 'object');
  });
});
