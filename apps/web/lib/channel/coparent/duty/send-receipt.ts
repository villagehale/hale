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

export interface DutySendRow {
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

/**
 * A provider id means Linq took the text, even if a later receipt flipped the row to
 * 'failed'. That is a failed delivery, not a refusal, and is never sent again.
 */
function isAccepted(rows: readonly DutySendRow[]): boolean {
  return rows.some(
    (row) =>
      row.providerMessageId !== null || (SENT_STATUSES as readonly string[]).includes(row.status),
  );
}

/** One door's rows: its key and that key's retries. */
function doorRows(rows: readonly DutySendRow[], doorKey: string): DutySendRow[] {
  const retries = `${doorKey}${RETRY_INFIX}`;
  return rows.filter(
    (row) => row.dedupeKey === doorKey || row.dedupeKey?.startsWith(retries) === true,
  );
}

function attemptFrom(rows: readonly DutySendRow[], baseKey: string, now: Date): DutySendAttempt {
  if (isAccepted(rows)) return { kind: 'accepted' };
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

/** Every row of one ask, through either door: the group (`<key>`) or a 1:1 (`<key>:<parent>`). */
export async function readDutyAskRows(
  database: Database,
  input: { familyId: string; dedupeKey: string },
): Promise<DutySendRow[]> {
  const prefix = `${input.dedupeKey}:`;
  return database
    .select(SEND_ROW)
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, input.familyId),
        or(eq(schema.channelMessages.dedupeKey, input.dedupeKey), keyStartsWith(prefix)),
      ),
    )
    .orderBy(asc(schema.channelMessages.createdAt));
}

export function dutyDoorAccepted(rows: readonly DutySendRow[], doorKey: string): boolean {
  return isAccepted(doorRows(rows, doorKey));
}

export function dutyDoorAttempt(
  rows: readonly DutySendRow[],
  doorKey: string,
  now: Date,
): DutySendAttempt {
  return attemptFrom(doorRows(rows, doorKey), doorKey, now);
}

/** The group door. A 1:1 that already carried this ask ends it here too. */
export async function readDutySendAttempt(
  database: Database,
  input: { familyId: string; dedupeKey: string; now: Date },
): Promise<DutySendAttempt> {
  const rows = await readDutyAskRows(database, input);
  if (isAccepted(rows)) return { kind: 'accepted' };
  return dutyDoorAttempt(rows, input.dedupeKey, input.now);
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

function isStranded(
  rows: readonly DutySendRow[],
  baseKey: string,
  now: Date,
  offered: ReadonlySet<string>,
): boolean {
  const state = attemptFrom(rows, baseKey, now);
  if (state.kind === 'exhausted') {
    return !rows.some((row) => row.errorCode === SEND_RETRIES_EXHAUSTED);
  }
  if (state.kind !== 'try' || state.dueAt === null) return false;
  // Still planned: a hold or a model outage kept this sweep's try from leaving.
  if ([...offered].some((key) => baseKey === key || baseKey.startsWith(`${key}:`))) return false;
  return now.getTime() > state.dueAt.getTime() + DUTY_SWEEP_EVERY_MS;
}

function keyStartsWith(prefix: string) {
  return sql`left(${schema.channelMessages.dedupeKey}, ${prefix.length}) = ${prefix}`;
}

/**
 * The plan only offers what is still worth saying: a night-before text stops at quiet
 * hours and a parent's direct question is never offered again. A send with a retry due
 * through a whole sweep, that this sweep did not offer (`offered`: the asks it planned),
 * was stranded, as was a crash on the last try. Run after the sweep's own sends.
 */
export async function settleStrandedDutySends(
  database: Database,
  input: { now: Date; pager: OpsPager; offered: ReadonlySet<string> },
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
  const acceptedKeys = [...sends].filter(([, group]) => isAccepted(group)).map(([key]) => key);
  const carriedByOtherDoor = (key: string) =>
    acceptedKeys.some((done) => done.startsWith(`${key}:`) || key.startsWith(`${done}:`));
  let dropped = 0;
  let surface: DutySendSurface = 'ack';
  let reason: ReturnType<typeof failureLabel> = 'send_refused';
  for (const [baseKey, group] of sends) {
    if (carriedByOtherDoor(baseKey)) continue;
    if (!isStranded(group, baseKey, input.now, input.offered)) continue;
    const failures = group.filter((row) => row.status === 'failed');
    const last = failures.at(-1);
    if (!last) continue;
    const rowSurface: DutySendSurface = baseKey.startsWith(DUTY_ACK_KEY_PREFIX) ? 'ack' : 'ask';
    await recordDutySendFailure(database, {
      familyId: last.familyId,
      claimId: last.id,
      code: last.errorCode,
      attempt: failures.length,
      surface: rowSurface,
      audience: rowSurface === 'ack' || last.providerChatId === null ? last.parentUserId : null,
      final: true,
    });
    dropped += 1;
    if (rowSurface === 'ask') surface = 'ask';
    if (failureLabel(last.errorCode) === 'not_confirmed') reason = 'not_confirmed';
  }
  // One page: #ops claims this site once an hour, so a second would be swallowed.
  if (dropped > 0) {
    await input.pager.page({ site: 'duty_unsent', facts: { surface, reason }, count: dropped });
  }
}
