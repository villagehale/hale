/**
 * VIL-581 · the claim reader's mode. Unset is `enforce`: the reader is part of the
 * decision on the coach turn, the gated sweeps, model-written dispatch bodies, and a
 * passport line folded onto a send (claim-enforce.ts), with the English regex kept as a
 * floor beside it. `shadow` reads every gated body beside or after the regex decision
 * and only counts the comparison (claim-shadow.ts); no send changes. `off` is the kill
 * switch: nothing reads, nothing is queried and the warm skips.
 *
 * `off` and `false` are matched trimmed, so a trailing newline from `vercel env add`
 * still kills; `shadow` and `enforce` are exact (packages/flags `offVariant`).
 *
 * The allowlist enforces named families while the mode is `shadow`. It never arms
 * anything while the mode is `off`.
 */

import { flagValue, isEnabled } from '@hale/flags';

export const CLAIM_READER_MODE_ENV = 'CLAIM_READER_MODE';
export const CLAIM_READER_ENFORCE_ALLOWLIST_ENV = 'CLAIM_READER_ENFORCE_FAMILY_ALLOWLIST';

export type ClaimReaderMode = 'off' | 'shadow' | 'enforce';

export function claimReaderMode(
  env: Record<string, string | undefined> = process.env,
  familyId?: string,
): ClaimReaderMode {
  const value = flagValue('claim-reader-mode', familyId, env);
  if (value === 'shadow' || value === 'enforce' || value === 'off') return value;
  throw new Error(`claim reader: unknown mode ${value}`);
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

/**
 * VIL-732 · a named recipient's claim candidates include the kid-judged mirrors of their
 * own Google Calendar, the rows their reminders are written from (candidate-rows.ts).
 * Dark: household rows only, and a reminder about a mirrored event is refused unbacked.
 */
export function claimReadOwnMirrorsEnabled(
  familyId: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isEnabled('claim-read-own-mirrors', familyId, env);
}

/**
 * VIL-732 · a dispatch leg the claim reader refused keeps its verdict in
 * `claim_refusals` (migration 0259): each claim's kind, cited alias and why, and how
 * many rows of each source were offered. No body. Dark: nothing is written.
 */
export function claimRefusalStoreEnabled(
  familyId: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isEnabled('claim-refusal-store', familyId, env);
}
