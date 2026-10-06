import { type Database, schema } from '@hale/db';
import { and, eq, isNull, or } from 'drizzle-orm';
import { findRevokedChannelOwner } from '~/lib/channel/intake/channel-state';
import { SITTING_SESSION_REMINDER } from '~/lib/channel/intake/copy';
import { type FriendVoiceComposer, speakFriend } from '~/lib/channel/intake/friend-voice';
import { onboardingFriendVoiceEnabled } from '~/lib/channel/intake/friend-voice-flag';
import {
  type IntakeSession,
  appendTranscript,
  loadOpenSession,
  saveSession,
} from '~/lib/channel/intake/session';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { PROACTIVE_QUIET_HOURS } from '~/lib/channel/outbound-gate';
import {
  createOutboundTransport,
  readSendRefusal,
  refusalStopsRetry,
  sendResolvingNewChat,
} from '~/lib/channel/outbound-transport';
import { decryptString } from '~/lib/crypto/string-cipher';
import { localParts } from '~/lib/loop/prefs';
import { dayKeyIn } from '~/lib/plan/spine';

/**
 * VIL-324 — one next-morning SMS for a first-hello that sat in awaiting_details.
 *
 * Not the same-thread followUpCount machine. That ask fires in the conversation
 * when details are incomplete, cap 1. This is a later, scheduled text for a
 * session that never came back.
 *
 * Clock (Advisor + GTM lock): the NEXT America/Toronto calendar morning, at the
 * existing proactive morning window (`PROACTIVE_QUIET_HOURS.end` = 08:00). Not
 * 24 hours later to the minute — an 8:25pm / 9:28pm first-hello must not get a
 * 10pm next-night ping. Not an invented 9:00. Not a family-local hour — these
 * rows are still intakes and have no family timezone. The hourly cron matches
 * the whole morning hour so a tick a minute late still lands.
 *
 * Send path is createOutboundTransport (Linq). No second text stack. No family
 * is minted. No family metrics.
 */

function localHourFromHm(hm: string): number {
  const hour = Number(hm.split(':')[0]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error(`sitting reminder: invalid morning window: ${hm}`);
  }
  return hour;
}

export const SITTING_REMINDER_TIMEZONE = 'America/Toronto';
export const SITTING_REMINDER_HOUR_LOCAL = localHourFromHm(PROACTIVE_QUIET_HOURS.end);

/**
 * GTM lock 2026-08-28 — tonight's founder pair already got a text (Claude may
 * have hit Twilio raw; Hale's ledger is empty). Do not send Still here to these
 * two. Claim the reminder so a later tick stays quiet. Everyone else still sitting
 * gets the locked line at 8:00 America/Toronto.
 */
export const FOUNDER_PAIR_SESSION_IDS: ReadonlySet<string> = new Set([
  '605b0577-cd64-4a6b-91c7-821ca6ceca00',
  '69310ee5-528d-4824-a2aa-27a853df4612',
]);

const MAX_SITTING_REMINDERS_PER_RUN = 50;

export interface SittingReminderDeps {
  /** The outbound text leg — REQUIRED (rule #11). The real adapter is Linq. */
  transport: ChannelTransport;
  /**
   * Friend-voice nudge. Absent, or a compose that fails, sends nothing canned.
   */
  friendVoice?: FriendVoiceComposer;
}

export interface SittingReminderResult {
  evaluated: number;
  sent: number;
  skipped: number;
  failed: number;
}

export interface SittingSessionRow {
  state: string;
  closedAt: Date | null;
  sittingReminderSentAt: Date | null;
  firstReplyRecoveredAt: Date | null;
  familyId: string | null;
  createdAt: Date;
}

/** Whether `now` sits in the locked Toronto morning hour (quiet-hours end). */
export function isSittingReminderSlot(now: Date): boolean {
  return (
    Math.floor(localParts(now, SITTING_REMINDER_TIMEZONE).minutes / 60) ===
    SITTING_REMINDER_HOUR_LOCAL
  );
}

/** Whether `now` is a later America/Toronto calendar day than first-hello. */
export function isNextTorontoMorning(createdAt: Date, now: Date): boolean {
  return dayKeyIn(now, SITTING_REMINDER_TIMEZONE) > dayKeyIn(createdAt, SITTING_REMINDER_TIMEZONE);
}

/**
 * Pure gate. Sitting sessions stay intakes: a provisioned family, a closed row,
 * STOP, a completed flow, or an already-claimed reminder all refuse. The clock
 * is the existing Toronto morning window the calendar morning after first-hello.
 */
