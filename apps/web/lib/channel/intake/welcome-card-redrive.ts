import { type Database, schema } from '@hale/db';
import { and, eq, gte, inArray, isNull } from 'drizzle-orm';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { PROACTIVE_QUIET_HOURS } from '~/lib/channel/outbound-gate';
import { DEFAULT_TIMEZONE } from '~/lib/format/datetime';
import { localParts } from '~/lib/loop/prefs';
import {
  WELCOME_CARD_TEMPLATE_KEY,
  type WelcomeCardPorts,
  sendWelcomeContactCard,
  welcomeCardDedupeKey,
} from './welcome-card';

/**
 * The card a family who onboarded at night was never sent.
 *
 * `sendWelcomeContactCard` holds the vCard through the parent's quiet hours and writes
 * the receipt saying so — and until now that was the end of it: a family that texted
 * Hale at 22:36 got every later message from an unnamed 289 number, forever, because
 * the one message that would have given Hale a name only ever had one chance to leave.
 * This is the second chance, and it is the SAME send: same function, same claim-first
 * dedupe key, same audit verb. Nothing here composes a message or reaches a transport
 * of its own.
 *
 * WHY IT IS NOT A NEW PROACTIVE CLASS, and so carries no gate kind and no dark-launch
 * flag of its own. This is not Hale deciding to interrupt a family; it is Hale finishing
 * an intake step the family already earned by texting first, deferred by a floor that
 * exists to protect their night. A flag here would mean the fix ships off, and a gate
 * kind would mean asking the outbound chokepoint about watch consent that does not exist
 * yet — the exact reason the card reads the quiet window by hand (outbound-gate.ts).
 */

/**
 * The local hour the held card goes out in — the hour the quiet window ENDS, read off
 * {@link PROACTIVE_QUIET_HOURS} rather than typed again, so a change to the floor moves
 * the re-drive with it.
 *
 * The cron fires hourly, so this matches the whole HOUR (the house rule: an exact-minute
 * match silently drops every family whose tick landed a minute late — nudge/run.ts).
 */
export const WELCOME_CARD_REDRIVE_HOUR_LOCAL = Number(PROACTIVE_QUIET_HOURS.end.slice(0, 2));

/**
 * How stale a held card may be and still be worth sending.
 *
 * An introduction is only an introduction for so long: a vCard arriving a fortnight after
 * the conversation it belonged to is a stranger's number texting a contact card out of
 * nowhere. It also bounds the scan — without it, every family this sweep can never serve
 * (no number, revoked channel) is re-read on every tick for the life of the product.
 */
export const WELCOME_CARD_REDRIVE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Filter first, then cap, so no family is starved out of their slot forever. */
const MAX_REDRIVE_FAMILIES_PER_RUN = 100;

/** Whether `now` sits in this family's re-drive hour, on the PARENT's own clock. */
export function isWelcomeCardRedriveSlot(now: Date, timeZone: string): boolean {
  return Math.floor(localParts(now, timeZone).minutes / 60) === WELCOME_CARD_REDRIVE_HOUR_LOCAL;
}

export interface WelcomeCardRedriveDeps {
  ports: WelcomeCardPorts;
  /** The parent's sendable number. Required (rule #11) — a re-drive with no way to
   * resolve a number is a sweep that silently sends nothing. */
  resolvePhone?: (database: Database, parentUserId: string) => Promise<string | null>;
}

/**
 * Every way a tick can end, counted. `held` is the population the sweep looked at,
 * `due` the slice whose local clock said now — the difference between them is the whole
 * reason most ticks send nothing, and without both numbers a zero is unreadable.
 */
export interface WelcomeCardRedriveResult {
  held: number;
  due: number;
  sent: number;
  alreadySent: number;
  noSendTarget: number;
  heldAgain: number;
  sendFailed: number;
}

function emptyResult(): WelcomeCardRedriveResult {
  return { held: 0, due: 0, sent: 0, alreadySent: 0, noSendTarget: 0, heldAgain: 0, sendFailed: 0 };
}

