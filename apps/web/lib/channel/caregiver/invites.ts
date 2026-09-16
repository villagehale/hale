import { type Database, schema } from '@hale/db';
import { and, eq, gte, isNull } from 'drizzle-orm';
import {
  coParentInviteBody,
  coParentScopeConfirm,
  inviterNameIsAffordable,
} from '~/lib/channel/coparent/copy';
import type { ReplyLanguage } from '~/lib/channel/language';
import { CO_PARENT_GRANT_SCOPE, type CaregiverRole } from '~/lib/channel/role-scope';
import { maskPhoneE164 } from '~/lib/channels/phone';
import { POLICY_VERSION } from '~/lib/consent';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { decryptString, encryptString } from '~/lib/crypto/string-cipher';
import { ROLE_LABEL, inviteBody, scopeConfirm } from './copy';
import type { AddRole, ParsedCaregiverAdd, ParsedCoParentAdd } from './parse';

/**
 * VIL-241 · M6 — the caregiver invite's state transitions and the rows they write.
 *
 * THE DOUBLE OPT-IN IS THE DESIGN. Two people who are not in the same conversation
 * both have to agree before Hale texts a family's week to a third party, and each
 * agreement is recorded on its own terms:
 *
 *   caregiver_access_grant     — the PARENT authorising the disclosure. Written when
 *                                they confirm, with their own words as evidence.
 *   caregiver_scoped_messages  — the CAREGIVER's OWN CASL consent to be texted, given
 *                                from the number itself, scoped to their ROLE.
 *
 * Neither row is inferred from the other and neither is inferred from the
 * family_members row. A family_members row without both is a bug, not a shortcut —
 * so acceptance writes all three in ONE transaction (rule #6).
 *
 * VERIFIED BY ORIGINATION. The caregiver's channel gets `verified_at` without an OTP,
 * on the same precedent as intake provisioning: the acceptance ARRIVED from the number
 * we are about to text. Texting a code to a phone that is already texting us would be
 * asking someone to prove they hold the phone in their hand.
 *
 * SILENCE EXPIRES IT. `expires_at` is set at creation and RESET when the caregiver is
 * asked, so each side gets its own 72 hours. Expiry is applied on READ — a sweep that
 * never runs cannot leave a stale invite live.
 */

export type CaregiverInviteState =
  /** The parent asked; Hale has stated the scope and is waiting for their confirmation.
   * NOBODY has been texted yet — this is the state that makes that guarantee. */
  | 'awaiting_parent_assent'
  /** The parent confirmed and the caregiver has been texted; waiting on them. */
  | 'awaiting_caregiver_reply'
  /** The caregiver said yes. Terminal. */
  | 'accepted'
  /** Either side said no (or the caregiver sent STOP). Terminal. */
  | 'declined'
  /** The parent described someone else before confirming this one. Terminal, and kept
   * DISTINCT from 'declined' because nobody was ever texted — which is exactly what the
   * volume meter below needs to know. */
  | 'superseded'
  /** This number was seated as a CO-PARENT by a forwarded join link while the invite was
   * still open. Terminal, and its own state rather than 'declined': nobody refused
   * anything, and rather than 'superseded': that one means nobody was ever texted, and
   * this one may have reached them (see the meter below, which counts it as delivered —
   * over-counting a family's daily budget is the safe direction, letting an invite that
   * DID text a stranger fall off the meter is not). */
  | 'superseded_by_join'
  /** This number finished its OWN intake and became a parent in its own household while
   * the invite was still open. Terminal, and kept distinct from 'superseded_by_join'
   * because a different thing happened to a different person: the join link seats
   * somebody in the household that asked for them, and this one is the invitee walking
   * away to a family of their own. An operator reading the inviting parent's trail has
   * to be able to tell "they joined you as a co-parent instead" from "they signed up on
   * their own and can no longer be your sitter". */
  | 'superseded_by_enrollment'
  /** 72h of silence on whichever side we were waiting for. Terminal. */
  | 'expired';

/** Either side silent for this long and the invite lapses. */
export const INVITE_SILENCE_MS = 72 * 60 * 60 * 1000;

/**
 * How many strangers one family may have Hale text in a rolling day.
 *
 * This is the bound that stands in for the F14 outbound gate on this path. M6 gives a
 * text the power to make Hale message an ARBITRARY number, which is the same power the
 * gate exists to meter — but every one of the gate's checks is about an enrolled
 * parent, and an invitee has no channel by construction.
 *
 * What is metered is the thing that actually costs someone something: an invite that
 * REACHED a stranger. A superseded invite (described, then thought better of) texted
 * nobody, so it does not consume the budget — a parent fumbling the wording five times
 * is not the abuse case, and charging them for it would leave them stuck.
 */