export function sittingSessionEligible(row: SittingSessionRow, now: Date): boolean {
  if (row.state !== 'awaiting_details') return false;
  if (row.closedAt !== null) return false;
  if (row.sittingReminderSentAt !== null) return false;
  if (row.familyId !== null) return false;
  if (!isSittingReminderSlot(now)) return false;
  // VIL-332: a same-run recovery first-hello must not also get Still here.
  // Clock the reminder from the first-hello that actually left, when we know it.
  if (row.firstReplyRecoveredAt && !isNextTorontoMorning(row.firstReplyRecoveredAt, now)) {
    return false;
  }
  return isNextTorontoMorning(row.createdAt, now);
}

/**
 * VIL-413. One next-morning nudge for a parent stuck on the postal code or the
 * ages. Same clock as the details reminder. One claim, so it cannot repeat.
 * Flag off: these states are not candidates.
 */
export function firstTouchNudgeEligible(row: SittingSessionRow, now: Date): boolean {
  if (row.state !== 'awaiting_place' && row.state !== 'awaiting_ages') return false;
  if (row.closedAt !== null) return false;
  if (row.sittingReminderSentAt !== null) return false;
  if (row.familyId !== null) return false;
  if (!isSittingReminderSlot(now)) return false;
  return isNextTorontoMorning(row.createdAt, now);
}

/**
 * One next-morning nudge after the find, while the parent has not picked.
 * Same clock as the other sitting nudges. One claim, so it cannot repeat.
 */
export function findNudgeEligible(row: SittingSessionRow, now: Date): boolean {
  if (row.state !== 'awaiting_cold_start') return false;
  if (row.closedAt !== null) return false;
  if (row.sittingReminderSentAt !== null) return false;
  if (row.familyId === null) return false;
  if (!isSittingReminderSlot(now)) return false;
  return isNextTorontoMorning(row.createdAt, now);
}

export function defaultSittingReminderDeps(): SittingReminderDeps {
  return { transport: createOutboundTransport() };
}

export async function runSittingReminderCron(
  database: Database,
  deps: SittingReminderDeps = defaultSittingReminderDeps(),
  now: Date = new Date(),
): Promise<SittingReminderResult> {
  const result: SittingReminderResult = { evaluated: 0, sent: 0, skipped: 0, failed: 0 };
  if (!isSittingReminderSlot(now)) return result;

  const friend = onboardingFriendVoiceEnabled();
  const candidates = await loadSittingCandidates(
    database,
    friend
      ? ['awaiting_details', 'awaiting_place', 'awaiting_ages', 'awaiting_cold_start']
      : ['awaiting_details'],
  );
  for (const row of candidates.slice(0, MAX_SITTING_REMINDERS_PER_RUN)) {
    if (FOUNDER_PAIR_SESSION_IDS.has(row.id)) {
      await claimSittingReminder(database, row.id, now, row.state);
      result.skipped += 1;
      continue;
    }
    const nudge = friend && (firstTouchNudgeEligible(row, now) || findNudgeEligible(row, now));
    if (!nudge && !sittingSessionEligible(row, now)) {
      result.skipped += 1;
      continue;
    }
    result.evaluated += 1;
    if (!(await claimSittingReminder(database, row.id, now, row.state))) {
      result.skipped += 1;
      continue;
    }

    try {
      const phoneE164 = decryptString(row.phoneEncrypted);
      if (await findRevokedChannelOwner(database, phoneE164)) {
        result.skipped += 1;
        continue;
      }
      const body = friend
        ? await firstTouchNudgeBody(database, phoneE164, row.state, deps.friendVoice)
        : SITTING_SESSION_REMINDER;
      if (body == null) {
        result.skipped += 1;
        continue;
      }
      if (friend && body.trim().length === 0) {
        await releaseSittingReminder(database, row.id);
        result.failed += 1;
        console.error({ reason: 'voice_unsent' }, 'sitting reminder: reply not sent');
        continue;
      }
      const { providerMessageId } = await sendResolvingNewChat(deps.transport, {
        to: phoneE164,
        body,
      });
      await recordSittingReminderOutbound(database, phoneE164, providerMessageId, now, body);
      result.sent += 1;
    } catch (err) {
      const refusal = readSendRefusal(err);
      if (refusalStopsRetry(err)) {
        result.skipped += 1;
        console.error({ code: refusal?.code }, 'sitting reminder send refused');
        continue;
      }
      await releaseSittingReminder(database, row.id);
      if (refusal?.code === 'not_configured') {
        result.skipped += 1;
        console.error({ code: refusal.code }, 'sitting reminder send skipped');
        continue;
      }
      result.failed += 1;
      console.error({ code: refusal?.code ?? 'unknown' }, 'sitting reminder send failed');
    }
  }
  return result;
}

