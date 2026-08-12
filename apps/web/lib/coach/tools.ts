import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { type RegisteredTool, defineTool } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { companionForChild, deriveStage } from '@hale/types';
import { readFamilyTimezone } from '~/lib/dashboard/trail-query';
import { frameworkGuidanceTool } from '~/lib/coach/framework-tool';
import { formatCalendarDayLabel } from '~/lib/format/datetime';
import { toVillageCandidateView } from '~/lib/village/mappers';
import { visibleCandidates } from '~/lib/village/visibility';
import { buildConnectorTools } from './connector-tools';

/**
 * The Ask Hale agent's tools — every one family-scoped (rule #1: a handler reads
 * only `ctx.familyId`'s rows, never another family's). The guarded invoker writes
 * the audit row for each call (rule #6) and runs the teen-content check before
 * `get_child_profile`'s handler (rule #1/#5), so the rails are enforced no matter
 * what the model decides to call. None of these spend money; `save_memory` is the
 * only writer and it persists only what the parent stated (rule: no inference).
 *
 * Teen-content (rule #1) defense in depth: `get_child_profile` names a childId, so
 * the guarded invoker's `checkChildContentAccess` gate refuses a teenager before
 * the handler runs. The two reads that DON'T name a child — `search_village` and
 * `search_memory` — can still surface rows attributed to a teen (memory facts and
 * episodes carry a nullable child_id; candidates likewise). The guard can't reach
 * those (no childId in the input to resolve), so each is teen-safe BY
 * CONSTRUCTION instead: it resolves the family's teen child ids LIVE from DOB and
 * drops/redacts any teen-attributed row at the source, before it can reach the
 * model. `search_memory` excludes teen rows outright (facts/episodes carry raw,
 * potentially teen-quoting content); `search_village` redacts to category only via
 * the mapper. `get_framework_guidance` reads no real child data at all.
 *
 * Tools take a `Database` by closure so the same definitions are reused with a
 * test db. The harness validates each tool's zod input at the boundary, so a
 * hallucinated arg is rejected before the handler runs.
 */

const MEMORY_RESULT_LIMIT = 15;

/**
 * The family's children currently in the teenager stage, derived LIVE from DOB
 * (never stored) — the source-side teen filter shared by the child-naming-less
 * reads (`search_memory`, `search_village`) so a teen's row can't slip past the
 * guard those tools never trigger.
 */
async function teenChildIdsForFamily(
  database: Database,
  familyId: string,
): Promise<Set<string>> {
  const children = await database
    .select({ id: schema.children.id, dateOfBirth: schema.children.dateOfBirth })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
  return new Set(
    children.filter((c) => deriveStage(c.dateOfBirth) === 'teenager').map((c) => c.id),
  );
}

function isTeenAttributed(childId: string | null, teenChildIds: ReadonlySet<string>): boolean {
  return childId !== null && teenChildIds.has(childId);
}

const memoryFactType = z.enum([
  'preference',
  'routine',
  'medical',
  'logistic',
  'relationship',
  'voice',
]);

/** One activity Hale may actually put in front of a parent. Every field is non-null
 * by construction — an offer a parent cannot turn up to is not an offer. */
interface OfferableActivity {
  title: string;
  kind: string;
  summary: string;
  venue: string;
  when: string;
}

/**
 * The Village read, as ONE definition shared by every surface that offers it — Ask in
 * the app and Hale over text (VIL-221 · C2). "Improvements compound across surfaces"
 * is only true if they are the same tool; two copies of this handler would be two
 * teen-redaction filters that can drift, which is the failure rule #1 cannot afford.
 *
 * WHAT A CANDIDATE HAS TO HAVE TO BE OFFERED. A row reaches the model as an offer only
 * when its `venue_name` and `event_date` are both present — the two facts a parent needs
 * to actually go. Everything else is a COUNT.
 *
 * This is structural on purpose. Handing the model a title and a blurb and asking it to
 * police its own confidence produced exactly the failure it sounds like: on launch day
 * Hale surfaced a real find and admitted, in the same breath, that it could not confirm
 * the location or the time. That is not honesty, it is the work handed back — and it was
 * unavoidable, because the model was shown a candidate it had no way to describe and its
 * own rules (never name a place or a time no tool returned) then forced the hedge. A
 * candidate it is never shown cannot be hedged about.
 *
 * The count exists so the silence is not a lie either: "two more still being checked" is
 * a true, forward-looking thing to say, and it is all there is to say. A teen-attributed
 * row is in NEITHER bucket — redaction leaves it with no venue and no date, so it can
 * never be offered, and counting it would have Hale promise to come back about a find it
 * must never mention (rule #1).
 */
