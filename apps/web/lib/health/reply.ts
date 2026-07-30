import { type Database, schema } from '@hale/db';
import { and, desc, eq, isNull, like } from 'drizzle-orm';
import { normalizeKeyword } from '~/lib/channel/intake/keywords';
import { draftInlineAction } from '~/lib/coach/inline-action';
import { pipelineClient } from '~/lib/pipeline/client';
import {
  checkpointById,
  healthNudgeDedupeKeyPrefix,
  parseCheckpointRef,
} from './checkpoints';

/**
 * VIL-243 · M8 — what a parent's answer to a health nudge is allowed to do.
 *
 * Exactly two things, and both are deterministic:
 *
 *   "done"    the parent says the paperwork is handled. Hale believes them, records it
 *             as a family fact, and never raises that checkpoint again. There is no
 *             verification step and there will never be one: Hale does not hold the
 *             record it would check against, and a product that asked a parent to prove
 *             they filed a form would be worse than the form.
 *   "yes"     on a checkpoint whose task IS booking a visit, the parent asks for help.
 *             That DRAFTS a book_checkup action held for approval on the existing
 *             engine (rule #4). Hale never books.
 *
 * Matching is EXACT on the normalized body, the same discipline as the CASL keywords
 * (lib/channel/intake/keywords.ts) and for a sharper reason: "not done yet" contains
 * "done", and a substring match would file the opposite of what the parent said and
 * then go quiet — the single worst failure this feature has.
 */

export type HealthReplyIntent = 'done' | 'booking';

/** The paperwork-is-handled family. */
const DONE_WORDS = new Set([
  'done',
  'did it',
  'did that',
  'done it',
  'all done',
  'finished',
  'handled',
  'filed',
  '✓',
  '✔',
  '✅',
]);

/** The yes-please-draft-it family. Only ever acted on for a booking checkpoint. */
const BOOKING_WORDS = new Set(['yes', 'yes please', 'yep', 'book it', 'draft it', 'please']);

/** What this reply IS, or null when it is ordinary conversation. */
export function matchHealthReply(body: string): HealthReplyIntent | null {
  const word = normalizeKeyword(body);
  if (DONE_WORDS.has(word)) return 'done';
  if (BOOKING_WORDS.has(word)) return 'booking';
  return null;
}

export type HealthReplyOutcome =
  | { status: 'recorded_done'; ref: string }
  | { status: 'drafted_for_approval'; actionId: string }
  | {
      status: 'ignored';
      reason: 'not_a_health_reply' | 'no_open_checkpoint' | 'not_a_booking_checkpoint';
    };

export interface HealthReplyDeps {
  /** The checkpoint ref this family was last nudged about, or null. */
  loadLastCheckpointRef(database: Database, familyId: string): Promise<string | null>;
  recordDone(
    database: Database,
    input: {
      familyId: string;
      parentUserId: string;
      /** null for a household-scoped checkpoint — there is no one child it belongs to. */
      childId: string | null;
      checkpointId: string;
      ref: string;
    },
  ): Promise<void>;
  draftCheckup(
    database: Database,
    input: {
      familyId: string;
      actorUserId: string;
      childId: string | null;
      intentKind: 'book_checkup';
      sourceAnswer: string;
    },
  ): Promise<{ actionId: string }>;
}

export async function handleHealthCheckpointReply(
  database: Database,
  input: { familyId: string; parentUserId: string; body: string },
  deps: HealthReplyDeps,
): Promise<HealthReplyOutcome> {
  const intent = matchHealthReply(input.body);
  // Checked before the lookup: an ordinary message must not cost a query, because most
  // inbound traffic on this channel is ordinary.
  if (!intent) return { status: 'ignored', reason: 'not_a_health_reply' };

  const ref = await deps.loadLastCheckpointRef(database, input.familyId);
  const parsed = ref === null ? null : parseCheckpointRef(ref);
  if (ref === null || parsed === null) {
    return { status: 'ignored', reason: 'no_open_checkpoint' };
  }
  const checkpoint = checkpointById(parsed.checkpointId);
  if (!checkpoint) return { status: 'ignored', reason: 'no_open_checkpoint' };

  if (intent === 'done') {
    await deps.recordDone(database, {
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      childId: parsed.childId,
      checkpointId: parsed.checkpointId,
      ref,
    });
    return { status: 'recorded_done', ref };
  }

  // A "yes" only means something where an offer was made. Drafting an appointment off a
  // paperwork reminder would be Hale inventing a visit nobody mentioned.
  if (!checkpoint.booking) {
    return { status: 'ignored', reason: 'not_a_booking_checkpoint' };
  }

  const { actionId } = await deps.draftCheckup(database, {
    familyId: input.familyId,
    actorUserId: input.parentUserId,
    childId: parsed.childId,
    intentKind: 'book_checkup',
    sourceAnswer: checkpoint.task,
  });
  return { status: 'drafted_for_approval', actionId };
}

// ── prod wiring ──────────────────────────────────────────────────────────────

/** The `family_memory_facts.fact_key` namespace for a completed checkpoint. */
export const HEALTH_FACT_KEY_PREFIX = 'health_checkpoint:';

