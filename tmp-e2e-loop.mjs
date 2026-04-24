/**
 * E2E Loop Test: Run conversation flow 5 times
 * Tests consistency of xa/xb classification and self-mention stripping
 */

const base = 'http://localhost:3002';
const username = 'ryasrk';
const password = 'Ryas4321';

let token = '';
let totalPassed = 0;
let totalFailed = 0;
const loopResults = [];

async function api(path, { method = 'GET', body, timeout = 30000 } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    clearTimeout(timer);

    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    return { status: response.status, data };
  } catch (err) {
    clearTimeout(timer);
    return { status: 0, data: { error: err.message } };
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getMessages(data) {
  return (data.messages || []).sort((a, b) => a.created_at - b.created_at);
}

function getAgentMessagesSince(messages, afterTimestamp) {
  return messages.filter(m =>
    m.sender_type === 'agent' &&
    m.event_type === 'message' &&
    m.created_at > afterTimestamp
  );
}

function hasSelfMention(content, senderName) {
  return content.toLowerCase().includes(`@${senderName.toLowerCase()}`);
}

// ═══════════════════════════════════════════════════════════════
// Single Loop
// ═══════════════════════════════════════════════════════════════

async function runSingleLoop(loopNum) {
  let passed = 0;
  let failed = 0;
  const issues = [];

  function assert(condition, label) {
    if (condition) {
      passed++;
    } else {
      failed++;
      issues.push(label);
    }
  }

  const roomName = `Loop ${loopNum} - ${Date.now()}`;

  // Create room
  const createRes = await api('/api/agent-rooms', {
    method: 'POST',
    body: {
      name: roomName,
      description: `Loop test ${loopNum}`,
      workspace_path: `/tmp/loop-test-${loopNum}-${Date.now()}`,
    },
  });
  const roomId = createRes.data?.room?.id || createRes.data?.id || '';
  assert(roomId.length > 0, 'Room created');

  // ── Test 1: Casual Indonesian ─────────────────────────────
  await api(`/api/agent-rooms/${roomId}/message`, {
    method: 'POST',
    body: { content: 'Halo! Apa kabar?' },
  });
  await sleep(5000);

  let msgs = getMessages((await api(`/api/agent-rooms/${roomId}/messages`)).data);
  let agentReplies = getAgentMessagesSince(msgs, 0);
  if (agentReplies.length > 0) {
    const r = agentReplies[0];
    assert(!hasSelfMention(r.content, r.sender_name), `[1] Casual: no self-mention`);
  } else {
    assert(false, '[1] Casual: no agent reply');
  }

  // ── Test 2: Random question ───────────────────────────────
  const ts2 = Math.floor(Date.now() / 1000);
  await api(`/api/agent-rooms/${roomId}/message`, {
    method: 'POST',
    body: { content: 'Kamu suka makan apa?' },
  });
  await sleep(5000);

  msgs = getMessages((await api(`/api/agent-rooms/${roomId}/messages`)).data);
  agentReplies = getAgentMessagesSince(msgs, ts2 - 1);
  if (agentReplies.length > 0) {
    const r = agentReplies[0];
    assert(!hasSelfMention(r.content, r.sender_name), `[2] Random: no self-mention`);
  } else {
    assert(false, '[2] Random: no agent reply');
  }

  // ── Test 3: Thanks ────────────────────────────────────────
  const ts3 = Math.floor(Date.now() / 1000);
  await api(`/api/agent-rooms/${roomId}/message`, {
    method: 'POST',
    body: { content: 'Oke thanks!' },
  });
  await sleep(5000);

  msgs = getMessages((await api(`/api/agent-rooms/${roomId}/messages`)).data);
  agentReplies = getAgentMessagesSince(msgs, ts3 - 1);
  if (agentReplies.length > 0) {
    const r = agentReplies[0];
    assert(!hasSelfMention(r.content, r.sender_name), `[3] Thanks: no self-mention`);
  } else {
    assert(false, '[3] Thanks: no agent reply');
  }

  // ── Test 4: Technical request ─────────────────────────────
  const ts4 = Math.floor(Date.now() / 1000);
  await api(`/api/agent-rooms/${roomId}/message`, {
    method: 'POST',
    body: { content: 'Buatkan file README.md untuk project ini' },
  });
  await sleep(4000);

  msgs = getMessages((await api(`/api/agent-rooms/${roomId}/messages`)).data);
  agentReplies = getAgentMessagesSince(msgs, ts4 - 1);
  if (agentReplies.length > 0) {
    const r = agentReplies[0];
    assert(!hasSelfMention(r.content, r.sender_name), `[4] Tech ack: no self-mention`);
    assert(r.content.length < 250, `[4] Tech ack: brief (${r.content.length} chars)`);
    const claimsDone = /sudah selesai|here.?s the|berikut file/i.test(r.content);
    assert(!claimsDone, `[4] Tech ack: honest (not claiming done)`);
  } else {
    assert(false, '[4] Tech ack: no agent reply');
    assert(false, '[4] Tech ack: brief (no reply)');
    assert(false, '[4] Tech ack: honest (no reply)');
  }

  // ── Test 5: Progress check ────────────────────────────────
  await sleep(2000);
  const ts5 = Math.floor(Date.now() / 1000);
  await api(`/api/agent-rooms/${roomId}/message`, {
    method: 'POST',
    body: { content: '@planner lagi ngapain?' },
  });
  await sleep(5000);

  msgs = getMessages((await api(`/api/agent-rooms/${roomId}/messages`)).data);
  agentReplies = getAgentMessagesSince(msgs, ts5 - 1);
  if (agentReplies.length > 0) {
    const r = agentReplies[0];
    assert(!hasSelfMention(r.content, r.sender_name), `[5] Progress: no self-mention`);
  } else {
    assert(false, '[5] Progress: no agent reply');
  }

  // ── Test 6: Wait for xb + follow-up ──────────────────────
  let xbDone = false;
  for (let i = 0; i < 18; i++) {
    await sleep(5000);
    msgs = getMessages((await api(`/api/agent-rooms/${roomId}/messages`)).data);
    const xbMsgs = msgs.filter(m =>
      m.sender_type === 'agent' &&
      m.created_at > ts4 &&
      m.content.length > 200
    );
    if (xbMsgs.length > 0) {
      xbDone = true;
      for (const xb of xbMsgs) {
        assert(!hasSelfMention(xb.content, xb.sender_name), `[6] xb response: no self-mention (@${xb.sender_name})`);
      }
      break;
    }
  }
  if (!xbDone) {
    assert(false, '[6] xb response: timed out');
  }

  // ── Test 7: Follow-up question ────────────────────────────
  await sleep(1000);
  const ts7 = Math.floor(Date.now() / 1000);
  await api(`/api/agent-rooms/${roomId}/message`, {
    method: 'POST',
    body: { content: 'Gimana hasilnya?' },
  });
  await sleep(8000);

  msgs = getMessages((await api(`/api/agent-rooms/${roomId}/messages`)).data);
  agentReplies = getAgentMessagesSince(msgs, ts7 - 1);
  if (agentReplies.length > 0) {
    const r = agentReplies[0];
    assert(!hasSelfMention(r.content, r.sender_name), `[7] Follow-up: no self-mention`);
  } else {
    assert(false, '[7] Follow-up: no agent reply');
  }

  // ── Test 8: English switch ────────────────────────────────
  const ts8 = Math.floor(Date.now() / 1000);
  await api(`/api/agent-rooms/${roomId}/message`, {
    method: 'POST',
    body: { content: 'What did you create?' },
  });
  await sleep(8000);

  msgs = getMessages((await api(`/api/agent-rooms/${roomId}/messages`)).data);
  agentReplies = getAgentMessagesSince(msgs, ts8 - 1);
  if (agentReplies.length > 0) {
    const r = agentReplies[0];
    assert(!hasSelfMention(r.content, r.sender_name), `[8] English: no self-mention`);
  } else {
    assert(false, '[8] English: no agent reply');
  }

  return { loopNum, passed, failed, issues };
}

// ═══════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════

async function run() {
  console.log('═══ E2E Loop Test: 5 Iterations ═══\n');

  // Login once
  console.log('Logging in...');
  const loginRes = await api('/api/auth/login', {
    method: 'POST',
    body: { username, password },
  });
  token = loginRes.data?.tokens?.access_token || '';
  if (!token) {
    console.error('Login failed!');
    process.exit(1);
  }
  console.log('✅ Logged in\n');

  for (let i = 1; i <= 5; i++) {
    console.log(`━━━ Loop ${i}/5 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    const startTime = Date.now();

    try {
      const result = await runSingleLoop(i);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      totalPassed += result.passed;
      totalFailed += result.failed;
      loopResults.push(result);

      const status = result.failed === 0 ? '✅ ALL PASS' : `❌ ${result.failed} FAIL`;
      console.log(`  ${status} (${result.passed}/${result.passed + result.failed}) — ${elapsed}s`);

      if (result.issues.length > 0) {
        for (const issue of result.issues) {
          console.log(`    ❌ ${issue}`);
        }
      }
      console.log('');
    } catch (err) {
      console.error(`  💥 Loop ${i} crashed: ${err.message}\n`);
      totalFailed++;
      loopResults.push({ loopNum: i, passed: 0, failed: 1, issues: [`Crash: ${err.message}`] });
    }
  }

  // ═══ Summary ═══
  console.log('═══════════════════════════════════════════════════════');
  console.log('SUMMARY');
  console.log('═══════════════════════════════════════════════════════');

  for (const r of loopResults) {
    const status = r.failed === 0 ? '✅' : '❌';
    console.log(`  Loop ${r.loopNum}: ${status} ${r.passed}/${r.passed + r.failed}${r.issues.length > 0 ? ' — ' + r.issues.join(', ') : ''}`);
  }

  console.log(`\n  TOTAL: ${totalPassed} passed, ${totalFailed} failed out of ${totalPassed + totalFailed}`);
  const allPassed = totalFailed === 0;
  console.log(`  ${allPassed ? '🎉 ALL LOOPS PASSED!' : '⚠️  Some tests failed'}`);
  console.log('═══════════════════════════════════════════════════════');

  process.exit(allPassed ? 0 : 1);
}

run().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
