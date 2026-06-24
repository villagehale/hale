import { type RegisteredTool, defineTool } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { toVillageCandidateView } from '~/lib/village/mappers';
import { countEndorsementsForCandidates } from '~/lib/village/endorse';

/**
 * The village-ranking agent's READ-ONLY tools — the three signals the
 * rank-recommendations / curate-shortlist skills reason over (fit, trust,
 * memory) plus the candidate list itself. Every tool is family-scoped (rule #1: a
 * handler reads only `ctx.familyId`'s rows) and goes through the guarded invoker,
 * which writes an audit row per call (rule #6). None spend money and none write —
 * ranking is a pure read over already-discovered candidates and already-recorded
 * signals.
 *
 * Why these are agent tools and not a scoring function: the ORDER is the moat. The
 * model weighs fit vs trust vs memory with judgement (a strongly on-taste,
 * un-endorsed candidate vs a weakly-fitting, well-endorsed one is a call, not a
 * formula). The tools only expose the SIGNALS; the model decides the ranking.
 *
 * Teen safety (rule #1) is BY CONSTRUCTION, mirroring the Ask Hale tools: these
 * reads don't name a child, so the guard's child-content gate can't reach them.
 * Instead each resolves the family's teen child ids LIVE from DOB and redacts a
 * teen-attributed candidate to category-only at the source (via the shared
 * mapper), before it can reach the model. The endorsement signal is a COUNT only
 * — never a family identity.
 */

const CANDIDATE_LIMIT = 40;

/** The family's children currently in the teenager stage, derived LIVE from DOB
 * (never stored) — the source-side teen filter shared by these child-naming-less
 * reads, identical to the Ask Hale tools' helper. */
async function teenChildIdsForFamily(
  database: Database,
  familyId: string,
): Promise<Set<string>> {
  const children = await database
    .select({ id: schema.children.id, dateOfBirth: schema.children.dateOfBirth })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
  return new Set(children.filter((c) => deriveStage(c.dateOfBirth) === 'teenager').map((c) => c.id));
}

function isTeenAttributed(childId: string | null, teenChildIds: ReadonlySet<string>): boolean {
  return childId !== null && teenChildIds.has(childId);
}

export function buildRankTools(database: Database): RegisteredTool[] {
  const listVillageCandidates = defineTool({
    name: 'list_village_candidates',
    description:
      "List THIS family's already-discovered village candidates to be ranked: each with its id, category (kind), title, and summary. A teen-attributed candidate is redacted to category only (rule #1).",
    inputSchema: z.object({}),
    handler: async (_input, ctx) => {
      const teenChildIds = await teenChildIdsForFamily(database, ctx.familyId);
      const rows = await database
        .select()
        .from(schema.villageCandidates)
        .where(eq(schema.villageCandidates.familyId, ctx.familyId))
        .orderBy(desc(schema.villageCandidates.discoveredAt))
        .limit(CANDIDATE_LIMIT);

      const candidates = rows.map((row) => {
        const view = toVillageCandidateView(row, isTeenAttributed(row.childId, teenChildIds));
        return {
          id: view.id,
          kind: view.kind,
          title: view.title,
          summary: view.summary,
          teenAttributed: view.teenAttributed,
        };
      });
      return { candidates };
    },
  });

  const getFamilyFitContext = defineTool({
    name: 'get_family_fit_context',
    description:
      "The FIT signal: THIS family's non-teen children's derived stages, the family's stated intents (what they came to Hale for), and their coarse area. Teen children are excluded (rule #1).",
    inputSchema: z.object({}),
    handler: async (_input, ctx) => {
      const familyRows = await database
        .select({ areaCoarse: schema.families.areaCoarse, intents: schema.families.intents })
        .from(schema.families)
        .where(eq(schema.families.id, ctx.familyId))
        .limit(1);
      const family = familyRows[0];

      const childRows = await database
        .select({ dateOfBirth: schema.children.dateOfBirth })
        .from(schema.children)
        .where(eq(schema.children.familyId, ctx.familyId));

      const stages = [
        ...new Set(
          childRows
            .map((c) => deriveStage(c.dateOfBirth))
            .filter((stage) => stage !== 'teenager'),
        ),
      ];

      return {
        childStages: stages,
        intents: family?.intents ?? [],
        areaCoarse: family?.areaCoarse ?? null,
      };
    },
  });

  const getFamilyTastes = defineTool({
    name: 'get_family_tastes',
    description:
      "The MEMORY signal: what THIS family has shown they like — currently-valid learned preference/routine facts. Teen-attributed facts are excluded (rule #1). Empty is a valid answer (a new family).",
    inputSchema: z.object({}),
    handler: async (_input, ctx) => {
      const teenChildIds = await teenChildIdsForFamily(database, ctx.familyId);
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
            eq(schema.familyMemoryFacts.familyId, ctx.familyId),
            isNull(schema.familyMemoryFacts.validUntil),
          ),
        )
        .limit(CANDIDATE_LIMIT);

      const tastes = factRows
        .filter((f) => !isTeenAttributed(f.childId, teenChildIds))
        .map(({ childId: _childId, ...fact }) => fact);
      return { tastes };
    },
  });

  const getEndorsementSignals = defineTool({
    name: 'get_endorsement_signals',
    description:
      "The TRUST signal: the distinct-family endorsement count per candidate id (how many families near them vouched for it). A COUNT only, never a family identity (rule #1). Absent ids have 0.",
    inputSchema: z.object({ candidateIds: z.array(z.string()) }),
    handler: async (input, _ctx) => {
      const counts = await countEndorsementsForCandidates(database, input.candidateIds);
      const endorsements = input.candidateIds.map((id) => ({
        candidateId: id,
        endorsementCount: counts.get(id) ?? 0,
      }));
      return { endorsements };
    },
  });

  return [listVillageCandidates, getFamilyFitContext, getFamilyTastes, getEndorsementSignals];
}
