import { type Database, schema } from '@hale/db';
import { and, desc, eq, gte, isNull } from 'drizzle-orm';
import { readAffirmative } from '~/lib/channel/affirmative';
import { normalizeKeyword } from '~/lib/channel/intake/keywords';
import type { createFamilyEvent } from '~/lib/loop/queries';
import { partyWhen, redactTeenNames } from './card';
import {
  PARTY_CANCELLED_ACK,
  PARTY_DATE_CLARIFY,
  partyLinkReady,
  partyRecorded,
  partyTeenNotice,
  rsvpUrl,
} from './copy';
import type { PartyExtractor } from './extract';
import {
  cancelPartyInvite,
  loadLivePartyInvite,
  loadPartyTally,
  loadTeenFirstNames,
  mintPartyInvite,
} from './store';
import { renderTally } from './tally';

/**
 * VIL-245 · M10 — what a HOST may do to a party over text, and the order it happens in.
 *
 * The flow is split in two on purpose, and the split is the D17 stakes line:
 *
 *   TELLING HALE ABOUT A PARTY is low-stakes. It writes a row on the family's own
 *     calendar, which is what the family asked for and what the weekly plan already
 *     does with every other occasion. It runs the extractor and needs no confirmation.
 *   MINTING THE PUBLIC PAGE is consequential — it puts a family's address in front of
 *     strangers and cannot be un-shared once a link is forwarded. So it is gated behind
 *     an EXACT-MATCH affirmative on a fresh offer: the M6 caregiver discipline, where a
 *     probabilistic "that sounded like a yes" is not a basis for a third-party
 *     disclosure. Nothing about a bare "yes" is read by a model here.
 *
 * The offer's window is short and the eligible row is narrow (`source = 'party'`, minted
 * only by this module, no invite yet), so a "yes" answering something else entirely
 * cannot land on it.
 *
 * ROUTER CONTRACT (C1 has not landed; M7 and M8 ship the same way). Every entry point
 * is `(database, input, deps) -> outcome`, every outcome union carries
 * `{ status: 'ignored', reason }` so an unmatched message falls straight through to the
 * conversational layer, and no handler sends anything — the caller owns the transport.
 */

/** How long a fresh offer stays answerable. Long enough for a parent to put the kettle
 * on, short enough that a "yes" tomorrow means tomorrow's thing. */
export const PARTY_OFFER_WINDOW_MS = 30 * 60 * 1000;

const TALLY_WORDS = new Set([
  "who's coming",
  'whos coming',
  'who is coming',
  "who's coming?",
  'headcount',
  'head count',
  'rsvp',
  'rsvps',
  'how many are coming',
  'how many',
]);

const CANCEL_WORDS = new Set([
  'cancel the party',
  'cancel party',
  'cancel the birthday',
  "party's off",
  'partys off',
  'party is off',
  'call off the party',
]);

/** A phone keyboard types a curly apostrophe; the two sets above use a straight one.
 * (The affirmative vocabulary folds its own; this is for the party-specific phrases.) */
