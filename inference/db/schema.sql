-- Tenrary-X Database Schema
-- SQLite with WAL mode for concurrent reads

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ── Users ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id           TEXT PRIMARY KEY,                          -- UUID
    username     TEXT UNIQUE NOT NULL,
    email        TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT,
    avatar_url   TEXT,
    created_at   INTEGER DEFAULT (unixepoch()),
    updated_at   INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_email    ON users(email);

-- ── Refresh Tokens ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL,
    expires_at  INTEGER NOT NULL,
    created_at  INTEGER DEFAULT (unixepoch()),
    revoked     INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id    ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token_hash ON refresh_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires_at ON refresh_tokens(expires_at);

-- ── Conversations ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversations (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       TEXT DEFAULT 'New Chat',
    messages    TEXT DEFAULT '[]',                          -- JSON array
    folder_id   TEXT,
    is_shared   INTEGER DEFAULT 0,
    share_token TEXT UNIQUE,
    created_at  INTEGER DEFAULT (unixepoch()),
    updated_at  INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_conversations_user_id    ON conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_folder_id  ON conversations(folder_id);
CREATE INDEX IF NOT EXISTS idx_conversations_share_token ON conversations(share_token);
CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at);

-- ── Project Rooms ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_rooms (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT DEFAULT '',
    category    TEXT NOT NULL DEFAULT 'team',
    owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invite_code TEXT UNIQUE NOT NULL,
    is_active   INTEGER DEFAULT 1,
    created_at  INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_project_rooms_owner_id    ON project_rooms(owner_id);
CREATE INDEX IF NOT EXISTS idx_project_rooms_invite_code ON project_rooms(invite_code);

-- ── Room Members ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS room_members (
    room_id   TEXT NOT NULL REFERENCES project_rooms(id) ON DELETE CASCADE,
    user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role      TEXT DEFAULT 'member' CHECK(role IN ('owner', 'admin', 'member')),
    joined_at INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY (room_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_room_members_user_id ON room_members(user_id);

-- ── Room Messages ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS room_messages (
    id           TEXT PRIMARY KEY,
    room_id      TEXT NOT NULL REFERENCES project_rooms(id) ON DELETE CASCADE,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content      TEXT NOT NULL,
    message_type TEXT DEFAULT 'text' CHECK(message_type IN ('text', 'system', 'ai_response')),
    created_at   INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_room_messages_room_id    ON room_messages(room_id);
CREATE INDEX IF NOT EXISTS idx_room_messages_user_id    ON room_messages(user_id);
CREATE INDEX IF NOT EXISTS idx_room_messages_created_at ON room_messages(created_at);

-- ── AI Agent Rooms ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_rooms (
    id             TEXT PRIMARY KEY,
    owner_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_room_id TEXT UNIQUE REFERENCES project_rooms(id) ON DELETE CASCADE,
    name           TEXT NOT NULL,
    description    TEXT DEFAULT '',
    workspace_id   TEXT UNIQUE NOT NULL,
    workspace_path TEXT NOT NULL,
    orchestration_mode TEXT DEFAULT 'reactive',
    autonomy_level INTEGER DEFAULT 2,
    is_active      INTEGER DEFAULT 1,
    created_at     INTEGER DEFAULT (unixepoch()),
    updated_at     INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_agent_rooms_owner_id   ON agent_rooms(owner_id);
CREATE INDEX IF NOT EXISTS idx_agent_rooms_project_room_id ON agent_rooms(project_room_id);
CREATE INDEX IF NOT EXISTS idx_agent_rooms_active     ON agent_rooms(is_active);
CREATE INDEX IF NOT EXISTS idx_agent_rooms_created_at ON agent_rooms(created_at);

CREATE TABLE IF NOT EXISTS agent_room_agents (
    id            TEXT PRIMARY KEY,
    room_id       TEXT NOT NULL REFERENCES agent_rooms(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    role          TEXT NOT NULL,
    model_tier    TEXT NOT NULL CHECK(model_tier IN ('brain', 'worker', 'cheap_worker')),
    system_prompt TEXT DEFAULT '',
    tools_json    TEXT DEFAULT '[]',
    provider_config_json TEXT DEFAULT '{}',
    router_config_json TEXT DEFAULT '{}',
    status        TEXT DEFAULT 'idle' CHECK(status IN ('idle', 'running', 'error')),
    created_at    INTEGER DEFAULT (unixepoch()),
    updated_at    INTEGER DEFAULT (unixepoch()),
    UNIQUE(room_id, name)
);

CREATE INDEX IF NOT EXISTS idx_agent_room_agents_room_id ON agent_room_agents(room_id);

CREATE TABLE IF NOT EXISTS agent_room_messages (
    id          TEXT PRIMARY KEY,
    room_id     TEXT NOT NULL REFERENCES agent_rooms(id) ON DELETE CASCADE,
    sender_type TEXT NOT NULL CHECK(sender_type IN ('user', 'agent', 'system')),
    sender_name TEXT NOT NULL,
    content     TEXT NOT NULL,
    event_type  TEXT DEFAULT 'message',
    artifacts   TEXT DEFAULT NULL,
    created_at  INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_agent_room_messages_room_id    ON agent_room_messages(room_id);
CREATE INDEX IF NOT EXISTS idx_agent_room_messages_created_at ON agent_room_messages(created_at);

CREATE TABLE IF NOT EXISTS agent_room_memories (
    room_id     TEXT NOT NULL REFERENCES agent_rooms(id) ON DELETE CASCADE,
    agent_name  TEXT NOT NULL,
    memory_text TEXT DEFAULT '',
    updated_at  INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY (room_id, agent_name)
);

CREATE INDEX IF NOT EXISTS idx_agent_room_memories_room_id ON agent_room_memories(room_id);

CREATE TABLE IF NOT EXISTS agent_room_logs (
    id         TEXT PRIMARY KEY,
    room_id    TEXT NOT NULL REFERENCES agent_rooms(id) ON DELETE CASCADE,
    agent_name TEXT NOT NULL,
    level      TEXT NOT NULL CHECK(level IN ('info', 'warning', 'error')),
    message    TEXT NOT NULL,
    meta_json  TEXT DEFAULT '{}',
    created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_agent_room_logs_room_id    ON agent_room_logs(room_id);
CREATE INDEX IF NOT EXISTS idx_agent_room_logs_created_at ON agent_room_logs(created_at);

CREATE TABLE IF NOT EXISTS agent_room_tasks (
    id            TEXT PRIMARY KEY,
    room_id       TEXT NOT NULL REFERENCES agent_rooms(id) ON DELETE CASCADE,
    title         TEXT NOT NULL,
    details       TEXT DEFAULT '',
    status        TEXT DEFAULT 'todo' CHECK(status IN ('todo', 'in_progress', 'blocked', 'done')),
    priority      TEXT DEFAULT 'medium' CHECK(priority IN ('low', 'medium', 'high')),
    assignee_name TEXT DEFAULT '',
    created_by    TEXT DEFAULT '',
    created_at    INTEGER DEFAULT (unixepoch()),
    updated_at    INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_agent_room_tasks_room_id ON agent_room_tasks(room_id);
CREATE INDEX IF NOT EXISTS idx_agent_room_tasks_status ON agent_room_tasks(status);

CREATE TABLE IF NOT EXISTS agent_room_file_reviews (
    room_id     TEXT NOT NULL REFERENCES agent_rooms(id) ON DELETE CASCADE,
    file_path   TEXT NOT NULL,
    status      TEXT DEFAULT 'draft' CHECK(status IN ('draft', 'in_review', 'changes_requested', 'approved', 'promoted')),
    summary     TEXT DEFAULT '',
    updated_by  TEXT DEFAULT '',
    created_at  INTEGER DEFAULT (unixepoch()),
    updated_at  INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY (room_id, file_path)
);

CREATE INDEX IF NOT EXISTS idx_agent_room_file_reviews_room_id ON agent_room_file_reviews(room_id);

CREATE TABLE IF NOT EXISTS agent_room_token_usage (
    id            TEXT PRIMARY KEY,
    room_id       TEXT NOT NULL REFERENCES agent_rooms(id) ON DELETE CASCADE,
    agent_name    TEXT NOT NULL,
    prompt_tokens INTEGER DEFAULT 0,
    completion_tokens INTEGER DEFAULT 0,
    total_tokens  INTEGER DEFAULT 0,
    model         TEXT DEFAULT '',
    provider      TEXT DEFAULT '',
    created_at    INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_agent_room_token_usage_room_id ON agent_room_token_usage(room_id);
CREATE INDEX IF NOT EXISTS idx_agent_room_token_usage_agent   ON agent_room_token_usage(room_id, agent_name);

-- ── Workspace Snapshots ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_room_snapshots (
    id          TEXT PRIMARY KEY,
    room_id     TEXT NOT NULL REFERENCES agent_rooms(id) ON DELETE CASCADE,
    label       TEXT NOT NULL DEFAULT '',
    description TEXT DEFAULT '',
    file_count  INTEGER DEFAULT 0,
    total_size  INTEGER DEFAULT 0,
    snapshot_data TEXT NOT NULL DEFAULT '{}',               -- JSON: {files: [{path, size, hash}]}
    created_by  TEXT DEFAULT '',
    created_at  INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_agent_room_snapshots_room_id ON agent_room_snapshots(room_id);
CREATE INDEX IF NOT EXISTS idx_agent_room_snapshots_created ON agent_room_snapshots(created_at);

-- ── Agent Room Skills ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_room_skills (
    id          TEXT PRIMARY KEY,
    room_id     TEXT NOT NULL REFERENCES agent_rooms(id) ON DELETE CASCADE,
    skill_id    TEXT NOT NULL,
    added_by    TEXT NOT NULL REFERENCES users(id),
    added_at    INTEGER DEFAULT (unixepoch()),
    UNIQUE(room_id, skill_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_room_skills_room_id ON agent_room_skills(room_id);

-- ── Shared Chats ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shared_chats (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    shared_by       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    share_token     TEXT UNIQUE NOT NULL,
    access_level    TEXT DEFAULT 'read' CHECK(access_level IN ('read', 'collaborate')),
    expires_at      INTEGER,
    created_at      INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_shared_chats_conversation_id ON shared_chats(conversation_id);
CREATE INDEX IF NOT EXISTS idx_shared_chats_shared_by       ON shared_chats(shared_by);
CREATE INDEX IF NOT EXISTS idx_shared_chats_share_token     ON shared_chats(share_token);
CREATE INDEX IF NOT EXISTS idx_shared_chats_expires_at      ON shared_chats(expires_at);