export const INVITE_DAILY_CAP = 5;
const INVITE_CAP_WINDOW_MS = 24 * 60 * 60 * 1000;

interface InviteFields {
  id: string;
  familyId: string;
  invitedByUserId: string;
  displayName: string;
  /** Decrypted only in memory, to address the send. Never logged, never audited raw. */
  phoneE164: string;
  state: CaregiverInviteState;
  expiresAt: Date;
}

/**
 * VIL-355 widened this table's reach from `CaregiverRole`: the same row, the same double
 * opt-in and the same 72h clock now also carry a co-parent ask. It is a UNION on the role
 * rather than a widened field so that a caller who has checked which lane it is in cannot
 * then hand the invite to the other lane's functions — everything that renders off the
 * role branches (see {@link inviteVerb} and the copy each start function picks), because
 * the one thing a co-parent's trail must never say is "a caregiver invite closed…".
 */
export type CaregiverLaneInvite = InviteFields & { role: CaregiverRole };
export type CoParentInvite = InviteFields & { role: 'co_parent' };
export type CaregiverInvite = CaregiverLaneInvite | CoParentInvite;

type InviteRow = {
  id: string;
  familyId: string;
  invitedByUserId: string;
  role: string;
  displayName: string;
  phoneE164Encrypted: string;
  phoneE164Hash: string;
  state: string;
  expiresAt: Date;
  closedAt: Date | null;
  createdAt: Date;
};

function toInvite(row: InviteRow): CaregiverInvite {
  const fields: InviteFields = {
    id: row.id,
    familyId: row.familyId,
    invitedByUserId: row.invitedByUserId,
    displayName: row.displayName,
    phoneE164: decryptString(row.phoneE164Encrypted),
    state: row.state as CaregiverInviteState,
    expiresAt: new Date(row.expiresAt),
  };
  const role = row.role as AddRole;
  return role === 'co_parent' ? { ...fields, role } : { ...fields, role };
}

/**
 * The audit verb for something that happened to THIS invite.
 *
 * Derived rather than passed, and that is the fix for the landmine VIL-355 found: every
 * closure below used to name a `caregiver_invite_*` verb unconditionally, so a co-parent
 * invite closed by a forwarded link rendered in the trail as "a caregiver invite closed
 * because that number is already set up with Hale" — about the other parent of these
 * children. A caller cannot get this wrong now because a caller no longer says it.
 */
function inviteVerb(role: AddRole, suffix: string): string {
  return `${role === 'co_parent' ? 'co_parent' : 'caregiver'}_invite_${suffix}`;
}

const INVITE_COLUMNS = {
  id: schema.caregiverInvites.id,
  familyId: schema.caregiverInvites.familyId,
  invitedByUserId: schema.caregiverInvites.invitedByUserId,
  role: schema.caregiverInvites.role,
  displayName: schema.caregiverInvites.displayName,
  phoneE164Encrypted: schema.caregiverInvites.phoneE164Encrypted,
  phoneE164Hash: schema.caregiverInvites.phoneE164Hash,
  state: schema.caregiverInvites.state,
  expiresAt: schema.caregiverInvites.expiresAt,
  closedAt: schema.caregiverInvites.closedAt,
  createdAt: schema.caregiverInvites.createdAt,
};

async function openInvites(database: Database): Promise<InviteRow[]> {
  const rows = await database
    .select(INVITE_COLUMNS)
    .from(schema.caregiverInvites)
    .where(isNull(schema.caregiverInvites.closedAt));
  // Post-filtered rather than trusted: the same defense-in-depth the channel lookups
  // use, so a widened query can never resolve a closed invite.
  return (rows as InviteRow[]).filter((r) => r.closedAt === null);
}

/** Close a lapsed invite and return null, so every read is also the sweep. */
async function throughExpiry(
  database: Database,
  row: InviteRow,
  now: Date,
): Promise<CaregiverInvite | null> {
  if (new Date(row.expiresAt).getTime() > now.getTime()) return toInvite(row);
  const invite = toInvite(row);
  await closeInvite(database, invite, 'expired', now, inviteVerb(invite.role, 'expired'));
  return null;
}

