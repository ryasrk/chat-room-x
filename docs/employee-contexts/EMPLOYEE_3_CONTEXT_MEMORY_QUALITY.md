# Employee 3 Context: Context and Memory Quality Engineer

Owner goal:
- Improve long-chat coherence while controlling token budget transparently.

Current known state:
- Auto-compaction trigger at 80% exists in `dashboard/src/chatApi.js`.
- Settings toggle `autoCompactEnabled` exists with UI sync.
- Current compaction uses summary-like behavior and needs structured memory format.

Primary tasks:
1. Structured compaction blocks with sections:
   - facts
   - decisions
   - tasks
   - constraints
   - open_questions
2. Add threshold selector (70/80/90).
3. Add pinned-message exclusion from compaction.
4. Add context budget preflight warning before dispatch.
5. Add manual compact preview action.

Relevant files:
- `dashboard/src/chatApi.js`
- `dashboard/src/tokenCounter.js`
- `dashboard/src/appState.js`
- `dashboard/src/uiUpdaters.js`
- `dashboard/src/main.js`
- `dashboard/index.html`
- `dashboard/src/style.css`

Data/contract expectations:
- Compaction must preserve recency window and pinned messages.
- Structured compact block should be machine-readable and user-auditable.
- Threshold setting should apply immediately and persist.

Acceptance criteria:
- Long chats beyond threshold remain responsive and coherent.
- Users can choose threshold and manually inspect compact preview.
- Compaction never removes pinned messages.
- Request preflight warns before hard token overflow.

Test checklist:
- Threshold switching at runtime.
- Pinned message preserved after compaction.
- Manual compact preview matches generated compacted memory.
- Repeat compaction does not recursively degrade memory block quality.

Subagent Brief:
- Evolve compaction flow to structured memory, minimal UI friction.
- Reuse existing auto-compact pipeline; avoid duplicate summarization paths.
- Add clear settings controls and preflight warnings with minimal regressions.
