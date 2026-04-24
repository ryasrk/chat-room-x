const base = 'http://localhost:3002';
const username = 'ryasrk';
const password = 'Ryas4321';
const roomName = `E2E Calculator ${Date.now()}`;
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

function tailMessages(messages) {
  return messages.slice(-12).map((message) => ({
    sender: message.sender_name,
    type: message.event_type,
    content: String(message.content || '').slice(0, 180),
  }));
}

function tailLogs(logs) {
  return logs.slice(-12).map((log) => ({
    agent: log.agent_name,
    level: log.level,
    message: log.message,
    meta: log.meta || {},
  }));
}

async function main() {
  const login = await api('/api/auth/login', {
    method: 'POST',
    body: { username, password },
  });
  if (login.status !== 200) {
    console.log(JSON.stringify({ stage: 'login', login }, null, 2));
    process.exit(1);
  }

  const token = login.data.tokens.access_token;
  const createdRoom = await api('/api/rooms', {
    method: 'POST',
    token,
    body: {
      name: roomName,
      description: 'Fresh AI Agent room for calculator E2E.',
      category: 'ai-agents',
    },
  });
  if (createdRoom.status !== 201) {
    console.log(JSON.stringify({ stage: 'create-room', createdRoom }, null, 2));
    process.exit(1);
  }

  const projectRoomId = createdRoom.data.room.id;
  const linked = await api(`/api/rooms/${projectRoomId}/agent-room`, { token });
  if (linked.status !== 200) {
    console.log(JSON.stringify({ stage: 'link-agent-room', linked }, null, 2));
    process.exit(1);
  }

  const agentRoomId = linked.data.room.id;
  const queued = await api(`/api/agent-rooms/${agentRoomId}/message`, {
    method: 'POST',
    token,
    body: { content: prompt },
  });
  if (queued.status !== 202) {
    console.log(JSON.stringify({ stage: 'queue-message', queued }, null, 2));
    process.exit(1);
  }

  const snapshots = [];
  for (let attempt = 1; attempt <= 14; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const [messages, logs, files] = await Promise.all([
      api(`/api/agent-rooms/${agentRoomId}/messages?limit=200`, { token }),
      api(`/api/agent-rooms/${agentRoomId}/logs?limit=200`, { token }),
      api(`/api/agent-rooms/${agentRoomId}/files?path=.`, { token }),
    ]);

    const messageList = messages.data.messages || [];
    const logList = logs.data.logs || [];
    const fileList = files.data.files || [];
    snapshots.push({
      attempt,
      messages: tailMessages(messageList),
      logs: tailLogs(logList),
      files: fileList.map((entry) => entry.path),
    });

    const hasReviewer = messageList.some((message) => message.sender_name === 'reviewer');
    const hasCalcFile = fileList.some((entry) => String(entry.path).includes('calculator'));
    const hasPlanFile = fileList.some((entry) => String(entry.path).includes('plan'));
    const hasReviewFile = fileList.some((entry) => String(entry.path).includes('review'));
    const hasToolError = logList.some((log) => String(log.level) === 'error');

    if ((hasPlanFile && hasCalcFile) || hasReviewer || hasReviewFile || hasToolError) {
      break;
    }
  }

  console.log(JSON.stringify({
    url: 'http://localhost:3000',
    projectRoomId,
    agentRoomId,
    roomName,
    prompt,
    snapshots,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ stage: 'script-error', message: error.message, stack: error.stack }, null, 2));
  process.exit(1);
});
