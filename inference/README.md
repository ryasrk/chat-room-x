# Tenrary-X Cloud Inference

Cloud-only inference manager — routes all LLM calls to cloud providers.

## Architecture

```
[Dashboard :3000] → [Manager :3002] → [Cloud Provider API]
                         ↓
                    Agent Room (LangChain)
                    ├── XA: gemini-2.5-flash (router/classifier)
                    └── XB: gpt-5.4 / gemini-2.5-flash (deep work)
```

## Quick Start

```bash
# Start manager
bun manager.js enowxai

# Or via npm
npm start
```

## API

Manager control API on `:3002`:

```bash
# Health check
curl http://localhost:3002/health

# Status
curl http://localhost:3002/status

# Switch provider
curl -X POST 'http://localhost:3002/switch?mode=enowxai'

# Chat completion (proxied to cloud)
curl http://localhost:3002/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello!"}], "max_tokens": 256}'
```

## Providers

| Provider | Type | Models |
|----------|------|--------|
| **EnowxAI** | Gateway (primary) | gpt-5.4, gemini-2.5-flash, etc. |
| **OpenAI** | Direct | gpt-4o, gpt-4o-mini |
| **Anthropic** | Direct | claude-sonnet-4, claude-3.5-haiku |
| **Custom** | OpenAI-compatible | Any |

## Environment Variables

See `.env.example` in the project root.