function normalizeBody(body: string): string {
  return normalizeKeyword(body.replace(/[‘’ʼ`]/g, "'"));
}

/**
 * A yes, read off the ONE shared vocabulary (VIL-265). M10 used to hold its own twelve
 * words; the words it was missing were hosts whose link was never made, and nothing
 * about a party makes "go ahead" less of a yes than it is to the approval grammar.
 *
 * Widening the words does not widen what a yes DOES here — {@link mintLink} still
 * requires a fresh offer with no invite on it, which is the whole gate.
 */
export function matchPartyLinkConfirm(body: string): boolean {
  return readAffirmative(body) === 'yes';
}

export function matchPartyTallyAsk(body: string): boolean {
  return TALLY_WORDS.has(normalizeBody(body));
}

export function matchPartyCancel(body: string): boolean {
  return CANCEL_WORDS.has(normalizeBody(body));
}

/**
 * The COST filter in front of the extractor — not the decision.
 *
 * Most inbound traffic on this channel is not about a party, and a model call on every
 * message would be a bill with no signal. A message that mentions neither a birthday
 * nor a party is not one; a message that does is handed to the extractor, which is the
 * thing that actually decides (`is_party`).
 */
export function looksLikePartyMessage(body: string): boolean {
  const text = body.toLowerCase();
  if (!/\b(birthday|party|bday)\b/.test(text)) return false;
  // A bare keyword with nothing around it is a fragment, not a plan.
  return text.trim().split(/\s+/).length >= 3;
}

// ── telling Hale about a party ───────────────────────────────────────────────

export type PartyCreateOutcome =
  | { status: 'recorded'; familyEventId: string; reply: string }
  | { status: 'clarify'; reply: string }
  | { status: 'ignored'; reason: 'not_party_shaped' | 'not_a_party' };

export interface PartyCreateDeps {
  extractor: PartyExtractor;
  createEvent: typeof createFamilyEvent;
  loadChildIdByFirstName(
    database: Database,
    familyId: string,
    firstName: string,
  ): Promise<string | null>;
}

export async function handlePartyCreate(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    body: string;
    timeZone: string;
    now: Date;
  },
  deps: PartyCreateDeps,
): Promise<PartyCreateOutcome> {
  // Checked before anything else: an ordinary message must not cost a model call.
  if (!looksLikePartyMessage(input.body)) {
    return { status: 'ignored', reason: 'not_party_shaped' };
  }

  const party = await deps.extractor.extract({
    message: input.body,
    receivedAt: input.now,
    timeZone: input.timeZone,
  });
  if (!party.isParty || party.title === null) {
    return { status: 'ignored', reason: 'not_a_party' };
  }

  // The ONE clarify. Nothing is written: an occasion with no date is not an occasion,
  // and a row Hale had to guess a date for would show up in the family's week as a
  // fact nobody stated.
  if (party.startsAt === null) {
    return { status: 'clarify', reply: PARTY_DATE_CLARIFY };
  }

  const childId =
    party.childName === null
      ? null
      : await deps.loadChildIdByFirstName(database, input.familyId, party.childName);

  const familyEventId = await deps.createEvent(database, {
    familyId: input.familyId,
    childId,
    title: party.title,
    startsAt: party.startsAt,
    endsAt: null,
    location: party.location,
    source: 'party',
    createdBy: input.parentUserId,
  });

  return {
    status: 'recorded',
    familyEventId,
    reply: partyRecorded(
      partyWhen(party.startsAt, input.timeZone),
      party.title,
      party.location,
    ),
  };
}

// ── the three deterministic host replies ─────────────────────────────────────

export type PartyReplyOutcome =
  | { status: 'link_minted'; publicToken: string; reply: string }
  | { status: 'tallied'; reply: string }
  | { status: 'cancelled'; reply: string; notifyInviteId: string }
  | { status: 'ignored'; reason: 'not_a_party_reply' | 'no_pending_offer' | 'no_live_party' };

export interface PartyReplyDeps {
  /** The party this family was just offered a link for, or null. */
  loadPendingOffer(
    database: Database,
    familyId: string,
    now: Date,
  ): Promise<{ familyEventId: string } | null>;
  mintInvite: typeof mintPartyInvite;
  loadLiveInvite: typeof loadLivePartyInvite;
  loadTally: typeof loadPartyTally;
  cancelInvite: typeof cancelPartyInvite;
  loadTeenNames: typeof loadTeenFirstNames;
}

export async function handlePartyReply(
  database: Database,
  input: { familyId: string; parentUserId: string; body: string; now: Date },
  deps: PartyReplyDeps,
): Promise<PartyReplyOutcome> {
  // Matched first, then looked up. Unlike M7 — where "in" means nothing without the
  // window — every phrase here is self-describing, so an ordinary message costs no
  // query at all.
  if (matchPartyLinkConfirm(input.body)) {
    return mintLink(database, input, deps);
  }
  if (matchPartyTallyAsk(input.body)) {
    return tally(database, input, deps);
  }
  if (matchPartyCancel(input.body)) {
    return cancel(database, input, deps);
  }
  return { status: 'ignored', reason: 'not_a_party_reply' };
}

async function mintLink(
  database: Database,
  input: { familyId: string; parentUserId: string; now: Date },
  deps: PartyReplyDeps,
): Promise<PartyReplyOutcome> {
  const pending = await deps.loadPendingOffer(database, input.familyId, input.now);
  // A bare "yes" with no fresh offer is not this module's yes. Falling through rather
  // than guessing is what lets the same word mean something else to another handler.
  if (!pending) return { status: 'ignored', reason: 'no_pending_offer' };

  const { publicToken } = await deps.mintInvite(database, {
    familyId: input.familyId,
    familyEventId: pending.familyEventId,
    hostUserId: input.parentUserId,
  });

  const teens = await deps.loadTeenNames(database, input.familyId, input.now);
  const notice = teens.length > 0 ? ` ${partyTeenNotice()}` : '';
  return {
    status: 'link_minted',
    publicToken,
    reply: `${partyLinkReady(rsvpUrl(publicToken))}${notice}`,
  };
}

async function tally(
  database: Database,
  input: { familyId: string },
  deps: PartyReplyDeps,
): Promise<PartyReplyOutcome> {
  const invite = await deps.loadLiveInvite(database, input.familyId);
  if (!invite) return { status: 'ignored', reason: 'no_live_party' };
  const counts = await deps.loadTally(database, invite.inviteId);
  return { status: 'tallied', reply: renderTally(counts) };
}

async function cancel(
  database: Database,
  input: { familyId: string; parentUserId: string; now: Date },
  deps: PartyReplyDeps,
): Promise<PartyReplyOutcome> {
  const invite = await deps.loadLiveInvite(database, input.familyId);
  if (!invite) return { status: 'ignored', reason: 'no_live_party' };

  await deps.cancelInvite(
    database,
    {
      familyId: input.familyId,
      inviteId: invite.inviteId,
      familyEventId: invite.familyEventId,
      actorUserId: input.parentUserId,
    },
    input.now,
  );

  // The caller notifies the opted-in guests; this handler owns the state change and
  // hands back the id to notify, so a cancel that could not be delivered is still a
  // cancel that happened.
  return { status: 'cancelled', reply: PARTY_CANCELLED_ACK, notifyInviteId: invite.inviteId };
}

// ── prod wiring ──────────────────────────────────────────────────────────────

/**
 * The party this family was offered a link for: the newest `source='party'` occasion
 * they recorded inside the offer window that has no invite yet.
 *
 * All four conditions are load-bearing. `source='party'` means only this module's rows
 * qualify. No invite means a second "yes" cannot mint a second page. The window means a
 * "yes" belongs to the thing that was just said. And `deleted_at IS NULL` means a
 * cancelled party cannot be republished by an old affirmative.
 */
export async function loadPendingPartyOffer(
  database: Database,
  familyId: string,
  now: Date,
): Promise<{ familyEventId: string } | null> {
  const rows = await database
    .select({
      familyEventId: schema.familyEvents.id,
      familyId: schema.familyEvents.familyId,
      inviteId: schema.partyInvites.id,
    })
    .from(schema.familyEvents)
    .leftJoin(
      schema.partyInvites,
      eq(schema.partyInvites.familyEventId, schema.familyEvents.id),
    )
    .where(
      and(
        eq(schema.familyEvents.familyId, familyId),
        eq(schema.familyEvents.source, 'party'),
        isNull(schema.familyEvents.deletedAt),
        gte(schema.familyEvents.createdAt, new Date(now.getTime() - PARTY_OFFER_WINDOW_MS)),
      ),
    )
    .orderBy(desc(schema.familyEvents.createdAt))
    .limit(1);

  const row = rows[0];
  // In-memory re-checks: the offer must be this family's and must not already be live.
  if (!row || row.familyId !== familyId || row.inviteId !== null) return null;
  return { familyEventId: row.familyEventId };
}

/** A child of this family whose first name matches, or null. Exact and case-folded —
 * a fuzzy match would attach one child's party to their sibling's row. */
export async function loadChildIdByFirstName(
  database: Database,
  familyId: string,
  firstName: string,
): Promise<string | null> {
  const rows = await database
    .select({ id: schema.children.id, name: schema.children.name })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
  const wanted = firstName.trim().toLowerCase();
  return rows.find((child) => child.name.trim().toLowerCase() === wanted)?.id ?? null;
}

export function defaultPartyReplyDeps(): PartyReplyDeps {
  return {
    loadPendingOffer: loadPendingPartyOffer,
    mintInvite: mintPartyInvite,
    loadLiveInvite: loadLivePartyInvite,
    loadTally: loadPartyTally,
    cancelInvite: cancelPartyInvite,
    loadTeenNames: loadTeenFirstNames,
  };
}

/** Re-exported so a caller composing a guest-facing string cannot forget the gate. */
export { redactTeenNames };
