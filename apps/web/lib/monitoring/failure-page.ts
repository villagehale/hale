import { type Database, schema } from '@hale/db';
import { and, asc, eq, gt, gte, lt, sql } from 'drizzle-orm';
import { readSendRefusal } from '~/lib/channel/outbound-transport';
import { type OpsPageOutcome, postOpsSlack } from '~/lib/monitoring/ops-slack';

/**
 * VIL-404 — page Slack #ops when a text turn fails or a new parent's first
 * hello never leaves.
 *
 * Two sms_turn_failed rows (broke_after_answering) on 2026-10-01 were invisible:
 * the ledger had them and nothing was watching it. VIL-315 described the same
 * hole for a first hello that 500'd before any family existed. Twilio is gone;
 * Linq is the only phone door, and the page goes to #ops (postOpsSlack), the
 * same helper the delivery and webhook alarms use. No founder phone.
 *
 * What is alerted, and only that:
 *   - an audit_log row whose action is `sms_turn_failed` (every TurnFailureReason,
 *     including broke_after_answering)
 *   - a first hello whose send threw (the greet, a sitting session that still
 *     has no outbound, or the same-day recovery sweep)
 * The text carries a family id (or `none` when the hello failed before a family
 * existed), an intake session id for that pre-family case, and an error
 * category from a closed vocabulary. It never carries message content, a phone
 * number, or an error message — those can echo a parent's own words.
 *
 * Dedup is a rate_limits claim, not an update of the audit row (audit_log is
 * append-only). One subject, one route, window_start at the epoch, so the
 * unique index is the lock:
 *   - turns: identifier is the sms_turn_failed audit row id. The audit row is
 *     the failure; the claim is only the "already paged" mark (count = 1).
 *   - first hellos: there is no audit row yet (family_id is NOT NULL and the
 *     session has no family). The claim row IS the failure record. identifier
 *     is `<session uuid>:<category>`. count 0 is unalerted, 1 is paged.
 * A claim is taken before the post (count = unix seconds) and set to 1 only
 * after Slack accepts. A refused post puts the claim back, so the next sweep
 * retries. A claim still in progress after two minutes is treated as a crash
 * and released the same way. The sweep looks back seven days, which is long
 * enough to cover the 2026-10-01 rows and short of a family's whole history.
 */

/** Same data value wiring.ts writes. A test pins the two spellings together. */
export const TURN_FAILED_AUDIT_ACTION = 'sms_turn_failed';

export const TURN_FAILURE_PAGE_ROUTE = 'ops:turn-failed';
export const FIRST_HELLO_PAGE_ROUTE = 'ops:first-hello';

/** Seven days: the turn ledger's own lookback, and past pg-boss's retry budget. */
export const FAILURE_PAGE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/** A claim left at a unix-second stamp for this long is a crashed poster. */
const STALE_CLAIM_MS = 2 * 60 * 1000;

/** count = 1 means Slack accepted. Anything larger is an in-progress stamp. */
const ALERTED_COUNT = 1;
const UNALERTED_COUNT = 0;

const MAX_PER_RUN = 50;

/** Fixed window so the unique index dedupes a subject instead of a clock bucket. */
const CLAIM_EPOCH = new Date(0);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface FailurePageCounts {
  posted: number;
  deduped: number;
  failed: number;
}

export interface FailurePageResult {
  turns: FailurePageCounts;
  firstHellos: FailurePageCounts;
}

export interface FailurePageDeps {
  post?: (text: string) => Promise<OpsPageOutcome>;
  now?: Date;
}

/**
 * A category safe to put in Slack and in a rate_limits key. Letters, digits,
 * underscores. A run of 7+ digits is a phone-shaped leak (a provider code is
 * shorter) and becomes `redacted` rather than travelling.
 */
export function failureCategory(value: string): string {
  if (/\d{7,}/.test(value)) return 'redacted';
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  if (!cleaned || /\d{7,}/.test(cleaned)) return 'redacted';
  return cleaned;
}

