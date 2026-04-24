const base = 'http://localhost:3002';
const username = 'ryasrk';
const password = 'Ryas4321';
const prompt = '@planner plan and build a simple calculator, hand off implementation and review, use tools as needed, and summarize what you created.';

async function api(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  return { status: response.status, data };
}

function compactMessages(messages) {
  return messages.slice(-10).map((message) => ({
    sender: message.sender_name,
    type: message.event_type,
    content: String(message.content || '').slice(0, 160),
  }));
}

function compactLogs(logs) {
  return logs.slice(-10).map((log) => ({
    agent: log.agent_name,
    level: log.level,
    message: log.message,
  }));
}

async function main() {
  const login = await api('/api/auth/login', {
    method: 'POST',
    body: { username, password },
  });
  console.log('LOGIN', JSON.stringify(login, null, 2));
  if (login.status !== 200) process.exit(1);

  const token = login.data.tokens.access_token;
  const rooms = await api('/api/rooms', { token });
  console.log('ROOMS', JSON.stringify(rooms, null, 2));
  if (rooms.status !== 200) process.exit(1);

  let room = (rooms.data.rooms || []).find((entry) => entry.category === 'ai-agents');
  if (!room) {
    const created = await api('/api/rooms', {
      method: 'POST',
      token,
      body: {
        name: 'E2E Calculator Test',
        description: 'Test AI Agent orchestration',
        category: 'ai-agents',
      },
    });
    console.log('CREATED_ROOM', JSON.stringify(created, null, 2));
    if (created.status !== 201) process.exit(1);
    room = created.data.room;
  }

  const linked = await api(`/api/rooms/${room.id}/agent-room`, { token });
  console.log('LINKED_AGENT_ROOM', JSON.stringify(linked, null, 2));
  if (linked.status !== 200) process.exit(1);

  const agentRoomId = linked.data.room.id;
  const queued = await api(`/api/agent-rooms/${agentRoomId}/message`, {
    method: 'POST',
    token,
    body: { content: prompt },
  });
  console.log('QUEUED', JSON.stringify(queued, null, 2));
  if (queued.status !== 202) process.exit(1);

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const [messages, logs, files] = await Promise.all([
      api(`/api/agent-rooms/${agentRoomId}/messages?limit=100`, { token }),
      api(`/api/agent-rooms/${agentRoomId}/logs?limit=100`, { token }),
      api(`/api/agent-rooms/${agentRoomId}/files?path=.`, { token }),
    ]);

    const messageList = messages.data.messages || [];
    const logList = logs.data.logs || [];
    const fileList = files.data.entries || [];

    console.log(`POLL ${attempt}`, JSON.stringify({
      messageCount: messageList.length,
      logCount: logList.length,
      fileCount: fileList.length,
      messages: compactMessages(messageList),
      logs: compactLogs(logList),
      files: fileList.map((entry) => entry.path),
    }, null, 2));

    const done = messageList.some((message) => ['planner', 'coder', 'reviewer'].includes(message.sender_name))
      || fileList.some((entry) => String(entry.path).includes('calculator'))
      || logList.some((log) => String(log.level) === 'error');

    if (done) {
      break;
    }
  }
}

main().catch((error) => {
  console.error('SCRIPT_ERROR', error);
  process.exit(1);
});