export function searchVillageTool(database: Database): RegisteredTool {
  return defineTool({
    name: 'search_village',
    description:
      "Local classes, groups, and activities already discovered for THIS family's area, optionally filtered by a free-text query against title/summary. `candidates` are OFFERABLE: each carries a verified `venue` and `when`, so it can be named to a parent whole. `inVerification` is a COUNT of finds whose place or date has not checked out yet — they are deliberately not listed, and there is nothing to tell a parent about them beyond that they are being checked. Teen-attributed candidates appear in neither (rule #1).",
    inputSchema: z.object({ query: z.string().optional() }),
    monetary: false,
    touchesChildContent: false,
    handler: async (input, ctx) => {
      const teenChildIds = await teenChildIdsForFamily(database, ctx.familyId);
      const timeZone = await readFamilyTimezone(database, ctx.familyId);
      const now = new Date();

      const currentRunRows = await database
        .select()
        .from(schema.villageCandidates)
        .where(
          and(
            eq(schema.villageCandidates.familyId, ctx.familyId),
            isNull(schema.villageCandidates.supersededAt),
          ),
        )
        .orderBy(desc(schema.villageCandidates.confidence), desc(schema.villageCandidates.discoveredAt))
        .limit(MEMORY_RESULT_LIMIT);

      const needle = input.query?.toLowerCase();
      const views = visibleCandidates(currentRunRows, now, timeZone)
        .map((row) => toVillageCandidateView(row, isTeenAttributed(row.childId, teenChildIds)))
        .filter(
          (c) =>
            !needle ||
            c.title.toLowerCase().includes(needle) ||
            c.summary.toLowerCase().includes(needle),
        );

      const candidates: OfferableActivity[] = [];
      let inVerification = 0;
      for (const view of views) {
        if (view.teenAttributed) continue;
        const venue = (view.venueName ?? '').trim();
        if (venue === '' || view.eventDate === null) {
          inVerification += 1;
          continue;
        }
        candidates.push({
          title: view.title,
          kind: view.kind,
          summary: view.summary,
          venue,
          when: formatCalendarDayLabel(view.eventDate, now),
        });
      }

      return { candidates, inVerification };
    },
  });
}

