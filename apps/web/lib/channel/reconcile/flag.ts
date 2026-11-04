/**
 * VIL-581 · the claim reader's mode. Unset is `off`: nothing reads, nothing is queried
 * and the warm skips. `shadow` reads every gated body beside or after the regex
 * decision and only counts the comparison (claim-shadow.ts); no send changes. `enforce`
 * is not built yet and runs as `shadow`, with the event naming which was set.
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
