/**
 * E2E test environment loader.
 * Reads .env from project root and exports test config.
 * Usage: import { base, username, password } from './loadE2eEnv.mjs';
 */
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '.env');

if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    // Strip wrapping quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

const controlPort = process.env.CONTROL_PORT || '18247';
const dashboardPort = process.env.DASHBOARD_PORT || '7391';

export const base = process.env.E2E_BASE_URL || `http://localhost:${controlPort}`;
export const dashboardUrl = process.env.E2E_DASHBOARD_URL || `http://localhost:${dashboardPort}`;
export const username = process.env.E2E_TEST_USERNAME || 'testuser';
export const password = process.env.E2E_TEST_PASSWORD || 'testpass';
