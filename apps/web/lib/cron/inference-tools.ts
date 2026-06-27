import { type RegisteredTool, defineTool } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { type FamilyStage, deriveStage } from '@hale/types';
import { and, desc, eq, gte, inArray, isNull } from 'drizzle-orm';
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

/** Marker swapped in for a 13+ child's raw memory content before the inferencer
 * sees it — only the type/key survives, the raw value is withheld (rule #1). */
const TEEN_MEMORY_PLACEHOLDER = '[teen content — withheld from inferencer (rule #1)]';

interface MemorySnapshot {
  recentEvents: { childId: string | null; eventType: string; payload: unknown; receivedAt: string }[];
  recentEpisodes: {
    childId: string | null;
    episodeType: string;
    summary: string;
    occurredAt: string;
  }[];
  currentFacts: {
    childId: string | null;
    factType: string;
    factKey: string;
    factValue: unknown;
    confidence: number;
  }[];
}

/**
 * Strip raw content from any snapshot row scoped to a 13+ child before the
 * memory-inferencer sees it (rule #1): the row's child scope is dropped to null
 * and its raw payload/summary/value is replaced with a marker, so no teen-specific
 * fact can be inferred or stored. Non-teen and family-wide (childId null) rows pass
 * through unchanged. Pure, no I/O — mirrors redactTimelineForDistill.
 */
