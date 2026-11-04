import { type Database, schema } from '@hale/db';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, sql } from 'drizzle-orm';
import type { CrisisRegion, CrisisSituation, CrisisWho } from '~/lib/channel/crisis-resources';
import { type ResolvedOutbound, sendResolvingNewChat } from '~/lib/channel/outbound-transport';
import type { ReplyLanguage } from '~/lib/channel/language';
import { isParentRole } from '~/lib/channel/role-scope';
import type { threadIfParent } from '~/lib/channel/thread';
import {
  type CrisisKind,
  type CrisisPager,
  type SaidLineWriter,
  crisisReplyLanguage,
  deliverCrisisReply,
  logCrisisUnanswered,
} from '~/lib/channel/voice/said-line';
import { resolveVerifiedChannelByPhone } from '~/lib/channels/sms-consent-core';
import { decryptString } from '~/lib/crypto/string-cipher';
import {
  claimCrisisReply,
  confirmCrisisReply,
  crisisClaimFor,
  crisisReplyState,
  releaseCrisisReply,
} from '~/lib/monitoring/failure-page';
import type { AbortedWindow, ProviderPreflightResult } from '~/lib/monitoring/provider-health';
import { INTAKE_CONTENT_REDACTED } from '~/lib/rights/message-retention';
import { crisisRegionForPlace } from './derive';
import { type Inbound, handleStop, writeChannelMessage } from './machine';
import { releaseHeldMessage } from './opt-out-hold';
import type { OptOutReader, OptOutReading } from './opt-out-reader';
import {
  type IntakeSession,
  type TranscriptEntry,
  appendTranscript,
  decodeIntakeForRecovery,
  loadOpenSession,
  saveSession,
} from './session';
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
 * holder of its number at the time only while they still hold it and the number's owner
 * has done nothing from it since. Then it runs the live stop path ({@link handleStop}) on
 * that number alone.
 *
 * VIL-602 · a text read late as a crisis gets the live crisis reply ({@link
 * deliverCrisisReply}: the same writer, check, re-ask and pager), one-to-one, while the
 * person who sent it still holds the number. When no reply can leave, the crisis pages
 * like a live one (`where late_read`) and the row stays, so a later tick tries the writer
 * again. Once a crisis is recorded for the text it is never read again. A crisis counts as
 * answered only once its reply was SENT, live (router/route.ts) or late: such a text is
 * released without a second reply. A reply still leaving holds it back while its send may
 * still land; one whose send failed, timed out or died is answered late.
 */

export const HELD_READ_OUTCOMES = [
  'stopped',
  'stopped_confirmation_unsent',
  /** Revoked, but the confirmation send threw: kept held and read again. */
  'stopped_confirmation_failed',
  /** Whoever holds the number did something from it after the stop: verified a channel on
   * it (a START writes one) or texted it into a new intake. The newer row wins, nobody is
   * stopped, nothing is sent. */
  'stop_superseded',
  /** The stop path threw before the number stopped being sendable: kept held, retried. */
  'stop_failed',
  'already_stopped',
  'read_not_stop',
  'read_start',
  'read_identity',
  /** Read late as a crisis: the crisis reply went out, one-to-one. */
  'crisis_replied',
  /** Read late as a crisis, and no reply left (writer down, check failed, send threw):
   * paged as a crisis, kept held, tried again. */
  'crisis_unanswered',
  /** Read late as a crisis, but nobody can be replied to on the number (not sendable, or
   * it changed hands): paged as a crisis, released once the page is claimed. */
  'crisis_unreachable',
  /** A crisis reply to this text already left, live or on an earlier tick: released, and
   * nothing is sent again. */
  'crisis_already_answered',
  /** A crisis reply to this text is leaving and its send may still land: kept held,
   * nothing read or sent, and looked at again on the next tick. */
  'crisis_reply_in_flight',
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
  'claimed_elsewhere',
  'crisis_unanswered',
  'crisis_reply_in_flight',
]);