/** Linq's code when the throw is one, otherwise the error's name. Never its message. */
export function firstHelloFailureCategory(err: unknown): string {
  const refusal = readSendRefusal(err);
  if (refusal) return failureCategory(refusal.code);
  if (err instanceof Error && err.name) return failureCategory(err.name);
  return 'unknown';
}

function uuidOr(value: string | null, fallback: string): string {
  if (value !== null && UUID_RE.test(value)) return value;
  return fallback;
}

export function composeTurnFailureAlert(input: {
  familyId: string;
  category: string;
  messageId: string | null;
}): string {
  const parts = [
    'Hale: text turn failed.',
    `family ${uuidOr(input.familyId, 'invalid')}.`,
    `category ${failureCategory(input.category)}.`,
  ];
  if (input.messageId && UUID_RE.test(input.messageId)) {
    parts.push(`message ${input.messageId}.`);
  }
  return parts.join(' ');
}

export function composeFirstHelloFailureAlert(input: {
  familyId: string | null;
  sessionId: string;
  category: string;
}): string {
  return [
    'Hale: first hello failed.',
    `family ${uuidOr(input.familyId, 'none')}.`,
    `session ${uuidOr(input.sessionId, 'invalid')}.`,
    `category ${failureCategory(input.category)}.`,
  ].join(' ');
}

function emptyCounts(): FailurePageCounts {
  return { posted: 0, deduped: 0, failed: 0 };
}

function claimStamp(now: Date): number {
  return Math.floor(now.getTime() / 1000);
}

function helloIdentifier(sessionId: string, category: string): string {
  return `${sessionId}:${category}`;
}

function parseHelloIdentifier(identifier: string): { sessionId: string; category: string } | null {
  const split = identifier.indexOf(':');
  if (split <= 0) return null;
  const sessionId = identifier.slice(0, split);
  const category = identifier.slice(split + 1);
  if (!UUID_RE.test(sessionId) || !category) return null;
  return { sessionId, category: failureCategory(category) };
}

async function releaseStaleClaims(database: Database, now: Date): Promise<void> {
  const staleBefore = claimStamp(new Date(now.getTime() - STALE_CLAIM_MS));
  await database
    .delete(schema.rateLimits)
    .where(
      and(
        eq(schema.rateLimits.route, TURN_FAILURE_PAGE_ROUTE),
        eq(schema.rateLimits.windowStart, CLAIM_EPOCH),
        gt(schema.rateLimits.count, ALERTED_COUNT),
        lt(schema.rateLimits.count, staleBefore),
      ),
    );
  await database
    .update(schema.rateLimits)
    .set({ count: UNALERTED_COUNT })
    .where(
      and(
        eq(schema.rateLimits.route, FIRST_HELLO_PAGE_ROUTE),
        eq(schema.rateLimits.windowStart, CLAIM_EPOCH),
        gt(schema.rateLimits.count, ALERTED_COUNT),
        lt(schema.rateLimits.count, staleBefore),
      ),
    );
}

async function claimInsert(
  database: Database,
  route: string,
  identifier: string,
  stamp: number,
): Promise<boolean> {
  const inserted = await database
    .insert(schema.rateLimits)
    .values({
      identifier,
      route,
      windowStart: CLAIM_EPOCH,
      count: stamp,
    })
    .onConflictDoNothing({
      target: [
        schema.rateLimits.identifier,
        schema.rateLimits.route,
        schema.rateLimits.windowStart,
      ],
    })
    .returning({ id: schema.rateLimits.id });
  return inserted.length > 0;
}

async function claimHello(database: Database, identifier: string, stamp: number): Promise<boolean> {
  const claimed = await database
    .update(schema.rateLimits)
    .set({ count: stamp })
    .where(
      and(
        eq(schema.rateLimits.route, FIRST_HELLO_PAGE_ROUTE),
        eq(schema.rateLimits.identifier, identifier),
        eq(schema.rateLimits.windowStart, CLAIM_EPOCH),
        eq(schema.rateLimits.count, UNALERTED_COUNT),
      ),
    )
    .returning({ id: schema.rateLimits.id });
  return claimed.length > 0;
}

