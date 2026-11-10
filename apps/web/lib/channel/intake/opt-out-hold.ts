import { createHash } from 'node:crypto';
import { type Database, schema } from '@hale/db';
import { and, eq, inArray, isNotNull, isNull, ne, or } from 'drizzle-orm';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { type OpsPagerOutcome, pageOps } from '~/lib/monitoring/failure-page';
import { INTAKE_CONTENT_REDACTED, redactIntakeSessionsById } from '~/lib/rights/message-retention';
import { decodeIntakeForRecovery, isUnreadableIntakeBlob } from './session';

/** Joins a colliding provider id to a digest of the second number. The digest is not the
 * number: phone_hash stays its own column, and a replay of the same pair writes this same
 * key, so two deliveries cannot leave two rows. */
const COLLISION_KEY_INFIX = '#collision:';

function collisionKeyOf(providerMessageId: string, phoneHash: string): string {
  return `${providerMessageId}${COLLISION_KEY_INFIX}${createHash('sha256').update(phoneHash).digest('hex')}`;
}

/** A hold on one text, released once that text is read. */
export const MESSAGE_HOLD = 'message';
/** A number whose text shares its provider id with another number's hold. No store can
 * place it, so only an operator clears it ({@link clearCollisionHold}). */
export const ID_COLLISION_HOLD = 'id_collision';

/** The only rows a read or a recovery pass may release. A kind this code does not know is
 * not one, so it is kept like a collision (fail closed). */
const releasableHold = eq(schema.optOutHeldMessages.kind, MESSAGE_HOLD);

/**
 * #868 · the hold after an opt-out read fails twice. No keyword list stands behind the
 * reader, so a text it could not read may be a stop. VIL-553: the hold names that text by
 * its provider message id, and the number stays held until THAT text has been read
 * (opt-out-recovery.ts re-reads it once the model is back). Nothing proactive or queued
 * goes to a held number (the outbound gate reads {@link isParentHeld}); replies to their
 * own texts still go out.
 */
export async function holdSender(
  database: Database,
  input: { phoneHash: string; providerMessageId: string; now: Date },
): Promise<HoldOutcome> {
  console.warn(
    { hold: 'opt_out_unread' },
    'opt-out read failed twice - sender held from proactive sends until the text is re-read; the opt-out hold sweep pages it',
  );
  return placeHold(database, {
    phoneHash: input.phoneHash,
    providerMessageId: input.providerMessageId,
    heldAt: input.now,
    nextReadAt: input.now,
  });
}

export type HoldOutcome = 'held' | 'already_held' | 'held_id_collision';

/**
 * Holds one text of one number: every writer of a hold row comes through here (the live
 * hold above, and the legacy re-point in opt-out-recovery.ts). The provider id is the key
 * across every transport, so an id another number's text already holds never holds this
 * number by nothing. Fail closed: this number gets a collision hold of its own, under a key
 * no store can place, which only an operator clears. The key names no number. A second
 * delivery of the same pair writes that same key and returns already_held, so it cannot
 * leave a second row.
 */
export async function placeHold(
  database: Database,
  input: { phoneHash: string; providerMessageId: string; heldAt: Date; nextReadAt: Date },
): Promise<HoldOutcome> {
  const inserted = await database
    .insert(schema.optOutHeldMessages)
    .values({ ...input, kind: MESSAGE_HOLD })
    .onConflictDoNothing()
    .returning({ id: schema.optOutHeldMessages.providerMessageId });
  if (inserted.length > 0) return 'held';
  const [existing] = await database
    .select({ phoneHash: schema.optOutHeldMessages.phoneHash })
    .from(schema.optOutHeldMessages)
    .where(eq(schema.optOutHeldMessages.providerMessageId, input.providerMessageId))
    .limit(1);
  if (existing?.phoneHash === input.phoneHash) return 'already_held';
  const collision = await database
    .insert(schema.optOutHeldMessages)
    .values({
      ...input,
      providerMessageId: collisionKeyOf(input.providerMessageId, input.phoneHash),
      kind: ID_COLLISION_HOLD,
    })
    .onConflictDoNothing()
    .returning({ id: schema.optOutHeldMessages.providerMessageId });
  if (collision.length === 0) return 'already_held';
  // A site of its own, so an unrelated failed hold this hour cannot use up its page.
  await pageOps(database, { site: 'opt_out_hold_id_collision', facts: {} });
  return 'held_id_collision';
}

/**
 * The operator path, and the only one, that clears a hold that is not a message hold
 * (scripts/clear-opt-out-collision-hold.ts). A message hold is never taken here: it goes
 * when its text is read. The number's verified holders each get an audit row about them.
 */
