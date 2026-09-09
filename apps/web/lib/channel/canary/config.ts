import type { Database } from '@hale/db';
import { isSyntheticProbeNumber } from '~/lib/channels/phone';
import { resolveVerifiedChannelByPhone } from '~/lib/channels/sms-consent-core';

/**
 * THE INBOUND CANARY — who it is, what it says, and what answering it looks like.
 *
 * The lane in /api/health/crons watches REAL turns, and on the night the drain
 * handler threw for six hours there were ninety-eight minutes with no text at
 * all. So a second half exists: every ten minutes a Twilio-signed synthetic
 * inbound is posted to the real webhook and its far-side artifact is verified
 * on the following tick (see run.ts). This module is the identity both halves
 * join on.
 *
 * NO ENV VAR, deliberately. A `HALE_CANARY_FAMILY_ID` would be a second drift
 * axis over the same fact — and `vercel env add` from a piped echo stores a
 * trailing newline, which would make the handler decline every turn while the
 * cron kept injecting. The household is resolved through the identity path the
 * product already trusts: the blind index on parent_channels. Seed the
 * household and it works; revoke the channel and every half fails closed.
 */

/**
 * The probe's number, inside the operator's fictional +1 437-555-XXXX range
 * (channels/phone.ts). Being in that range is what keeps it out of every
 * human-facing signal — the founder ping and the village intro sweep both
 * consult `familyHasSyntheticProbeChannel` — while `normalizePhoneE164` still
 * accepts it as an ordinary NANP number, which it must, because the whole
 * point is that this turn walks the same path a parent's does.
 */
export const CANARY_PHONE_E164 = '+14375550100';

if (!isSyntheticProbeNumber(CANARY_PHONE_E164)) {
  throw new Error(
    'the inbound canary number must sit in the synthetic probe range — outside it, a probe turn can reach a human-facing signal',
  );
}

/** The one word the canary texts. Not a CASL keyword (those are consumed inside
 * handleInboundSms and never enqueue — a canary texting HELP would have been
 * green all night), not a join tag, not an add-command. */
export const CANARY_BODY = 'CANARY';

/**
 * The audit action that says the turn was answered. A DATA value: the handler
 * writes it and the cron's verification reads it back, so renaming it on one
 * side alone breaks the join — which is the fact run.test.ts pins.
 */
export const CANARY_ANSWERED_ACTION = 'sms_canary_answered';

export interface CanaryHousehold {
  familyId: string;
  parentUserId: string;
}

/**
 * The seeded canary household, or null when nothing answers to that number —
 * never seeded, or its channel revoked. Null is a first-class outcome on both
 * sides (rule #11): the cron THROWS on it before injecting, because an unknown
 * `From` would start an intake conversation and text the probe number every
 * tick; the handler simply declines.
 */
export async function canaryChannel(database: Database): Promise<CanaryHousehold | null> {
  const owner = await resolveVerifiedChannelByPhone(database, CANARY_PHONE_E164);
  return owner ? { familyId: owner.familyId, parentUserId: owner.userId } : null;
}

/**
 * Is this turn the canary's? The BODY is checked first and the lookup runs only
 * then, so the chain a real parent's text walks — and the door it walks through
 * — pays no extra query.
 */
export async function isCanaryTurn(
  database: Database,
  body: string,
  familyId: string,
): Promise<boolean> {
  if (body.trim().toUpperCase() !== CANARY_BODY) return false;
  const household = await canaryChannel(database);
  return household?.familyId === familyId;
}
