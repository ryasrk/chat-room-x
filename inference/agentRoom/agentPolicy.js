const DOCUMENTATION_ROOTS = ['notes', 'docs'];
const DOCUMENTATION_FILES = new Set(['README.md']);

const BASE_AGENT_POLICIES = {
  planner: {
    canWriteImplementation: false,
    canWriteDocumentation: true,
    canRunPython: false,
    canManageTasks: true,
  },
  coder: {
    canWriteImplementation: true,
    canWriteDocumentation: true,
    canRunPython: true,
    canManageTasks: true,
  },
  reviewer: {
    canWriteImplementation: false,
    canWriteDocumentation: true,
    canRunPython: true,
    canManageTasks: false,
  },
  scribe: {
    canWriteImplementation: false,
    canWriteDocumentation: true,
    canRunPython: false,
    canManageTasks: false,
  },
  default: {
    canWriteImplementation: false,
    canWriteDocumentation: true,
    canRunPython: false,
    canManageTasks: false,
  },
};

function normalizePath(path) {
  return String(path || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '');
}

export function isDocumentationPath(path) {
  const normalized = normalizePath(path);
  if (!normalized) return false;
  if (DOCUMENTATION_FILES.has(normalized)) return true;
  return DOCUMENTATION_ROOTS.some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

export function getAgentPolicy({ agentName = '', allowedTools = [] } = {}) {
  const normalizedAgent = String(agentName || '').toLowerCase();
  const basePolicy = BASE_AGENT_POLICIES[normalizedAgent] || BASE_AGENT_POLICIES.default;
  const allowedToolSet = new Set(Array.isArray(allowedTools) ? allowedTools : []);
  const hasToolRestrictions = allowedToolSet.size > 0;

  return {
    agentName: normalizedAgent,
    canWriteImplementation: basePolicy.canWriteImplementation,
    canWriteDocumentation: basePolicy.canWriteDocumentation,
    canRunPython: basePolicy.canRunPython && (!hasToolRestrictions || allowedToolSet.has('run_python')),
    canManageTasks: basePolicy.canManageTasks,
  };
}

export function assertAgentCanWritePath(policy, path) {
  const normalizedPath = normalizePath(path);
  if (!normalizedPath) {
    return;
  }

  if (policy.canWriteImplementation) {
    return;
  }

  if (policy.canWriteDocumentation && isDocumentationPath(normalizedPath)) {
    return;
  }

  if (policy.agentName === 'planner') {
    throw new Error('Planner cannot write implementation files. Write plans in notes/ or delegate implementation to @coder.');
  }

  if (policy.agentName === 'reviewer') {
    throw new Error('Reviewer cannot write implementation files. Save findings in notes/ instead.');
  }

  if (policy.agentName === 'scribe') {
    throw new Error('Scribe cannot write implementation files. Save summaries in notes/, docs/, or README.md instead.');
  }

  throw new Error('This agent cannot write to the requested workspace path.');
}

export function assertAgentCanRunPython(policy) {
  if (policy.canRunPython) {
    return;
  }
  throw new Error('Only agents with Python execution capability can execute Python files in the workspace.');
}