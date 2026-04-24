/**
 * Application State — shared singleton consumed by all modules.
 */

export const SYSTEM_PROMPT_TEMPLATES = [
  { name: 'Default', prompt: 'You are a helpful assistant.' },
  { name: 'Coding Assistant', prompt: 'You are an expert programmer. Write clean, efficient code with clear explanations. Always include error handling.' },
  { name: 'Translator', prompt: 'You are a professional translator. Translate text between languages accurately while preserving tone and context.' },
  { name: 'Creative Writer', prompt: 'You are a creative writing assistant. Help with stories, poems, scripts, and creative content.' },
  { name: 'Tutor', prompt: 'You are a patient tutor. Explain concepts step-by-step, use examples, and check understanding.' },
  { name: 'Analyst', prompt: 'You are a data analyst. Analyze information systematically, identify patterns, and provide evidence-based conclusions.' },
];

export const state = {
  messages: [],
  isStreaming: false,
  abortController: null,
  conversationId: null,
  folder: '',
  attachedFiles: [],
  _pendingBranches: null,
  _pendingAutoTitle: null,
  settings: {
    temperature: 0,
    maxTokens: 1024,
    maxContext: 65536,
    autoCompactEnabled: true,
    systemPrompt: 'You are a helpful assistant.',
    apiEndpoint: '/v1/chat/completions',
    model: '',
    enableThinking: false,
    showThinking: true,
    language: 'auto',
    timezone: 'auto',
  },
  mode: 'enowxai',
};
