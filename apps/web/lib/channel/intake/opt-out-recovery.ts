import { type Database, schema } from '@hale/db';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { resolveVerifiedChannelByPhone, revokeSmsChannel } from '~/lib/channels/sms-consent-core';
import { decryptString } from '~/lib/crypto/string-cipher';
import { noteLateOptOutCrisis } from '~/lib/monitoring/failure-page';
import type { AbortedWindow, ProviderPreflightResult } from '~/lib/monitoring/provider-health';
import { type Inbound, handleStop } from './machine';
import { releaseHeldMessage } from './opt-out-hold';
import type { OptOutReader, OptOutReading } from './opt-out-reader';
import { type IntakeSession, decodeIntakeForRecovery, loadOpenSession } from './session';
import type { ChannelTransport } from './transport';

/**
 * VIL-553 · a text whose opt-out read failed is held by its provider message id
 * (opt-out-hold.ts), and this pass reads it again once the model is back. A number stays
 * held while any of its texts may be an unread stop, so a stop sent during an outage is
 * never lost to a later "hello" that read fine.
 *
 * Per tick (the scheduled drain, before the queues):
 *   0. Pre-VIL-553 per-number rows are re-pointed at every inbound of that number since
 *      the row was written. A standing row means no read succeeded after it.
 *   1. Due rows (`next_read_at <= now`) are taken oldest-due first, a batch at a time.
 *   2. The provider pre-flight runs once; a provider that cannot serve claims nothing.
 *   3. Each row is claimed and pushed back in one compare-and-set, so a row that never
 *      reads only delays itself, then read and settled by what the model read.
 * A stop runs the live stop path ({@link handleStop}): ledger row, audit row, session
 * close, and the model's own confirmation. An empty confirmation sends nothing.
 */

export const HELD_READ_OUTCOMES = [
  'stopped',
  'stopped_confirmation_unsent',
  'stopped_confirmation_failed',
  /** The number has a new holder: only the author's own channel is revoked, nothing sent. */
  'stopped_previous_holder',
  /** The number has a new holder and its author no longer holds it: nothing revoked or sent. */
  'previous_holder_already_stopped',
  /** The stop path threw before the number stopped being sendable: kept held, retried. */
  'stop_failed',
  'already_stopped',
  'read_not_stop',
  'read_start',
  'read_identity',
  'read_crisis',
  'read_leave_group',
  'read_failed',
  'not_yet_recorded',
  'unrecorded',
  'no_channel',
  'claimed_elsewhere',
] as const;

export type HeldReadOutcome = (typeof HELD_READ_OUTCOMES)[number];

/** Outcomes that leave the row standing. Every other outcome read the text and released it. */
const KEPT: ReadonlySet<HeldReadOutcome> = new Set([
  'stop_failed',
  'read_failed',
  'not_yet_recorded',
  'unrecorded',
  'no_channel',
  'claimed_elsewhere',
]);

export interface OptOutRecoveryDeps {
  reader: OptOutReader;
  /** The confirmation of a stop read late — REQUIRED (rule #11). */
  transport: ChannelTransport;
  /** Asked once per tick, and only when a row is due. */
  preflight: () => Promise<ProviderPreflightResult>;
  now: Date;
}

export interface OptOutRecoveryResult {
  repointed: number;
  legacyNoChannel: number;
  legacyUnpointed: number;
  outcomes: Record<HeldReadOutcome, number>;
  /** Due rows left for the next tick because this one spent its budget. */
  deferred: number;
  halted: (AbortedWindow & { reason: 'provider_down' }) | null;
}

/** A work bound per tick, not a send rule. */
export const HELD_READ_BATCH = 25;
/** The pass stops starting rows past this share of the drain tick. */
export const OPT_OUT_RECOVERY_BUDGET_MS = 25_000;
/** An inbound turn has written its ledger row by then. */
export const HELD_MESSAGE_SETTLE_MS = 15 * 60_000;

const FIRST_BACKOFF_MS = 15 * 60_000;
const MAX_BACKOFF_MS = 24 * 3_600_000;

/** A retry back-off for a model read, never a parent-send cadence. The first step is
 * past the drain's maxDuration, so a row claimed by a crashed tick is simply due again. */
export function heldReadBackoff(attempt: number): number {
  return Math.min(FIRST_BACKOFF_MS * 2 ** Math.max(0, attempt - 1), MAX_BACKOFF_MS);
}

