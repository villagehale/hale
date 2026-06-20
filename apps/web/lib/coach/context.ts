import { and, desc, eq, isNull } from 'drizzle-orm';
import { type Database, schema } from '@hale/db';
import { ageInMonths, deriveStage, type FamilyStage } from '@hale/types';
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
 * longitudinal recall; the running transcript gives it the multi-turn thread.
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

export interface MemoryFactContext {
  factType: string;
  factKey: string;
  factValue: unknown;
  confidence: number;
}

export interface MemoryEpisodeContext {
  occurredAt: string;
  episodeType: string;
  summary: string;
}

export interface AgentContext {
  /** The signed-in parent's display name, when known. */
  parentName: string | null;
  /** Coarse location only — never a precise address (rule #1). */
  location: { city: string | null; province: string | null; country: string | null };
  planTier: schema.Family['planTier'];
  children: ChildContext[];
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
  transcript: TranscriptMessage[];
}

/**
 * Assembles the agent context for a family in one place. Reads only the caller's
 * family (every query is keyed on familyId). Teen children are reduced to stage
 * at the mapper, so their raw detail never enters the assembled context.
 */
export async function loadAgentContext(
  input: LoadAgentContextInput,
  database: Database,
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

  const factRows = await database
    .select({
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

  const episodeRows = await database
    .select({
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
    stages,
    memoryFacts: factRows.map((r) => ({
      factType: r.factType,
      factKey: r.factKey,
      factValue: r.factValue,
      confidence: r.confidence,
    })),
    recentEpisodes: episodeRows.map((r) => ({
      occurredAt: r.occurredAt.toISOString(),
      episodeType: r.episodeType,
      summary: r.summary,
    })),
    transcript: input.transcript,
    question: input.question,
    intent: input.intent,
  };
}

export const _internal = { toChildContext };
