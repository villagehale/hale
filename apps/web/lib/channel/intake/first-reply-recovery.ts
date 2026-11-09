import { type Database, schema } from '@hale/db';
import { and, desc, eq, gte, isNotNull, isNull, lte, or } from 'drizzle-orm';
import { findRevokedChannelOwner } from '~/lib/channel/intake/channel-state';
import { venueForCode } from '~/lib/channel/intake/copy';
import { placeFromVenue } from '~/lib/channel/intake/first-touch-place';
import {
  type FriendVoiceComposer,
  type LastInboundFact,
  createFriendVoiceComposer,
  lastInboundFact,
  pageOncePerDay,
  speakFriend,
  turnsFromTranscript,
} from '~/lib/channel/intake/friend-voice';
import { isSenderHeld } from '~/lib/channel/intake/opt-out-hold';
import {
  type FirstTouchPersisted,
  type TranscriptEntry,
  appendTranscript,
  decodeIntakeForRecovery,
  loadOpenSession,
  placeSettled,
  saveSession,
  transcriptHasOutbound,
  transcriptOwesReply,
} from '~/lib/channel/intake/session';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import type { ReplyLanguage } from '~/lib/channel/language';
import { inProactiveQuietHours } from '~/lib/channel/outbound-gate';
import {
  createOutboundTransport,
  plainTextWithoutLinks,
  readSendRefusal,
  refusalStopsRetry,
  sendResolvingNewChat,
} from '~/lib/channel/outbound-transport';
import { decryptString } from '~/lib/crypto/string-cipher';
import { reportFirstHelloFailure } from '~/lib/monitoring/failure-page';
import {
  type AbortedWindow,
  type ProviderPreflightResult,
  providerPreflight,
} from '~/lib/monitoring/provider-health';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import type { RateLimiter } from '~/lib/rate-limit/limiter';
import { PostgresRateLimiter } from '~/lib/rate-limit/postgres';
import { placeZone } from './sitting-reminder';

/**
 * VIL-332 — one first reply for a new parent whose first text got none.
 *
 * The invariant, owned by code: an open pre-family session whose transcript ends on an
 * inbound is owed one reply, whatever state the turn left it in: the opening text that
 * heard nothing, and a text mid-onboarding whose turn sent nothing (the named
 * `first_touch_unsent`). A text that took the crisis path is never owed an onboarding
 * ask (`TranscriptEntry.crisis`). The
 * transcript is the record (pre-family outbound has no channel_messages row to occupy —
 * family_id is NOT NULL there), so it is what this sweep reads; never a marker a turn
 * writes. `first_reply_recovered_at` is this sweep's claim and nothing else, and only
 * {@link claimFirstReplyRecovery} writes it.
 *
 * Not VIL-324's 8am Still here: that is next-morning only. This runs every minute from
 * the drain, except through proactive quiet hours (21:00–08:00) on the family's own
 * clock, read from the place the session stored, the same zone the sitting reminder
 * uses. A row owed a reply stays owed overnight and is not claimed; the first tick
 * after 08:00 there answers it, and the 24h window still covers a text that arrived
 * late the night before. A session with no postal place has no zone, and none is
 * guessed: its reply answers the text they just sent, whenever the sweep reaches it,
 * and the tick counts it as `zoneUnknownAnswered`.
 * The reply is the first-touch ladder's own step, written by the model when
 * friend voice is on: the ages when a place is known (the silent turn stored one, or the
 * venue gives one), otherwise the place. The brief tells the model how long ago the
 * parent's text was when that wait is real.
 *
 * Claim BEFORE send, so two overlapping ticks cannot double; one send per session.
 */

const MAX_FIRST_REPLY_RECOVERIES_PER_RUN = 50;

/**
 * Rows read per tick. Whether a row is owed lives in the encrypted transcript, so SQL
 * cannot drop the rows Hale already answered and every open session in the window is
 * read; newest first, so at a volume past this the freshest first texts are seen first.
 */
const MAX_FIRST_REPLY_CANDIDATES_PER_TICK = 500;

/**
 * How long a silent first text stays owed a reply. A day: past that, an unprompted
 * opener reads as Hale texting first rather than answering, and the next-morning
 * Still here (sitting-reminder.ts) is the one later touch. An open founder question.
 */
export const FIRST_REPLY_RECOVERY_WINDOW_MS = 24 * 3_600_000;

/**
 * How long a session must have been quiet before the sweep speaks on it. A turn still
 * running inline has not saved its outbound yet; two minutes is past the opening turn's
 * whole model budget (friend-voice.ts OPENING_ATTEMPT_TIMEOUT_MS) and its send. Measured
 * from the row's last write, so a re-text turn that just saved is also left alone, and a
 * released claim waits out the same interval before its retry.
 */
