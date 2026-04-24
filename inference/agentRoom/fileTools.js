/**
 * Agent Room — Sandboxed File Tool System
 *
 * Provides read, write, update, list operations within a workspace jail.
 * All paths are resolved relative to the workspace root with strict
 * path traversal prevention.
 */

import { promises as fs } from 'fs';
import { join, resolve, relative, sep, basename, dirname, extname } from 'path';
import { realpathSync, existsSync, mkdirSync, lstatSync } from 'fs';

// ── Constants ──────────────────────────────────────────────────
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MB per file
const MAX_FILES_PER_WORKSPACE = 500;
const MAX_PATH_DEPTH = 10;
const BLOCKED_EXTENSIONS = new Set(['.exe', '.dll', '.so', '.dylib', '.sh', '.bat', '.cmd']);
const BLOCKED_NAMES = new Set(['.env', '.env.local', '.env.production', '.git', '.gitignore']);

// ── Security: Path Resolution ──────────────────────────────────

/**
 * Safely resolve a user-provided path within a workspace root.
 * Prevents path traversal, symlink escape, and absolute path injection.
 *
 * @param {string} workspaceRoot - Absolute path to workspace directory
 * @param {string} userPath - User-provided relative path
 * @returns {string} Resolved absolute path guaranteed to be inside workspace
 * @throws {Error} If path escapes workspace or is invalid
 */
export function safePath(workspaceRoot, userPath) {
  if (!userPath || typeof userPath !== 'string') {
    throw new Error('Path is required');
  }

  let decodedPath = userPath;
  try {
    decodedPath = decodeURIComponent(userPath);
  } catch {
    throw new Error('Path contains invalid encoding');
  }

  // Reject absolute paths
  if (decodedPath.startsWith('/') || decodedPath.startsWith('\\') || /^[A-Za-z]:/.test(decodedPath)) {
    throw new Error('Absolute paths are not allowed');
  }

  // Reject null bytes
  if (decodedPath.includes('\0')) {
    throw new Error('Path contains null bytes');
  }

  // Normalize and check for traversal components
  const parts = decodedPath.split(/[/\\]/);
  if (parts.some(p => p === '..')) {
    throw new Error('Path traversal (..) is not allowed');
  }

  // Check depth
  if (parts.length > MAX_PATH_DEPTH) {
    throw new Error(`Path too deep (max ${MAX_PATH_DEPTH} levels)`);
  }

  // Check blocked names
  const fileName = basename(decodedPath);
  if (BLOCKED_NAMES.has(fileName.toLowerCase())) {
    throw new Error(`File name "${fileName}" is not allowed`);
  }

  // Check blocked extensions
  const ext = extname(fileName).toLowerCase();
  if (BLOCKED_EXTENSIONS.has(ext)) {
    throw new Error(`File extension "${ext}" is not allowed`);
  }

  // Resolve the full path
  const resolved = resolve(workspaceRoot, decodedPath);
  const realRoot = realpathSync(workspaceRoot);

  // Ensure resolved path is within workspace (prefix check)
  const normalizedRoot = workspaceRoot.endsWith(sep) ? workspaceRoot : workspaceRoot + sep;
  if (!resolved.startsWith(normalizedRoot) && resolved !== workspaceRoot) {
    throw new Error('Path resolves outside workspace');
  }

  // Reject any existing symlinked component in the requested path.
  let currentPath = realRoot;
  for (const part of parts.filter(Boolean)) {
    currentPath = join(currentPath, part);
    if (!existsSync(currentPath)) {
      continue;
    }

    const stat = lstatSync(currentPath);
    if (stat.isSymbolicLink()) {
      throw new Error('Symlinks are not allowed in workspace paths');
    }

    const realCurrent = realpathSync(currentPath);
    const normalizedRealRoot = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
    if (!realCurrent.startsWith(normalizedRealRoot) && realCurrent !== realRoot) {
      throw new Error('Symlink resolves outside workspace');
    }
  }

  // If the path already exists, check realpath for symlink escape
  if (existsSync(resolved)) {
    const real = realpathSync(resolved);
    const normalizedRealRoot = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
    if (!real.startsWith(normalizedRealRoot) && real !== realRoot) {
      throw new Error('Symlink resolves outside workspace');
    }
  }

  return resolved;
}

// ── File Tools ─────────────────────────────────────────────────

/**
 * Read a file from the workspace.
 * @param {string} workspaceRoot
 * @param {string} filePath - Relative path within workspace
 * @returns {Promise<{path: string, content: string, size: number}>}
 */
export async function readFile(workspaceRoot, filePath) {
  const resolved = safePath(workspaceRoot, filePath);

  const stat = await fs.stat(resolved);
  if (!stat.isFile()) {
    throw new Error(`"${filePath}" is not a file`);
  }
  if (stat.size > MAX_FILE_SIZE) {
    throw new Error(`File too large (${(stat.size / 1024).toFixed(1)} KB, max ${MAX_FILE_SIZE / 1024} KB)`);
  }

  const content = await fs.readFile(resolved, 'utf-8');
  return {
    path: filePath,
    content,
    size: stat.size,
  };
}

