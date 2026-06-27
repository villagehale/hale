import { and, desc, eq, isNull } from 'drizzle-orm';
import { type Database, schema } from '@hale/db';
import {
  ageInMonths,
  type CompanionView,
  companionForChild,
  deriveStage,
  type FamilyStage,
} from '@hale/types';
import type { TranscriptMessage } from './conversation';

/**
 * Builds the family-scoped context the Ask Hale agent reasons over. Everything
 * here is the CALLER's family only (rule #1 — never another family's data).
 *
 * Teen redaction (rule #1 / #5) is structural, not cosmetic: a 13+ child
 * (stage === 'teenager') is surfaced to the agent as stage + a redacted marker
 * only — no name, no DOB-derived detail. Raw teen detail is ABSENT from the
 * context the model sees, not merely filtered downstream. Non-teen children carry
 * their name + age so the agent can ground per-child. The `get_child_profile`
 * tool re-checks this at the tool boundary via the child-content guard, so a
 * model that asks for a teen's profile is refused there too.
 *
 * The memory slice (currently-valid facts + recent episodes) gives the agent its
 * longitudinal recall; the running transcript gives it the multi-turn thread. A
 * recent episode OR currently-valid fact attributed to a 13+ child is redacted at
 * the source too — neither table carries a teen flag, so the summary / factKey /
 * factValue is withheld and child scope dropped before the slice reaches the model
 * (rule #1).
 */

const RECENT_EPISODE_LIMIT = 10;
const RELEVANT_FACT_LIMIT = 30;

/** A child as the agent sees it — teen detail redacted to stage only (rule #1). */
export interface ChildContext {
  id: string;
  stage: FamilyStage;
  /** Null for a teenager — name is withheld (rule #1). */
  name: string | null;
  /** Null for a teenager — age detail is withheld (rule #1). */
  ageMonths: number | null;
  /** True when this child is 13+ and their detail is intentionally withheld. */
  teenRedacted: boolean;
}

/**
 * The child the conversation is currently focused on (the per-child chip). For a
 * non-teen child this carries the deterministic companion view (stage guidance +
 * milestones around now) so the agent grounds its answer on THAT child's stage.
 * For a teenager it carries stage only — name, age, and milestone detail are
 * withheld (rule #1), exactly as ChildContext redacts.
 */
export interface FocusedChildContext {
  id: string;
  stage: FamilyStage;
  /** Null for a teenager (rule #1). */
  name: string | null;
  /** Null for a teenager (rule #1). */
  ageMonths: number | null;
  teenRedacted: boolean;
  /** Deterministic stage view for grounding — null for a teenager (rule #1). */
  companion: CompanionView | null;
}

export interface MemoryFactContext {
  childId: string | null;
  factType: string;
  factKey: string;
  factValue: unknown;
  confidence: number;
}

export interface MemoryEpisodeContext {
  childId: string | null;
  occurredAt: string;
  episodeType: string;
  summary: string;
}

/** Marker swapped in for a 13+ child's episode summary before the agent sees it —
 * only the coarse episodeType survives, the raw summary is withheld (rule #1). */
const TEEN_EPISODE_PLACEHOLDER = '[teen content — summary withheld from agent (rule #1)]';

/**
 * Redact any recent episode attributed to a 13+ child before it reaches the agent
 * (rule #1): the episode's child scope is dropped to null and its raw summary is
 * replaced with a marker, so no teen-specific detail can be surfaced. Non-teen and
 * family-wide (childId null) episodes pass through unchanged. The teen set is
 * derived LIVE from each child's DOB (deriveStage) — the episodes table carries no
 * teen flag. Pure, no I/O — mirrors the inferencer's snapshot redaction.
 */
function redactEpisodesForTeens(
  episodes: readonly MemoryEpisodeContext[],
  stageByChild: ReadonlyMap<string, FamilyStage>,
): MemoryEpisodeContext[] {
  return episodes.map((e) =>
    e.childId !== null && stageByChild.get(e.childId) === 'teenager'
      ? { childId: null, occurredAt: e.occurredAt, episodeType: e.episodeType, summary: TEEN_EPISODE_PLACEHOLDER }
      : e,
  );
}

