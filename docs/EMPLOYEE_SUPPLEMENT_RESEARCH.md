# Employee Supplement Research Pack

Purpose:
- Give each employee practical technical references, tools, and algorithms to execute roadmap tasks faster and with lower implementation risk.

Scope:
- Focused on current roadmap constraints and exclusions.
- Prioritizes reliability, persistence, context quality, UX, and observability.

---

## Employee 1: Streaming Reliability Engineer

### Recommended Tech/Patterns
- Explicit stream finite-state machine (FSM): `idle -> queued -> streaming -> finalizing -> done/error`.
- Dual transport policy: WebSocket primary, SSE fallback.
- Exponential backoff with jitter for reconnect after abnormal closure.
- Idempotent cancel and cleanup lifecycle for in-flight requests.

### Algorithms
1. Reconnect backoff
- Initial delay random in 0-5s.
- Then truncated exponential backoff.
- Cap max delay (e.g., 20-30s).

2. Slot safety invariant
- Maintain invariant: `active_slots >= 0` and `active_slots <= max_parallel_slots`.
- Every exit path (success/error/disconnect/timeout) must release slot exactly once.

3. Queue deadlock detector
- If `queue_depth > 0` and `active_slots == 0` for threshold duration, trigger self-heal routine.

### Tools
- Node diagnostics: structured logs with request IDs.
- Synthetic load scripts for ws/sse path stress.
- Chaos tests: socket drops, abrupt close, malformed stream chunk.

### Documentation
- WebSocket protocol RFC 6455: https://www.rfc-editor.org/rfc/rfc6455
- MDN WebSocket API overview: https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API
- SSE guide and stream format: https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events
- HTTP semantics (timeouts/retry/status): https://www.rfc-editor.org/rfc/rfc7231

---

## Employee 2: Session Persistence & Recovery Engineer

### Recommended Tech/Patterns
- Versioned local storage schema with migration function.
- Write-through persistence for critical state:
  - draft input
  - active conversation id
  - stream metadata
  - token/session counters
- Recovery handshake on app boot:
  - validate persisted state
  - reconcile with current runtime
  - show explicit recovery banner

### Algorithms
1. Schema migration
- Keep `state_version` key.
- On load: migrate old versions step-by-step until current.
- On migration failure: fallback to safe defaults without app crash.

2. Recovery reconciliation
- If persisted stream exists but no live stream on backend, mark as interrupted and offer resume/retry.

3. Atomic save strategy
- Save minimal critical slices first, then optional UI slices.

### Tools
- Browser storage inspector for migration tests.
- Fault injection tests for partial/corrupt local storage records.

### Documentation
- AbortController API for safe cancellation/recovery transitions: https://developer.mozilla.org/en-US/docs/Web/API/AbortController
- Web APIs + worker support notes for WebSocket: https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API

---

## Employee 3: Context & Memory Quality Engineer

### Recommended Tech/Patterns
- Structured memory summaries, not free-form dumps.
- Preserve recent turns + pinned turns verbatim.
- Preflight token budget enforcement before dispatch.
- Configurable compact threshold and user controls.

### Algorithms
1. Structured compaction schema
- Output sections:
  - facts
  - decisions
  - constraints
  - todo
  - open_questions

2. Sliding context window
- Keep last N turns + compacted memory block.
- Hard reserve generation budget before request.

3. Compact quality guard
- Prevent repeated re-summarization loops by tagging compact blocks and skipping them in next summary pass.

### Tools
- Prompt/eval sets for long-conversation coherence checks.
- Deterministic regression set for compaction edge cases.

### Documentation
- OpenTelemetry traces concepts (for evaluating compaction effects on request lifecycle): https://opentelemetry.io/docs/concepts/signals/traces/
- Metrics concepts (for tracking context growth/compaction impacts): https://opentelemetry.io/docs/concepts/signals/metrics/

---

## Employee 4: Conversation UX Engineer

### Recommended Tech/Patterns
- Immutable message revisions.
- Explicit branch graph model for regenerate/edit forks.
- Progressive status language:
  - queued
  - connecting
  - generating
  - finalizing
  - interrupted

### Algorithms
1. Branch model
- DAG-like message lineage with `parentMessageId`.
- Default active branch pointer per fork node.

2. Replay-from-point
- Deterministic truncation from selected revision point.
- Preserve old branch as immutable history.

3. Continuation suggestion
- Rule-based detector for unfinished assistant tasks from last reply.

### Tools
- UX event telemetry for branch-switch and replay usage.
- Session recordings for failed user paths.

### Documentation
- MDN bfcache note for WebSocket lifecycle and page transitions: https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API
- SSE event formatting for resilient fallback status events: https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events

---

## Employee 5: Attachment Grounding + Observability Engineer

### Recommended Tech/Patterns
- Content-hash based file indexing cache.
- Retrieval-first answering with explicit citation mapping.
- Request correlation across frontend and manager logs.
- Golden signals dashboard for chat runtime.

### Algorithms
1. Chunking policy
- Hybrid chunking:
  - paragraph boundary first
  - token cap fallback
  - overlap window for recall

2. Citation mapping
- Each answer segment references source chunk IDs.
- Maintain confidence level per segment.

3. Observability baselines
- Metrics:
  - queue_depth
  - active_slots
  - max_parallel_slots
  - first_token_latency_ms
  - completion_latency_ms
  - error_rate

### Tools
- OpenTelemetry JS SDK + browser instrumentation.
- Console exporter in dev; collector/OTLP in staging/prod.
- Request-id propagation middleware.

### Documentation
- OpenTelemetry JS browser getting started: https://opentelemetry.io/docs/languages/js/getting-started/browser/
- OpenTelemetry JS repository and package guidance: https://github.com/open-telemetry/opentelemetry-js
- OpenTelemetry traces concepts: https://opentelemetry.io/docs/concepts/signals/traces/
- OpenTelemetry metrics concepts: https://opentelemetry.io/docs/concepts/signals/metrics/

---

## Shared References (All Employees)
- llama.cpp project (OpenAI-compatible server context): https://github.com/ggml-org/llama.cpp
- WebSocket protocol standard: https://www.rfc-editor.org/rfc/rfc6455
- HTTP semantics and status behavior: https://www.rfc-editor.org/rfc/rfc7231
- MDN WebSocket API guide: https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API
- MDN SSE guide: https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events
- MDN AbortController API: https://developer.mozilla.org/en-US/docs/Web/API/AbortController

---

## Suggested Immediate Usage
1. Employee 1 and 5 align on metric names and request-id propagation format first.
2. Employee 2 defines storage schema versioning contract used by Employee 3 and 4.
3. Employee 3 and 4 align on compacted memory rendering conventions in chat timeline.
4. Weekly demo must include one chaos scenario and one recovery scenario.
