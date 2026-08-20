import { type Database, schema } from '@hale/db';
import { and, eq, gte, isNotNull, isNull, lt } from 'drizzle-orm';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { acceptedStatus } from '~/lib/channel/ledger';
import { f14EnabledFor } from '~/lib/channel/nudge/run';
import { createTwilioTransport } from '~/lib/channel/twilio/transport';
import { decryptString } from '~/lib/crypto/string-cipher';
import { localParts } from '~/lib/loop/prefs';
import { dayKeyIn } from '~/lib/plan/spine';
import { partyWhen, redactTeenNames } from './card';
import { guestCancellation, guestReminder } from './guest-copy';
import { claimGuestReminder, loadTeenFirstNames, releaseGuestReminder } from './store';

/**
 * VIL-245 · M10 — the day-before reminder to GUESTS, and the cancellation notice that
 * shares its machinery.
 *
 * WHY THIS DOES NOT GO THROUGH THE F14 OUTBOUND GATE. `assertProactiveSendAllowed` is
 * parent-scoped in all four of its checks — an enrolled `parent_channels` row, a
 * `proactive_watch` consent, a per-family cap counted on that parent's ledger, and the
 * PARENT's timezone. A party guest has none of those and never will: they have no
 * account, gave no watch consent, and are not in anybody's household. Routing them
 * through the gate would mean either widening every port to accept a phone number with
 * no user behind it, or answering four questions about the host to decide whether to
 * text a stranger. Both are wrong. So this leg carries its own bounds, and they are
 * stricter than the gate's, not looser:
 *
 *   CONSENT is the guest's own, express, and typed into a form that said exactly what
 *     they would receive. It is the `reminder_opt_in_at` timestamp, and the table's
 *     CHECK makes a stored number without it unrepresentable.
 *   VOLUME is bounded by the LADDER, not a counter — the same reasoning that gives
 *     `registration_sequence` a null cap. A guest receives at most TWO messages ever:
 *     one reminder for the one party they answered, and a cancellation if the host
 *     calls it off. A counter over a two-message maximum would not be a safety rail.
 *   QUIET HOURS are satisfied BY CONSTRUCTION rather than by a check. Hale does not
 *     know a guest's timezone and will not guess one, so the sweep only fires in the
 *     HOST family's mid-morning hour — the party is local, the guests are local, and a
 *     10 a.m. send cannot land at 3 a.m. for anyone plausibly attending. This is the
 *     subtraction: no timezone to store, no check to get wrong.
 *   THE WAY OUT travels with every message (`GUEST_OPT_OUT`). A guest STOP is honoured
 *     two ways — the carrier's own opt-out list rejects the send (Twilio 21610), and
 *     `optOutGuestRemindersOnStop` erases the opt-in and the stored number the moment a
 *     STOP reaches the inbound webhook.
 *
 * Dark by default, on the same F14 gate as every other F14 send class.
 */

/** The HOST family's local hour a guest message may leave in. Mid-morning: awake
 * everywhere plausible, and a day-before reminder is useful all day. The cron fires
 * hourly, so this matches the whole HOUR — an exact-minute match would drop a family
 * whose tick landed late. */
export const GUEST_SEND_HOUR_LOCAL = 10;

/** Enough parties per tick to clear any plausible Saturday without an unbounded loop. */
const MAX_PARTIES_PER_RUN = 50;

export interface GuestSendLedger {
  familyId: string;
  hostUserId: string;
  dedupeKey: string;
  providerMessageId: string;
  sentAt: Date;
}

export interface PartyReminderDeps {
  /**
   * The outbound SMS leg — REQUIRED (VIL-267). It was nullable, and an absent transport
   * returned `deduped`: the one bucket that means "another tick has this guest", so an
   * unconfigured deploy read as a healthy sweep, and a CANCELLATION — which reports only
   * sent/failed — vanished entirely. The real leg refuses by naming its missing
   * credentials, which is a failure the sweep counts and logs. A no-send mode belongs in
   * the result, never in an absent dependency.
   */
  transport: ChannelTransport;
  claim: typeof claimGuestReminder;
  release: typeof releaseGuestReminder;
  loadTeenNames: typeof loadTeenFirstNames;
  recordSend(database: Database, write: GuestSendLedger): Promise<void>;
}