/** Marker swapped in for a 13+ child's fact key and value before the agent sees it —
 * only the coarse factType survives, the raw key/value is withheld (rule #1). */
const TEEN_FACT_PLACEHOLDER = '[teen content — fact withheld from agent (rule #1)]';

/**
 * Redact any currently-valid fact attributed to a 13+ child before it reaches the
 * agent (rule #1): the fact's child scope is dropped to null and BOTH its free-text
 * factKey and raw jsonb factValue are replaced with a marker, so no teen-specific
 * detail can be surfaced. Non-teen and family-wide (childId null) facts pass through
 * unchanged. The teen set is derived LIVE from each child's DOB (deriveStage) — the
 * facts table carries no teen flag. Pure, no I/O — mirrors redactEpisodesForTeens.
 */
function redactFactsForTeens(
  facts: readonly MemoryFactContext[],
  stageByChild: ReadonlyMap<string, FamilyStage>,
): MemoryFactContext[] {
  return facts.map((f) =>
    f.childId !== null && stageByChild.get(f.childId) === 'teenager'
      ? {
          childId: null,
          factType: f.factType,
          factKey: TEEN_FACT_PLACEHOLDER,
          factValue: TEEN_FACT_PLACEHOLDER,
          confidence: f.confidence,
        }
      : f,
  );
}

export interface AgentContext {
  /** The signed-in parent's display name, when known. */
  parentName: string | null;
  /** Coarse location only — never a precise address (rule #1). */
  location: { city: string | null; province: string | null; country: string | null };
  planTier: schema.Family['planTier'];
  children: ChildContext[];
  /** Which child the parent has focused this turn on, or null for the whole family. */
  focusedChild: FocusedChildContext | null;
  /** Distinct stages the family spans, childhood-ordered. */
  stages: FamilyStage[];
  memoryFacts: MemoryFactContext[];
  recentEpisodes: MemoryEpisodeContext[];
  /** The prior turns of THIS conversation — the multi-turn thread. */
  transcript: TranscriptMessage[];
  /** The parent's current question. */
  question: string;
  /** Optional UI intent chip the parent tapped (e.g. "find a daycare near me"). */
  intent: string | null;
}

const STAGE_ORDER: readonly FamilyStage[] = ['newborn', 'toddler', 'child', 'teenager'];

function toChildContext(row: { id: string; name: string; dateOfBirth: string }): ChildContext {
  const stage = deriveStage(row.dateOfBirth);
  if (stage === 'teenager') {
    return { id: row.id, stage, name: null, ageMonths: null, teenRedacted: true };
  }
  return {
    id: row.id,
    stage,
    name: row.name,
    ageMonths: ageInMonths(row.dateOfBirth),
    teenRedacted: false,
  };
}

export interface LoadAgentContextInput {
  familyId: string;
  question: string;
  intent: string | null;
  /** The child the parent has focused on (the per-child chip), or null for the family. */
  focusedChildId: string | null;
  transcript: TranscriptMessage[];
}

/**
 * Builds the focused-child slice from the family's own child rows. A teenager is
 * reduced to stage only (rule #1) — name, age, and companion detail are withheld.
 * A focus id that doesn't name one of THIS family's children resolves to null (no
 * cross-family leak), so the conversation falls back to the whole-family scope.
 */
function toFocusedChild(
  focusedChildId: string,
  childRows: ReadonlyArray<{ id: string; name: string; dateOfBirth: string }>,
  now: Date,
): FocusedChildContext | null {
  const row = childRows.find((c) => c.id === focusedChildId);
  if (!row) return null;
  const stage = deriveStage(row.dateOfBirth, now);
  if (stage === 'teenager') {
    return { id: row.id, stage, name: null, ageMonths: null, teenRedacted: true, companion: null };
  }
  return {
    id: row.id,
    stage,
    name: row.name,
    ageMonths: ageInMonths(row.dateOfBirth, now),
    teenRedacted: false,
    companion: companionForChild({ dateOfBirth: row.dateOfBirth, name: row.name }, now),
  };
}