/** The open invite this number is being asked about, if any. */
export async function loadOpenInviteByPhone(
  database: Database,
  phoneE164: string,
  now: Date,
): Promise<CaregiverInvite | null> {
  const hash = phoneBlindIndex(phoneE164);
  const row = (await openInvites(database)).find((r) => r.phoneE164Hash === hash);
  if (!row) return null;
  return throughExpiry(database, row, now);
}

/**
 * The invite THIS parent still owes a yes/no on. At most one can exist — starting a new
 * one supersedes the last (see {@link startCaregiverInvite}) — which is what makes a
 * bare "yes" answerable at all. Ordering two pending invites by timestamp was the
 * tempting fix and the wrong one: two invites described in the same minute tie, and the
 * loser of that tie is a stranger getting texted a family's schedule.
 */
export async function loadPendingAssent(
  database: Database,
  invitedByUserId: string,
  now: Date,
): Promise<CaregiverInvite | null> {
  const row = (await openInvites(database)).find(
    (r) => r.invitedByUserId === invitedByUserId && r.state === 'awaiting_parent_assent',
  );
  if (!row) return null;
  return throughExpiry(database, row, now);
}

/**
 * The ACTIVE verified channel behind a number, resolved by blind index. Local rather
 * than `resolveVerifiedChannelByPhone` because this answers a different question —
 * "is this number already spoken for" — and needs no route.
 */
export async function activeChannelOwner(
  database: Database,
  phoneE164: string,
): Promise<{ userId: string; familyId: string } | null> {
  const hash = phoneBlindIndex(phoneE164);
  const rows = await database
    .select({
      userId: schema.parentChannels.userId,
      familyId: schema.parentChannels.familyId,
      phoneE164Hash: schema.parentChannels.phoneE164Hash,
      verifiedAt: schema.parentChannels.verifiedAt,
      revokedAt: schema.parentChannels.revokedAt,
    })
    .from(schema.parentChannels)
    .where(
      and(
        eq(schema.parentChannels.phoneE164Hash, hash),
        isNull(schema.parentChannels.revokedAt),
      ),
    );
  const row = rows.find(
    (r) => r.phoneE164Hash === hash && r.verifiedAt !== null && r.revokedAt === null,
  );
  return row ? { userId: row.userId, familyId: row.familyId } : null;
}

/** Invites this family actually sent inside the cap window — the meter's reading. A row
 * still awaiting the parent's confirmation has texted nobody yet either. */
async function invitesDeliveredSince(
  database: Database,
  familyId: string,
  since: Date,
): Promise<number> {
  const rows = await database
    .select({
      familyId: schema.caregiverInvites.familyId,
      state: schema.caregiverInvites.state,
      createdAt: schema.caregiverInvites.createdAt,
    })
    .from(schema.caregiverInvites)
    .where(
      and(
        eq(schema.caregiverInvites.familyId, familyId),
        gte(schema.caregiverInvites.createdAt, since),
      ),
    );
  return rows.filter(
    (r) =>
      r.familyId === familyId &&
      new Date(r.createdAt).getTime() >= since.getTime() &&
      r.state !== 'awaiting_parent_assent' &&
      r.state !== 'superseded',
  ).length;
}

export type StartInviteResult =
  | { status: 'started'; invite: CaregiverLaneInvite; reply: string }
  | { status: 'own_number' }
  | { status: 'number_in_use' }
  | { status: 'already_invited' }
  | { status: 'too_many' };

/**
 * Open an invite and state the scope back to the parent. NOTHING is sent to the
 * caregiver here — that is the whole meaning of `awaiting_parent_assent`.
 */
