import type { Database } from '@hale/db';
import { captureServerEvent } from '~/lib/analytics/server-capture';
import { ensureUserRow } from '~/lib/family';
import { credentialExternalAuthId } from './credentials';
import { createFounderSignupNotifier } from './founder-signal';
import type { SignupSideEffectDeps } from './signup-side-effects';
import { createVerificationEmailSender } from './verification-email';

/**
 * Production wiring for the signup side-effects. Kept apart from the testable core
 * (signup-side-effects.ts) because ensureUserRow pulls ~/lib/family → ~/auth
 * (next-auth), which can't load in the node test runner — the core stays free of
 * that so its orchestration is unit-tested with fakes.
 *
 * The mirrored `users` row is minted here with the SAME `credentials:<id>` external
 * id auth resolves to later (ensureUserRow is idempotent), so the verification
 * ledger FK and the analytics distinct_id both key to the real, stable user id.
 */
export function defaultSignupSideEffectDeps(
  db: Database,
  credentialId: string,
  email: string,
): SignupSideEffectDeps {
  return {
    ensureUserId: () =>
      ensureUserRow(
        { externalAuthId: credentialExternalAuthId(credentialId), email, name: null },
        db,
      ),
    founder: createFounderSignupNotifier(),
    verifier: createVerificationEmailSender(),
    captureServerEvent,
  };
}
