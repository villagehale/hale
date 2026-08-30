import type { ServiceOutcome } from './services/outcome';

/**
 * The one vocabulary for a degraded panel (rule #11 rendered): a missing key
 * names itself, a dead provider says it didn't answer, and neither is ever a
 * blank. Pure, so the copy is testable without rendering.
 */
export function serviceStateLine(
  provider: string,
  outcome: Extract<ServiceOutcome<unknown>, { ok: false }>,
): string {
  if (outcome.status === 'not_configured') {
    return `${outcome.detail}.`;
  }
  return `${provider} didn’t answer (${outcome.detail}) — the link below still works.`;
}

export const EMPTY_WINDOW_LINE = 'No rows in this window.';
