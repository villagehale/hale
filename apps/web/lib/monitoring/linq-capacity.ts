import { type Database, schema } from '@hale/db';
import { and, eq, gt, lt, sql } from 'drizzle-orm';
import { CANARY_CHAT_ID_PREFIX } from '~/lib/channel/canary/config';
import {
  LINQ_MALFORMED_CHAT_PAGE,
  type LinqChatService,
  LinqSendError,
  type listLinqChatsPage,
} from '~/lib/channel/linq/transport';
import {
  ALERTED_COUNT,
  CLAIM_EPOCH,
  STALE_CLAIM_MS,
  claimStamp,
} from '~/lib/monitoring/failure-page';
import type { OpsPageOutcome } from '~/lib/monitoring/ops-slack';

/**
 * VIL-407 — the Linq chat-ID capacity watch.
 *
 * Linq's line holds a fixed number of chat IDs: each 1:1 parent is one, each group
 * chat is one. This counts them read-only through the list call in transport.ts and
 * pages Slack #ops once per upward crossing of 70% and 90%. It re-arms only after the
 * count falls a gap below the threshold, so a count sitting at the line pages once.
 *
 * Monitoring only. Nothing here gates, holds or delays a send, and no send path is
 * imported (pinned by the import-graph test).
 *
 * Privacy (rule #1): outcomes, logs and the page carry counts only — never a chat
 * id, a handle, a name or the key.
 *
 * Audit (rule #6), deliberate deviation: no audit_log row. audit_log.family_id is
 * NOT NULL and this is a line-level ops event, as in provider-health. The latch row
 * in rate_limits is the record.
 */

/** Linq's limit, in chat IDs. The only home of the number. */
export const LINQ_CHAT_ID_LIMIT = 200;

export const LINQ_CAPACITY_THRESHOLDS = [
  { id: 'pct70', pct: 70 },
  { id: 'pct90', pct: 90 },
] as const;

export type CapacityThreshold = (typeof LINQ_CAPACITY_THRESHOLDS)[number]['id'];

/** A latched threshold re-arms only strictly below (threshold - gap). */
export const LINQ_CAPACITY_REARM_GAP = 10;

/** The rate_limits `route` the latch rows live under. */
export const LINQ_CAPACITY_ROUTE = 'ops:linq-capacity';

/** Linq's page maximum. */
export const LINQ_CHATS_PAGE_LIMIT = 100;

/** Loop bound: a cursor chain longer than this is named, not followed. */
export const LINQ_CHATS_MAX_PAGES = 20;

const RUNBOOK = 'docs/linq-chat-capacity.md';

export interface LinqChatCount {
  total: number;
  direct: number;
  groups: number;
  byService: Record<LinqChatService, number>;
  pages: number;
}

export type LinqCountResult =
  | { status: 'ok'; count: LinqChatCount }
  | { status: 'not_configured' }
  | { status: 'refused'; code: string; httpStatus: number; permanent: boolean }
  | { status: 'unreachable'; reason: 'timeout' | 'network' }
  | { status: 'malformed' }
  | { status: 'cursor_loop' }
  | { status: 'page_bound_exceeded'; seen: number };

type LinqUnavailable = Exclude<LinqCountResult, { status: 'ok' }>;

// ── counting ─────────────────────────────────────────────────────────────────

function linqErrorResult(err: LinqSendError): LinqUnavailable {
  if (err.code === 'not_configured') return { status: 'not_configured' };
  if (err.code === 'timeout' || err.code === 'network') {
    return { status: 'unreachable', reason: err.code };
  }
  if (err.code === LINQ_MALFORMED_CHAT_PAGE) return { status: 'malformed' };
  return {
    status: 'refused',
    code: err.code,
    httpStatus: err.httpStatus,
    permanent: err.permanent,
  };
}

/** Every chat the key sees, deduped by id. A Linq failure is a named result, never
 * a throw; anything else is a bug and propagates. */
