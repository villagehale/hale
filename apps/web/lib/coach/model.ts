import { SONNET_MODEL } from '@hale/agent';

/**
 * The coach model id comes from the single source of truth: `SONNET_MODEL` in
 * `@hale/agent`, the same constant the worker's agents and the drafter eval use.
 * apps/web already depends on `@hale/agent`, so we import it directly rather than
 * readFileSync-parse the worker's client.ts across the process boundary (a copy
 * that could silently drift).
 */

export async function loadCoachModel(): Promise<string> {
  return SONNET_MODEL;
}
