import { type Database, schema } from '@hale/db';
import { and, eq, gte, isNull } from 'drizzle-orm';
import { maskPhoneE164 } from '~/lib/channels/phone';
import type { CaregiverRole } from '~/lib/channel/role-scope';
import { POLICY_VERSION } from '~/lib/consent';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { decryptString, encryptString } from '~/lib/crypto/string-cipher';
import { ROLE_LABEL, inviteBody, scopeConfirm } from './copy';
import type { ParsedAddCaregiver } from './parse';

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

export interface CaregiverInvite {
  id: string;
  familyId: string;
  invitedByUserId: string;
  role: CaregiverRole;
  displayName: string;
  /** Decrypted only in memory, to address the send. Never logged, never audited raw. */
  phoneE164: string;
  state: CaregiverInviteState;
  expiresAt: Date;
}

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
  return {
    id: row.id,
    familyId: row.familyId,
    invitedByUserId: row.invitedByUserId,
    role: row.role as CaregiverRole,
    displayName: row.displayName,
    phoneE164: decryptString(row.phoneE164Encrypted),
    state: row.state as CaregiverInviteState,
    expiresAt: new Date(row.expiresAt),
  };
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
  await closeInvite(database, toInvite(row), 'expired', now, 'caregiver_invite_expired');
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
  | { status: 'started'; invite: CaregiverInvite; reply: string }
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
    parsed: Extract<ParsedAddCaregiver, { ok: true }>;
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
    await closeInvite(
      database,
      toInvite(superseded),
      'superseded',
      now,
      'caregiver_invite_superseded',
    );
  }

  const [row] = await database
    .insert(schema.caregiverInvites)
    .values({
      familyId: input.familyId,
      invitedByUserId: input.invitedByUserId,
      role: parsed.role,
      displayName: parsed.name,
      phoneE164Encrypted: encryptString(parsed.phoneE164),
      phoneE164Hash: hash,
      state: 'awaiting_parent_assent',
      expiresAt: new Date(now.getTime() + INVITE_SILENCE_MS),
      // Written explicitly rather than left to the column default: the cap above reads
      // it back, and a meter that depends on the clock the row was written by cannot be
      // reasoned about (or tested) deterministically.
      createdAt: now,
    })
    .returning({ id: schema.caregiverInvites.id });
  const id = row?.id;
  if (!id) {
    throw new Error('startCaregiverInvite: caregiver_invites insert returned no row');
  }

  await database.insert(schema.auditLog).values({
    familyId: input.familyId,
    actor: input.invitedByUserId,
    actionTaken: 'caregiver_invite_started',
    targetTable: 'caregiver_invites',
    targetId: id,
    after: {
      role: parsed.role,
      displayName: parsed.name,
      maskedPhone: maskPhoneE164(parsed.phoneE164),
    },
  });

  return {
    status: 'started',
    invite: {
      id,
      familyId: input.familyId,
      invitedByUserId: input.invitedByUserId,
      role: parsed.role,
      displayName: parsed.name,
      phoneE164: parsed.phoneE164,
      state: 'awaiting_parent_assent',
      expiresAt: new Date(now.getTime() + INVITE_SILENCE_MS),
    },
    reply: scopeConfirm(parsed.name, parsed.role),
  };
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
    invite: CaregiverInvite;
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
    input.by === 'parent' ? 'caregiver_invite_withdrawn' : 'caregiver_invite_refused',
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
  input: { invite: CaregiverInvite; verbatimReply: string; now: Date },
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
  co_parent_join: {
    state: 'superseded_by_join',
    actionTaken: 'caregiver_invite_superseded_by_join',
  },
  sms_intake: {
    state: 'superseded_by_enrollment',
    actionTaken: 'caregiver_invite_superseded_by_enrollment',
  },
} as const satisfies Record<string, { state: CaregiverInviteState; actionTaken: string }>;

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
  const { state, actionTaken } = ENROLMENT_SUPERSEDES[input.via];
  await closeInvite(database, invite, state, input.now, actionTaken);
  return invite.id;
}
