# Employee 1 Context: Streaming Reliability Engineer

Owner goal:
- Guarantee queue/stream lifecycle correctness and eliminate stuck queued states.

Current known state:
- Parallel slot dispatch exists in `inference/manager.js`.
- Prior fixes added disconnect-safe slot release and queue validation.
- Frontend already renders queued/streaming statuses in `dashboard/src/chatApi.js` and `dashboard/src/messageRenderer.js`.

Primary tasks:
1. Deterministic stream state machine: `idle -> queued -> streaming -> finalizing -> done/error`.
2. WS/SSE watchdog timeout and auto-fallback behavior.
3. Deadlock detector: if `queue_depth > 0` and `active_slots == 0` for threshold, trigger safe self-heal.
4. Queued cancellation API + frontend action.

Relevant files:
- `inference/manager.js`
- `inference/streamProxy.js`
- `dashboard/src/chatApi.js`
- `dashboard/src/messageRenderer.js`
- `dashboard/src/appState.js`
- `dashboard/src/main.js`

Data/contract expectations:
- Slot counters must never go negative.
- Every terminal stream path must release slot exactly once.
- Cancellation must be idempotent.
- Queue position displayed only when valid positive integer.

Acceptance criteria:
- No deadlock under simulated disconnect storms.
- Cancelled queued request does not consume slot.
- Watchdog timeout triggers fallback or safe failure state.
- No regression to perpetual `Queued` UI.

Test checklist:
- Two parallel requests, cancel one while queued.
- Drop client connection while streaming.
- Upstream timeout during generation.
- Reconnect and verify queue resumes correctly.

Subagent Brief:
- Implement/verify stream lifecycle hardening in the listed files only.
- Add minimal surface area changes; preserve current API compatibility.
- Include guard tests or deterministic test harness updates where feasible.
- Report any invariant violations observed during implementation.
