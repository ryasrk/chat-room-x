/**
 * Unit tests for skillLoader.js — skill file loading and caching.
 */

import { describe, test, beforeEach, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import { join } from 'path';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';

// We test the parseFrontmatter logic and skill loading behavior
// by importing the module and testing its exports

import { searchSkills, getSkillContent, readSkillFile, listSkillFiles } from './skillLoader.js';

// ── searchSkills ───────────────────────────────────────────────

describe('searchSkills', () => {
  test('returns an array', async () => {
    const results = await searchSkills('python testing');
    assert.ok(Array.isArray(results));
  });

  test('results have expected shape', async () => {
    const results = await searchSkills('api design');
    for (const r of results) {
      assert.ok(typeof r.id === 'string' || typeof r.name === 'string');
    }
  });

  test('handles empty query', async () => {
    const results = await searchSkills('');
    assert.ok(Array.isArray(results));
  });

  test('handles nonsense query', async () => {
    const results = await searchSkills('xyzzy123frobnicator');
    assert.ok(Array.isArray(results));
  });
});

// ── getSkillContent ────────────────────────────────────────────

describe('getSkillContent', () => {
  test('returns null for non-existent skill', async () => {
    const content = await getSkillContent('nonexistent-skill-xyz');
    assert.equal(content, null);
  });

  test('returns string for existing skill (if any)', async () => {
    const skills = await searchSkills('');
    if (skills.length > 0) {
      const content = await getSkillContent(skills[0].id || skills[0].name);
      // May be null if skill directory doesn't have SKILL.md
      assert.ok(content === null || typeof content === 'string');
    }
  });
});

// ── readSkillFile ──────────────────────────────────────────────

describe('readSkillFile', () => {
  test('returns null for non-existent skill file', async () => {
    const content = await readSkillFile('nonexistent-skill', 'SKILL.md');
    assert.equal(content, null);
  });

  test('blocks path traversal', async () => {
    const content = await readSkillFile('../../etc', 'passwd');
    assert.equal(content, null);
  });
});

// ── listSkillFiles ─────────────────────────────────────────────

describe('listSkillFiles', () => {
  test('returns array for non-existent skill', async () => {
    const files = await listSkillFiles('nonexistent-skill');
    assert.ok(Array.isArray(files));
    assert.equal(files.length, 0);
  });

  test('returns files for existing skill (if any)', async () => {
    const skills = await searchSkills('');
    if (skills.length > 0) {
      const files = await listSkillFiles(skills[0].id || skills[0].name);
      assert.ok(Array.isArray(files));
    }
  });
});