/**
 * Write a file to the workspace. Creates directories as needed.
 * @param {string} workspaceRoot
 * @param {string} filePath - Relative path within workspace
 * @param {string} content - File content
 * @returns {Promise<{path: string, size: number, created: boolean}>}
 */
export async function writeFile(workspaceRoot, filePath, content) {
  if (typeof content !== 'string') {
    throw new Error('Content must be a string');
  }
  if (Buffer.byteLength(content, 'utf-8') > MAX_FILE_SIZE) {
    throw new Error(`Content too large (max ${MAX_FILE_SIZE / 1024} KB)`);
  }

  const resolved = safePath(workspaceRoot, filePath);
  const existed = existsSync(resolved);

  // Ensure parent directory exists
  const dir = dirname(resolved);
  await fs.mkdir(dir, { recursive: true });

  await fs.writeFile(resolved, content, 'utf-8');
  const stat = await fs.stat(resolved);

  return {
    path: filePath,
    size: stat.size,
    created: !existed,
  };
}

/**
 * Update a file using string replacement (surgical edit).
 * @param {string} workspaceRoot
 * @param {string} filePath - Relative path within workspace
 * @param {string} oldStr - Exact string to find
 * @param {string} newStr - Replacement string
 * @returns {Promise<{path: string, replacements: number}>}
 */
export async function updateFile(workspaceRoot, filePath, oldStr, newStr) {
  if (!oldStr || typeof oldStr !== 'string') {
    throw new Error('oldStr is required');
  }
  if (typeof newStr !== 'string') {
    throw new Error('newStr must be a string');
  }

  const resolved = safePath(workspaceRoot, filePath);

  const stat = await fs.stat(resolved);
  if (!stat.isFile()) {
    throw new Error(`"${filePath}" is not a file`);
  }

  let content = await fs.readFile(resolved, 'utf-8');

  // Count occurrences
  let count = 0;
  let idx = content.indexOf(oldStr);
  while (idx !== -1) {
    count++;
    idx = content.indexOf(oldStr, idx + oldStr.length);
  }

  if (count === 0) {
    throw new Error(`String not found in "${filePath}"`);
  }

  // Replace all occurrences
  content = content.replaceAll(oldStr, newStr);

  if (Buffer.byteLength(content, 'utf-8') > MAX_FILE_SIZE) {
    throw new Error('Updated content exceeds max file size');
  }

  await fs.writeFile(resolved, content, 'utf-8');

  return {
    path: filePath,
    replacements: count,
  };
}

/**
 * List files in a workspace directory (recursive).
 * @param {string} workspaceRoot
 * @param {string} [dirPath='.'] - Relative directory path
 * @param {number} [maxDepth=5] - Max recursion depth
 * @returns {Promise<Array<{path: string, type: 'file'|'directory', size?: number}>>}
 */
export async function listFiles(workspaceRoot, dirPath = '.', maxDepth = 5) {
  const resolved = safePath(workspaceRoot, dirPath || '.');

  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`"${dirPath}" is not a directory`);
  }

  const results = [];
  await _walkDir(workspaceRoot, resolved, results, 0, maxDepth);
  return results;
}

async function _walkDir(workspaceRoot, dir, results, depth, maxDepth) {
  if (depth > maxDepth || results.length >= MAX_FILES_PER_WORKSPACE) return;

  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (results.length >= MAX_FILES_PER_WORKSPACE) break;

    const fullPath = join(dir, entry.name);
    const relPath = relative(workspaceRoot, fullPath);

    if (entry.isDirectory()) {
      // Skip hidden directories
      if (entry.name.startsWith('.')) continue;

      results.push({ path: relPath, type: 'directory' });
      await _walkDir(workspaceRoot, fullPath, results, depth + 1, maxDepth);
    } else if (entry.isFile()) {
      const stat = await fs.stat(fullPath);
      results.push({
        path: relPath,
        type: 'file',
        size: stat.size,
      });
    }
  }
}

/**
 * Delete a file from the workspace.
 * @param {string} workspaceRoot
 * @param {string} filePath
 * @returns {Promise<{path: string, deleted: boolean}>}
 */
export async function deleteFile(workspaceRoot, filePath) {
  const resolved = safePath(workspaceRoot, filePath);

  const stat = await fs.stat(resolved);
  if (!stat.isFile()) {
    throw new Error(`"${filePath}" is not a file`);
  }

  await fs.unlink(resolved);
  return { path: filePath, deleted: true };
}

/**
 * Ensure a workspace directory exists.
 * @param {string} workspaceRoot
 */
export function ensureWorkspace(workspaceRoot) {
  if (!existsSync(workspaceRoot)) {
    mkdirSync(workspaceRoot, { recursive: true });
  }
}
