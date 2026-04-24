import test from 'node:test';
import assert from 'node:assert/strict';

import { extractToolCalls, getAllowedCollaborationToolNames, getRoleOperatingGuidance, getToolCallingMode, isSimpleQuery, isProgressQuery, stripSelfMentions, shouldAgentRespond } from './reactiveAgent.js';

const agents = [
  { name: 'planner', role: 'Breaks work into steps and coordinates implementation.', system_prompt: '' },
  { name: 'coder', role: 'Implements code and updates files in the workspace.', system_prompt: '' },
  { name: 'reviewer', role: 'Reviews proposals and checks quality risks.', system_prompt: '' },
];

test('shouldAgentRespond returns direct-mention priority', () => {
  const decision = shouldAgentRespond(
    agents[1],
    { sender_type: 'user', sender_name: 'alice', content: '@coder please update the parser', event_type: 'message' },
    { agents },
  );

  assert.equal(decision.respond, true);
  assert.equal(decision.reason, 'directly_mentioned');
  assert.equal(decision.priority, 1);
});

test('shouldAgentRespond gives planner default ownership for unmentioned user messages', () => {
  const decision = shouldAgentRespond(
    agents[0],
    { sender_type: 'user', sender_name: 'alice', content: 'Build a new agent room workflow', event_type: 'message' },
    { agents },
  );

  assert.equal(decision.respond, true);
  assert.equal(decision.reason, 'planner_default');
});

test('shouldAgentRespond asks reviewers to inspect proposals sent to all', () => {
  const decision = shouldAgentRespond(
    agents[2],
    { sender_type: 'agent', sender_name: 'planner', content: 'Proposal: use a queue\n\nReview requested from: @all', event_type: 'proposal' },
    { agents },
  );

  assert.equal(decision.respond, true);
  assert.equal(decision.reason, 'proposal_review_requested');
});

test('shouldAgentRespond ignores unrelated messages for non-planner agents', () => {
  const decision = shouldAgentRespond(
    agents[1],
    { sender_type: 'agent', sender_name: 'scribe', content: 'Summary written to notes/summary.md', event_type: 'message' },
    { agents },
  );

  assert.equal(decision.respond, false);
  assert.equal(decision.reason, 'not_relevant');
});

test('extractToolCalls normalizes nested args and common field aliases', () => {
  const calls = extractToolCalls([
    '```json',
    JSON.stringify({ tool: 'read_file', arguments: { file_path: 'notes/plan.md' } }),
    '```',
    '```json',
    JSON.stringify({ tool: 'write_file', params: { filePath: 'src/calculator.js', contents: 'export const ok = true;\n' } }),
    '```',
    '```json',
    JSON.stringify({ tool: 'delegate', args: { to: '@Reviewer', instructions: 'Review src/calculator.js', details: 'Check correctness.' } }),
    '```',
  ].join('\n'));

  assert.deepEqual(calls, [
    { tool: 'read_file', path: 'notes/plan.md' },
    { tool: 'write_file', path: 'src/calculator.js', content: 'export const ok = true;\n' },
    { tool: 'delegate', to_agent: 'reviewer', task: 'Review src/calculator.js', context: 'Check correctness.' },
  ]);
});

test('extractToolCalls parses whole-response JSON payloads with nested params', () => {
  const calls = extractToolCalls(JSON.stringify({
    tool: 'propose',
    params: {
      title: 'Calculator plan',
      content: 'Build the calculator in small steps.',
      request_review_from: ['reviewer'],
    },
  }));

  assert.deepEqual(calls, [
    {
      tool: 'propose',
      title: 'Calculator plan',
      content: 'Build the calculator in small steps.',
      request_review_from: ['reviewer'],
    },
  ]);
});

