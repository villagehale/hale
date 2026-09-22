import { createHash } from 'node:crypto';
import { type Database, schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import { and, count, eq, gte, inArray, isNull, like, lt } from 'drizzle-orm';
import { TOPICS } from '~/lib/coach/topic';
import { readFamilyTimezone } from '~/lib/dashboard/trail-query';
import { indexFamilyAliases } from './aliases';
import { closeFacts } from './facts';
import { isEphemeralKey, isReceiptKey, normalizeFactKey } from './lexicon';
import { type PeriodWindow, digestWindows } from './period';
import { SYNTHESIS_WRITERS } from './synthesis';

/**
 * Daily and weekly memory rollups, plus the narrow reconciliations that do not
 * need a model: retire `ephemeral.` facts the belief writers opted into, and
 * count contradictory spellings without closing them (the nightly synthesis
 * pass owns that election). Nothing here reads a message body or invents a fact.
 *
 * Dark by default. `applied` is passed in so the cron reads the flag once.
 * Observe mode still audits an add or an update; it does not insert.
 */

export const MEMORY_DIGEST_APPLY_ENV = 'MEMORY_DIGEST_APPLY';
export const MEMORY_DIGEST_ALLOWLIST_ENV = 'MEMORY_DIGEST_FAMILY_ALLOWLIST';

export const MAX_EPHEMERAL_CLOSES = 10;
export const EPHEMERAL_MIN_AGE_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const TOPIC_SET = new Set<string>(TOPICS);
const BELIEF_WRITERS = new Set<string>(SYNTHESIS_WRITERS);

export interface DigestMode {
  /** True only when the flag is exactly `true` AND the allowlist is non-empty. */
  apply: boolean;
  allowlist: ReadonlySet<string>;
}

/** Strict `true`, and an allowlist is required. A trailing newline stays off. */
export function resolveDigestMode(env: NodeJS.ProcessEnv): DigestMode {
  const flagged = env[MEMORY_DIGEST_APPLY_ENV] === 'true';
  const ids = (env[MEMORY_DIGEST_ALLOWLIST_ENV] ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  if (!flagged || ids.length === 0) return { apply: false, allowlist: new Set(ids) };
  return { apply: true, allowlist: new Set(ids) };
}

export interface DigestSummary {
  inbound: number;
  outbound: number;
  byCategory: Record<string, number>;
  byTopic: Record<string, number>;
  openWorkstreams: Array<{ kind: string; topic: string | null; dueAt: string }>;
  completedWorkstreams: number;
  factsTouchedByType: Record<string, number>;
  line: string;
}

export interface FamilyDigestResult {
  applied: boolean;
  candidates: number;
  added: number;
  updated: number;
  unchanged: number;
  superseded: number;
  forgotten: number;
  deferred: number;
  failures: number;
  aliasCandidates: number;
  aliasesWritten: number;
  contradictionCandidates: number;
}

function emptyResult(applied: boolean): FamilyDigestResult {
  return {
    applied,
    candidates: 0,
    added: 0,
    updated: 0,
    unchanged: 0,
    superseded: 0,
    forgotten: 0,
    deferred: 0,
    failures: 0,
    aliasCandidates: 0,
    aliasesWritten: 0,
    contradictionCandidates: 0,
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${stableStringify(inner)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function digestContentHash(summary: DigestSummary): string {
  return createHash('sha256').update(stableStringify(summary)).digest('hex');
}

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const direct = (err as { code?: string }).code;
  const cause = (err as { cause?: { code?: string } }).cause?.code;
  return direct === '23505' || cause === '23505';
}

async function teenIds(database: Database, familyId: string, now: Date): Promise<Set<string>> {
  const rows = await database
    .select({ id: schema.children.id, dateOfBirth: schema.children.dateOfBirth })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
  return new Set(
    rows.filter((row) => deriveStage(row.dateOfBirth, now) === 'teenager').map((row) => row.id),
  );
}

async function buildSummary(
  database: Database,
  familyId: string,
  window: PeriodWindow,
  grain: 'day' | 'week',
  teenChildIds: ReadonlySet<string>,
): Promise<{ summary: DigestSummary; sourceCount: number }> {
  const [channelRows, messageRows, openRows, commitmentRows, factRows] = await Promise.all([
    database
      .select({
        direction: schema.channelMessages.direction,
        category: schema.channelMessages.category,
        n: count(),
      })
      .from(schema.channelMessages)
      .where(
        and(
          eq(schema.channelMessages.familyId, familyId),
          gte(schema.channelMessages.createdAt, window.start),
          lt(schema.channelMessages.createdAt, window.end),
        ),
      )
      .groupBy(schema.channelMessages.direction, schema.channelMessages.category),
    database
      .select({
        topic: schema.messages.topic,
        childId: schema.messages.childId,
        n: count(),
      })
      .from(schema.messages)
      .innerJoin(schema.conversations, eq(schema.messages.conversationId, schema.conversations.id))
      .where(
        and(
          eq(schema.conversations.familyId, familyId),
          isNull(schema.messages.deletedAt),
          gte(schema.messages.createdAt, window.start),
          lt(schema.messages.createdAt, window.end),
        ),
      )
      .groupBy(schema.messages.topic, schema.messages.childId),
    database
      .select({
        kind: schema.agentCommitments.commitmentKind,
        topic: schema.agentCommitments.topic,
        dueAt: schema.agentCommitments.dueAt,
      })
      .from(schema.agentCommitments)
      .where(
        and(
          eq(schema.agentCommitments.familyId, familyId),
          isNull(schema.agentCommitments.fulfilledAt),
          isNull(schema.agentCommitments.cancelledAt),
        ),
      )
      .orderBy(schema.agentCommitments.dueAt)
      .limit(8),
    database
      .select({
        fulfilledAt: schema.agentCommitments.fulfilledAt,
        cancelledAt: schema.agentCommitments.cancelledAt,
      })
      .from(schema.agentCommitments)
      .where(eq(schema.agentCommitments.familyId, familyId))
      .limit(200),
    database
      .select({
        factType: schema.familyMemoryFacts.factType,
        childId: schema.familyMemoryFacts.childId,
      })
      .from(schema.familyMemoryFacts)
      .where(
        and(
          eq(schema.familyMemoryFacts.familyId, familyId),
          gte(schema.familyMemoryFacts.validFrom, window.start),
          lt(schema.familyMemoryFacts.validFrom, window.end),
        ),
      )
      .limit(200),
  ]);

  let inbound = 0;
  let outbound = 0;
  const byCategory: Record<string, number> = {};
  for (const row of channelRows) {
    const n = Number(row.n);
    if (row.direction === 'in') inbound += n;
    else outbound += n;
    byCategory[row.category] = (byCategory[row.category] ?? 0) + n;
  }

  const byTopic: Record<string, number> = {};
  let notes = 0;
  for (const row of messageRows) {
    if (row.childId !== null && teenChildIds.has(row.childId)) continue;
    const n = Number(row.n);
    notes += n;
    if (row.topic && TOPIC_SET.has(row.topic)) {
      byTopic[row.topic] = (byTopic[row.topic] ?? 0) + n;
    }
  }

  let completedWorkstreams = 0;
  for (const row of commitmentRows) {
    const closedAt = row.fulfilledAt ?? row.cancelledAt;
    if (!closedAt) continue;
    if (closedAt >= window.start && closedAt < window.end) completedWorkstreams += 1;
  }

  const factsTouchedByType: Record<string, number> = {};
  for (const row of factRows) {
    if (row.childId !== null && teenChildIds.has(row.childId)) continue;
    factsTouchedByType[row.factType] = (factsTouchedByType[row.factType] ?? 0) + 1;
  }

  const openWorkstreams = openRows.map((row) => ({
    kind: row.kind,
    topic: row.topic,
    dueAt: row.dueAt.toISOString(),
  }));
  const summary: DigestSummary = {
    inbound,
    outbound,
    byCategory,
    byTopic,
    openWorkstreams,
    completedWorkstreams,
    factsTouchedByType,
    line: `${grain} ${window.periodStart}: inbound ${inbound}, outbound ${outbound}, open ${openWorkstreams.length}.`,
  };
  return { summary, sourceCount: inbound + outbound + notes };
}

async function contradictionCandidates(database: Database, familyId: string): Promise<number> {
  const rows = await database
    .select({
      childId: schema.familyMemoryFacts.childId,
      factType: schema.familyMemoryFacts.factType,
      factKey: schema.familyMemoryFacts.factKey,
    })
    .from(schema.familyMemoryFacts)
    .where(
      and(
        eq(schema.familyMemoryFacts.familyId, familyId),
        isNull(schema.familyMemoryFacts.validUntil),
        inArray(schema.familyMemoryFacts.inferredBy, [...SYNTHESIS_WRITERS]),
      ),
    )
    .limit(200);
  const groups = new Map<string, number>();
  for (const row of rows) {
    if (row.factKey.includes(':')) continue;
    const key = `${row.childId ?? 'house'}|${row.factType}|${normalizeFactKey(row.factKey)}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  let groupsWithTwo = 0;
  for (const size of groups.values()) if (size >= 2) groupsWithTwo += 1;
  return groupsWithTwo;
}

type DigestDecision = 'add' | 'update' | 'unchanged';

async function upsertDigest(
  database: Database,
  input: {
    familyId: string;
    grain: 'day' | 'week';
    window: PeriodWindow;
    timeZone: string;
    summary: DigestSummary;
    sourceCount: number;
    now: Date;
    applied: boolean;
    contradictionCandidates: number;
    aliasCandidates: number;
  },
): Promise<DigestDecision> {
  const hash = digestContentHash(input.summary);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await database.transaction(async (tx) => {
        const [existing] = await tx
          .select({
            id: schema.familyMemoryDigests.id,
            contentHash: schema.familyMemoryDigests.contentHash,
          })
          .from(schema.familyMemoryDigests)
          .where(
            and(
              eq(schema.familyMemoryDigests.familyId, input.familyId),
              eq(schema.familyMemoryDigests.grain, input.grain),
              eq(schema.familyMemoryDigests.periodStart, input.window.periodStart),
            ),
          )
          .limit(1);
        if (existing?.contentHash === hash) return 'unchanged';
        const decision: DigestDecision = existing ? 'update' : 'add';
        await tx.insert(schema.auditLog).values({
          familyId: input.familyId,
          actor: 'system',
          actionTaken: 'memory_digest_planned',
          targetTable: 'family_memory_digests',
          targetId: existing?.id ?? input.familyId,
          after: {
            applied: input.applied,
            grain: input.grain,
            periodStart: input.window.periodStart,
            timezone: input.timeZone,
            decision,
            sourceCount: input.sourceCount,
            contentHash: hash,
            contradictionCandidates: input.contradictionCandidates,
            aliasCandidates: input.aliasCandidates,
          },
        });
        if (!input.applied) return decision;
        if (!existing) {
          await tx.insert(schema.familyMemoryDigests).values({
            familyId: input.familyId,
            grain: input.grain,
            periodStart: input.window.periodStart,
            timezone: input.timeZone,
            summary: input.summary,
            contentHash: hash,
            sourceCount: input.sourceCount,
            generatedAt: input.now,
            updatedAt: input.now,
          });
        } else {
          await tx
            .update(schema.familyMemoryDigests)
            .set({
              timezone: input.timeZone,
              summary: input.summary,
              contentHash: hash,
              sourceCount: input.sourceCount,
              generatedAt: input.now,
              updatedAt: input.now,
            })
            .where(eq(schema.familyMemoryDigests.id, existing.id));
        }
        return decision;
      });
    } catch (err) {
      if (attempt === 0 && isUniqueViolation(err)) continue;
      throw err;
    }
  }
  return 'unchanged';
}

async function retireEphemeral(
  database: Database,
  input: { familyId: string; now: Date; applied: boolean; teenChildIds: ReadonlySet<string> },
): Promise<{ superseded: number; deferred: number }> {
  const rows = await database
    .select({
      id: schema.familyMemoryFacts.id,
      factKey: schema.familyMemoryFacts.factKey,
      inferredBy: schema.familyMemoryFacts.inferredBy,
      validFrom: schema.familyMemoryFacts.validFrom,
      childId: schema.familyMemoryFacts.childId,
    })
    .from(schema.familyMemoryFacts)
    .where(
      and(
        eq(schema.familyMemoryFacts.familyId, input.familyId),
        isNull(schema.familyMemoryFacts.validUntil),
        like(schema.familyMemoryFacts.factKey, `${'ephemeral.'}%`),
      ),
    )
    .limit(50);

  const minAge = input.now.getTime() - EPHEMERAL_MIN_AGE_DAYS * DAY_MS;
  const eligible = rows.filter((row) => {
    if (!isEphemeralKey(row.factKey) || isReceiptKey(row.factKey)) return false;
    if (row.childId !== null && input.teenChildIds.has(row.childId)) return false;
    if (row.inferredBy === null || !BELIEF_WRITERS.has(row.inferredBy)) return false;
    return row.validFrom.getTime() <= minAge;
  });
  const closing = eligible.slice(0, MAX_EPHEMERAL_CLOSES);
  const deferred = eligible.length - closing.length;
  if (closing.length === 0) return { superseded: 0, deferred };

  await database.transaction(async (tx) => {
    await tx.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: 'system',
      actionTaken: 'memory_ephemeral_retired',
      targetTable: 'family_memory_facts',
      targetId: closing[0]?.id ?? input.familyId,
      after: {
        applied: input.applied,
        factIds: closing.map((row) => row.id),
        deferred,
      },
    });
    if (!input.applied) return;
    await closeFacts(tx, {
      factIds: closing.map((row) => row.id),
      closedAt: input.now,
      supersededBy: null,
    });
  });
  return { superseded: input.applied ? closing.length : 0, deferred };
}

function tally(result: FamilyDigestResult, decision: DigestDecision): void {
  if (decision === 'add') result.added += 1;
  else if (decision === 'update') result.updated += 1;
  else result.unchanged += 1;
}

/**
 * One family, one run. Day digest covers the previous local day. Week digest
 * covers that day's Monday through the end of that day. Both identities are
 * stable, so a second run with the same inputs is `unchanged`.
 */
export async function runFamilyMemoryDigest(
  database: Database,
  familyId: string,
  now: Date,
  applied: boolean,
): Promise<FamilyDigestResult> {
  const result = emptyResult(applied);
  const timeZone = await readFamilyTimezone(database, familyId);
  const windows = digestWindows(now, timeZone);
  const teens = await teenIds(database, familyId, now);
  const [day, week, contradictions, aliases] = await Promise.all([
    buildSummary(database, familyId, windows.day, 'day', teens),
    buildSummary(database, familyId, windows.week, 'week', teens),
    contradictionCandidates(database, familyId),
    indexFamilyAliases(database, { familyId, teenChildIds: teens, applied: false }),
  ]);
  result.candidates = week.sourceCount;
  result.contradictionCandidates = contradictions;
  result.aliasCandidates = aliases.candidates;

  const dayDecision = await upsertDigest(database, {
    familyId,
    grain: 'day',
    window: windows.day,
    timeZone,
    summary: day.summary,
    sourceCount: day.sourceCount,
    now,
    applied,
    contradictionCandidates: contradictions,
    aliasCandidates: aliases.candidates,
  });
  tally(result, dayDecision);
  const weekDecision = await upsertDigest(database, {
    familyId,
    grain: 'week',
    window: windows.week,
    timeZone,
    summary: week.summary,
    sourceCount: week.sourceCount,
    now,
    applied,
    contradictionCandidates: contradictions,
    aliasCandidates: aliases.candidates,
  });
  tally(result, weekDecision);

  if (applied) {
    const written = await indexFamilyAliases(database, {
      familyId,
      teenChildIds: teens,
      applied: true,
    });
    result.aliasesWritten = written.written;
    if (written.written > 0) {
      await database.insert(schema.auditLog).values({
        familyId,
        actor: 'system',
        actionTaken: 'memory_aliases_indexed',
        targetTable: 'family_memory_aliases',
        targetId: familyId,
        after: { applied: true, written: written.written, candidates: written.candidates },
      });
    }
  }

  const ephemeral = await retireEphemeral(database, {
    familyId,
    now,
    applied,
    teenChildIds: teens,
  });
  result.superseded = ephemeral.superseded;
  result.deferred = ephemeral.deferred;
  return result;
}
