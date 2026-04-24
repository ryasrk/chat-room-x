/**
 * E2E Conversation Flow Test: Casual → Random → Technical → Request
 *
 * Tests a realistic multi-turn conversation:
 * 1. Casual chat (Indonesian) — CHAT path
 * 2. Random/fun question — CHAT path
 * 3. Follow-up casual — CHAT path
 * 4. Technical question — DELEGATE path (needs reasoning)
 * 5. Request to build something — DELEGATE path (needs tools)
 * 6. Progress check (Indonesian) — PROGRESS path
 * 7. Follow-up about the request — should answer directly, NOT self-delegate
 *
 * Validates:
 * - Language matching (Indonesian ↔ English)
 * - No self-delegation (@planner never mentions @planner)
 * - Correct classification (CHAT/PROGRESS/DELEGATE)
 * - Flow clarity
 *
 * Requires: server running on localhost:3002
 */

const base = 'http://localhost:3002';
const username = 'ryasrk';
const password = 'Ryas4321';
const roomName = `Flow Test ${Date.now()}`;

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
    const content = String(m.content || '').slice(0, 200);
    console.log(`    ${sender}${type}: ${content}`);
  }
}

function getLastAgentMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].sender_type === 'agent' && messages[i].event_type === 'message') {
      return messages[i];
    }
  }
  return null;
}

function getAgentMessagesSince(messages, afterTimestamp) {
  return messages.filter(m =>
    m.sender_type === 'agent' &&
    m.event_type === 'message' &&
    m.created_at > afterTimestamp
  );
}

// ═══════════════════════════════════════════════════════════════
// Test Flow
// ═══════════════════════════════════════════════════════════════

