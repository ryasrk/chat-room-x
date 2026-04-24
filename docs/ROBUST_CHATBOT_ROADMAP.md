# Tenrary-X Robust Chatbot Roadmap

Scope exclusions (as requested):
- No multi-model orchestration/routing features
- No external tool-use expansion (code sandbox, web browse, connectors)
- No security/governance expansion track in this roadmap

## Objective
Build a reliable, production-ready local LLM chat experience focused on:
- Stability and recovery
- Context and memory quality
- Conversation UX depth
- Attachment grounding reliability
- Collaboration + observability

## Timeline
- Total: 5 weeks
- Team size: 5 employees
- Delivery model: parallel workstreams with weekly integration checkpoints

## Team Assignment (5 Employees)

### Employee 1: Streaming Reliability Engineer
Owner focus:
- Queue/stream robustness and recovery guarantees

Primary tasks:
1. Implement client stream state machine: `idle -> queued -> streaming -> finalizing -> done/error`.
2. Add WS/SSE watchdog timers and auto-fallback behavior.
3. Add deadlock detection in manager: if `queue_depth > 0` and `active_slots == 0` for threshold window, trigger safe self-heal.
4. Add queued request cancellation and cleanup correctness.

Deliverables:
- Stream state transitions with deterministic tests
- Deadlock alarm + self-heal path
- Queue cancellation UX + manager support

Definition of done:
- No stuck queue scenarios in chaos tests
- Automatic recovery from connection interruption

---

### Employee 2: Session Persistence & Recovery Engineer
Owner focus:
- Never lose user progress; resilient refresh behavior

Primary tasks:
1. Persist in-progress draft, active conversation ID, and pending stream metadata.
2. Restore session state after hard refresh (including recovering context indicators).
3. Add "Recovered session" UX banner + continue action.
4. Add localStorage schema versioning and migration guards.

Deliverables:
- Recovery module for refresh/crash scenarios
- UI recovery prompts and safe replay behavior
- Migration-safe persistence layer

Definition of done:
- Hard refresh does not lose in-progress user work
- Recovery succeeds across app updates with schema changes

---

### Employee 3: Context & Memory Quality Engineer
Owner focus:
- Long-conversation coherence and token budget quality

Primary tasks:
1. Upgrade compaction from freeform summary to structured memory blocks:
   - facts, decisions, tasks, constraints, open questions
2. Add settings controls:
   - auto-compact toggle (existing, validate)
   - threshold selector (70/80/90)
   - preserve pinned messages
3. Add context budget preflight checks before request dispatch.
4. Add compact preview and manual compact action.

Deliverables:
- Structured compaction pipeline
- Settings + controls for compaction policy
- Preflight context budget warnings

Definition of done:
- Fewer coherence regressions in long chats
- Compaction is transparent and user-controllable

---

### Employee 4: Conversation UX Engineer
Owner focus:
- Editing, branching, and continuation ergonomics

Primary tasks:
1. Implement visible branch tree navigation for regenerated answers.
2. Add immutable edit revision history and replay-from-point workflow.
3. Improve queue/generation UX messaging (ETA, reasons, status chips).
4. Add unfinished-task continuation cards.

Deliverables:
- Branch-aware conversation timeline UX
- Edit/retry reliability controls
- Continuation affordances for interrupted tasks

Definition of done:
- Multi-step tasks can be resumed easily
- Users can inspect and switch branches predictably

---

### Employee 5: Attachment Grounding + Observability Engineer
Owner focus:
- Trustworthy file-based answers and operational visibility

Primary tasks:
1. Build attachment pipeline: normalize, chunk, index, cache by content hash.
2. Add answer grounding references (chunk citations + source panel).
3. Add observability dashboard cards:
   - queue depth
   - active slots
   - first token latency
   - completion latency
   - error rates
4. Add request-id correlation from frontend to inference manager logs.

Deliverables:
- Grounded response UX for attachments
- Performance/health dashboard in app
- Correlated logs for faster incident triage

Definition of done:
- Attachment answers show clear source mapping
- Incidents can be diagnosed with request correlation

---

## Weekly Plan

### Week 1: Reliability Foundation
- Employee 1: Stream state machine + queue cancellation
- Employee 2: Draft and session persistence baseline
- Employee 5: Initial metrics cards + request-id plumbing

Milestone:
- No queue deadlocks under controlled fault tests

### Week 2: Recovery + Persistence
- Employee 2: Full refresh/crash recovery flow
- Employee 1: Deadlock self-heal and timeout fallback polish
- Employee 4: Queue UX status semantics and empty/error states

Milestone:
- In-progress chat survives hard refresh reliably

### Week 3: Context/Mem Quality
- Employee 3: Structured compaction + threshold settings
- Employee 4: Revision timeline + replay scaffolding
- Employee 5: Baseline attachment ingestion pipeline

Milestone:
- Long conversations stay coherent beyond 80% context usage

### Week 4: UX + Grounding
- Employee 4: Branch tree and continuation cards
- Employee 5: Grounding citations and source panel
- Employee 3: Compact preview + pin protection

Milestone:
- Users can trace and trust attachment-grounded answers

### Week 5: Integration + Hardening
- All: Integration, bug bash, perf passes, release checklist
- Employee 1 + 5: chaos/load test + observability tuning
- Employee 2 + 3 + 4: UX polish and edge-case fixes

Milestone:
- Production-ready robust chat experience

## Quality Gates (Each Week)
1. Functional tests pass for WS/SSE queue flows.
2. Disconnect/reconnect chaos tests pass.
3. No regression in message persistence and title generation.
4. Metrics instrumentation validated in dashboard.
5. Demo scenario run-through completed and recorded.

## KPIs
- Queue stall incident rate
- p95 first token latency
- p95 completion latency
- Recovery success rate after hard refresh
- Long-chat coherence satisfaction (manual QA rubric)
- Attachment grounding accuracy (citation match rate)

## Risks and Mitigations
- Risk: slot accounting regressions under disconnect storms
  - Mitigation: strict in-flight lifecycle tests + deadlock monitor
- Risk: compaction degrades answer quality
  - Mitigation: structured memory format + pin exclusions + preview
- Risk: attachment ingestion slows response time
  - Mitigation: async indexing + cache + incremental grounding

## Next Implementation Slice (Suggested)
1. Employee 1: deadlock alarm + self-heal
2. Employee 2: refresh recovery MVP
3. Employee 3: compaction threshold selector
4. Employee 5: metrics panel (`queue_depth`, `active_slots`, `ttfb`)
5. Employee 4: generation status UX refinement
