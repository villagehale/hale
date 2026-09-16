import { type Database, schema } from '@hale/db';
import { type SQL, sql } from 'drizzle-orm';
import { isSyntheticProbeNumber } from '~/lib/channels/phone';
import { resolveVerifiedChannelByPhone } from '~/lib/channels/sms-consent-core';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';

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
 * The canary's own rows, excluded from an aggregate the founder reads as a
 * measure of families — keyed on whichever column names the person: the sender
 * of a `channel_messages` row, the actor of an `audit_log` one.
 *
 * Six synthetic inbounds an hour is one permanent extra sender EVERY day and a
 * 6/hour floor under the hourly strip: "families who texted today" could never
 * read 0 again, and the founder's line would stop being a measure of families.
 * Each of those ticks also lands two audit rows — the door's `sms_reply_received`
 * and the handler's answer — which is 288 a day against nine households, enough
 * to make the audit mix a picture of the probe. The door already keeps it out of
 * the routed counter (`handed_off_canary`); this keeps it out of the dashboards.
 *
 * `not exists` rather than `not in` on purpose: `parent_user_id` is nullable,
 * and `null not in (…)` is NULL, which would silently drop those rows from
 * counts that must include them. A correlated probe on the blind index — the
 * same identity both halves of the canary join on — needs no decryption and
 * rides `parent_channels`' own index on the hash. Both sides of the identity
 * comparison are cast because `audit_log.actor` is TEXT and reads 'system' or an
 * agent-run id as often as a user id, so it is the uuid that must give way.
 */
export function notCanaryTraffic(actor: SQL | unknown): SQL {
  return sql`not exists (select 1 from ${schema.parentChannels} where ${schema.parentChannels.userId}::text = ${actor}::text and ${schema.parentChannels.phoneE164Hash} = ${phoneBlindIndex(CANARY_PHONE_E164)})`;
}

function isCanaryBody(body: string): boolean {
  return body.trim().toUpperCase() === CANARY_BODY;
}

/**
 * Is this turn the canary's, as THE DOOR can tell? The door has already
 * canonicalized the `From`, so the identity is right there and the question is
 * pure. That matters more than the saved query: the door asks only to LABEL its
 * counter, and it asks after the ledger insert, the audit row and the enqueue
 * have all committed — a lookup there could turn a completed hand-off into a
 * 500, a Twilio retry, and a 'duplicate'. A label must never be able to fail the
 * request it is labelling.
 *
 * The NUMBER alone, not the number and the word. Everything arriving from the
 * probe is synthetic whatever it says, which is the same rule `notCanaryTraffic`
 * applies to the dashboards; a label that also demanded the word would put
 * synthetic turns back into the real denominator the day the cron's body
 * constant drifts. The word is the HANDLER's question — whether to answer — and
 * that one is asked in `isCanaryTurn`.
 */
export function isCanaryInbound(phoneE164: string): boolean {
  return phoneE164 === CANARY_PHONE_E164;
}

/**
 * The same question from INSIDE the router, which holds a familyId and not a
 * number, so it must resolve the household. The BODY is checked first, so the
 * chain a real parent's text walks pays no extra query.
 */
export async function isCanaryTurn(
  database: Database,
  body: string,
  familyId: string,
): Promise<boolean> {
  if (!isCanaryBody(body)) return false;
  const household = await canaryChannel(database);
  return household?.familyId === familyId;
}
