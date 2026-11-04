import { type Database, schema } from '@hale/db';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { resolveVerifiedChannelByPhone } from '~/lib/channels/sms-consent-core';
import { decryptString } from '~/lib/crypto/string-cipher';
import { noteLateOptOutCrisis } from '~/lib/monitoring/failure-page';
import type { AbortedWindow, ProviderPreflightResult } from '~/lib/monitoring/provider-health';
import { INTAKE_CONTENT_REDACTED } from '~/lib/rights/message-retention';
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
 * A stop is settled against {@link numberHolderTimeline}, latest row wins: it stops the
 * holder of its number at the time only while they still hold it and nothing has started
 * since. Then it runs the live stop path ({@link handleStop}) on that number alone.
 */

export const HELD_READ_OUTCOMES = [
  'stopped',
  'stopped_confirmation_unsent',
  /** Revoked, but the confirmation send threw: kept held and read again. */
  'stopped_confirmation_failed',
  /** Something started on the number after the stop (the same person again, or someone
   * new on a recycled number): the newer row wins, nobody is stopped, nothing is sent. */
  'stop_superseded',
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
  /** The timeline cannot say whose stop it is: kept held (fail closed), paged, nobody stopped. */
  'timeline_unresolved',
  /** Reading or settling the row threw: kept held and read again; the pass goes on. */
  'recovery_failed',
  'no_channel',
  'claimed_elsewhere',
] as const;

export type HeldReadOutcome = (typeof HELD_READ_OUTCOMES)[number];

/** Outcomes that leave the row standing. Every other outcome read the text and released it. */
const KEPT: ReadonlySet<HeldReadOutcome> = new Set([
  'stopped_confirmation_failed',
  'stop_failed',
  'timeline_unresolved',
  'recovery_failed',
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
  /** Legacy rows whose re-point threw: left standing for the next tick. */
  legacyFailed: number;
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
    legacyFailed: 0,
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
    const outcome = await recoverRow(database, deps, row).catch((err: unknown) => {
      // The row was claimed, so it is due again after its back-off. The name only: a
      // message from inside the read may carry what it was reading.
      console.error(
        { urgent: true, outcome: 'recovery_failed', err: errName(err) },
        'URGENT: opt-out recovery: a held text could not be settled - kept held',
      );
      return 'recovery_failed' as const;
    });
    result.outcomes[outcome] += 1;
  }
  return result;
}

type HeldRow = typeof schema.optOutHeldMessages.$inferSelect;

function errName(err: unknown): string {
  return err instanceof Error ? err.name : 'unknown';
}

/** A session's transcript, or null once the retention sweep has redacted it. */
function readTranscript(dataEncrypted: string): ReturnType<typeof decodeIntakeForRecovery> | null {
  return dataEncrypted === INTAKE_CONTENT_REDACTED ? null : decodeIntakeForRecovery(dataEncrypted);
}

interface HeldText {
  inbound: Inbound;
  phoneE164: string;
  language: IntakeSession['ladderLanguage'];
  /** Who the store says sent it: the ledger's parent, or the user the intake became.
   * Null for an intake that never reached a family. */
  authorUserId: string | null;
  /** The author's family, when there is one. The read's audit row needs it. */
  familyId: string | null;
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
    language: held.language,
  });
  if (reading === null) return 'read_failed';

  const outcome = await settleReading(database, deps, row, held, reading);
  if (KEPT.has(outcome)) return outcome;
  if (held.familyId && held.authorUserId) {
    await database.insert(schema.auditLog).values({
      familyId: held.familyId,
      actor: 'system',
      actionTaken: 'opt_out_hold_read',
      // About one adult, the parent who texted, so History and the family copy leave it
      // out. It names no outcome: a stop or a crisis is not another adult's to read.
      targetTable: 'users',
      targetId: held.authorUserId,
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
  const timeline = await numberHolderTimeline(database, row.phoneHash);
  const verdict = lateStopVerdict(timeline, held.inbound.receivedAt, held.authorUserId);
  if (verdict === 'superseded') return 'stop_superseded';
  if (verdict === 'unresolved') {
    console.error(
      { urgent: true, outcome: 'timeline_unresolved' },
      'URGENT: opt-out recovery: a stop read late, but the number timeline cannot say whose it is - kept held, nobody stopped',
    );
    return 'timeline_unresolved';
  }

  // 'holder': the one who held the number then holds it now, and every open holding is
  // theirs, so the open session (if any) is theirs to close. 'no_holder': nobody holds it
  // and nothing has started since; the stop still reaches the number's invites, quietly.
  const open = verdict === 'holder' ? await loadOpenSession(database, held.phoneE164) : null;
  const sendable = verdict === 'holder' && (await stillSendable(database, held.phoneE164));
  try {
    const stopped = await handleStop(
      database,
      {
        phoneE164: held.phoneE164,
        inbound: held.inbound,
        // handleStop revokes a session's user wherever their channel is now. A late stop
        // belongs to the number it came from, so the owner is read from this number.
        session: open ? { ...open, familyId: null, userId: null } : null,
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
    const name = errName(err);
    // Nothing was to be sent, or the number can still be texted: the stop itself failed.
    if (!sendable || (await stillSendable(database, held.phoneE164))) {
      console.error(
        { urgent: true, outcome: 'stop_failed', err: name },
        'URGENT: opt-out recovery: stop read late but the stop path failed - kept held',
      );
      return 'stop_failed';
    }
    console.error(
      { outcome: 'stopped_confirmation_failed', err: name },
      'opt-out recovery: stop read late, revoked - confirmation send failed, kept held',
    );
    return 'stopped_confirmation_failed';
  }
}

/** One holding of a number: a parent channel until it is revoked, an intake session
 * until it closes, a caregiver invite until it closes, or a guest's reminder opt-in. Only
 * a channel or a session names who holds the number; every kind is a consent a stop can
 * reach, so any of them starting after a stop supersedes it. */
export interface NumberHolding {
  kind: 'channel' | 'session' | 'invite' | 'guest_reminders';
  id: string;
  /** The person behind it. Null for an intake that has not become anyone yet, which is
   * only "whoever texts this number". */
  userId: string | null;
  start: Date;
  /** Null while it still holds the number. */
  end: Date | null;
}

/** Every holding of the number, oldest first. */
export async function numberHolderTimeline(
  database: Database,
  phoneHash: string,
): Promise<NumberHolding[]> {
  const channels = await database
    .select({
      id: schema.parentChannels.id,
      userId: schema.parentChannels.userId,
      verifiedAt: schema.parentChannels.verifiedAt,
      createdAt: schema.parentChannels.createdAt,
      revokedAt: schema.parentChannels.revokedAt,
    })
    .from(schema.parentChannels)
    .where(eq(schema.parentChannels.phoneE164Hash, phoneHash));
  const sessions = await database
    .select({
      id: schema.smsIntakeSessions.id,
      userId: schema.smsIntakeSessions.userId,
      createdAt: schema.smsIntakeSessions.createdAt,
      closedAt: schema.smsIntakeSessions.closedAt,
      dataEncrypted: schema.smsIntakeSessions.dataEncrypted,
    })
    .from(schema.smsIntakeSessions)
    .where(eq(schema.smsIntakeSessions.phoneHash, phoneHash));
  const invites = await database
    .select({
      id: schema.caregiverInvites.id,
      createdAt: schema.caregiverInvites.createdAt,
      closedAt: schema.caregiverInvites.closedAt,
    })
    .from(schema.caregiverInvites)
    .where(eq(schema.caregiverInvites.phoneE164Hash, phoneHash));
  const guestOptIns = await database
    .select({ id: schema.partyRsvps.id, optedInAt: schema.partyRsvps.reminderOptInAt })
    .from(schema.partyRsvps)
    .where(eq(schema.partyRsvps.phoneE164Hash, phoneHash));
  const holdings: NumberHolding[] = [
    ...channels.map((channel) => ({
      kind: 'channel' as const,
      id: channel.id,
      userId: channel.userId,
      // Every SMS consent grant inserts a fresh row (revoke-then-insert, never an
      // un-revoke), so a verified channel starts at its consent; a pending one when it
      // was asked for.
      start: channel.verifiedAt ?? channel.createdAt,
      end: channel.revokedAt,
    })),
    ...sessions.map((session) => {
      // The row is written while its first text is handled, a moment after that text
      // arrived, so the session holds the number from its first text. A redacted one
      // still held it, from when it was written.
      const first = Math.min(
        session.createdAt.getTime(),
        ...(readTranscript(session.dataEncrypted)
          ?.transcript.filter((entry) => entry.direction === 'in')
          .map((entry) => Date.parse(entry.at)) ?? []),
      );
      return {
        kind: 'session' as const,
        id: session.id,
        userId: session.userId,
        start: new Date(first),
        end: session.closedAt,
      };
    }),
    ...invites.map((invite) => ({
      kind: 'invite' as const,
      id: invite.id,
      userId: null,
      start: invite.createdAt,
      end: invite.closedAt,
    })),
    ...guestOptIns.flatMap((rsvp) =>
      rsvp.optedInAt
        ? [
            {
              kind: 'guest_reminders' as const,
              id: rsvp.id,
              userId: null,
              start: rsvp.optedInAt,
              end: null,
            },
          ]
        : [],
    ),
  ];
  return holdings.sort((a, b) => a.start.getTime() - b.start.getTime());
}

function covers(holding: NumberHolding, at: Date): boolean {
  return (
    holding.start.getTime() <= at.getTime() &&
    (holding.end === null || holding.end.getTime() > at.getTime())
  );
}

/** The newest of these holdings when one person is behind them all; 'ambiguous' otherwise. */
function onePerson(holdings: NumberHolding[]): NumberHolding | null | 'ambiguous' {
  const newest = holdings[holdings.length - 1];
  if (!newest) return null;
  return holdings.every((holding) => holding.userId === newest.userId) ? newest : 'ambiguous';
}

function namesHolder(holding: NumberHolding): boolean {
  return holding.kind === 'channel' || holding.kind === 'session';
}

/** Who held the number when `at` came: 'ambiguous' when two people did. */
export function holderAt(timeline: NumberHolding[], at: Date): NumberHolding | null | 'ambiguous' {
  return onePerson(timeline.filter((holding) => namesHolder(holding) && covers(holding, at)));
}

/** Who holds the number now: the newest holding still open. */
export function currentHolder(timeline: NumberHolding[]): NumberHolding | null | 'ambiguous' {
  return onePerson(timeline.filter((holding) => namesHolder(holding) && holding.end === null));
}

/**
 * Latest row wins, as in the consent ledger. A late stop applies only to the number's
 * holder when it was sent, and only while that holder still holds it with nothing
 * started since. Any later holding, the same person's or someone new's, supersedes it.
 * A timeline that cannot name one holder, or that disagrees with the store about who
 * sent the text, stops nobody.
 */
export function lateStopVerdict(
  timeline: NumberHolding[],
  receivedAt: Date,
  authorUserId: string | null,
): 'holder' | 'no_holder' | 'superseded' | 'unresolved' {
  if (timeline.length === 0) return 'unresolved';
  if (timeline.some((holding) => holding.start.getTime() > receivedAt.getTime())) {
    return 'superseded';
  }
  const then = holderAt(timeline, receivedAt);
  const now = currentHolder(timeline);
  if (then === 'ambiguous' || now === 'ambiguous') return 'unresolved';
  if (then !== null && then.userId !== authorUserId) return 'unresolved';
  if (now === null) return 'no_holder';
  // With nothing started since, a holding open now was open then.
  return then?.userId === now.userId ? 'holder' : 'unresolved';
}

async function stillSendable(database: Database, phoneE164: string): Promise<boolean> {
  if (await resolveVerifiedChannelByPhone(database, phoneE164)) return true;
  return (await loadOpenSession(database, phoneE164)) !== null;
}

/** The held text, from the family ledger, else from an intake transcript of the number. */
async function resolveHeldText(database: Database, row: HeldRow): Promise<HeldText | null> {
  const [message] = await database
    .select({
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
        language: (await loadOpenSession(database, phoneE164))?.ladderLanguage ?? null,
        authorUserId: message.parentUserId,
        familyId: message.familyId,
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
    })
    .from(schema.smsIntakeSessions)
    .where(eq(schema.smsIntakeSessions.phoneHash, row.phoneHash))
    .orderBy(
      sql`${schema.smsIntakeSessions.closedAt} is not null`,
      desc(schema.smsIntakeSessions.createdAt),
    );
  for (const candidate of sessions) {
    const data = readTranscript(candidate.dataEncrypted);
    if (!data) continue;
    const entry = data.transcript.find(
      (line) => line.direction === 'in' && line.providerId === row.providerMessageId,
    );
    if (!entry) continue;
    const phoneE164 = decryptString(candidate.phoneEncrypted);
    return {
      phoneE164,
      language: data.ladderLanguage,
      authorUserId: candidate.userId,
      familyId: candidate.userId ? candidate.familyId : null,
      // No chat: a late confirmation always goes one-to-one.
      inbound: {
        from: phoneE164,
        body: entry.body,
        providerId: row.providerMessageId,
        receivedAt: new Date(entry.at),
        transport: entry.channel ?? 'sms',
      },
    };
  }
  return null;
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
  const [session] = await database
    .select({ id: schema.smsIntakeSessions.id })
    .from(schema.smsIntakeSessions)
    .where(
      and(
        eq(schema.smsIntakeSessions.phoneHash, phoneHash),
        isNull(schema.smsIntakeSessions.closedAt),
      ),
    )
    .limit(1);
  return session !== undefined;
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
    await repointLegacyHold(database, now, result, row).catch((err: unknown) => {
      console.error(
        { urgent: true, outcome: 'legacy_failed', err: errName(err) },
        'URGENT: opt-out recovery: a legacy hold could not be re-pointed - left standing',
      );
      result.legacyFailed += 1;
    });
  }
}

async function repointLegacyHold(
  database: Database,
  now: Date,
  result: OptOutRecoveryResult,
  row: typeof schema.optOutReadHolds.$inferSelect,
): Promise<void> {
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
    return;
  }
  const settled = row.heldAt.getTime() <= now.getTime() - HELD_MESSAGE_SETTLE_MS;
  if (settled && !(await numberReachable(database, row.phoneHash))) {
    await deleteLegacyHold(database, row.phoneHash);
    result.legacyNoChannel += 1;
    return;
  }
  result.legacyUnpointed += 1;
}

async function deleteLegacyHold(database: Database, phoneHash: string): Promise<void> {
  await database
    .delete(schema.optOutReadHolds)
    .where(eq(schema.optOutReadHolds.phoneHash, phoneHash));
}

/** Every text from this number since `since`: from the ledger and from every intake
 * transcript of the number, open or closed. */
async function inboundIdsSince(
  database: Database,
  phoneHash: string,
  since: Date,
): Promise<string[]> {
  // The ledger names a user, not the number a text came from. A user's text counts as
  // this number's when one of their holdings of it was open when it was sent, including
  // the intake that became them, whose texts were replayed with their own times.
  const timeline = await numberHolderTimeline(database, phoneHash);
  const people = [
    ...new Set(timeline.flatMap((holding) => (holding.userId ? [holding.userId] : []))),
  ];
  const ledger =
    people.length === 0
      ? []
      : await database
          .select({
            id: schema.channelMessages.providerMessageId,
            userId: schema.channelMessages.parentUserId,
            sentAt: schema.channelMessages.sentAt,
          })
          .from(schema.channelMessages)
          .where(
            and(
              inArray(schema.channelMessages.parentUserId, people),
              eq(schema.channelMessages.direction, 'in'),
              inArray(schema.channelMessages.channel, ['sms', 'imessage']),
              gte(schema.channelMessages.sentAt, since),
              isNotNull(schema.channelMessages.providerMessageId),
            ),
          );
  const fromThisNumber = ledger.filter((text) => {
    const sentAt = text.sentAt;
    return (
      sentAt !== null &&
      timeline.some((holding) => holding.userId === text.userId && covers(holding, sentAt))
    );
  });
  const sessions = await database
    .select({ dataEncrypted: schema.smsIntakeSessions.dataEncrypted })
    .from(schema.smsIntakeSessions)
    .where(eq(schema.smsIntakeSessions.phoneHash, phoneHash));
  const transcript = sessions.flatMap(
    (session) =>
      readTranscript(session.dataEncrypted)
        ?.transcript.filter(
          (entry) => entry.direction === 'in' && Date.parse(entry.at) >= since.getTime(),
        )
        .map((entry) => entry.providerId) ?? [],
  );
  return [
    ...new Set(
      [...fromThisNumber.map((text) => text.id), ...transcript].filter((id): id is string =>
        Boolean(id),
      ),
    ),
  ];
}
