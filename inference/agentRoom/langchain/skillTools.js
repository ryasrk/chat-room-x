/**
 * LangChain Structured Tools — Skill Search & Read
 *
 * Provides agents with tool-based access to the skills catalog.
 * Instead of auto-injecting skill content into prompts, agents
 * actively search for relevant skills and read their content on demand.
 *
 * Tools:
 *   - search_skills: Search the skill catalog by keyword
 *   - read_skill: Read a skill's SKILL.md or any file within the skill directory
 *   - list_skill_files: Browse files within a skill directory
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import {
  searchSkills,
  getSkillContent,
  readSkillFile,
  listSkillFiles,
} from '../skillLoader.js';

/**
 * Create skill-related tools for agent use.
 *
 * @param {Object} [options]
 * @param {string[]} [options.allowedSkillIds] - If provided, restrict to these skill IDs only (room-level filter)
 * @returns {DynamicStructuredTool[]}
 */
export function createSkillTools(options = {}) {
  const { allowedSkillIds } = options;
  const hasFilter = Array.isArray(allowedSkillIds) && allowedSkillIds.length > 0;
  const allowedSet = hasFilter ? new Set(allowedSkillIds) : null;

  const searchSkillsTool = new DynamicStructuredTool({
    name: 'search_skills',
    description:
      'Search the skills catalog for domain knowledge relevant to your task. ' +
      'Skills contain expert instructions, scripts, references, and templates for specialized tasks ' +
      '(e.g., UI design, API patterns, document processing, code review). ' +
      'Returns matching skills ranked by relevance. Use this before starting complex tasks to find helpful guidance.',
    schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Search keywords describing what you need (e.g., "UI design tailwind", "PDF form extraction", "API REST design patterns").',
        },
      },
      required: ['query'],
    },
    func: async ({ query }) => {
      try {
        let results = await searchSkills(query);

        // Apply room-level filter if set
        if (allowedSet) {
          results = results.filter((r) => allowedSet.has(r.id));
        }

        if (results.length === 0) {
          return JSON.stringify({ results: [], message: 'No matching skills found. Try broader keywords.' });
        }

        // Return top 10 results
        const top = results.slice(0, 10).map((r) => ({
          id: r.id,
          name: r.name,
          description: r.description,
          relevance: Math.round(r.relevance * 100) + '%',
        }));

        return JSON.stringify({ results: top, total: results.length });
      } catch (error) {
        return JSON.stringify({ error: error.message });
      }
    },
  });

  const readSkillTool = new DynamicStructuredTool({
    name: 'read_skill',
    description:
      'Read a skill\'s content to get detailed instructions, patterns, and guidance. ' +
      'By default reads the main SKILL.md file. You can also read specific files within the skill ' +
      '(e.g., "references/aws.md", "scripts/extract.py") by providing a file_path. ' +
      'Use search_skills first to find the skill ID, then read_skill to load its content.',
    schema: {
      type: 'object',
      properties: {
        skill_id: {
          type: 'string',
          description: 'The skill ID (directory name) to read, e.g., "ui-ux-pro-max", "pdf", "claude-api".',
        },
        file_path: {
          type: 'string',
          description:
            'Optional relative path within the skill directory. Defaults to "SKILL.md". ' +
            'Examples: "references/aws.md", "scripts/thumbnail.py", "editing.md".',
          default: 'SKILL.md',
        },
      },
      required: ['skill_id'],
    },
    func: async ({ skill_id, file_path = 'SKILL.md' }) => {
      try {
        // Apply room-level filter
        if (allowedSet && !allowedSet.has(skill_id)) {
          return JSON.stringify({ status: 'not_available', message: `Skill "${skill_id}" is not available in this room. Use search_skills to find available skills.` });
        }

        if (file_path === 'SKILL.md' || !file_path) {
          // Read the main skill content (parsed, without frontmatter)
          const skill = await getSkillContent(skill_id);
          if (!skill) {
            return JSON.stringify({ status: 'not_found', message: `Skill "${skill_id}" not found. Use search_skills to find valid skill IDs.` });
          }

          return JSON.stringify({
            id: skill_id,
            name: skill.name,
            description: skill.description,
            content: skill.content,
          });
        }

        // Read a specific file within the skill
        const content = await readSkillFile(skill_id, file_path);
        if (content === null) {
          return JSON.stringify({ status: 'not_found', message: `File "${file_path}" not found in skill "${skill_id}". Use list_skill_files to see available files.` });
        }

        // Truncate very large files
        const MAX_CHARS = 12000;
        const truncated = content.length > MAX_CHARS;
        return JSON.stringify({
          id: skill_id,
          file: file_path,
          content: truncated ? content.slice(0, MAX_CHARS) + '\n\n[... truncated, use list_skill_files to see available files]' : content,
          truncated,
        });
      } catch (error) {
        console.error(`[read_skill] Error reading skill_id="${skill_id}" file_path="${file_path}":`, error.message);
        return JSON.stringify({ error: error.message });
      }
    },
  });

  const listSkillFilesTool = new DynamicStructuredTool({
    name: 'list_skill_files',
    description:
      'List files and directories within a skill. Useful for discovering available references, scripts, ' +
      'templates, and other resources bundled with a skill before reading them.',
    schema: {
      type: 'object',
      properties: {
        skill_id: {
          type: 'string',
          description: 'The skill ID (directory name) to browse.',
        },
        path: {
          type: 'string',
          description: 'Relative path within the skill directory. Defaults to "." (root).',
          default: '.',
        },
      },
      required: ['skill_id'],
    },
    func: async ({ skill_id, path = '.' }) => {
      try {
        if (allowedSet && !allowedSet.has(skill_id)) {
          return JSON.stringify({ status: 'not_available', message: `Skill "${skill_id}" is not available in this room. Use search_skills to find available skills.` });
        }

        const entries = await listSkillFiles(skill_id, path);
        if (entries.length === 0) {
          return JSON.stringify({ entries: [], message: `No files found in "${skill_id}/${path}".` });
        }

        return JSON.stringify({ skill_id, path, entries });
      } catch (error) {
        return JSON.stringify({ error: error.message });
      }
    },
  });

  return [searchSkillsTool, readSkillTool, listSkillFilesTool];
}
