import { type Database, schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import { and, desc, eq, isNull, like } from 'drizzle-orm';
import { readAffirmative } from '~/lib/channel/affirmative';
import { normalizeKeyword } from '~/lib/channel/intake/keywords';
import { draftInlineAction } from '~/lib/coach/inline-action';
import { writeFact } from '~/lib/memory/facts';
import { pipelineClient } from '~/lib/pipeline/client';
import { checkpointById, parseCheckpointRef, refsSharingVisit } from './checkpoints';
import {
  CHECKUP_OFFER_TTL_HOURS,
  type OpenCheckupOffer,
  fulfillCheckupOffer,
  loadOpenCheckupOffer,
} from './offer';
import { checkpointToldKeyPrefix, loadToldCheckpointRefs } from './told';

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
 *   "yes"     the parent accepts the OFFER the nudge made ("want me to add booking it to
 *             your week?"). That DRAFTS a book_checkup action held for approval on the
 *             existing engine (rule #4). Hale never books. What makes the acceptance
 *             resolvable is that the offer is a ROW, minted by the message that made it
 *             (lib/health/offer.ts) — not an inference from the last checkpoint this
 *             family happened to be told about.
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

/**
 * The two ways of asking for help booking that are NOT affirmations — an instruction
 * about a clinic visit rather than a yes (VIL-265). They stay local for that reason:
 * folding them into the shared vocabulary would make "book it" a word that approves
 * whatever else happens to be drafted, on every surface that reads a yes.
 */
const BOOKING_VERBS = new Set(['book it', 'draft it']);

/**
 * What this reply IS, or null when it is ordinary conversation.
 *
 * DONE is matched first, and the order is load-bearing: the shared vocabulary reads a
 * tick (✓ ✔ ✅) as a yes, while on a health nudge it means the paperwork is filed. A
 * parent ticking a form off must never be booked an appointment for it.
 *
 * The yes itself is the shared reading (VIL-265). M8's own six-word list dropped "sure"
 * and "go ahead" on the floor — the same silent lapse WS4 found in M6, on a message a
 * family gets once every few months.
 */
export function matchHealthReply(body: string): HealthReplyIntent | null {
  const word = normalizeKeyword(body);
  if (DONE_WORDS.has(word)) return 'done';
  if (BOOKING_VERBS.has(word) || readAffirmative(body) === 'yes') return 'booking';
  return null;
}

export type HealthReplyOutcome =
  | { status: 'recorded_done'; ref: string }
  /** The draft is real and held for approval; `commitmentId` is the offer it answered,
   * which the caller closes once the receipt has actually reached the parent. */
  | { status: 'drafted_for_approval'; actionId: string; commitmentId: string }
  | {
      status: 'ignored';
      reason: 'not_a_health_reply' | 'no_open_checkpoint' | 'no_open_offer';
    };

export interface HealthReplyDeps {
  /**
   * The checkpoint this family was last told about, and WHEN they were told, or null.
   *
   * The instant rides along because two readers of this answer need different things
   * from it. An exact "done" is unambiguous and needs no clock: whenever a parent types
   * the word, they mean the errand Hale raised. A NATURAL statement — "we booked
   * already", read by lib/channel/stated-state.ts — is only about that errand while the
   * errand is recent, so it is checked against the same relevance window the nudge gives
   * its own offer ({@link CHECKUP_OFFER_TTL_HOURS}). One reader, one answer, and the
   * looser caller is the one that pays for the looseness.
   */
  loadLastCheckpointRef(
    database: Database,
    familyId: string,
  ): Promise<{ ref: string; toldAt: Date } | null>;
  /**
   * The booking offer this family may still accept, or null — the ONE thing a "yes"
   * here resolves against (lib/health/offer.ts).
   *
   * It replaced a read of the last told-marker, and the difference is the whole 2026-08-20
   * fix. The told-marker answers "what were they last told about", which is not the same
   * question as "what were they OFFERED": most checkpoints are paperwork and offer
   * nothing, the intake radar can tell a family about one without offering anything at
   * all, and a marker has no expiry. The offer row is minted only by the message that
   * actually asked, and it lapses on its own week.
   */
  loadOpenOffer(
    database: Database,
    familyId: string,
    now: Date,
  ): Promise<OpenCheckupOffer | null>;
  /**
   * Close the offer once the parent has been told their draft exists. REQUIRED (rule
   * #11): an accepted offer that stays open is a question the resolver keeps asking and
   * a second yes would draft the same visit twice.
   */
  fulfillOffer: typeof fulfillCheckupOffer;
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
  input: {
    familyId: string;
    parentUserId: string;
    body: string;
    now: Date;
    /**
     * The router's natural-reply stage already read this message as an acceptance of the
     * open booking offer (lib/channel/router/resolve.ts) — "add it to my week", in words
     * no closed vocabulary contains. It NAMES the question, so it is trusted over the
     * word match; the exact words still win when they are there, because the handler
     * that reads them runs first and this field is only set once they have declined.
     */
    resolved?: 'booking' | 'done' | null,
  },
  deps: HealthReplyDeps,
): Promise<HealthReplyOutcome> {
  const intent = input.resolved ?? matchHealthReply(input.body);
  // Checked before any lookup: an ordinary message must not cost a query, because most
  // inbound traffic on this channel is ordinary.
  if (!intent) return { status: 'ignored', reason: 'not_a_health_reply' };

  // A word from the closed vocabulary is unambiguous whenever it arrives; a RESOLVED
  // done came from a reader of ordinary English, so it only speaks for a checkpoint the
  // family was told about recently. The freshness bar is the caller's looseness made
  // explicit, not a property of the fact.
  if (intent === 'done') {
    return recordDoneReply(database, input, deps, input.resolved === 'done' ? input.now : null);
  }

  // A "yes" only means something where an OFFER was made, and the offer is a row rather
  // than an inference from the last thing Hale said. No live offer, no draft: the turn
  // falls through to the coach, which will read the message properly.
  const offer = await deps.loadOpenOffer(database, input.familyId, input.now);
  if (!offer) return { status: 'ignored', reason: 'no_open_offer' };

  const { actionId } = await deps.draftCheckup(database, {
    familyId: input.familyId,
    actorUserId: input.parentUserId,
    childId: offer.childId,
    intentKind: 'book_checkup',
    sourceAnswer: offer.checkpoint.task,
  });
  return { status: 'drafted_for_approval', actionId, commitmentId: offer.id };
}

/** The paperwork half, unchanged: the told-marker is the identity of the errand a parent
 * is calling handled, and it is the right reader for that question. */
async function recordDoneReply(
  database: Database,
  input: { familyId: string; parentUserId: string },
  deps: HealthReplyDeps,
  /** Non-null when the reading was a loose one: the told-marker must be inside the
   * nudge's own relevance window or this settles nothing. */
  freshAt: Date | null,
): Promise<HealthReplyOutcome> {
  const told = await deps.loadLastCheckpointRef(database, input.familyId);
  const ref = told?.ref ?? null;
  const parsed = ref === null ? null : parseCheckpointRef(ref);
  if (told === null || ref === null || parsed === null || !checkpointById(parsed.checkpointId)) {
    return { status: 'ignored', reason: 'no_open_checkpoint' };
  }
  if (freshAt !== null && !toldRecently(told.toldAt, freshAt)) {
    return { status: 'ignored', reason: 'no_open_checkpoint' };
  }
  await deps.recordDone(database, {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    childId: parsed.childId,
    checkpointId: parsed.checkpointId,
    ref,
  });
  return { status: 'recorded_done', ref };
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
    // A parent can answer "done" to the same checkpoint twice. Superseding rather
    // than appending keeps one live suppression row per checkpoint — which is what
    // the read below counts, and what the unique index will accept.
    await writeFact(tx, {
      familyId: input.familyId,
      childId: input.childId,
      factType: 'logistic',
      factKey: `${HEALTH_FACT_KEY_PREFIX}${input.ref}`,
      factValue: { checkpointId: input.checkpointId, status: 'done' },
      confidence: 1,
      inferredBy: HEALTH_FACT_WRITER,
      validFrom: new Date(),
    });
  });
}

/**
 * Every checkpoint this family should not be raised about again — the ONE input the
 * matcher takes, and it is a union of two different facts on purpose:
 *
 *   TOLD  — some surface already said it (lib/health/told.ts owns that answer, for
 *           every surface at once). A health window is months wide, so a checkpoint
 *           that stayed the top candidate after being sent would keep winning the
 *           priority order, dead-end the sweep on the send-time dedupe guard, and
 *           silence every OTHER nudge class for the whole band — up to three years for
 *           the 4-to-6-year row, invisibly, because a deduped outcome writes no audit
 *           row. Being told once is the design; being told once and then muted is a
 *           bug, and it belongs here in SELECTION rather than at the send guard, which
 *           cannot fall through to a lower-priority candidate.
 *   DONE  — the parent said it is handled.
 *
 * Both are "do not raise this again", so they are one set. Keeping them apart would
 * mean two places that can disagree about whether a family is owed a message.
 */
export async function loadSuppressedCheckpointRefs(
  database: Database,
  familyId: string,
): Promise<Set<string>> {
  const [told, done] = await Promise.all([
    loadToldCheckpointRefs(database, familyId),
    loadDoneCheckpointRefs(database, familyId),
  ]);
  // DONE widens to the whole appointment and TOLD does not, and the asymmetry is the
  // point. "We booked already" settles the visit, so every row describing that visit is
  // answered (checkpoints.ts refsSharingVisit) — the 2026-08-13 → 08-20 repeat is exactly
  // the narrow read. "Hale said it" settles only the sentence Hale actually sent; a
  // sibling row nobody has mentioned is still owed.
  for (const ref of done) {
    for (const sibling of refsSharingVisit(ref)) told.add(sibling);
  }
  return told;
}

/**
 * The live suppression rows, unprojected — ONE predicate, because two callers ask two
 * different questions of exactly the same set and a second copy of this WHERE clause is
 * the drift that lets a fact suppress a reminder without being able to back a sentence.
 *
 * The trust boundary is the writer pin: `family_memory_facts` is not a private table (the
 * coach's `save_memory` lets a model choose both type and key freely), so a read that did
 * not name the writer could be silenced by a single injected memory.
 */
async function loadHandledFacts(
  database: Database,
  familyId: string,
): Promise<Array<{ ref: string; childId: string | null }>> {
  const rows = await database
    .select({
      factKey: schema.familyMemoryFacts.factKey,
      childId: schema.familyMemoryFacts.childId,
    })
    .from(schema.familyMemoryFacts)
    .where(
      and(
        eq(schema.familyMemoryFacts.familyId, familyId),
        eq(schema.familyMemoryFacts.inferredBy, HEALTH_FACT_WRITER),
        eq(schema.familyMemoryFacts.factType, 'logistic'),
        // '_' is a single-character wildcard in LIKE, so the underscore in the prefix is
        // escaped — an unescaped prefix would also match a neighbouring namespace.
        like(schema.familyMemoryFacts.factKey, `${HEALTH_FACT_KEY_PREFIX.replace('_', '\\_')}%`),
        isNull(schema.familyMemoryFacts.validUntil),
      ),
    );
  return rows.map((row) => ({
    ref: row.factKey.slice(HEALTH_FACT_KEY_PREFIX.length),
    childId: row.childId,
  }));
}

/** Every checkpoint this family has told us is handled. */
async function loadDoneCheckpointRefs(
  database: Database,
  familyId: string,
): Promise<Set<string>> {
  return new Set((await loadHandledFacts(database, familyId)).map((row) => row.ref));
}

/**
 * The appointments this family has TOLD HALE are booked, as the words a booking claim is
 * checked against (VIL-293 reconcile.ts `statedBookings`).
 *
 * WHY THE OUTBOUND GATE NEEDS THIS. "Your 18-month visit is booked" is a `scheduled_event`
 * claim, and the only thing that could back one was a row on the family's calendar. Hale
 * has no such row here and never will: the parent booked the visit themselves and never
 * said when. So the true sentence — an acknowledgement of what the parent just told us —
 * was the one the gate deleted. The fact IS the backing; this is its projection.
 *
 * A TEEN'S APPOINTMENT IS EXCLUDED OUTRIGHT, and the exclusion is fail-closed rather than
 * redacted (rule #1): the suppression still works, because that reads the key, but Hale
 * may not assert to a parent that a 13+ child's visit is booked. Nothing here is a
 * redaction of the claim — the claim simply goes unbacked, and the gate drops it.
 *
 * The projection is the checkpoint's own `task` string. Nothing new is minted: the words
 * the gate matches on are the words the message that raised it used.
 */
export async function loadStatedBookings(
  database: Database,
  familyId: string,
  now: Date,
): Promise<string[]> {
  const handled = await loadHandledFacts(database, familyId);
  if (handled.length === 0) return [];

  const children = await database
    .select({ id: schema.children.id, dateOfBirth: schema.children.dateOfBirth })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
  const teens = new Set(
    children.filter((c) => deriveStage(c.dateOfBirth, now) === 'teenager').map((c) => c.id),
  );

  const tasks: string[] = [];
  for (const row of handled) {
    if (row.childId !== null && teens.has(row.childId)) continue;
    const parsed = parseCheckpointRef(row.ref);
    const checkpoint = parsed === null ? null : checkpointById(parsed.checkpointId);
    // Paperwork is not a booking. A filed records check must not back "that's booked".
    if (!checkpoint || checkpoint.visit === null) continue;
    tasks.push(checkpoint.task);
  }
  return tasks;
}

/**
 * The checkpoint the family was last texted about, read back off the ledger row that
 * told it. The told-marker IS the identity, so there is nothing else to store and
 * nothing that can disagree with it — and, like the suppression above, the SURFACE is
 * not part of the question: a parent who replies "done" to the checkpoint their first
 * radar carried is answering the same errand the nudge would have raised.
 */
export async function loadLastCheckpointRef(
  database: Database,
  familyId: string,
): Promise<{ ref: string; toldAt: Date } | null> {
  const prefix = checkpointToldKeyPrefix(familyId);
  const [row] = await database
    .select({
      dedupeKey: schema.channelMessages.dedupeKey,
      createdAt: schema.channelMessages.createdAt,
    })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, familyId),
        eq(schema.channelMessages.direction, 'out'),
        like(schema.channelMessages.dedupeKey, `${prefix}%`),
      ),
    )
    .orderBy(desc(schema.channelMessages.createdAt))
    .limit(1);

  const key = row?.dedupeKey;
  if (!key || !row) return null;
  const ref = key.slice(prefix.length);
  return parseCheckpointRef(ref) ? { ref, toldAt: row.createdAt } : null;
}

/** Inside the window the nudge already treats its own question as live. */
function toldRecently(toldAt: Date, now: Date): boolean {
  return now.getTime() - toldAt.getTime() <= CHECKUP_OFFER_TTL_HOURS * 3_600_000;
}

export function defaultHealthReplyDeps(): HealthReplyDeps {
  return {
    loadLastCheckpointRef,
    loadOpenOffer: loadOpenCheckupOffer,
    fulfillOffer: fulfillCheckupOffer,
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
          // A parent replying "book it" to a nudge IS a person asking in a
          // conversation — the nudge only opened it. The cron composed the question,
          // never this draft, so `registration_sweep`'s no-one-in-the-loop stamp
          // would be the false claim here.
          origin: 'ask_hale',
        },
        database,
        pipelineClient(),
      );
      return { actionId };
    },
  };
}
