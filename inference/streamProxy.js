export function buildChatCompletionPayload({
  messages,
  max_tokens,
  temperature,
  chat_template_kwargs,
  reasoning_format,
  model,
  reasoning_effort,
}) {
  const MAX_TOKENS_CAP = 8192;
  const msgArray = Array.isArray(messages) ? messages : [];

  // Some providers (e.g. enowxai) reject payloads without a system message.
  const hasSystem = msgArray.some((m) => m.role === 'system');
  const safeMessages = hasSystem
    ? msgArray
    : [{ role: 'system', content: 'You are a helpful assistant.' }, ...msgArray];

  const payload = {
    messages: safeMessages,
    max_tokens: Number.isFinite(max_tokens) ? Math.min(max_tokens, MAX_TOKENS_CAP) : 1024,
    temperature: Number.isFinite(temperature) ? temperature : 0.7,
    stream: true,
  };

  if (chat_template_kwargs && typeof chat_template_kwargs === 'object' && !Array.isArray(chat_template_kwargs)) {
    payload.chat_template_kwargs = chat_template_kwargs;
  }

  if (typeof reasoning_format === 'string' && reasoning_format) {
    payload.reasoning_format = reasoning_format;
  }

  if (typeof model === 'string' && model) {
    payload.model = model;
  }

  if (typeof reasoning_effort === 'string' && reasoning_effort) {
    payload.reasoning_effort = reasoning_effort;
  }

  return JSON.stringify(payload);
}

export function splitSseLines(buffer, chunk = '') {
  const combined = `${buffer}${chunk}`;
  const lines = combined.split('\n');

  return {
    lines: lines.slice(0, -1),
    buffer: lines.at(-1) ?? '',
  };
}

export function parseSseLine(line) {
  if (!line.startsWith('data: ')) {
    return null;
  }

  const data = line.slice(6).trim();
  if (!data) {
    return null;
  }

  if (data === '[DONE]') {
    return { type: 'done' };
  }

  try {
    const payload = JSON.parse(data);
    const deltaPayload = payload.choices?.[0]?.delta;
    const contentDelta = deltaPayload?.content;
    const reasoningDelta = deltaPayload?.reasoning_content;

    if (typeof contentDelta === 'string' && contentDelta) {
      return { type: 'delta', channel: 'content', delta: contentDelta };
    }

    if (typeof reasoningDelta === 'string' && reasoningDelta) {
      return { type: 'delta', channel: 'reasoning', delta: reasoningDelta };
    }

    if (!deltaPayload) {
      return { type: 'meta', payload };
    }

    return { type: 'meta', payload };
  } catch (error) {
    return {
      type: 'invalid',
      message: error instanceof Error ? error.message : 'Invalid SSE payload',
      raw: data,
    };
  }
}