interface HeldCard {
  familyId: string;
  parentUserId: string;
}

/**
 * The families owed a card: a quiet-hours receipt with NO key spent, and no row anywhere
 * holding the family's one card key.
 *
 * Both halves matter. The status filter is what keeps a card suppressed for a cap or a
 * withdrawn consent out of this sweep — those are different refusals and re-driving them
 * at 08:00 would be overruling the reason they were refused. The key check is what keeps
 * a FAILED send out: a provider refusal consumes the key on purpose (ledger.ts), and a
 * family whose MMS Twilio rejected must not be retried from here.
 */
export async function selectHeldWelcomeCards(
  database: Database,
  now: Date,
): Promise<HeldCard[]> {
  const held = await database
    .select({
      familyId: schema.channelMessages.familyId,
      parentUserId: schema.channelMessages.parentUserId,
    })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.templateKey, WELCOME_CARD_TEMPLATE_KEY),
        eq(schema.channelMessages.status, 'suppressed_quiet_hours'),
        isNull(schema.channelMessages.dedupeKey),
        gte(
          schema.channelMessages.createdAt,
          new Date(now.getTime() - WELCOME_CARD_REDRIVE_MAX_AGE_MS),
        ),
      ),
    );

  const byFamily = new Map<string, HeldCard>();
  for (const row of held) byFamily.set(row.familyId, row);
  if (byFamily.size === 0) return [];

  const keys = [...byFamily.keys()].map(welcomeCardDedupeKey);
  const claimed = await database
    .select({ familyId: schema.channelMessages.familyId })
    .from(schema.channelMessages)
    .where(inArray(schema.channelMessages.dedupeKey, keys));
  for (const row of claimed) byFamily.delete(row.familyId);

  return [...byFamily.values()];
}

/** The parent's wall clock, off their own users row — the same reader the card uses. */
async function parentTimeZone(database: Database, parentUserId: string): Promise<string> {
  const rows = await database
    .select({ id: schema.users.id, timezone: schema.users.timezone })
    .from(schema.users)
    .where(eq(schema.users.id, parentUserId));
  return rows.find((row) => row.id === parentUserId)?.timezone ?? DEFAULT_TIMEZONE;
}

export async function runWelcomeCardRedrive(
  database: Database,
  deps: WelcomeCardRedriveDeps,
  now: Date = new Date(),
): Promise<WelcomeCardRedriveResult> {
  const resolvePhone = deps.resolvePhone ?? resolveSendablePhone;
  const result = emptyResult();

  const owed = await selectHeldWelcomeCards(database, now);
  result.held = owed.length;

  const due: Array<HeldCard & { phoneE164: string | null }> = [];
  for (const card of owed) {
    if (!isWelcomeCardRedriveSlot(now, await parentTimeZone(database, card.parentUserId))) continue;
    due.push({ ...card, phoneE164: await resolvePhone(database, card.parentUserId) });
  }
  result.due = due.length;

  for (const card of due.slice(0, MAX_REDRIVE_FAMILIES_PER_RUN)) {
    if (card.phoneE164 === null) {
      // NOT claimed and NOT written off: the family is still owed the card if they ever
      // re-enroll, and the reason this tick sent nothing is a count rather than silence.
      result.noSendTarget += 1;
      console.warn(
        { familyId: card.familyId },
        'welcome card re-drive: the held card has no sendable number - nothing sent, nothing spent',
      );
      continue;
    }
    const outcome = await sendWelcomeContactCard(
      database,
      {
        familyId: card.familyId,
        parentUserId: card.parentUserId,
        phoneE164: card.phoneE164,
        now,
      },
      deps.ports,
    );
    if (outcome.status === 'sent') result.sent += 1;
    else if (outcome.reason === 'already_sent') result.alreadySent += 1;
    else if (outcome.reason === 'suppressed_quiet_hours') result.heldAgain += 1;
    else result.sendFailed += 1;
  }

  return result;
}