function emptyOutcomes(): Record<HeldReadOutcome, number> {
  return Object.fromEntries(HELD_READ_OUTCOMES.map((outcome) => [outcome, 0])) as Record<
    HeldReadOutcome,
    number
  >;
}

export async function recoverHeldOptOutReads(
  database: Database,
  deps: OptOutRecoveryDeps,
): Promise<OptOutRecoveryResult> {
  const startedMs = Date.now();
  const { now } = deps;
  const result: OptOutRecoveryResult = {
    repointed: 0,
    legacyNoChannel: 0,
    legacyUnpointed: 0,
    outcomes: emptyOutcomes(),
    deferred: 0,
    halted: null,
  };
  await repointLegacyHolds(database, now, result);

  const due = await database
    .select()
    .from(schema.optOutHeldMessages)
    .where(lte(schema.optOutHeldMessages.nextReadAt, now))
    .orderBy(asc(schema.optOutHeldMessages.nextReadAt), asc(schema.optOutHeldMessages.heldAt))
    .limit(HELD_READ_BATCH);
  if (due.length === 0) return result;

  const preflight = await deps.preflight();
  if (!preflight.proceed) {
    result.halted = { ...preflight.abort, skipped: due.length, reason: 'provider_down' };
    return result;
  }

  for (const [index, row] of due.entries()) {
    if (Date.now() - startedMs >= OPT_OUT_RECOVERY_BUDGET_MS) {
      result.deferred = due.length - index;
      break;
    }
    const outcome = await recoverRow(database, deps, row);
    result.outcomes[outcome] += 1;
  }
  return result;
}

type HeldRow = typeof schema.optOutHeldMessages.$inferSelect;

interface HeldText {
  inbound: Inbound;
  phoneE164: string;
  session: IntakeSession | null;
  /** Known when the text belongs to a family; the audit row needs one. */
  owner: { familyId: string; parentUserId: string; channelMessageId: string | null } | null;
}

async function recoverRow(
  database: Database,
  deps: OptOutRecoveryDeps,
  row: HeldRow,
): Promise<HeldReadOutcome> {
  const { now } = deps;
  const claimed = await database
    .update(schema.optOutHeldMessages)
    .set({
      nextReadAt: new Date(now.getTime() + heldReadBackoff(row.readAttempts + 1)),
      readAttempts: sql`${schema.optOutHeldMessages.readAttempts} + 1`,
    })
    .where(
      and(
        eq(schema.optOutHeldMessages.providerMessageId, row.providerMessageId),
        lte(schema.optOutHeldMessages.nextReadAt, now),
      ),
    )
    .returning({ id: schema.optOutHeldMessages.providerMessageId });
  if (claimed.length === 0) return 'claimed_elsewhere';

  const held = await resolveHeldText(database, row);
  if (!held) {
    if (row.heldAt.getTime() > now.getTime() - HELD_MESSAGE_SETTLE_MS) return 'not_yet_recorded';
    if (await numberReachable(database, row.phoneHash)) {
      // Fail closed: a text no store recorded can never be read, so the number stays held
      // and the failure-page sweep pages it as "not in ledger".
      return 'unrecorded';
    }
    await releaseHeldMessage(database, row.providerMessageId);
    return 'no_channel';
  }

  const reading = await deps.reader.read({
    text: held.inbound.body,
    language: held.session?.ladderLanguage ?? null,
  });
  if (reading === null) return 'read_failed';

  const outcome = await settleReading(database, deps, row, held, reading);
  if (KEPT.has(outcome)) return outcome;
  if (held.owner) {
    await database.insert(schema.auditLog).values({
      familyId: held.owner.familyId,
      actor: held.owner.parentUserId,
      actionTaken: 'opt_out_hold_read',
      targetTable: 'channel_messages',
      targetId: held.owner.channelMessageId,
      after: { outcome },
    });
  } else {
    // No family yet (audit_log.family_id is NOT NULL). On a stop the closed session row
    // is the record, as on the live path.
    console.info({ outcome }, 'opt-out recovery: held text read for a sender with no family');
  }
  await releaseHeldMessage(database, row.providerMessageId);
  return outcome;
}