export const FIRST_REPLY_RECOVERY_MIN_AGE_MS = 2 * 60_000;

/**
 * The run's share of the drain tick. The drain's own wall budget leaves about 100 s of
 * the function's ceiling; the sweep stops starting rows past this and leaves the rest
 * owed for the next minute.
 */
export const FIRST_REPLY_RECOVERY_BUDGET_MS = 45_000;

const RECOVERABLE_STATES = ['awaiting_details', 'awaiting_place', 'awaiting_ages'] as const;

export interface FirstReplyRecoveryDeps {
  /** The outbound text leg — REQUIRED (rule #11). The real adapter is Linq. */
  transport: ChannelTransport;
  /** Friend-voice reply. Absent while the flag is on sends nothing canned. */
  friendVoice?: FriendVoiceComposer;
  /** Keeps a row the model keeps failing to one #ops page a day. */
  limiter: RateLimiter;
  /** Asked once per tick, and only when a row is owed a reply. */
  preflight: () => Promise<ProviderPreflightResult>;
}

export interface FirstReplyRecoveryResult {
  evaluated: number;
  sent: number;
  skipped: number;
  failed: number;
  /** Owed rows left for the next tick because this one spent its budget. */
  deferred: number;
  /** The tick did not speak: the provider cannot serve any family right now. */
  held?: AbortedWindow;
  /** VIL-553 · owed rows not claimed because the number has an unread opt-out read. */
  optOutHeld?: number;
  /** Owed rows not claimed because it is night on the family's own clock. Still owed. */
  quietHeld?: number;
  /**
   * Rows answered with no zone to read the night in: the session holds no postal place
   * and none is guessed, so the reply answers the parent's own text whenever it is owed.
   */
  zoneUnknownAnswered?: number;
}

export interface FirstReplyRecoveryRow {
  state: string;
  closedAt: Date | null;
  firstReplyRecoveredAt: Date | null;
  familyId: string | null;
  lastProviderId: string | null;
  /** The transcript ends on an inbound that did not take the crisis path. */
  owesReply: boolean;
}

export function firstReplyRecoveryEligible(row: FirstReplyRecoveryRow): boolean {
  if (!(RECOVERABLE_STATES as readonly string[]).includes(row.state)) return false;
  if (row.closedAt !== null) return false;
  if (row.firstReplyRecoveredAt !== null) return false;
  if (row.familyId !== null) return false;
  if (!row.lastProviderId) return false;
  return row.owesReply;
}

/**
 * The deps every caller runs the sweep with: the same composer the sitting reminder is
 * given, and a pre-flight against the client that composer speaks through.
 */
export function firstReplyRecoveryDeps(
  database: Database,
  now: Date = new Date(),
): FirstReplyRecoveryDeps {
  const client = budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS);
  return {
    transport: createOutboundTransport(),
    limiter: new PostgresRateLimiter(database),
    ...(client ? { friendVoice: createFriendVoiceComposer(client) } : {}),
    preflight: () => providerPreflight(database, 'first_reply_recovery', client, now),
  };
}

/**
 * Quiet hours are the proactive floor, read in the zone the session's own place
 * gives. Inside the window the row is not claimed, so it is still owed when the
 * window ends.
 */
export function firstReplyRecoveryQuiet(now: Date, timeZone: string): boolean {
  return inProactiveQuietHours(now, timeZone);
}

