import { type Database, householdFamilyEvent, schema } from '@hale/db';
import { and, eq, gt, isNull, lte } from 'drizzle-orm';
import { coparentDutyMemoryEnabled } from './flag';

/**
 * VIL-383 metrics, derived from family_events and audit_log.
 * Share of events with a clear owner in the next 24 hours, median time
 * from the ask to the first confirmed owner, and the share of those
 * writes undone within 10 minutes.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const TEN_MIN_MS = 10 * 60 * 1000;

export interface DutyMetrics {
  eventsWithOwner24hAhead: { considered: number; owned: number; share: number | null };
  timeToFirstAnswerMs: number | null;
  undoneWithin10Minutes: { recorded: number; undone: number; share: number | null };
}

interface Recorded {
  factKey: string;
  askedAt: string | null;
  answeredAt: string;
}

interface Undone {
  factKey: string;
  recordedAt: string | null;
  undoneAt: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  return value as Record<string, unknown>;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const left = sorted[mid - 1];
  const right = sorted[mid];
  if (sorted.length % 2 === 1) return right ?? null;
  if (left === undefined || right === undefined) return null;
  return (left + right) / 2;
}

export async function recordDutyAnswered(
  database: Database,
  input: {
    familyId: string;
    actorUserId: string;
    factKey: string;
    now: Date;
    source: string;
    confirmed: boolean;
  },
): Promise<void> {
  if (!coparentDutyMemoryEnabled() || !input.confirmed) return;
  if (typeof database.select !== 'function') return;
  let askedAt: string | null = null;
  const opens = await database
    .select({
      factKey: schema.familyMemoryFacts.factKey,
      factValue: schema.familyMemoryFacts.factValue,
      validFrom: schema.familyMemoryFacts.validFrom,
      familyId: schema.familyMemoryFacts.familyId,
      validUntil: schema.familyMemoryFacts.validUntil,
    })
    .from(schema.familyMemoryFacts)
    .where(
      and(
        eq(schema.familyMemoryFacts.familyId, input.familyId),
        eq(schema.familyMemoryFacts.factKey, 'duty-ask/open'),
        isNull(schema.familyMemoryFacts.validUntil),
      ),
    );
  const open = opens.find(
    (row) => row.familyId === input.familyId && row.factKey === 'duty-ask/open' && !row.validUntil,
  );
  const value = asRecord(open?.factValue);
  if (open && value?.eventKey === input.factKey) askedAt = open.validFrom.toISOString();
  await database.insert(schema.auditLog).values({
    familyId: input.familyId,
    actor: input.actorUserId,
    actionTaken: 'duty_memory_recorded',
    targetTable: 'family_memory_facts',
    targetId: input.familyId,
    after: {
      factKey: input.factKey,
      askedAt,
      answeredAt: input.now.toISOString(),
      source: input.source,
    },
  });
}

export async function recordDutyUndone(
  database: Database,
  input: {
    familyId: string;
    actorUserId: string;
    factKey: string;
    recordedAt: Date | null;
    now: Date;
  },
): Promise<void> {
  if (!coparentDutyMemoryEnabled()) return;
  await database.insert(schema.auditLog).values({
    familyId: input.familyId,
    actor: input.actorUserId,
    actionTaken: 'duty_memory_undone',
    targetTable: 'family_memory_facts',
    targetId: input.familyId,
    after: {
      factKey: input.factKey,
      recordedAt: input.recordedAt ? input.recordedAt.toISOString() : null,
      undoneAt: input.now.toISOString(),
    },
  });
}

export async function loadDutyMetrics(
  database: Database,
  familyId: string,
  now: Date,
): Promise<DutyMetrics> {
  const horizon = new Date(now.getTime() + DAY_MS);
  const events = await database
    .select({
      familyId: schema.familyEvents.familyId,
      startsAt: schema.familyEvents.startsAt,
      deletedAt: schema.familyEvents.deletedAt,
      dutySetAt: schema.familyEvents.dutySetAt,
      dutyOwnerUserId: schema.familyEvents.dutyOwnerUserId,
      dutyOwnerLabel: schema.familyEvents.dutyOwnerLabel,
      dutyOwnerKind: schema.familyEvents.dutyOwnerKind,
    })
    .from(schema.familyEvents)
    .where(
      and(
        eq(schema.familyEvents.familyId, familyId),
        householdFamilyEvent(),
        gt(schema.familyEvents.startsAt, now),
        lte(schema.familyEvents.startsAt, horizon),
      ),
    );
  const upcoming = events.filter(
    (row) =>
      row.familyId === familyId &&
      row.deletedAt === null &&
      row.startsAt.getTime() > now.getTime() &&
      row.startsAt.getTime() <= horizon.getTime(),
  );
  const owned = upcoming.filter(
    (row) => row.dutySetAt !== null && (row.dutyOwnerUserId || row.dutyOwnerLabel || row.dutyOwnerKind),
  );

  const audits = await database
    .select({
      familyId: schema.auditLog.familyId,
      actionTaken: schema.auditLog.actionTaken,
      after: schema.auditLog.after,
    })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.familyId, familyId));
  const recorded: Recorded[] = [];
  const undone: Undone[] = [];
  for (const row of audits) {
    if (row.familyId !== familyId) continue;
    const after = asRecord(row.after);
    if (!after || typeof after.factKey !== 'string') continue;
    if (row.actionTaken === 'duty_memory_recorded' && typeof after.answeredAt === 'string') {
      recorded.push({
        factKey: after.factKey,
        askedAt: typeof after.askedAt === 'string' ? after.askedAt : null,
        answeredAt: after.answeredAt,
      });
    }
    if (row.actionTaken === 'duty_memory_undone' && typeof after.undoneAt === 'string') {
      undone.push({
        factKey: after.factKey,
        recordedAt: typeof after.recordedAt === 'string' ? after.recordedAt : null,
        undoneAt: after.undoneAt,
      });
    }
  }
  const waits = recorded
    .map((row) => {
      if (!row.askedAt) return null;
      const delta = new Date(row.answeredAt).getTime() - new Date(row.askedAt).getTime();
      return Number.isFinite(delta) && delta >= 0 ? delta : null;
    })
    .filter((delta): delta is number => delta !== null);
  const undoneSoon = recorded.filter((row) =>
    undone.some((item) => {
      if (item.factKey !== row.factKey) return false;
      const delta = new Date(item.undoneAt).getTime() - new Date(row.answeredAt).getTime();
      return Number.isFinite(delta) && delta >= 0 && delta <= TEN_MIN_MS;
    }),
  );
  return {
    eventsWithOwner24hAhead: {
      considered: upcoming.length,
      owned: owned.length,
      share: upcoming.length === 0 ? null : owned.length / upcoming.length,
    },
    timeToFirstAnswerMs: median(waits),
    undoneWithin10Minutes: {
      recorded: recorded.length,
      undone: undoneSoon.length,
      share: recorded.length === 0 ? null : undoneSoon.length / recorded.length,
    },
  };
}