export async function startCaregiverInvite(
  database: Database,
  input: {
    familyId: string;
    invitedByUserId: string;
    inviterPhoneE164: string;
    parsed: ParsedCaregiverAdd;
    now: Date;
  },
): Promise<StartInviteResult> {
  const { parsed, now } = input;
  if (parsed.phoneE164 === input.inviterPhoneE164) return { status: 'own_number' };

  // A number already carrying an active Hale channel cannot take a second one (the
  // partial unique index says so), and quietly attaching it to another household
  // would be exactly the cross-family leak this ticket exists to prevent.
  if (await activeChannelOwner(database, parsed.phoneE164)) return { status: 'number_in_use' };

  const hash = phoneBlindIndex(parsed.phoneE164);
  const open = await openInvites(database);
  // One open invite per number (the partial unique index says so). Asking twice would
  // also be the second unsolicited text this person never agreed to receive.
  if (open.some((r) => r.phoneE164Hash === hash)) return { status: 'already_invited' };

  const since = new Date(now.getTime() - INVITE_CAP_WINDOW_MS);
  if ((await invitesDeliveredSince(database, input.familyId, since)) >= INVITE_DAILY_CAP) {
    return { status: 'too_many' };
  }

  // Describing a second caregiver before confirming the first ABANDONS the first — that
  // is what happened in the conversation, so it is what the rows say. Superseding here
  // is why "yes" can only ever mean one thing (see loadPendingAssent).
  const superseded = open.find(
    (r) => r.invitedByUserId === input.invitedByUserId && r.state === 'awaiting_parent_assent',
  );
  if (superseded) {
    const previous = toInvite(superseded);
    await closeInvite(database, previous, 'superseded', now, inviteVerb(previous.role, 'superseded'));
  }

  const invite = await openInviteRow(database, { ...input, hash });

  await database.insert(schema.auditLog).values({
    familyId: input.familyId,
    actor: input.invitedByUserId,
    actionTaken: 'caregiver_invite_started',
    targetTable: 'caregiver_invites',
    targetId: invite.id,
    after: {
      role: parsed.role,
      displayName: parsed.name,
      maskedPhone: maskPhoneE164(parsed.phoneE164),
    },
  });

  return { status: 'started', invite, reply: scopeConfirm(parsed.name, parsed.role) };
}

/** Why Hale will not open a CO-PARENT invite. Every one of them is answered with its own
 * sentence (coparent/copy.ts) — a parent who asked us to text somebody is owed the reason
 * nobody was texted, and a shared "can't do that" would hide four different facts. */
export type CoParentRefusal =
  | 'own_number'
  | 'number_in_use'
  | 'already_invited'
  | 'too_many'
  | 'co_parent_seat_taken'
  | 'previously_declined'
  | 'referrer_unnamed';

export type StartCoParentResult =
  | { status: 'started'; invite: CoParentInvite; reply: string }
  | { status: 'refused'; reason: CoParentRefusal };

/** Whether this household already holds its one co-parent seat. */
async function familyHasCoParent(database: Database, familyId: string): Promise<boolean> {
  const rows = await database
    .select({
      familyId: schema.familyMembers.familyId,
      role: schema.familyMembers.role,
    })
    .from(schema.familyMembers)
    .where(and(eq(schema.familyMembers.familyId, familyId), eq(schema.familyMembers.role, 'co_parent')));
  return rows.some((r) => r.familyId === familyId && r.role === 'co_parent');
}

/**
 * A CLOSED invite this number already refused, or null.
 *
 * NUMBER-KEYED AND FAMILY-BLIND, the same scope `declineOpenInviteOnStop` already uses,
 * and that is the whole point: `startCaregiverInvite` looks only at OPEN invites, so a
 * person who replied NO — or STOP, which lands in the same terminal state — could be
 * asked again tomorrow, five times a day, by this household or any other. Nothing in the
 * schema remembered a refusal because nothing had to: a refusal writes no consent row
 * (see {@link declineInvite}) and there is no suppression table. The closed row is the
 * memory, and its blind index is what makes it findable without storing the number.
 */
async function priorRefusal(database: Database, phoneE164: string): Promise<InviteRow | null> {
  const hash = phoneBlindIndex(phoneE164);
  const rows = (await database
    .select(INVITE_COLUMNS)
    .from(schema.caregiverInvites)
    .where(
      and(
        eq(schema.caregiverInvites.phoneE164Hash, hash),
        eq(schema.caregiverInvites.state, 'declined'),
      ),
    )) as InviteRow[];
  const refusals = rows
    .filter((r) => r.phoneE164Hash === hash && r.state === 'declined')
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return refusals[0] ?? null;
}

/**
 * Open a CO-PARENT invite and state the scope back to the parent. NOTHING is sent to the
 * number they named here — `awaiting_parent_assent` is that guarantee, and it is the same
 * one the caregiver flow makes, on the same table and the same 72h clock.
 *
 * WHAT IS NOT SHARED with {@link startCaregiverInvite} is the guard list, and the three
 * extra refusals are the three ways this ask differs from that one. The seat is single
 * ({@link familyHasCoParent}), the refusal is remembered ({@link priorRefusal}), and the
 * message cannot go out unsigned: a caregiver invite from an unnamed parent still reads
 * as an invitation, while "a parent added you as their co-parent" from an unknown number
 * is the cold text this whole feature exists not to send.
 */