interface SittingCandidate extends SittingSessionRow {
  id: string;
  phoneEncrypted: string;
}

async function loadSittingCandidates(
  database: Database,
  states: readonly string[],
): Promise<SittingCandidate[]> {
  return database
    .select({
      id: schema.smsIntakeSessions.id,
      phoneEncrypted: schema.smsIntakeSessions.phoneEncrypted,
      state: schema.smsIntakeSessions.state,
      closedAt: schema.smsIntakeSessions.closedAt,
      sittingReminderSentAt: schema.smsIntakeSessions.sittingReminderSentAt,
      firstReplyRecoveredAt: schema.smsIntakeSessions.firstReplyRecoveredAt,
      familyId: schema.smsIntakeSessions.familyId,
      createdAt: schema.smsIntakeSessions.createdAt,
    })
    .from(schema.smsIntakeSessions)
    .where(
      and(
        isNull(schema.smsIntakeSessions.closedAt),
        isNull(schema.smsIntakeSessions.sittingReminderSentAt),
        states.length === 1
          ? eq(schema.smsIntakeSessions.state, states[0] ?? 'awaiting_details')
          : or(...states.map((state) => eq(schema.smsIntakeSessions.state, state))),
      ),
    );
}

async function claimSittingReminder(
  database: Database,
  sessionId: string,
  now: Date,
  state: string,
): Promise<boolean> {
  const claimed = await database
    .update(schema.smsIntakeSessions)
    .set({ sittingReminderSentAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.smsIntakeSessions.id, sessionId),
        isNull(schema.smsIntakeSessions.sittingReminderSentAt),
        isNull(schema.smsIntakeSessions.closedAt),
        eq(schema.smsIntakeSessions.state, state),
      ),
    )
    .returning({ id: schema.smsIntakeSessions.id });
  return claimed.length > 0;
}

async function releaseSittingReminder(database: Database, sessionId: string): Promise<void> {
  await database
    .update(schema.smsIntakeSessions)
    .set({ sittingReminderSentAt: null })
    .where(eq(schema.smsIntakeSessions.id, sessionId));
}

/** The reminder is an intake outbound: it lives on the session transcript, not a family ledger. */
async function recordSittingReminderOutbound(
  database: Database,
  phoneE164: string,
  providerMessageId: string,
  now: Date,
  body: string,
): Promise<void> {
  const session = await loadOpenSession(database, phoneE164);
  if (!session) return;
  await saveSession(
    database,
    session,
    {
      transcript: appendTranscript(session, {
        direction: 'out',
        body,
        providerId: providerMessageId,
        at: now.toISOString(),
      }),
    },
    now,
  );
}

/**
 * After provisioning, a parent's reply is ledgered on channel_messages rather than the
 * transcript, and moves last_provider_id past the transcript's last inbound — the text
 * that provisioned them.
 */
function repliedSinceFind(session: IntakeSession): boolean {
  const lastInbound = [...session.transcript].reverse().find((entry) => entry.direction === 'in');
  return (lastInbound?.providerId ?? null) !== session.lastProviderId;
}

async function firstTouchNudgeBody(
  database: Database,
  phoneE164: string,
  state: string,
  composer: FriendVoiceComposer | undefined,
): Promise<string | null> {
  const session = await loadOpenSession(database, phoneE164);
  const language = session?.ladderLanguage ?? session?.firstTouch?.language ?? 'en';
  const cold = session?.firstTouch?.coldStart ?? null;
  // Null keeps the claim: there is no find to nudge about, or they already answered it.
  // Empty releases it so a missed model reply can retry the next morning.
  if (state === 'awaiting_cold_start' && (!session || !cold || repliedSinceFind(session))) {
    return null;
  }
  const findLines =
    state === 'awaiting_cold_start' && cold
      ? cold.findBody
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => /^\d+\.\s+/.test(line))
          .map((line) => line.replace(/^\d+\.\s+/, ''))
      : [];
  const spoken = await speakFriend(composer, {
    step:
      state === 'awaiting_ages'
        ? 'nudge_ages'
        : state === 'awaiting_cold_start'
          ? 'nudge_find'
          : 'nudge_place',
    language,
    address: 'tu',
    introduce: false,
    parentWords: '',
    recentTurns: [],
    placeLabel: session?.firstTouch?.place?.city || session?.firstTouch?.place?.areaCoarse || null,
    agesLabel: null,
    ageMonths: [],
    findLines,
    listKind: findLines.length > 0 ? 'year' : 'none',
    activity: cold?.activity ?? null,
    day: cold?.day ?? null,
    parentName: session?.firstTouch?.given?.parentName ?? null,
  });
  return spoken.body;
}
