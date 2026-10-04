import { type Database, schema } from '@hale/db';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { findRevokedChannelOwner } from '~/lib/channel/intake/channel-state';
import { KNOWN_VENUE_HELLO } from '~/lib/channel/intake/cold-start/copy';
import { FIRST_TOUCH_SMS_BY_LANGUAGE, venueForCode } from '~/lib/channel/intake/copy';
import { placeFromVenue } from '~/lib/channel/intake/first-touch-place';
import { type FriendVoiceComposer, speakFriend } from '~/lib/channel/intake/friend-voice';
import { onboardingFriendVoiceEnabled } from '~/lib/channel/intake/friend-voice-flag';
import {
  appendTranscript,
  decodeIntakeTranscript,
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
import { FOUNDER_PAIR_SESSION_IDS } from './sitting-reminder';

/**
 * VIL-332 — one same-day first-hello for an inbound that created a session
 * with last_provider_id and then left no outbound.
 *
 * Not VIL-324's 8am Still here. That reminder is next-morning only and too
 * late for a parent who just texted. The resend is the first-touch ladder,
 * never greeting(). A known venue gets the venue hello and parks on ages.
 * Everyone else gets the postal ask and parks on awaiting_place. Friend voice
 * on writes that line. Never SITTING_SESSION_REMINDER.
 *
 * Pre-family outbound lives on the session transcript, not channel_messages
 * (family_id is NOT NULL on the ledger). "No outbound" means no transcript
 * `out` row. A session Hale already spoke on is skipped.
 *
 * Send path is createOutboundTransport (Linq). Claim BEFORE send so
 * two hourly ticks cannot double. Cap 1. Founder-pair skip list is the same
 * two ids VIL-324 already refuses.
 */

const MAX_FIRST_REPLY_RECOVERIES_PER_RUN = 50;

export interface FirstReplyRecoveryDeps {
  /** The outbound text leg — REQUIRED (rule #11). The real adapter is Linq. */
  transport: ChannelTransport;
  /** Friend-voice postal ask. Absent when the flag is on sends nothing canned. */
  friendVoice?: FriendVoiceComposer;
}

export interface FirstReplyRecoveryResult {
  evaluated: number;
  sent: number;
  skipped: number;
  failed: number;
}

export interface FirstReplyRecoveryRow {
  state: string;
  closedAt: Date | null;
  firstReplyRecoveredAt: Date | null;
  familyId: string | null;
  lastProviderId: string | null;
  hasOutbound: boolean;
}

export function firstReplyRecoveryEligible(row: FirstReplyRecoveryRow): boolean {
  if (row.state !== 'awaiting_details') return false;
  if (row.closedAt !== null) return false;
  if (row.firstReplyRecoveredAt !== null) return false;
  if (row.familyId !== null) return false;
  if (!row.lastProviderId) return false;
  if (row.hasOutbound) return false;
  return true;
}

export function defaultFirstReplyRecoveryDeps(): FirstReplyRecoveryDeps {
  return { transport: createOutboundTransport() };
}

export async function runFirstReplyRecoveryCron(
  database: Database,
  deps: FirstReplyRecoveryDeps = defaultFirstReplyRecoveryDeps(),
  now: Date = new Date(),
): Promise<FirstReplyRecoveryResult> {
  const result: FirstReplyRecoveryResult = { evaluated: 0, sent: 0, skipped: 0, failed: 0 };

  const candidates = await loadFirstReplyCandidates(database);
  for (const row of candidates.slice(0, MAX_FIRST_REPLY_RECOVERIES_PER_RUN)) {
    if (FOUNDER_PAIR_SESSION_IDS.has(row.id)) {
      await claimFirstReplyRecovery(database, row.id, now);
      result.skipped += 1;
      continue;
    }
    const transcript = decodeIntakeTranscript(row.dataEncrypted);
    if (
      !firstReplyRecoveryEligible({
        state: row.state,
        closedAt: row.closedAt,
        firstReplyRecoveredAt: row.firstReplyRecoveredAt,
        familyId: row.familyId,
        lastProviderId: row.lastProviderId,
        hasOutbound: transcriptHasOutbound(transcript),
      })
    ) {
      result.skipped += 1;
      continue;
    }
    result.evaluated += 1;
    if (!(await claimFirstReplyRecovery(database, row.id, now))) {
      result.skipped += 1;
      continue;
    }

    try {
      const phoneE164 = decryptString(row.phoneEncrypted);
      if (await findRevokedChannelOwner(database, phoneE164)) {
        result.skipped += 1;
        continue;
      }
      const language = languageFromTranscript(transcript);
      const inbound = [...transcript].reverse().find((entry) => entry.direction === 'in');
      const venuePlace = recoveryVenuePlace(row.sourceCode);
      const body = await firstTouchRecoveryBody(
        deps.friendVoice,
        language,
        inbound?.body ?? '',
        venuePlace,
      );
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

async function firstTouchRecoveryBody(
  composer: FriendVoiceComposer | undefined,
  language: ReplyLanguage,
  parentWords: string,
  venuePlace: ReturnType<typeof placeFromVenue>,
): Promise<string> {
  const knownVenue = venuePlace != null;
  if (!onboardingFriendVoiceEnabled()) {
    return knownVenue ? KNOWN_VENUE_HELLO[language] : FIRST_TOUCH_SMS_BY_LANGUAGE[language];
  }
  const spoken = await speakFriend(composer, {
    step: knownVenue ? 'ages' : 'place',
    language,
    address: 'tu',
    introduce: !knownVenue,
    parentWords,
    recentTurns: [],
    placeLabel: knownVenue ? venuePlace.city || venuePlace.areaCoarse : null,
    agesLabel: null,
    ageMonths: [],
    findLines: [],
    listKind: 'none',
    activity: null,
    day: null,
    parentName: null,
  });
  return spoken.body;
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

async function loadFirstReplyCandidates(database: Database): Promise<FirstReplyCandidate[]> {
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
        eq(schema.smsIntakeSessions.state, 'awaiting_details'),
        isNotNull(schema.smsIntakeSessions.lastProviderId),
      ),
    )
    .limit(MAX_FIRST_REPLY_RECOVERIES_PER_RUN);
}

async function claimFirstReplyRecovery(
  database: Database,
  sessionId: string,
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
        eq(schema.smsIntakeSessions.state, 'awaiting_details'),
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
  const language = languageFromTranscript(session.transcript);
  const venuePlace = recoveryVenuePlace(session.sourceCode);
  await saveSession(
    database,
    session,
    {
      state: venuePlace ? 'awaiting_ages' : 'awaiting_place',
      ladderLanguage: language,
      firstTouch: session.firstTouch ?? {
        language,
        place: venuePlace,
        locationRequest: null,
      },
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