export interface PartyReminderResult {
  /** Parties whose local send hour it was. */
  evaluated: number;
  sent: number;
  /** Guests skipped because another tick already claimed them. */
  deduped: number;
  failed: number;
}

/** One guest reminder's identity. The rsvp id is the natural key — one guest, one party,
 * one reminder — so a re-drain can never produce a second text. */
export function guestReminderDedupeKey(rsvpId: string): string {
  return `rsvp:reminder:${rsvpId}`;
}

export function guestCancelDedupeKey(rsvpId: string): string {
  return `rsvp:cancel:${rsvpId}`;
}

interface DueParty {
  inviteId: string;
  familyId: string;
  hostUserId: string;
  title: string;
  location: string | null;
  startsAt: Date;
  timeZone: string;
}

interface OptedInGuest {
  rsvpId: string;
  phoneE164Encrypted: string;
}

/**
 * The day-before sweep.
 *
 * Selection is deliberately WIDE (every live party starting in the next 48 hours) and
 * the day check is applied in memory against the family's own zone, because "tomorrow"
 * is a local calendar question that a UTC range cannot answer across DST.
 */
export async function runPartyReminderCron(
  database: Database,
  deps: PartyReminderDeps = defaultPartyReminderDeps(),
  now: Date = new Date(),
): Promise<PartyReminderResult> {
  const result: PartyReminderResult = { evaluated: 0, sent: 0, deduped: 0, failed: 0 };

  const parties = await loadPartiesStartingSoon(database, now);
  for (const party of parties.slice(0, MAX_PARTIES_PER_RUN)) {
    if (!f14EnabledFor(party.familyId)) continue;
    if (!isGuestSendSlot(now, party.timeZone)) continue;
    if (!isTomorrowLocal(party.startsAt, now, party.timeZone)) continue;

    result.evaluated += 1;
    // One party's failure never silences the rest of the morning.
    try {
      const teens = await deps.loadTeenNames(database, party.familyId, now);
      const body = guestReminder(
        redactTeenNames(party.title, teens),
        partyWhen(party.startsAt, party.timeZone),
        party.location === null ? null : redactTeenNames(party.location, teens),
      );
      const guests = await loadOptedInGuests(database, party.inviteId);
      for (const guest of guests) {
        const outcome = await sendToGuest(database, deps, {
          party,
          guest,
          body,
          dedupeKey: guestReminderDedupeKey(guest.rsvpId),
          now,
        });
        if (outcome === 'sent') result.sent += 1;
        else if (outcome === 'deduped') result.deduped += 1;
        else result.failed += 1;
      }
    } catch (err) {
      result.failed += 1;
      console.error('party reminder sweep failed for one party', err);
    }
  }

  return result;
}

/**
 * Tell every opted-in guest of one party that it is off.
 *
 * Called from the host's cancel reply rather than a sweep: a cancellation is worthless
 * late, and there is no version of this that should wait for a cron tick. It is also
 * the ONE guest message that ignores the send hour — a party cancelled at 8 p.m. is a
 * family driving somewhere tomorrow morning for nothing.
 */
export async function notifyGuestsOfCancellation(
  database: Database,
  input: { inviteId: string },
  deps: PartyReminderDeps = defaultPartyReminderDeps(),
  now: Date = new Date(),
): Promise<{ sent: number; failed: number }> {
  const party = await loadPartyByInvite(database, input.inviteId);
  if (!party) return { sent: 0, failed: 0 };

  const teens = await deps.loadTeenNames(database, party.familyId, now);
  const body = guestCancellation(redactTeenNames(party.title, teens));
  const guests = await loadOptedInGuests(database, party.inviteId, { includeReminded: true });

  let sent = 0;
  let failed = 0;
  for (const guest of guests) {
    const outcome = await sendToGuest(database, deps, {
      party,
      guest,
      body,
      dedupeKey: guestCancelDedupeKey(guest.rsvpId),
      now,
      // A cancellation must reach a guest whose reminder already went out, so it does
      // NOT take the reminder claim — its own dedupe key is what keeps it single.
      claimReminder: false,
    });
    if (outcome === 'sent') sent += 1;
    else if (outcome === 'failed') failed += 1;
  }
  return { sent, failed };
}

