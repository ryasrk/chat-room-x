import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertAgentCanRunPython,
  assertAgentCanWritePath,
  getAgentPolicy,
  isDocumentationPath,
} from './agentPolicy.js';

test('documentation path detection allows notes docs and README', () => {
  assert.equal(isDocumentationPath('notes/plan.md'), true);
  assert.equal(isDocumentationPath('docs/spec.md'), true);
  assert.equal(isDocumentationPath('README.md'), true);
  assert.equal(isDocumentationPath('src/app.py'), false);
});

test('agent policy centralizes implementation and python capabilities', () => {
  const planner = getAgentPolicy({ agentName: 'planner', allowedTools: ['read_file', 'write_file'] });
  const coder = getAgentPolicy({ agentName: 'coder', allowedTools: ['read_file', 'write_file', 'run_python'] });
  const reviewer = getAgentPolicy({ agentName: 'reviewer', allowedTools: ['read_file', 'run_python'] });

  assert.equal(planner.canManageTasks, true);
  assert.equal(coder.canWriteImplementation, true);
  assert.equal(coder.canRunPython, true);
  assert.equal(reviewer.canRunPython, true);
});

test('agent policy rejects invalid write and run actions', () => {
  const planner = getAgentPolicy({ agentName: 'planner', allowedTools: ['write_file'] });
  const reviewer = getAgentPolicy({ agentName: 'reviewer', allowedTools: ['read_file'] });

  assert.doesNotThrow(() => assertAgentCanWritePath(planner, 'notes/plan.md'));
  assert.throws(() => assertAgentCanWritePath(planner, 'src/app.py'), /Planner cannot write implementation files/i);
  assert.throws(() => assertAgentCanRunPython(reviewer), /Python execution capability/i);
});