export async function runFirstReplyRecoveryCron(
  database: Database,
  deps: FirstReplyRecoveryDeps,
  now: Date = new Date(),
): Promise<FirstReplyRecoveryResult> {
  const startedMs = Date.now();
  const result: FirstReplyRecoveryResult = {
    evaluated: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    deferred: 0,
  };

  const owed: Array<FirstReplyCandidate & { recovery: RecoveryView; timeZone: string | null }> = [];
  for (const row of await loadFirstReplyCandidates(database, now)) {
    const recovery = decodeIntakeForRecovery(row.dataEncrypted);
    if (
      !firstReplyRecoveryEligible({
        state: row.state,
        closedAt: row.closedAt,
        firstReplyRecoveredAt: row.firstReplyRecoveredAt,
        familyId: row.familyId,
        lastProviderId: row.lastProviderId,
        owesReply: transcriptOwesReply(recovery.transcript),
      })
    ) {
      result.skipped += 1;
      continue;
    }
    const timeZone = placeZone(recoveryPlace(recovery.firstTouch, row.sourceCode));
    if (timeZone !== null && firstReplyRecoveryQuiet(now, timeZone)) {
      result.quietHeld = (result.quietHeld ?? 0) + 1;
      continue;
    }
    if (await isSenderHeld(database, row.phoneHash)) {
      result.optOutHeld = (result.optOutHeld ?? 0) + 1;
      console.info(
        { skipped: 'opt_out_unread' },
        'first-reply recovery: number held - not claimed',
      );
      continue;
    }
    owed.push({ ...row, recovery, timeZone });
    if (owed.length === MAX_FIRST_REPLY_RECOVERIES_PER_RUN) break;
  }
  if (owed.length === 0) return result;

  const preflight = await deps.preflight();
  if (!preflight.proceed) {
    return { ...result, held: { ...preflight.abort, skipped: owed.length } };
  }

  for (const [index, row] of owed.entries()) {
    if (Date.now() - startedMs >= FIRST_REPLY_RECOVERY_BUDGET_MS) {
      result.deferred = owed.length - index;
      break;
    }
    result.evaluated += 1;
    if (!(await claimFirstReplyRecovery(database, row.id, row.state, now))) {
      result.skipped += 1;
      continue;
    }

    try {
      const phoneE164 = decryptString(row.phoneEncrypted);
      if (await findRevokedChannelOwner(database, phoneE164)) {
        result.skipped += 1;
        continue;
      }
      const transcript = row.recovery.transcript;
      const language = row.recovery.ladderLanguage ?? languageFromTranscript(transcript);
      const inbound = [...transcript].reverse().find((entry) => entry.direction === 'in');
      const waited = inbound?.at ? lastInboundFact(new Date(inbound.at), now, row.timeZone) : null;
      const body = await firstTouchRecoveryBody(deps, row.id, {
        language,
        parentWords: inbound?.body ?? '',
        transcript,
        place: recoveryPlace(row.recovery.firstTouch, row.sourceCode),
        placeSettled: recoverySettled(row.recovery.firstTouch, row.sourceCode),
        knownVenue: recoveryVenuePlace(row.sourceCode) != null,
        ...(waited ? { lastInbound: waited } : {}),
      });
      if (!body.trim()) {
        await releaseFirstReplyRecovery(database, row.id);
        result.failed += 1;
        console.error({ reason: 'voice_unsent' }, 'first-reply recovery: reply not sent');
        continue;
      }
      const sent = await sendResolvingNewChat(deps.transport, { to: phoneE164, body });
      const wireBody = sent.linkOmitted ? plainTextWithoutLinks(body) : body;
      await recordFirstReplyOutbound(database, phoneE164, wireBody, sent.providerMessageId, now);
      result.sent += 1;
      if (row.timeZone === null) {
        result.zoneUnknownAnswered = (result.zoneUnknownAnswered ?? 0) + 1;
      }
    } catch (err) {
      await reportFirstHelloFailure(database, {
        sessionId: row.id,
        familyId: row.familyId,
        err,
      });
      const refusal = readSendRefusal(err);
      if (refusalStopsRetry(err)) {
        result.skipped += 1;
        console.error({ code: refusal?.code }, 'first-reply recovery send refused');
        continue;
      }
      await releaseFirstReplyRecovery(database, row.id);
      if (refusal?.code === 'not_configured') {
        result.skipped += 1;
        console.error({ code: refusal.code }, 'first-reply recovery send skipped');
        continue;
      }
      result.failed += 1;
      console.error({ code: refusal?.code ?? 'unknown' }, 'first-reply recovery send failed');
    }
  }
  if (result.zoneUnknownAnswered) {
    console.info(
      { zoneUnknownAnswered: result.zoneUnknownAnswered },
      'first-reply recovery: answered with no zone for the session',
    );
  }
  return result;
}

type RecoveryView = ReturnType<typeof decodeIntakeForRecovery>;
type RecoveryPlace = FirstTouchPersisted['place'];

async function firstTouchRecoveryBody(
  deps: FirstReplyRecoveryDeps,
  sessionId: string,
  input: {
    language: ReplyLanguage | null;
    parentWords: string;
    transcript: readonly TranscriptEntry[];
    place: RecoveryPlace;
    placeSettled: boolean;
    knownVenue: boolean;
    lastInbound?: LastInboundFact;
  },
): Promise<string> {
  // Mid-onboarding, the model reads the thread so far and does not introduce Hale again.
  const spoken = await speakFriend(
    deps.friendVoice,
    {
      step: input.placeSettled ? 'ages' : 'place',
      language: input.language,
      address: 'tu',
      introduce: !transcriptHasOutbound(input.transcript),
      parentWords: input.parentWords,
      ...(input.lastInbound ? { lastInbound: input.lastInbound } : {}),
      recentTurns: turnsFromTranscript(input.transcript),
      placeLabel: input.place ? input.place.city || input.place.areaCoarse : null,
      agesLabel: null,
      ageMonths: [],
      findLines: [],
      listKind: 'none',
      activity: null,
      day: null,
      parentName: null,
    },
    { page: pageOncePerDay(deps.limiter, sessionId) },
  );
  return spoken.body;
}