export interface OptOutRecoveryDeps {
  reader: OptOutReader;
  /** The confirmation of a stop, or the reply to a crisis, read late — REQUIRED (rule #11). */
  transport: ChannelTransport;
  /** Writes the reply to a crisis read late — REQUIRED (rule #11). */
  saidLine: SaidLineWriter;
  /** Pages #ops when a crisis read late gets no reply — REQUIRED (rule #11). */
  crisisPager: CrisisPager;
  /** Puts a late crisis reply in a parent's coach thread, which the next turn reads —
   * REQUIRED (rule #11). The ledger stores no outbound body. Only ever a parent's thread. */
  threadMessage: typeof threadIfParent;
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
        { outcome: 'recovery_failed', err: errName(err) },
        'opt-out recovery: a held text could not be settled - kept held; the opt-out hold sweep pages it',
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

export interface HeldText {
  inbound: Inbound;
  phoneE164: string;
  language: IntakeSession['ladderLanguage'];
  /** Who the store says sent it: the ledger's parent, or the user the intake became.
   * Null for an intake that never reached a family. */
  authorUserId: string | null;
  /** The author's family, when there is one. The read's audit row needs it. */
  familyId: string | null;
  /** The crisis lines' country, from a place the store holds; null names both. Never guessed. */
  region: CrisisRegion | null;
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
  // A reply to this text was sent: nothing is read, and nothing is sent again. One still
  // leaving is waited for; one that never left is not a reply.
  const reply = await crisisReplyState(database, row.providerMessageId, now);
  if (reply === 'in_flight') return 'crisis_reply_in_flight';
  if (reply === 'answered') {
    await releaseHeldMessage(database, row.providerMessageId);
    return 'crisis_already_answered';
  }

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

