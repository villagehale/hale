import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, parse } from 'node:path';

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

const PROMPTS_REL = join('apps', 'worker', 'prompts');

/**
 * Resolve `<name>.md` under apps/worker/prompts.
 *
 * Fast path (the worker process): the prompts dir is a sibling of `src/`,
 * reachable relative to this module. Bundled path (apps/web imports the
 * orchestrator and Next re-bundles this source, so `import.meta.url` no longer
 * points at apps/worker): walk up from cwd + the module dir testing
 * `<dir>/apps/worker/prompts/<name>.md`. The file is shipped into the Vercel
 * function bundle via next.config.ts `outputFileTracingIncludes`. Single source
 * of truth either way (rule #2) — we never write a copy.
 */
function resolvePromptPath(name: string): string {
  const sibling = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'prompts', `${name}.md`);
  if (existsSync(sibling)) return sibling;

  const anchors = [process.cwd(), dirname(fileURLToPath(import.meta.url))];
  for (const anchor of anchors) {
    let dir = anchor;
    const root = parse(dir).root;
    while (true) {
      const candidate = join(dir, PROMPTS_REL, `${name}.md`);
      if (existsSync(candidate)) return candidate;
      if (dir === root) break;
      dir = dirname(dir);
    }
  }
  return sibling;
}

export async function loadPrompt(name: string): Promise<string> {
  const cached = cache.get(name);
  if (cached) return cached;

  const path = resolvePromptPath(name);
  const contents = await readFile(path, 'utf8');
  cache.set(name, contents);
  return contents;
}

/** Test seam: wipe the cache so a reload picks up edits in dev. */
export function clearPromptCache(): void {
  cache.clear();
}