async function finishClaim(
  database: Database,
  route: string,
  identifier: string,
  stamp: number,
  posted: boolean,
): Promise<void> {
  if (posted) {
    await database
      .update(schema.rateLimits)
      .set({ count: ALERTED_COUNT })
      .where(
        and(
          eq(schema.rateLimits.route, route),
          eq(schema.rateLimits.identifier, identifier),
          eq(schema.rateLimits.windowStart, CLAIM_EPOCH),
          eq(schema.rateLimits.count, stamp),
        ),
      );
    return;
  }
  if (route === FIRST_HELLO_PAGE_ROUTE) {
    await database
      .update(schema.rateLimits)
      .set({ count: UNALERTED_COUNT })
      .where(
        and(
          eq(schema.rateLimits.route, route),
          eq(schema.rateLimits.identifier, identifier),
          eq(schema.rateLimits.windowStart, CLAIM_EPOCH),
          eq(schema.rateLimits.count, stamp),
        ),
      );
    return;
  }
  await database
    .delete(schema.rateLimits)
    .where(
      and(
        eq(schema.rateLimits.route, route),
        eq(schema.rateLimits.identifier, identifier),
        eq(schema.rateLimits.windowStart, CLAIM_EPOCH),
        eq(schema.rateLimits.count, stamp),
      ),
    );
}

interface TurnCandidate {
  id: string;
  familyId: string;
  messageId: string | null;
  category: string;
  occurredAt: Date | null;
}

function asTurnCandidate(row: Record<string, unknown>): TurnCandidate | null {
  if (row.actionTaken !== undefined && row.actionTaken !== TURN_FAILED_AUDIT_ACTION) return null;
  if (typeof row.id !== 'string' || typeof row.familyId !== 'string') return null;
  let category = 'unknown';
  if (typeof row.reason === 'string') category = row.reason;
  else if (row.after && typeof row.after === 'object' && 'reason' in row.after) {
    const reason = (row.after as { reason: unknown }).reason;
    if (typeof reason === 'string') category = reason;
  }
  const occurredAt = row.occurredAt instanceof Date ? row.occurredAt : null;
  const messageId = typeof row.targetId === 'string' ? row.targetId : null;
  return { id: row.id, familyId: row.familyId, messageId, category, occurredAt };
}

async function loadTurnCandidates(database: Database, now: Date): Promise<TurnCandidate[]> {
  const since = new Date(now.getTime() - FAILURE_PAGE_LOOKBACK_MS);
  const rows = await database
    .select({
      id: schema.auditLog.id,
      familyId: schema.auditLog.familyId,
      targetId: schema.auditLog.targetId,
      actionTaken: schema.auditLog.actionTaken,
      occurredAt: schema.auditLog.occurredAt,
      after: schema.auditLog.after,
      reason: sql<string | null>`${schema.auditLog.after} ->> 'reason'`,
    })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.actionTaken, TURN_FAILED_AUDIT_ACTION),
        gte(schema.auditLog.occurredAt, since),
        sql`not exists (
          select 1 from ${schema.rateLimits}
          where ${schema.rateLimits.identifier} = ${schema.auditLog.id}::text
            and ${schema.rateLimits.route} = ${TURN_FAILURE_PAGE_ROUTE}
            and ${schema.rateLimits.windowStart} = ${CLAIM_EPOCH}
            and ${schema.rateLimits.count} = ${ALERTED_COUNT}
        )`,
      ),
    )
    .orderBy(asc(schema.auditLog.occurredAt))
    .limit(MAX_PER_RUN);

  const candidates: TurnCandidate[] = [];
  for (const row of rows) {
    const candidate = asTurnCandidate(row as unknown as Record<string, unknown>);
    if (!candidate) continue;
    if (candidate.occurredAt && candidate.occurredAt.getTime() < since.getTime()) continue;
    candidates.push(candidate);
  }
  return candidates;
}