/**
 * Stamped on every fact this module writes, and REQUIRED on every fact it reads back.
 *
 * `family_memory_facts` is not a private table: the Ask Hale `save_memory` tool lets a
 * model choose both `fact_type` and `fact_key` freely, so the key namespace above is
 * writable by anything that can get one sentence into a coach turn. Reading suppression
 * state without pinning the WRITER would mean a single injected memory could silence a
 * family's records-check reminder permanently, silently, and with no audit row — the
 * exact harm this feature exists to prevent. The writer is the trust boundary.
 */
const HEALTH_FACT_WRITER = 'health-nudge-reply';

/**
 * Typed 'logistic', NOT 'medical', and the distinction is the point: this row records
 * that a parent completed an ADMINISTRATIVE task. It holds no clinical observation, no
 * vaccine, no date of any visit — Hale has none of those and never will. Filing it as
 * medical would seed the medical fact space with content Hale never saw, and hand every
 * downstream medical-context read a claim nobody made.
 */
export async function recordCheckpointDone(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    childId: string | null;
    checkpointId: string;
    ref: string;
  },
): Promise<void> {
  // One transaction, audit FIRST — the same discipline recordWatchConsent uses. A
  // suppression that landed without its audit row would be a permanent state change
  // with no trail, which rule #6 admits no exception to.
  //
  // The audit payload names the CHECKPOINT and the family, never the child: the one
  // teen-reachable non-recurring row scopes its ref to a 13+ child's id, and audit_log
  // is immutable, PIPEDA-exportable, and has none of the teen redaction that guards a
  // memory-fact read. The fact row keeps the child scope, because suppression needs it.
  await database.transaction(async (tx) => {
    await tx.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: input.parentUserId,
      actionTaken: 'health_checkpoint_marked_done',
      targetTable: 'family_memory_facts',
      targetId: input.familyId,
      after: { checkpointId: input.checkpointId },
    });
    await tx.insert(schema.familyMemoryFacts).values({
      familyId: input.familyId,
      childId: input.childId,
      factType: 'logistic',
      factKey: `${HEALTH_FACT_KEY_PREFIX}${input.ref}`,
      factValue: { checkpointId: input.checkpointId, status: 'done' },
      inferredBy: HEALTH_FACT_WRITER,
    });
  });
}

/** Every checkpoint this family has told us is handled. Read once per sweep and handed
 * to the matcher, which drops those rows before anything else runs. */
export async function loadDoneCheckpointRefs(
  database: Database,
  familyId: string,
): Promise<Set<string>> {
  const rows = await database
    .select({ factKey: schema.familyMemoryFacts.factKey })
    .from(schema.familyMemoryFacts)
    .where(
      and(
        eq(schema.familyMemoryFacts.familyId, familyId),
        // The trust boundary: only rows THIS module wrote may suppress a reminder.
        eq(schema.familyMemoryFacts.inferredBy, HEALTH_FACT_WRITER),
        eq(schema.familyMemoryFacts.factType, 'logistic'),
        // '_' is a single-character wildcard in LIKE, so the underscore in the prefix is
        // escaped — an unescaped prefix would also match a neighbouring namespace.
        like(schema.familyMemoryFacts.factKey, `${HEALTH_FACT_KEY_PREFIX.replace('_', '\\_')}%`),
        isNull(schema.familyMemoryFacts.validUntil),
      ),
    );
  return new Set(rows.map((row) => row.factKey.slice(HEALTH_FACT_KEY_PREFIX.length)));
}

/**
 * The checkpoint the family was last texted about, read back off the ledger row the
 * sweep wrote. The dedupe key IS the identity, so there is nothing else to store and
 * nothing that can disagree with it.
 */
export async function loadLastCheckpointRef(
  database: Database,
  familyId: string,
): Promise<string | null> {
  const prefix = healthNudgeDedupeKeyPrefix(familyId);
  const [row] = await database
    .select({ dedupeKey: schema.channelMessages.dedupeKey })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, familyId),
        eq(schema.channelMessages.direction, 'out'),
        eq(schema.channelMessages.category, 'nudge'),
        like(schema.channelMessages.dedupeKey, `${prefix}%`),
      ),
    )
    .orderBy(desc(schema.channelMessages.createdAt))
    .limit(1);

  const key = row?.dedupeKey;
  if (!key) return null;
  const ref = key.slice(prefix.length);
  return parseCheckpointRef(ref) ? ref : null;
}

export function defaultHealthReplyDeps(): HealthReplyDeps {
  return {
    loadLastCheckpointRef,
    recordDone: recordCheckpointDone,
    // Routed through the SAME approval spine an Ask Hale chip uses: drafted, reviewed,
    // and held at drafted_for_approval. Nothing here executes (rule #4).
    draftCheckup: async (database, input) => {
      const { actionId } = await draftInlineAction(
        {
          familyId: input.familyId,
          actor: input.actorUserId,
          intentKind: input.intentKind,
          childId: input.childId,
          sourceAnswer: input.sourceAnswer,
        },
        database,
        pipelineClient(),
      );
      return { actionId };
    },
  };
}
