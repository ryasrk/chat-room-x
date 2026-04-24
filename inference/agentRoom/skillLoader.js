/**
 * Skill Loader — reads skill markdown files from data/skills/ and provides
 * them to agents as additional system prompt context.
 *
 * Skills are stored as directories under data/skills/<skill-name>/SKILL.md.
 * Each SKILL.md has YAML frontmatter (name, description) followed by markdown content.
 * The loader caches parsed skills in memory and refreshes on demand.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const SKILLS_ROOT = join(PROJECT_ROOT, 'data', 'skills');

/** @type {Map<string, {name: string, description: string, content: string, dataFiles: string[]}>} */
const skillCache = new Map();
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60_000; // refresh every 60s

/**
 * Parse YAML frontmatter from a markdown string.
 * Returns { meta: {}, body: string }.
 */
function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };

  const meta = {};
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    meta[key] = value;
  }
  return { meta, body: match[2] };
}

/**
 * Scan data/skills/ directory and load all SKILL.md files.
 */
async function loadAllSkills() {
  const now = Date.now();
  if (now - cacheTimestamp < CACHE_TTL_MS && skillCache.size > 0) {
    return skillCache;
  }

  try {
    const entries = await readdir(SKILLS_ROOT, { withFileTypes: true });
    const newSkills = new Map();

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillDir = join(SKILLS_ROOT, entry.name);
      const skillFile = join(skillDir, 'SKILL.md');

      try {
        const raw = await readFile(skillFile, 'utf8');
        const { meta, body } = parseFrontmatter(raw);

        // Discover data files (CSV, JSON) for reference
        const dataFiles = [];
        try {
          const dataDir = join(skillDir, 'data');
          const dataStat = await stat(dataDir);
          if (dataStat.isDirectory()) {
            const dataEntries = await readdir(dataDir);
            dataFiles.push(...dataEntries.filter((f) => f.endsWith('.csv') || f.endsWith('.json')));
          }
        } catch {
          // No data directory — that's fine
        }

        newSkills.set(entry.name, {
          name: meta.name || entry.name,
          description: meta.description || '',
          content: body.trim(),
          dataFiles,
        });
      } catch {
        // SKILL.md not found or unreadable — skip
      }
    }

    skillCache.clear();
    for (const [k, v] of newSkills) skillCache.set(k, v);
    cacheTimestamp = now;
  } catch {
    // data/skills/ directory doesn't exist — return empty
  }

  return skillCache;
}

/**
 * List all available skills (name + description only, no full content).
 */
export async function listAvailableSkills() {
  const skills = await loadAllSkills();
  return Array.from(skills.entries()).map(([id, skill]) => ({
    id,
    name: skill.name,
    description: skill.description,
    dataFileCount: skill.dataFiles.length,
  }));
}

/**
 * Get full skill content by ID.
 */
export async function getSkillContent(skillId) {
  const skills = await loadAllSkills();
  return skills.get(skillId) || null;
}

/**
 * Read a specific data file from a skill's data/ directory.
 */
export async function readSkillDataFile(skillId, fileName) {
  // Prevent path traversal
  if (fileName.includes('..') || fileName.includes('/')) return null;

  const filePath = join(SKILLS_ROOT, skillId, 'data', fileName);
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Read any file within a skill directory (SKILL.md, references/*, scripts/*, etc.).
 * Supports relative paths within the skill folder.
 *
 * @param {string} skillId - Skill directory name
 * @param {string} relativePath - Relative path within the skill directory (e.g., "SKILL.md", "references/aws.md")
 * @returns {Promise<string|null>} File content or null
 */
export async function readSkillFile(skillId, relativePath) {
  // Prevent path traversal
  const normalized = String(relativePath || '').replace(/\\/g, '/');
  if (normalized.includes('..') || normalized.startsWith('/')) return null;

  const filePath = join(SKILLS_ROOT, skillId, normalized);
  // Ensure resolved path stays within the skill directory
  const resolved = join(SKILLS_ROOT, skillId, normalized);
  if (!resolved.startsWith(join(SKILLS_ROOT, skillId))) return null;

  try {
    return await readFile(resolved, 'utf8');
  } catch {
    return null;
  }
}

/**
 * List files within a skill directory (for browsing skill resources).
 *
 * @param {string} skillId - Skill directory name
 * @param {string} [subPath='.'] - Relative path within the skill directory
 * @returns {Promise<Array<{name: string, type: string}>>} List of entries
 */
export async function listSkillFiles(skillId, subPath = '.') {
  const normalized = String(subPath || '.').replace(/\\/g, '/');
  if (normalized.includes('..')) return [];

  const dirPath = join(SKILLS_ROOT, skillId, normalized);
  if (!dirPath.startsWith(join(SKILLS_ROOT, skillId))) return [];

  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries.map((e) => ({
      name: e.name,
      type: e.isDirectory() ? 'directory' : 'file',
    }));
  } catch {
    return [];
  }
}

/**
 * Search skills by keyword matching against name and description.
 *
 * @param {string} query - Search query (keywords)
 * @returns {Promise<Array<{id: string, name: string, description: string, relevance: number}>>}
 */
export async function searchSkills(query) {
  const skills = await loadAllSkills();
  const queryLower = String(query || '').toLowerCase().trim();
  if (!queryLower) {
    return Array.from(skills.entries()).map(([id, skill]) => ({
      id,
      name: skill.name,
      description: skill.description,
      relevance: 1,
    }));
  }

  const queryWords = queryLower.split(/\s+/).filter(Boolean);
  const results = [];

  for (const [id, skill] of skills) {
    const nameStr = (skill.name || '').toLowerCase();
    const descStr = (skill.description || '').toLowerCase();
    const contentStr = (skill.content || '').toLowerCase();

    let score = 0;
    for (const word of queryWords) {
      if (nameStr.includes(word)) score += 3;
      if (descStr.includes(word)) score += 2;
      if (contentStr.includes(word)) score += 1;
    }

    if (score > 0) {
      results.push({
        id,
        name: skill.name,
        description: skill.description.slice(0, 200),
        relevance: score / (queryWords.length * 6), // normalize to 0-1
      });
    }
  }

  results.sort((a, b) => b.relevance - a.relevance);
  return results;
}

/**
 * Build a skill context block for injection into an agent's system prompt.
 * Takes an array of skill IDs and returns a formatted markdown section.
 *
 * @param {string[]} skillIds - Array of skill IDs to include
 * @param {object} options
 * @param {number} [options.maxCharsPerSkill=4000] - Truncate skill content to this length
 * @returns {Promise<string>} Formatted skill context block
 */
export async function buildSkillPromptBlock(skillIds, { maxCharsPerSkill = 4000 } = {}) {
  if (!skillIds || skillIds.length === 0) return '';

  const skills = await loadAllSkills();
  const blocks = [];

  for (const id of skillIds) {
    const skill = skills.get(id);
    if (!skill) continue;

    let content = skill.content;
    if (content.length > maxCharsPerSkill) {
      content = content.slice(0, maxCharsPerSkill) + '\n\n[... truncated for context efficiency]';
    }

    blocks.push(`### Skill: ${skill.name}\n${content}`);
  }

  if (blocks.length === 0) return '';

  return `\n## Loaded Skills\nThe following skills provide domain knowledge for this task:\n\n${blocks.join('\n\n---\n\n')}`;
}

/**
 * Force-refresh the skill cache (e.g., after adding new skills).
 */
export function invalidateSkillCache() {
  cacheTimestamp = 0;
  skillCache.clear();
}
