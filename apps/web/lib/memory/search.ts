import { type Database, schema } from '@hale/db';
import { and, asc, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { type MatchChannel, expandTokens, scoreFact, tokenize } from './lexicon';

/**
 * Alias-backed lexical retrieval. No vectors. Family-scoped. Forgotten and
 * superseded rows stay out unless the caller passes `includeHistory`.
 *
 * The scan is bounded: the highest-confidence live facts, plus any fact an
 * alias row names. A fact outside that window is invisible until the digest
 * indexes its aliases, which is the same bound Instinct gets from a result limit.
 */

export const MEMORY_SEARCH_LIMIT = 8;
export const MEMORY_CANDIDATE_LIMIT = 200;
export const MEMORY_HISTORY_LIMIT = 20;
const ALIAS_HIT_LIMIT = 50;

export interface MemorySearchHit {
  id: string;
  factType: string;
  factKey: string;
  factValue: unknown;
  confidence: number;
  validFrom: string;
  validUntil: string | null;
  score: number;
  matchedBy: MatchChannel;
}

export interface SearchFamilyMemoryInput {
  familyId: string;
  query: string;
  factType?: schema.FamilyMemoryFact['factType'];
  includeHistory?: boolean;
  teenChildIds: ReadonlySet<string>;
  limit?: number;
}

interface FactRow {
  id: string;
  childId: string | null;
  factType: string;
  factKey: string;
  factValue: unknown;
  confidence: number;
  validFrom: Date;
  validUntil: Date | null;
  supersededBy: string | null;
  inferredBy: string | null;
}

const factColumns = {
  id: schema.familyMemoryFacts.id,
  childId: schema.familyMemoryFacts.childId,
  factType: schema.familyMemoryFacts.factType,
  factKey: schema.familyMemoryFacts.factKey,
  factValue: schema.familyMemoryFacts.factValue,
  confidence: schema.familyMemoryFacts.confidence,
  validFrom: schema.familyMemoryFacts.validFrom,
  validUntil: schema.familyMemoryFacts.validUntil,
  supersededBy: schema.familyMemoryFacts.supersededBy,
  inferredBy: schema.familyMemoryFacts.inferredBy,
};

function isTeen(row: { childId: string | null }, teenChildIds: ReadonlySet<string>): boolean {
  return row.childId !== null && teenChildIds.has(row.childId);
}

export async function searchFamilyMemory(
  database: Database,
  input: SearchFamilyMemoryInput,
): Promise<MemorySearchHit[]> {
  const tokens = tokenize(input.query);
  const expanded = expandTokens(tokens);
  if (expanded.size === 0) return [];

  const limit = Math.min(input.limit ?? MEMORY_SEARCH_LIMIT, MEMORY_SEARCH_LIMIT);
  const liveWhere = [
    eq(schema.familyMemoryFacts.familyId, input.familyId),
    isNull(schema.familyMemoryFacts.validUntil),
  ];
  if (input.factType) {
    liveWhere.push(eq(schema.familyMemoryFacts.factType, input.factType));
  }

  const aliasNorms = [...expanded].slice(0, 32);
  const [live, aliasHits, closed] = await Promise.all([
    database
      .select(factColumns)
      .from(schema.familyMemoryFacts)
      .where(and(...liveWhere))
      .orderBy(
        desc(schema.familyMemoryFacts.confidence),
        desc(schema.familyMemoryFacts.validFrom),
        asc(schema.familyMemoryFacts.id),
      )
      .limit(MEMORY_CANDIDATE_LIMIT),
    database
      .select({ factId: schema.familyMemoryAliases.factId })
      .from(schema.familyMemoryAliases)
      .where(
        and(
          eq(schema.familyMemoryAliases.familyId, input.familyId),
          inArray(schema.familyMemoryAliases.aliasNorm, aliasNorms),
        ),
      )
      .limit(ALIAS_HIT_LIMIT),
    input.includeHistory
      ? database
          .select(factColumns)
          .from(schema.familyMemoryFacts)
          .where(
            and(
              eq(schema.familyMemoryFacts.familyId, input.familyId),
              isNotNull(schema.familyMemoryFacts.validUntil),
              input.factType ? eq(schema.familyMemoryFacts.factType, input.factType) : undefined,
            ),
          )
          .orderBy(desc(schema.familyMemoryFacts.validUntil), asc(schema.familyMemoryFacts.id))
          .limit(MEMORY_CANDIDATE_LIMIT)
      : Promise.resolve([] as FactRow[]),
  ]);

  const byId = new Map<string, FactRow>();
  for (const [index, row] of [...live, ...closed].entries()) {
    // Real rows have ids. A test double that omits them must not collapse
    // every fact onto one map key.
    byId.set(row.id ?? `candidate-${index}-${row.factKey}`, row);
  }

  const aliasHitIds = new Set(aliasHits.map((row) => row.factId));
  const missing = [...aliasHitIds].filter((id) => !byId.has(id));
  if (missing.length > 0) {
    const extra = await database
      .select(factColumns)
      .from(schema.familyMemoryFacts)
      .where(
        and(
          eq(schema.familyMemoryFacts.familyId, input.familyId),
          inArray(schema.familyMemoryFacts.id, missing),
          input.includeHistory ? undefined : isNull(schema.familyMemoryFacts.validUntil),
        ),
      );
    for (const row of extra) byId.set(row.id, row);
  }

  const ranked: MemorySearchHit[] = [];
  for (const row of byId.values()) {
    if (isTeen(row, input.teenChildIds)) continue;
    const validFrom = row.validFrom instanceof Date ? row.validFrom : new Date(0);
    // A row with no validUntil (including a test double that omits the column)
    // is live. Only a real Date closes it.
    const validUntil = row.validUntil instanceof Date ? row.validUntil : null;
    if (!input.includeHistory && validUntil !== null) continue;
    const scored = scoreFact(expanded, {
      factKey: row.factKey,
      factValue: row.factValue,
      confidence: row.confidence,
      validFrom,
      validUntil,
      aliasHit: aliasHitIds.has(row.id),
    });
    if (!scored) continue;
    ranked.push({
      id: row.id,
      factType: row.factType,
      factKey: row.factKey,
      factValue: row.factValue,
      confidence: row.confidence,
      validFrom: validFrom.toISOString(),
      validUntil: validUntil?.toISOString() ?? null,
      score: scored.score,
      matchedBy: scored.matchedBy,
    });
  }

  ranked.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const byTime = b.validFrom.localeCompare(a.validFrom);
    if (byTime !== 0) return byTime;
    return (a.id ?? '').localeCompare(b.id ?? '');
  });
  return ranked.slice(0, limit);
}