  // A crisis already recorded for this text (live, or on an earlier tick) stays one, and the
  // text is never handed to the model again: the reply is written from what was read then.
  const crisis = await crisisClaimFor(database, row.providerMessageId);
  let outcome: HeldReadOutcome;
  if (crisis) {
    const { language, situation, who } = crisis;
    outcome = await lateCrisis(database, deps, row, held, crisis.kind, {
      language,
      situation,
      who,
    });
  } else {
    const reading = await deps.reader.read({
      text: held.inbound.body,
      language: held.language,
      late: { receivedAt: held.inbound.receivedAt, readAt: now },
    });
    if (reading === null) return 'read_failed';
    outcome = await settleReading(database, deps, row, held, reading);
  }
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
      return lateCrisis(
        database,
        deps,
        row,
        held,
        reading.intent === 'crisis_emergency' ? 'emergency' : 'mental',
        reading,
      );
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
      { outcome: 'timeline_unresolved' },
      'opt-out recovery: a stop read late, but the number timeline cannot say whose it is - kept held, nobody stopped; the opt-out hold sweep pages it',
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
        { outcome: 'stop_failed', err: name },
        'opt-out recovery: stop read late but the stop path failed - kept held; the opt-out hold sweep pages it',
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

const LATE_READ = 'late_read';

/** What a read said about a crisis: on a later tick, what was kept with its claim. */
interface CrisisRead {
  language?: ReplyLanguage | null;
  situation?: CrisisSituation | null;
  who?: CrisisWho | null;
}

/**
 * A held text read late as a crisis. The reply is the live one, written from facts only,
 * sent one-to-one to the number, and only while the person who sent it still holds it.
 * Nobody to reply to: paged, and released once the page is claimed. No reply left:
 * paged, and kept. After a send it is marked answered, then the row goes: nothing sends it again.
 */
async function lateCrisis(
  database: Database,
  deps: OptOutRecoveryDeps,
  row: HeldRow,
  held: HeldText,
  kind: CrisisKind,
  read: CrisisRead,
): Promise<HeldReadOutcome> {
  const language = crisisReplyLanguage(held.language, read);
  const alert = {
    kind,
    where: LATE_READ,
    inboundId: row.providerMessageId,
    familyId: held.familyId,
    parentUserId: held.authorUserId,
    language,
    situation: read.situation ?? null,
    who: read.who ?? null,
  };
  const holder = await lateCrisisHolder(database, row, held);
  if (holder.status !== 'reachable') {
    const page = await logCrisisUnanswered(deps.crisisPager, {
      ...alert,
      reason: holder.status,
      writes: 0,
    });
    return page === 'paged' || page === 'already_paged'
      ? 'crisis_unreachable'
      : 'crisis_unanswered';
  }
  const crisis = await deliverCrisisReply({
    ...alert,
    region: held.region,
    pager: deps.crisisPager,
    writer: deps.saidLine,
  });
  if (crisis.status === 'unanswered') return 'crisis_unanswered';
  // The leaving mark goes first, so a live turn's send and this one never overlap. It counts
  // as answered only once confirmed below; one this tick never confirms goes stale and the
  // text is answered late.
  const claim = await claimCrisisReply(database, row.providerMessageId, deps.now);
  if (claim === 'answered') return 'crisis_already_answered';
  if (claim === 'in_flight') return 'crisis_reply_in_flight';
  let sent: ResolvedOutbound;
  try {
    sent = await sendResolvingNewChat(deps.transport, { to: held.phoneE164, body: crisis.body });
  } catch (err) {
    console.error(
      { outcome: 'crisis_unanswered', err: errName(err) },
      'opt-out recovery: late crisis reply send threw - kept held',
    );
    await logCrisisUnanswered(deps.crisisPager, {
      ...alert,
      reason: 'send_failed',
      writes: crisis.attempts,
    });
    await releaseCrisisReply(database, row.providerMessageId).catch((releaseErr: unknown) => {
      // It goes stale after its lease, and a later tick answers the text then.
      console.error(
        { outcome: 'crisis_unanswered', err: errName(releaseErr) },
        'opt-out recovery: late_crisis_reply_mark_stuck',
      );
    });
    return 'crisis_unanswered';
  }
  // Sent: answered, before the row goes, so a release that throws never sends it again.
  await confirmCrisisReply(database, row.providerMessageId, deps.now).catch((err: unknown) => {
    console.error(
      { outcome: 'crisis_replied', err: errName(err) },
      'opt-out recovery: late_crisis_reply_unconfirmed',
    );
  });
  await releaseHeldMessage(database, row.providerMessageId);
  await recordLateCrisisReply(database, deps, held, holder.then, crisis.body, sent);
  return 'crisis_replied';
}

/** Whether the person who sent the text holds the number now and can still be texted. */
async function lateCrisisHolder(
  database: Database,
  row: HeldRow,
  held: HeldText,
): Promise<
  { status: 'reachable'; then: NumberHolding } | { status: 'not_sendable' | 'holder_changed' }
> {
  const timeline = await numberHolderTimeline(database, row.phoneHash);
  const then = holderAt(timeline, held.inbound.receivedAt);
  const now = currentHolder(timeline);
  if (now === null) return { status: 'not_sendable' };
  if (then === 'ambiguous' || now === 'ambiguous' || then === null) {
    return { status: 'holder_changed' };
  }
  if (held.authorUserId !== null && held.authorUserId !== then.userId) {
    return { status: 'holder_changed' };
  }
  if (!samePerson(then, now)) return { status: 'holder_changed' };
  if (!(await stillSendable(database, held.phoneE164))) return { status: 'not_sendable' };
  return { status: 'reachable', then };
}

/** One person behind both: the same user, or, before anyone is a user, the same holding. */
function samePerson(a: NumberHolding, b: NumberHolding): boolean {
  if (a.userId !== null || b.userId !== null) return a.userId === b.userId;
  return a.kind === b.kind && a.id === b.id;
}

/**
 * The reply's trace, best-effort once it has left: the ledger and the coach thread for a
 * family, else the transcript of the intake that held the number, so the next turn knows
 * a crisis reply went out. A failure here is named and never sends again.
 */
async function recordLateCrisisReply(
  database: Database,
  deps: OptOutRecoveryDeps,
  held: HeldText,
  then: NumberHolding,
  body: string,
  sent: ResolvedOutbound,
): Promise<void> {
  const { now } = deps;
  const channel = sent.transport === 'imessage' ? 'imessage' : 'sms';
  const entry: TranscriptEntry = {
    direction: 'out',
    body,
    providerId: sent.providerMessageId,
    at: now.toISOString(),
    channel,
    chatId: sent.chatId ?? null,
  };
  if (held.familyId && held.authorUserId) {
    const owner = { familyId: held.familyId, parentUserId: held.authorUserId };
    // Read live, as threadIfParent reads it: a parent who left keeps the reply, and the
    // family they left gets no trace of it.
    if (!(await isParentOf(database, owner))) {
      console.info(
        { trace: 'late_crisis_not_recorded_left_family' },
        'opt-out recovery: late crisis reply sent, not recorded - the author is no longer a parent of that family',
      );
      return;
    }
    try {
      await writeChannelMessage(database, owner, entry, now);
    } catch (err) {
      console.error({ err: errName(err) }, 'opt-out recovery: late_crisis_ledger_failed');
    }
    try {
      await deps.threadMessage(database, { ...owner, body });
    } catch (err) {
      console.error({ err: errName(err) }, 'opt-out recovery: late_crisis_thread_failed');
    }
    return;
  }
  try {
    const open = await loadOpenSession(database, held.phoneE164);
    if (!open || then.kind !== 'session' || then.id !== open.id) return;
    await saveSession(database, open, { transcript: appendTranscript(open, entry) }, now);
  } catch (err) {
    console.error({ err: errName(err) }, 'opt-out recovery: late_crisis_transcript_failed');
  }
}

async function isParentOf(
  database: Database,
  owner: { familyId: string; parentUserId: string },
): Promise<boolean> {
  const [member] = await database
    .select({ role: schema.familyMembers.role })
    .from(schema.familyMembers)
    .where(
      and(
        eq(schema.familyMembers.familyId, owner.familyId),
        eq(schema.familyMembers.userId, owner.parentUserId),
      ),
    )
    .limit(1);
  return member !== undefined && isParentRole(member.role);
}

/** One holding of a number: a parent channel until it is revoked, an intake session
 * until it closes, a caregiver invite until it closes, or a guest's reminder opt-in. Only
 * a channel or a session names who holds the number. An invite or an opt-in is a record
 * someone else made about the number; it only scopes what a stop reaches. */
export interface NumberHolding {
  kind: 'channel' | 'session' | 'invite' | 'guest_reminders';
  id: string;
  /** The person behind it. Null for an intake that has not become anyone yet, which is
   * only "whoever texts this number". */
  userId: string | null;
  start: Date;
  /** Null while it still holds the number. */
  end: Date | null;
  /** Made by whoever holds the number, from it: a channel verified on it (a START writes
   * one too) or an intake their own text opened. Only these can outrank their stop. An
   * invite, another person's opt-in, or a number typed into a form and never verified
   * says nothing about what the number's holder wants. */
  ownerMade: boolean;
}

type ChannelRow = Pick<
  typeof schema.parentChannels.$inferSelect,
  'id' | 'userId' | 'verifiedAt' | 'createdAt' | 'revokedAt'
>;

function channelHolding(channel: ChannelRow): NumberHolding {
  return {
    kind: 'channel',
    id: channel.id,
    userId: channel.userId,
    // Every SMS consent grant inserts a fresh row (revoke-then-insert, never an
    // un-revoke), so a verified channel starts at its consent; a pending one when it
    // was asked for.
    start: channel.verifiedAt ?? channel.createdAt,
    end: channel.revokedAt,
    ownerMade: channel.verifiedAt !== null,
  };
}

type SessionRow = Pick<
  typeof schema.smsIntakeSessions.$inferSelect,
  'id' | 'userId' | 'createdAt' | 'closedAt' | 'dataEncrypted'
>;

function sessionHolding(session: SessionRow): NumberHolding {
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
    kind: 'session',
    id: session.id,
    userId: session.userId,
    start: new Date(first),
    end: session.closedAt,
    ownerMade: true,
  };
}

const CHANNEL_HOLDING_COLUMNS = {
  id: schema.parentChannels.id,
  userId: schema.parentChannels.userId,
  verifiedAt: schema.parentChannels.verifiedAt,
  createdAt: schema.parentChannels.createdAt,
  revokedAt: schema.parentChannels.revokedAt,
};

const SESSION_HOLDING_COLUMNS = {
  id: schema.smsIntakeSessions.id,
  userId: schema.smsIntakeSessions.userId,
  createdAt: schema.smsIntakeSessions.createdAt,
  closedAt: schema.smsIntakeSessions.closedAt,
  dataEncrypted: schema.smsIntakeSessions.dataEncrypted,
};

/** Every holding of the number, oldest first. */
export async function numberHolderTimeline(
  database: Database,
  phoneHash: string,
): Promise<NumberHolding[]> {
  const channels = await database
    .select(CHANNEL_HOLDING_COLUMNS)
    .from(schema.parentChannels)
    .where(eq(schema.parentChannels.phoneE164Hash, phoneHash));
  const sessions = await database
    .select(SESSION_HOLDING_COLUMNS)
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
    ...channels.map(channelHolding),
    ...sessions.map(sessionHolding),
    ...invites.map((invite) => ({
      kind: 'invite' as const,
      id: invite.id,
      userId: null,
      start: invite.createdAt,
      end: invite.closedAt,
      ownerMade: false,
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
              ownerMade: false,
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
 * holder when it was sent, and only while that holder still holds it. Only something the
 * number's holder did from it later (see {@link NumberHolding.ownerMade}) supersedes it;
 * a record anyone else made about the number never does, whatever its time, and the stop
 * reaches it instead. A timeline that cannot name one holder, or that disagrees with the
 * store about who sent the text, stops nobody.
 */
export function lateStopVerdict(
  timeline: NumberHolding[],
  receivedAt: Date,
  authorUserId: string | null,
): 'holder' | 'no_holder' | 'superseded' | 'unresolved' {
  if (timeline.length === 0) return 'unresolved';
  if (
    timeline.some((holding) => holding.ownerMade && holding.start.getTime() > receivedAt.getTime())
  ) {
    return 'superseded';
  }
  const then = holderAt(timeline, receivedAt);
  const now = currentHolder(timeline);
  if (then === 'ambiguous' || now === 'ambiguous') return 'unresolved';
  if (then !== null && then.userId !== authorUserId) return 'unresolved';
  if (now === null) return 'no_holder';
  // Nothing the holder made started since, so the same person open now was open then.
  return then?.userId === now.userId ? 'holder' : 'unresolved';
}

async function stillSendable(database: Database, phoneE164: string): Promise<boolean> {
  if (await resolveVerifiedChannelByPhone(database, phoneE164)) return true;
  return (await loadOpenSession(database, phoneE164)) !== null;
}

/** The held text, from the family ledger, else from an intake transcript of the number. */
export async function resolveHeldText(database: Database, row: HeldRow): Promise<HeldText | null> {
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
      // Never families.country_code: it defaults to CA, which would be a guess.
      const [family] = await database
        .select({ postalCode: schema.families.postalCode })
        .from(schema.families)
        .where(eq(schema.families.id, message.familyId))
        .limit(1);
      return {
        phoneE164,
        language: (await loadOpenSession(database, phoneE164))?.ladderLanguage ?? null,
        authorUserId: message.parentUserId,
        familyId: message.familyId,
        region: crisisRegionForPlace([family?.postalCode]),
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
      region: crisisRegionForPlace([
        data.firstTouch?.place?.postalCode,
        data.firstTouch?.place?.areaCoarse,
      ]),
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
        { outcome: 'legacy_failed', err: errName(err) },
        'opt-out recovery: a legacy hold could not be re-pointed - left standing; the opt-out hold sweep pages it',
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
  const { ids, unplaceable } = await inboundIdsSince(database, row.phoneHash, row.heldAt);
  // A row left standing has already held these by message, and a held text that was
  // read is gone, so holding them again would re-read it every tick. Once nothing is
  // left to place, the row goes after one last pass (a repeat read at most once).
  if (ids.length > 0 && (row.repointedAt === null || unplaceable === 0)) {
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
    result.repointed += ids.length;
  }
  if (unplaceable > 0) {
    // A text the ledger cannot place on one number is never guessed onto this one: the
    // row stands for it (fail closed) and the failure-page sweep pages it as legacy.
    if (row.repointedAt === null) {
      await database
        .update(schema.optOutReadHolds)
        .set({ repointedAt: now })
        .where(eq(schema.optOutReadHolds.phoneHash, row.phoneHash));
    }
    result.legacyUnpointed += 1;
    return;
  }
  if (ids.length > 0) {
    await deleteLegacyHold(database, row.phoneHash);
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

/** Every text this number sent since `since`: from the ledger and from every intake
 * transcript of the number, open or closed. `unplaceable` counts the ledger texts left
 * out because their author also held another number then, so either could have sent it;
 * one on this number's own transcript is placed here regardless. */
async function inboundIdsSince(
  database: Database,
  phoneHash: string,
  since: Date,
): Promise<{ ids: string[]; unplaceable: number }> {
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
  // This number's own transcript places a text on it, whatever else its author held.
  const elsewhere = await otherNumberHoldings(database, people, phoneHash);
  const placeable = (text: (typeof fromThisNumber)[number]) =>
    transcript.includes(text.id) ||
    !elsewhere.some(
      (holding) =>
        holding.userId === text.userId && text.sentAt !== null && covers(holding, text.sentAt),
    );
  const placed = fromThisNumber.filter(placeable);
  return {
    ids: [
      ...new Set(
        [...placed.map((text) => text.id), ...transcript].filter((id): id is string => Boolean(id)),
      ),
    ],
    unplaceable: fromThisNumber.length - placed.length,
  };
}

/** These people's channels and intakes on every number but this one. */
async function otherNumberHoldings(
  database: Database,
  people: string[],
  phoneHash: string,
): Promise<NumberHolding[]> {
  if (people.length === 0) return [];
  const channels = await database
    .select(CHANNEL_HOLDING_COLUMNS)
    .from(schema.parentChannels)
    .where(
      and(
        inArray(schema.parentChannels.userId, people),
        ne(schema.parentChannels.phoneE164Hash, phoneHash),
      ),
    );
  const sessions = await database
    .select(SESSION_HOLDING_COLUMNS)
    .from(schema.smsIntakeSessions)
    .where(
      and(
        inArray(schema.smsIntakeSessions.userId, people),
        ne(schema.smsIntakeSessions.phoneHash, phoneHash),
      ),
    );
  return [...channels.map(channelHolding), ...sessions.map(sessionHolding)];
}
