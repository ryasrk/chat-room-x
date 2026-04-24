/**
 * Environment variable loader.
 * Bun natively loads .env files — this module ensures the correct .env path
 * is loaded and provides a fallback for non-Bun runtimes.
 */
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import process from 'process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.resolve(__dirname, '..', '.env');

function stripWrappingQuotes(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function loadEnvFileFallback(envPath) {
  if (!existsSync(envPath)) {
    return;
  }

  const content = readFileSync(envPath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    const value = stripWrappingQuotes(line.slice(separatorIndex + 1));
    process.env[key] = value;
  }
}

// Bun auto-loads .env from cwd, but our .env is in the parent directory.
// Explicitly load it to ensure correct path resolution.
if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile(ENV_PATH);
  } catch {
    loadEnvFileFallback(ENV_PATH);
  }
} else {
  loadEnvFileFallback(ENV_PATH);
}