test('extractToolCalls derives file paths and collaboration targets from local-model alias shapes', () => {
  const calls = extractToolCalls([
    '```json',
    JSON.stringify({
      tool: 'write_file',
      arguments: {
        directory: 'notes',
        filename: 'plan.md',
        body: '# Plan\n- Build calculator\n',
      },
    }),
    '```',
    '```json',
    JSON.stringify({
      tool: 'propose',
      params: {
        proposal_title: 'Calculator implementation plan',
        description: 'Build a simple calculator with planning, coding, and review.',
        requested_reviewers: ['@reviewer'],
      },
    }),
    '```',
    '```json',
    JSON.stringify({
      tool: 'delegate',
      args: {
        message: '@coder Implement src/calculator.js',
        background: 'Use notes/plan.md first.',
      },
    }),
    '```',
  ].join('\n'));

  assert.deepEqual(calls, [
    { tool: 'write_file', path: 'notes/plan.md', content: '# Plan\n- Build calculator\n' },
    {
      tool: 'propose',
      title: 'Calculator implementation plan',
      content: 'Build a simple calculator with planning, coding, and review.',
      request_review_from: ['reviewer'],
    },
    {
      tool: 'delegate',
      to_agent: 'coder',
      task: 'Implement src/calculator.js',
      context: 'Use notes/plan.md first.',
    },
  ]);
});

test('extractToolCalls parses leading JSON payloads followed by prose', () => {
  const calls = extractToolCalls('{"tool":"list_files","params":{}}\n\nI listed the workspace first.');

  assert.deepEqual(calls, [
    { tool: 'list_files', path: '.' },
  ]);
});

test('getToolCallingMode defaults anthropic to text mode', () => {
  assert.equal(getToolCallingMode({ provider_config: { provider: 'anthropic' } }), 'text');

  const previousBaseUrl = process.env.ENOWXAI_BASE_URL;
  delete process.env.ENOWXAI_BASE_URL;
  try {
    assert.equal(getToolCallingMode({ provider_config: {} }), 'text');
  } finally {
    if (previousBaseUrl === undefined) {
      delete process.env.ENOWXAI_BASE_URL;
    } else {
      process.env.ENOWXAI_BASE_URL = previousBaseUrl;
    }
  }
});

test('getRoleOperatingGuidance keeps planner, coder, and reviewer scoped to their role', () => {
  assert.ok(getRoleOperatingGuidance({ name: 'planner' }).some((line) => line.includes('@coder')));
  assert.ok(getRoleOperatingGuidance({ name: 'planner' }).some((line) => line.includes('DELEGATE')));
  assert.ok(getRoleOperatingGuidance({ name: 'coder' }).some((line) => line.includes('BOUNDARIES')));
  assert.ok(getRoleOperatingGuidance({ name: 'coder' }).some((line) => line.includes('RESEARCH')));
  assert.ok(getRoleOperatingGuidance({ name: 'reviewer' }).some((line) => line.includes('BOUNDARIES')));
  assert.ok(getRoleOperatingGuidance({ name: 'reviewer' }).some((line) => line.includes('INSPECT')));
});

test('getAllowedCollaborationToolNames narrows collaboration tools by role', () => {
  assert.deepEqual(
    [...getAllowedCollaborationToolNames({ name: 'planner' })].sort(),
    ['delegate', 'propose', 'spawn_agent', 'think_aloud'],
  );
  assert.deepEqual(
    [...getAllowedCollaborationToolNames({ name: 'coder' })].sort(),
    ['delegate', 'think_aloud'],
  );
  assert.deepEqual(
    [...getAllowedCollaborationToolNames({ name: 'reviewer' })].sort(),
    ['respond_to_proposal', 'think_aloud'],
  );
});

// ── isSimpleQuery ──────────────────────────────────────────────

test('isSimpleQuery detects greetings and acknowledgments as simple', () => {
  assert.equal(isSimpleQuery('hi'), true);
  assert.equal(isSimpleQuery('hello'), true);
  assert.equal(isSimpleQuery('thanks'), true);
  assert.equal(isSimpleQuery('ok'), true);
  assert.equal(isSimpleQuery('keren broo'), true);
  assert.equal(isSimpleQuery('mantap'), true);
  assert.equal(isSimpleQuery('nice work'), true);
  assert.equal(isSimpleQuery('got it'), true);
  assert.equal(isSimpleQuery('haha'), true);
});