export async function startCoParentInvite(
  database: Database,
  input: {
    familyId: string;
    invitedByUserId: string;
    inviterPhoneE164: string;
    inviterName: string | null;
    parsed: ParsedCoParentAdd;
    language: ReplyLanguage;
    now: Date;
  },
): Promise<StartCoParentResult> {
  const { parsed, now } = input;
  const refuse = (reason: CoParentRefusal): StartCoParentResult => ({ status: 'refused', reason });

  if (parsed.phoneE164 === input.inviterPhoneE164) return refuse('own_number');
  if (await familyHasCoParent(database, input.familyId)) return refuse('co_parent_seat_taken');
  if (!inviterNameIsAffordable(input.inviterName)) return refuse('referrer_unnamed');
  if (await activeChannelOwner(database, parsed.phoneE164)) return refuse('number_in_use');

  const hash = phoneBlindIndex(parsed.phoneE164);
  const open = await openInvites(database);
  if (open.some((r) => r.phoneE164Hash === hash)) return refuse('already_invited');

  const refused = await priorRefusal(database, parsed.phoneE164);
  if (refused) {
    // Written even though nothing was sent, because "why was nobody texted" is exactly
    // the question this row exists to answer. It says a refusal happened and never when
    // or by whom — the same bound the parent's own sentence keeps (rule #1).
    await database.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: input.invitedByUserId,
      actionTaken: 'co_parent_invite_blocked_prior_refusal',
      targetTable: 'caregiver_invites',
      targetId: refused.id,
      after: { maskedPhone: maskPhoneE164(parsed.phoneE164) },
    });
    return refuse('previously_declined');
  }

  const since = new Date(now.getTime() - INVITE_CAP_WINDOW_MS);
  if ((await invitesDeliveredSince(database, input.familyId, since)) >= INVITE_DAILY_CAP) {
    return refuse('too_many');
  }

  const superseded = open.find(
    (r) => r.invitedByUserId === input.invitedByUserId && r.state === 'awaiting_parent_assent',
  );
  if (superseded) {
    const previous = toInvite(superseded);
    await closeInvite(database, previous, 'superseded', now, inviteVerb(previous.role, 'superseded'));
  }

  const invite = await openInviteRow(database, { ...input, hash });
  await database.insert(schema.auditLog).values({
    familyId: input.familyId,
    actor: input.invitedByUserId,
    actionTaken: 'co_parent_invite_started',
    targetTable: 'caregiver_invites',
    targetId: invite.id,
    after: {
      role: parsed.role,
      displayName: parsed.name,
      maskedPhone: maskPhoneE164(parsed.phoneE164),
    },
  });

  return { status: 'started', invite, reply: coParentScopeConfirm(parsed.name, input.language) };
}

/** The `caregiver_invites` row itself, with nobody texted yet. Shared by both start
 * functions so the two doors cannot drift on what an unanswered invite looks like; the
 * audit verb stays with each caller, because that is the one thing they must not share. */
async function openInviteRow<R extends AddRole>(
  database: Database,
  input: {
    familyId: string;
    invitedByUserId: string;
    parsed: { name: string; phoneE164: string; role: R };
    hash: string;
    now: Date;
  },
): Promise<InviteFields & { role: R }> {
  const { parsed, now } = input;
  const expiresAt = new Date(now.getTime() + INVITE_SILENCE_MS);
  const [row] = await database
    .insert(schema.caregiverInvites)
    .values({
      familyId: input.familyId,
      invitedByUserId: input.invitedByUserId,
      role: parsed.role,
      displayName: parsed.name,
      phoneE164Encrypted: encryptString(parsed.phoneE164),
      phoneE164Hash: input.hash,
      state: 'awaiting_parent_assent',
      expiresAt,
      // Written explicitly rather than left to the column default: the cap reads it
      // back, and a meter that depends on the clock the row was written by cannot be
      // reasoned about (or tested) deterministically.
      createdAt: now,
    })
    .returning({ id: schema.caregiverInvites.id });
  const id = row?.id;
  if (!id) {
    throw new Error('openInviteRow: caregiver_invites insert returned no row');
  }
  return {
    id,
    familyId: input.familyId,
    invitedByUserId: input.invitedByUserId,
    displayName: parsed.name,
    phoneE164: parsed.phoneE164,
    state: 'awaiting_parent_assent',
    expiresAt,
    role: parsed.role,
  };
}