export async function clearCollisionHold(
  database: Database,
  holdKey: string,
): Promise<'cleared' | 'not_a_collision_hold'> {
  return database.transaction(async (tx) => {
    const [cleared] = await tx
      .delete(schema.optOutHeldMessages)
      .where(
        and(
          eq(schema.optOutHeldMessages.providerMessageId, holdKey),
          ne(schema.optOutHeldMessages.kind, MESSAGE_HOLD),
        ),
      )
      .returning({ phoneHash: schema.optOutHeldMessages.phoneHash });
    if (!cleared) return 'not_a_collision_hold';
    const holders = await tx
      .select({ familyId: schema.parentChannels.familyId, userId: schema.parentChannels.userId })
      .from(schema.parentChannels)
      .where(
        and(
          eq(schema.parentChannels.phoneE164Hash, cleared.phoneHash),
          isNull(schema.parentChannels.revokedAt),
          isNotNull(schema.parentChannels.verifiedAt),
        ),
      );
    if (holders.length > 0) {
      await tx.insert(schema.auditLog).values(
        holders.map((holder) => ({
          familyId: holder.familyId,
          actor: 'system',
          actionTaken: 'opt_out_hold_cleared',
          // About the one adult who holds the number, as opt_out_hold_read is.
          targetTable: 'users',
          targetId: holder.userId,
        })),
      );
    } else {
      // No family to write it to (audit_log.family_id is NOT NULL).
      console.info(
        { outcome: 'collision_hold_cleared', holders: 0 },
        'opt-out hold: an operator cleared a collision hold on a number nobody holds',
      );
    }
    return 'cleared';
  });
}

/** This exact text has been read. Releases its own message hold and no other row. */
export async function releaseHeldMessage(
  database: Database,
  providerMessageId: string,
): Promise<'released' | 'not_held'> {
  const deleted = await database
    .delete(schema.optOutHeldMessages)
    .where(and(eq(schema.optOutHeldMessages.providerMessageId, providerMessageId), releasableHold))
    .returning({ id: schema.optOutHeldMessages.providerMessageId });
  return deleted.length > 0 ? 'released' : 'not_held';
}

/** What an erasure takes from the two hold tables, read before the family cascade. */
export interface ErasedHolds {
  /** The erased families' numbers. */
  phoneHashes: string[];
  /** Held texts the erased families sent, whichever number holds them now: named by their
   * ledger, or by their intake transcripts (a text no ledger row names). */
  providerMessageIds: string[];
  /** The numbers of their intake sessions that would not decode. What those sessions name
   * cannot be read, so a held row on such a number is taken only where nobody holds it. */
  undecodableNumbers: string[];
  /** Their intake sessions that would not decode. Each is kept, redacted, so the page has a
   * row to name: ops resolves it to its number. */
  undecodableSessions: { id: string; phoneHash: string }[];
  /** Every inbound text their intake transcripts name. A pre-signup text has no ledger row,
   * so its crisis marks are found by these alone. */
  intakeInboundIds: string[];
  /** Their pre-signup sessions (no family yet), which the family cascade never reaches. */
  presignupSessionIds: string[];
}

/** What {@link releaseErasedHolds} did about intake sessions that would not decode. */
export interface UndecodableIntakeOutcome {
  sessions: number;
  page: OpsPagerOutcome | 'nothing_to_page';
}

const UNDECODABLE_REASON = 'intake_session_undecodable';

/** The inbound texts a session's transcript names, or `undecodable` for a blob that will
 * not open (a corrupt row, a rotated key): one such session must never stop an erasure. Any
 * other throw is a fault in the code, not the row, and stops the sweep. */
function inboundTextsOf(session: { id: string; dataEncrypted: string }): string[] | 'undecodable' {
  if (session.dataEncrypted === INTAKE_CONTENT_REDACTED) return [];
  let transcript: ReturnType<typeof decodeIntakeForRecovery>['transcript'];
  try {
    transcript = decodeIntakeForRecovery(session.dataEncrypted).transcript;
  } catch (err) {
    if (!isUnreadableIntakeBlob(err)) throw err;
    console.error(
      { session: session.id, reason: UNDECODABLE_REASON },
      'erasure: an intake session would not decode - its held rows are taken by number only where nobody holds it',
    );
    return 'undecodable';
  }
  return transcript.flatMap((line) =>
    line.direction === 'in' && line.providerId ? [line.providerId] : [],
  );
}