async function settleReading(
  database: Database,
  deps: OptOutRecoveryDeps,
  row: HeldRow,
  held: HeldText,
  reading: OptOutReading,
): Promise<HeldReadOutcome> {
  switch (reading.intent) {
    case 'none':
      return 'read_not_stop';
    // Not re-enrolled here: a late start is released, which is the safe direction.
    case 'start':
      return 'read_start';
    case 'identity':
      return 'read_identity';
    // The leave is not performed late; the group turn owns it.
    case 'leave_group':
      return 'read_leave_group';
    case 'crisis_emergency':
    case 'crisis_mental':
      // The crisis lane owns the reply (crisis-check.ts). A late one is paged by count.
      console.error(
        { urgent: true, outcome: 'read_crisis' },
        'URGENT: opt-out recovery: a held text read late as a crisis - no late reply sent',
      );
      await noteLateOptOutCrisis(database, row.providerMessageId, deps.now);
      return 'read_crisis';
    case 'stop':
      return lateStop(database, deps, row, held, reading.confirmation);
  }
}

async function lateStop(
  database: Database,
  deps: OptOutRecoveryDeps,
  row: HeldRow,
  held: HeldText,
  confirmation: string,
): Promise<HeldReadOutcome> {
  // The stop path acts on the phone number. A number that now belongs to someone else
  // (a recycled number, a new intake) must not be stopped for its previous holder.
  const author = held.owner;
  const current = await activeHolder(database, row.phoneHash);
  if (author) {
    const otherHolder =
      (current !== null && current.userId !== author.parentUserId) ||
      (held.session !== null && held.session.userId !== author.parentUserId);
    if (otherHolder) {
      // revokeSmsChannel acts on the author's active channel, whichever number it is on.
      if (current?.userId !== author.parentUserId) {
        return 'previous_holder_already_stopped';
      }
      await revokeSmsChannel(
        database,
        { userId: author.parentUserId, familyId: author.familyId },
        { now: deps.now },
      );
      return 'stopped_previous_holder';
    }
  } else if (
    held.session === null &&
    current?.verifiedAt != null &&
    current.verifiedAt.getTime() > held.inbound.receivedAt.getTime()
  ) {
    // Only a closed intake with no family recorded the text, and the number was verified
    // by its holder after it was sent: the text is not theirs to stop them with.
    return 'previous_holder_already_stopped';
  }
  const sendable = await stillSendable(database, held.phoneE164, row.phoneHash);
  try {
    const stopped = await handleStop(
      database,
      {
        phoneE164: held.phoneE164,
        inbound: held.inbound,
        session: held.session,
        now: deps.now,
        providerAnswered: false,
        // A number that already stopped is not told twice.
        confirmation: sendable ? confirmation : '',
      },
      { transport: deps.transport },
    );
    if (!sendable) return 'already_stopped';
    if (stopped.status === 'stopped' && stopped.ack === 'voice_unsent') {
      console.error(
        { outcome: 'stopped_confirmation_unsent' },
        'opt-out recovery: stop read late, revoked - confirmation not sent',
      );
      return 'stopped_confirmation_unsent';
    }
    return 'stopped';
  } catch (err) {
    const name = err instanceof Error ? err.name : 'unknown';
    if (await stillSendable(database, held.phoneE164, row.phoneHash)) {
      console.error(
        { urgent: true, outcome: 'stop_failed', err: name },
        'URGENT: opt-out recovery: stop read late but the stop path failed - kept held',
      );
      return 'stop_failed';
    }
    console.error(
      { outcome: 'stopped_confirmation_failed', err: name },
      'opt-out recovery: stop read late, revoked - confirmation send failed',
    );
    return 'stopped_confirmation_failed';
  }
}

/** The number's one active channel (a partial unique index), verified or not. */
async function activeHolder(
  database: Database,
  phoneHash: string,
): Promise<{ userId: string; verifiedAt: Date | null } | null> {
  const [holder] = await database
    .select({
      userId: schema.parentChannels.userId,
      verifiedAt: schema.parentChannels.verifiedAt,
    })
    .from(schema.parentChannels)
    .where(
      and(
        eq(schema.parentChannels.phoneE164Hash, phoneHash),
        isNull(schema.parentChannels.revokedAt),
      ),
    )
    .limit(1);
  return holder ?? null;
}

async function stillSendable(
  database: Database,
  phoneE164: string,
  phoneHash: string,
): Promise<boolean> {
  if (await resolveVerifiedChannelByPhone(database, phoneE164)) return true;
  return (await openSessionRow(database, phoneHash)) !== null;
}

/** The held text, from the family ledger, else from the open intake session's transcript. */
async function resolveHeldText(database: Database, row: HeldRow): Promise<HeldText | null> {
  const [message] = await database
    .select({
      id: schema.channelMessages.id,
      familyId: schema.channelMessages.familyId,
      parentUserId: schema.channelMessages.parentUserId,
      channel: schema.channelMessages.channel,
      body: schema.channelMessages.body,
      providerChatId: schema.channelMessages.providerChatId,
      inGroup: schema.channelMessages.inGroup,
      sentAt: schema.channelMessages.sentAt,
      createdAt: schema.channelMessages.createdAt,
    })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.providerMessageId, row.providerMessageId),
        eq(schema.channelMessages.direction, 'in'),
      ),
    )
    .limit(1);
  if (message?.body) {
    const [channel] = await database
      .select({ phoneE164Encrypted: schema.parentChannels.phoneE164Encrypted })
      .from(schema.parentChannels)
      .where(
        and(
          eq(schema.parentChannels.userId, message.parentUserId),
          eq(schema.parentChannels.phoneE164Hash, row.phoneHash),
        ),
      )
      .limit(1);
    if (channel) {
      const phoneE164 = decryptString(channel.phoneE164Encrypted);
      const transport = message.channel === 'imessage' ? 'imessage' : 'sms';
      return {
        phoneE164,
        session: await loadOpenSession(database, phoneE164),
        owner: {
          familyId: message.familyId,
          parentUserId: message.parentUserId,
          channelMessageId: message.id,
        },
        inbound: {
          from: phoneE164,
          body: message.body,
          providerId: row.providerMessageId,
          receivedAt: message.sentAt ?? message.createdAt,
          transport,
          // A late confirmation always goes one-to-one, never into the family group.
          ...(message.inGroup !== true && message.providerChatId
            ? { chatId: message.providerChatId }
            : {}),
          ...(message.inGroup === null ? {} : { isGroup: message.inGroup }),
        },
      };
    }
  }

  // Then the intake transcripts for this number: the open session first, then any closed
  // one (a session that closed before its held text was read still holds the words).
  const sessions = await database
    .select({
      phoneEncrypted: schema.smsIntakeSessions.phoneEncrypted,
      dataEncrypted: schema.smsIntakeSessions.dataEncrypted,
      familyId: schema.smsIntakeSessions.familyId,
      userId: schema.smsIntakeSessions.userId,
      closedAt: schema.smsIntakeSessions.closedAt,
    })
    .from(schema.smsIntakeSessions)
    .where(eq(schema.smsIntakeSessions.phoneHash, row.phoneHash))
    .orderBy(
      sql`${schema.smsIntakeSessions.closedAt} is not null`,
      desc(schema.smsIntakeSessions.createdAt),
    );
  for (const candidate of sessions) {
    const entry = decodeIntakeForRecovery(candidate.dataEncrypted).transcript.find(
      (line) => line.direction === 'in' && line.providerId === row.providerMessageId,
    );
    if (!entry) continue;
    const phoneE164 = decryptString(candidate.phoneEncrypted);
    return {
      phoneE164,
      session: candidate.closedAt === null ? await loadOpenSession(database, phoneE164) : null,
      owner:
        candidate.familyId && candidate.userId
          ? { familyId: candidate.familyId, parentUserId: candidate.userId, channelMessageId: null }
          : null,
      inbound: {
        from: phoneE164,
        body: entry.body,
        providerId: row.providerMessageId,
        receivedAt: new Date(entry.at),
        transport: entry.channel ?? 'sms',
        ...(entry.chatId ? { chatId: entry.chatId } : {}),
      },
    };
  }
  return null;
}

