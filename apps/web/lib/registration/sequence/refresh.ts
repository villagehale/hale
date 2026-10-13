import { createHash } from 'node:crypto';
import { type Database, schema } from '@hale/db';
import { and, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { f14Allowlist, f14Enabled } from '~/lib/channel/nudge/run';
import type { LiveRegistrationDate, LiveRegistrationReading } from '../live-reading';
import { registrationAnchor, registrationDate, registrationWhen } from '../read';
import { openLegWindows } from './schedule';

export interface RegistrationChange {
  kind: 'earlier' | 'later' | 'unavailable' | 'restored';
  key: string;
  sourceUrl: string;
  previousAt: string | null;
  candidateAt: string | null;
  date: LiveRegistrationDate | null;
  timeZone: string | null;
  status: LiveRegistrationReading['status'];
  notified: boolean;
  reviewCandidate?: RegistrationChange;
}
export function registrationChange(
  value: Record<string, unknown> | null,
): RegistrationChange | null {
  if (
    !value ||
    typeof value.key !== 'string' ||
    typeof value.kind !== 'string' ||
    typeof value.sourceUrl !== 'string'
  )
    return null;
  return value as unknown as RegistrationChange;
}

export function decideRegistrationRefresh(
  state: {
    anchor: Date | null;
    pending: RegistrationChange | null;
    pausedAt: Date | null;
    reviewApproved: boolean;
  },
  reading: LiveRegistrationReading,
  resident: boolean,
  now: Date,
) {
  const date = registrationDate(reading, resident);
  let candidate: Date | null = null;
  if (date) {
    try {
      candidate = registrationAnchor(reading, date);
    } catch {
      /* An impossible wall clock cannot schedule a send. */
    }
  }
  const nextCheckAt = new Date(
    now.getTime() +
      (candidate && candidate.getTime() - now.getTime() > 7 * 86_400_000 ? 24 : 1) * 3_600_000,
  );
  const base = { nextCheckAt, publishedTime: date?.time != null, resetReview: false };
  const review = state.pending?.kind === 'later' ? state.pending : state.pending?.reviewCandidate;
  const change = (kind: RegistrationChange['kind']): RegistrationChange => {
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          kind,
          reading.sourceUrl,
          candidate?.toISOString(),
          date?.time,
          reading.timeZone,
        ]),
      )
      .digest('hex')
      .slice(0, 24);
    if (state.pending?.key === key) return state.pending;
    return {
      kind,
      key,
      sourceUrl: reading.sourceUrl,
      previousAt: state.anchor?.toISOString() ?? null,
      candidateAt: candidate?.toISOString() ?? null,
      date: candidate ? date : null,
      timeZone: reading.timeZone,
      status: reading.status,
      notified: false,
    };
  };
  const hourly = new Date(now.getTime() + 3_600_000);
  if (!candidate)
    return {
      ...base,
      nextCheckAt: hourly,
      anchor: state.anchor,
      paused: true,
      pending: { ...change('unavailable'), ...(review ? { reviewCandidate: review } : {}) },
    };
  // A date-only source does not corroborate the imported midnight scheduling marker.
  if (
    state.anchor &&
    date?.time === null &&
    reading.timeZone &&
    new Intl.DateTimeFormat('en-CA', { timeZone: reading.timeZone }).format(state.anchor) ===
      date.date
  ) {
    return {
      ...base,
      anchor: candidate,
      paused: false,
      pending: state.pausedAt ? change('restored') : null,
      resetReview: !!review,
    };
  }
  if (
    review?.candidateAt === candidate.toISOString() &&
    review.date?.time === date?.time &&
    review.timeZone === reading.timeZone
  ) {
    if (!state.reviewApproved)
      return { ...base, nextCheckAt: hourly, anchor: state.anchor, paused: true, pending: review };
    return {
      ...base,
      anchor: candidate,
      paused: false,
      pending: change('restored'),
      resetReview: true,
    };
  }
  if (state.anchor && candidate > state.anchor)
    return {
      ...base,
      nextCheckAt: hourly,
      anchor: state.anchor,
      paused: true,
      pending: change('later'),
      resetReview: review?.key !== change('later').key,
    };
  if (state.anchor && candidate < state.anchor)
    return {
      ...base,
      anchor: candidate,
      paused: false,
      pending: change('earlier'),
      resetReview: !!review,
    };
  return {
    ...base,
    anchor: candidate,
    paused: false,
    pending: state.pausedAt ? change('restored') : state.pending,
    resetReview: !!review,
  };
}

