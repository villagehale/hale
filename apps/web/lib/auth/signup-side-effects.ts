import type { Database } from '@hale/db';
import type { captureServerEvent } from '~/lib/analytics/server-capture';
import { recordEmailSend } from '~/lib/cron/email-compliance';
import type { FounderSignupNotifier } from './founder-signal';
import type { VerificationEmailSender } from './verification-email';

/**
 * The side-effects that run the moment a credentials account is created, BEFORE
 * onboarding. Kept out of the server action so the orchestration is unit-testable
 * with fakes (no real DB / Resend / PostHog), mirroring the credentials/send-welcome
 * split. The action fires this and-forgets; every effect here is best-effort and
 * MUST NOT throw out — a failing signal can never break sign-up (CLAUDE.md #8:
 * boundary catch).
 *
 *  1. Founder new-signup signal — so the founder learns of EVERY join.
 *  2. Verification-send ledger — a 'verification' email_sends row (auditable like
 *     'welcome'), written only when the provider accepts the send.
 *  3. signup_completed analytics — fired on ACTUAL creation, server-side, keyed to
 *     the new user's opaque id, so cancelled/failed attempts aren't counted.
 *
 * (2) and (3) need the internal users.id. A credentials sign-up only creates a
 * `credentials` row; ensureUserRow mints the mirrored `users` row here (idempotent,
 * same `credentials:<id>` external id auth resolves to later — no divergence), so
 * the ledger FK and the analytics distinct_id both have a real id.
 */

export interface SignupSideEffectDeps {
  ensureUserId(): Promise<string>;
  founder: FounderSignupNotifier;
  verifier: VerificationEmailSender;
  captureServerEvent: typeof captureServerEvent;
}

export interface SignupSideEffectInput {
  db: Database;
  email: string;
  verifyUrl: string;
}

function logFailure(what: string, err: unknown): void {
  // Log only the message — a caught Resend/PostHog error can carry the recipient
  // address, and PII must not land in logs (rule #1).
  const message = err instanceof Error ? err.message : 'unknown error';
  console.error(`${what} (signup unaffected)`, { message });
}

/**
 * Fire the post-creation side-effects. Never throws: each effect is guarded so a
 * failure is logged (message only) and swallowed. Returns once all have settled.
 */
export async function dispatchSignupSideEffects(
  input: SignupSideEffectInput,
  deps: SignupSideEffectDeps,
): Promise<void> {
  // The founder signal needs only the email, so it runs regardless of whether the
  // users row could be minted.
  const founderSignal = deps.founder
    .notifySignup(input.email)
    .catch((err) => logFailure('founder signup signal failed', err));

  const userScoped = (async () => {
    const userId = await deps.ensureUserId();
    await Promise.all([
      recordVerificationSend(input, deps, userId).catch((err) =>
        logFailure('verification ledger failed', err),
      ),
      deps
        .captureServerEvent('signup_completed', userId, { method: 'email' })
        .catch((err) => logFailure('signup analytics failed', err)),
    ]);
  })().catch((err) => logFailure('signup user-row provisioning failed', err));

  await Promise.all([founderSignal, userScoped]);
}

async function recordVerificationSend(
  input: SignupSideEffectInput,
  deps: SignupSideEffectDeps,
  userId: string,
): Promise<void> {
  const result = await deps.verifier.sendVerification(input.email, input.verifyUrl);
  if (!result.accepted) {
    return;
  }
  await recordEmailSend(input.db, {
    userId,
    familyId: null,
    emailType: 'verification',
    recipient: input.email,
    providerMessageId: result.providerMessageId,
  });
}
