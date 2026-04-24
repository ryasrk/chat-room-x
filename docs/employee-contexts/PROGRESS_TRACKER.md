# Employee Progress Tracker

Purpose:
- Single tracking surface for all 5 employee workstreams.
- Designed for isolated subagents to update without needing full chat history.

Status values:
- To Do
- In Progress
- Blocked
- Done

Update rules:
1. Update `Current Status` and `Last Updated` on every work session.
2. Add one-line `Latest Change` with concrete artifact.
3. If blocked, include blocker reason and dependency owner.
4. Add evidence links (PR, commit, test output, screenshot path).

---

## Employee 1: Streaming Reliability Engineer
Context file: `docs/employee-contexts/EMPLOYEE_1_STREAMING_RELIABILITY.md`

- Current Status: To Do
- Last Updated: YYYY-MM-DD
- Week Target: Reliability foundation
- Latest Change: None
- Active Tasks:
  - [ ] Stream FSM deterministic implementation
  - [ ] WS/SSE watchdog and fallback
  - [ ] Deadlock detector + self-heal
  - [ ] Queue cancellation correctness
- Blockers: None
- Evidence:
  - None

---

## Employee 2: Session Persistence and Recovery Engineer
Context file: `docs/employee-contexts/EMPLOYEE_2_SESSION_RECOVERY.md`

- Current Status: In Progress
- Last Updated: YYYY-MM-DD
- Week Target: Recovery baseline
- Latest Change: Token/session persistence baseline already present
- Active Tasks:
  - [ ] Persist in-progress stream metadata
  - [ ] Recovered-session banner and continue/retry
  - [ ] Schema versioning and migration guards
- Blockers: None
- Evidence:
  - `dashboard/src/tokenCounter.js` local persistence implementation

---

## Employee 3: Context and Memory Quality Engineer
Context file: `docs/employee-contexts/EMPLOYEE_3_CONTEXT_MEMORY_QUALITY.md`

- Current Status: In Progress
- Last Updated: YYYY-MM-DD
- Week Target: Structured compaction controls
- Latest Change: Auto compact trigger and toggle available
- Active Tasks:
  - [ ] Structured memory block format
  - [ ] Threshold selector 70/80/90
  - [ ] Pinned-message exclusion
  - [ ] Manual compact preview
  - [ ] Context budget preflight warnings
- Blockers: None
- Evidence:
  - `dashboard/src/chatApi.js` auto compact flow
  - `dashboard/src/uiUpdaters.js` toggle sync

---

## Employee 4: Conversation UX Engineer
Context file: `docs/employee-contexts/EMPLOYEE_4_CONVERSATION_UX.md`

- Current Status: In Progress
- Last Updated: YYYY-MM-DD
- Week Target: Generation UX refinement
- Latest Change: New-chat streaming guard and queue status improvements
- Active Tasks:
  - [ ] Branch tree navigation
  - [ ] Immutable revision timeline
  - [ ] Replay-from-point workflow
  - [ ] Continuation cards
- Blockers: None
- Evidence:
  - `dashboard/src/chatApi.js` new-chat guard while streaming
  - `dashboard/src/style.css` queue/generation visual updates

---

## Employee 5: Attachment Grounding and Observability Engineer
Context file: `docs/employee-contexts/EMPLOYEE_5_GROUNDING_OBSERVABILITY.md`

- Current Status: In Progress
- Last Updated: YYYY-MM-DD
- Week Target: Metrics and correlation baseline
- Latest Change: Manager slot metrics exposure exists
- Active Tasks:
  - [ ] Attachment chunk/index/cache pipeline
  - [ ] Citation and source panel
  - [ ] Dashboard metrics cards
  - [ ] Request-id correlation frontend -> manager
- Blockers: None
- Evidence:
  - `inference/manager.js` metrics fields for slot strategy/counters

---

## Shared Integration Milestones

- Week 1 milestone:
  - [ ] No queue deadlocks in controlled chaos tests
- Week 2 milestone:
  - [ ] Hard refresh recovery flow verified
- Week 3 milestone:
  - [ ] Long-context coherence beyond threshold validated
- Week 4 milestone:
  - [ ] Branching and grounding UX demo complete
- Week 5 milestone:
  - [ ] Production hardening and release checklist complete

---

## Cross-Team Dependencies

- Employee 1 <-> Employee 5:
  - Metrics naming and request-id propagation contract
- Employee 2 -> Employee 3, Employee 4:
  - Local storage schema version and migration contract
- Employee 3 <-> Employee 4:
  - Rendering format for compacted memory in timeline

---

## Weekly Reporting Format (for all employees)

- What changed this week:
- What is next:
- Risks:
- Blockers:
- Evidence links:
