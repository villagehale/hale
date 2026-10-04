import { type RegisteredTool, defineTool } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { type FamilyStage, deriveStage } from '@hale/types';
import { and, desc, eq, gte, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  commitClassifiedMemory,
  modelClassificationShape,
  promptKind,
  readDisposition,
} from '~/lib/memory/classify-write';
import { distillFactNeedsEvidence, guardChatDistilledFact } from '~/lib/memory/distill-guard';
import type { DistillGuardDecision } from '~/lib/memory/distill-guard';
import { CONFIDENCE_FLOOR } from '~/lib/memory/facts';

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

export { CONFIDENCE_FLOOR } from '~/lib/memory/facts';

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
  recentEvents: {
    childId: string | null;
    eventType: string;
    payload: unknown;
    receivedAt: string;
  }[];
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
    /** Model vocabulary, so a later pass can weigh the fact. Absent on older fixtures. */
    kind?: string;
    disposition?: string;
    source?: string;
    expiresAt?: string | null;
  }[];
}

/**
 * Strip raw content from any snapshot row scoped to a 13+ child before the
 * memory-inferencer sees it (rule #1): the row's child scope is dropped to null
 * and its raw payload/summary/value — and a fact's free-text factKey — is replaced
 * with a marker, so no teen-specific fact can be inferred or stored. Non-teen and
 * family-wide (childId null) rows pass
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
        ? {
            childId: null,
            eventType: e.eventType,
            payload: TEEN_MEMORY_PLACEHOLDER,
            receivedAt: e.receivedAt,
          }
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
            factKey: TEEN_MEMORY_PLACEHOLDER,
            factValue: TEEN_MEMORY_PLACEHOLDER,
            confidence: f.confidence,
            ...(f.kind ? { kind: f.kind } : {}),
            ...(f.disposition ? { disposition: f.disposition } : {}),
            ...(f.source ? { source: f.source } : {}),
            ...(f.expiresAt ? { expiresAt: f.expiresAt } : {}),
          }
        : f,
    ),
  };
}

export function buildInferenceTools(database: Database, now: Date = new Date()): RegisteredTool[] {
  const readRecentMemory = defineTool({
    name: 'read_recent_memory',
    description:
      "Read THIS family's recent activity (events + episodes in the last week) and its currently-valid memory facts — the snapshot to diff against when inferring new facts. Each fact includes kind, disposition, source, and expiry so a declined or passing fact is not saved again as identity.",
    inputSchema: z.object({}),
    monetary: false,
    touchesChildContent: false,
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
        .where(and(eq(schema.events.familyId, ctx.familyId), gte(schema.events.receivedAt, since)))
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
          memoryKind: schema.familyMemoryFacts.memoryKind,
          memorySource: schema.familyMemoryFacts.memorySource,
          expiresAt: schema.familyMemoryFacts.expiresAt,
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
        currentFacts: currentFacts.map((fact) => ({
          childId: fact.childId,
          factType: fact.factType,
          factKey: fact.factKey,
          factValue: fact.factValue,
          confidence: fact.confidence,
          kind: promptKind(fact.memoryKind, fact.factValue),
          disposition: readDisposition(fact.factValue),
          source: fact.memorySource,
          expiresAt: fact.expiresAt ? fact.expiresAt.toISOString() : null,
        })),
      };

      return redactMemorySnapshotForTeens(snapshot, stageByChild);
    },
  });

  const saveMemory = defineTool({
    name: 'save_memory',
    description:
      "Persist ONE fact inferred about THIS family, with a confidence in [0,1]. Facts below 0.7 confidence are REFUSED. Classify it: memoryClass enduring, obligation, or curiosity, and disposition confirmed, declined, or asked. A declined or rejected activity is declined, never confirmed, and observedAt is the event's own time. A passing question is curiosity and asked, not a preference, until a later save classifies the same fact as enduring. Upserts on (factType, factKey). Pass correctsKey when this replaces a different key. Pass observedAt (ISO-8601) for WHEN it became true, not when you read it. Omit it if the source carries no time; never guess. Save only what the parent said or confirmed. A suggested or found activity, and anything Hale proposed, is not enrollment, registration, signup, or the family's pick. Do not write enrolled, enrollment, signed up, booked, or registered unless a booking or family event already records that activity.",
    inputSchema: z.object({
      factType: memoryFactType,
      factKey: z.string().min(1),
      factValue: z.unknown(),
      confidence: z.number().min(0).max(1),
      observedAt: z.string().optional(),
      ...modelClassificationShape,
    }),
    monetary: false,
    touchesChildContent: false,
    handler: async (input, ctx) => {
      // The 0.7 floor is a code-level invariant, not just a prompt rule: a fact
      // below it is dropped here, never written (mirrors the worker inferencer).
      if (input.confidence < CONFIDENCE_FLOOR) {
        return { saved: false as const, reason: 'below_confidence_floor' };
      }

      const decision = await decideDistilledFact(
        database,
        ctx.familyId,
        now,
        input.factKey,
        flattenFactValue(input.factValue),
      );
      if (decision.action !== 'keep') {
        logDistillRefusal(ctx.familyId, input.factKey, decision);
        return { saved: false as const, reason: decision.reason };
      }

      const { factId } = await commitClassifiedMemory(database, {
        familyId: ctx.familyId,
        childId: null,
        factType: input.factType,
        factKey: input.factKey,
        factValue: input.factValue,
        confidence: input.confidence,
        inferredBy: 'memory_inferencer',
        source: 'inferred',
        now,
        omittedClass: 'curiosity',
        memoryClass: input.memoryClass,
        disposition: input.disposition,
        observedAt: input.observedAt,
        expiresAt: input.expiresAt,
        correctsKey: input.correctsKey,
      });
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
const distillCategory = z.enum(['health', 'development', 'routines', 'preferences', 'concerns']);
type DistillCategory = z.infer<typeof distillCategory>;

/** Maps a distillation category onto the coarse DB fact-type enum (no migration). */
const CATEGORY_TO_FACT_TYPE: Record<
  DistillCategory,
  'medical' | 'routine' | 'preference' | 'relationship'