/**
 * The parent's YES to seating a co-parent: the authorisation row and the state advance in
 * one transaction, and the body to text the person they named returned from it — so a
 * caller cannot advance the state without holding something to send.
 *
 * ITS OWN FUNCTION rather than a branch inside {@link recordParentAssent}, because almost
 * nothing about it is the same record: a different consent type, a different scope, a
 * different question in the evidence, and a different verb. The one thing the two share
 * is the shape of the promise — the row and the advance stand or fall together.
 */
export async function recordCoParentAssent(
  database: Database,
  input: {
    invite: CoParentInvite;
    inviterName: string;
    language: ReplyLanguage;
    verbatimReply: string;
    channelMessageId: string | null;
    now: Date;
  },
): Promise<string> {
  const { invite, now } = input;
  await database.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    await tx.insert(schema.consentRecords).values({
      userId: invite.invitedByUserId,
      familyId: invite.familyId,
      consentType: 'co_parent_access_grant',
      granted: true,
      consentScope: CO_PARENT_GRANT_SCOPE,
      policyVersion: POLICY_VERSION,
      evidence: {
        question: coParentScopeConfirm(invite.displayName, input.language),
        verbatimReply: input.verbatimReply,
        interpretation: `parent authorised texting ${invite.displayName} and seating them as a co-parent, with everything a parent sees`,
        channelMessageId: input.channelMessageId,
        maskedPhone: maskPhoneE164(invite.phoneE164),
      },
    });

    await tx
      .update(schema.caregiverInvites)
      .set({
        state: 'awaiting_caregiver_reply',
        expiresAt: new Date(now.getTime() + INVITE_SILENCE_MS),
        updatedAt: now,
      })
      .where(eq(schema.caregiverInvites.id, invite.id));

    await tx.insert(schema.auditLog).values({
      familyId: invite.familyId,
      actor: invite.invitedByUserId,
      actionTaken: 'co_parent_access_granted',
      targetTable: 'caregiver_invites',
      targetId: invite.id,
      after: { role: invite.role, maskedPhone: maskPhoneE164(invite.phoneE164) },
    });
  });

  return coParentInviteBody(input.inviterName, input.language);
}

/**
 * The parent's confirmation: the authorisation row, then the state advance, in one
 * transaction. The caregiver's clock restarts here — they have their own 72 hours.
 * Returns the body to text the caregiver, so the caller cannot advance the state
 * without having something to send.
 */
export async function recordParentAssent(
  database: Database,
  input: {
    invite: CaregiverLaneInvite;
    inviterName: string | null;
    verbatimReply: string;
    channelMessageId: string | null;
    now: Date;
  },
): Promise<string> {
  const { invite, now } = input;
  await database.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    await tx.insert(schema.consentRecords).values({
      userId: invite.invitedByUserId,
      familyId: invite.familyId,
      consentType: 'caregiver_access_grant',
      granted: true,
      consentScope: `caregiver:${invite.role}`,
      policyVersion: POLICY_VERSION,
      evidence: {
        question: scopeConfirm(invite.displayName, invite.role),
        verbatimReply: input.verbatimReply,
        interpretation: `parent confirmed disclosing the ${ROLE_LABEL[invite.role]} scope to ${invite.displayName}`,
        channelMessageId: input.channelMessageId,
        maskedPhone: maskPhoneE164(invite.phoneE164),
      },
    });

    await tx
      .update(schema.caregiverInvites)
      .set({
        state: 'awaiting_caregiver_reply',
        expiresAt: new Date(now.getTime() + INVITE_SILENCE_MS),
        updatedAt: now,
      })
      .where(eq(schema.caregiverInvites.id, invite.id));

    await tx.insert(schema.auditLog).values({
      familyId: invite.familyId,
      actor: invite.invitedByUserId,
      actionTaken: 'caregiver_access_granted',
      targetTable: 'caregiver_invites',
      targetId: invite.id,
      after: { role: invite.role, maskedPhone: maskPhoneE164(invite.phoneE164) },
    });
  });

  return inviteBody(input.inviterName, invite.role);
}

/** Close an invite in a terminal state, with its audit row. */
async function closeInvite(
  database: Database,
  invite: CaregiverInvite,
  state: Extract<
    CaregiverInviteState,
    'declined' | 'expired' | 'superseded' | 'superseded_by_join' | 'superseded_by_enrollment'
  >,
  now: Date,
  actionTaken: string,
  actor?: string,
): Promise<void> {
  await database
    .update(schema.caregiverInvites)
    .set({ state, closedAt: now, updatedAt: now })
    .where(eq(schema.caregiverInvites.id, invite.id));
  await database.insert(schema.auditLog).values({
    familyId: invite.familyId,
    actor: actor ?? invite.invitedByUserId,
    actionTaken,
    targetTable: 'caregiver_invites',
    targetId: invite.id,
    after: { role: invite.role, maskedPhone: maskPhoneE164(invite.phoneE164) },
  });
}

