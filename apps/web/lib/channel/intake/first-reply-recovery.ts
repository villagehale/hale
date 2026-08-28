import { type Database, schema } from '@hale/db';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { findRevokedChannelOwner } from '~/lib/channel/intake/channel-state';
import { greeting, venueForCode } from '~/lib/channel/intake/copy';
import {
  appendTranscript,
  decodeIntakeTranscript,
  loadOpenSession,
  saveSession,
  transcriptHasOutbound,
} from '~/lib/channel/intake/session';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { type ReplyLanguage, replyLanguage } from '~/lib/channel/language';
import { TwilioSendError, createTwilioTransport } from '~/lib/channel/twilio/transport';
import { decryptString } from '~/lib/crypto/string-cipher';
import { FOUNDER_PAIR_SESSION_IDS } from './sitting-reminder';

/**
 * VIL-332 — one same-day first-hello for an inbound that created a session
 * with last_provider_id and then left no outbound.
 *
 * Not VIL-324's 8am Still here. That reminder is next-morning only and too
 * late for a parent who just texted. Copy is greeting() / COLD_START_ASK —
 * the Designer lock, venue variant when the session already has a venue.
 * Never SITTING_SESSION_REMINDER.
 *
 * Pre-family outbound lives on the session transcript, not channel_messages
 * (family_id is NOT NULL on the ledger). "No outbound" means no transcript
 * `out` row. A session Hale already spoke on is skipped.
 *
 * Send path is the existing intake Twilio transport. Claim BEFORE send so
 * two hourly ticks cannot double. Cap 1. Founder-pair skip list is the same
 * two ids VIL-324 already refuses.
 */

const MAX_FIRST_REPLY_RECOVERIES_PER_RUN = 50;

export interface FirstReplyRecoveryDeps {
  /** The outbound SMS leg — REQUIRED (rule #11). The real adapter is Hale's Twilio number. */
  transport: ChannelTransport;
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
  return { transport: createTwilioTransport() };
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
      const body = greeting(venueForCode(row.sourceCode)?.name ?? null, language);
      const { providerMessageId } = await deps.transport.send({ to: phoneE164, body });
      await recordFirstReplyOutbound(database, phoneE164, body, providerMessageId, now);
      result.sent += 1;
    } catch (err) {
      if (err instanceof TwilioSendError && err.permanent) {
        result.skipped += 1;
        continue;
      }
      await releaseFirstReplyRecovery(database, row.id);
      result.failed += 1;
      console.error(
        'first-reply recovery send failed',
        err instanceof Error ? err.message : 'unknown',
      );
    }
  }
  return result;
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
    );
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
