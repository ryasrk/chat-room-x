# Robust Chatbot Task Board

Roadmap reference:
- [tenrary-x/docs/ROBUST_CHATBOT_ROADMAP.md](tenrary-x/docs/ROBUST_CHATBOT_ROADMAP.md)

Sprint window:
- Week 1 to Week 5

Status legend:
- To Do
- In Progress
- Blocked
- Done

## Employee 1: Streaming Reliability Engineer

### To Do
- Implement deterministic stream state machine in dashboard chat flow.
- Add WS/SSE watchdog timeout and auto-fallback strategy.
- Add deadlock detector in inference manager.
- Add queued request cancel API and client action.

### In Progress
- None

### Blocked
- None

### Done
- Slot-leak fix for disconnect handling.
- Queue position validation in client rendering.

---

## Employee 2: Session Persistence & Recovery Engineer

### To Do
- Persist in-progress stream metadata for refresh recovery.
- Implement recovered-session banner and continue flow.
- Add localStorage schema versioning and migration helper.

### In Progress
- Persist token/session indicators across hard refresh.

### Blocked
- None

### Done
- Baseline token stats persistence to localStorage.

---

## Employee 3: Context & Memory Quality Engineer

### To Do
- Add compaction threshold selector (70/80/90).
- Add pinned-message exclusion in compaction.
- Build structured compact memory format.
- Add manual compact preview action.

### In Progress
- Auto compact trigger at 80% context usage.

### Blocked
- None

### Done
- Auto compact toggle in settings modal.

---

## Employee 4: Conversation UX Engineer

### To Do
- Add branch tree panel for regenerated replies.
- Add immutable edit revision timeline.
- Add replay-from-point workflow.
- Add unfinished-task continuation cards.

### In Progress
- Generation/queued status UX refinement.

### Blocked
- None

### Done
- New chat guard while streaming (keep ongoing response visible).
- Export modal layout modernization.

---

## Employee 5: Attachment Grounding + Observability Engineer

### To Do
- Build attachment chunk/index pipeline with cache.
- Implement citation/source panel in answer UI.
- Add metrics cards: queue depth, active slots, first-token latency, completion latency.
- Add request-id correlation frontend to manager logs.

### In Progress
- Initial observability metric exposure in manager endpoint.

### Blocked
- None

### Done
- Metrics endpoint includes slot strategy and slot counters.

---

## Shared Integration Board

### To Do
- Weekly integration test pass for WS/SSE and refresh recovery.
- Chaos test suite: drop WS, timeout upstream, malformed event frame.
- End-to-end scenario validation for long-context chat.

### In Progress
- None

### Blocked
- None

### Done
- Baseline queue pipeline supports parallel slot dispatch.

---

## Meeting Cadence
- Daily standup: 15 minutes
- Mid-week integration sync: 30 minutes
- End-of-week demo and QA signoff: 45 minutes

## Definition of Sprint Completion
1. No critical queue deadlock regressions.
2. No data loss on hard refresh.
3. Context compaction remains user-controllable and transparent.
4. Metrics visible and actionable in dashboard.
5. Core chat flow validated under disconnect and retry conditions.