export interface MemoryFactView {
  found: true;
  id: string;
  factType: string;
  factKey: string;
  factValue: unknown;
  confidence: number;
  validFrom: string;
  validUntil: string | null;
  supersededBy: string | null;
  inferredBy: string | null;
}

export type GetMemoryFactResult =
  | MemoryFactView
  | { found: false; reason: 'not_found' | 'not_live' }
  | { found: false; reason: 'teen_redacted' };

export async function getFamilyMemoryFact(
  database: Database,
  input: {
    familyId: string;
    factId: string;
    includeHistory: boolean;
    teenChildIds: ReadonlySet<string>;
  },
): Promise<GetMemoryFactResult> {
  const [row] = await database
    .select(factColumns)
    .from(schema.familyMemoryFacts)
    .where(
      and(
        eq(schema.familyMemoryFacts.id, input.factId),
        eq(schema.familyMemoryFacts.familyId, input.familyId),
      ),
    )
    .limit(1);
  if (!row) return { found: false, reason: 'not_found' };
  if (isTeen(row, input.teenChildIds)) return { found: false, reason: 'teen_redacted' };
  if (!input.includeHistory && row.validUntil !== null) return { found: false, reason: 'not_live' };
  return {
    found: true,
    id: row.id,
    factType: row.factType,
    factKey: row.factKey,
    factValue: row.factValue,
    confidence: row.confidence,
    validFrom: row.validFrom.toISOString(),
    validUntil: row.validUntil?.toISOString() ?? null,
    supersededBy: row.supersededBy,
    inferredBy: row.inferredBy,
  };
}

