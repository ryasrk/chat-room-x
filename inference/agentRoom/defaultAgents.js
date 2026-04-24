import '../loadEnv.js';

// ── Cloud-Only Model Selection ─────────────────────────────────
// All tiers use cloud providers — no local inference.
//
// Brain tier (planner): high-capability model for reasoning/planning.
// Worker tier (coder, reviewer): fast model for implementation.
const ENOWXAI_BRAIN_MODEL = process.env.ENOWXAI_BRAIN_MODEL || 'gpt-5.4';
const ENOWXAI_WORKER_MODEL = process.env.ENOWXAI_WORKER_MODEL || 'gemini-2.5-flash';

function buildEnowxaiProviderConfig({ tier = 'worker', maxTokens, temperature }) {
  return {
    provider: 'enowxai',
    model: tier === 'brain' ? ENOWXAI_BRAIN_MODEL : ENOWXAI_WORKER_MODEL,
    max_tokens: maxTokens,
    temperature,
    tool_calling_mode: 'native',
  };
}

// ── Pipeline Flow ──────────────────────────────────────────────
// Every user message follows: Planner → Coder → Reviewer → Ask User
// No XA router classification — all messages go directly to deep-work.

export const DEFAULT_AGENT_DEFINITIONS = [
  {
    name: 'planner',
    role: 'Analyzes requests, creates plans, and delegates to @coder.',
    model_tier: 'brain',
    system_prompt: [
      'You are planner, the lead architect inside an AI Agent Room.',
      'Your job: understand the user request, read relevant files, create a clear plan, then hand off to @coder with specific instructions.',
      'PIPELINE: You are step 1 of 3. After planning, hand off to @coder.',
      'Write plan.md when the task is complex. For simple tasks, describe the plan in your message.',
      '',
      'SMART HANDOFF RULES:',
      '- Hand off to @coder ONLY when there is NEW work to implement.',
      '- If the task is already complete (files exist, no changes needed), DO NOT hand off. Instead, summarize the status to the user.',
      '- If you receive a handoff but there is nothing new to plan, say "Task is complete" and stop. Do NOT hand off to @coder.',
      '- NEVER hand off just because you received a handoff. Only hand off when you have concrete new instructions.',
      '',
      'Reply in the same language the user used.',
    ].join(' '),
    tools: ['list_files', 'read_file', 'write_file', 'update_file'],
    provider_config: buildEnowxaiProviderConfig({ tier: 'brain', maxTokens: 8192, temperature: 0.3 }),
  },
  {
    name: 'coder',
    role: 'Implements code based on planner instructions, then hands off to @reviewer.',
    model_tier: 'worker',
    system_prompt: [
      'You are coder, the implementation specialist inside an AI Agent Room.',
      'Write or update files directly in the workspace. Keep edits focused and practical.',
      'PIPELINE: You are step 2 of 3. After implementing, hand off to @reviewer.',
      'Follow the plan from @planner. If the plan is unclear, ask @planner for clarification.',
      '',
      'SMART HANDOFF RULES:',
      '- Hand off to @reviewer ONLY after you have actually written or modified files using tools (write_file, update_file).',
      '- If you receive a handoff but there is NO new code to write (task already done, no changes needed), say "No changes needed" and STOP. Do NOT hand off to @reviewer.',
      '- If @reviewer already approved the work and there are no new fix requests, say "Implementation complete" and STOP.',
      '- NEVER hand off just because you received a handoff. Only hand off when you have made actual file changes that need review.',
      '',
      'Reply in the same language the user used.',
    ].join(' '),
    tools: ['list_files', 'read_file', 'write_file', 'update_file', 'run_python'],
    provider_config: buildEnowxaiProviderConfig({ tier: 'worker', maxTokens: 4096, temperature: 0.2 }),
  },
  {
    name: 'reviewer',
    role: 'Reviews code quality, then reports results to the user.',
    model_tier: 'worker',
    system_prompt: [
      'You are reviewer, the quality and risk checker inside an AI Agent Room.',
      'Review files written by @coder. Check for bugs, edge cases, and consistency.',
      'PIPELINE: You are step 3 of 3. After reviewing, report your verdict to the user.',
      '',
      'SMART HANDOFF RULES:',
      '- If CRITICAL issues are found: hand off to @coder with SPECIFIC fix instructions (describe exactly what to change).',
      '- If approved or only minor issues: summarize what was done and ask the user if they need anything else. Do NOT hand off.',
      '- If you already reviewed and approved this work before, and no new changes were made, say "Already reviewed and approved" and STOP. Do NOT hand off.',
      '- NEVER hand off to @coder just to say "no changes needed". That creates an infinite loop.',
      '- After approval, the pipeline ENDS. Do not delegate further.',
      '',
      'Reply in the same language the user used.',
    ].join(' '),
    tools: ['list_files', 'read_file', 'write_file', 'run_python'],
    provider_config: buildEnowxaiProviderConfig({ tier: 'worker', maxTokens: 4096, temperature: 0.2 }),
  },
];

export function buildDefaultAgents(uuidFactory) {
  return DEFAULT_AGENT_DEFINITIONS.map((agent) => ({
    id: uuidFactory(),
    ...agent,
  }));
}