export async function countLinqChats(deps: {
  listPage: typeof listLinqChatsPage;
}): Promise<LinqCountResult> {
  const seen = new Set<string>();
  const cursors = new Set<string>();
  const count: LinqChatCount = {
    total: 0,
    direct: 0,
    groups: 0,
    byService: { iMessage: 0, SMS: 0, RCS: 0, other: 0 },
    pages: 0,
  };
  let cursor: string | undefined;

  for (;;) {
    let page: Awaited<ReturnType<typeof listLinqChatsPage>>;
    try {
      page = await deps.listPage({
        limit: LINQ_CHATS_PAGE_LIMIT,
        ...(cursor ? { cursor } : {}),
      });
    } catch (err) {
      if (err instanceof LinqSendError) return linqErrorResult(err);
      throw err;
    }
    count.pages += 1;
    for (const chat of page.chats) {
      if (seen.has(chat.id)) continue;
      seen.add(chat.id);
      count.total += 1;
      if (chat.isGroup) count.groups += 1;
      else count.direct += 1;
      count.byService[chat.service] += 1;
    }

    const next = page.nextCursor;
    if (next === null) return { status: 'ok', count };
    if (cursors.has(next)) return { status: 'cursor_loop' };
    if (count.pages >= LINQ_CHATS_MAX_PAGES) {
      return { status: 'page_bound_exceeded', seen: count.pages };
    }
    cursors.add(next);
    cursor = next;
  }
}

/**
 * The DB's view of the line: every distinct chat id any table recorded, canary
 * excluded. Fallback only, when Linq cannot answer. It undercounts by design: a
 * parent mid-intake has no family row yet, and an erased family's rows are gone
 * while its chats stay on Linq. A full scan (provider_chat_id is unindexed), so it
 * runs only when the Linq count is not ok.
 */
export async function countDbChatIds(database: Database): Promise<number> {
  const s = schema;
  const result = (await database.execute(sql`
    select count(*)::int as n from (
      select ${s.families.linqGroupChatId} as id from ${s.families}
      union select ${s.linqGroupRosters.chatId} from ${s.linqGroupRosters}
      union select ${s.linqGroupMembers.chatId} from ${s.linqGroupMembers}
      union select ${s.linqMultiFamilyJoins.chatId} from ${s.linqMultiFamilyJoins}
      union select ${s.linqMultiFamilyMembers.chatId} from ${s.linqMultiFamilyMembers}
      union select ${s.linqMultiFamilyLedger.chatId} from ${s.linqMultiFamilyLedger}
      union select ${s.linqGroupOnboarding.providerChatId} from ${s.linqGroupOnboarding}
      union select ${s.familyUpgradeOffers.chatId} from ${s.familyUpgradeOffers}
      union select ${s.linqPollOptions.providerChatId} from ${s.linqPollOptions}
      union select ${s.linqGroupRosterMembers.chatId} from ${s.linqGroupRosterMembers}
      union select ${s.groupDecisionSync.originChatId} from ${s.groupDecisionSync}
      union select ${s.channelMessages.providerChatId} from ${s.channelMessages}
    ) ids
    where id is not null and id not like ${`${CANARY_CHAT_ID_PREFIX}%`}
  `)) as unknown as { rows?: Array<{ n: number }> } | Array<{ n: number }>;
  const row = (Array.isArray(result) ? result : (result.rows ?? []))[0];
  if (!row) throw new Error('countDbChatIds: count returned no row');
  return Number(row.n);
}

// ── evaluation ───────────────────────────────────────────────────────────────

function thresholdPct(t: CapacityThreshold): number {
  const found = LINQ_CAPACITY_THRESHOLDS.find((x) => x.id === t);
  if (!found) throw new Error(`unknown capacity threshold: ${t}`);
  return found.pct;
}

