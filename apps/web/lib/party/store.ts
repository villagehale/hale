import { randomBytes } from 'node:crypto';
import { type Database, schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { normalizePhoneE164 } from '~/lib/channels/phone';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type RsvpResponse, type RsvpTally, tallyRsvps } from './tally';

/**
 * VIL-245 · M10 — the reads and writes behind the account-less RSVP.
 *
 * Three parties touch this module and they are given three different amounts:
 *
 *   THE PUBLIC PAGE gets `loadPublicParty`, which returns what the host chose to
 *     publish plus the teen names needed to redact it, and nothing else. It never
 *     returns an id, a family, a child row, or another guest.
 *   THE GUEST gets `submitRsvp`, which writes exactly what they typed and — only if
 *     they asked to be reminded — an encrypted number and the timestamp of the consent
 *     that permits holding it.
 *   THE HOST gets `loadPartyTally` and `cancelPartyInvite`, both family-scoped.
 *
 * Every lookup that a stranger can reach applies its own IN-MEMORY re-check after the
 * query (the `resolveVerifiedChannelByPhone` discipline): a token match is confirmed on
 * the returned row, and a family-scoped read confirms the row's `familyId`. It is
 * defence in depth against a future where a `where` clause is edited and a page starts
 * serving the wrong household's party.
 */

/** 18 random bytes → 144 bits, base64url. Same shape as the village share tokens. */
export function mintPublicToken(): string {
  return randomBytes(18).toString('base64url');
}

