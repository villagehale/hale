import { type Database, schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';
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
  /** 72h of silence on whichever side we were waiting for. Terminal. */
  | 'expired';

/** Either side silent for this long and the invite lapses. */
export const INVITE_SILENCE_MS = 72 * 60 * 60 * 1000;

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

/** The invite THIS parent still owes a yes/no on, if any. */
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

export type StartInviteResult =
  | { status: 'started'; invite: CaregiverInvite; reply: string }
  | { status: 'own_number' }
  | { status: 'number_in_use' };

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
  state: Extract<CaregiverInviteState, 'declined' | 'expired'>,
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
 * A no from either side. The caregiver's no is a CASL refusal from the number itself,
 * so it writes a granted=false consent row in their own name-less right (there is no
 * user row for someone who never accepted — the refusal lives on the invite + audit).
 * The parent's no needs no consent row: nothing was ever authorised.
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
