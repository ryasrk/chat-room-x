# Employee 2 Context: Session Persistence and Recovery Engineer

Owner goal:
- Ensure user progress survives refresh/crash and restore flow is explicit and reliable.

Current known state:
- Token/session indicators persist via local storage in `dashboard/src/tokenCounter.js`.
- Active conversation history and chat state are already persisted in existing app flows.
- No complete recovery handshake for interrupted streams yet.

Primary tasks:
1. Persist in-progress stream metadata (request id, mode, message id, timestamp).
2. Recover draft + active conversation + stream metadata after hard refresh.
3. Add `Recovered session` banner with continue/retry action.
4. Introduce schema versioning + migration guards for local storage.

Relevant files:
- `dashboard/src/tokenCounter.js`
- `dashboard/src/chatStorage.js`
- `dashboard/src/chatApi.js`
- `dashboard/src/conversationManager.js`
- `dashboard/src/main.js`
- `dashboard/src/appState.js`
- `dashboard/src/uiUpdaters.js`

Data/contract expectations:
- Persisted state includes `state_version`.
- Migration path must be forward-only and safe-fallback on parse errors.
- Recovery must never crash UI on corrupt storage.
- Recovery banner should be dismissible and not reappear after user resolution.

Acceptance criteria:
- Hard refresh during compose does not lose draft.
- Hard refresh during/after interrupted generation offers continue/retry path.
- Old storage payloads migrate cleanly to latest schema.
- Corrupt local storage resets safely and logs warning.

Test checklist:
- Refresh with active draft.
- Refresh during queued state.
- Refresh during streaming state.
- Load app with intentionally malformed local storage JSON.

Subagent Brief:
- Build robust session recovery module in listed files.
- Keep persistence keys stable where possible; add versioned migration for new keys.
- Add user-visible recovery UX that is clear and non-blocking.
- Keep code defensive around storage access errors.
