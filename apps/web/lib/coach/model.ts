import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveRepoFile } from './resolve-repo-file';

/**
 * The coach model id lives in ONE place: `apps/worker/src/anthropic/client.ts`
 * (`SONNET_MODEL`), the same constant the worker's agents and the drafter eval
 * use. apps/web cannot import the worker's internal module, and there's no shared
 * package that re-exports it, so — exactly as `run-drafter-eval.mjs` does — we
 * read the constant out of that file at request time rather than mint a second
 * copy that could drift. Same repo-root anchoring as the prompt loader.
 */

const CLIENT_REL = join('apps', 'worker', 'src', 'anthropic', 'client.ts');

let cached: string | undefined;

export async function loadCoachModel(): Promise<string> {
  if (cached) return cached;
  const src = await readFile(resolveRepoFile(CLIENT_REL), 'utf8');
  const match = src.match(/SONNET_MODEL\s*=\s*'([^']+)'/);
  const model = match?.[1];
  if (!model) {
    throw new Error(`could not parse SONNET_MODEL from ${CLIENT_REL}`);
  }
  cached = model;
  return cached;
}
