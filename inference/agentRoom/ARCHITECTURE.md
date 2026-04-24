# AI Agent Room — System Architecture

## Overview

The AI Agent Room is a multi-agent collaboration system where AI agents work together
inside isolated workspace folders. Each room gets a UUID-based workspace directory where
agents read/write files, communicate via @mentions, and produce artifacts.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        Dashboard (Vite)                         │
│  ┌──────────┐  ┌──────────────┐  ┌──────────┐  ┌────────────┐ │
│  │ Agent    │  │ Chat +       │  │ File     │  │ Logs       │ │
│  │ Status   │  │ @mention     │  │ Explorer │  │ Sidebar    │ │
│  │ Panel    │  │ Composer     │  │ Tree     │  │            │ │
│  └──────────┘  └──────────────┘  └──────────┘  └────────────┘ │
└────────────────────────┬────────────────────────────────────────┘
                         │ WebSocket + REST
┌────────────────────────┴────────────────────────────────────────┐
│                    Inference Manager (Node.js)                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                  Agent Room Router                        │   │
│  │  /api/agent-rooms/*  (REST)                              │   │
│  │  ws://…/agent-room   (WebSocket events)                  │   │
│  └──────────────────────┬───────────────────────────────────┘   │
│                         │                                        │
│  ┌──────────────────────┴───────────────────────────────────┐   │
│  │              Agent Orchestrator (EventEmitter)            │   │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌───────────┐  │   │
│  │  │ Planner │  │ Coder   │  │ Reviewer│  │ Executor  │  │   │
│  │  │ (brain) │  │ (worker)│  │ (worker)│  │ (cheap)   │  │   │
│  │  └────┬────┘  └────┬────┘  └────┬────┘  └─────┬─────┘  │   │
│  │       │             │            │              │         │   │
│  │  ┌────┴─────────────┴────────────┴──────────────┴────┐   │   │
│  │  │           Model Router (brain/worker/cheap)       │   │   │
│  │  │  brain  → Claude Opus / GPT-4o (planning)        │   │   │
│  │  │  worker → Claude Sonnet / GPT-4o-mini (coding)   │   │   │
│  │  │  cheap  → Cloud gemini-2.5-flash (formatting)    │   │   │
│  │  └───────────────────────────────────────────────────┘   │   │
│  └──────────────────────────────────────────────────────────┘   │
│                         │                                        │
│  ┌──────────────────────┴───────────────────────────────────┐   │
│  │                  File Tool System                         │   │
│  │  read_file | write_file | list_files | update_file       │   │
│  │  ┌───────────────────────────────────────────────────┐   │   │
│  │  │  Security Layer (path traversal prevention)       │   │   │
│  │  │  All paths resolved relative to workspace root    │   │   │
│  │  │  Symlink resolution + jail check                  │   │   │
│  │  └───────────────────────────────────────────────────┘   │   │
│  └──────────────────────────────────────────────────────────┘   │
│                         │                                        │
│  ┌──────────────────────┴───────────────────────────────────┐   │
│  │              Workspace Storage                            │   │
│  │  data/agent-workspaces/<room-uuid>/                      │   │
│  │    ├── plan.md                                           │   │
│  │    ├── src/                                              │   │
│  │    │   ├── main.py                                       │   │
│  │    │   └── utils.py                                      │   │
│  │    └── review.md                                         │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## Key Components

### 1. Agent Room (per room)
- UUID-based workspace folder under `data/agent-workspaces/<room-id>/`
- SQLite metadata (room config, agent definitions, message history)
- Event bus for real-time agent communication

### 2. Agent Definitions
Each agent has:
- `name` — unique identifier (e.g., "planner", "coder", "reviewer")
- `role` — display role description
- `model_tier` — "brain" | "worker" | "cheap_worker"
- `system_prompt` — agent personality and instructions
- `tools` — which file tools the agent can use

### 3. Model Router
Routes agent requests to the appropriate LLM:
- **brain** → High-capability model (Claude Opus, GPT-4o) for planning/architecture
- **worker** → Mid-tier model (Claude Sonnet, GPT-4o-mini) for coding/review
- **cheap_worker** → Cloud model (gemini-2.5-flash) for formatting, summaries

### 4. File Tool System
Sandboxed file operations within workspace:
- `read_file(path)` — Read file contents
- `write_file(path, content)` — Create/overwrite file
- `update_file(path, old_str, new_str)` — Surgical string replacement
- `list_files(path?)` — List directory contents recursively

### 5. @Mention Communication
Agents communicate by mentioning each other:
- `@coder Please implement the plan above`
- `@reviewer Check src/main.py for issues`
- Parser extracts mentions → dispatches to target agent

### 6. Event System
WebSocket events for real-time UI updates:
- `agent:thinking` — Agent started processing
- `agent:message` — Agent produced a message
- `agent:file_write` — Agent wrote a file
- `agent:file_read` — Agent read a file
- `agent:done` — Agent finished
- `agent:error` — Agent encountered an error

### 7. Security
- All file paths resolved relative to workspace root
- `realpath()` check ensures resolved path stays within workspace
- No symlink escape
- Path components validated (no `..`, no absolute paths)
- File size limits enforced
- ZIP download streams from workspace only

## API Endpoints

### REST
| Method | Path | Description |
|--------|------|-------------|
| POST | /api/agent-rooms | Create a new agent room |
| GET | /api/agent-rooms | List user's agent rooms |
| GET | /api/agent-rooms/:id | Get room details + agents |
| DELETE | /api/agent-rooms/:id | Delete room + workspace |
| POST | /api/agent-rooms/:id/message | Send message (triggers agents) |
| GET | /api/agent-rooms/:id/messages | Get message history |
| GET | /api/agent-rooms/:id/files | List workspace files |
| GET | /api/agent-rooms/:id/files/* | Read a specific file |
| GET | /api/agent-rooms/:id/download | Download workspace as ZIP |
| POST | /api/agent-rooms/:id/agents | Add/configure agent |
| GET | /api/agent-rooms/:id/agents | List agents in room |

### WebSocket
Connect to `/agent-room?room_id=<id>&token=<jwt>` for real-time events.
