import { type Database, schema } from '@hale/db';
import { and, asc, eq, gte, or, sql } from 'drizzle-orm';
import { SEND_RETRIES_EXHAUSTED } from '~/lib/channel/config';
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
 *
 * Every try of one ask to one recipient carries the same Linq idempotency key (the base
 * dedupe key). A try that looked failed may still have landed (a timeout, a 5xx, a crash),
 * and a fresh compose has new words, so only the key keeps the parents from reading it twice.
 *
 * A send ends one of two ways: accepted, or dropped with SEND_RETRIES_EXHAUSTED on its last
 * row, an audit row and an #ops page. The plan decides what is offered again, so a send it
 * stops offering is settled by {@link settleStrandedDutySends}.
 */
export const DUTY_SEND_IN_FLIGHT = 'send_in_flight';

export const DUTY_ASK_KEY_PREFIX = 'duty_ask:';
export const DUTY_ACK_KEY_PREFIX = 'linq:duty_ack:';

/** How often the nudge cron runs the duty sweep (apps/web/vercel.json). */
const DUTY_SWEEP_EVERY_MS = 60 * 60_000;
/** A duty key names one local day, so a send older than this has nothing left to settle. */
const STRANDED_LOOKBACK_MS = 48 * DUTY_SWEEP_EVERY_MS;

const UNCONFIRMED_SEND_CODES: ReadonlySet<string> = new Set([
  DUTY_SEND_IN_FLIGHT,
  'timeout',
  'network',
  'missing_message_id',
  'missing_chat_id',
  'unknown',
]);

function failureLabel(code: string | null): 'not_confirmed' | 'send_refused' {
  return code !== null && UNCONFIRMED_SEND_CODES.has(code) ? 'not_confirmed' : 'send_refused';
}

export type DutySendSurface = 'ask' | 'ack';

export type DutySendAttempt =
  /** `dueAt`: when a retry became due. Null on a first try. */
  | { kind: 'try'; dedupeKey: string; attempt: number; dueAt: Date | null }
  | { kind: 'accepted' }
  | { kind: 'in_flight' }
  | { kind: 'wait' }
  | { kind: 'exhausted' };

const SEND_ROW = {
  id: schema.channelMessages.id,
  familyId: schema.channelMessages.familyId,
  parentUserId: schema.channelMessages.parentUserId,
  providerChatId: schema.channelMessages.providerChatId,
  dedupeKey: schema.channelMessages.dedupeKey,
  status: schema.channelMessages.status,
  errorCode: schema.channelMessages.errorCode,
  providerMessageId: schema.channelMessages.providerMessageId,
  createdAt: schema.channelMessages.createdAt,
};

interface DutySendRow {
  id: string;
  familyId: string;
  parentUserId: string;
  providerChatId: string | null;
  dedupeKey: string | null;
  status: string;
  errorCode: string | null;
  providerMessageId: string | null;
  createdAt: Date;
}

const RETRY_INFIX = ':retry:';

/** The unique dedupe index has no status predicate, so each retry needs its own row key. */
export function dutyAttemptKey(baseKey: string, attempt: number): string {
  return attempt === 1 ? baseKey : `${baseKey}${RETRY_INFIX}${attempt - 1}`;
}

function baseKeyOf(dedupeKey: string): string {
  const at = dedupeKey.indexOf(RETRY_INFIX);
  return at === -1 ? dedupeKey : dedupeKey.slice(0, at);
}

export function isLastDutySendTry(attempt: number): boolean {
  return attempt >= COMPOSE_HOLD_MAX_ATTEMPTS;
}

export function dutySendClaim(now: Date) {
  return { status: 'failed', errorCode: DUTY_SEND_IN_FLIGHT, createdAt: now } as const;
}

function attemptFrom(rows: readonly DutySendRow[], baseKey: string, now: Date): DutySendAttempt {
  // A provider id means Linq took the text, even if a later receipt flipped the row to
  // 'failed'. That is a failed delivery, not a refusal, and is never sent again.
  const accepted = rows.some(
    (row) =>
      row.providerMessageId !== null || (SENT_STATUSES as readonly string[]).includes(row.status),
  );
  if (accepted) return { kind: 'accepted' };
  if (rows.some((row) => row.errorCode === SEND_RETRIES_EXHAUSTED)) return { kind: 'exhausted' };
  const running = rows.some(
    (row) =>
      row.errorCode === DUTY_SEND_IN_FLIGHT &&
      now.getTime() - row.createdAt.getTime() <= COMPOSE_HOLD_FIRST_GAP_MS,
  );
  if (running) return { kind: 'in_flight' };
  const failures = rows.filter((row) => row.status === 'failed');
  const last = failures.at(-1);
  if (!last) return { kind: 'try', dedupeKey: baseKey, attempt: 1, dueAt: null };
  const step = nextComposeHold(failures.length - 1, last.createdAt);
  if (step.action === 'exhausted') return { kind: 'exhausted' };
  if (step.nextTryAt.getTime() > now.getTime()) return { kind: 'wait' };
  const attempt = failures.length + 1;
  return {
    kind: 'try',
    dedupeKey: dutyAttemptKey(baseKey, attempt),
    attempt,
    dueAt: step.nextTryAt,
  };
}