async function openSessionRow(
  database: Database,
  phoneHash: string,
): Promise<{ phoneEncrypted: string; dataEncrypted: string } | null> {
  const [row] = await database
    .select({
      phoneEncrypted: schema.smsIntakeSessions.phoneEncrypted,
      dataEncrypted: schema.smsIntakeSessions.dataEncrypted,
    })
    .from(schema.smsIntakeSessions)
    .where(
      and(
        eq(schema.smsIntakeSessions.phoneHash, phoneHash),
        isNull(schema.smsIntakeSessions.closedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Something can still text this number: a channel not revoked, or an open intake. */
async function numberReachable(database: Database, phoneHash: string): Promise<boolean> {
  const [channel] = await database
    .select({ id: schema.parentChannels.id })
    .from(schema.parentChannels)
    .where(
      and(
        eq(schema.parentChannels.phoneE164Hash, phoneHash),
        isNull(schema.parentChannels.revokedAt),
      ),
    )
    .limit(1);
  if (channel) return true;
  return (await openSessionRow(database, phoneHash)) !== null;
}

/**
 * A pre-VIL-553 row names a number, not a text. It still stands only if no read of that
 * number succeeded after `held_at`, so every inbound since then may be the unread stop.
 * Inserted before the legacy row is deleted, so a crash between the two re-points again.
 */
async function repointLegacyHolds(
  database: Database,
  now: Date,
  result: OptOutRecoveryResult,
): Promise<void> {
  // Every row, never a slice: nothing writes this table any more, so the set only
  // shrinks, and a slice of rows that stay unpointed would starve the rest forever.
  const legacy = await database
    .select()
    .from(schema.optOutReadHolds)
    .orderBy(asc(schema.optOutReadHolds.heldAt));
  for (const row of legacy) {
    const ids = await inboundIdsSince(database, row.phoneHash, row.heldAt);
    if (ids.length > 0) {
      await database
        .insert(schema.optOutHeldMessages)
        .values(
          ids.map((providerMessageId) => ({
            providerMessageId,
            phoneHash: row.phoneHash,
            heldAt: row.heldAt,
            nextReadAt: now,
          })),
        )
        .onConflictDoNothing();
      await deleteLegacyHold(database, row.phoneHash);
      result.repointed += ids.length;
      continue;
    }
    const settled = row.heldAt.getTime() <= now.getTime() - HELD_MESSAGE_SETTLE_MS;
    if (settled && !(await numberReachable(database, row.phoneHash))) {
      await deleteLegacyHold(database, row.phoneHash);
      result.legacyNoChannel += 1;
      continue;
    }
    result.legacyUnpointed += 1;
  }
}

async function deleteLegacyHold(database: Database, phoneHash: string): Promise<void> {
  await database
    .delete(schema.optOutReadHolds)
    .where(eq(schema.optOutReadHolds.phoneHash, phoneHash));
}

async function inboundIdsSince(
  database: Database,
  phoneHash: string,
  since: Date,
): Promise<string[]> {
  // The ledger names a user, not the number a text came from. A user holds one active
  // channel at a time, so a text the user sent while their channel on this number stood
  // came from this number; email and the user's other numbers are left out.
  const holdings = await database
    .select({
      userId: schema.parentChannels.userId,
      verifiedAt: schema.parentChannels.verifiedAt,
      revokedAt: schema.parentChannels.revokedAt,
    })
    .from(schema.parentChannels)
    .where(eq(schema.parentChannels.phoneE164Hash, phoneHash));
  const ledger: { id: string | null }[] = [];
  for (const holding of holdings) {
    const from =
      holding.verifiedAt && holding.verifiedAt.getTime() > since.getTime()
        ? holding.verifiedAt
        : since;
    ledger.push(
      ...(await database
        .select({ id: schema.channelMessages.providerMessageId })
        .from(schema.channelMessages)
        .where(
          and(
            eq(schema.channelMessages.parentUserId, holding.userId),
            eq(schema.channelMessages.direction, 'in'),
            inArray(schema.channelMessages.channel, ['sms', 'imessage']),
            gte(schema.channelMessages.sentAt, from),
            holding.revokedAt ? lte(schema.channelMessages.sentAt, holding.revokedAt) : undefined,
            isNotNull(schema.channelMessages.providerMessageId),
          ),
        )),
    );
  }
  const open = await openSessionRow(database, phoneHash);
  const transcript = open
    ? decodeIntakeForRecovery(open.dataEncrypted)
        .transcript.filter(
          (entry) => entry.direction === 'in' && Date.parse(entry.at) >= since.getTime(),
        )
        .map((entry) => entry.providerId)
    : [];
  return [
    ...new Set(
      [...ledger.map((row) => row.id), ...transcript].filter((id): id is string => Boolean(id)),
    ),
  ];
}