/**
 * A no from either side. Neither writes a consent row, and that is correct rather than
 * an omission: a consent_records row belongs to a USER, and nobody who refused an
 * invitation has one — creating an identity for someone in order to record that they
 * declined would be exactly backwards. The refusal lives on the invite's terminal state
 * plus its audit row, which is what a PIPEDA read of "what did you do with my number"
 * needs to answer.
 */
export async function declineInvite(
  database: Database,
  input: { invite: CaregiverInvite; by: 'parent' | 'caregiver'; now: Date },
): Promise<void> {
  await closeInvite(
    database,
    input.invite,
    'declined',
    input.now,
    inviteVerb(input.invite.role, input.by === 'parent' ? 'withdrawn' : 'refused'),
  );
}

/** The users row for a caregiver's number, created if absent. Keyed by the SAME blind
 * index intake uses, so a caregiver who later texts Hale as a parent is one account,
 * and a re-invite after a STOP reuses the identity rather than forking it. */
async function ensureCaregiverUser(tx: Database, externalAuthId: string): Promise<string> {
  await tx
    .insert(schema.users)
    .values({ externalAuthId, email: null, name: null })
    .onConflictDoNothing({ target: schema.users.externalAuthId });

  const rows = await tx
    .select({ id: schema.users.id, externalAuthId: schema.users.externalAuthId })
    .from(schema.users)
    .where(eq(schema.users.externalAuthId, externalAuthId));
  const row = rows.find((r) => r.externalAuthId === externalAuthId);
  if (!row) {
    throw new Error('ensureCaregiverUser: no users row after upsert');
  }
  return row.id;
}

export interface AcceptResult {
  caregiverUserId: string;
}

/**
 * The caregiver's yes. In ONE transaction: their identity, their own consent, their
 * verified channel, their membership, the invite's close, and the audit trail. A crash
 * anywhere leaves none of it — there is no state in which a caregiver is a member of a
 * family without a consent row saying they agreed to be.
 */
export async function acceptInvite(
  database: Database,
  input: { invite: CaregiverLaneInvite; verbatimReply: string; now: Date },
): Promise<AcceptResult> {
  const { invite, now } = input;
  const hash = phoneBlindIndex(invite.phoneE164);

  return database.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    const caregiverUserId = await ensureCaregiverUser(tx, `sms:${hash}`);

    const [consent] = await tx
      .insert(schema.consentRecords)
      .values({
        userId: caregiverUserId,
        familyId: invite.familyId,
        consentType: 'caregiver_scoped_messages',
        granted: true,
        consentScope: `caregiver:${invite.role}`,
        policyVersion: POLICY_VERSION,
        evidence: {
          question: inviteBody(null, invite.role),
          verbatimReply: input.verbatimReply,
          interpretation: `caregiver accepted the ${ROLE_LABEL[invite.role]} scope from the number itself`,
        },
      })
      .returning({ id: schema.consentRecords.id });
    const consentId = consent?.id;
    if (!consentId) {
      throw new Error('acceptInvite: consent insert returned no row');
    }

    const [channel] = await tx
      .insert(schema.parentChannels)
      .values({
        userId: caregiverUserId,
        familyId: invite.familyId,
        kind: 'sms',
        phoneE164Encrypted: encryptString(invite.phoneE164),
        phoneE164Hash: hash,
        // Verified by origination: this acceptance arrived FROM the number.
        verifiedAt: now,
        consentRecordId: consentId,
      })
      .returning({ id: schema.parentChannels.id });
    const channelId = channel?.id;
    if (!channelId) {
      throw new Error('acceptInvite: parent_channels insert returned no row');
    }

    await tx
      .insert(schema.familyMembers)
      .values({
        familyId: invite.familyId,
        userId: caregiverUserId,
        role: invite.role,
        invitedByUserId: invite.invitedByUserId,
      })
      // A caregiver who once left and was invited back lands on the same PK. Their new
      // role is the one that was just consented to, so it wins.
      .onConflictDoUpdate({
        target: [schema.familyMembers.familyId, schema.familyMembers.userId],
        set: { role: invite.role, invitedByUserId: invite.invitedByUserId },
      });

    await tx
      .update(schema.caregiverInvites)
      .set({ state: 'accepted', caregiverUserId, closedAt: now, updatedAt: now })
      .where(eq(schema.caregiverInvites.id, invite.id));

    await tx.insert(schema.auditLog).values([
      {
        familyId: invite.familyId,
        actor: caregiverUserId,
        actionTaken: 'caregiver_invite_accepted',
        targetTable: 'family_members',
        targetId: invite.id,
        after: { role: invite.role, maskedPhone: maskPhoneE164(invite.phoneE164) },
      },
      {
        familyId: invite.familyId,
        actor: caregiverUserId,
        actionTaken: 'channel_sms_enrolled',
        targetTable: 'parent_channels',
        targetId: channelId,
        after: {
          kind: 'sms',
          maskedPhone: maskPhoneE164(invite.phoneE164),
          verification: 'caregiver_invite_reply',
        },
      },
    ]);

    return { caregiverUserId };
  });
}

