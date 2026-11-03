/**
 * VIL-581 · the claim reader's mode. Unset is `off`, and nothing reads a parent's
 * reply through the reader in PR 1 whatever the value: the warm route is its only
 * consumer (`off` skips the warm). `shadow` and `enforce` get their consumers in
 * PRs 2 and 3.
 *
 * Strict equality, no trim: a trailing newline from `vercel env add` must not arm it.
 */

export const CLAIM_READER_MODE_ENV = 'CLAIM_READER_MODE';

export type ClaimReaderMode = 'off' | 'shadow' | 'enforce';

export function claimReaderMode(
  env: Record<string, string | undefined> = process.env,
): ClaimReaderMode {
  const value = env[CLAIM_READER_MODE_ENV];
  if (value === 'shadow' || value === 'enforce') return value;
  return 'off';
}
