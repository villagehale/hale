/**
 * VIL-581 · the claim reader's mode. Unset is `off`: nothing reads, nothing is queried
 * and the warm skips. `shadow` reads every gated body beside or after the regex
 * decision and only counts the comparison (claim-shadow.ts); no send changes.
 * `enforce` makes the reader part of the decision on the coach turn, the gated
 * sweeps, model-written dispatch bodies, and a passport line folded onto a send
 * (claim-enforce.ts), with the English regex kept as a floor beside it.
 *
 * The allowlist enforces named families (the test line) while the mode is `shadow`, so
 * the test line goes first and everyone else stays in shadow. It never arms anything
 * while the mode is `off`.
 *
 * Strict equality, no trim on the mode: a trailing newline from `vercel env add` must
 * not arm it. The allowlist is comma-separated and trimmed.
 */

import { flagValue } from '@hale/flags';

export const CLAIM_READER_MODE_ENV = 'CLAIM_READER_MODE';
export const CLAIM_READER_ENFORCE_ALLOWLIST_ENV = 'CLAIM_READER_ENFORCE_FAMILY_ALLOWLIST';

export type ClaimReaderMode = 'off' | 'shadow' | 'enforce';

export function claimReaderMode(
  env: Record<string, string | undefined> = process.env,
  familyId?: string,
): ClaimReaderMode {
  const value = flagValue('claim-reader-mode', familyId, env);
  if (value === 'shadow' || value === 'enforce') return value;
  return 'off';
}

/** Whether this family's sends are decided with the reader's verdict. */
export function claimReaderEnforces(
  familyId: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const mode = claimReaderMode(env, familyId);
  if (mode === 'enforce') return true;
  if (mode === 'off') return false;
  return (env[CLAIM_READER_ENFORCE_ALLOWLIST_ENV] ?? '')
    .split(',')
    .map((id) => id.trim())
    .includes(familyId);
}
