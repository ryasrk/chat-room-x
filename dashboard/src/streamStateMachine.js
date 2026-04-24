/**
 * streamStateMachine.js — Stream state machine with watchdog timer and deadlock detection.
 * States: idle → queued → streaming → finalizing → done | error
 */

// ── State Definitions ──────────────────────────────────────────

export const StreamState = Object.freeze({
  IDLE: 'idle',
  QUEUED: 'queued',
  STREAMING: 'streaming',
  FINALIZING: 'finalizing',
  DONE: 'done',
  ERROR: 'error',
});

const VALID_TRANSITIONS = Object.freeze({
  [StreamState.IDLE]: [StreamState.QUEUED, StreamState.STREAMING, StreamState.ERROR],
  [StreamState.QUEUED]: [StreamState.STREAMING, StreamState.ERROR, StreamState.IDLE],
  [StreamState.STREAMING]: [StreamState.FINALIZING, StreamState.DONE, StreamState.ERROR],
  [StreamState.FINALIZING]: [StreamState.DONE, StreamState.ERROR],
  [StreamState.DONE]: [StreamState.IDLE],
  [StreamState.ERROR]: [StreamState.IDLE],
});

// ── Timeouts (ms) ──────────────────────────────────────────────

const WATCHDOG_TIMEOUTS = Object.freeze({
  [StreamState.QUEUED]: 60_000,      // 60s max in queue
  [StreamState.STREAMING]: 30_000,   // 30s without a token = stalled
  [StreamState.FINALIZING]: 10_000,  // 10s to finalize
});

const DEADLOCK_CHECK_INTERVAL = 5_000; // check every 5s

// ── Stream State Machine ───────────────────────────────────────

export function createStreamStateMachine(options = {}) {
  const { onStateChange, onWatchdogTimeout, onDeadlock } = options;

  let _state = StreamState.IDLE;
  let _lastActivity = Date.now();
  let _watchdogTimer = null;
  let _deadlockTimer = null;
  let _tokenCount = 0;
  let _startTime = 0;
  let _error = null;
  let _queuePosition = null;

  function _clearTimers() {
    if (_watchdogTimer) { clearTimeout(_watchdogTimer); _watchdogTimer = null; }
    if (_deadlockTimer) { clearInterval(_deadlockTimer); _deadlockTimer = null; }
  }

  function _startWatchdog() {
    _clearTimers();
    const timeout = WATCHDOG_TIMEOUTS[_state];
    if (timeout) {
      _watchdogTimer = setTimeout(() => {
        onWatchdogTimeout?.({
          state: _state,
          elapsed: Date.now() - _lastActivity,
          tokenCount: _tokenCount,
        });
        // Auto-transition to error on watchdog timeout
        transition(StreamState.ERROR, new Error(`Watchdog timeout in ${_state} state (${timeout}ms)`));
      }, timeout);
    }

    // Start deadlock detection during streaming
    if (_state === StreamState.STREAMING) {
      _deadlockTimer = setInterval(() => {
        const sinceLastActivity = Date.now() - _lastActivity;
        if (sinceLastActivity > DEADLOCK_CHECK_INTERVAL * 2) {
          onDeadlock?.({
            state: _state,
            sinceLastActivity,
            tokenCount: _tokenCount,
          });
        }
      }, DEADLOCK_CHECK_INTERVAL);
    }
  }

  function transition(newState, errorOrData) {
    const allowed = VALID_TRANSITIONS[_state];
    if (!allowed || !allowed.includes(newState)) {
      console.warn(`[StreamSM] Invalid transition: ${_state} → ${newState}`);
      return false;
    }

    const prevState = _state;
    _state = newState;
    _lastActivity = Date.now();

    if (newState === StreamState.ERROR) {
      _error = errorOrData instanceof Error ? errorOrData : new Error(String(errorOrData || 'Unknown error'));
    }

    if (newState === StreamState.QUEUED && typeof errorOrData === 'number') {
      _queuePosition = errorOrData;
    }

    if (newState === StreamState.STREAMING && prevState !== StreamState.STREAMING) {
      _startTime = _startTime || Date.now();
    }

    _startWatchdog();

    if (newState === StreamState.DONE || newState === StreamState.ERROR) {
      _clearTimers();
    }

    onStateChange?.({ prev: prevState, current: newState, error: _error });
    return true;
  }

  function recordToken() {
    _tokenCount++;
    _lastActivity = Date.now();
    // Reset watchdog on each token
    if (_state === StreamState.STREAMING) {
      _startWatchdog();
    }
  }

  function reset() {
    _clearTimers();
    _state = StreamState.IDLE;
    _lastActivity = Date.now();
    _tokenCount = 0;
    _startTime = 0;
    _error = null;
    _queuePosition = null;
  }

  return {
    get state() { return _state; },
    get tokenCount() { return _tokenCount; },
    get startTime() { return _startTime; },
    get error() { return _error; },
    get queuePosition() { return _queuePosition; },
    get lastActivity() { return _lastActivity; },
    get isActive() { return _state !== StreamState.IDLE && _state !== StreamState.DONE && _state !== StreamState.ERROR; },
    transition,
    recordToken,
    reset,
    destroy() { _clearTimers(); },
  };
}