/** The place the silent turn stored, or the venue the parent walked in from. */
function recoveryPlace(
  touch: FirstTouchPersisted | null,
  sourceCode: string | null,
): RecoveryPlace {
  return touch?.place ?? recoveryVenuePlace(sourceCode);
}

/** A place is stored or venue-given, or the parent declined one: the next ask is the ages. */
function recoverySettled(touch: FirstTouchPersisted | null, sourceCode: string | null): boolean {
  return placeSettled({ place: recoveryPlace(touch, sourceCode), given: touch?.given ?? null });
}

function recoveryVenuePlace(sourceCode: string | null): ReturnType<typeof placeFromVenue> {
  const venue = venueForCode(sourceCode);
  return venue ? placeFromVenue(venue) : null;
}

function languageFromTranscript(
  _transcript: Array<{ direction: 'in' | 'out'; body: string }>,
): ReplyLanguage | null {
  return null;
}

interface FirstReplyCandidate {
  id: string;
  phoneHash: string;
  phoneEncrypted: string;
  state: string;
  closedAt: Date | null;
  firstReplyRecoveredAt: Date | null;
  familyId: string | null;
  lastProviderId: string | null;
  sourceCode: string | null;
  dataEncrypted: string;
}

async function loadFirstReplyCandidates(
  database: Database,
  now: Date,
): Promise<FirstReplyCandidate[]> {
  return database
    .select({
      id: schema.smsIntakeSessions.id,
      phoneHash: schema.smsIntakeSessions.phoneHash,
      phoneEncrypted: schema.smsIntakeSessions.phoneEncrypted,
      state: schema.smsIntakeSessions.state,
      closedAt: schema.smsIntakeSessions.closedAt,
      firstReplyRecoveredAt: schema.smsIntakeSessions.firstReplyRecoveredAt,
      familyId: schema.smsIntakeSessions.familyId,
      lastProviderId: schema.smsIntakeSessions.lastProviderId,
      sourceCode: schema.smsIntakeSessions.sourceCode,
      dataEncrypted: schema.smsIntakeSessions.dataEncrypted,
    })
    .from(schema.smsIntakeSessions)
    .where(
      and(
        isNull(schema.smsIntakeSessions.closedAt),
        isNull(schema.smsIntakeSessions.firstReplyRecoveredAt),
        isNull(schema.smsIntakeSessions.familyId),
        or(...RECOVERABLE_STATES.map((state) => eq(schema.smsIntakeSessions.state, state))),
        isNotNull(schema.smsIntakeSessions.lastProviderId),
        gte(
          schema.smsIntakeSessions.createdAt,
          new Date(now.getTime() - FIRST_REPLY_RECOVERY_WINDOW_MS),
        ),
        lte(
          schema.smsIntakeSessions.updatedAt,
          new Date(now.getTime() - FIRST_REPLY_RECOVERY_MIN_AGE_MS),
        ),
      ),
    )
    .orderBy(desc(schema.smsIntakeSessions.createdAt))
    .limit(MAX_FIRST_REPLY_CANDIDATES_PER_TICK);
}

async function claimFirstReplyRecovery(
  database: Database,
  sessionId: string,
  state: string,
  now: Date,
): Promise<boolean> {
  const claimed = await database
    .update(schema.smsIntakeSessions)
    .set({ firstReplyRecoveredAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.smsIntakeSessions.id, sessionId),
        isNull(schema.smsIntakeSessions.firstReplyRecoveredAt),
        isNull(schema.smsIntakeSessions.closedAt),
        eq(schema.smsIntakeSessions.state, state),
      ),
    )
    .returning({ id: schema.smsIntakeSessions.id });
  return claimed.length > 0;
}

async function releaseFirstReplyRecovery(database: Database, sessionId: string): Promise<void> {
  await database
    .update(schema.smsIntakeSessions)
    .set({ firstReplyRecoveredAt: null })
    .where(eq(schema.smsIntakeSessions.id, sessionId));
}

async function recordFirstReplyOutbound(
  database: Database,
  phoneE164: string,
  body: string,
  providerMessageId: string,
  now: Date,
): Promise<void> {
  const session = await loadOpenSession(database, phoneE164);
  if (!session) {
    console.warn('first-reply recovery: send succeeded but no open session to record outbound');
    return;
  }
  const language = session.ladderLanguage ?? languageFromTranscript(session.transcript);
  const place = recoveryPlace(session.firstTouch, session.sourceCode);
  await saveSession(
    database,
    session,
    {
      state: recoverySettled(session.firstTouch, session.sourceCode)
        ? 'awaiting_ages'
        : 'awaiting_place',
      ladderLanguage: language,
      firstTouch: session.firstTouch
        ? { ...session.firstTouch, place }
        : { language, place, locationRequest: null },
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
