import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveRepoFile } from '~/lib/coach/resolve-repo-file';

/**
 * Loads the discovery SYSTEM PROMPT from the single source of truth the worker
 * (and the Langfuse sync) own: `apps/worker/prompts/discovery.md`. Exactly one
 * copy of this prompt exists in the repo — hard rule #2 (prompts by reference,
 * never inline). Same repo-root anchoring as the coach loader; `next.config.ts`
 * ships the worker prompts via `outputFileTracingIncludes` so resolveRepoFile
 * finds the file in a serverless bundle too.
 */

const PROMPT_REL = join('apps', 'worker', 'prompts', 'discovery.md');

let cached: string | undefined;

export async function loadDiscoveryPrompt(): Promise<string> {
  if (cached) return cached;
  cached = await readFile(resolveRepoFile(PROMPT_REL), 'utf8');
  return cached;
}
