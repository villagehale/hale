import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type AgentTask, isAgentTask } from './model.js';

/**
 * Skill loader.
 *
 * A skill is a markdown file with YAML frontmatter. The frontmatter is the
 * machine-readable contract (name, when to use it, the pickModel task, the tools
 * it may call); the body is the agent's instructions — the prompt. Keeping skills
 * file-based + versioned is the same discipline as hard rule #2 (prompts by
 * reference, never inline strings): the harness loads a skill by name/path, and
 * the instructions live in git, reviewable in PRs, migratable to Langfuse later.
 *
 * Frontmatter is a FIXED, simple schema we control — scalar strings plus string
 * arrays. We parse that subset directly rather than pull in a YAML dependency for
 * four keys; an out-of-spec value fails loudly, it is never silently coerced.
 */

export interface SkillMeta {
  name: string;
  whenToUse: string;
  /** Drives pickModel — must be one of the known AgentTask values. */
  task: AgentTask;
  /** Names of the tools this skill is allowed to call. */
  tools: string[];
}

export interface Skill {
  meta: SkillMeta;
  /** The markdown body — becomes the agent's system instructions. */
  instructions: string;
}

function skillsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // From .../src/skill.ts → .../skills (sibling of src/)
  return join(here, '..', 'skills');
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Parse the constrained frontmatter: `key: value` lines where a value is either
 * a quoted/plain scalar or a flow array `[a, b]`, plus block arrays of `- item`
 * lines under a bare `key:`. Anything outside this shape throws.
 */
function parseFrontmatter(block: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const lines = block.split(/\r?\n/);
  let pendingListKey: string | null = null;

  for (const line of lines) {
    if (line.trim() === '') continue;

    const listItem = /^\s*-\s+(.*)$/.exec(line);
    if (listItem) {
      if (!pendingListKey) {
        throw new Error(`skill frontmatter: list item with no preceding key: "${line}"`);
      }
      (out[pendingListKey] as string[]).push(unquote(listItem[1] ?? ''));
      continue;
    }

    const kv = /^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!kv) {
      throw new Error(`skill frontmatter: malformed line: "${line}"`);
    }
    const key = kv[1] as string;
    const rawValue = (kv[2] ?? '').trim();

    if (rawValue === '') {
      out[key] = [];
      pendingListKey = key;
      continue;
    }
    pendingListKey = null;

    if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
      const inner = rawValue.slice(1, -1).trim();
      out[key] = inner === '' ? [] : inner.split(',').map((s) => unquote(s.trim()));
      continue;
    }

    out[key] = unquote(rawValue);
  }

  return out;
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function expectString(fm: Record<string, string | string[]>, key: string): string {
  const value = fm[key];
  if (typeof value !== 'string') {
    throw new Error(`skill frontmatter: '${key}' must be a string`);
  }
  return value;
}

function expectStringArray(fm: Record<string, string | string[]>, key: string): string[] {
  const value = fm[key];
  if (!Array.isArray(value)) {
    throw new Error(`skill frontmatter: '${key}' must be a list`);
  }
  return value;
}

/** Parse a raw skill file (frontmatter + body) into a validated Skill. */
export function parseSkill(raw: string): Skill {
  const match = FRONTMATTER.exec(raw);
  if (!match) {
    throw new Error('skill file: missing or malformed YAML frontmatter (--- ... ---)');
  }
  const fm = parseFrontmatter(match[1] as string);
  const instructions = (match[2] as string).trim();
  if (instructions === '') {
    throw new Error('skill file: empty instructions body');
  }

  const task = expectString(fm, 'task');
  if (!isAgentTask(task)) {
    throw new Error(`skill file: 'task' is not a known AgentTask: '${task}'`);
  }

  return {
    meta: {
      name: expectString(fm, 'name'),
      whenToUse: expectString(fm, 'whenToUse'),
      task,
      tools: expectStringArray(fm, 'tools'),
    },
    instructions,
  };
}

/**
 * Load a skill by bare name (resolved under the package's skills/ dir) or by an
 * explicit path. A bare name maps to `<skillsDir>/<name>.md`.
 */
export async function loadSkill(nameOrPath: string): Promise<Skill> {
  const path = isAbsolute(nameOrPath)
    ? nameOrPath
    : nameOrPath.includes('/') || nameOrPath.endsWith('.md')
      ? nameOrPath
      : join(skillsDir(), `${nameOrPath}.md`);
  const raw = await readFile(path, 'utf8');
  return parseSkill(raw);
}
