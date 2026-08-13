import { type Database, schema } from '@hale/db';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { isParentRole } from '~/lib/channel/role-scope';
import type { OtpSender } from '~/lib/channels/otp-sender';
import {
  OTP_MAX_ATTEMPTS,
  isOtpExpired,
  isOtpLockedOut,
  verifyOtpCode,
} from '~/lib/channels/otp';
import { normalizePhoneE164 } from '~/lib/channels/phone';
import { requestPhoneOtp, resolveVerifiedChannelByPhone } from '~/lib/channels/sms-consent-core';
import { decryptString } from '~/lib/crypto/string-cipher';

/**
 * Claiming the receipts room by phone.
 *
 * A family that arrived by TEXT (channel/intake/provision.ts) already has a users row
 * — `external_auth_id = 'sms:<phone blind index>'`, `email` NULL. Until now that
 * account had no way in: every web sign-in path mints an identity from an email
 * address, so a parent who signed in got a SECOND account and their own family stayed
 * behind on the number. This is the missing door, and its whole job is that the door
 * leads to the SAME room: the session subject is the external_auth_id the account
 * ALREADY has, so there is no create-or-merge branch anywhere in here to get wrong.
 *
 * WHAT PROVES IT IS THEM. Possession of the number, demonstrated by a code we texted
 * to it — the same OTP primitives (lib/channels/otp) the Settings enrolment uses, with
 * the same TTL, attempt ceiling and resend cooldown. The number itself is never
 * matched in plaintext: the lookup goes through the keyed blind index, exactly as the
 * inbound webhook's does.
 *
 * TWO GATES, and they are the pair the inbound leg already uses.
 * `resolveVerifiedChannelByPhone` answers "is this an active, verified, non-revoked
 * channel" — so a number that texted STOP resolves to nothing and is sent no code.
 * `isParentRole` answers "is this person a parent" — a caregiver or teen holding a
 * verified channel is refused, because a claim is not a message, it is the household's
 * account.
 *
 * WHAT THIS DELIBERATELY IS NOT: account LINKING. A visitor already signed in under a
 * different identity is untouched by this flow; there is no path here that attaches a
 * phone to an existing web account or merges two accounts. That is a separate,
 * consent-bearing decision and it is out of scope.
 *
 * ANTI-ENUMERATION (rule #1) is a property of the CALLER, not of this module. Every
 * outcome below is distinct on purpose so the server can log which gate closed; the
 * HTTP layer collapses them all into one constant response, and only the SMS itself
 * differs between a number we know and one we don't.
 */

export type ClaimCodeOutcome =
  | { status: 'sent' }
  | { status: 'invalid_phone' }
  /** Unknown number, unverified channel, or one revoked by STOP. */
  | { status: 'no_claimable_account' }
  | { status: 'not_a_parent' }
  | { status: 'cooldown' }
  /** Rule #11: no transport is a NAMED outcome, never a silent nothing-happened. */
  | { status: 'sender_not_configured' };

export interface ClaimSendDeps {
  sender: OtpSender;
  generateCode?: () => string;
}

/**
 * The claimable parent behind a number, or the reason there isn't one. Both entry
 * points start here, so the two gates cannot drift apart between requesting a code and
 * spending it.
 */
async function resolveClaimant(
  database: Database,
  phoneE164: string,
): Promise<
  | { ok: true; userId: string; familyId: string }
  | { ok: false; reason: 'no_claimable_account' | 'not_a_parent' }
> {
  const channel = await resolveVerifiedChannelByPhone(database, phoneE164);
  if (!channel) return { ok: false, reason: 'no_claimable_account' };

  const members = await database
    .select({
      familyId: schema.familyMembers.familyId,
      userId: schema.familyMembers.userId,
      role: schema.familyMembers.role,
    })
    .from(schema.familyMembers)
    .where(eq(schema.familyMembers.userId, channel.userId));
  const membership = members.find(
    (row) => row.userId === channel.userId && row.familyId === channel.familyId,
  );
  if (!membership || !isParentRole(membership.role)) {
    return { ok: false, reason: 'not_a_parent' };
  }

  return { ok: true, userId: channel.userId, familyId: channel.familyId };
}

/**
 * Text a sign-in code to a number that already owns an account here. Sends to nobody
 * else: an unknown number, a revoked one, and a caregiver's all leave without an SMS
 * and without a stored code.
 *
 * CASL basis: transactional. The person typed their number into the sign-in form and
 * asked for it — the message is the response to that request, carries no marketing,
 * and reaches only a number that separately holds an active consent record.
 */
export async function requestClaimCode(
  database: Database,
  input: { phoneRaw: string; now?: Date },
  deps: ClaimSendDeps,
): Promise<ClaimCodeOutcome> {
  const phoneE164 = normalizePhoneE164(input.phoneRaw);
  if (!phoneE164) return { status: 'invalid_phone' };

  const claimant = await resolveClaimant(database, phoneE164);
  if (!claimant.ok) return { status: claimant.reason };

  // The mint/send/persist lifecycle is the enrolment engine's, unchanged: one place
  // owns "only the newest code works", the 60s resend cooldown, and the rule that
  // nothing is persisted unless the send actually happened.
  const sent = await requestPhoneOtp(
    database,
    { userId: claimant.userId, phoneRaw: phoneE164 },
    { sender: deps.sender, now: input.now, generateCode: deps.generateCode },
  );

  switch (sent.status) {
    case 'sent':
      // The masked number the engine returns is dropped here: echoing it back would
      // confirm to an unauthenticated caller that the number has an account.
      return { status: 'sent' };
    case 'not_configured':
      return { status: 'sender_not_configured' };
    case 'cooldown':
      return { status: 'cooldown' };
    case 'invalid_phone':
      return { status: 'invalid_phone' };
  }
}