/** The per-party natural key for a guest: case- and whitespace-folded display name. */
export function guestNameKey(displayName: string): string {
  return displayName.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** A headcount above this from a public form is someone testing the input, not a guest
 * list. Mirrors the table's CHECK — the DB is the backstop, this is the friendly error. */
const MAX_HEADCOUNT = 20;
const MAX_NAME_LENGTH = 80;

// ── the public page ──────────────────────────────────────────────────────────

export interface PublicParty {
  /** Needed by the POST handler to attach an RSVP. Never rendered. */
  inviteId: string;
  familyId: string;
  title: string;
  location: string | null;
  startsAt: Date;
  /** The HOST family's zone — the party happens where the party happens. */
  timeZone: string;
  cancelled: boolean;
  /** First names of the household's 13+ children, for the read-time redaction. */
  teenFirstNames: string[];
}

/**
 * Resolve a public token to the party behind it, or null.
 *
 * Null covers every failure a stranger can produce — an unknown token, a mistyped one,
 * a party whose event was deleted — and the page renders one indistinguishable
 * not-found state for all of them, so the token space cannot be probed for hits.
 */
export async function loadPublicParty(
  database: Database,
  token: string,
  now: Date = new Date(),
): Promise<PublicParty | null> {
  const rows = await database
    .select({
      inviteId: schema.partyInvites.id,
      familyId: schema.partyInvites.familyId,
      publicToken: schema.partyInvites.publicToken,
      cancelledAt: schema.partyInvites.cancelledAt,
      title: schema.familyEvents.title,
      location: schema.familyEvents.location,
      startsAt: schema.familyEvents.startsAt,
      deletedAt: schema.familyEvents.deletedAt,
      timeZone: schema.users.timezone,
    })
    .from(schema.partyInvites)
    .innerJoin(schema.familyEvents, eq(schema.familyEvents.id, schema.partyInvites.familyEventId))
    .innerJoin(schema.users, eq(schema.users.id, schema.partyInvites.hostUserId))
    .where(eq(schema.partyInvites.publicToken, token))
    .limit(1);

  const row = rows[0];
  // The in-memory re-check: the row we act on must be the row the token names.
  if (!row || row.publicToken !== token) return null;
  // A soft-deleted occasion is gone; its page goes with it.
  if (row.deletedAt !== null) return null;

  return {
    inviteId: row.inviteId,
    familyId: row.familyId,
    title: row.title,
    location: row.location,
    startsAt: row.startsAt,
    timeZone: row.timeZone,
    cancelled: row.cancelledAt !== null,
    teenFirstNames: await loadTeenFirstNames(database, row.familyId, now),
  };
}

/**
 * The household's 13+ children, by first name. The age gate is `deriveStage`, never a
 * classifier flag — a teen's privacy cannot depend on a model having noticed.
 */
export async function loadTeenFirstNames(
  database: Database,
  familyId: string,
  now: Date,
): Promise<string[]> {
  const rows = await database
    .select({ name: schema.children.name, dateOfBirth: schema.children.dateOfBirth })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
  return rows
    .filter((child) => deriveStage(child.dateOfBirth, now) === 'teenager')
    .map((child) => child.name);
}

// ── the guest write ──────────────────────────────────────────────────────────

export interface RsvpSubmission {
  displayName: string;
  response: RsvpResponse;
  headcount: number;
  /** Present ONLY when the guest ticked the reminder box. Null is the default state. */
  reminderPhone: string | null;
}

export type SubmitRsvpResult =
  | { status: 'recorded'; reminderOptIn: boolean }
  | { status: 'invalid'; field: 'name' | 'headcount' | 'phone' }
  | { status: 'cancelled' };

export interface RsvpTarget {
  inviteId: string;
  familyId: string;
  cancelled: boolean;
}

/**
 * Record one guest's answer.
 *
 * A bad reminder number fails the WHOLE submission rather than recording the RSVP and
 * quietly dropping the opt-in: the guest ticked a box that says they will be reminded,
 * and a silent downgrade would be Hale making a promise it had already decided not to
 * keep. They get the form back with one field to fix.
 *
 * Re-answering UPDATES the guest's row (`nameKey` is the per-party natural key), so
 * opening the link twice does not add a second head to the host's count.
 */
export async function submitRsvp(
  database: Database,
  target: RsvpTarget,
  submission: RsvpSubmission,
  now: Date = new Date(),
): Promise<SubmitRsvpResult> {
  if (target.cancelled) return { status: 'cancelled' };

  const displayName = submission.displayName.trim();
  if (displayName.length === 0 || displayName.length > MAX_NAME_LENGTH) {
    return { status: 'invalid', field: 'name' };
  }
  if (
    !Number.isInteger(submission.headcount) ||
    submission.headcount < 1 ||
    submission.headcount > MAX_HEADCOUNT
  ) {
    return { status: 'invalid', field: 'headcount' };
  }

  // The three reminder columns are written as ONE decision, so there is no code path
  // that can produce a number without its consent stamp (the table's CHECK agrees).
  let reminder: {
    reminderOptInAt: Date | null;
    phoneE164Encrypted: string | null;
    phoneE164Hash: string | null;
  } = { reminderOptInAt: null, phoneE164Encrypted: null, phoneE164Hash: null };

  if (submission.reminderPhone !== null && submission.reminderPhone.trim().length > 0) {
    const e164 = normalizePhoneE164(submission.reminderPhone);
    if (e164 === null) return { status: 'invalid', field: 'phone' };
    reminder = {
      reminderOptInAt: now,
      phoneE164Encrypted: encryptString(e164),
      phoneE164Hash: phoneBlindIndex(e164),
    };
  }

  await database.transaction(async (tx) => {
    // Audit first, and deliberately WITHOUT the guest's name: audit_log is immutable
    // and exportable to the FAMILY under PIPEDA, and a guest is a third party who
    // agreed to tell the host they were coming, not to be listed in the host's record
    // export. The row records that an RSVP happened, on which invite.
    await tx.insert(schema.auditLog).values({
      familyId: target.familyId,
      // 'guest', not a user id and not the host: `actor` is free text with a documented
      // 'system' sentinel for "no user did this", and a party guest is a fourth kind of
      // actor Hale has never had — a real person, acting deliberately, whom Hale is not
      // allowed to identify. Naming the host here would be a false statement about who
      // pressed the button.
      actor: 'guest',
      actionTaken: 'party_rsvp_submitted',
      targetTable: 'party_rsvps',
      targetId: target.inviteId,
      after: { response: submission.response, reminderOptIn: reminder.reminderOptInAt !== null },
    });
    await tx
      .insert(schema.partyRsvps)
      .values({
        partyInviteId: target.inviteId,
        displayName,
        nameKey: guestNameKey(displayName),
        response: submission.response,
        headcount: submission.headcount,
        ...reminder,
      })
      .onConflictDoUpdate({
        target: [schema.partyRsvps.partyInviteId, schema.partyRsvps.nameKey],
        set: {
          displayName,
          response: submission.response,
          headcount: submission.headcount,
          ...reminder,
          updatedAt: now,
        },
      });
  });

  return { status: 'recorded', reminderOptIn: reminder.reminderOptInAt !== null };
}

// ── the host's side ──────────────────────────────────────────────────────────

/** The family's newest live (non-cancelled, future-or-present) party invite, or null. */
export async function loadLivePartyInvite(
  database: Database,
  familyId: string,
): Promise<{ inviteId: string; familyEventId: string; publicToken: string } | null> {
  const rows = await database
    .select({
      inviteId: schema.partyInvites.id,
      familyId: schema.partyInvites.familyId,
      familyEventId: schema.partyInvites.familyEventId,
      publicToken: schema.partyInvites.publicToken,
    })
    .from(schema.partyInvites)
    .where(
      and(
        eq(schema.partyInvites.familyId, familyId),
        isNull(schema.partyInvites.cancelledAt),
      ),
    )
    .orderBy(desc(schema.partyInvites.createdAt))
    .limit(1);

  const row = rows[0];
  // The family re-check: a host may only ever be handed their own household's party.
  if (!row || row.familyId !== familyId) return null;
  return { inviteId: row.inviteId, familyEventId: row.familyEventId, publicToken: row.publicToken };
}

/** Every answer on one invite, oldest-first — the host's list, and only the host's. */
export async function loadPartyTally(
  database: Database,
  inviteId: string,
): Promise<RsvpTally> {
  const rows = await database
    .select({
      displayName: schema.partyRsvps.displayName,
      response: schema.partyRsvps.response,
      headcount: schema.partyRsvps.headcount,
    })
    .from(schema.partyRsvps)
    .where(eq(schema.partyRsvps.partyInviteId, inviteId))
    .orderBy(schema.partyRsvps.createdAt);
  return tallyRsvps(rows);
}

/**
 * Mint the shareable page for an occasion the family already recorded.
 *
 * Idempotent on the event: a second call returns the token the first minted, so a host
 * who asks twice gets one link rather than two pages splitting their guest list.
 */
export async function mintPartyInvite(
  database: Database,
  input: { familyId: string; familyEventId: string; hostUserId: string },
): Promise<{ inviteId: string; publicToken: string }> {
  const existing = await database
    .select({ inviteId: schema.partyInvites.id, publicToken: schema.partyInvites.publicToken })
    .from(schema.partyInvites)
    .where(eq(schema.partyInvites.familyEventId, input.familyEventId))
    .limit(1);
  const found = existing[0];
  if (found) return found;

  const publicToken = mintPublicToken();
  return database.transaction(async (tx) => {
    const inserted = await tx
      .insert(schema.partyInvites)
      .values({
        familyId: input.familyId,
        familyEventId: input.familyEventId,
        hostUserId: input.hostUserId,
        publicToken,
      })
      .returning({ id: schema.partyInvites.id });
    const row = inserted[0];
    if (!row) throw new Error('mintPartyInvite: party_invites insert returned no row');
    await tx.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: input.hostUserId,
      actionTaken: 'party_invite_created',
      targetTable: 'party_invites',
      targetId: row.id,
    });
    return { inviteId: row.id, publicToken };
  });
}

