import { type Database, schema } from '@hale/db';
import { isEnabled } from '@hale/flags';
import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import { recallChannelSigninParent } from '~/lib/auth/channel-signin';
import { readSendRefusal } from '~/lib/channel/outbound-transport';
import { OTP_MAX_ATTEMPTS, isOtpExpired, verifyBoundOtpCode } from '~/lib/channels/otp';
import type { OtpSender } from '~/lib/channels/otp-sender';
import {
  otpResendWaitMs,
  requestPhoneOtp,
  resolveSendablePhone,
} from '~/lib/channels/sms-consent-core';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { decryptString } from '~/lib/crypto/string-cipher';
import { enforceRateLimit } from '~/lib/rate-limit/apply';

/**
 * A texted /connect link can be forwarded or posted in a family group, so holding it
 * proves nothing. With CONNECT_LINK_CODE_ENABLED on, signing in from a link also takes a
 * code texted to the number Hale holds for the user the token names.
 *
 * The code lives in phone_verifications with the sign-in door's lifecycle (TTL, cooldown,
 * newest code wins, attempt cap), and its hash is bound to the token id, so it opens this
 * one link and nothing else: not a sibling link, not another user's, not /sign-in.
 */
export function connectLinkCodeEnabled(): boolean {
  return isEnabled('connect-link-code');
}

export type ConnectCodeRequestOutcome =
  | 'sent'
  | 'cooldown'
  | 'rate_limited'
  | 'dead_link'
  | 'no_verified_number'
  | 'sender_not_configured'
  | 'send_failed';

export async function requestConnectLinkCode(
  database: Database,
  input: { token: string; now?: Date },
  deps: { sender: OtpSender },
): Promise<ConnectCodeRequestOutcome> {
  const now = input.now ?? new Date();
  const link = await recallChannelSigninParent(input.token, database, { now });
  if (!link?.usable) return 'dead_link';

  const phone = await resolveSendablePhone(database, link.userId);
  if (!phone) return 'no_verified_number';

  // Before the limiter, because a tap that sends nothing must not spend the budget
  // /sign-in shares: family members tapping a posted link would lock the parent out.
  if ((await otpResendWaitMs(database, link.userId, now)) !== null) return 'cooldown';

  // The sign-in door's per-number budget, shared on purpose: a link must not buy a
  // number more texts than /sign-in allows. The limiter's upsert is atomic, which the
  // cooldown's read-then-send is not, so this is what holds under simultaneous taps.
  if (await enforceRateLimit('claim-phone-send', phoneBlindIndex(phone), true)) {
    return 'rate_limited';
  }

  let sent: Awaited<ReturnType<typeof requestPhoneOtp>>;
  try {
    sent = await requestPhoneOtp(
      database,
      { userId: link.userId, phoneRaw: phone, codeBinding: link.tokenId },
      { sender: deps.sender, now },
    );
  } catch (err) {
    const refusal = readSendRefusal(err);
    if (!refusal) throw err;
    console.warn({ code: refusal.code }, 'channel-link: code not accepted by the provider');
    return 'send_failed';
  }

  switch (sent.status) {
    case 'sent':
      // 'system', not the parent: whoever tapped has not proved who they are yet.
      await database.insert(schema.auditLog).values({
        familyId: link.familyId,
        actor: 'system',
        audience: link.userId,
        actionTaken: 'connector_link_code_sent',
        targetTable: 'channel_signin_tokens',
        targetId: link.tokenId,
        occurredAt: now,
      });
      return 'sent';
    case 'cooldown':
      return 'cooldown';
    case 'not_configured':
      return 'sender_not_configured';
    case 'invalid_phone':
      return 'no_verified_number';
  }
}

export type ConnectCodeRefusal =
  | 'no_code'
  | 'dead_link'
  | 'no_verified_number'
  | 'no_pending_code'
  | 'code_not_for_this_number'
  | 'expired'
  | 'locked'
  | 'wrong_code';

export async function verifyConnectLinkCode(
  database: Database,
  input: { token: string; code: string; now?: Date },
): Promise<{ ok: true } | { ok: false; reason: ConnectCodeRefusal }> {
  const now = input.now ?? new Date();
  const refuse = (reason: ConnectCodeRefusal) => ({ ok: false as const, reason });

  if (!input.code) return refuse('no_code');
  const link = await recallChannelSigninParent(input.token, database, { now });
  if (!link?.usable) return refuse('dead_link');
  const phone = await resolveSendablePhone(database, link.userId);
  if (!phone) return refuse('no_verified_number');

  const table = schema.phoneVerifications;
  const [pending] = await database
    .select({
      id: table.id,
      phoneE164Encrypted: table.phoneE164Encrypted,
      codeHash: table.codeHash,
      expiresAt: table.expiresAt,
    })
    .from(table)
    .where(and(eq(table.userId, link.userId), isNull(table.consumedAt)))
    .orderBy(desc(table.createdAt))
    .limit(1);
  if (!pending) return refuse('no_pending_code');
  if (decryptString(pending.phoneE164Encrypted) !== phone) {
    return refuse('code_not_for_this_number');
  }
  if (isOtpExpired(pending.expiresAt, now)) return refuse('expired');

  // Spend the attempt before comparing, in one statement, so simultaneous guesses
  // cannot all read the same count and exceed the cap.
  const [attempt] = await database
    .update(table)
    .set({ attemptCount: sql`${table.attemptCount} + 1` })
    .where(
      and(
        eq(table.id, pending.id),
        isNull(table.consumedAt),
        lt(table.attemptCount, OTP_MAX_ATTEMPTS),
      ),
    )
    .returning({ id: table.id });
  if (!attempt) return refuse('locked');

  if (!verifyBoundOtpCode(input.code, link.tokenId, pending.codeHash)) {
    return refuse('wrong_code');
  }

  const [burned] = await database
    .update(table)
    .set({ consumedAt: now })
    .where(and(eq(table.id, pending.id), isNull(table.consumedAt)))
    .returning({ id: table.id });
  return burned ? { ok: true } : refuse('no_pending_code');
}