/**
 * The single place a guest is texted. Claim, decrypt, send, ledger — and on any send
 * failure, release the claim so a transient provider error costs a retry rather than
 * the message.
 *
 * The plaintext number exists only inside this function and is handed straight to the
 * transport. It is never returned, logged, or put in the ledger row (rule #1).
 */
async function sendToGuest(
  database: Database,
  deps: PartyReminderDeps,
  args: {
    party: DueParty;
    guest: OptedInGuest;
    body: string;
    dedupeKey: string;
    now: Date;
    claimReminder?: boolean;
  },
): Promise<'sent' | 'deduped' | 'failed'> {
  const claimReminder = args.claimReminder !== false;
  if (claimReminder && !(await deps.claim(database, args.guest.rsvpId, args.now))) {
    return 'deduped';
  }

  try {
    const { providerMessageId } = await deps.transport.send({
      to: decryptString(args.guest.phoneE164Encrypted),
      body: args.body,
    });
    await deps.recordSend(database, {
      familyId: args.party.familyId,
      hostUserId: args.party.hostUserId,
      dedupeKey: args.dedupeKey,
      providerMessageId,
      sentAt: args.now,
    });
    return 'sent';
  } catch (err) {
    if (claimReminder) await deps.release(database, args.guest.rsvpId);
    // The number and the body are never in the log line — Twilio echoes both back
    // inside its error message, so only the shape of the failure is recorded.
    console.error('guest send failed', err instanceof Error ? err.message : 'unknown');
    return 'failed';
  }
}

// ── slot + day maths ─────────────────────────────────────────────────────────

/** Whether `now` sits in the host family's guest-send hour. */
export function isGuestSendSlot(now: Date, timeZone: string): boolean {
  return Math.floor(localParts(now, timeZone).minutes / 60) === GUEST_SEND_HOUR_LOCAL;
}

/** Whether the party's FAMILY-LOCAL calendar day is the day after today's. Local, not
 * a 24-hour offset: "tomorrow" is a calendar word and DST makes the two disagree. */
export function isTomorrowLocal(startsAt: Date, now: Date, timeZone: string): boolean {
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  return dayKeyIn(startsAt, timeZone) === dayKeyIn(tomorrow, timeZone);
}

// ── reads ────────────────────────────────────────────────────────────────────

/** Every live party starting within the next two days, with its host's zone. */
async function loadPartiesStartingSoon(database: Database, now: Date): Promise<DueParty[]> {
  return database
    .select({
      inviteId: schema.partyInvites.id,
      familyId: schema.partyInvites.familyId,
      hostUserId: schema.partyInvites.hostUserId,
      title: schema.familyEvents.title,
      location: schema.familyEvents.location,
      startsAt: schema.familyEvents.startsAt,
      timeZone: schema.users.timezone,
    })
    .from(schema.partyInvites)
    .innerJoin(schema.familyEvents, eq(schema.familyEvents.id, schema.partyInvites.familyEventId))
    .innerJoin(schema.users, eq(schema.users.id, schema.partyInvites.hostUserId))
    .where(
      and(
        isNull(schema.partyInvites.cancelledAt),
        isNull(schema.familyEvents.deletedAt),
        gte(schema.familyEvents.startsAt, now),
        lt(schema.familyEvents.startsAt, new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000)),
      ),
    );
}

async function loadPartyByInvite(
  database: Database,
  inviteId: string,
): Promise<DueParty | null> {
  const rows = await database
    .select({
      inviteId: schema.partyInvites.id,
      familyId: schema.partyInvites.familyId,
      hostUserId: schema.partyInvites.hostUserId,
      title: schema.familyEvents.title,
      location: schema.familyEvents.location,
      startsAt: schema.familyEvents.startsAt,
      timeZone: schema.users.timezone,
    })
    .from(schema.partyInvites)
    .innerJoin(schema.familyEvents, eq(schema.familyEvents.id, schema.partyInvites.familyEventId))
    .innerJoin(schema.users, eq(schema.users.id, schema.partyInvites.hostUserId))
    .where(eq(schema.partyInvites.id, inviteId))
    .limit(1);
  const row = rows[0];
  return row && row.inviteId === inviteId ? row : null;
}

