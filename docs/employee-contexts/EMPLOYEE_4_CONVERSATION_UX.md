# Employee 4 Context: Conversation UX Engineer

Owner goal:
- Make edit/regenerate flows traceable, branch-aware, and easy to continue.

Current known state:
- Generation status UX has been improved, and `new chat` is blocked during active stream.
- Export modal and queue chip UX were modernized.
- Full branch tree and immutable revision timeline are not implemented yet.

Primary tasks:
1. Branch tree navigation for regenerated answers.
2. Immutable edit revision history.
3. Replay-from-point workflow.
4. Better queue/generation status messaging (ETA/reason/status chips where possible).
5. Unfinished-task continuation cards.

Relevant files:
- `dashboard/src/messageRenderer.js`
- `dashboard/src/conversationManager.js`
- `dashboard/src/chatApi.js`
- `dashboard/src/main.js`
- `dashboard/src/appState.js`
- `dashboard/index.html`
- `dashboard/src/style.css`

Data/contract expectations:
- Existing conversation history must remain backward compatible.
- Branch lineage must be deterministic (`parentMessageId` style relation).
- Replay must not mutate old branches.

Acceptance criteria:
- User can switch between regenerated answer branches.
- User can inspect edit history and replay from selected revision.
- Interrupted tasks show continuation affordance without forcing auto-action.

Test checklist:
- Create multiple regenerations from one user turn.
- Edit a prior turn, replay from point, verify old branch preserved.
- Confirm branch switching updates visible assistant message deterministically.

Subagent Brief:
- Implement minimal but robust branch and revision UX in listed files.
- Preserve existing conversation behavior for users who never use branching.
- Keep data model explicit and immutable where possible.