/** The chat-ID count that crosses `t`: 140 and 180 of 200. */
export function crossingThreshold(t: CapacityThreshold): number {
  return Math.floor((thresholdPct(t) * LINQ_CHAT_ID_LIMIT) / 100);
}

/** `cross`: armed thresholds the total has reached. `rearm`: latched thresholds the
 * total has fallen strictly below (threshold - gap), only when the source may re-arm. */
export function evaluateCapacity(input: {
  total: number;
  latched: ReadonlySet<CapacityThreshold>;
  mayRearm: boolean;
}): { cross: CapacityThreshold[]; rearm: CapacityThreshold[] } {
  const cross: CapacityThreshold[] = [];
  const rearm: CapacityThreshold[] = [];
  for (const { id } of LINQ_CAPACITY_THRESHOLDS) {
    const at = crossingThreshold(id);
    if (!input.latched.has(id)) {
      if (input.total >= at) cross.push(id);
    } else if (input.mayRearm && input.total < at - LINQ_CAPACITY_REARM_GAP) {
      rearm.push(id);
    }
  }
  return { cross, rearm };
}

// ── the latch ────────────────────────────────────────────────────────────────

/**
 * One rate_limits row per threshold, on failure-page's epoch encoding: no row is
 * armed, a unix-second stamp is a page in flight, ALERTED_COUNT is paged. The unique
 * (identifier, route, window_start) index is the lock.
 */
export interface CapacityLatchStore {
  /** Releases in-flight stamps older than the stale window, then returns what is latched. */
  latched(now: Date): Promise<Set<CapacityThreshold>>;
  claim(t: CapacityThreshold, now: Date): Promise<boolean>;
  confirm(t: CapacityThreshold): Promise<void>;
  release(t: CapacityThreshold): Promise<void>;
}

const THRESHOLD_IDS: ReadonlySet<string> = new Set(LINQ_CAPACITY_THRESHOLDS.map((t) => t.id));

function isThreshold(value: string): value is CapacityThreshold {
  return THRESHOLD_IDS.has(value);
}

export function rateLimitLatchStore(database: Database): CapacityLatchStore {
  const r = schema.rateLimits;
  const scope = and(eq(r.route, LINQ_CAPACITY_ROUTE), eq(r.windowStart, CLAIM_EPOCH));
  const row = (t: CapacityThreshold) => and(scope, eq(r.identifier, t));

  return {
    async latched(now) {
      const staleBefore = claimStamp(new Date(now.getTime() - STALE_CLAIM_MS));
      await database
        .delete(r)
        .where(and(scope, gt(r.count, ALERTED_COUNT), lt(r.count, staleBefore)));
      const rows = await database.select({ identifier: r.identifier }).from(r).where(scope);
      return new Set(rows.map((x) => x.identifier).filter(isThreshold));
    },
    async claim(t, now) {
      const claimed = await database
        .insert(r)
        .values({
          identifier: t,
          route: LINQ_CAPACITY_ROUTE,
          windowStart: CLAIM_EPOCH,
          count: claimStamp(now),
        })
        .onConflictDoNothing({ target: [r.identifier, r.route, r.windowStart] })
        .returning({ id: r.id });
      return claimed.length > 0;
    },
    async confirm(t) {
      await database.update(r).set({ count: ALERTED_COUNT }).where(row(t));
    },
    async release(t) {
      await database.delete(r).where(row(t));
    },
  };
}

// ── the page ─────────────────────────────────────────────────────────────────

function unavailableLabel(result: LinqUnavailable): string {
  return result.status === 'unreachable' ? result.reason : result.status;
}