/** Read BEFORE the family cascade: it deletes the channels and texts that say what to take. */
export async function erasedFamilyHolds(
  database: Database,
  familyIds: readonly string[],
): Promise<ErasedHolds> {
  if (familyIds.length === 0) {
    return {
      phoneHashes: [],
      providerMessageIds: [],
      undecodableNumbers: [],
      undecodableSessions: [],
      intakeInboundIds: [],
      presignupSessionIds: [],
    };
  }
  const channels = await database
    .select({
      phoneHash: schema.parentChannels.phoneE164Hash,
      revokedAt: schema.parentChannels.revokedAt,
    })
    .from(schema.parentChannels)
    .where(inArray(schema.parentChannels.familyId, [...familyIds]));
  const phoneHashes = [...new Set(channels.map((row) => row.phoneHash))];
  // The held set is small (one row per unread text); a family's ledger is not.
  const held = await database
    .select({ id: schema.optOutHeldMessages.providerMessageId })
    .from(schema.optOutHeldMessages);
  const texts =
    held.length === 0
      ? []
      : await database
          .select({ id: schema.channelMessages.providerMessageId })
          .from(schema.channelMessages)
          .where(
            and(
              inArray(schema.channelMessages.familyId, [...familyIds]),
              eq(schema.channelMessages.direction, 'in'),
              inArray(
                schema.channelMessages.providerMessageId,
                held.map((row) => row.id),
              ),
            ),
          );
  const heldIds = new Set(held.map((row) => row.id));
  // Until when the erased families held each number: null while they still do. A session
  // with no family yet on that number, opened by then, is theirs from before they signed
  // up; one opened after is its next holder's.
  const heldUntil = new Map<string, Date | null>();
  for (const row of channels) {
    const until = heldUntil.get(row.phoneHash);
    if (until === null) continue;
    if (row.revokedAt === null || until === undefined || row.revokedAt > until) {
      heldUntil.set(row.phoneHash, row.revokedAt);
    }
  }
  const sessions = (
    await database
      .select({
        id: schema.smsIntakeSessions.id,
        phoneHash: schema.smsIntakeSessions.phoneHash,
        familyId: schema.smsIntakeSessions.familyId,
        createdAt: schema.smsIntakeSessions.createdAt,
        dataEncrypted: schema.smsIntakeSessions.dataEncrypted,
      })
      .from(schema.smsIntakeSessions)
      .where(
        or(
          inArray(schema.smsIntakeSessions.familyId, [...familyIds]),
          phoneHashes.length === 0
            ? undefined
            : and(
                isNull(schema.smsIntakeSessions.familyId),
                inArray(schema.smsIntakeSessions.phoneHash, phoneHashes),
              ),
        ),
      )
  ).filter((session) => {
    if (session.familyId !== null) return true;
    const until = heldUntil.get(session.phoneHash);
    return until === null || (until !== undefined && session.createdAt <= until);
  });
  const intakeTexts: string[] = [];
  const undecodable: { id: string; phoneHash: string }[] = [];
  for (const session of sessions) {
    const named = inboundTextsOf(session);
    if (named === 'undecodable') undecodable.push({ id: session.id, phoneHash: session.phoneHash });
    else intakeTexts.push(...named);
  }
  return {
    phoneHashes,
    providerMessageIds: [
      ...new Set([
        ...texts.flatMap((row) => (row.id === null ? [] : [row.id])),
        ...intakeTexts.filter((id) => heldIds.has(id)),
      ]),
    ],
    undecodableNumbers: [...new Set(undecodable.map((session) => session.phoneHash))],
    undecodableSessions: undecodable,
    intakeInboundIds: [...new Set(intakeTexts)],
    presignupSessionIds: sessions
      .filter((session) => session.familyId === null)
      .map((session) => session.id),
  };
}

/**
 * Before the family cascade: what the erased parents texted before their family existed is
 * redacted with it, not a year later by retention. A session that would not decode is
 * detached from its family and redacted rather than cascaded, so the page names a row that
 * still stands: no content, only the number's hash ops looks the held rows up by.
 */
export async function redactErasedIntake(
  database: Database,
  erased: ErasedHolds,
  now: Date,
): Promise<void> {
  const undecodable = erased.undecodableSessions.map((session) => session.id);
  if (undecodable.length > 0) {
    await database
      .update(schema.smsIntakeSessions)
      .set({ familyId: null, userId: null })
      .where(inArray(schema.smsIntakeSessions.id, undecodable));
  }
  await redactIntakeSessionsById(
    database,
    [...new Set([...erased.presignupSessionIds, ...undecodable])],
    now,
  );
}

/**
 * After the family cascade (rights/delete.ts). Hold rows are keyed by the number and the
 * text alone, so an erasure takes its own here: held texts the family sent, and every row
 * on its numbers, but only where nobody holds that number now. A number someone still
 * holds keeps every row on it, since any may be their own unread stop (a parent seated in
 * a second family, or the number's next holder). Such a row keeps no family content (a
 * phone hash, a provider id, a time): what a text the family sent was read as when it was
 * read as a crisis is cleared from it. Never by the number alone: a still-held number's
 * other rows are its holder's, and their late crisis reply needs what they were read as.
 * Once its text is gone it reads as unrecorded, so the hold stays fail closed and is paged.
 */
