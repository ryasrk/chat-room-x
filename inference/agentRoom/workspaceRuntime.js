import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { promises as fs } from 'fs';
import { join } from 'path';

import { safePath } from './fileTools.js';

const DEFAULT_VENV_DIR = '.venv';
const MAX_RUNTIME_OUTPUT_BYTES = 64 * 1024;
const MAX_RUNTIME_ARGS = 12;
const MAX_ARG_LENGTH = 200;
const VENV_CREATION_TIMEOUT_MS = 120000;
const PYTHON_EXEC_TIMEOUT_MS = 20000;

function trimOutput(output) {
  if (typeof output !== 'string' || output.length <= MAX_RUNTIME_OUTPUT_BYTES) {
    return output || '';
  }
  return `${output.slice(0, MAX_RUNTIME_OUTPUT_BYTES)}\n... output truncated ...`;
}

function execFileResult(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      maxBuffer: MAX_RUNTIME_OUTPUT_BYTES,
      ...options,
    }, (error, stdout, stderr) => {
      if (error?.code === 'ENOENT') {
        reject(error);
        return;
      }

      resolve({
        error: error || null,
        stdout: trimOutput(stdout),
        stderr: trimOutput(stderr),
      });
    });
  });
}

function getPythonCandidates() {
  return [...new Set([
    process.env.AGENT_ROOM_PYTHON_BIN,
    'python3',
    'python',
  ].filter(Boolean))];
}

export function getWorkspaceVenvPath(workspaceRoot) {
  return join(workspaceRoot, DEFAULT_VENV_DIR);
}

export function getWorkspacePythonBinary(workspaceRoot) {
  return join(getWorkspaceVenvPath(workspaceRoot), 'bin', 'python');
}

export async function ensureWorkspacePythonEnv(workspaceRoot) {
  const pythonBinary = getWorkspacePythonBinary(workspaceRoot);
  if (existsSync(pythonBinary)) {
    return {
      created: false,
      pythonBinary,
      venvPath: DEFAULT_VENV_DIR,
    };
  }

  let lastError = null;
  for (const candidate of getPythonCandidates()) {
    try {
      const result = await execFileResult(candidate, ['-m', 'venv', DEFAULT_VENV_DIR], {
        cwd: workspaceRoot,
        timeout: VENV_CREATION_TIMEOUT_MS,
      });

      if (result.error) {
        lastError = new Error(result.stderr || result.error.message || `Failed to create venv with ${candidate}`);
        continue;
      }

      if (!existsSync(pythonBinary)) {
        lastError = new Error(`Virtual environment was created without ${DEFAULT_VENV_DIR}/bin/python`);
        continue;
      }

      return {
        created: true,
        pythonBinary,
        venvPath: DEFAULT_VENV_DIR,
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(lastError?.message || 'Unable to create a Python virtual environment for this workspace.');
}

function normalizeRuntimeArgs(args) {
  if (args == null) {
    return [];
  }
  if (!Array.isArray(args)) {
    throw new Error('args must be an array of strings');
  }
  if (args.length > MAX_RUNTIME_ARGS) {
    throw new Error(`Too many args (max ${MAX_RUNTIME_ARGS})`);
  }

  return args.map((arg) => {
    const value = String(arg ?? '');
    if (value.length > MAX_ARG_LENGTH) {
      throw new Error(`Argument too long (max ${MAX_ARG_LENGTH} chars)`);
    }
    return value;
  });
}

export async function runWorkspacePythonFile(workspaceRoot, filePath, args = []) {
  const normalizedArgs = normalizeRuntimeArgs(args);
  const resolvedPath = safePath(workspaceRoot, filePath);
  const stat = await fs.stat(resolvedPath);
  if (!stat.isFile()) {
    throw new Error(`"${filePath}" is not a file`);
  }
  if (!String(filePath).toLowerCase().endsWith('.py')) {
    throw new Error('Only .py files can be executed');
  }

  const { pythonBinary, venvPath } = await ensureWorkspacePythonEnv(workspaceRoot);
  const binDir = join(workspaceRoot, venvPath, 'bin');
  const result = await execFileResult(pythonBinary, [resolvedPath, ...normalizedArgs], {
    cwd: workspaceRoot,
    timeout: PYTHON_EXEC_TIMEOUT_MS,
    env: {
      ...process.env,
      VIRTUAL_ENV: join(workspaceRoot, venvPath),
      PATH: `${binDir}:${process.env.PATH || ''}`,
      PYTHONUNBUFFERED: '1',
    },
  });

  return {
    path: filePath,
    args: normalizedArgs,
    command: `python ${filePath}${normalizedArgs.length ? ` ${normalizedArgs.join(' ')}` : ''}`,
    exitCode: result.error ? Number(result.error.code) || 1 : 0,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: Boolean(result.error?.killed && result.error?.signal === 'SIGTERM'),
    venvPath,
  };
}