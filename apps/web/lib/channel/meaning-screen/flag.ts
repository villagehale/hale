import { isEnabled } from '@hale/flags';

/**
 * Barton rule sweep: leftover word-list / regex intent checks become a Haiku
 * read. Off unless MODEL_READ_SWEEP_ENABLED is exactly `true`. No trim: a
 * piped `vercel env add` stores a trailing newline, which must stay off.
 * `TRUE`, `on`, `1`, and unset stay off. Production may light it; nothing
 * here hard-offs in Prod. Declared in @hale/flags as `model-read-sweep`.
 */

export const MODEL_READ_SWEEP_ENABLED_ENV = 'MODEL_READ_SWEEP_ENABLED';

export function modelReadSweepEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isEnabled('model-read-sweep', undefined, env);
}
