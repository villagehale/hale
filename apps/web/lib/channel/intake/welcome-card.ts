import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { acceptedStatus } from '~/lib/channel/ledger';
import { inProactiveQuietHours } from '~/lib/channel/outbound-gate';
import type { threadProactiveMessage } from '~/lib/channel/thread';
import { TwilioSendError } from '~/lib/channel/twilio/transport';
import { DEFAULT_TIMEZONE } from '~/lib/format/datetime';
import { MARKETING_SITE_URL } from '~/lib/legal-links';
import type { ChannelTransport } from './transport';

/**
 * The introduction, sent once: an MMS carrying Hale's own vCard, so the parent taps Add
 * and every later text arrives under a name and the navy turtle instead of a 289 number
 * they have to recognise.
 *
 * IT IS ITS OWN MESSAGE, not media hung on the welcome text, and that is the whole
 * design decision. Live against the prod messaging service (2026-08-26): a MediaUrl
 * Twilio cannot fetch does not degrade to a plain SMS — the WHOLE message goes to
 * `status: failed`, `error_code: 11200`, body and all. Attaching the card to the first
 * radar would mean a blip on one static file costs a family the only message a stranger
 * is guaranteed to read, plus the consent ask carrying the privacy link. Separated, a
 * lost card costs the card.
 *
 * CASL: no new send moment. This rides the reply the parent's own text just earned,
 * inside the intake conversation they started, under the same consent as the radar it
 * follows — which is also why it carries no footer (intake appends none).
 */

/** Where the card is served. apps/site owns the route (`app/hale.vcf/route.ts`), on the
 * marketing origin and on `www` — the apex 308s, and Twilio should not pay a hop to
 * fetch a contact card. Never the app domain: this URL is fetched by the PROVIDER, so
 * it has to be public. */
export const CONTACT_CARD_URL = `${MARKETING_SITE_URL}/hale.vcf`;

export const WELCOME_CARD_TEMPLATE_KEY = 'intake:welcome_card';

/** Plain, and ASCII-only so smart encoding keeps it in one GSM-7 part. */
export const WELCOME_CARD_BODY =
  "That's me - save my card so it's a name texting you, not a number.";

/** At most one card per family, ever, enforced by the partial unique index on
 * `channel_messages.dedupe_key`. */
export function welcomeCardDedupeKey(familyId: string): string {
  return `${WELCOME_CARD_TEMPLATE_KEY}:${familyId}`;
}

export interface WelcomeCardPorts {
  transport: ChannelTransport;
  threadMessage: typeof threadProactiveMessage;
}

/**
 * Every way this can end, named (rule #11). `already_sent` is the idempotent no-op and
 * `send_failed` is the card this family will not get — both are outcomes an operator can
 * read, and neither is silence.
 */
export type WelcomeCardOutcome =
  | { status: 'sent'; channelMessageId: string }
  | { status: 'not_sent'; reason: 'already_sent' }
  /** Held for the parent's quiet hours (2026-08-28 ads-week audit): the card is a
   * proactive EXTRA riding beside the radar reply, not the reply itself, and an MMS at
   * 22:36 is Hale making noise, not answering. Named on the ledger and never on the
   * dedupe key — a suppression must not spend this family's only card. */
  | { status: 'not_sent'; reason: 'suppressed_quiet_hours' }
  | { status: 'not_sent'; reason: 'send_failed'; code: string; permanent: boolean };

export async function sendWelcomeContactCard(
  database: Database,
  args: { familyId: string; parentUserId: string; phoneE164: string; now: Date },
  ports: WelcomeCardPorts,
): Promise<WelcomeCardOutcome> {
  const { familyId, parentUserId, now } = args;

  // QUIET HOURS, before the claim: the same window the outbound chokepoint enforces
  // (outbound-gate.ts), applied here by hand because this send runs seconds after
  // provisioning — before watch consent can exist — so the full gate cannot serve it.
  // The radar reply this rides beside is exempt by design; the extra is not.
  if (inProactiveQuietHours(now, await parentTimeZone(database, parentUserId))) {
    await database.insert(schema.channelMessages).values({
      familyId,
      parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'intake',
      templateKey: WELCOME_CARD_TEMPLATE_KEY,
      dedupeKey: null,
      status: 'suppressed_quiet_hours',
    });
    console.warn(
      { familyId },
      'intake welcome card: held for quiet hours - this family gets no contact card tonight (no re-drive exists yet)',
    );
    return { status: 'not_sent', reason: 'suppressed_quiet_hours' };
  }

  // CLAIM FIRST. The unique index is the claim, so "have we sent this?" is answered by
  // the insert rather than by a read another request can race. At-most-once is the right
  // side to err on for a contact card: a duplicate is a stranger's number texting a
  // vCard twice, and there is no retry that makes that better.
  const [claimed] = await database
    .insert(schema.channelMessages)
    .values({
      familyId,
      parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'intake',
      templateKey: WELCOME_CARD_TEMPLATE_KEY,
      dedupeKey: welcomeCardDedupeKey(familyId),
      status: acceptedStatus('sms'),
      sentAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: schema.channelMessages.id });
  if (!claimed) return { status: 'not_sent', reason: 'already_sent' };

  await database.insert(schema.auditLog).values({
    familyId,
    actor: parentUserId,
    actionTaken: 'sms_intake_contact_card',
    targetTable: 'channel_messages',
    targetId: claimed.id,
  });

  let providerMessageId: string;
  try {
    ({ providerMessageId } = await ports.transport.send({
      to: args.phoneE164,
      body: WELCOME_CARD_BODY,
      mediaUrls: [CONTACT_CARD_URL],
    }));
  } catch (err) {
    const code = err instanceof TwilioSendError ? err.code : 'unknown';
    const permanent = err instanceof TwilioSendError ? err.permanent : false;
    // The claimed row says what happened, so a family with no card is a query rather
    // than a guess. The key STAYS consumed either way (ledger.ts:
    // CONSUMED_SEND_STATUSES) — a failed delivery must never un-consume idempotency.
    await database
      .update(schema.channelMessages)
      .set({ status: 'failed', errorCode: code })
      .where(eq(schema.channelMessages.id, claimed.id));
    console.error(
      { familyId, code, permanent },
      'intake welcome card: the provider refused the MMS - this family will not see the contact card',
    );
    return { status: 'not_sent', reason: 'send_failed', code, permanent };
  }

  await database
    .update(schema.channelMessages)
    .set({ providerMessageId })
    .where(eq(schema.channelMessages.id, claimed.id));

  // The sentence Hale said, where the coach reads it back (channel/thread.ts). The card
  // itself is not a sentence and has nothing to thread.
  await ports.threadMessage(database, { familyId, parentUserId, body: WELCOME_CARD_BODY });

  return { status: 'sent', channelMessageId: claimed.id };
}

/** The parent's wall clock, off their own users row. Post-filtered by id as every
 * reader here is (defense in depth); the column is NOT NULL with a default in prod, so
 * the fallback only ever serves a store that skipped the default. */
async function parentTimeZone(database: Database, parentUserId: string): Promise<string> {
  const rows = await database
    .select({ id: schema.users.id, timezone: schema.users.timezone })
    .from(schema.users)
    .where(eq(schema.users.id, parentUserId));
  return rows.find((row) => row.id === parentUserId)?.timezone ?? DEFAULT_TIMEZONE;
}