export type ClaimRefusalReason =
  | 'invalid_phone'
  | 'no_claimable_account'
  | 'not_a_parent'
  | 'no_pending_code'
  | 'code_not_for_this_number'
  | 'locked'
  | 'expired'
  | 'wrong_code'
  | 'no_identity';

export type ClaimVerifyOutcome =
  | { status: 'claimed'; externalAuthId: string; userId: string; familyId: string }
  /** The reason is for the SERVER's log. Every refusal is one generic failure to the
   * caller — never which gate closed, never whether the account exists. */
  | { status: 'refused'; reason: ClaimRefusalReason };

/**
 * Spend a code and claim the account. On success the caller mints a session whose
 * subject is the returned `externalAuthId` — the one the account already had.
 *
 * The code is bound to the NUMBER, not just to the user: a live code this parent holds
 * for a different handset (a Settings re-enrolment in flight) cannot be typed in here
 * to claim this one. Single-use is enforced by a conditional burn inside the same
 * transaction as the audit row, so a code cannot be spent twice by two racing requests.
 */
export async function verifyClaimCode(
  database: Database,
  input: { phoneRaw: string; code: string; now?: Date },
): Promise<ClaimVerifyOutcome> {
  const now = input.now ?? new Date();
  const refuse = (reason: ClaimRefusalReason): ClaimVerifyOutcome => ({
    status: 'refused',
    reason,
  });

  const phoneE164 = normalizePhoneE164(input.phoneRaw);
  if (!phoneE164) return refuse('invalid_phone');

  const claimant = await resolveClaimant(database, phoneE164);
  if (!claimant.ok) return refuse(claimant.reason);

  const [pending] = await database
    .select({
      id: schema.phoneVerifications.id,
      phoneE164Encrypted: schema.phoneVerifications.phoneE164Encrypted,
      codeHash: schema.phoneVerifications.codeHash,
      expiresAt: schema.phoneVerifications.expiresAt,
      attemptCount: schema.phoneVerifications.attemptCount,
    })
    .from(schema.phoneVerifications)
    .where(
      and(
        eq(schema.phoneVerifications.userId, claimant.userId),
        isNull(schema.phoneVerifications.consumedAt),
      ),
    )
    .orderBy(desc(schema.phoneVerifications.createdAt))
    .limit(1);

  if (!pending) return refuse('no_pending_code');
  if (decryptString(pending.phoneE164Encrypted) !== phoneE164) {
    return refuse('code_not_for_this_number');
  }
  if (isOtpLockedOut(pending.attemptCount)) return refuse('locked');
  if (isOtpExpired(pending.expiresAt, now)) return refuse('expired');

  if (!verifyOtpCode(input.code, pending.codeHash)) {
    const attemptCount = pending.attemptCount + 1;
    await database
      .update(schema.phoneVerifications)
      .set({ attemptCount })
      .where(eq(schema.phoneVerifications.id, pending.id));
    return refuse(isOtpLockedOut(attemptCount) ? 'locked' : 'wrong_code');
  }

  // Read the identity BEFORE burning anything: a user row we cannot name is a session
  // we cannot mint, and it must cost the parent nothing to discover that.
  const [user] = await database
    .select({ externalAuthId: schema.users.externalAuthId })
    .from(schema.users)
    .where(eq(schema.users.id, claimant.userId))
    .limit(1);
  const externalAuthId = user?.externalAuthId;
  if (!externalAuthId) return refuse('no_identity');

  const claimed = await database.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    const burned = await tx
      .update(schema.phoneVerifications)
      .set({ consumedAt: now })
      .where(
        and(
          eq(schema.phoneVerifications.id, pending.id),
          isNull(schema.phoneVerifications.consumedAt),
        ),
      )
      .returning({ id: schema.phoneVerifications.id });
    if (!burned[0]) return false;

    // Rule #6. Coarse on purpose: WHO signed in and WHEN. The number is the credential
    // that was presented, so it has no business in the record of presenting it — not
    // even masked, which is more than the audit needs to be useful.
    await tx.insert(schema.auditLog).values({
      familyId: claimant.familyId,
      actor: claimant.userId,
      actionTaken: 'account_claimed_by_phone',
      targetTable: 'users',
      targetId: claimant.userId,
      occurredAt: now,
    });
    return true;
  });

  if (!claimed) return refuse('no_pending_code');

  return { status: 'claimed', externalAuthId, userId: claimant.userId, familyId: claimant.familyId };
}

/** The attempts a parent has left on a fresh code — surfaced only as UI copy. */
export const CLAIM_MAX_ATTEMPTS = OTP_MAX_ATTEMPTS;