/**
 * The guests of one party who asked to be reminded.
 *
 * `reminder_opt_in_at IS NOT NULL` is the consent check and it is the ONLY filter that
 * decides whether a number may be texted — there is no flag to fall out of sync with,
 * because the timestamp IS the flag.
 */
async function loadOptedInGuests(
  database: Database,
  inviteId: string,
  opts: { includeReminded?: boolean } = {},
): Promise<OptedInGuest[]> {
  const rows = await database
    .select({
      rsvpId: schema.partyRsvps.id,
      phoneE164Encrypted: schema.partyRsvps.phoneE164Encrypted,
      reminderOptInAt: schema.partyRsvps.reminderOptInAt,
      reminderSentAt: schema.partyRsvps.reminderSentAt,
      response: schema.partyRsvps.response,
    })
    .from(schema.partyRsvps)
    .where(
      and(
        eq(schema.partyRsvps.partyInviteId, inviteId),
        isNotNull(schema.partyRsvps.reminderOptInAt),
      ),
    );

  return guestsEligibleForSend(rows, opts);
}

/**
 * THE CASL FILTER, and the only thing that decides whether a non-user may be texted.
 * Pure and exported so it is tested directly rather than inferred from a query plan.
 *
 * Four conditions, each of which alone is sufficient to refuse:
 *
 *   NO OPT-IN, NO SEND. `reminderOptInAt` is the express consent, and it is re-checked
 *     here in memory whatever the query returned — a `where` clause is one edit away
 *     from being wrong, and this is the failure that would put an unsolicited text on a
 *     stranger's phone.
 *   NO NUMBER, NO SEND. The pair moves together (the table's CHECK), so this can only
 *     fire on a row someone has half-erased; refusing is the safe read of that.
 *   A GUEST WHO SAID NO is not reminded about a party they told the host they would not
 *     be at. They consented to a reminder for an event they were attending.
 *   ALREADY REMINDED means already reminded. Only a cancellation — which is news, not a
 *     repeat — passes `includeReminded`.
 */
export function guestsEligibleForSend(
  rows: readonly {
    rsvpId: string;
    phoneE164Encrypted: string | null;
    reminderOptInAt: Date | null;
    reminderSentAt: Date | null;
    response: 'yes' | 'no' | 'maybe';
  }[],
  opts: { includeReminded?: boolean } = {},
): OptedInGuest[] {
  const eligible: OptedInGuest[] = [];
  for (const row of rows) {
    if (row.reminderOptInAt === null) continue;
    if (row.phoneE164Encrypted === null) continue;
    if (row.response === 'no') continue;
    if (opts.includeReminded !== true && row.reminderSentAt !== null) continue;
    eligible.push({ rsvpId: row.rsvpId, phoneE164Encrypted: row.phoneE164Encrypted });
  }
  return eligible;
}

// ── prod wiring ──────────────────────────────────────────────────────────────

/**
 * Ledgered against the HOST parent, because `channel_messages.parent_user_id` is NOT
 * NULL and a guest has no users row — the M6 caregiver precedent, where a stranger Hale
 * texts on a parent's say-so is attributed to the parent who authorised it. The
 * `'rsvp'` category keeps that volume separable from anything the parent themself
 * received (0074's migration note).
 */
async function recordGuestSend(database: Database, write: GuestSendLedger): Promise<void> {
  await database.transaction(async (tx) => {
    await tx.insert(schema.channelMessages).values({
      familyId: write.familyId,
      parentUserId: write.hostUserId,
      channel: 'sms',
      direction: 'out',
      category: 'rsvp',
      templateKey: 'party_guest_message',
      dedupeKey: write.dedupeKey,
      providerMessageId: write.providerMessageId,
      status: acceptedStatus('sms'),
      sentAt: write.sentAt,
    });
    await tx.insert(schema.auditLog).values({
      familyId: write.familyId,
      actor: write.hostUserId,
      actionTaken: 'party_guest_message_sent',
      targetTable: 'channel_messages',
      targetId: write.familyId,
      after: { dedupeKey: write.dedupeKey },
    });
  });
}

export function defaultPartyReminderDeps(): PartyReminderDeps {
  return {
    transport: createTwilioTransport(),
    claim: claimGuestReminder,
    release: releaseGuestReminder,
    loadTeenNames: loadTeenFirstNames,
    recordSend: recordGuestSend,
  };
}
