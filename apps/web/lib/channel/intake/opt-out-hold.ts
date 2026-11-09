import { type Database, schema } from '@hale/db';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { type OpsPagerOutcome, pageOps } from '~/lib/monitoring/failure-page';
import { INTAKE_CONTENT_REDACTED } from '~/lib/rights/message-retention';
import { decodeIntakeForRecovery } from './session';

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
): Promise<'held' | 'already_held'> {
  const inserted = await database
    .insert(schema.optOutHeldMessages)
    .values({
      providerMessageId: input.providerMessageId,
      phoneHash: input.phoneHash,
      heldAt: input.now,
      nextReadAt: input.now,
    })
    .onConflictDoNothing()
    .returning({ id: schema.optOutHeldMessages.providerMessageId });
  console.warn(
    { hold: 'opt_out_unread' },
    'opt-out read failed twice - sender held from proactive sends until the text is re-read; the opt-out hold sweep pages it',
  );
  return inserted.length > 0 ? 'held' : 'already_held';
}

/** This exact text has been read. Releases its own row and no other. */
export async function releaseHeldMessage(
  database: Database,
  providerMessageId: string,
): Promise<'released' | 'not_held'> {
  const deleted = await database
    .delete(schema.optOutHeldMessages)
    .where(eq(schema.optOutHeldMessages.providerMessageId, providerMessageId))
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
  /** How many of their intake sessions would not decode. */
  undecodableSessions: number;
}

/** What {@link releaseErasedHolds} did about intake sessions that would not decode. */
export interface UndecodableIntakeOutcome {
  sessions: number;
  page: OpsPagerOutcome | 'nothing_to_page';
}

const UNDECODABLE_REASON = 'intake_session_undecodable';

/** The held texts a session's transcript names, or `undecodable` for a blob that will not
 * decrypt (a corrupt row, a rotated key): one such session must never stop an erasure. */
function heldTextsNamedBy(
  session: { id: string; dataEncrypted: string },
  heldIds: ReadonlySet<string>,
): string[] | 'undecodable' {
  if (session.dataEncrypted === INTAKE_CONTENT_REDACTED) return [];
  let transcript: ReturnType<typeof decodeIntakeForRecovery>['transcript'];
  try {
    transcript = decodeIntakeForRecovery(session.dataEncrypted).transcript;
  } catch {
    console.error(
      { session: session.id, reason: UNDECODABLE_REASON },
      'erasure: an intake session would not decode - its held rows are taken by number only where nobody holds it',
    );
    return 'undecodable';
  }
  return transcript.flatMap((line) =>
    line.direction === 'in' && line.providerId && heldIds.has(line.providerId)
      ? [line.providerId]
      : [],
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
      undecodableSessions: 0,
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
  const sessions =
    held.length === 0
      ? []
      : (
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
  const undecodable: string[] = [];
  for (const session of sessions) {
    const named = heldTextsNamedBy(session, heldIds);
    if (named === 'undecodable') undecodable.push(session.phoneHash);
    else intakeTexts.push(...named);
  }
  return {
    phoneHashes,
    providerMessageIds: [
      ...new Set([...texts.flatMap((row) => (row.id === null ? [] : [row.id])), ...intakeTexts]),
    ],
    undecodableNumbers: [...new Set(undecodable)],
    undecodableSessions: undecodable.length,
  };
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
    await database
      .delete(schema.optOutHeldMessages)
      .where(inArray(schema.optOutHeldMessages.phoneHash, released));
    await database
      .delete(schema.optOutReadHolds)
      .where(inArray(schema.optOutReadHolds.phoneHash, released));
  }
  if (erased.undecodableSessions === 0) return { sessions: 0, page: 'nothing_to_page' };
  const page = await pageOps(database, {
    site: 'erasure_intake_undecodable',
    facts: {
      number: erased.undecodableNumbers.some((hash) => stillHeld.has(hash))
        ? 'still_held'
        : 'released',
    },
  });
  return { sessions: erased.undecodableSessions, page };
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