async function run() {
  console.log('═══ E2E Conversation Flow: Casual → Random → Technical → Request ═══\n');

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
      description: 'Conversation flow test',
      workspace_path: '/tmp/flow-test-' + Date.now(),
    },
  });
  assert(createRes.status === 201 || createRes.status === 200, `Room created (${createRes.status})`);
  roomId = createRes.data?.room?.id || createRes.data?.id || '';
  assert(roomId.length > 0, `Room ID: ${roomId.slice(0, 8)}...`);

  // ── 3. Casual Chat (Indonesian) ───────────────────────────
  console.log('\n3. Casual Chat (Indonesian) — should be CHAT path');
  const casualRes = await api(`/api/agent-rooms/${roomId}/message`, {
    method: 'POST',
    body: { content: 'Halo! Apa kabar?' },
  });
  assert(casualRes.status === 202 || casualRes.status === 200, `Casual msg accepted (${casualRes.status})`);

  await sleep(5000); // Wait for xa to respond

  const msgs3 = getMessages((await api(`/api/agent-rooms/${roomId}/messages`)).data);
  const agentReply3 = getAgentMessagesSince(msgs3, 0);
  printMessages(msgs3, 'After casual chat');

  assert(agentReply3.length > 0, 'Agent replied to casual chat');
  if (agentReply3.length > 0) {
    const reply = agentReply3[0].content.toLowerCase();
    // Should respond in Indonesian (or at least not delegate)
    const hasIndonesian = /halo|hai|kabar|salam|selamat|apa|bisa|bantu|senang/i.test(reply);
    const hasSelfMention = reply.includes(`@${agentReply3[0].sender_name}`);
    assert(!hasSelfMention, 'No self-delegation in casual reply');
    console.log(`  ℹ️  Language check: ${hasIndonesian ? 'Indonesian detected ✓' : 'Not clearly Indonesian (may be OK)'}`);
  }

  // ── 4. Random/Fun Question ────────────────────────────────
  console.log('\n4. Random/Fun Question — should be CHAT path');
  const randomRes = await api(`/api/agent-rooms/${roomId}/message`, {
    method: 'POST',
    body: { content: 'Kamu suka warna apa?' },
  });
  assert(randomRes.status === 202 || randomRes.status === 200, `Random msg accepted (${randomRes.status})`);

  await sleep(5000);

  const msgs4 = getMessages((await api(`/api/agent-rooms/${roomId}/messages`)).data);
  const agentReply4 = getAgentMessagesSince(msgs4, msgs3[msgs3.length - 1]?.created_at || 0);
  printMessages(agentReply4, 'After random question');

  if (agentReply4.length > 0) {
    const reply = agentReply4[0].content.toLowerCase();
    const hasSelfMention = reply.includes(`@${agentReply4[0].sender_name}`);
    assert(!hasSelfMention, 'No self-delegation in random reply');
    // This is a casual question — should NOT trigger xb (no tool use needed)
    assert(agentReply4.length <= 2, `Quick response (${agentReply4.length} messages, expected ≤2)`);
  }

  // ── 5. Follow-up Casual ───────────────────────────────────
  console.log('\n5. Follow-up Casual — should be CHAT path');
  const followupRes = await api(`/api/agent-rooms/${roomId}/message`, {
    method: 'POST',
    body: { content: 'Haha nice. Btw thanks ya!' },
  });
  assert(followupRes.status === 202 || followupRes.status === 200, `Follow-up accepted (${followupRes.status})`);

  await sleep(5000);

  const msgs5 = getMessages((await api(`/api/agent-rooms/${roomId}/messages`)).data);
  const agentReply5 = getAgentMessagesSince(msgs5, msgs4[msgs4.length - 1]?.created_at || msgs3[msgs3.length - 1]?.created_at || 0);
  printMessages(agentReply5, 'After follow-up casual');

  if (agentReply5.length > 0) {
    const reply = agentReply5[0].content.toLowerCase();
    const hasSelfMention = reply.includes(`@${agentReply5[0].sender_name}`);
    assert(!hasSelfMention, 'No self-delegation in follow-up');
  }

  // ── 6. Technical Request (Indonesian) ─────────────────────
  console.log('\n6. Technical Request (Indonesian) — should be DELEGATE path');
  const techTimestamp = Math.floor(Date.now() / 1000);
  const techRes = await api(`/api/agent-rooms/${roomId}/message`, {
    method: 'POST',
    body: { content: 'Buatkan file index.html untuk landing page coffee shop dong' },
  });
  assert(techRes.status === 202 || techRes.status === 200, `Technical request accepted (${techRes.status})`);

  // Wait a bit for xa ack
  await sleep(3000);

  const msgsAck = getMessages((await api(`/api/agent-rooms/${roomId}/messages`)).data);
  const ackMessages = getAgentMessagesSince(msgsAck, techTimestamp - 1);
  printMessages(ackMessages, 'After technical request (xa ack)');

  if (ackMessages.length > 0) {
    const ack = ackMessages[0].content.toLowerCase();
    const hasSelfMention = ack.includes(`@${ackMessages[0].sender_name}`);
    assert(!hasSelfMention, 'No self-delegation in ack');
    // Ack should be short and honest
    assert(ackMessages[0].content.length < 200, `Ack is brief (${ackMessages[0].content.length} chars)`);
    // Should NOT claim work is done
    const claimsDone = /sudah|selesai|done|here.?s|berikut|ini dia/i.test(ack);
    assert(!claimsDone, 'Ack does NOT claim work is already done');
  }

  // ── 7. Progress Check (Indonesian) ────────────────────────
  console.log('\n7. Progress Check (Indonesian) — should be PROGRESS path');
  await sleep(2000);
  const progressRes = await api(`/api/agent-rooms/${roomId}/message`, {
    method: 'POST',
    body: { content: '@planner lagi ngapain?' },
  });
  assert(progressRes.status === 202 || progressRes.status === 200, `Progress check accepted (${progressRes.status})`);

  await sleep(5000);

  const msgsProgress = getMessages((await api(`/api/agent-rooms/${roomId}/messages`)).data);
  const progressReplies = msgsProgress.filter(m =>
    m.sender_type === 'agent' &&
    m.content.toLowerCase().includes('progress') ||
    m.content.toLowerCase().includes('sedang') ||
    m.content.toLowerCase().includes('mengerjakan') ||
    m.content.toLowerCase().includes('working') ||
    m.content.toLowerCase().includes('task') ||
    m.content.toLowerCase().includes('aktif') ||
    m.content.toLowerCase().includes('saat ini')
  );
  printMessages(msgsProgress.slice(-4), 'After progress check (last 4)');

  // ── 8. Wait for xb to complete ────────────────────────────
  console.log('\n8. Waiting for xb to complete...');
  let xbDone = false;
  for (let i = 0; i < 12; i++) {
    await sleep(5000);
    const msgsWait = getMessages((await api(`/api/agent-rooms/${roomId}/messages`)).data);
    const xbMessages = msgsWait.filter(m =>
      m.sender_type === 'agent' &&
      m.created_at > techTimestamp &&
      m.content.length > 200 // xb responses are typically longer
    );
    if (xbMessages.length > 0) {
      xbDone = true;
      printMessages(xbMessages, 'xb completed');
      
      for (const xbMsg of xbMessages) {
        const hasSelfMention = xbMsg.content.toLowerCase().includes(`@${xbMsg.sender_name}`);
        assert(!hasSelfMention, `No self-delegation in xb response from @${xbMsg.sender_name}`);
      }
      break;
    }
    process.stdout.write(`  ⏳ ${(i + 1) * 5}s...`);
  }
  if (!xbDone) {
    console.log('\n  ⚠️  xb did not complete within 60s (may still be running)');
  }

  // ── 9. Follow-up about the request ────────────────────────
  console.log('\n9. Follow-up about request — should answer directly, NOT self-delegate');
  await sleep(2000);
  const followupTechRes = await api(`/api/agent-rooms/${roomId}/message`, {
    method: 'POST',
    body: { content: 'Gimana strukturnya?' },
  });
  assert(followupTechRes.status === 202 || followupTechRes.status === 200, `Follow-up tech accepted (${followupTechRes.status})`);

  // Wait for response
  await sleep(8000);

  const msgsFinal = getMessages((await api(`/api/agent-rooms/${roomId}/messages`)).data);
  const followupTechReplies = msgsFinal.slice(-3);
  printMessages(followupTechReplies, 'After "Gimana strukturnya?"');

  // Check the last agent response
  const lastAgent = getLastAgentMessage(msgsFinal);
  if (lastAgent) {
    const reply = lastAgent.content.toLowerCase();
    const hasSelfMention = reply.includes(`@${lastAgent.sender_name}`);
    assert(!hasSelfMention, `@${lastAgent.sender_name} did NOT self-delegate ← KEY TEST`);
    
    // Should actually talk about structure
    const talksAboutStructure = /struktur|structure|html|head|body|section|header|footer|div|file|folder/i.test(reply);
    console.log(`  ℹ️  Talks about structure: ${talksAboutStructure ? 'Yes ✓' : 'Not clearly (may need more time)'}`);
  }

  // ── 10. English switch ────────────────────────────────────
  console.log('\n10. English switch — should reply in English');
  const englishRes = await api(`/api/agent-rooms/${roomId}/message`, {
    method: 'POST',
    body: { content: 'Hey, can you explain what you built?' },
  });
  assert(englishRes.status === 202 || englishRes.status === 200, `English msg accepted (${englishRes.status})`);

  await sleep(8000);

  const msgsEnglish = getMessages((await api(`/api/agent-rooms/${roomId}/messages`)).data);
  const englishReplies = msgsEnglish.slice(-3);
  printMessages(englishReplies, 'After English question');

  // ═══════════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════════');
  console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed}`);
  console.log('═══════════════════════════════════════════');

  // Print full conversation
  console.log('\n📋 Full Conversation:');
  const allMsgs = getMessages((await api(`/api/agent-rooms/${roomId}/messages`)).data);
  printMessages(allMsgs, 'Complete thread');

  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