export interface MemoryHistoryNode {
  id: string;
  factKey: string;
  factValue: unknown;
  validFrom: string;
  validUntil: string | null;
  supersededBy: string | null;
  inferredBy: string | null;
}

export type MemoryHistoryResult =
  | { found: true; nodes: MemoryHistoryNode[]; truncated: boolean }
  | { found: false; reason: 'not_found' }
  | { found: false; reason: 'teen_redacted' };

/**
 * The bi-temporal chain around one fact: predecessors (`superseded_by` points
 * here) and successors (this row's `superseded_by`), family-scoped, capped.
 */
export async function loadFactHistory(
  database: Database,
  input: { familyId: string; factId: string; teenChildIds: ReadonlySet<string> },
): Promise<MemoryHistoryResult> {
  const seed = await getFamilyMemoryFact(database, {
    ...input,
    includeHistory: true,
  });
  if (!seed.found) {
    return seed.reason === 'teen_redacted'
      ? { found: false, reason: 'teen_redacted' }
      : { found: false, reason: 'not_found' };
  }

  const nodes = new Map<string, FactRow>();
  const [seedRow] = await database
    .select(factColumns)
    .from(schema.familyMemoryFacts)
    .where(
      and(
        eq(schema.familyMemoryFacts.id, input.factId),
        eq(schema.familyMemoryFacts.familyId, input.familyId),
      ),
    )
    .limit(1);
  if (!seedRow) return { found: false, reason: 'not_found' };
  nodes.set(seedRow.id, seedRow);

  let truncated = false;
  const consider = async (rows: FactRow[]) => {
    for (const row of rows) {
      if (nodes.size >= MEMORY_HISTORY_LIMIT) {
        truncated = true;
        return;
      }
      if (isTeen(row, input.teenChildIds)) continue;
      nodes.set(row.id, row);
    }
  };

  // Walk forward along superseded_by, then backward to rows that point at what we have.
  let cursor: FactRow | undefined = seedRow;
  while (cursor?.supersededBy && nodes.size < MEMORY_HISTORY_LIMIT) {
    const nextId: string = cursor.supersededBy;
    if (nodes.has(nextId)) break;
    const [next] = await database
      .select(factColumns)
      .from(schema.familyMemoryFacts)
      .where(
        and(
          eq(schema.familyMemoryFacts.id, nextId),
          eq(schema.familyMemoryFacts.familyId, input.familyId),
        ),
      )
      .limit(1);
    if (!next) break;
    await consider([next]);
    cursor = next;
  }
  if (
    cursor?.supersededBy &&
    !nodes.has(cursor.supersededBy) &&
    nodes.size >= MEMORY_HISTORY_LIMIT
  ) {
    truncated = true;
  }

  const seenBackward = new Set<string>(nodes.keys());
  let frontier = [...nodes.keys()];
  while (frontier.length > 0 && nodes.size < MEMORY_HISTORY_LIMIT) {
    const predecessors = await database
      .select(factColumns)
      .from(schema.familyMemoryFacts)
      .where(
        and(
          eq(schema.familyMemoryFacts.familyId, input.familyId),
          inArray(schema.familyMemoryFacts.supersededBy, frontier),
        ),
      )
      .limit(MEMORY_HISTORY_LIMIT);
    const fresh: FactRow[] = [];
    for (const row of predecessors) {
      if (seenBackward.has(row.id)) continue;
      seenBackward.add(row.id);
      fresh.push(row);
    }
    if (fresh.length === 0) break;
    const room = MEMORY_HISTORY_LIMIT - nodes.size;
    if (fresh.length > room) truncated = true;
    await consider(fresh);
    frontier = fresh.slice(0, room).map((row) => row.id);
  }

  // The walk stops once the cap is full, so a chain longer than the cap never
  // enters `consider` on the overflow hop. Probe one older predecessor.
  if (!truncated && nodes.size >= MEMORY_HISTORY_LIMIT && frontier.length > 0) {
    const [older] = await database
      .select({ id: schema.familyMemoryFacts.id })
      .from(schema.familyMemoryFacts)
      .where(
        and(
          eq(schema.familyMemoryFacts.familyId, input.familyId),
          inArray(schema.familyMemoryFacts.supersededBy, frontier),
        ),
      )
      .limit(1);
    if (older && !nodes.has(older.id)) truncated = true;
  }

  const ordered = [...nodes.values()].sort((a, b) => {
    const byTime = a.validFrom.getTime() - b.validFrom.getTime();
    if (byTime !== 0) return byTime;
    return a.id.localeCompare(b.id);
  });
  return {
    found: true,
    truncated,
    nodes: ordered.map((row) => ({
      id: row.id,
      factKey: row.factKey,
      factValue: row.factValue,
      validFrom: row.validFrom.toISOString(),
      validUntil: row.validUntil?.toISOString() ?? null,
      supersededBy: row.supersededBy,
      inferredBy: row.inferredBy,
    })),
  };
}