function redactMemorySnapshotForTeens(
  snapshot: MemorySnapshot,
  stageByChild: ReadonlyMap<string, FamilyStage>,
): MemorySnapshot {
  const isTeen = (childId: string | null) =>
    childId !== null && stageByChild.get(childId) === 'teenager';
  return {
    recentEvents: snapshot.recentEvents.map((e) =>
      isTeen(e.childId)
        ? { childId: null, eventType: e.eventType, payload: TEEN_MEMORY_PLACEHOLDER, receivedAt: e.receivedAt }
        : e,
    ),
    recentEpisodes: snapshot.recentEpisodes.map((e) =>
      isTeen(e.childId)
        ? {
            childId: null,
            episodeType: e.episodeType,
            summary: TEEN_MEMORY_PLACEHOLDER,
            occurredAt: e.occurredAt,
          }
        : e,
    ),
    currentFacts: snapshot.currentFacts.map((f) =>
      isTeen(f.childId)
        ? {
            childId: null,
            factType: f.factType,
            factKey: f.factKey,
            factValue: TEEN_MEMORY_PLACEHOLDER,
            confidence: f.confidence,
          }
        : f,
    ),
  };
}

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

      const childRows = await database
        .select({ id: schema.children.id, dateOfBirth: schema.children.dateOfBirth })
        .from(schema.children)
        .where(eq(schema.children.familyId, ctx.familyId));
      const stageByChild = new Map<string, FamilyStage>(
        childRows.map((c) => [c.id, deriveStage(c.dateOfBirth, now)]),
      );

      const recentEvents = await database
        .select({
          childId: schema.events.childId,
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
          childId: schema.familyMemoryEpisodes.childId,
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
        );

      const snapshot: MemorySnapshot = {
        recentEvents: recentEvents.map((e) => ({
          childId: e.childId,
          eventType: e.eventType,
          payload: e.payload,
          receivedAt: e.receivedAt.toISOString(),
        })),
        recentEpisodes: recentEpisodes.map((e) => ({
          childId: e.childId,
          episodeType: e.episodeType,
          summary: e.summary,
          occurredAt: e.occurredAt.toISOString(),
        })),
        currentFacts,
      };

      return redactMemorySnapshotForTeens(snapshot, stageByChild);
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

/**
 * Chat → memory distillation. The infer-memory agent also reads recent
 * CONVERSATIONS and distills durable, per-child, categorized facts. The teen
 * redaction (rule #1) is STRUCTURAL: a 13+ child's chat turn is reduced to
 * category/summary BEFORE the model sees it (in `read_recent_conversations`), so
 * raw teen content never enters the distiller's input and no teen-specific fact
 * can ever be derived or stored.
 *
 * The five distillation categories (health/development/routines/preferences/
 * concerns) are the parent-facing spec set; each maps onto the existing coarse
 * memory_fact_type enum (no enum migration) while the precise category is kept in
 * the fact value, so nothing is lost.
 */

/** How many days of conversation the distiller reads. */
const CONVERSATION_WINDOW_DAYS = 14;
const CONVERSATION_TURN_LIMIT = 60;

/** The parent-facing distillation categories (the prompt + UI vocabulary). */
const distillCategory = z.enum([
  'health',
  'development',
  'routines',
  'preferences',
  'concerns',
]);
type DistillCategory = z.infer<typeof distillCategory>;

/** Maps a distillation category onto the coarse DB fact-type enum (no migration). */
const CATEGORY_TO_FACT_TYPE: Record<DistillCategory, 'medical' | 'routine' | 'preference' | 'relationship'> =
  {
    health: 'medical',
    development: 'relationship',
    routines: 'routine',
    preferences: 'preference',
    concerns: 'relationship',
  };

interface RawTimelineTurn {
  childId: string | null;
  role: 'user' | 'assistant';
  content: string;
  topic: string | null;
}

interface DistillTurn {
  childId: string | null;
  role: 'user' | 'assistant';
  /** Raw content for a non-teen turn; a redaction marker for a teen turn. */
  content: string;
  topic: string | null;
  /** True iff this turn was a 13+ child's content, reduced to category only (rule #1). */
  redacted?: boolean;
}

const TEEN_DISTILL_PLACEHOLDER = '[teen content — category only, raw text withheld (rule #1)]';

/**
 * Reduce a conversation timeline to what the distiller may see. A turn focused on
 * a 13+ child is stripped to its topic/category and a redaction marker, and its
 * child scope is dropped to null so no teen-specific fact can be derived (rule #1).
 * Non-teen and family-wide turns pass through unchanged.
 */
function redactTimelineForDistill(
  turns: readonly RawTimelineTurn[],
  stageByChild: ReadonlyMap<string, FamilyStage>,
): DistillTurn[] {
  return turns.map((turn) => {
    const isTeen = turn.childId !== null && stageByChild.get(turn.childId) === 'teenager';
    if (isTeen) {
      return {
        childId: null,
        role: turn.role,
        content: TEEN_DISTILL_PLACEHOLDER,
        topic: turn.topic,
        redacted: true,
      };
    }
    return { childId: turn.childId, role: turn.role, content: turn.content, topic: turn.topic };
  });
}

/**
 * The chat-distiller's tools — the conversation-reading + per-child save the
 * infer-memory agent uses on top of its event/episode tools. Family-scoped (rule
 * #1); every save runs through the guarded invoker (audited, rule #6) and is held
 * to the same 0.7 confidence floor as inferred facts.
 */
export function buildDistillTools(database: Database, now: Date = new Date()): RegisteredTool[] {
  const readRecentConversations = defineTool({
    name: 'read_recent_conversations',
    description:
      "Read THIS family's recent Ask Hale conversation turns (the last two weeks). A 13+ child's turns are already reduced to category/summary — raw teen content is never shown (rule #1). Use these to distill durable, per-child facts.",
    inputSchema: z.object({}),
    handler: async (_input, ctx) => {
      const since = new Date(now.getTime() - CONVERSATION_WINDOW_DAYS * 24 * 60 * 60 * 1000);

      const childRows = await database
        .select({ id: schema.children.id, dateOfBirth: schema.children.dateOfBirth })
        .from(schema.children)
        .where(eq(schema.children.familyId, ctx.familyId));
      const stageByChild = new Map<string, FamilyStage>(
        childRows.map((c) => [c.id, deriveStage(c.dateOfBirth, now)]),
      );

      const familyConversations = await database
        .select({ id: schema.conversations.id })
        .from(schema.conversations)
        .where(eq(schema.conversations.familyId, ctx.familyId));
      const conversationIds = familyConversations.map((c) => c.id);
      if (conversationIds.length === 0) {
        return { turns: [] };
      }

      const turnRows = await database
        .select({
          childId: schema.messages.childId,
          role: schema.messages.role,
          content: schema.messages.content,
          topic: schema.messages.topic,
        })
        .from(schema.messages)
        .where(
          and(
            inArray(schema.messages.conversationId, conversationIds),
            gte(schema.messages.createdAt, since),
          ),
        )
        .orderBy(desc(schema.messages.createdAt))
        .limit(CONVERSATION_TURN_LIMIT);

      const raw: RawTimelineTurn[] = turnRows.map((r) => ({
        childId: r.childId,
        role: r.role,
        content: r.content,
        topic: r.topic,
      }));

      return { turns: redactTimelineForDistill(raw, stageByChild) };
    },
  });

  const saveChildFact = defineTool({
    name: 'save_child_fact',
    description:
      "Persist ONE durable, categorized fact distilled from conversation about a specific child (or family-wide with childId omitted), confidence in [0,1]. Categories: health, development, routines, preferences, concerns. Facts below 0.7 confidence are REFUSED. NEVER pass raw teen content — only a category/summary.",
    inputSchema: z.object({
      childId: z.string().uuid().nullish(),
      category: distillCategory,
      factKey: z.string().min(1),
      summary: z.string().min(1),
      confidence: z.number().min(0).max(1),
    }),
    handler: async (input, ctx) => {
      if (input.confidence < CONFIDENCE_FLOOR) {
        return { saved: false as const, reason: 'below_confidence_floor' };
      }

      const factType = CATEGORY_TO_FACT_TYPE[input.category];
      const childId = input.childId ?? null;

      await database
        .update(schema.familyMemoryFacts)
        .set({ validUntil: now })
        .where(
          and(
            eq(schema.familyMemoryFacts.familyId, ctx.familyId),
            eq(schema.familyMemoryFacts.factType, factType),
            eq(schema.familyMemoryFacts.factKey, input.factKey),
            isNull(schema.familyMemoryFacts.validUntil),
          ),
        );

      const inserted = await database
        .insert(schema.familyMemoryFacts)
        .values({
          familyId: ctx.familyId,
          childId,
          factType,
          factKey: input.factKey,
          factValue: { category: input.category, summary: input.summary },
          confidence: input.confidence,
          inferredBy: 'chat_distiller',
        })
        .returning({ id: schema.familyMemoryFacts.id });

      const factId = inserted[0]?.id;
      if (!factId) {
        throw new Error('save_child_fact: family_memory_facts insert returned no row');
      }
      return { saved: true as const, factId };
    },
  });

  return [readRecentConversations, saveChildFact];
}

export const _internal = { redactTimelineForDistill, redactMemorySnapshotForTeens };
