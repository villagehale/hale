// Anthropic retired Haiku 3.5. A request that still names that family
// (the floating alias or the dated snapshot) fails at the API. The house id
// is HAIKU_MODEL in packages/agent/src/model.ts (`claude-haiku-4-5`).
//
// The family name is assembled at runtime so this file is not itself a hit.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The retired model family. Covers the bare id, the `-latest` alias, and the dated snapshot. */
export function retiredHaikuFamily() {
  return ['claude', '3', '5', 'haiku'].join('-');
}

export function matchingLines(text, needle = retiredHaikuFamily()) {
  const hits = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(needle)) hits.push(`${i + 1}:${lines[i]}`);
  }
  return hits;
}

/**
 * Every tracked file that still names the retired family.
 * `git grep` exit 1 means a clean tree. Any other failure is a broken scanner.
 */
export function retiredHaikuHits(root = REPO_ROOT) {
  const needle = retiredHaikuFamily();
  try {
    const out = execFileSync('git', ['grep', '-a', '-n', '-F', '--', needle], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    return out.split('\n').filter((line) => line.length > 0);
  } catch (error) {
    if (error && error.status === 1) return [];
    throw error;
  }
}
