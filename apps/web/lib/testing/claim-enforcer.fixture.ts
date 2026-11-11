import type { ClaimEnforcer } from '~/lib/channel/reconcile/claim-enforce';
import { claimReaderEnforces } from '~/lib/channel/reconcile/flag';

/**
 * Mechanics tests: a clean read, no live model. Enforce still respects the flag, so a
 * test that stubs CLAIM_READER_MODE off takes the regex path, and a test that lights
 * enforce gets empty claims (the English floor still applies beside it).
 */
export function cleanClaimEnforcer(): ClaimEnforcer {
  return {
    enforces: (familyId) => claimReaderEnforces(familyId),
    async read() {
      return {
        status: 'read',
        segments: [],
        verdict: { resolutions: [], refusedSegments: [], mints: [] },
        mints: [],
      };
    },
  };
}
