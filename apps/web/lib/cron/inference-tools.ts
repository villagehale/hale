import {
  type GuardResult,
  type RegisteredTool,
  defineTool,
  markUntrustedTree,
  untrustedSourceFor,
} from '@hale/agent';
import { type Database, householdFamilyEvent, schema } from '@hale/db';
import { type FamilyStage, deriveStage } from '@hale/types';
import {
  episodesForContext,
  factsForContext,
  namesAnyIn,
  teenRoster,
} from '@hale/worker/memory-context';
import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { EXAMPLE_CHILD_ID } from '~/lib/coach/tools';
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
/** How many current facts the snapshot carries to diff against. */
const CURRENT_FACT_LIMIT = 100;

/**
 * VIL-599 · the nightly writer cannot say which adult a fact came from: the family's
 * conversation is one thread whose turns name no author, and an event names no speaker.
 * Its facts are held back from every adult while another is on record, until a write
 * made at the turn (which knows the speaker) replaces them.
 */
const NIGHTLY_HEARD = 'unrecorded' as const;

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
  /** Who a save may name as its subject. A 13+ child carries no name and is never one. */
  children: { childId: string; name: string | null; stage: FamilyStage }[];
  recentEvents: {
    /** What `save_memory`'s `sourceEventId` names. Null once the event is redacted. */
    eventId: string | null;
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
 * Strip raw content from any recent event scoped to a 13+ child before the
 * memory-inferencer sees it (rule #1): the child scope is dropped to null and the raw
 * payload replaced with a marker, so no teen-specific fact can be inferred or stored.
 * An event whose payload names a 13+ child is treated the same way, whatever child it
 * is filed under: an inbound text carries no child id, so the name is the only sign it
 * is about the teen (VIL-598 leg A found this one).
 * Facts and episodes need no pass here: the shared prompt read never returns a teen's.
 */
function redactEventsForTeens(
  events: MemorySnapshot['recentEvents'],
  stageByChild: ReadonlyMap<string, FamilyStage>,
  teenNames: readonly string[],
): MemorySnapshot['recentEvents'] {
  return events.map((e) =>
    (e.childId !== null && stageByChild.get(e.childId) === 'teenager') ||
    namesAnyIn(e.payload, teenNames)
      ? {
          eventId: null,
          childId: null,
          eventType: e.eventType,
          payload: TEEN_MEMORY_PLACEHOLDER,
          receivedAt: e.receivedAt,
        }
      : e,
  );
}

interface ChildRow {
  id: string;
  name: string;
  dateOfBirth: string;
}

/**
 * The family's children and its recent events as the inferencer sees them, teen-redacted.
 * `read_recent_memory` shows these, and `save_memory` reads them again, so a source is
 * only ever an event this run showed: never another family's, never one the redaction
 * withheld, never one outside the window.
 */
async function loadSnapshotEvents(
  database: Database,
  familyId: string,
  now: Date,
): Promise<{
  childRows: ChildRow[];
  stageByChild: Map<string, FamilyStage>;
  recentEvents: MemorySnapshot['recentEvents'];
}> {
  const since = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const childRows = await database
    .select({
      id: schema.children.id,
      name: schema.children.name,
      dateOfBirth: schema.children.dateOfBirth,
    })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
  const stageByChild = new Map<string, FamilyStage>(
    childRows.map((c) => [c.id, deriveStage(c.dateOfBirth, now)]),
  );

  const rows = await database
    .select({
      id: schema.events.id,
      childId: schema.events.childId,
      eventType: schema.events.eventType,
      payload: schema.events.payload,
      receivedAt: schema.events.receivedAt,
    })
    .from(schema.events)
    .where(and(eq(schema.events.familyId, familyId), gte(schema.events.receivedAt, since)))
    .orderBy(desc(schema.events.receivedAt))
    .limit(RECENT_LIMIT);

  const recentEvents = redactEventsForTeens(
    rows.map((e) => ({
      eventId: e.id,
      childId: e.childId,
      eventType: e.eventType,
      payload: e.payload,
      receivedAt: e.receivedAt.toISOString(),
    })),
    stageByChild,
    childRows.filter((c) => stageByChild.get(c.id) === 'teenager').map((c) => c.name),
  );
  return { childRows, stageByChild, recentEvents };
}

async function snapshotShowsEvent(
  database: Database,
  familyId: string,
  now: Date,
  eventId: string,
): Promise<boolean> {
  const { recentEvents } = await loadSnapshotEvents(database, familyId, now);
  return recentEvents.some((event) => event.eventId === eventId);
}

export function buildInferenceTools(database: Database, now: Date = new Date()): RegisteredTool[] {
  const readRecentMemory = defineTool({
    name: 'read_recent_memory',
    description:
      "Read THIS family's children, recent activity (events + episodes in the last week) and its currently-valid memory facts — the snapshot to diff against when inferring new facts. Each fact includes kind, disposition, source, and expiry so a declined or passing fact is not saved again as identity. A child with stage teenager has no name and is never the subject of a save.",
    inputSchema: z.object({}),
    monetary: false,
    touchesChildContent: false,
    handler: async (_input, ctx) => {
      const { childRows, stageByChild, recentEvents } = await loadSnapshotEvents(
        database,
        ctx.familyId,
        now,
      );

      const [recentEpisodes, currentFacts] = await Promise.all([
        episodesForContext(database, ctx.familyId, { now, limit: RECENT_LIMIT }),
        factsForContext(database, ctx.familyId, {
          now,
          reader: 'memory_writer',
          limit: CURRENT_FACT_LIMIT,
        }),
      ]);

      const snapshot: MemorySnapshot = {
        children: childRows.map((c) => {
          const stage = stageByChild.get(c.id) as FamilyStage;
          return { childId: c.id, name: stage === 'teenager' ? null : c.name, stage };
        }),
        recentEvents: recentEvents.map((event) => ({
          ...event,
          payload:
            event.payload === TEEN_MEMORY_PLACEHOLDER
              ? event.payload
              : markUntrustedTree(untrustedSourceFor(event.eventType), event.payload),
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

      return snapshot;
    },
  });

  const saveMemory = defineTool({
    name: 'save_memory',
    description:
      "Persist ONE fact inferred about THIS family, with a confidence in [0,1]. Name its subject: childId is a childId from read_recent_memory's children when the fact is about that child, or null when it is about the whole family. Facts below 0.7 confidence are REFUSED. Classify it: memoryClass enduring, obligation, or curiosity, and disposition confirmed, declined, or asked. Set record to age when the fact is the child's age or birth, or place when it is where the family lives; omit record otherwise. The key's spelling is not that signal. A declined or rejected activity is declined, never confirmed, and observedAt is the event's own time. A passing question is curiosity and asked, not a preference, until a later save classifies the same fact as enduring. Upserts on (factType, factKey). Pass correctsKey when this replaces a different key. When the fact rests on recent events, pass sourceEventId: the eventId of the newest one it rests on. Pass observedAt (ISO-8601) for WHEN it became true, not when you read it. Omit it if the source carries no time; never guess. Save only what the parent said or confirmed. A suggested or found activity, and anything Hale proposed, is not enrollment, registration, signup, or the family's pick. Do not write enrolled, enrollment, signed up, booked, or registered unless a booking or family event already records that activity.",
    inputSchema: z.object({
      childId: z.string().uuid().nullable(),
      factType: memoryFactType,
      factKey: z.string().min(1),
      factValue: z.unknown(),
      confidence: z.number().min(0).max(1),
      observedAt: z.string().optional(),
      sourceEventId: z.string().uuid().nullable().optional(),
      ...modelClassificationShape,
    }),
    // Invented values only: examples are cached outside message protections (rule #1).
    inputExamples: [
      {
        childId: EXAMPLE_CHILD_ID,
        factType: 'routine',
        factKey: 'afternoon_nap',
        factValue: 'one nap, 1pm to 3pm, most days for a month',
        confidence: 0.85,
        memoryClass: 'enduring',
        disposition: 'confirmed',
      },
      {
        childId: null,
        factType: 'preference',
        factKey: 'saturday_swim_trial',
        factValue: 'declined the Saturday swim trial',
        confidence: 0.95,
        observedAt: '2026-03-14T14:00:00.000Z',
        memoryClass: 'obligation',
        disposition: 'declined',
      },
      {
        childId: EXAMPLE_CHILD_ID,
        factType: 'preference',
        factKey: 'toddler_pottery',
        factValue: 'asked once about a toddler pottery class',
        confidence: 0.8,
        memoryClass: 'curiosity',
        disposition: 'asked',
      },
    ],
    monetary: false,
    // The input names a child, so the guarded invoker refuses a childId outside this
    // family or a 13+ child's before the handler runs (rule #1), as for save_child_fact.
    touchesChildContent: true,
    childContentGate: (input, ctx) => teenNameGate(database, ctx.familyId, now, input),
    handler: async (input, ctx) => {
      // The 0.7 floor is a code-level invariant, not just a prompt rule: a fact
      // below it is dropped here, never written (mirrors the worker inferencer).
      if (input.confidence < CONFIDENCE_FLOOR) {
        return { saved: false as const, reason: 'below_confidence_floor' };
      }
      const sourceEventId = input.sourceEventId ?? undefined;
      if (
        sourceEventId &&
        !(await snapshotShowsEvent(database, ctx.familyId, now, sourceEventId))
      ) {
        return { saved: false as const, reason: 'unknown_source_event' };
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
        childId: input.childId,
        factType: input.factType,
        factKey: input.factKey,
        factValue: input.factValue,
        confidence: input.confidence,
        inferredBy: 'memory_inferencer',
        source: 'inferred',
        sourceEventId,
        heard: NIGHTLY_HEARD,
        now,
        memoryClass: input.memoryClass,
        disposition: input.disposition,
        observedAt: input.observedAt,
        expiresAt: input.expiresAt,
        correctsKey: input.correctsKey,
        record: input.record,
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
    .select({
      id: schema.children.id,
      name: schema.children.name,
      dateOfBirth: schema.children.dateOfBirth,
    })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
  const stageByChild = new Map<string, FamilyStage>(
    childRows.map((c) => [c.id, deriveStage(c.dateOfBirth, now)]),
  );
  const teenNames = childRows
    .filter((c) => stageByChild.get(c.id) === 'teenager')
    .map((c) => c.name);

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
        isNull(schema.messages.deletedAt),
        // VIL-616: a reply written after `read_email` may repeat a stranger's name,
        // number or code. The router marks its row, and no fact is learned from it.
        sql`coalesce(${schema.messages.source} ->> 'kind', '') <> 'read_email'`,
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
    teenNames,
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
      .where(and(eq(schema.familyEvents.familyId, familyId), householdFamilyEvent()))
      .limit(RECEIPT_LIMIT),
  ]);
  return [...bookings, ...events];
}

/**
 * A save whose text names a 13+ child is refused (rule #1), whoever it is filed
 * under. A text turn carries no child id, and a model can file a teen's news under a
 * younger sibling, so the name is checked on every save. The guarded invoker's age
 * gate has already refused a save filed under the teen. This runs as the saves'
 * `childContentGate`, BEFORE the audit row, so a refused save's words never reach
 * audit_log (VIL-618).
 */
async function teenNameGate(
  database: Database,
  familyId: string,
  now: Date,
  values: unknown,
): Promise<GuardResult> {
  const { names } = await teenRoster(database, familyId, now);
  return namesAnyIn(values, names)
    ? { ok: false, reason: 'names_teen' }
    : { ok: true, reason: 'names_no_teen' };
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
 * A turn that names a 13+ child is treated the same way, whatever child it is filed
 * under: a text turn never carries a child id, so the name is the only sign it is
 * about the teen.
 * Other turns pass through unchanged.
 */
function redactTimelineForDistill(
  turns: readonly RawTimelineTurn[],
  stageByChild: ReadonlyMap<string, FamilyStage>,
  teenNames: readonly string[],
): DistillTurn[] {
  return turns.map((turn) => {
    const isTeen =
      (turn.childId !== null && stageByChild.get(turn.childId) === 'teenager') ||
      namesAnyIn(turn.content, teenNames);
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
      "Persist ONE categorized fact distilled from what the PARENT said or confirmed about a specific child (or family-wide with childId null), confidence in [0,1]. Categories: health, development, routines, preferences, concerns. Classify it: memoryClass enduring, obligation, or curiosity, and disposition confirmed, declined, or asked. Set record to age when the fact is the child's age or birth, or place when it is where the family lives; omit record otherwise. The key's spelling is not that signal. A declined or rejected activity is declined, never confirmed, and observedAt is the event's own time. A passing question is curiosity and asked, not a preference, until a later save classifies it as enduring. Facts below 0.7 confidence are REFUSED. NEVER pass raw teen content — only a category/summary. Pass correctsKey when this replaces a different key. A suggested or found activity, and anything Hale proposed, is not enrollment, registration, signup, or the family's pick. Do not put enrolled, enrollment, signed up, booked, or registered in the summary unless a booking or family event already records that activity.",
    inputSchema: z.object({
      childId: z.string().uuid().nullable(),
      category: distillCategory,
      factKey: z.string().min(1),
      summary: z.string().min(1),
      confidence: z.number().min(0).max(1),
      observedAt: z.string().optional(),
      ...modelClassificationShape,
    }),
    // Invented values only (rule #1; see EXAMPLE_CHILD_ID).
    inputExamples: [
      {
        childId: EXAMPLE_CHILD_ID,
        category: 'routines',
        factKey: 'afternoon_nap',
        summary: 'naps once a day, 1pm to 3pm',
        confidence: 0.95,
        memoryClass: 'enduring',
        disposition: 'confirmed',
      },
      {
        childId: EXAMPLE_CHILD_ID,
        category: 'preferences',
        factKey: 'saturday_swim_trial',
        summary: 'parent declined the Saturday swim trial',
        confidence: 0.95,
        observedAt: '2026-03-14T14:00:00.000Z',
        memoryClass: 'obligation',
        disposition: 'declined',
      },
      {
        childId: null,
        category: 'preferences',
        factKey: 'toddler_pottery',
        summary: 'parent asked once about a toddler pottery class',
        confidence: 0.8,
        memoryClass: 'curiosity',
        disposition: 'asked',
      },
    ],
    monetary: false,
    // VIL-269: this input NAMES a child, so the guarded invoker's teen check resolves
    // it before the handler runs — the same gate get_child_profile gets. The redaction
    // above is what the model SEES; this is what it may WRITE, and the two need
    // separate enforcement: a childId the distiller never read from a turn (a
    // hallucinated uuid, another family's, or a teen's) is refused rather than
    // persisted as a fact scoped to that child (rule #1/#5).
    touchesChildContent: true,
    childContentGate: (input, ctx) => teenNameGate(database, ctx.familyId, now, input),
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

      const childId = input.childId;
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
        heard: NIGHTLY_HEARD,
        now,
        memoryClass: input.memoryClass,
        disposition: input.disposition,
        observedAt: input.observedAt,
        expiresAt: input.expiresAt,
        correctsKey: input.correctsKey,
        record: input.record,
      });
      return { saved: true as const, factId };
    },
  });

  return [readRecentConversations, saveChildFact];
}

export const _internal = { redactTimelineForDistill, redactEventsForTeens };