test('isSimpleQuery detects short questions as simple', () => {
  assert.equal(isSimpleQuery('how are you?'), true);
  assert.equal(isSimpleQuery('what is this?'), true);
  assert.equal(isSimpleQuery('why?'), true);
});

test('isSimpleQuery detects action requests as complex', () => {
  assert.equal(isSimpleQuery('create a new file called app.js'), false);
  assert.equal(isSimpleQuery('fix the bug in the parser'), false);
  assert.equal(isSimpleQuery('build a REST API for user management'), false);
  assert.equal(isSimpleQuery('implement the login flow with JWT'), false);
  assert.equal(isSimpleQuery('refactor the database module'), false);
});

test('isSimpleQuery detects @mentions and file paths as complex', () => {
  assert.equal(isSimpleQuery('@coder please help'), false);
  assert.equal(isSimpleQuery('check /src/main.js'), false);
  assert.equal(isSimpleQuery('```code block```'), false);
});

test('isSimpleQuery detects long messages as complex', () => {
  assert.equal(isSimpleQuery('I need you to analyze the entire codebase and find all the performance bottlenecks then create a detailed report'), false);
});

// ── isProgressQuery tests ──────────────────────────────────────

test('isProgressQuery detects English progress queries', () => {
  assert.equal(isProgressQuery("how's it going?"), true);
  assert.equal(isProgressQuery('what is the status?'), true);
  assert.equal(isProgressQuery('any progress?'), true);
  assert.equal(isProgressQuery('are you done yet?'), true);
});

test('isProgressQuery detects Indonesian progress queries', () => {
  assert.equal(isProgressQuery('udah selesai?'), true);
  assert.equal(isProgressQuery('gimana progressnya?'), true);
  assert.equal(isProgressQuery('sudah belum?'), true);
  assert.equal(isProgressQuery('lagi ngapain?'), true);
  assert.equal(isProgressQuery('mengerjakan apa?'), true);
  assert.equal(isProgressQuery('sedang apa?'), true);
  assert.equal(isProgressQuery('sampai mana?'), true);
});

test('isProgressQuery detects @mention + progress queries', () => {
  assert.equal(isProgressQuery('@planner mengerjakan apa?'), true);
  assert.equal(isProgressQuery('@coder lagi ngapain?'), true);
  assert.equal(isProgressQuery('@planner sampai mana?'), true);
  assert.equal(isProgressQuery('@reviewer udah selesai?'), true);
  assert.equal(isProgressQuery('@coder what are you doing?'), true);
});

test('isProgressQuery rejects non-progress messages', () => {
  assert.equal(isProgressQuery('hi'), false);
  assert.equal(isProgressQuery('create a file'), false);
  assert.equal(isProgressQuery('thanks!'), false);
  assert.equal(isProgressQuery('@coder fix the bug'), false);
});

// ── stripSelfMentions ─────────────────────────────────────────
test('stripSelfMentions removes self @mentions from responses', () => {
  // Leading self-mention with comma
  assert.equal(
    stripSelfMentions('@planner, saya akan menyelesaikan tugas', 'planner'),
    'saya akan menyelesaikan tugas',
  );
  // Leading self-mention with colon
  assert.equal(
    stripSelfMentions('@planner: here is the plan', 'planner'),
    'here is the plan',
  );
  // Self-mention in middle of text
  assert.equal(
    stripSelfMentions('Saya @planner akan mengerjakan ini', 'planner'),
    'Saya akan mengerjakan ini',
  );
  // Does NOT strip other agent mentions
  assert.equal(
    stripSelfMentions('@coder please fix this', 'planner'),
    '@coder please fix this',
  );
  // Multiple self-mentions
  assert.equal(
    stripSelfMentions('@planner, @planner will handle this', 'planner'),
    'will handle this',
  );
  // No self-mention — unchanged
  assert.equal(
    stripSelfMentions('Everything looks good', 'planner'),
    'Everything looks good',
  );
  // Case insensitive
  assert.equal(
    stripSelfMentions('@Planner, here is the plan', 'planner'),
    'here is the plan',
  );
});