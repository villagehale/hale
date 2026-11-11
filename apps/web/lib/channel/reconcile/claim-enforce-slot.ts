import type { ClaimEnforcer } from './claim-enforce';

/**
 * The process-wide claim enforcer, kept in a file that does not load the reader
 * or the model client. Tests install a scripted enforcer from vitest.setup without
 * evaluating claim-enforce.ts (which would bind the live structured-output seam
 * before a suite can mock it).
 */

let shared: ClaimEnforcer | undefined;

export function defaultClaimEnforcerSlot(): ClaimEnforcer | undefined {
  return shared;
}

/** Tests install a scripted enforcer here; null restores the production reader. */
export function setDefaultClaimEnforcer(enforcer: ClaimEnforcer | null): void {
  shared = enforcer ?? undefined;
}