/**
 * A STOP from a number with an invite in flight. "Reply STOP anytime" is on the invite
 * itself, so it has to close the invite too — otherwise the one thing we promised
 * them would only cover messages we had already stopped sending.
 */
export async function declineOpenInviteOnStop(
  database: Database,
  phoneE164: string,
  now: Date,
): Promise<boolean> {
  const invite = await loadOpenInviteByPhone(database, phoneE164, now);
  if (!invite) return false;
  await declineInvite(database, { invite, by: 'caregiver', now });
  return true;
}

/**
 * How a number that had an invite in flight came to own a channel of its own — the two
 * doors onto {@link supersedeOpenInviteOnEnrollment}, each with the state and the audit
 * verb that says what actually happened to that person.
 *
 * They are not one bucket, because they are not one event: `co_parent_join` is somebody
 * accepting a BIGGER role in the household that invited them, and `sms_intake` is the
 * same phone signing up as a parent of its OWN family and walking away from the ask.
 * The inviting parent's trail has to be able to tell those apart.
 */
const ENROLMENT_SUPERSEDES = {
  co_parent_join: { state: 'superseded_by_join', suffix: 'superseded_by_join' },
  sms_intake: { state: 'superseded_by_enrollment', suffix: 'superseded_by_enrollment' },
} as const satisfies Record<string, { state: CaregiverInviteState; suffix: string }>;

export type EnrolmentDoor = keyof typeof ENROLMENT_SUPERSEDES;

/**
 * A number with an invite in flight has just been ENROLLED — given an active channel of
 * its own, by a forwarded co-parent link (VIL-297) or by finishing its own SMS intake
 * (VIL-305). The invite is closed by the same transaction, and this is the ONE invariant
 * behind every door: a number that owns an active channel has no open caregiver invite.
 *
 * {@link startCaregiverInvite} keeps the other end of it (`number_in_use`); nothing kept
 * this one, and the two states are not merely redundant. `loadOpenInviteByPhone` is read
 * BEFORE the channel in the intake machine — deliberately, so a caregiver's "yes" is not
 * read as a stranger starting an intake — so an invite left armed OUTRANKS the channel
 * that was just written: every ordinary message the newly enrolled person sends is
 * answered with the invite's question, and the "yes" that ends the loop tries to enrol
 * their number a SECOND time, against a partial unique index that refuses it and takes
 * the webhook down with it.
 *
 * NOT `declineInvite`, whichever door: nobody refused anything. The person did something
 * larger than what they were being asked, and the row has to be able to say so — a
 * 'declined' here would tell the inviting parent's audit trail that their caregiver
 * said no.
 *
 * MUST be called inside the same transaction as the channel insert. Both halves describe
 * one phone and only one of them can be true, so a crash between them leaves exactly the
 * armed invite above.
 *
 * Returns the closed invite's id, or null when there was nothing open (the ordinary
 * case). Named rather than a bare boolean because the join outcome carries it: an invite
 * that ended without either side answering is not something anyone should have to infer
 * from a `closed_at` they went looking for.
 */
export async function supersedeOpenInviteOnEnrollment(
  database: Database,
  input: { phoneE164: string; via: EnrolmentDoor; now: Date },
): Promise<string | null> {
  const invite = await loadOpenInviteByPhone(database, input.phoneE164, input.now);
  if (!invite) return null;
  const { state, suffix } = ENROLMENT_SUPERSEDES[input.via];
  await closeInvite(database, invite, state, input.now, inviteVerb(invite.role, suffix));
  return invite.id;
}