/** The Slack #ops page. ASCII, counts only. */
export function composeCapacityAlert(
  input:
    | { source: 'linq'; threshold: CapacityThreshold; count: LinqChatCount }
    | { source: 'db'; threshold: CapacityThreshold; db: number; linq: LinqUnavailable },
): string {
  if (input.source === 'linq') {
    const { total, direct, groups } = input.count;
    return `Hale: Linq chat IDs at ${thresholdPct(input.threshold)}% - ${total} of ${LINQ_CHAT_ID_LIMIT} (1:1 ${direct}, groups ${groups}). Runbook: ${RUNBOOK}`;
  }
  return `Hale: Linq count unavailable (${unavailableLabel(input.linq)}); DB sees ${input.db} of ${LINQ_CHAT_ID_LIMIT} chat IDs (undercounts parents mid-intake and erased families). Runbook: ${RUNBOOK}`;
}

// ── orchestration ────────────────────────────────────────────────────────────

export interface LinqCapacityDeps {
  countApi(): Promise<LinqCountResult>;
  countDb(database: Database): Promise<number>;
  latches: CapacityLatchStore;
  sendAlert(body: string): Promise<OpsPageOutcome>;
}

export type LinqCapacityOutcome =
  | { outcome: 'below'; total: number; rearmed: CapacityThreshold[] }
  | { outcome: 'latched'; total: number }
  | { outcome: 'alerted'; threshold: CapacityThreshold; total: number; source: 'linq' | 'db' }
  | { outcome: 'alert_send_failed' | 'skipped_not_configured'; threshold: CapacityThreshold }
  | { outcome: 'claim_unavailable' }
  | { outcome: 'linq_unavailable'; reason: LinqUnavailable['status']; db: number };

/**
 * One tick. The Linq count may cross and re-arm; the DB fallback may only cross,
 * so an outage cannot flap a threshold. Every path out is a named outcome (rule
 * #11). A latch or DB read error throws: the route re-throws and the missing
 * heartbeat is the signal.
 */
export async function checkLinqCapacity(
  database: Database,
  deps: LinqCapacityDeps,
  now: Date,
): Promise<LinqCapacityOutcome> {
  const api = await deps.countApi();
  const latched = await deps.latches.latched(now);

  let total: number;
  let mayRearm: boolean;
  if (api.status === 'ok') {
    total = api.count.total;
    mayRearm = true;
  } else {
    console.warn('linq capacity: Linq count unavailable, reading the DB', { status: api.status });
    total = await deps.countDb(database);
    mayRearm = false;
  }

  const { cross, rearm } = evaluateCapacity({ total, latched, mayRearm });
  for (const t of rearm) {
    await deps.latches.release(t);
    latched.delete(t);
    console.info('linq capacity: threshold re-armed', { threshold: t, total });
  }

  if (cross.length === 0) {
    if (api.status !== 'ok') {
      return { outcome: 'linq_unavailable', reason: api.status, db: total };
    }
    return latched.size > 0
      ? { outcome: 'latched', total }
      : { outcome: 'below', total, rearmed: rearm };
  }

  const won: CapacityThreshold[] = [];
  try {
    for (const t of cross) {
      if (await deps.latches.claim(t, now)) won.push(t);
    }
  } catch (err) {
    console.error('linq capacity: latch claim failed, page withheld', {
      err: err instanceof Error ? err.name : 'unknown',
    });
    return { outcome: 'claim_unavailable' };
  }
  const threshold = won.at(-1);
  if (!threshold) return { outcome: 'latched', total };

  const body =
    api.status === 'ok'
      ? composeCapacityAlert({ source: 'linq', threshold, count: api.count })
      : composeCapacityAlert({ source: 'db', threshold, db: total, linq: api });
  const page = await deps.sendAlert(body);
  if (page === 'sent') {
    for (const t of won) await deps.latches.confirm(t);
    return { outcome: 'alerted', threshold, total, source: api.status === 'ok' ? 'linq' : 'db' };
  }
  for (const t of won) await deps.latches.release(t);
  console.error('linq capacity: ops page not delivered', { page, threshold, total });
  return page === 'skipped_not_configured'
    ? { outcome: 'skipped_not_configured', threshold }
    : { outcome: 'alert_send_failed', threshold };
}
