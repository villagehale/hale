import type { AgentClient } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import { and, asc, desc, eq, gt, inArray, isNotNull, sql } from 'drizzle-orm';
import { isNotKept } from '~/lib/channel/checkin/notes';
import {
  ACTIVITY_FOLLOWUP_ASK_TEMPLATE_KEY,
  type activityFollowupAskOpen,
  familyEventIdFromAskDedupeKey,
} from '~/lib/channel/followup/ask-open';
import { SENT_STATUSES } from '~/lib/channel/ledger';
import { CRON_SWEEP_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { matchAreaKey, normalizeFsa } from '~/lib/village/intros/matcher';
import { type ReviewSubject, type SubjectUnresolved, resolveReviewSubject } from './subject';
import type { VerdictReader } from './verdict';

/**
 * WHAT A PARENT SAID ABOUT HOW IT WENT, reduced to a verdict and up to three tags, so it
 * can eventually reach the next parent.
 *
 * IT SENDS NOTHING. That is the shape of the feature rather than a withheld dependency
 * (rule #11): the ask already went out on its own leg, and this pass only reads what came
 * back. So there is no transport here and no outbound gate.
 *
 * IT RUNS LAST ON THE NUDGE CRON, after the sweep that discharges a debt, because it is
 * the only stage that neither interrupts a parent nor discharges one — its failure must
 * not cost a send.
 */

export const ACTIVITY_REVIEWS_ENABLED_ENV = 'ACTIVITY_REVIEWS_ENABLED';

/**
 * Its OWN dark-launch flag, not F14's and not the ask's, on `followupAsksEnabled`'s
 * precedent: arming the messaging surface for a household must not silently start
 * contributing that household's opinions to other families' recommendations.
 *
 * STRICT equality on the literal 'true': `vercel env add` from a piped `echo` stores a
 * TRAILING NEWLINE, so a value that prints as `true` is really `'true\n'` and a
 * truthiness check reads that as ON.
 */
export function activityReviewsEnabled(): boolean {
  return process.env[ACTIVITY_REVIEWS_ENABLED_ENV] === 'true';
}

export interface ReviewCaptureResult {
  /** Null when the pass ran. `'flag_off'` is the dark flag, named rather than silent. */
  skipped: 'flag_off' | null;
  asksExamined: number;
  /** The ask stands and nothing came back. */
  noReply: number;
  /** Something else went out — the ask is no longer the last word. */
  askClosed: number;
  /** An inbound after the ask, from the parent it was not sent to. */
  wrongParent: number;
  /** Already read on an earlier tick — no second model call. */
  alreadyRead: number;
  teenScoped: number;
  sensitiveEvent: number;
  notKept: number;
  /** The family's area is not FSA-shaped, so there is no honest `area_key` to stamp. */
  noAreaKey: number;
  /** By reason, never a bucket (rule #11). */
  subjectUnresolved: Record<SubjectUnresolved, number>;
  /** They answered; no verdict was expressed. An audit row is still written. */
  noVerdict: number;
  tagsDropped: number;
  recorded: number;
  /** A second answer corrected the first. */
  updated: number;
  /** Parse or schema failure — named, never silent. */
  extractionFailed: number;
  /** client_unavailable | skill_unavailable. The datum is uncaptured and says so. */
  deferred: number;
}

function emptyResult(skipped: 'flag_off' | null): ReviewCaptureResult {
  return {
    skipped,
    asksExamined: 0,
    noReply: 0,
    askClosed: 0,
    wrongParent: 0,
    alreadyRead: 0,
    teenScoped: 0,
    sensitiveEvent: 0,
    notKept: 0,
    noAreaKey: 0,
    subjectUnresolved: {
      no_placing_action: 0,
      no_provenance_in_payload: 0,
      foreign_source_table: 0,
      candidate_gone: 0,
      no_shared_identity: 0,
    },
    noVerdict: 0,
    tagsDropped: 0,
    recorded: 0,
    updated: 0,
    extractionFailed: 0,
    deferred: 0,
  };
}

/** Every effect this pass needs is here and NONE of them is optional (rule #11). */
export interface ReviewCaptureDeps {
  /** The same ledger read the router uses, so the two can never disagree about whether
   * the parent was answering. */
  askOpen: typeof activityFollowupAskOpen;
  verdict: VerdictReader;
  now: Date;
}

/**
 * How far back a tick looks for asks. The question itself cannot stand longer than 24
 * hours (it lapses at 08:00 local, and `askStillStanding` caps at a day), so this only
 * has to cover that plus the widest timezone spread.
 */
const ASK_LOOKBACK_MS = 48 * 60 * 60 * 1000;

/** How many replies one standing question is read from. A bound rather than a rule: the
 * question closes at Hale's own next word, so a household that writes more than this
 * before Hale answers is not correcting itself any more. */
const MAX_REPLIES_PER_ASK = 5;

/**
 * The trail verb, written on every model read — see `lib/trail/verbs.ts`.
 *
 * It is spelled out as a LITERAL at the insert below rather than read from here, and
 * that is the drift gate's requirement rather than a slip: `verbs-drift.test.ts` reads
 * the verb off the write statically, and a constant there would make this file owe an
 * `INDIRECT_WRITE_SITES` enumeration. (That scanner is line-based, which is also why
 * this sentence does not spell the field name it looks for.) The pglite test asserts the
 * written row against this constant, which keeps the two in step.
 */
export const VERDICT_AUDIT_VERB = 'activity_verdict_read';

let verdictAnthropic: AgentClient | undefined;

/**
 * The extractor's client, resolved LAZILY — a function, not a value, for the reason the
 * follow-up voice's is: these deps are built on EVERY hourly tick and the vast majority
 * of ticks read nothing at all. A client constructed at wiring time would turn a missing
 * ANTHROPIC_API_KEY into a broken cron rather than the honest `client_unavailable`
 * deferral this pass already names.
 */
export function reviewVerdictClient(): AgentClient {
  verdictAnthropic ??= budgetedAnthropic(CRON_SWEEP_CLIENT_OPTIONS);
  return verdictAnthropic;
}

export async function runReviewCapture(
  database: Database,
  deps: ReviewCaptureDeps,
): Promise<ReviewCaptureResult> {
  if (!activityReviewsEnabled()) {
    console.info({ env: ACTIVITY_REVIEWS_ENABLED_ENV }, 'review capture: dark, nothing read');
    return emptyResult('flag_off');
  }

  const result = emptyResult(null);
  const since = new Date(deps.now.getTime() - ASK_LOOKBACK_MS);

  const asks = await database
    .select({
      id: schema.channelMessages.id,
      familyId: schema.channelMessages.familyId,
      parentUserId: schema.channelMessages.parentUserId,
      askedAt: schema.channelMessages.createdAt,
      dedupeKey: schema.channelMessages.dedupeKey,
    })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.direction, 'out'),
        eq(schema.channelMessages.templateKey, ACTIVITY_FOLLOWUP_ASK_TEMPLATE_KEY),
        inArray(schema.channelMessages.status, [...SENT_STATUSES]),
        isNotNull(schema.channelMessages.parentUserId),
        gt(schema.channelMessages.createdAt, sql`${since.toISOString()}::timestamptz`),
      ),
    )
    .orderBy(desc(schema.channelMessages.createdAt));

  for (const ask of asks) {
    const parentUserId = ask.parentUserId;
    if (parentUserId === null) continue;
    result.asksExamined += 1;
    try {
      await captureOne(database, deps, result, {
        askMessageId: ask.id,
        familyId: ask.familyId,
        parentUserId,
        askedAt: ask.askedAt,
        familyEventId: familyEventIdFromAskDedupeKey(ask.dedupeKey),
      });
    } catch (err) {
      // One household's failure must not cost the rest of the tick, and it must not
      // look like a quiet "nothing to capture" either.
      result.extractionFailed += 1;
      console.error(
        { familyId: ask.familyId, reason: err instanceof Error ? err.message : String(err) },
        'review capture: a family failed and was skipped',
      );
    }
  }

  return result;
}