export function buildAskHaleTools(database: Database): RegisteredTool[] {
  const getChildProfile = defineTool({
    name: 'get_child_profile',
    description:
      "Read one of THIS family's children by id: derived stage, age in months, and stage-appropriate developmental guidance. A teenager's profile is refused by the child-content guard (rule #1).",
    inputSchema: z.object({ childId: z.string() }),
    monetary: false,
    touchesChildContent: true,
    handler: async (input, ctx) => {
      const rows = await database
        .select({
          id: schema.children.id,
          name: schema.children.name,
          dateOfBirth: schema.children.dateOfBirth,
          gestationalWeeks: schema.children.gestationalWeeks,
          parentingStyleOverrides: schema.children.parentingStyleOverrides,
        })
        .from(schema.children)
        .where(and(eq(schema.children.id, input.childId), eq(schema.children.familyId, ctx.familyId)))
        .limit(1);

      const child = rows[0];
      if (!child) {
        return { found: false as const };
      }
      const companion = companionForChild({ dateOfBirth: child.dateOfBirth, name: child.name });
      return {
        found: true as const,
        name: child.name,
        stage: companion.stage,
        ageMonths: companion.ageMonths,
        gestationalWeeks: child.gestationalWeeks,
        parentingStyleOverrides: child.parentingStyleOverrides,
        whatsNow: companion.whatsNow,
        whatsNext: companion.whatsNext,
      };
    },
  });

  const searchMemory = defineTool({
    name: 'search_memory',
    description:
      "Recall what Hale knows about THIS family: currently-valid memory facts (optionally filtered by type) and recent episodes whose summary matches a free-text query.",
    inputSchema: z.object({
      query: z.string().min(1),
      factType: memoryFactType.optional(),
    }),
    monetary: false,
    touchesChildContent: false,
    handler: async (input, ctx) => {
      const teenChildIds = await teenChildIdsForFamily(database, ctx.familyId);

      const factConditions = [
        eq(schema.familyMemoryFacts.familyId, ctx.familyId),
        isNull(schema.familyMemoryFacts.validUntil),
      ];
      if (input.factType) {
        factConditions.push(eq(schema.familyMemoryFacts.factType, input.factType));
      }
      const factRows = await database
        .select({
          childId: schema.familyMemoryFacts.childId,
          factType: schema.familyMemoryFacts.factType,
          factKey: schema.familyMemoryFacts.factKey,
          factValue: schema.familyMemoryFacts.factValue,
          confidence: schema.familyMemoryFacts.confidence,
        })
        .from(schema.familyMemoryFacts)
        .where(and(...factConditions))
        .limit(MEMORY_RESULT_LIMIT);

      const needle = input.query.toLowerCase();
      const episodeRows = await database
        .select({
          childId: schema.familyMemoryEpisodes.childId,
          occurredAt: schema.familyMemoryEpisodes.occurredAt,
          episodeType: schema.familyMemoryEpisodes.episodeType,
          summary: schema.familyMemoryEpisodes.summary,
        })
        .from(schema.familyMemoryEpisodes)
        .where(eq(schema.familyMemoryEpisodes.familyId, ctx.familyId))
        .orderBy(desc(schema.familyMemoryEpisodes.occurredAt))
        .limit(MEMORY_RESULT_LIMIT);

      return {
        facts: factRows
          .filter((f) => !isTeenAttributed(f.childId, teenChildIds))
          .map(({ childId: _childId, ...fact }) => fact),
        episodes: episodeRows
          .filter((e) => !isTeenAttributed(e.childId, teenChildIds))
          .filter((e) => e.summary.toLowerCase().includes(needle))
          .map((e) => ({
            occurredAt: e.occurredAt.toISOString(),
            episodeType: e.episodeType,
            summary: e.summary,
          })),
      };
    },
  });

  const saveMemory = defineTool({
    name: 'save_memory',
    description:
      "Persist a durable fact the parent STATED about THIS family (a settled routine, a stated preference, a logistic), so Hale recalls it next turn. Upserts on (factType, factKey). Never store inferences — only what the parent actually said.",
    inputSchema: z.object({
      factType: memoryFactType,
      factKey: z.string().min(1),
      factValue: z.unknown(),
    }),
    monetary: false,
    touchesChildContent: false,
    handler: async (input, ctx) => {
      await database
        .update(schema.familyMemoryFacts)
        .set({ validUntil: new Date() })
        .where(
          and(
            eq(schema.familyMemoryFacts.familyId, ctx.familyId),
            eq(schema.familyMemoryFacts.factType, input.factType),
            eq(schema.familyMemoryFacts.factKey, input.factKey),
            isNull(schema.familyMemoryFacts.validUntil),
          ),
        );

      const inserted = await database
        .insert(schema.familyMemoryFacts)
        .values({
          familyId: ctx.familyId,
          factType: input.factType,
          factKey: input.factKey,
          factValue: input.factValue,
          confidence: 1,
          inferredBy: 'ask-hale',
        })
        .returning({ id: schema.familyMemoryFacts.id });

      const factId = inserted[0]?.id;
      if (!factId) {
        throw new Error('save_memory: family_memory_facts insert returned no row');
      }
      return { saved: true as const, factId };
    },
  });

  // Shared with the SMS channel coach since 2026-08-12 (framework-tool.ts): the
  // skill audit caught the two registries drifting — the channel skill instructed
  // a tool only this runtime carried.
  const getFrameworkGuidance = frameworkGuidanceTool();

  return [
    getChildProfile,
    searchMemory,
    saveMemory,
    getFrameworkGuidance,
    searchVillageTool(database),
    ...buildConnectorTools(database),
  ];
}