async function familyIdForSession(database: Database, sessionId: string): Promise<string | null> {
  const rows = await database
    .select({
      id: schema.smsIntakeSessions.id,
      familyId: schema.smsIntakeSessions.familyId,
    })
    .from(schema.smsIntakeSessions)
    .where(eq(schema.smsIntakeSessions.id, sessionId))
    .limit(1);
  const match = rows.find((row) => row.id === sessionId);
  return match?.familyId ?? null;
}

interface HelloCandidate {
  identifier: string;
  sessionId: string;
  category: string;
}

async function loadHelloCandidates(database: Database): Promise<HelloCandidate[]> {
  const rows = await database
    .select({
      identifier: schema.rateLimits.identifier,
      route: schema.rateLimits.route,
      count: schema.rateLimits.count,
      windowStart: schema.rateLimits.windowStart,
    })
    .from(schema.rateLimits)
    .where(
      and(
        eq(schema.rateLimits.route, FIRST_HELLO_PAGE_ROUTE),
        eq(schema.rateLimits.windowStart, CLAIM_EPOCH),
        eq(schema.rateLimits.count, UNALERTED_COUNT),
      ),
    )
    .limit(MAX_PER_RUN);

  const candidates: HelloCandidate[] = [];
  for (const row of rows) {
    if (row.route !== FIRST_HELLO_PAGE_ROUTE || row.count !== UNALERTED_COUNT) continue;
    const parsed = parseHelloIdentifier(row.identifier);
    if (!parsed) continue;
    candidates.push({ identifier: row.identifier, ...parsed });
    if (candidates.length >= MAX_PER_RUN) break;
  }
  return candidates;
}

async function deliver(
  database: Database,
  route: string,
  identifier: string,
  text: string,
  stamp: number,
  post: (text: string) => Promise<OpsPageOutcome>,
  counts: FailurePageCounts,
): Promise<void> {
  let outcome: OpsPageOutcome;
  try {
    outcome = await post(text);
  } catch (err) {
    console.error('failure page: post threw', {
      route,
      err: err instanceof Error ? err.name : 'unknown',
    });
    outcome = 'failed';
  }
  const posted = outcome === 'sent';
  try {
    await finishClaim(database, route, identifier, stamp, posted);
  } catch (err) {
    console.error('failure page: claim finish threw', {
      route,
      posted,
      err: err instanceof Error ? err.name : 'unknown',
    });
  }
  if (posted) counts.posted += 1;
  else counts.failed += 1;
}

async function pageTurns(
  database: Database,
  post: (text: string) => Promise<OpsPageOutcome>,
  now: Date,
  counts: FailurePageCounts,
): Promise<void> {
  const candidates = await loadTurnCandidates(database, now);
  const stamp = claimStamp(now);
  for (const candidate of candidates) {
    const claimed = await claimInsert(database, TURN_FAILURE_PAGE_ROUTE, candidate.id, stamp);
    if (!claimed) {
      counts.deduped += 1;
      continue;
    }
    const text = composeTurnFailureAlert({
      familyId: candidate.familyId,
      category: candidate.category,
      messageId: candidate.messageId,
    });
    await deliver(database, TURN_FAILURE_PAGE_ROUTE, candidate.id, text, stamp, post, counts);
  }
}

async function pageHellos(
  database: Database,
  post: (text: string) => Promise<OpsPageOutcome>,
  now: Date,
  counts: FailurePageCounts,
): Promise<void> {
  const candidates = await loadHelloCandidates(database);
  const stamp = claimStamp(now);
  for (const candidate of candidates) {
    const claimed = await claimHello(database, candidate.identifier, stamp);
    if (!claimed) {
      counts.deduped += 1;
      continue;
    }
    const familyId = await familyIdForSession(database, candidate.sessionId);
    const text = composeFirstHelloFailureAlert({
      familyId,
      sessionId: candidate.sessionId,
      category: candidate.category,
    });
    await deliver(
      database,
      FIRST_HELLO_PAGE_ROUTE,
      candidate.identifier,
      text,
      stamp,
      post,
      counts,
    );
  }
}

