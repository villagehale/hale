import { type Database, schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import { and, count, eq, inArray, isNull, notInArray, or } from 'drizzle-orm';
import { closeFacts } from './facts';

/**
 * VIL-354 — the nightly memory-integrity pass. Not to be confused with
 * `lib/channel/activity/synthesis.ts`, which is the deep lane's LLM summariser; this
 * makes no model call, reads no fact VALUE, and decides nothing a human could not
 * re-derive from the same rows.
 *
 * A fact, once written, was live forever: `writeFact`'s supersede was the only thing
 * in the repo that ever set `valid_until`, and it only fires when a NEW value arrives
 * on the same identity. So two things accumulated. A child outgrows a routine and
 * nobody replaces it, and the same belief gets filed twice under two spellings by two
 * writers who each choose their own keys. Both are the same missing verb — "this is no
 * longer live" — which `closeFacts` now provides.
 *
 * The cure for the duplicates is an ELECTION, not a synthesis: pick a winner among the
 * live rows and close the losers. Nothing is inserted, no key is rewritten, no
 * `inferred_by` is re-stamped — which is what keeps the worker registry's exact-key,
 * writer-pinned reads correct by construction rather than by a test.
 *
 * It reads `child_id`, `fact_type`, `valid_from`, `created_at`, `confidence`,
 * `inferred_by` and the SHAPE of `fact_key`. Never a value, never the key's prose. The
 * teen redaction boundary (rule #1) is therefore satisfied by subtraction: there is no
 * content in scope to redact and no model to read it.
 */

export const MEMORY_SYNTHESIS_APPLY_ENV = 'MEMORY_SYNTHESIS_APPLY';

/**
 * STRICT equality on the literal 'true', the same fail-closed shape the F14 gate uses
 * and for the same reason: `vercel env add` from a piped `echo` stores a TRAILING
 * NEWLINE, so a value that prints as `true` is really `'true\n'` and a truthiness check
 * would read that as ON — here, arming irreversible retirements nobody armed. Set it
 * with `printf '%s'`.
 *
 * OFF is not off, it is OBSERVE-ONLY: the pass still runs, still decides, and still
 * files every audit row with `applied: false`. One night of real decisions on real
 * families, readable in the trail, before a single row moves.
 */
export function memorySynthesisApplies(): boolean {
  return process.env[MEMORY_SYNTHESIS_APPLY_ENV] === 'true';
}

/**
 * The writers whose rows are BELIEFS about a household, and the only rows this pass may
 * close. An allowlist rather than a blocklist: the two excluded writers
 * (`health-nudge-reply`, `registration-sequence-reply`) are control-plane receipts, and
 * the health one is read back as a suppression predicate pinned to that exact writer —
 * closing one silently un-suppresses a checkpoint the parent already answered and Hale
 * re-nags. An allowlist also means the next mechanical writer is excluded by DEFAULT,
 * where a blocklist would leave it one merge away from that same re-nag.
 */
export const SYNTHESIS_WRITERS = ['ask-hale', 'memory_inferencer', 'chat_distiller'] as const;

/**
 * Rule A's writer, and it is ONE of the three — narrower than the set Rule B elects
 * over, deliberately.
 *
 * Retiring is the only thing this pass does that discards a belief rather than
 * choosing between two spellings of one, and "the child crossed a boundary" is not
 * Hale's licence to forget something a parent SAID. `ask-hale` rows are written from a
 * parent's own message and `memory_inferencer` rows from the household's events; only
 * `chat_distiller` rows are Hale's own reading of a conversation, which is the only
 * thing it may quietly change its mind about. Rule B keeps the full allowlist because
 * an election discards no belief — the winner still says it.
 *
 * `satisfies` rather than a bare string so this cannot drift out of the allowlist: a
 * Rule A writer the candidate query never returns is a rule that silently does nothing.
 */
const STALE_ROUTINE_WRITER = 'chat_distiller' satisfies (typeof SYNTHESIS_WRITERS)[number];

/**
 * How old a belief must be before "it predates the child's current stage" is a claim
 * about the belief rather than about the calendar. The preschool band is only twelve
 * months wide, so "most recent crossing" can be days away: without this, a routine
 * written the day before a birthday is retired the day after.
 */
export const MIN_STALE_FACT_AGE_DAYS = 30;

/**
 * The blast-radius bound, in the shape `MAX_FAMILIES_PER_RUN` already uses: a wrong
 * rule can retire at most this many of one family's facts before the founder reads it
 * in the trail. The remainder is named `deferredOverCap` and picked up the next night,
 * which costs nothing because the pass is idempotent.
 */
export const MAX_SYNTHESIS_ACTIONS_PER_FAMILY = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Every outcome of one family's night, including the ones where nothing happened —
 *  a count of zero retirements and a count of twelve rows the allowlist refused are
 *  different nights, and folding them together is what hides a broken rule (#11). */
export interface FamilySynthesisResult {
  /** False when the dark flag is off: every decision below was made and audited, and
   *  no `valid_until` was written. Never a withheld dependency — the pass always has
   *  its database; what it does not have is permission. */
  applied: boolean;
  candidates: number;
  /** `inferred_by IS NULL` — excluded, because a row with no writer cannot be checked
   *  against the allowlist at all. */
  unattributed: number;
  /** Live rows the allowlist refused: the control-plane receipts. */
  controlPlaneExcluded: number;
  retired: number;
  /** Stage-crossed, but younger than MIN_STALE_FACT_AGE_DAYS. Left live. */
  tooYoungToRetire: number;
  mergedGroups: number;
  mergedLosers: number;
  /** Closes landing on a 13+ child's rows. Permitted — `TEENAGER_START_MONTHS` is a
   *  Rule A boundary — and counted apart because it is the one case worth reading. */
  teenScoped: number;
  /** Keys containing ':' — addresses, not prose. Never elected against each other. */
  namespacedSkipped: number;
  deferredOverCap: number;
  /** Asked for by a decision but already closed when the UPDATE ran: a race or a
   *  double-run, never reported as success. */
  alreadyClosed: number;
}

export interface SynthesisCronResult {
  applied: boolean;
  families: number;
  results: Array<
    { familyId: string; result: FamilySynthesisResult } | { familyId: string; error: string }
  >;
}

type MemoryFactType = schema.NewFamilyMemoryFact['factType'];

interface Candidate {
  id: string;
  childId: string | null;
  factType: MemoryFactType;
  factKey: string;
  confidence: number;
  /** Non-null by construction: the candidate query's allowlist is an `IN`, which no
   *  NULL satisfies. Carried because Rule A reads a narrower set than Rule B. */
  inferredBy: string | null;
  validFrom: Date;
  createdAt: Date;
}

/** One thing the pass decided to do, and the sentence it will file about it. The verb
 *  is picked here rather than at the insert, which is why `lib/memory/synthesis.ts` is
 *  registered as an indirect audit write site. */
interface Decision {
  verb: 'memory_fact_retired' | 'memory_facts_merged';
  /** The fact a parent reading the trail would ask about: the retired row, or the
   *  winner that absorbed the others. Deliberately NOT the family id, which is what
   *  `recordCheckpointDone` uses — that row is about a checkpoint, this one is about
   *  a specific fact, and the noun renders off (target_table, target_id). */
  targetId: string;
  closes: string[];
  supersededBy: string | null;
  after: Record<string, unknown>;
}

/**
 * Two spellings of the same key. Lowercased, with everything outside `[a-z0-9]`
 * stripped — enough for `bedtime_routine` / `bedtime-routine` / `Bedtime Routine` /
 * `bed_time`, and deliberately not enough for `bedtime` vs `bedtime_routine`, which
 * are two different beliefs as often as they are one.
 */
function normalizeKey(factKey: string): string {
  return factKey.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** The 0084 unique-index tiebreak, which is the order the database itself would keep
 *  if it had to choose one live row per identity. Note it is NOT the coach's order —
 *  the first two keys match, the last does not — so an exact two-way tie can elect a
 *  different row than the coach's top one. */
function electionOrder(a: Candidate, b: Candidate): number {
  if (a.confidence !== b.confidence) return b.confidence - a.confidence;
  const byValidFrom = b.validFrom.getTime() - a.validFrom.getTime();
  if (byValidFrom !== 0) return byValidFrom;
  const byCreatedAt = b.createdAt.getTime() - a.createdAt.getTime();
  if (byCreatedAt !== 0) return byCreatedAt;
  return b.id.localeCompare(a.id);
}

/**
 * One family's night.
 *
 * `applied` is a parameter rather than an env read so the flag is consulted once per
 * window and a test can drive both states without touching the process.
 */
export async function runFamilySynthesis(
  database: Database,
  familyId: string,
  now: Date,
  applied: boolean,
): Promise<FamilySynthesisResult> {
  const result: FamilySynthesisResult = {
    applied,
    candidates: 0,
    unattributed: 0,
    controlPlaneExcluded: 0,
    retired: 0,
    tooYoungToRetire: 0,
    mergedGroups: 0,
    mergedLosers: 0,
    teenScoped: 0,
    namespacedSkipped: 0,
    deferredOverCap: 0,
    alreadyClosed: 0,
  };

  // The allowlist lives in the WHERE clause, not in a filter after it: nothing else in
  // this file produces an id, so a control-plane row cannot reach `closeFacts` even
  // through a bug downstream.
  const candidates: Candidate[] = await database
    .select({
      id: schema.familyMemoryFacts.id,
      childId: schema.familyMemoryFacts.childId,
      factType: schema.familyMemoryFacts.factType,
      factKey: schema.familyMemoryFacts.factKey,
      confidence: schema.familyMemoryFacts.confidence,
      inferredBy: schema.familyMemoryFacts.inferredBy,
      validFrom: schema.familyMemoryFacts.validFrom,
      createdAt: schema.familyMemoryFacts.createdAt,
    })
    .from(schema.familyMemoryFacts)
    .where(
      and(
        eq(schema.familyMemoryFacts.familyId, familyId),
        isNull(schema.familyMemoryFacts.validUntil),
        inArray(schema.familyMemoryFacts.inferredBy, [...SYNTHESIS_WRITERS]),
      ),
    );
  result.candidates = candidates.length;

  // The complement, counted rather than assumed. `NOT IN` alone would drop the NULLs
  // (SQL's `NULL NOT IN (…)` is NULL, not true), which is exactly the bucket that has
  // to be named — so the null case is spelled out beside it.
  const excluded = await database
    .select({ inferredBy: schema.familyMemoryFacts.inferredBy, rows: count() })
    .from(schema.familyMemoryFacts)
    .where(
      and(
        eq(schema.familyMemoryFacts.familyId, familyId),
        isNull(schema.familyMemoryFacts.validUntil),
        or(
          isNull(schema.familyMemoryFacts.inferredBy),
          notInArray(schema.familyMemoryFacts.inferredBy, [...SYNTHESIS_WRITERS]),
        ),
      ),
    )
    .groupBy(schema.familyMemoryFacts.inferredBy);
  for (const row of excluded) {
    if (row.inferredBy === null) result.unattributed += row.rows;
    else result.controlPlaneExcluded += row.rows;
  }

  if (candidates.length === 0) return result;

  const childRows = await database
    .select({ id: schema.children.id, dateOfBirth: schema.children.dateOfBirth })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
  const dobByChild = new Map(childRows.map((row) => [row.id, row.dateOfBirth]));

  // ── Rule A: a child-scoped routine the child has outgrown ───────────────────────
  // "Predates the most recent boundary crossing" is exactly "the child was in a
  // different stage when this became true", so `deriveStage` answers it and no month
  // arithmetic is re-implemented here — which is what keeps the boundaries read from
  // STAGE_BOUNDARIES_MONTHS rather than from a positional index.
  const retirements: Decision[] = [];
  const minAgeMs = MIN_STALE_FACT_AGE_DAYS * DAY_MS;
  for (const fact of candidates) {
    if (fact.childId === null || fact.factType !== 'routine') continue;
    // …and only what Hale read for itself. See STALE_ROUTINE_WRITER: a routine the
    // parent stated is not Hale's to let go of. The row stays a Rule B candidate —
    // being told something twice is still worth tidying.
    if (fact.inferredBy !== STALE_ROUTINE_WRITER) continue;
    const dateOfBirth = dobByChild.get(fact.childId);
    // `child_id` is an FK that cascades on delete, so a live child-scoped fact always
    // has its child row; this narrows the map read.
    if (dateOfBirth === undefined) continue;
    if (deriveStage(dateOfBirth, fact.validFrom) === deriveStage(dateOfBirth, now)) continue;
    if (now.getTime() - fact.validFrom.getTime() < minAgeMs) {
      result.tooYoungToRetire += 1;
      continue;
    }
    retirements.push({
      verb: 'memory_fact_retired',
      targetId: fact.id,
      closes: [fact.id],
      supersededBy: null,
      after: { factType: fact.factType, reason: 'stage_crossed', factIds: [fact.id] },
    });
  }

  // ── Rule B: the same belief, filed twice ────────────────────────────────────────
  const retiredIds = new Set(retirements.map((decision) => decision.targetId));
  const groups = new Map<string, Candidate[]>();
  for (const fact of candidates) {
    if (retiredIds.has(fact.id)) continue;
    // A namespaced key is an ADDRESS — recipient:<email>, action_override:<type> — and
    // one address is never a near-duplicate of another. `save_memory` lets a model
    // write into those namespaces freely, so electing among them would amplify a
    // pre-existing injection surface.
    if (fact.factKey.includes(':')) {
      result.namespacedSkipped += 1;
      continue;
    }
    // `child_id` is part of the group key: a household fact and a child's fact are
    // different beliefs, and 0084's NULLS NOT DISTINCT already treats them that way.
    const groupKey = `${fact.childId ?? 'house'}|${fact.factType}|${normalizeKey(fact.factKey)}`;
    const group = groups.get(groupKey);
    if (group) group.push(fact);
    else groups.set(groupKey, [fact]);
  }

  const merges: Decision[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const [winner, ...losers] = [...group].sort(electionOrder);
    if (!winner) continue;
    merges.push({
      verb: 'memory_facts_merged',
      targetId: winner.id,
      closes: losers.map((fact) => fact.id),
      supersededBy: winner.id,
      after: {
        factType: winner.factType,
        winnerFactId: winner.id,
        closedFactIds: losers.map((fact) => fact.id),
      },
    });
  }

  // ── The cap ─────────────────────────────────────────────────────────────────────
  // Counted in facts closed, and a merge is taken whole or not at all: half an
  // election is a group with two live winners.
  const acted: Decision[] = [];
  let closing = 0;
  for (const decision of [...retirements, ...merges]) {
    if (closing + decision.closes.length > MAX_SYNTHESIS_ACTIONS_PER_FAMILY) {
      result.deferredOverCap += decision.closes.length;
      continue;
    }
    acted.push(decision);
    closing += decision.closes.length;
  }

  for (const decision of acted) {
    if (decision.verb === 'memory_fact_retired') result.retired += 1;
    else {
      result.mergedGroups += 1;
      result.mergedLosers += decision.closes.length;
    }
  }

  const childIdByFact = new Map(candidates.map((fact) => [fact.id, fact.childId]));
  const teenChildIds = new Set(
    childRows
      .filter((row) => deriveStage(row.dateOfBirth, now) === 'teenager')
      .map((row) => row.id),
  );
  result.teenScoped = acted
    .flatMap((decision) => decision.closes)
    .filter((factId) => {
      const childId = childIdByFact.get(factId);
      return childId !== null && childId !== undefined && teenChildIds.has(childId);
    }).length;

  if (acted.length === 0) return result;

  // Audit FIRST and inside the same transaction as the close, the shape
  // `recordCheckpointDone` states: a crash between them must leave neither, because a
  // fact that vanished with no audit line is the one thing PIPEDA right-to-access
  // cannot recover. `applied` is the single boolean the dark flag controls.
  await database.transaction(async (tx) => {
    for (const decision of acted) {
      await tx.insert(schema.auditLog).values({
        familyId,
        actor: 'system',
        actionTaken: decision.verb,
        targetTable: 'family_memory_facts',
        targetId: decision.targetId,
        after: { ...decision.after, applied },
      });
      if (!applied) continue;
      const closed = await closeFacts(tx, {
        factIds: decision.closes,
        closedAt: now,
        supersededBy: decision.supersededBy,
      });
      result.alreadyClosed += closed.alreadyClosedFactIds.length;
    }
  });

  return result;
}

/**
 * The window: every family the inference cron selected, one at a time. A per-family
 * throw is recorded against that family and the loop continues — the shape the agent
 * leg beside it already uses, for the same reason.
 */
export async function runMemorySynthesis(
  database: Database,
  familyIds: readonly string[],
  now: Date,
): Promise<SynthesisCronResult> {
  const applied = memorySynthesisApplies();
  const results: SynthesisCronResult['results'] = [];
  for (const familyId of familyIds) {
    try {
      results.push({
        familyId,
        result: await runFamilySynthesis(database, familyId, now, applied),
      });
    } catch (err) {
      results.push({ familyId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { applied, families: familyIds.length, results };
}