export async function releaseErasedHolds(
  database: Database,
  erased: ErasedHolds,
): Promise<UndecodableIntakeOutcome> {
  if (erased.providerMessageIds.length > 0) {
    await database
      .update(schema.optOutHeldMessages)
      .set({
        crisisReadEncrypted: null,
        crisisLanguage: null,
        crisisSituation: null,
        crisisWho: null,
      })
      .where(inArray(schema.optOutHeldMessages.providerMessageId, erased.providerMessageIds));
  }
  const texts =
    erased.providerMessageIds.length === 0
      ? []
      : await database
          .select({
            id: schema.optOutHeldMessages.providerMessageId,
            phoneHash: schema.optOutHeldMessages.phoneHash,
          })
          .from(schema.optOutHeldMessages)
          .where(inArray(schema.optOutHeldMessages.providerMessageId, erased.providerMessageIds));
  const numbers = [
    ...new Set([
      ...erased.phoneHashes,
      ...erased.undecodableNumbers,
      ...texts.map((row) => row.phoneHash),
    ]),
  ];
  if (numbers.length === 0) return { sessions: 0, page: 'nothing_to_page' };
  const channels = await database
    .select({ phoneHash: schema.parentChannels.phoneE164Hash })
    .from(schema.parentChannels)
    .where(
      and(
        inArray(schema.parentChannels.phoneE164Hash, numbers),
        isNull(schema.parentChannels.revokedAt),
      ),
    );
  const sessions = await database
    .select({ phoneHash: schema.smsIntakeSessions.phoneHash })
    .from(schema.smsIntakeSessions)
    .where(
      and(
        inArray(schema.smsIntakeSessions.phoneHash, numbers),
        isNull(schema.smsIntakeSessions.closedAt),
      ),
    );
  const stillHeld = new Set([...channels, ...sessions].map((row) => row.phoneHash));
  const releasedTexts = texts.filter((row) => !stillHeld.has(row.phoneHash)).map((row) => row.id);
  if (releasedTexts.length > 0) {
    await database
      .delete(schema.optOutHeldMessages)
      .where(inArray(schema.optOutHeldMessages.providerMessageId, releasedTexts));
  }
  const released = [...new Set([...erased.phoneHashes, ...erased.undecodableNumbers])].filter(
    (hash) => !stillHeld.has(hash),
  );
  if (released.length > 0) {
    // Every kind, collision holds too: nobody holds the number, so no stop of theirs can be
    // lost, and the erased family's phone hash is not kept for a number nobody has.
    await database
      .delete(schema.optOutHeldMessages)
      .where(inArray(schema.optOutHeldMessages.phoneHash, released));
    await database
      .delete(schema.optOutReadHolds)
      .where(inArray(schema.optOutReadHolds.phoneHash, released));
  }
  const [first] = erased.undecodableSessions;
  if (first === undefined) return { sessions: 0, page: 'nothing_to_page' };
  // A session on a number someone still holds is the one ops has rows to act on.
  const named =
    erased.undecodableSessions.find((session) => stillHeld.has(session.phoneHash)) ?? first;
  const page = await pageOps(database, {
    site: 'erasure_intake_undecodable',
    facts: { number: stillHeld.has(named.phoneHash) ? 'still_held' : 'released' },
    ref: named.id,
  });
  return { sessions: erased.undecodableSessions.length, page };
}

/** Held while any unread text of this number stands, or a pre-VIL-553 row does. */
export async function isSenderHeld(database: Database, phoneHash: string): Promise<boolean> {
  const [message] = await database
    .select({ id: schema.optOutHeldMessages.providerMessageId })
    .from(schema.optOutHeldMessages)
    .where(eq(schema.optOutHeldMessages.phoneHash, phoneHash))
    .limit(1);
  if (message) return true;
  const [legacy] = await database
    .select({ phoneHash: schema.optOutReadHolds.phoneHash })
    .from(schema.optOutReadHolds)
    .where(eq(schema.optOutReadHolds.phoneHash, phoneHash))
    .limit(1);
  return Boolean(legacy);
}

/** The parent's sendable number is on hold. No number: nothing to hold. */
export async function isParentHeld(database: Database, parentUserId: string): Promise<boolean> {
  const phone = await resolveSendablePhone(database, parentUserId);
  return phone ? isSenderHeld(database, phoneBlindIndex(phone)) : false;
}