/**
 * Assembles the agent context for a family in one place. Reads only the caller's
 * family (every query is keyed on familyId). Teen children are reduced to stage
 * at the mapper, so their raw detail never enters the assembled context.
 */
export async function loadAgentContext(
  input: LoadAgentContextInput,
  database: Database,
  now: Date = new Date(),
): Promise<AgentContext> {
  const familyRows = await database
    .select({
      planTier: schema.families.planTier,
      city: schema.families.city,
      province: schema.families.province,
      country: schema.families.country,
    })
    .from(schema.families)
    .where(eq(schema.families.id, input.familyId))
    .limit(1);

  const family = familyRows[0];
  if (!family) {
    throw new Error(`loadAgentContext: no family row for ${input.familyId}`);
  }

  const parentRows = await database
    .select({ name: schema.users.name })
    .from(schema.familyMembers)
    .innerJoin(schema.users, eq(schema.familyMembers.userId, schema.users.id))
    .where(
      and(
        eq(schema.familyMembers.familyId, input.familyId),
        eq(schema.familyMembers.role, 'primary_parent'),
      ),
    )
    .limit(1);

  const childRows = await database
    .select({
      id: schema.children.id,
      name: schema.children.name,
      dateOfBirth: schema.children.dateOfBirth,
    })
    .from(schema.children)
    .where(eq(schema.children.familyId, input.familyId));

  const children = childRows.map(toChildContext);
  const presentStages = new Set(children.map((c) => c.stage));
  const stages = STAGE_ORDER.filter((s) => presentStages.has(s));

  const focusedChild = input.focusedChildId
    ? toFocusedChild(input.focusedChildId, childRows, now)
    : null;

  const factRows = await database
    .select({
      childId: schema.familyMemoryFacts.childId,
      factType: schema.familyMemoryFacts.factType,
      factKey: schema.familyMemoryFacts.factKey,
      factValue: schema.familyMemoryFacts.factValue,
      confidence: schema.familyMemoryFacts.confidence,
    })
    .from(schema.familyMemoryFacts)
    .where(
      and(
        eq(schema.familyMemoryFacts.familyId, input.familyId),
        isNull(schema.familyMemoryFacts.validUntil),
      ),
    )
    .limit(RELEVANT_FACT_LIMIT);

  const stageByChild = new Map<string, FamilyStage>(
    childRows.map((c) => [c.id, deriveStage(c.dateOfBirth, now)]),
  );

  const episodeRows = await database
    .select({
      childId: schema.familyMemoryEpisodes.childId,
      occurredAt: schema.familyMemoryEpisodes.occurredAt,
      episodeType: schema.familyMemoryEpisodes.episodeType,
      summary: schema.familyMemoryEpisodes.summary,
    })
    .from(schema.familyMemoryEpisodes)
    .where(eq(schema.familyMemoryEpisodes.familyId, input.familyId))
    .orderBy(desc(schema.familyMemoryEpisodes.occurredAt))
    .limit(RECENT_EPISODE_LIMIT);

  return {
    parentName: parentRows[0]?.name ?? null,
    location: { city: family.city, province: family.province, country: family.country },
    planTier: family.planTier,
    children,
    focusedChild,
    stages,
    memoryFacts: redactFactsForTeens(
      factRows.map((r) => ({
        childId: r.childId,
        factType: r.factType,
        factKey: r.factKey,
        factValue: r.factValue,
        confidence: r.confidence,
      })),
      stageByChild,
    ),
    recentEpisodes: redactEpisodesForTeens(
      episodeRows.map((r) => ({
        childId: r.childId,
        occurredAt: r.occurredAt.toISOString(),
        episodeType: r.episodeType,
        summary: r.summary,
      })),
      stageByChild,
    ),
    transcript: input.transcript,
    question: input.question,
    intent: input.intent,
  };
}

export const _internal = { toChildContext, toFocusedChild, redactEpisodesForTeens, redactFactsForTeens };