export interface MemoryBucketList {
  factsByType: Record<string, number>;
  openWorkstreams: number;
  completedWorkstreams: number;
  digests: { day: number; week: number };
  /** Closed belief rows. Present only when includeHistory is set; otherwise omitted. */
  closedFacts?: number;
}

export async function listMemoryBuckets(
  database: Database,
  input: { familyId: string; teenChildIds: ReadonlySet<string>; includeHistory?: boolean },
): Promise<MemoryBucketList> {
  const facts = await database
    .select({
      factType: schema.familyMemoryFacts.factType,
      childId: schema.familyMemoryFacts.childId,
      validUntil: schema.familyMemoryFacts.validUntil,
    })
    .from(schema.familyMemoryFacts)
    .where(eq(schema.familyMemoryFacts.familyId, input.familyId))
    .limit(MEMORY_CANDIDATE_LIMIT);

  const factsByType: Record<string, number> = {};
  let closedFacts = 0;
  for (const fact of facts) {
    if (isTeen(fact, input.teenChildIds)) continue;
    if (fact.validUntil !== null) {
      closedFacts += 1;
      continue;
    }
    factsByType[fact.factType] = (factsByType[fact.factType] ?? 0) + 1;
  }

  const commitments = await database
    .select({
      fulfilledAt: schema.agentCommitments.fulfilledAt,
      cancelledAt: schema.agentCommitments.cancelledAt,
    })
    .from(schema.agentCommitments)
    .where(eq(schema.agentCommitments.familyId, input.familyId))
    .limit(MEMORY_CANDIDATE_LIMIT);
  let openWorkstreams = 0;
  let completedWorkstreams = 0;
  for (const row of commitments) {
    if (row.fulfilledAt === null && row.cancelledAt === null) openWorkstreams += 1;
    else completedWorkstreams += 1;
  }

  const digests = await database
    .select({ grain: schema.familyMemoryDigests.grain })
    .from(schema.familyMemoryDigests)
    .where(eq(schema.familyMemoryDigests.familyId, input.familyId))
    .limit(MEMORY_CANDIDATE_LIMIT);
  const digestCounts = { day: 0, week: 0 };
  for (const row of digests) {
    if (row.grain === 'day' || row.grain === 'week') digestCounts[row.grain] += 1;
  }

  return {
    factsByType,
    openWorkstreams,
    completedWorkstreams,
    digests: digestCounts,
    ...(input.includeHistory ? { closedFacts } : {}),
  };
}
