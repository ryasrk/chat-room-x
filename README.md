# Chat Room X — Cloud AI Agent Room

Cloud-only AI chat with multi-agent architecture — **zero local inference**, all LLM calls routed
through cloud providers (EnowxAI gateway, OpenAI, Anthropic).

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Dashboard (Vite + React)  :7391                    │
│  ├── Chat interface                                 │
│  ├── Agent Room monitor                             │
│  └── Provider status                                │
├─────────────────────────────────────────────────────┤
│  Inference Manager (Bun)   :18247                   │
│  ├── Cloud provider routing (EnowxAI/OpenAI/etc)    │
│  ├── Request caching (Redis + in-memory)            │
│  └── Agent Room (LangChain)                         │
│       ├── XA Router: gemini-2.5-flash (classifier)  │
│       └── XB Deep:   gpt-5.4 / gemini-2.5-flash    │
├─────────────────────────────────────────────────────┤
│  Cloud Providers                                    │
│  ├── EnowxAI Gateway (primary)                      │
│  ├── OpenAI (optional)                              │
│  └── Anthropic (optional)                           │
└─────────────────────────────────────────────────────┘
```

## Agent Room

4 specialized agents with dual-model architecture:

| Agent | Role | XB (Deep Work) | XA (Router) |
|-------|------|----------------|-------------|
| Planner | Brain / orchestrator | gpt-5.4 | gemini-2.5-flash |
| Coder | Worker / implementation | gemini-2.5-flash | gemini-2.5-flash |
| Reviewer | Worker / quality check | gemini-2.5-flash | gemini-2.5-flash |
| Scribe | Worker / documentation | gemini-2.5-flash | gemini-2.5-flash |

- **XA (Router)**: Fast cloud model for relevance classification and routing decisions
- **XB (Deep Work)**: Full-power cloud model for actual task execution

## Quick Start

```bash
# 1. Setup (install deps only — no engines/models needed)
./setup.sh

# 2. Configure cloud provider keys
cp .env.example .env
# Edit .env with your ENOWXAI_API_KEY

# 3. Run
./run_all.sh

# 4. (Optional) Run with ngrok tunnel
./run_all_ngrok.sh
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ENOWXAI_BASE_URL` | ✅ | EnowxAI gateway URL |
| `ENOWXAI_API_KEY` | ✅ | EnowxAI API key |
| `ENOWXAI_MODEL` | ✅ | Default model (e.g. `gemini-2.5-flash`) |
| `ENOWXAI_ROUTER_MODEL` | ✅ | XA router model (e.g. `gemini-2.5-flash`) |
| `ENOWXAI_BRAIN_MODEL` | ❌ | Brain agent model override (default: `gpt-5.4`) |
| `ENOWXAI_WORKER_MODEL` | ❌ | Worker agent model override |
| `NGROK_AUTHTOKEN` | ❌ | For remote access via ngrok |
| `NGROK_DOMAIN` | ❌ | Static ngrok domain |

## Project Structure

```
chat-room-x/
├── run_all.sh                # Start dashboard + cloud manager
├── run_all_ngrok.sh          # Start with ngrok tunnel
├── setup.sh                  # Install deps (no engines)
├── .env                      # Cloud provider config
├── inference/
│   ├── manager.js            # Cloud inference manager (:18247)
│   ├── package.json
│   └── agentRoom/
│       ├── defaultAgents.js  # 4 agents with XA/XB cloud configs
│       ├── modelRouter.js    # Cloud provider routing
│       └── langchain/        # LangChain adapter
├── dashboard/                # Vite + React UI (:7391)
├── config/                   # (empty — no local configs needed)
└── docs/
```

## Hardware Requirements

| Component | Minimum |
|-----------|----------|
| RAM       | 4 GB |
| Disk      | 500 MB (deps only) |
| OS        | Linux / macOS / WSL |
| GPU       | Not required |
