import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Loads system prompts from `apps/worker/prompts/<name>.md`.
 *
 * Why on disk and not inline: project CLAUDE.md hard rule — "no inline
 * prompts in code." Markdown files are versioned in git, reviewable in
 * PRs, and migrate cleanly to Langfuse later (the loader is the only
 * call site we need to change).
 *
 * Prompts are cached after first read.
 */

const cache = new Map<string, string>();

function promptsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // From .../src/prompts/loader.ts → .../prompts (sibling of src/)
  return join(here, '..', '..', 'prompts');
}

export async function loadPrompt(name: string): Promise<string> {
  const cached = cache.get(name);
  if (cached) return cached;

  const path = join(promptsDir(), `${name}.md`);
  const contents = await readFile(path, 'utf8');
  cache.set(name, contents);
  return contents;
}

/** Test seam: wipe the cache so a reload picks up edits in dev. */
export function clearPromptCache(): void {
  cache.clear();
}
