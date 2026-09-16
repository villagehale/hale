import { type Database, schema } from '@hale/db';
import { and, desc, eq, gte, isNotNull, like, lte } from 'drizzle-orm';
import { appBaseUrl } from '~/lib/cron/email-compliance';
import { type TwilioConfig, twilioConfig } from '../twilio/config';
import { computeTwilioSignature } from '../twilio/signature';
import {
  CANARY_ANSWERED_ACTION,
  CANARY_BODY,
  CANARY_PHONE_E164,
  canaryChannel,
} from './config';

/**
 * THE WRITE SIDE — one synthetic turn every ten minutes, and a verdict on the
 * previous one.
 *
 * The read-side lane (deadman.ts) watches REAL turns, and the night the drain
 * handler threw for six hours had ninety-eight minutes with nobody texting. So
 * this posts a Twilio-signed inbound to the REAL webhook — the route shell,
 * its failure boundary, the signature contract, the ledger insert, the
 * enqueue, the after() drain kick, the whole router graph — and then asserts
 * the FAR-SIDE ARTIFACT of the previous tick. Never this tick's HTTP status:
 * the door answers 200 for every authentic request by design, so its response
 * proves only that the door is up.
 *
 * Nothing here is caught. `cronRoute` stamps the dead-man ledger only when the
 * handler RETURNS, so every throw below withholds the stamp and, at
 * 2×600+900 = 2100s, `inbound-canary` reads stale and pages: one failed tick
 * never wakes the founder, three consecutive do.
 */

export interface InboundCanaryDeps {
  database: Database;
  /** The injector. Non-nullable (rule #11): a canary that could be built
   * without a way to post is a monitor that silently monitors nothing. */
  fetch: typeof globalThis.fetch;
  now: () => Date;
}

/** Marks a `channel_messages` row as this cron's own, for the verify read. */
export const CANARY_SID_PREFIX = 'hale-canary-';

/** Bounded well inside the route's maxDuration, so a hung door still throws. */
const INJECTION_TIMEOUT_MS = 10_000;

/**
 * The window the PREVIOUS tick's row must fall in, by TIME rather than by slot
 * arithmetic: a `9-59/10` fire sits sixty seconds from its slot boundary and
 * Vercel lag skips slots, so a floor(now/period) key is the "a cron is a SLOT"
 * landmine wearing a different hat. Two minutes covers the async kick;
 * twenty-two covers two ticks plus lag.
 */
const VERIFY_NOT_AFTER_MS = 2 * 60_000;
export const VERIFY_NOT_BEFORE_MS = 22 * 60_000;

/**
 * Minute-truncated, so two invocations inside one minute collide on
 * `channel_messages_inbound_provider_msg_uniq` and the second is answered
 * 'duplicate' rather than becoming a second turn.
 */
function canarySid(now: Date): string {
  const minute = new Date(now);
  minute.setSeconds(0, 0);
  return `${CANARY_SID_PREFIX}${minute.toISOString()}`;
}

async function inject(deps: InboundCanaryDeps, twilio: TwilioConfig, now: Date): Promise<void> {
  const url = `${appBaseUrl()}/api/channels/twilio/inbound`;
  const params = {
    Body: CANARY_BODY,
    From: CANARY_PHONE_E164,
    MessageSid: canarySid(now),
    To: twilio.fromNumber,
  };

  const response = await deps.fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      // Over the CANONICAL origin, which is what twilioWebhookUrl rebuilds and
      // verifies against — never the request Host.
      'x-twilio-signature': computeTwilioSignature(twilio.authToken, url, params),
    },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(INJECTION_TIMEOUT_MS),
  });

  if (!response.ok) {
    // 503 is twilio_not_configured, 403 is APP_URL/auth-token drift — either
    // way the webhook is the thing to look at, and the status says which.
    throw new Error(`inbound canary: the door refused the injection (${response.status})`);
  }
}

async function verifyPreviousTick(
  database: Database,
  familyId: string,
  now: Date,
): Promise<void> {
  const [prior] = await database
    .select({ id: schema.channelMessages.id, sentAt: schema.channelMessages.sentAt })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, familyId),
        eq(schema.channelMessages.direction, 'in'),
        like(schema.channelMessages.providerMessageId, `${CANARY_SID_PREFIX}%`),
        isNotNull(schema.channelMessages.sentAt),
        gte(schema.channelMessages.sentAt, new Date(now.getTime() - VERIFY_NOT_BEFORE_MS)),
        lte(schema.channelMessages.sentAt, new Date(now.getTime() - VERIFY_NOT_AFTER_MS)),
      ),
    )
    .orderBy(desc(schema.channelMessages.sentAt))
    .limit(1);

  if (!prior?.sentAt) {
    throw new Error(
      'inbound canary: no injection in the last 22 minutes landed as an inbound row — the door, the signature, or the canary channel is broken',
    );
  }

  const [answered] = await database
    .select({ id: schema.auditLog.id })
    .from(schema.auditLog)
    .where(
      and(
        // family_id + occurred_at leads audit_log's only index.
        eq(schema.auditLog.familyId, familyId),
        gte(schema.auditLog.occurredAt, prior.sentAt),
        eq(schema.auditLog.actionTaken, CANARY_ANSWERED_ACTION),
        eq(schema.auditLog.targetTable, 'channel_messages'),
        eq(schema.auditLog.targetId, prior.id),
      ),
    )
    .limit(1);

  if (!answered) {
    throw new Error(
      `inbound canary: the turn recorded at ${prior.sentAt.toISOString()} was never answered — the drain handler or the router is failing`,
    );
  }
}

/**
 * Order matters, and every step of it is a fail-closed decision:
 *
 *   1. Twilio config, or the signature cannot be computed at all.
 *   2. THE HOUSEHOLD, before anything is posted. An unseeded (or revoked)
 *      canary number is an unknown `From`, and an unknown `From` reaches the
 *      intake machine — which would start a conversation and text
 *      +1 437-555-0100 every tick. Refusing here is the difference between a
 *      monitor that pages and a monitor that spams a phone number.
 *   3. INJECT, then
 *   4. VERIFY THE PREVIOUS TICK — in that order, so a broken lane keeps being
 *      probed and the alarm clears itself on the tick after a fix lands.
 */
export async function runInboundCanary(deps: InboundCanaryDeps): Promise<void> {
  const twilio = twilioConfig();
  if (!twilio) throw new Error('inbound canary: not configured');

  const household = await canaryChannel(deps.database);
  if (!household) throw new Error('inbound canary: household not seeded');

  const now = deps.now();
  await inject(deps, twilio, now);
  await verifyPreviousTick(deps.database, household.familyId, now);
}