interface AskUnderExamination {
  askMessageId: string;
  familyId: string;
  parentUserId: string;
  askedAt: Date;
  familyEventId: string | null;
}

async function captureOne(
  database: Database,
  deps: ReviewCaptureDeps,
  result: ReviewCaptureResult,
  ask: AskUnderExamination,
): Promise<void> {
  // Everything the household said after the ask, oldest first. Plural rather than one,
  // because a parent who writes again while the question is still standing is CORRECTING
  // themselves, not starting a second household — and the last verdict wins by upsert.
  // The list is short by construction: `activityFollowupAskOpen` closes the question the
  // moment anything goes out, so the run below stops at Hale's own next word.
  const inbounds = await database
    .select({
      id: schema.channelMessages.id,
      parentUserId: schema.channelMessages.parentUserId,
      body: schema.channelMessages.body,
      createdAt: schema.channelMessages.createdAt,
    })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, ask.familyId),
        eq(schema.channelMessages.direction, 'in'),
        isNotNull(schema.channelMessages.body),
        gt(schema.channelMessages.createdAt, sql`${ask.askedAt.toISOString()}::timestamptz`),
      ),
    )
    .orderBy(asc(schema.channelMessages.createdAt))
    .limit(MAX_REPLIES_PER_ASK);

  if (inbounds.length === 0) {
    // Nothing came back. Whether the ask still stands or something else has since gone
    // out is the difference between "waiting" and "the moment passed".
    const stillOpen = await deps.askOpen(database, {
      familyId: ask.familyId,
      parentUserId: ask.parentUserId,
      now: deps.now,
    });
    if (stillOpen) result.noReply += 1;
    else result.askClosed += 1;
    return;
  }

  for (const inbound of inbounds) {
    // THE LEDGER, NOT A CLOCK, and read AT THE MOMENT THE REPLY ARRIVED rather than now:
    // a reply at 07:50 answered a question that was standing, even though the tick that
    // reads it runs after the 08:00 lapse. Once one reply is past the question's close,
    // every later one is too.
    const openWhenAnswered = await deps.askOpen(database, {
      familyId: ask.familyId,
      parentUserId: ask.parentUserId,
      now: inbound.createdAt,
    });
    if (!openWhenAnswered || openWhenAnswered.id !== ask.askMessageId) {
      result.askClosed += 1;
      return;
    }

    if (inbound.parentUserId !== ask.parentUserId) {
      // The ask went to one phone. A co-parent's unrelated text is not the household's
      // answer, and the evening check-in fires in the same tick — so this is the common
      // case rather than the edge.
      result.wrongParent += 1;
      continue;
    }

    if (await alreadyRead(database, ask.familyId, inbound.id)) {
      result.alreadyRead += 1;
      continue;
    }

    await captureReply(database, deps, result, ask, inbound);
  }
}

