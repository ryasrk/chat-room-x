import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDefaultAgents } from './defaultAgents.js';

test('default agent-room agents use enowxai provider configs', () => {
  let nextId = 0;
  const agents = buildDefaultAgents(() => `agent-${++nextId}`);

  assert.deepEqual(agents.map((agent) => agent.name), ['planner', 'coder', 'reviewer', 'scribe']);
  assert.ok(agents.every((agent) => agent.provider_config?.provider === 'enowxai'));
  assert.ok(agents.every((agent) => agent.provider_config?.tool_calling_mode === 'native'));
  assert.equal(agents.find((agent) => agent.name === 'scribe')?.model_tier, 'worker');
});

test('default agents include router_config for xa (cloud router model)', () => {
  let nextId = 0;
  const agents = buildDefaultAgents(() => `agent-${++nextId}`);

  assert.ok(agents.every((agent) => agent.router_config?.provider === 'enowxai'));
  assert.ok(agents.every((agent) => typeof agent.router_config?.model === 'string'));
  assert.ok(agents.every((agent) => agent.router_config?.max_tokens === 512));
});