/**
 * Post every unalerted failure once. Never throws: a sweep that escapes would
 * turn the cron red and, on the inline path, a turn that already answered.
 */
export async function pageFailureAlerts(
  database: Database,
  deps: FailurePageDeps = {},
): Promise<FailurePageResult> {
  const now = deps.now ?? new Date();
  const post = deps.post ?? ((text: string) => postOpsSlack(text));
  const result: FailurePageResult = { turns: emptyCounts(), firstHellos: emptyCounts() };
  try {
    await releaseStaleClaims(database, now);
  } catch (err) {
    console.error('failure page: stale claim release threw', {
      err: err instanceof Error ? err.name : 'unknown',
    });
  }
  try {
    await pageTurns(database, post, now, result.turns);
  } catch (err) {
    console.error('failure page: turn sweep threw', {
      err: err instanceof Error ? err.name : 'unknown',
    });
  }
  try {
    await pageHellos(database, post, now, result.firstHellos);
  } catch (err) {
    console.error('failure page: first hello sweep threw', {
      err: err instanceof Error ? err.name : 'unknown',
    });
  }
  return result;
}

/**
 * Remember a first hello that did not leave, then page it (and any other
 * unalerted failure). One session records one row; a second failure of the
 * same session does not add another category. Invalid ids are refused — a
 * phone number must not be able to land in the claim key.
 */
export async function noteFirstHelloFailure(
  database: Database,
  input: { sessionId: string; familyId: string | null; category: string },
  deps: FailurePageDeps = {},
): Promise<FailurePageResult> {
  const sessionId = input.sessionId;
  if (!UUID_RE.test(sessionId)) {
    console.error('failure page: first hello session id was not a uuid — not recorded');
    return pageFailureAlerts(database, deps);
  }
  if (input.familyId !== null && !UUID_RE.test(input.familyId)) {
    console.error('failure page: first hello family id was not a uuid — not recorded');
    return pageFailureAlerts(database, deps);
  }
  const category = failureCategory(input.category);
  const identifier = helloIdentifier(sessionId, category);
  try {
    const existing = await database
      .select({
        identifier: schema.rateLimits.identifier,
        route: schema.rateLimits.route,
      })
      .from(schema.rateLimits)
      .where(eq(schema.rateLimits.route, FIRST_HELLO_PAGE_ROUTE));
    const already = existing.some(
      (row) => row.route === FIRST_HELLO_PAGE_ROUTE && row.identifier.startsWith(`${sessionId}:`),
    );
    if (!already) {
      await database
        .insert(schema.rateLimits)
        .values({
          identifier,
          route: FIRST_HELLO_PAGE_ROUTE,
          windowStart: CLAIM_EPOCH,
          count: UNALERTED_COUNT,
        })
        .onConflictDoNothing({
          target: [
            schema.rateLimits.identifier,
            schema.rateLimits.route,
            schema.rateLimits.windowStart,
          ],
        });
    }
  } catch (err) {
    console.error('failure page: first hello record threw', {
      err: err instanceof Error ? err.name : 'unknown',
    });
  }
  return pageFailureAlerts(database, deps);
}

/** Inline hook. The cron is the backstop when this never runs or the post fails. */
export async function reportTurnFailures(database: Database): Promise<void> {
  try {
    await pageFailureAlerts(database);
  } catch (err) {
    console.error('failure page: inline turn sweep threw', {
      err: err instanceof Error ? err.name : 'unknown',
    });
  }
}

/** Inline hook for a greet / recovery send that threw. Never replaces that error. */
export async function reportFirstHelloFailure(
  database: Database,
  input: { sessionId: string; familyId: string | null; err: unknown },
): Promise<void> {
  try {
    await noteFirstHelloFailure(database, {
      sessionId: input.sessionId,
      familyId: input.familyId,
      category: firstHelloFailureCategory(input.err),
    });
  } catch (err) {
    console.error('failure page: inline first hello sweep threw', {
      err: err instanceof Error ? err.name : 'unknown',
    });
  }
}
