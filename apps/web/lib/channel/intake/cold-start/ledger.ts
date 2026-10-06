/**
 * VIL-392 — the shared optional-ask ledger.
 *
 * Flag off is an allow that does not read. This file does not import the duty
 * ask module: the stop-asking fact key is duplicated and pinned equal in a test.
 */

import { type Database, schema } from '@hale/db';
import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import {
  type AskBudgetVerdict,
  type AskLedgerRow,
  type OptionalAskClass,
  SHARED_STOP_ASKING_KEY,
  judgeAskBudget,
  localCalendarDay,
  pauseAnchor,
} from './budget';
import { coldStartLadderEnabled } from './flags';

export interface OptionalAskGate {
  familyId: string;
  now: Date;
  sendClass: OptionalAskClass;
  askKey: string;
  timeZone?: string;
  env?: Record<string, string | undefined>;
  /** Name, calendar, and email in one sitting. Skips the one-a-day cap. */
  onboardingSequence?: boolean;
}

export async function gateOptionalAsk(
  database: Database,
  input: OptionalAskGate,
): Promise<AskBudgetVerdict & { skipped?: 'flag_off' }> {
  if (!coldStartLadderEnabled(input.env)) return { allow: true, skipped: 'flag_off' };
  const [family] = await database
    .select({ createdAt: schema.families.createdAt })
    .from(schema.families)
    .where(eq(schema.families.id, input.familyId))
    .limit(1);
  if (!family) {
    console.info({ reason: 'family_missing', familyId: input.familyId }, 'optional ask: no family');
    return { allow: false, reason: 'ask_budget' };
  }
  const familyStartedAt = family.createdAt instanceof Date ? family.createdAt : input.now;
  const stored = await database
    .select()
    .from(schema.optionalAskLedger)
    .where(eq(schema.optionalAskLedger.familyId, input.familyId))
    .orderBy(asc(schema.optionalAskLedger.createdAt));
  const rows = stored.map(toRow);
  const stopUntil = await readStopUntil(database, input.familyId);
  const anchor = pauseAnchor(rows, input.now);
  const parentWroteSincePause = anchor
    ? await parentWroteAfterPause(database, input.familyId, anchor)
    : false;
  return judgeAskBudget(
    {
      now: input.now,
      familyStartedAt,
      rows,
      stopUntil,
      parentWroteSincePause,
      ...(input.timeZone ? { timeZone: input.timeZone } : {}),
    },
    { sendClass: input.sendClass, askKey: input.askKey },
    input.onboardingSequence ? { onboardingSequence: true } : undefined,
  );
}

export async function recordOptionalAsk(
  database: Database,
  input: OptionalAskGate,
): Promise<{ recorded: true } | { recorded: false; skipped: 'flag_off' }> {
  if (!coldStartLadderEnabled(input.env)) return { recorded: false, skipped: 'flag_off' };
  await database.insert(schema.optionalAskLedger).values({
    familyId: input.familyId,
    sendClass: input.sendClass,
    askKey: input.askKey,
    outcome: 'sent',
    localDay: localCalendarDay(input.now, input.timeZone),
    createdAt: input.now,
  });
  return { recorded: true };
}

export async function declineOptionalAsk(
  database: Database,
  input: { familyId: string; askKey: string; env?: Record<string, string | undefined> },
): Promise<{ updated: true } | { updated: false; skipped: 'flag_off' | 'not_sent' }> {
  if (!coldStartLadderEnabled(input.env)) return { updated: false, skipped: 'flag_off' };
  const [row] = await database
    .select({ id: schema.optionalAskLedger.id })
    .from(schema.optionalAskLedger)
    .where(
      and(
        eq(schema.optionalAskLedger.familyId, input.familyId),
        eq(schema.optionalAskLedger.askKey, input.askKey),
        eq(schema.optionalAskLedger.outcome, 'sent'),
      ),
    )
    .limit(1);
  if (!row) return { updated: false, skipped: 'not_sent' };
  await database
    .update(schema.optionalAskLedger)
    .set({ outcome: 'declined' })
    .where(eq(schema.optionalAskLedger.id, row.id));
  return { updated: true };
}

async function readStopUntil(database: Database, familyId: string): Promise<Date | null> {
  const [fact] = await database
    .select({ factValue: schema.familyMemoryFacts.factValue })
    .from(schema.familyMemoryFacts)
    .where(
      and(
        eq(schema.familyMemoryFacts.familyId, familyId),
        eq(schema.familyMemoryFacts.factKey, SHARED_STOP_ASKING_KEY),
        isNull(schema.familyMemoryFacts.validUntil),
      ),
    )
    .limit(1);
  return stopUntil(fact?.factValue);
}

/**
 * Two inbounds after the pause anchor means a later text, not only the
 * decline that closed the second ask.
 */
async function parentWroteAfterPause(
  database: Database,
  familyId: string,
  anchor: Date,
): Promise<boolean> {
  const inbound = await database
    .select({ id: schema.channelMessages.id })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, familyId),
        eq(schema.channelMessages.direction, 'in'),
        gt(schema.channelMessages.createdAt, anchor),
      ),
    )
    .limit(2);
  return inbound.length >= 2;
}

function toRow(row: typeof schema.optionalAskLedger.$inferSelect): AskLedgerRow {
  return {
    sendClass: row.sendClass as AskLedgerRow['sendClass'],
    askKey: row.askKey,
    outcome: row.outcome === 'declined' ? 'declined' : 'sent',
    localDay: row.localDay,
    createdAt: row.createdAt,
  };
}

function stopUntil(value: unknown): Date | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as { kind?: string; until?: string };
  if (row.kind !== 'duty_stop_asking' || typeof row.until !== 'string') return null;
  const until = new Date(row.until);
  return Number.isFinite(until.getTime()) ? until : null;
}