/**
 * Close a party. The invite is soft-cancelled and the occasion soft-deleted, in one
 * transaction — a page still reachable for a party that left the family's calendar
 * would keep collecting RSVPs for something nobody is hosting.
 */
export async function cancelPartyInvite(
  database: Database,
  input: { familyId: string; inviteId: string; familyEventId: string; actorUserId: string },
  now: Date = new Date(),
): Promise<void> {
  await database.transaction(async (tx) => {
    await tx.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: input.actorUserId,
      actionTaken: 'party_invite_cancelled',
      targetTable: 'party_invites',
      targetId: input.inviteId,
    });
    await tx
      .update(schema.partyInvites)
      .set({ cancelledAt: now, updatedAt: now })
      .where(eq(schema.partyInvites.id, input.inviteId));
    await tx
      .update(schema.familyEvents)
      .set({ deletedAt: now })
      .where(eq(schema.familyEvents.id, input.familyEventId));
  });
}

/**
 * CASL: a STOP from a guest's number withdraws every reminder opt-in that number ever
 * gave, and takes the stored number with it.
 *
 * Erasing the columns rather than only clearing the flag is the point — the consent was
 * the only reason Hale was allowed to hold a non-user's phone number, and the moment it
 * is withdrawn the basis for holding it is gone. The table's CHECK makes the pair move
 * together, so there is no half-erased state to leak. The RSVP itself survives: the host
 * still needs their headcount, and the guest did not un-attend the party.
 */
export async function optOutGuestRemindersOnStop(
  database: Database,
  phoneE164: string,
  now: Date = new Date(),
): Promise<number> {
  const updated = await database
    .update(schema.partyRsvps)
    .set({
      reminderOptInAt: null,
      phoneE164Encrypted: null,
      phoneE164Hash: null,
      updatedAt: now,
    })
    .where(eq(schema.partyRsvps.phoneE164Hash, phoneBlindIndex(phoneE164)))
    .returning({ id: schema.partyRsvps.id });
  return updated.length;
}

/**
 * Claim one guest's day-before reminder BEFORE it is sent.
 *
 * At-most-once by construction: the claim is a conditional UPDATE that only wins while
 * `reminder_sent_at IS NULL`, so two overlapping cron ticks cannot both send. The
 * failure mode this buys is a missed reminder rather than a second text to a non-user,
 * which is the correct direction for a message CASL only permits once.
 */
export async function claimGuestReminder(
  database: Database,
  rsvpId: string,
  now: Date,
): Promise<boolean> {
  const claimed = await database
    .update(schema.partyRsvps)
    .set({ reminderSentAt: now, updatedAt: now })
    .where(and(eq(schema.partyRsvps.id, rsvpId), isNull(schema.partyRsvps.reminderSentAt)))
    .returning({ id: schema.partyRsvps.id });
  return claimed.length > 0;
}

/** Release a claim whose send failed, so the next tick may try again. */
export async function releaseGuestReminder(database: Database, rsvpId: string): Promise<void> {
  await database
    .update(schema.partyRsvps)
    .set({ reminderSentAt: null })
    .where(eq(schema.partyRsvps.id, rsvpId));
}
