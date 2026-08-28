import { type Database, schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';
import { findRevokedChannelOwner } from '~/lib/channel/intake/channel-state';
import { SITTING_SESSION_REMINDER } from '~/lib/channel/intake/copy';
import { appendTranscript, loadOpenSession, saveSession } from '~/lib/channel/intake/session';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { TwilioSendError, createTwilioTransport } from '~/lib/channel/twilio/transport';
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
 * Clock (Designer lock): 8:00 America/Toronto the morning AFTER the session
 * opened. Not 9:00. Not a 24-hour offset. Not a family-local hour — these rows
 * are still intakes and have no family timezone. The hourly cron matches the
 * whole 8:00 hour so a tick a minute late still lands.
 *
 * Send path is the existing intake Twilio transport (Hale's number / Messaging
 * Service). No second SMS stack. No family is minted.
 */

export const SITTING_REMINDER_TIMEZONE = 'America/Toronto';
export const SITTING_REMINDER_HOUR_LOCAL = 8;

const MAX_SITTING_REMINDERS_PER_RUN = 50;

export interface SittingReminderDeps {
  /** The outbound SMS leg — REQUIRED (rule #11). The real adapter is Hale's Twilio number. */
  transport: ChannelTransport;
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
  familyId: string | null;
  createdAt: Date;
}

/** Whether `now` sits in the locked 8:00 America/Toronto hour. */
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
 * is the locked 8:00 Toronto hour on the morning after first-hello.
 */
export function sittingSessionEligible(row: SittingSessionRow, now: Date): boolean {
  if (row.state !== 'awaiting_details') return false;
  if (row.closedAt !== null) return false;
  if (row.sittingReminderSentAt !== null) return false;
  if (row.familyId !== null) return false;
  if (!isSittingReminderSlot(now)) return false;
  return isNextTorontoMorning(row.createdAt, now);
}

export function defaultSittingReminderDeps(): SittingReminderDeps {
  return { transport: createTwilioTransport() };
}

export async function runSittingReminderCron(
  database: Database,
  deps: SittingReminderDeps = defaultSittingReminderDeps(),
  now: Date = new Date(),
): Promise<SittingReminderResult> {
  const result: SittingReminderResult = { evaluated: 0, sent: 0, skipped: 0, failed: 0 };
  if (!isSittingReminderSlot(now)) return result;

  const candidates = await loadSittingCandidates(database);
  for (const row of candidates.slice(0, MAX_SITTING_REMINDERS_PER_RUN)) {
    if (!sittingSessionEligible(row, now)) {
      result.skipped += 1;
      continue;
    }
    result.evaluated += 1;
    if (!(await claimSittingReminder(database, row.id, now))) {
      result.skipped += 1;
      continue;
    }

    try {
      const phoneE164 = decryptString(row.phoneEncrypted);
      if (await findRevokedChannelOwner(database, phoneE164)) {
        result.skipped += 1;
        continue;
      }
      const { providerMessageId } = await deps.transport.send({
        to: phoneE164,
        body: SITTING_SESSION_REMINDER,
      });
      await recordSittingReminderOutbound(database, phoneE164, providerMessageId, now);
      result.sent += 1;
    } catch (err) {
      if (err instanceof TwilioSendError && err.permanent) {
        result.skipped += 1;
        continue;
      }
      await releaseSittingReminder(database, row.id);
      result.failed += 1;
      console.error('sitting reminder send failed', err instanceof Error ? err.message : 'unknown');
    }
  }
  return result;
}

interface SittingCandidate extends SittingSessionRow {
  id: string;
  phoneEncrypted: string;
}

async function loadSittingCandidates(database: Database): Promise<SittingCandidate[]> {
  return database
    .select({
      id: schema.smsIntakeSessions.id,
      phoneEncrypted: schema.smsIntakeSessions.phoneEncrypted,
      state: schema.smsIntakeSessions.state,
      closedAt: schema.smsIntakeSessions.closedAt,
      sittingReminderSentAt: schema.smsIntakeSessions.sittingReminderSentAt,
      familyId: schema.smsIntakeSessions.familyId,
      createdAt: schema.smsIntakeSessions.createdAt,
    })
    .from(schema.smsIntakeSessions)
    .where(
      and(
        isNull(schema.smsIntakeSessions.closedAt),
        isNull(schema.smsIntakeSessions.sittingReminderSentAt),
        eq(schema.smsIntakeSessions.state, 'awaiting_details'),
      ),
    );
}

async function claimSittingReminder(
  database: Database,
  sessionId: string,
  now: Date,
): Promise<boolean> {
  const claimed = await database
    .update(schema.smsIntakeSessions)
    .set({ sittingReminderSentAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.smsIntakeSessions.id, sessionId),
        isNull(schema.smsIntakeSessions.sittingReminderSentAt),
        isNull(schema.smsIntakeSessions.closedAt),
        eq(schema.smsIntakeSessions.state, 'awaiting_details'),
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
): Promise<void> {
  const session = await loadOpenSession(database, phoneE164);
  if (!session) return;
  await saveSession(
    database,
    session,
    {
      transcript: appendTranscript(session, {
        direction: 'out',
        body: SITTING_SESSION_REMINDER,
        providerId: providerMessageId,
        at: now.toISOString(),
      }),
    },
    now,
  );
}