> = {
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
 * The turns `read_recent_conversations` shows the model. The save guard reads
 * the same window, so a fact is judged against the text the distiller saw.
 */
async function loadDistillTurns(
  database: Database,
  familyId: string,
  now: Date,
): Promise<DistillTurn[]> {
  const since = new Date(now.getTime() - CONVERSATION_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const childRows = await database
    .select({ id: schema.children.id, dateOfBirth: schema.children.dateOfBirth })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
  const stageByChild = new Map<string, FamilyStage>(
    childRows.map((c) => [c.id, deriveStage(c.dateOfBirth, now)]),
  );

  const familyConversations = await database
    .select({ id: schema.conversations.id })
    .from(schema.conversations)
    .where(eq(schema.conversations.familyId, familyId));
  const conversationIds = familyConversations.map((c) => c.id);
  if (conversationIds.length === 0) return [];

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

  return redactTimelineForDistill(
    turnRows.map((row) => ({
      childId: row.childId,
      role: row.role,
      content: row.content,
      topic: row.topic,
    })),
    stageByChild,
  );
}

const RECEIPT_LIMIT = 100;

/** Live bookings and family events. A cancelled booking or a deleted event does not
 *  back an enrollment sentence. */
async function loadDistillReceipts(
  database: Database,
  familyId: string,
): Promise<{ title: string }[]> {
  const [bookings, events] = await Promise.all([
    database
      .select({ title: schema.activityBookings.title })
      .from(schema.activityBookings)
      .where(
        and(
          eq(schema.activityBookings.familyId, familyId),
          isNull(schema.activityBookings.cancelledAt),
        ),
      )
      .limit(RECEIPT_LIMIT),
    database
      .select({ title: schema.familyEvents.title })
      .from(schema.familyEvents)
      .where(and(eq(schema.familyEvents.familyId, familyId), isNull(schema.familyEvents.deletedAt)))
      .limit(RECEIPT_LIMIT),
  ]);
  return [...bookings, ...events];
}

function flattenFactValue(factValue: unknown): string {
  if (typeof factValue === 'string') return factValue;
  return JSON.stringify(factValue) ?? '';
}

function logDistillRefusal(
  familyId: string,
  factKey: string,
  decision: Exclude<DistillGuardDecision, { action: 'keep' }>,
): void {
  console.warn(
    { familyId, factKey, decision: decision.action, reason: decision.reason },
    'chat distiller: suggestion was not stored as enrollment',
  );
}

async function decideDistilledFact(
  database: Database,
  familyId: string,
  now: Date,
  factKey: string,
  summary: string,
): Promise<DistillGuardDecision> {
  if (!distillFactNeedsEvidence(factKey, summary)) return { action: 'keep' };
  const [turns, receipts] = await Promise.all([
    loadDistillTurns(database, familyId, now),
    loadDistillReceipts(database, familyId),
  ]);
  return guardChatDistilledFact({
    factKey,
    summary,
    turns: turns.map((turn) => ({ role: turn.role, content: turn.content })),
    receipts,
  });
}

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
    monetary: false,
    touchesChildContent: false,
    handler: async (_input, ctx) => ({
      turns: await loadDistillTurns(database, ctx.familyId, now),
    }),
  });

  const saveChildFact = defineTool({
    name: 'save_child_fact',
    description:
      "Persist ONE categorized fact distilled from what the PARENT said or confirmed about a specific child (or family-wide with childId omitted), confidence in [0,1]. Categories: health, development, routines, preferences, concerns. Classify it: memoryClass enduring, obligation, or curiosity, and disposition confirmed, declined, or asked. A declined or rejected activity is declined, never confirmed, and observedAt is the event's own time. A passing question is curiosity and asked, not a preference, until a later save classifies it as enduring. Facts below 0.7 confidence are REFUSED. NEVER pass raw teen content — only a category/summary. Pass correctsKey when this replaces a different key. A suggested or found activity, and anything Hale proposed, is not enrollment, registration, signup, or the family's pick. Do not put enrolled, enrollment, signed up, booked, or registered in the summary unless a booking or family event already records that activity.",
    inputSchema: z.object({
      childId: z.string().uuid().nullish(),
      category: distillCategory,
      factKey: z.string().min(1),
      summary: z.string().min(1),
      confidence: z.number().min(0).max(1),
      observedAt: z.string().optional(),
      ...modelClassificationShape,
    }),
    monetary: false,
    // VIL-269: this input NAMES a child, so the guarded invoker's teen check resolves
    // it before the handler runs — the same gate get_child_profile gets. The redaction
    // above is what the model SEES; this is what it may WRITE, and the two need
    // separate enforcement: a childId the distiller never read from a turn (a
    // hallucinated uuid, another family's, or a teen's) is refused rather than
    // persisted as a fact scoped to that child (rule #1/#5).
    touchesChildContent: true,
    handler: async (input, ctx) => {
      if (input.confidence < CONFIDENCE_FLOOR) {
        return { saved: false as const, reason: 'below_confidence_floor' };
      }

      const decision = await decideDistilledFact(
        database,
        ctx.familyId,
        now,
        input.factKey,
        input.summary,
      );
      if (decision.action === 'drop') {
        logDistillRefusal(ctx.familyId, input.factKey, decision);
        return { saved: false as const, reason: decision.reason };
      }
      const summary = decision.action === 'rewrite' ? decision.summary : input.summary;
      if (decision.action === 'rewrite') {
        logDistillRefusal(ctx.familyId, input.factKey, decision);
      }

      const childId = input.childId ?? null;
      const factType = CATEGORY_TO_FACT_TYPE[input.category];
      const { factId } = await commitClassifiedMemory(database, {
        familyId: ctx.familyId,
        childId,
        factType,
        factKey: input.factKey,
        factValue: { category: input.category, summary },
        confidence: input.confidence,
        inferredBy: 'chat_distiller',
        source: 'inferred',
        now,
        omittedClass: 'curiosity',
        memoryClass: input.memoryClass,
        disposition: input.disposition,
        observedAt: input.observedAt,
        expiresAt: input.expiresAt,
        correctsKey: input.correctsKey,
      });
      return { saved: true as const, factId };
    },
  });

  return [readRecentConversations, saveChildFact];
}

export const _internal = { redactTimelineForDistill, redactMemorySnapshotForTeens };