export async function readDutySendAttempt(
  database: Database,
  input: { familyId: string; dedupeKey: string; now: Date },
): Promise<DutySendAttempt> {
  const prefix = `${input.dedupeKey}${RETRY_INFIX}`;
  const rows = await database
    .select(SEND_ROW)
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
  return attemptFrom(rows, input.dedupeKey, input.now);
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

interface DutySendFailure {
  familyId: string;
  claimId: string;
  code: string | null;
  attempt: number;
  surface: DutySendSurface;
  /** The adult a send to one person belongs to. Null on a send to the family's group. */
  audience: string | null;
  /** No further try will happen: the row is marked, and the send is dropped. */
  final: boolean;
}

/** Linq's own code stays on the ledger row. The immutable audit row gets the closed label. */
async function recordDutySendFailure(database: Database, input: DutySendFailure): Promise<void> {
  await database.transaction(async (tx) => {
    await tx
      .update(schema.channelMessages)
      .set({ status: 'failed', errorCode: input.final ? SEND_RETRIES_EXHAUSTED : input.code })
      .where(eq(schema.channelMessages.id, input.claimId));
    const audit = {
      familyId: input.familyId,
      actor: 'system',
      targetTable: 'channel_messages',
      targetId: input.claimId,
      audience: input.audience,
      after: {
        surface: input.surface,
        failure: failureLabel(input.code),
        attempts: input.attempt,
        ...(input.final ? { reason: SEND_RETRIES_EXHAUSTED } : {}),
      },
    };
    await tx
      .insert(schema.auditLog)
      .values(
        input.final
          ? { ...audit, actionTaken: 'duty_send_dropped' }
          : { ...audit, actionTaken: 'duty_send_failed' },
      );
  });
  console.error(
    { familyId: input.familyId, surface: input.surface, code: input.code, attempt: input.attempt },
    'duty: send not accepted, not marked sent',
  );
}

export async function settleDutySendFailure(
  database: Database,
  input: DutySendFailure & { pager: OpsPager },
): Promise<void> {
  await recordDutySendFailure(database, input);
  if (!input.final) return;
  await input.pager.page({
    site: 'duty_unsent',
    facts: { surface: input.surface, reason: failureLabel(input.code) },
    count: 1,
  });
}

function isStranded(rows: readonly DutySendRow[], baseKey: string, now: Date): boolean {
  const state = attemptFrom(rows, baseKey, now);
  if (state.kind === 'try') {
    return state.dueAt !== null && now.getTime() > state.dueAt.getTime() + DUTY_SWEEP_EVERY_MS;
  }
  return (
    state.kind === 'exhausted' && !rows.some((row) => row.errorCode === SEND_RETRIES_EXHAUSTED)
  );
}

function keyStartsWith(prefix: string) {
  return sql`left(${schema.channelMessages.dedupeKey}, ${prefix.length}) = ${prefix}`;
}

/**
 * The plan only offers what is still worth saying: a night-before text stops at quiet
 * hours and a parent's direct question is never offered again. A send with a retry due
 * through a whole sweep and no new try was stranded, as was a crash on the last try.
 * Run after the sweep's own sends, so a send it just retried is not counted.
 */
export async function settleStrandedDutySends(
  database: Database,
  input: { now: Date; pager: OpsPager },
): Promise<void> {
  const rows = await database
    .select(SEND_ROW)
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.direction, 'out'),
        gte(schema.channelMessages.createdAt, new Date(input.now.getTime() - STRANDED_LOOKBACK_MS)),
        or(keyStartsWith(DUTY_ASK_KEY_PREFIX), keyStartsWith(DUTY_ACK_KEY_PREFIX)),
      ),
    )
    .orderBy(asc(schema.channelMessages.createdAt));
  const sends = new Map<string, DutySendRow[]>();
  for (const row of rows) {
    if (row.dedupeKey === null) continue;
    const baseKey = baseKeyOf(row.dedupeKey);
    const group = sends.get(baseKey);
    if (group) group.push(row);
    else sends.set(baseKey, [row]);
  }
  const pages = new Map<
    string,
    { surface: DutySendSurface; reason: ReturnType<typeof failureLabel>; count: number }
  >();
  for (const [baseKey, group] of sends) {
    if (!isStranded(group, baseKey, input.now)) continue;
    const failures = group.filter((row) => row.status === 'failed');
    const last = failures.at(-1);
    if (!last) continue;
    const surface: DutySendSurface = baseKey.startsWith(DUTY_ACK_KEY_PREFIX) ? 'ack' : 'ask';
    await recordDutySendFailure(database, {
      familyId: last.familyId,
      claimId: last.id,
      code: last.errorCode,
      attempt: failures.length,
      surface,
      audience: surface === 'ack' || last.providerChatId === null ? last.parentUserId : null,
      final: true,
    });
    const reason = failureLabel(last.errorCode);
    const page = pages.get(`${surface}:${reason}`);
    if (page) page.count += 1;
    else pages.set(`${surface}:${reason}`, { surface, reason, count: 1 });
  }
  for (const { surface, reason, count } of pages.values()) {
    await input.pager.page({ site: 'duty_unsent', facts: { surface, reason }, count });
  }
}
