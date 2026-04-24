# Employee 5 Context: Attachment Grounding and Observability Engineer

Owner goal:
- Deliver trustworthy attachment-grounded responses and actionable runtime observability.

Current known state:
- Manager metrics already include slot strategy/counters.
- Frontend has queue/model indicators and session token counters.
- Attachment grounding with citation/source panel is not complete.

Primary tasks:
1. Attachment pipeline: normalize -> chunk -> index -> content-hash cache.
2. Grounding UI: answer citations + source panel.
3. Dashboard cards for:
   - queue depth
   - active slots
   - first token latency
   - completion latency
   - error rate
4. Request-id correlation from frontend to manager logs.

Relevant files:
- `dashboard/src/fileManager.js`
- `dashboard/src/chatApi.js`
- `dashboard/src/main.js`
- `dashboard/src/uiUpdaters.js`
- `dashboard/src/tokenCounter.js`
- `dashboard/index.html`
- `dashboard/src/style.css`
- `inference/manager.js`
- `inference/server.py` (if needed for request-id propagation)

Data/contract expectations:
- Citation references must map to deterministic chunk ids.
- Request id should be present in frontend event logs and backend manager logs.
- Metrics card values should degrade gracefully if telemetry endpoint unavailable.

Acceptance criteria:
- Attachment-grounded responses include usable source mapping.
- Latency metrics visible and consistent with manager telemetry.
- Request correlation enables tracing one chat request end-to-end.

Test checklist:
- Upload attachment and verify citation source links/chunk mapping.
- Compare manager metrics endpoint values with dashboard cards.
- Trace one request with request-id from UI to manager logs.

Subagent Brief:
- Implement attachment grounding and telemetry surface with clear contracts.
- Minimize heavy coupling between retrieval and rendering layers.
- Prioritize deterministic ids, stable metrics naming, and graceful failure behavior.