interface InboundReply {
  id: string;
  body: string | null;
  createdAt: Date;
}

async function captureReply(
  database: Database,
  deps: ReviewCaptureDeps,
  result: ReviewCaptureResult,
  ask: AskUnderExamination,
  inbound: InboundReply,
): Promise<void> {
  // ── the screens. Each one runs BEFORE the model, and a screened reply reaches no
  // model and writes no row. A screen that ran after the call would be a screen that
  // leaked.
  const placement = ask.familyEventId
    ? await readPlacement(database, ask.familyId, ask.familyEventId)
    : null;

  if (placement?.childDateOfBirth) {
    // Live `deriveStage`, on top of the CHECK that makes 'teenager' unwritable. Two
    // layers, one of them structural (rule #1).
    if (deriveStage(placement.childDateOfBirth, deps.now) === 'teenager') {
      result.teenScoped += 1;
      return;
    }
  }
  if (placement?.sensitive) {
    result.sensitiveEvent += 1;
    return;
  }
  const body = inbound.body ?? '';
  if (isNotKept(body)) {
    result.notKept += 1;
    return;
  }

  const subject: ReviewSubject = ask.familyEventId
    ? await resolveReviewSubject(database, {
        familyId: ask.familyId,
        familyEventId: ask.familyEventId,
      })
    : { unresolved: 'no_placing_action' };
  if ('unresolved' in subject) {
    result.subjectUnresolved[subject.unresolved] += 1;
    return;
  }

  const areaKey = await readAreaKey(database, ask.familyId);
  if (areaKey === null) {
    // `area_key` is how "near you" is decided, and an area that is not FSA-shaped is a
    // city of three million. There is no honest value to stamp, so nothing is read.
    result.noAreaKey += 1;
    return;
  }

  const outcome = await deps.verdict.read(body);
  if (outcome.status === 'deferred') {
    console.error(
      { familyId: ask.familyId, reason: outcome.reason },
      'review capture: deferring rather than guessing a verdict',
    );
    result.deferred += 1;
    return;
  }
  if (outcome.status === 'extraction_failed') {
    console.error(
      { familyId: ask.familyId, reason: outcome.reason },
      'review capture: the verdict could not be parsed',
    );
    result.extractionFailed += 1;
    return;
  }

  result.tagsDropped += outcome.tagsDropped;
  const stored = outcome.status === 'read';
  const childAgeBand = placement?.childDateOfBirth
    ? (deriveStage(placement.childDateOfBirth, deps.now) as
        | 'newborn'
        | 'toddler'
        | 'preschool'
        | 'child')
    : null;

  // ONE TRANSACTION for the row and its receipt: a crash between them would leave a
  // stored opinion with no trail, or a trail for something that was never stored.
  await database.transaction(async (tx) => {
    let inserted = true;
    if (outcome.status === 'read') {
      const [row] = await tx
        .insert(schema.activityReviews)
        .values({
          familyId: ask.familyId,
          sourceMessageId: inbound.id,
          subjectSource: subject.source,
          subjectRef: subject.ref,
          areaKey,
          childAgeBand,
          verdict: outcome.verdict,
          tags: outcome.tags,
        })
        .onConflictDoUpdate({
          target: [
            schema.activityReviews.familyId,
            schema.activityReviews.subjectSource,
            schema.activityReviews.subjectRef,
          ],
          set: {
            sourceMessageId: inbound.id,
            areaKey,
            childAgeBand,
            verdict: outcome.verdict,
            tags: outcome.tags,
            updatedAt: deps.now,
          },
        })
        // `xmax = 0` on the returned row is postgres saying this was an INSERT rather
        // than the UPDATE half of the upsert — the only way to tell a first answer from
        // a correction without a second read.
        .returning({ inserted: sql<boolean>`xmax = 0` });
      inserted = row?.inserted !== false;
    }

    // RULE #6, ON EVERY MODEL READ — including the one that stored nothing, because the
    // parent's words were still sent to a model and that is processing. Never the tag
    // names, the subject ref, the area key or the child band.
    await tx.insert(schema.auditLog).values({
      familyId: ask.familyId,
      actor: 'system',
      actionTaken: 'activity_verdict_read',
      targetTable: 'channel_messages',
      targetId: inbound.id,
      after: {
        stored,
        verdict: outcome.status === 'read' ? outcome.verdict : null,
        tagCount: outcome.status === 'read' ? outcome.tags.length : 0,
        subjectSource: subject.source,
        updated: outcome.status === 'read' ? !inserted : false,
      },
    } as never);

    if (outcome.status === 'read') {
      if (inserted) result.recorded += 1;
      else result.updated += 1;
    } else {
      result.noVerdict += 1;
    }
  });
}

