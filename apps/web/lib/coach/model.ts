import { type ModelId, pickModel } from '@hale/agent';

/**
 * The coach model id comes from the single source of truth: the `converse` lane in
 * `@hale/agent`, the same table the worker's agents route through. apps/web already
 * depends on `@hale/agent`, so we import it directly rather than readFileSync-parse
 * the worker's client.ts across the process boundary (a copy that could silently
 * drift).
 */

export async function loadCoachModel(): Promise<ModelId> {
  return pickModel('converse');
}