export async function claimDueRegistrationChecks(database: Database, now: Date): Promise<string[]> {
  const enabled = f14Enabled();
  const families = [...f14Allowlist()];
  if (!enabled && !families.length) return [];
  return database.transaction(async (tx) => {
    const rows = await tx
      .select({ id: schema.registrationSequences.id })
      .from(schema.registrationSequences)
      .where(
        and(
          or(
            isNull(schema.registrationSequences.outcome),
            eq(schema.registrationSequences.outcome, 'waitlisted'),
          ),
          or(
            isNull(schema.registrationSequences.nextCheckAt),
            lte(schema.registrationSequences.nextCheckAt, now),
          ),
          enabled ? undefined : inArray(schema.registrationSequences.familyId, families),
        ),
      )
      .orderBy(
        sql`${schema.registrationSequences.nextCheckAt} ASC NULLS FIRST`,
        schema.registrationSequences.id,
      )
      .limit(24)
      .for('update', { skipLocked: true });
    if (!rows.length) return [];
    await tx
      .update(schema.registrationSequences)
      .set({ nextCheckAt: new Date(now.getTime() + 5 * 60_000) })
      .where(
        inArray(
          schema.registrationSequences.id,
          rows.map((row) => row.id),
        ),
      );
    return rows.map((row) => row.id);
  });
}

/** The locked row rejects obsolete bindings/observations. Scheduling and audit land together. */
export async function refreshRegistrationWatch(
  database: Database,
  input: {
    sequenceId: string;
    reading: LiveRegistrationReading;
    resident: boolean;
    now: Date;
    cachedAnchor?: Date | null;
    parentTimeZone?: string;
  },
): Promise<boolean> {
  if (input.reading.status === 'unreadable' && input.reading.reason === 'read_budget') {
    console.info(
      { sequenceId: input.sequenceId },
      'registration: live read deferred by run budget',
    );
    return false;
  }
  return database.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.registrationSequences)
      .where(eq(schema.registrationSequences.id, input.sequenceId))
      .for('update');
    if (
      !row ||
      (row.courseUrl !== null && row.courseUrl !== input.reading.sourceUrl) ||
      (row.lastReadAt && row.lastReadAt > input.reading.checkedAt)
    )
      return false;
    let reviewApproved = false;
    if (row.dateReviewActionId) {
      const [action] = await tx
        .select({ executedAt: schema.actions.executedAt, revertedAt: schema.actions.revertedAt })
        .from(schema.actions)
        .where(
          and(
            eq(schema.actions.id, row.dateReviewActionId),
            eq(schema.actions.familyId, row.familyId),
          ),
        );
      reviewApproved =
        action?.executedAt !== null &&
        action?.executedAt !== undefined &&
        action.revertedAt === null;
    }
    const decision = decideRegistrationRefresh(
      {
        anchor: row.courseOpensAt ?? input.cachedAnchor ?? null,
        pending: registrationChange(row.pendingChange),
        pausedAt: row.pausedAt,
        reviewApproved,
      },
      input.reading,
      input.resident,
      input.now,
    );
    if (
      decision.resetReview &&
      row.dateReviewActionId &&
      !(reviewApproved && !decision.paused && decision.pending?.kind === 'restored')
    ) {
      // Invalidate even an already-queued YES when its candidate changed.
      await tx
        .update(schema.actions)
        .set({
          revertedAt: input.now,
          revertedReason: 'registration_date_changed',
          userVisibleState: 'reverted',
        })
        .where(eq(schema.actions.id, row.dateReviewActionId));
    }
    await tx
      .update(schema.registrationSequences)
      .set({
        courseUrl: input.reading.sourceUrl,
        courseOpensAt: decision.anchor,
        lastReading: { ...input.reading, checkedAt: input.reading.checkedAt.toISOString() },
        lastReadAt: input.reading.checkedAt,
        nextCheckAt: decision.nextCheckAt,
        pausedAt: decision.paused ? (row.pausedAt ?? input.now) : null,
        pendingChange: decision.pending ? { ...decision.pending } : null,
        dateReviewActionId: decision.resetReview ? null : row.dateReviewActionId,
        updatedAt: input.now,
      })
      .where(eq(schema.registrationSequences.id, row.id));
    const oldAnchor = row.courseOpensAt ?? input.cachedAnchor;
    if (
      decision.anchor &&
      oldAnchor &&
      !decision.paused &&
      oldAnchor.getTime() !== decision.anchor.getTime()
    ) {
      for (const kind of ['registration_plan', 'registration_watch'] as const) {
        const dueAt = (anchor: Date) =>
          kind === 'registration_watch'
            ? anchor
            : openLegWindows(anchor, input.parentTimeZone ?? 'America/Toronto').battle_plan.until;
        await tx
          .update(schema.agentCommitments)
          .set({ dueAt: dueAt(decision.anchor) })
          .where(
            and(
              eq(schema.agentCommitments.familyId, row.familyId),
              eq(schema.agentCommitments.commitmentKind, kind),
              eq(schema.agentCommitments.dueAt, dueAt(oldAnchor)),
              isNull(schema.agentCommitments.fulfilledAt),
              isNull(schema.agentCommitments.cancelledAt),
            ),
          );
      }
    }
    await tx.insert(schema.auditLog).values({
      familyId: row.familyId,
      actor: 'system',
      actionTaken: 'registration_watch_refreshed',
      targetTable: 'registration_sequences',
      targetId: row.id,
      before: { anchor: row.courseOpensAt?.toISOString() ?? null },
      after: {
        status: input.reading.status,
        anchor: decision.anchor?.toISOString() ?? null,
        paused: decision.paused,
        changeKey: decision.pending?.key ?? null,
        sourceUrl: input.reading.sourceUrl,
        evidence: registrationDate(input.reading, input.resident)?.evidence ?? [],
      },
      occurredAt: input.now,
    });
    return true;
  });
}

