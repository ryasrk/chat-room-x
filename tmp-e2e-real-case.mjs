/**
 * E2E Real Case Test: xa/xb Dual-Model Architecture
 *
 * Tests a realistic workflow:
 * 1. Create a new room with workspace
 * 2. Send a greeting (CHAT path — xa handles)
 * 3. Ask a real coding question (DELEGATE path — xa acks, xb works)
 * 4. Check progress while xb works (PROGRESS path)
 * 5. Wait for xb to complete and verify result
 * 6. Send a follow-up question (CHAT path)
 *
 * Requires: server running on localhost:3002
 */

const base = 'http://localhost:3002';
const username = 'ryasrk';
const password = 'Ryas4321';
const roomName = `Real Case ${Date.now()}`;

let token = '';
let roomId = '';
let passed = 0;
let failed = 0;

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

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    failed++;
  }
}

function getMessages(data) {
  return (data.messages || []).sort((a, b) => a.created_at - b.created_at);
}

function printMessages(messages, label = '') {
  if (label) console.log(`\n  📨 ${label}:`);
  for (const m of messages) {
    const sender = m.sender_type === 'user' ? m.sender_name : `@${m.sender_name}`;
    const type = m.event_type !== 'message' ? ` [${m.event_type}]` : '';
    const content = String(m.content || '').slice(0, 150);
    console.log(`    ${sender}${type}: ${content}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// Test Flow
// ═══════════════════════════════════════════════════════════════

async function run() {
  console.log('═══ E2E Real Case: xa/xb Architecture ═══\n');

  // ── 1. Login ──────────────────────────────────────────────
  console.log('1. Login');
  const loginRes = await api('/api/auth/login', {
    method: 'POST',
    body: { username, password },
  });
  assert(loginRes.status === 200, `Login OK (${loginRes.status})`);
  token = loginRes.data?.tokens?.access_token || '';
  assert(token.length > 0, 'Got access token');

  // ── 2. Create Room ────────────────────────────────────────
  console.log('\n2. Create Room');
  const createRes = await api('/api/agent-rooms', {
    method: 'POST',
    body: {
      name: roomName,
      description: 'E2E real case test room',
      workspace_path: '/tmp/e2e-real-case',
    },
  });
  assert(createRes.status === 201 || createRes.status === 200, `Room created (${createRes.status})`);
  roomId = createRes.data?.room?.id || '';
  assert(roomId.length > 0, `Room ID: ${roomId.slice(0, 8)}...`);

  // Verify agents have router_config
  const agentsRes = await api(`/api/agent-rooms/${roomId}/agents`);
  const agents = agentsRes.data?.agents || [];
  console.log(`  Agents: ${agents.map(a => a.name).join(', ')}`);
  const agentsWithRouter = agents.filter(a => a.router_config && Object.keys(a.router_config).length > 0);
  assert(agentsWithRouter.length === agents.length, `All ${agents.length} agents have router_config`);

  // ── 3. CHAT Path — Greeting ───────────────────────────────
  console.log('\n3. CHAT Path — Greeting');
  const chatStart = Date.now();
  const chatRes = await api(`/api/agent-rooms/${roomId}/message`, {
    method: 'POST',
    body: { content: 'Hi team! How are you doing today?' },
  });
  assert(chatRes.status === 202, `Message queued (${chatRes.status})`);

  // Wait for xa to respond (should be fast — <3s)
  await sleep(5000);
  const chatMessages = await api(`/api/agent-rooms/${roomId}/messages`);
  const msgs1 = getMessages(chatMessages.data);
  const chatLatency = Date.now() - chatStart;

  const agentReplies = msgs1.filter(m => m.sender_type === 'agent');
  assert(agentReplies.length > 0, `Got ${agentReplies.length} agent reply(ies) in ${chatLatency}ms`);
  printMessages(msgs1.slice(-5), 'Recent messages');

  // Verify it was xa (fast path) — should be quick and no tool calls
  const plannerReply = agentReplies.find(m => m.sender_name === 'planner');
  if (plannerReply) {
    assert(plannerReply.content.length > 5, `Planner replied: "${plannerReply.content.slice(0, 80)}..."`);
  }

  // ── 4. DELEGATE Path — Real Coding Task ───────────────────
  console.log('\n4. DELEGATE Path — Real Coding Task');
  const delegateStart = Date.now();
  const delegateRes = await api(`/api/agent-rooms/${roomId}/message`, {
    method: 'POST',
    body: { content: '@coder Create a Python file called fibonacci.py that has a function to calculate the nth fibonacci number using memoization. Include a main block that prints fib(10).' },
  });
  assert(delegateRes.status === 202, `Delegate message queued (${delegateRes.status})`);

  // Wait a moment for xa ack
  await sleep(3000);
  const ackMessages = await api(`/api/agent-rooms/${roomId}/messages`);
  const msgs2 = getMessages(ackMessages.data);
  const ackLatency = Date.now() - delegateStart;

  // Find the ack from coder (should appear quickly)
  const coderMsgs = msgs2.filter(m => m.sender_name === 'coder' && m.sender_type === 'agent');
  const hasAck = coderMsgs.length > 0;
  assert(hasAck, `Coder ack received in ${ackLatency}ms`);
  if (hasAck) {
    const ackContent = coderMsgs[coderMsgs.length - 1].content;
    // Verify honest ack (not pretending to have done it)
    const dishonestPatterns = /I('ve| have) (created|written|made|generated)/i;
    const isHonest = !dishonestPatterns.test(ackContent);
    assert(isHonest, `Ack is honest: "${ackContent.slice(0, 100)}"`);
  }

  // ── 5. PROGRESS Path — Check while xb works ──────────────
  console.log('\n5. PROGRESS Path — Check Progress');
  await sleep(2000); // Give xb a moment to start
  const progressRes = await api(`/api/agent-rooms/${roomId}/message`, {
    method: 'POST',
    body: { content: "how's it going? any progress?" },
  });
  assert(progressRes.status === 202, `Progress query queued (${progressRes.status})`);

  // Wait for progress response
  await sleep(5000);
  const progressMessages = await api(`/api/agent-rooms/${roomId}/messages`);
  const msgs3 = getMessages(progressMessages.data);

  // Find progress-related responses
  const afterProgress = msgs3.filter(m =>
    m.sender_type === 'agent' &&
    m.created_at > (delegateStart / 1000)
  );
  printMessages(afterProgress.slice(-8), 'Messages after delegate');

  // ── 6. Wait for xb completion ─────────────────────────────
  console.log('\n6. Wait for xb Completion');
  let xbDone = false;
  let finalMessages = [];
  for (let i = 0; i < 12; i++) { // Max 60s wait
    await sleep(5000);
    const res = await api(`/api/agent-rooms/${roomId}/messages`);
    finalMessages = getMessages(res.data);

    // Check if coder posted a final message with code
    const coderFinal = finalMessages.filter(m =>
      m.sender_name === 'coder' &&
      m.sender_type === 'agent' &&
      (m.content.includes('fibonacci') || m.content.includes('fib') || m.content.includes('write_file'))
    );

    // Also check for handoffs (coder → reviewer)
    const handoffs = finalMessages.filter(m => m.event_type === 'handoff');

    if (coderFinal.length >= 2 || handoffs.length > 0) {
      xbDone = true;
      console.log(`  ⏱ xb completed after ${Math.round((Date.now() - delegateStart) / 1000)}s`);
      break;
    }
    console.log(`  ⏳ Waiting... (${(i + 1) * 5}s)`);
  }
  assert(xbDone, 'xb completed the task');

  // Print final conversation
  printMessages(finalMessages.slice(-12), 'Final conversation');

  // Check for file creation
  const fileMessages = finalMessages.filter(m =>
    m.content && (m.content.includes('fibonacci.py') || m.content.includes('write_file'))
  );
  assert(fileMessages.length > 0, `File creation mentioned in ${fileMessages.length} message(s)`);

  // Check for handoff chain (coder → reviewer)
  const handoffMsgs = finalMessages.filter(m => m.event_type === 'handoff');
  console.log(`  Handoffs: ${handoffMsgs.length}`);
  if (handoffMsgs.length > 0) {
    // Check no duplicates to same agent
    const handoffTargets = handoffMsgs.map(m => {
      const match = m.content.match(/@(\w+)/);
      return match ? match[1] : 'unknown';
    });
    const uniqueTargets = new Set(handoffTargets);
    assert(uniqueTargets.size === handoffTargets.length, `No duplicate handoffs (${handoffTargets.join(', ')})`);
  }

  // ── 7. Follow-up CHAT ─────────────────────────────────────
  console.log('\n7. Follow-up CHAT');
  await sleep(3000);
  const followupRes = await api(`/api/agent-rooms/${roomId}/message`, {
    method: 'POST',
    body: { content: 'Thanks! That looks great.' },
  });
  assert(followupRes.status === 202, `Follow-up queued (${followupRes.status})`);

  await sleep(5000);
  const followupMessages = await api(`/api/agent-rooms/${roomId}/messages`);
  const msgs4 = getMessages(followupMessages.data);
  const followupReplies = msgs4.filter(m =>
    m.sender_type === 'agent' &&
    m.created_at > (Date.now() / 1000 - 10)
  );
  assert(followupReplies.length > 0, `Got ${followupReplies.length} follow-up reply(ies)`);
  printMessages(followupReplies.slice(-3), 'Follow-up replies');

  // ── 8. Token Usage Check ──────────────────────────────────
  console.log('\n8. Token Usage');
  const usageRes = await api(`/api/agent-rooms/${roomId}/token-usage`);
  if (usageRes.status === 200 && usageRes.data?.usage) {
    const usage = usageRes.data.usage;
    console.log(`  Total tokens: ${JSON.stringify(usage)}`);
  } else {
    console.log(`  Token usage endpoint: ${usageRes.status} (may not be implemented)`);
  }

  // ── Summary ───────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════');
  console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} assertions`);
  console.log(`Room: ${roomName} (${roomId.slice(0, 8)}...)`);
  console.log('═══════════════════════════════════════════');

  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
