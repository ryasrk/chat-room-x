import test from 'node:test';
import assert from 'node:assert/strict';

import { getMissingHandoffMessages, getRoomOrchestrationConfig, selectReactingAgents } from './orchestratorEngine.js';

const agents = [
  { name: 'planner', role: 'Breaks work into steps and coordinates implementation.', system_prompt: '' },
  { name: 'coder', role: 'Implements code and updates files in the workspace.', system_prompt: '' },
  { name: 'reviewer', role: 'Reviews proposals and checks quality risks.', system_prompt: '' },
];

test('getRoomOrchestrationConfig defaults to reactive mode and clamps autonomy', () => {
  assert.deepEqual(
    getRoomOrchestrationConfig({ orchestration_mode: 'invalid', autonomy_level: 99 }),
    {
      mode: 'reactive',
      autonomyLevel: 3,
      maxCycles: 20,
      maxAgentsPerCycle: 4,
      maxTurnsPerAgent: 4,
    },
  );

  assert.deepEqual(
    getRoomOrchestrationConfig({ autonomy_level: -5 }),
    {
      mode: 'reactive',
      autonomyLevel: 0,
      maxCycles: 8,
      maxAgentsPerCycle: 1,
      maxTurnsPerAgent: 2,
    },
  );
});

test('getRoomOrchestrationConfig keeps legacy limits fixed', () => {
  assert.deepEqual(
    getRoomOrchestrationConfig({ orchestration_mode: 'legacy', autonomy_level: 2 }),
    {
      mode: 'legacy',
      autonomyLevel: 2,
      maxCycles: 4,
      maxAgentsPerCycle: 1,
      maxTurnsPerAgent: 1,
    },
  );
});

test('selectReactingAgents restricts reactive replies to the mentioned agent', () => {
  const selected = selectReactingAgents({
    agents,
    triggerMessage: {
      sender_type: 'user',
      sender_name: 'alice',
      content: '@coder please update the parser',
      event_type: 'message',
    },
    roomConfig: {
      mode: 'reactive',
      maxCycles: 9,
      maxAgentsPerCycle: 4,
      maxTurnsPerAgent: 2,
    },
  });

  assert.deepEqual(selected.map(({ agent }) => agent.name), ['coder']);
});

test('selectReactingAgents falls back to planner for legacy user messages', () => {
  const selected = selectReactingAgents({
    agents,
    triggerMessage: {
      sender_type: 'user',
      sender_name: 'alice',
      content: 'Need a plan for this room',
      event_type: 'message',
    },
    roomConfig: {
      mode: 'legacy',
      maxCycles: 4,
      maxAgentsPerCycle: 1,
      maxTurnsPerAgent: 1,
    },
  });

  assert.deepEqual(selected.map(({ agent }) => agent.name), ['planner']);
});

test('selectReactingAgents stops exhausted agents from re-entering the queue', () => {
  const selected = selectReactingAgents({
    agents,
    triggerMessage: {
      sender_type: 'agent',
      sender_name: 'planner',
      content: '@coder please implement the workspace update',
      event_type: 'handoff',
    },
    roomConfig: {
      mode: 'reactive',
      maxCycles: 9,
      maxAgentsPerCycle: 4,
      maxTurnsPerAgent: 1,
    },
    responseCounts: new Map([['coder', 1]]),
  });

  assert.deepEqual(selected, []);
});

test('selectReactingAgents ignores plain agent messages that only mention teammates in prose', () => {
  const selected = selectReactingAgents({
    agents,
    triggerMessage: {
      sender_type: 'agent',
      sender_name: 'planner',
      content: 'I will delegate implementation to @coder after I finish the plan.',
      event_type: 'message',
    },
    roomConfig: {
      mode: 'reactive',
      maxCycles: 9,
      maxAgentsPerCycle: 4,
      maxTurnsPerAgent: 2,
    },
  });

  assert.deepEqual(selected, []);
});

test('selectReactingAgents does not auto-trigger follow-up turns from proposal events', () => {
  const selected = selectReactingAgents({
    agents,
    triggerMessage: {
      sender_type: 'agent',
      sender_name: 'planner',
      content: 'Proposal: calculator scope\n\nReview requested from: @reviewer',
      event_type: 'proposal',
    },
    roomConfig: {
      mode: 'reactive',
      maxCycles: 9,
      maxAgentsPerCycle: 4,
      maxTurnsPerAgent: 2,
    },
  });

  assert.deepEqual(selected, []);
});

test('selectReactingAgents limits handoff events to the first mentioned target', () => {
  const selected = selectReactingAgents({
    agents,
    triggerMessage: {
      sender_type: 'agent',
      sender_name: 'planner',
      content: '@coder Please implement the calculator, then ask @reviewer to inspect it.',
      event_type: 'handoff',
    },
    roomConfig: {
      mode: 'reactive',
      maxCycles: 9,
      maxAgentsPerCycle: 4,
      maxTurnsPerAgent: 2,
    },
  });

  assert.deepEqual(selected.map(({ agent }) => agent.name), ['coder']);
});

test('selectReactingAgents follows textual mention order even when sender is listed earlier in agent order', () => {
  const selected = selectReactingAgents({
    agents,
    triggerMessage: {
      sender_type: 'agent',
      sender_name: 'planner',
      content: '@coder Continue the delegated room task from @planner.',
      event_type: 'handoff',
    },
    roomConfig: {
      mode: 'reactive',
      maxCycles: 9,
      maxAgentsPerCycle: 4,
      maxTurnsPerAgent: 2,
    },
  });

  assert.deepEqual(selected.map(({ agent }) => agent.name), ['coder']);
});

test('getMissingHandoffMessages creates one explicit handoff when only a plain message mention exists', () => {
  const missing = getMissingHandoffMessages({
    senderName: 'planner',
    postedMessages: [
      {
        sender_type: 'agent',
        sender_name: 'planner',
        content: 'Plan saved in notes/plans.txt. @coder please implement the calculator next.',
        event_type: 'message',
      },
    ],
    handoffs: [
      {
        agentName: 'coder',
        message: 'Plan saved in notes/plans.txt. @coder please implement the calculator next.',
      },
    ],
    agents,
  });

  assert.equal(missing.length, 1);
  assert.equal(missing[0].event_type, 'handoff');
  assert.match(missing[0].content, /^@coder\b/);
  assert.doesNotMatch(missing[0].content, /@reviewer/);
});

test('getMissingHandoffMessages skips targets already covered by an explicit handoff', () => {
  const missing = getMissingHandoffMessages({
    senderName: 'planner',
    postedMessages: [
      {
        sender_type: 'agent',
        sender_name: 'planner',
        content: '@coder Implement src/calculator.js using notes/plans.txt.',
        event_type: 'handoff',
      },
    ],
    handoffs: [
      {
        agentName: 'coder',
        message: 'Plan saved in notes/plans.txt. @coder please implement the calculator next.',
      },
    ],
    agents,
  });

  assert.deepEqual(missing, []);
});