export function registrationChangeBody(change: RegistrationChange): string {
  const when = change.date
    ? registrationWhen({ timeZone: change.timeZone } as LiveRegistrationReading, change.date)
    : null;
  if (change.kind === 'unavailable')
    return `I couldn't verify a current registration date. Date reminders are paused; I'll check again in an hour. ${change.sourceUrl}`;
  if (change.kind === 'later')
    return `The registration page now says ${when}, later than before. Old date reminders are paused. Confirm the new date in your approvals; I'll recheck the page before resuming. ${change.sourceUrl}`;
  return `The registration page now says ${when}. ${change.kind === 'earlier' ? 'I moved your reminder schedule earlier.' : 'Date reminders can resume.'} ${change.sourceUrl}`;
}

/** Expiring per-sequence lease; ledger dedupe still owns successfully sent stages. */
export async function claimRegistrationSend(
  database: Database,
  sequenceId: string,
  now: Date,
): Promise<number | null> {
  const token = Math.floor(now.getTime() / 1000) + 240;
  const [row] = await database
    .insert(schema.rateLimits)
    .values({
      identifier: sequenceId,
      route: 'registration:send',
      windowStart: new Date(0),
      count: token,
    })
    .onConflictDoUpdate({
      target: [
        schema.rateLimits.identifier,
        schema.rateLimits.route,
        schema.rateLimits.windowStart,
      ],
      set: { count: token },
      setWhere: lte(schema.rateLimits.count, Math.floor(now.getTime() / 1000)),
    })
    .returning({ count: schema.rateLimits.count });
  if (!row) return null;
  // Round-robin bounded scans, including already-sent stages, rather than starving later rows.
  await database
    .update(schema.registrationSequences)
    .set({ updatedAt: now })
    .where(eq(schema.registrationSequences.id, sequenceId));
  return row.count;
}

export async function releaseRegistrationSend(
  database: Database,
  sequenceId: string,
  token: number,
): Promise<void> {
  await database
    .delete(schema.rateLimits)
    .where(
      and(
        eq(schema.rateLimits.identifier, sequenceId),
        eq(schema.rateLimits.route, 'registration:send'),
        eq(schema.rateLimits.count, token),
      ),
    );
}
