import { type Database, schema } from '@hale/db';
import { and, asc, eq, or, sql } from 'drizzle-orm';
import type { SEND_RETRIES_EXHAUSTED } from '~/lib/channel/config';
import { SENT_STATUSES, acceptedStatus } from '~/lib/channel/ledger';
import {
  COMPOSE_HOLD_FIRST_GAP_MS,
  COMPOSE_HOLD_MAX_ATTEMPTS,
  nextComposeHold,
} from '~/lib/loop/reminders/schedule';
import type { OpsPager } from '~/lib/monitoring/failure-page';

/**
 * A duty row says 'sent' only once Linq has accepted the text. Until then it is a 'failed'
 * row under this code: it holds the dedupe key against a concurrent run, and a crash
 * mid-send leaves a row that claims nothing.
 */
export const DUTY_SEND_IN_FLIGHT = 'send_in_flight';

/**
 * The failures after which Linq may still have taken the text. The next try reuses that
 * send's Linq idempotency key, so a text that did leave comes back as the original rather
 * than reaching the parents twice in new words. After a plain refusal the next try takes
 * its own key, because Linq answers a reused key with its first response.
 */
const UNCONFIRMED_SEND_CODES: ReadonlySet<string> = new Set([
  DUTY_SEND_IN_FLIGHT,
  'timeout',
  'network',
  'missing_message_id',
  'missing_chat_id',
  'unknown',
]);

export function dutySendMayHaveLeft(code: string | null): boolean {
  return code !== null && UNCONFIRMED_SEND_CODES.has(code);
}

export type DutySendSurface = 'ask' | 'ack';

export type DutySendDrop = typeof SEND_RETRIES_EXHAUSTED | 'model_unsent';

export type DutySendAttempt =
  | { kind: 'try'; dedupeKey: string; sendKey: string; attempt: number }
  | { kind: 'accepted' }
  | { kind: 'in_flight' }
  | { kind: 'wait' }
  | { kind: 'exhausted' };

/** The unique dedupe index has no status predicate, so each retry needs its own key. */
export function dutyAttemptKey(baseKey: string, attempt: number): string {
  return attempt === 1 ? baseKey : `${baseKey}:retry:${attempt - 1}`;
}

export function isLastDutySendTry(attempt: number): boolean {
  return attempt >= COMPOSE_HOLD_MAX_ATTEMPTS;
}

export function dutySendClaim(now: Date) {
  return { status: 'failed', errorCode: DUTY_SEND_IN_FLIGHT, createdAt: now } as const;
}

export async function readDutySendAttempt(
  database: Database,
  input: { familyId: string; dedupeKey: string; now: Date },
): Promise<DutySendAttempt> {
  const prefix = `${input.dedupeKey}:retry:`;
  const rows = await database
    .select({
      dedupeKey: schema.channelMessages.dedupeKey,
      status: schema.channelMessages.status,
      errorCode: schema.channelMessages.errorCode,
      providerMessageId: schema.channelMessages.providerMessageId,
      createdAt: schema.channelMessages.createdAt,
    })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, input.familyId),
        or(
          eq(schema.channelMessages.dedupeKey, input.dedupeKey),
          sql`left(${schema.channelMessages.dedupeKey}, ${prefix.length}) = ${prefix}`,
        ),
      ),
    )
    .orderBy(asc(schema.channelMessages.createdAt));
  // A provider id means Linq took the text, even if a later receipt flipped the row to
  // 'failed'. That is a failed delivery, not a refusal, and is never sent again.
  const accepted = rows.some(
    (row) =>
      row.providerMessageId !== null || (SENT_STATUSES as readonly string[]).includes(row.status),
  );
  if (accepted) return { kind: 'accepted' };
  const mid = rows.some(
    (row) =>
      row.errorCode === DUTY_SEND_IN_FLIGHT &&
      input.now.getTime() - row.createdAt.getTime() <= COMPOSE_HOLD_FIRST_GAP_MS,
  );
  if (mid) return { kind: 'in_flight' };
  const failures = rows.filter((row) => row.status === 'failed');
  const last = failures.at(-1);
  if (!last) {
    return { kind: 'try', dedupeKey: input.dedupeKey, sendKey: input.dedupeKey, attempt: 1 };
  }
  const step = nextComposeHold(failures.length - 1, last.createdAt);
  if (step.action === 'exhausted') return { kind: 'exhausted' };
  if (step.nextTryAt.getTime() > input.now.getTime()) return { kind: 'wait' };
  const attempt = failures.length + 1;
  const dedupeKey = dutyAttemptKey(input.dedupeKey, attempt);
  const unconfirmed = failures.find((row) => dutySendMayHaveLeft(row.errorCode));
  return { kind: 'try', dedupeKey, sendKey: unconfirmed?.dedupeKey ?? dedupeKey, attempt };
}

export async function markDutySendAccepted(
  database: Database,
  input: { claimId: string; now: Date; providerMessageId: string | null },
): Promise<void> {
  await database
    .update(schema.channelMessages)
    .set({
      status: acceptedStatus('imessage'),
      errorCode: null,
      sentAt: input.now,
      providerMessageId: input.providerMessageId,
    })
    .where(eq(schema.channelMessages.id, input.claimId));
}

export function defaultDutyPager(database: Database): OpsPager {
  return {
    async page(page) {
      const { pageOps } = await import('~/lib/monitoring/failure-page');
      return pageOps(database, page);
    },
  };
}

/** The row names the failure. A `drop` ends the send: audited as dropped, and #ops paged. */
export async function settleDutySendFailure(
  database: Database,
  input: {
    familyId: string;
    claimId: string;
    code: string;
    attempt: number;
    surface: DutySendSurface;
    now: Date;
    pager: OpsPager;
    drop: DutySendDrop | null;
  },
): Promise<void> {
  await database.transaction(async (tx) => {
    await tx
      .update(schema.channelMessages)
      .set({ status: 'failed', errorCode: input.code })
      .where(eq(schema.channelMessages.id, input.claimId));
    await tx.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: 'system',
      actionTaken: input.drop ? 'duty_send_dropped' : 'duty_send_failed',
      targetTable: 'channel_messages',
      targetId: input.claimId,
      after: {
        surface: input.surface,
        failure: input.code,
        attempts: input.attempt,
        ...(input.drop ? { reason: input.drop } : {}),
      },
    });
  });
  console.error(
    { familyId: input.familyId, surface: input.surface, code: input.code, attempt: input.attempt },
    'duty: send not accepted, not marked sent',
  );
  if (!input.drop) return;
  await input.pager.page({
    site: 'duty_unsent',
    facts: {
      surface: input.surface,
      reason: dutySendMayHaveLeft(input.code) ? 'not_confirmed' : 'send_refused',
    },
    count: 1,
  });
}
