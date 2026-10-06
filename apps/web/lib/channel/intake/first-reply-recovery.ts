import { type Database, schema } from '@hale/db';
import { and, desc, eq, gte, isNotNull, isNull, lte, or } from 'drizzle-orm';
import { findRevokedChannelOwner } from '~/lib/channel/intake/channel-state';
import { KNOWN_VENUE_HELLO } from '~/lib/channel/intake/cold-start/copy';
import { FIRST_TOUCH_SMS_BY_LANGUAGE, venueForCode } from '~/lib/channel/intake/copy';
import { placeFromVenue } from '~/lib/channel/intake/first-touch-place';
import {
  type FriendVoiceComposer,
  createFriendVoiceComposer,
  pageOncePerDay,
  speakFriend,
} from '~/lib/channel/intake/friend-voice';
import { onboardingFriendVoiceEnabled } from '~/lib/channel/intake/friend-voice-flag';
import {
  type FirstTouchPersisted,
  appendTranscript,
  decodeIntakeForRecovery,
  loadOpenSession,
  saveSession,
  transcriptHasOutbound,
} from '~/lib/channel/intake/session';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { type ReplyLanguage, replyLanguage } from '~/lib/channel/language';
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
import { FOUNDER_PAIR_SESSION_IDS } from './sitting-reminder';

/**
 * VIL-332 — one first reply for a new parent whose first text got none.
 *
 * The invariant, owned by code: an open pre-family session whose transcript holds an
 * inbound and no outbound is owed one reply, whatever state the turn left it in. The
 * transcript is the record (pre-family outbound has no channel_messages row to occupy —
 * family_id is NOT NULL there), so it is what this sweep reads; never a marker a turn
 * writes. `first_reply_recovered_at` is this sweep's claim and nothing else, and only
 * {@link claimFirstReplyRecovery} writes it.
 *
 * Not VIL-324's 8am Still here: that is next-morning only. This runs every minute from
 * the drain. The reply is the first-touch ladder's own step, written by the model when
 * friend voice is on: the ages when a place is known (the silent turn stored one, or the
 * venue gives one), otherwise the place.
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
}

export interface FirstReplyRecoveryRow {
  state: string;
  closedAt: Date | null;
  firstReplyRecoveredAt: Date | null;
  familyId: string | null;
  lastProviderId: string | null;
  hasInbound: boolean;
  hasOutbound: boolean;
}

export function firstReplyRecoveryEligible(row: FirstReplyRecoveryRow): boolean {
  if (!(RECOVERABLE_STATES as readonly string[]).includes(row.state)) return false;
  if (row.closedAt !== null) return false;
  if (row.firstReplyRecoveredAt !== null) return false;
  if (row.familyId !== null) return false;
  if (!row.lastProviderId) return false;
  if (!row.hasInbound) return false;
  if (row.hasOutbound) return false;
  return true;
}

/**
 * The deps every caller runs the sweep with: the same composer the sitting reminder is
 * given, and a pre-flight against the client that composer speaks through.
 */
export function firstReplyRecoveryDeps(
  database: Database,
  now: Date = new Date(),
): FirstReplyRecoveryDeps {
  const client = onboardingFriendVoiceEnabled() ? budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS) : null;
  return {
    transport: createOutboundTransport(),
    limiter: new PostgresRateLimiter(database),
    ...(client ? { friendVoice: createFriendVoiceComposer(client) } : {}),
    preflight: () => providerPreflight(database, 'first_reply_recovery', client, now),
  };
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

  const owed: Array<FirstReplyCandidate & { recovery: RecoveryView }> = [];
  for (const row of await loadFirstReplyCandidates(database, now)) {
    if (FOUNDER_PAIR_SESSION_IDS.has(row.id)) {
      await claimFirstReplyRecovery(database, row.id, row.state, now);
      result.skipped += 1;
      continue;
    }
    const recovery = decodeIntakeForRecovery(row.dataEncrypted);
    if (
      !firstReplyRecoveryEligible({
        state: row.state,
        closedAt: row.closedAt,
        firstReplyRecoveredAt: row.firstReplyRecoveredAt,
        familyId: row.familyId,
        lastProviderId: row.lastProviderId,
        hasInbound: recovery.transcript.some((entry) => entry.direction === 'in'),
        hasOutbound: transcriptHasOutbound(recovery.transcript),
      })
    ) {
      result.skipped += 1;
      continue;
    }
    owed.push({ ...row, recovery });
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
      const body = await firstTouchRecoveryBody(deps, row.id, {
        language,
        parentWords: inbound?.body ?? '',
        place: recoveryPlace(row.recovery.firstTouch, row.sourceCode),
        knownVenue: recoveryVenuePlace(row.sourceCode) != null,
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
  return result;
}

type RecoveryView = ReturnType<typeof decodeIntakeForRecovery>;
type RecoveryPlace = FirstTouchPersisted['place'];

async function firstTouchRecoveryBody(
  deps: FirstReplyRecoveryDeps,
  sessionId: string,
  input: {
    language: ReplyLanguage;
    parentWords: string;
    place: RecoveryPlace;
    knownVenue: boolean;
  },
): Promise<string> {
  if (!onboardingFriendVoiceEnabled()) {
    return input.knownVenue
      ? KNOWN_VENUE_HELLO[input.language]
      : FIRST_TOUCH_SMS_BY_LANGUAGE[input.language];
  }
  const placed = input.place != null;
  const spoken = await speakFriend(
    deps.friendVoice,
    {
      step: placed ? 'ages' : 'place',
      language: input.language,
      address: 'tu',
      introduce: true,
      parentWords: input.parentWords,
      recentTurns: [],
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

function recoveryVenuePlace(sourceCode: string | null): ReturnType<typeof placeFromVenue> {
  const venue = venueForCode(sourceCode);
  return venue ? placeFromVenue(venue) : null;
}

function languageFromTranscript(
  transcript: Array<{ direction: 'in' | 'out'; body: string }>,
): ReplyLanguage {
  const inbound = [...transcript].reverse().find((entry) => entry.direction === 'in');
  return inbound ? replyLanguage(inbound.body) : 'en';
}

interface FirstReplyCandidate {
  id: string;
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
      state: place ? 'awaiting_ages' : 'awaiting_place',
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
