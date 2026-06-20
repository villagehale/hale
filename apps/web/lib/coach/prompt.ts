import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveRepoFile } from './resolve-repo-file';

/**
 * Loads the coach SYSTEM PROMPT from the single source of truth that the worker
 * (and the Langfuse sync) own: `apps/worker/prompts/coach.md`. There is exactly
 * one copy of this prompt in the repo — hard rule #2 (prompts by reference, never
 * inline) plus "do not duplicate it so it can't drift".
 *
 * Loading a sibling-app file from a Next.js bundle is awkward: the file lives
 * outside apps/web, so Next won't trace it as an asset and a build that runs from
 * a copied output dir wouldn't find a module-relative path. Least-bad option:
 * resolve it at request time against the monorepo root. We anchor on the
 * `apps/web` segment of either `process.cwd()` (Next runs the route from the app
 * dir) or this module's own path, walk up to the repo root, then descend into
 * `apps/worker/prompts/coach.md`. No second copy is ever written.
 */

const PROMPT_REL = join('apps', 'worker', 'prompts', 'coach.md');

let cached: string | undefined;

export async function loadCoachPrompt(): Promise<string> {
  if (cached) return cached;
  cached = await readFile(resolveRepoFile(PROMPT_REL), 'utf8');
  return cached;
}
