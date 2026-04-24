import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDefaultAgents } from './defaultAgents.js';

test('default agent-room agents use enowxai provider configs', () => {
  let nextId = 0;
  const agents = buildDefaultAgents(() => `agent-${++nextId}`);

  assert.deepEqual(agents.map((agent) => agent.name), ['planner', 'coder', 'reviewer']);
  assert.ok(agents.every((agent) => agent.provider_config?.provider === 'enowxai'));
  assert.ok(agents.every((agent) => agent.provider_config?.tool_calling_mode === 'native'));
});

test('default agents follow pipeline flow (planner → coder → reviewer)', () => {
  let nextId = 0;
  const agents = buildDefaultAgents(() => `agent-${++nextId}`);

  const planner = agents.find((a) => a.name === 'planner');
  const coder = agents.find((a) => a.name === 'coder');
  const reviewer = agents.find((a) => a.name === 'reviewer');

  assert.equal(planner.model_tier, 'brain');
  assert.equal(coder.model_tier, 'worker');
  assert.equal(reviewer.model_tier, 'worker');

  // Pipeline prompts reference the next agent in the chain
  assert.ok(planner.system_prompt.includes('@coder'));
  assert.ok(coder.system_prompt.includes('@reviewer'));

  // No router_config — XA classification removed
  assert.ok(agents.every((agent) => !agent.router_config));
});