/** Has this inbound already been read? The audit row is the cheap filter, not the claim:
 * `audit_log` has no unique index on (target_table, target_id), so two overlapping ticks
 * can both pass here and pay one extra model call — the upsert makes the WRITE idempotent
 * and the ledger, not this, is what makes the row right. */
async function alreadyRead(
  database: Database,
  familyId: string,
  inboundMessageId: string,
): Promise<boolean> {
  const [row] = await database
    .select({ id: schema.auditLog.id })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, familyId),
        eq(schema.auditLog.actionTaken, VERDICT_AUDIT_VERB),
        eq(schema.auditLog.targetTable, 'channel_messages'),
        eq(schema.auditLog.targetId, inboundMessageId),
      ),
    )
    .limit(1);
  return row !== undefined;
}

async function readPlacement(
  database: Database,
  familyId: string,
  familyEventId: string,
): Promise<{ sensitive: boolean; childDateOfBirth: string | null } | null> {
  const [row] = await database
    .select({
      sensitive: schema.familyEvents.sensitive,
      childDateOfBirth: schema.children.dateOfBirth,
    })
    .from(schema.familyEvents)
    .leftJoin(schema.children, eq(schema.children.id, schema.familyEvents.childId))
    .where(
      and(eq(schema.familyEvents.id, familyEventId), eq(schema.familyEvents.familyId, familyId)),
    )
    .limit(1);
  return row ?? null;
}

/** The coarse area the count is pooled over — `matchAreaKey` over `normalizeFsa`, reused
 * rather than re-decided, because the intros lane already settled what "a family near
 * you" means. Null when the family's area is not FSA-shaped. */
async function readAreaKey(database: Database, familyId: string): Promise<string | null> {
  const [family] = await database
    .select({ areaCoarse: schema.families.areaCoarse })
    .from(schema.families)
    .where(eq(schema.families.id, familyId))
    .limit(1);
  const fsa = normalizeFsa(family?.areaCoarse ?? null);
  return fsa === null ? null : matchAreaKey(fsa);
}
