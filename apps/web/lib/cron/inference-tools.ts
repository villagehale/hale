import { type RegisteredTool, defineTool } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { and, desc, eq, gte, isNull } from 'drizzle-orm';
import { z } from 'zod';

/**
 * The memory-inferencer agent's tools — family-scoped (rule #1) and run through
 * the guarded invoker so every WRITE is audited (rule #6). Mirrors the worker's
 * runMemoryInferencer web-side without importing its internal module:
 *
 *   read_recent_memory → the family's recent events/episodes + currently-valid
 *     facts (the snapshot the model diffs against). Read-only.
 *   save_memory        → upsert ONE inferred fact, with the hard 0.7 confidence
 *     floor enforced in the handler (not just the prompt): a fact below the floor
 *     is REFUSED at the boundary, never written. Each save audits via invokeTool.
 *
 * The 0.7 floor lives here as well as in the skill because a wrong fact poisons
 * every downstream draft — the precision bar is a code-level invariant, not a
 * model promise (the same belt-and-braces the worker uses).
 */

/** Facts below this confidence are refused, never written — the worker's
 * CONFIDENCE_FLOOR, enforced at the tool boundary. */
export const CONFIDENCE_FLOOR = 0.7;

/** How many days of recent activity the inferencer reads. */
const WINDOW_DAYS = 7;

/** How many recent rows the snapshot carries — bounded so the prompt stays small. */
const RECENT_LIMIT = 30;

const memoryFactType = z.enum([
  'preference',
  'routine',
  'medical',
  'logistic',
  'relationship',
  'voice',
]);

export function buildInferenceTools(
  database: Database,
  now: Date = new Date(),
): RegisteredTool[] {
  const readRecentMemory = defineTool({
    name: 'read_recent_memory',
    description:
      "Read THIS family's recent activity (events + episodes in the last week) and its currently-valid memory facts — the snapshot to diff against when inferring new facts.",
    inputSchema: z.object({}),
    handler: async (_input, ctx) => {
      const since = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

      const recentEvents = await database
        .select({
          eventType: schema.events.eventType,
          payload: schema.events.payload,
          receivedAt: schema.events.receivedAt,
        })
        .from(schema.events)
        .where(
          and(
            eq(schema.events.familyId, ctx.familyId),
            gte(schema.events.receivedAt, since),
          ),
        )
        .orderBy(desc(schema.events.receivedAt))
        .limit(RECENT_LIMIT);

      const recentEpisodes = await database
        .select({
          episodeType: schema.familyMemoryEpisodes.episodeType,
          summary: schema.familyMemoryEpisodes.summary,
          occurredAt: schema.familyMemoryEpisodes.occurredAt,
        })
        .from(schema.familyMemoryEpisodes)
        .where(eq(schema.familyMemoryEpisodes.familyId, ctx.familyId))
        .orderBy(desc(schema.familyMemoryEpisodes.occurredAt))
        .limit(RECENT_LIMIT);

      const currentFacts = await database
        .select({
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
        );

      return {
        recentEvents: recentEvents.map((e) => ({
          eventType: e.eventType,
          payload: e.payload,
          receivedAt: e.receivedAt.toISOString(),
        })),
        recentEpisodes: recentEpisodes.map((e) => ({
          episodeType: e.episodeType,
          summary: e.summary,
          occurredAt: e.occurredAt.toISOString(),
        })),
        currentFacts,
      };
    },
  });

  const saveMemory = defineTool({
    name: 'save_memory',
    description:
      "Persist ONE high-precision fact inferred about THIS family, with a confidence in [0,1]. Facts below 0.7 confidence are REFUSED — do not call this for a hunch. Upserts on (factType, factKey): a new value supersedes the old one.",
    inputSchema: z.object({
      factType: memoryFactType,
      factKey: z.string().min(1),
      factValue: z.unknown(),
      confidence: z.number().min(0).max(1),
    }),
    handler: async (input, ctx) => {
      // The 0.7 floor is a code-level invariant, not just a prompt rule: a fact
      // below it is dropped here, never written (mirrors the worker inferencer).
      if (input.confidence < CONFIDENCE_FLOOR) {
        return { saved: false as const, reason: 'below_confidence_floor' };
      }

      await database
        .update(schema.familyMemoryFacts)
        .set({ validUntil: now })
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
          confidence: input.confidence,
          inferredBy: 'memory_inferencer',
        })
        .returning({ id: schema.familyMemoryFacts.id });

      const factId = inserted[0]?.id;
      if (!factId) {
        throw new Error('save_memory: family_memory_facts insert returned no row');
      }
      return { saved: true as const, factId };
    },
  });

  return [readRecentMemory, saveMemory];
}
