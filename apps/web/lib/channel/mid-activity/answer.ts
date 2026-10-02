import {
  type ActivityReviewAgeBand,
  type ActivityReviewTag,
  type Database,
  schema,
} from '@hale/db';
import { deriveStage } from '@hale/types';
import { and, asc, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import { askStillStanding } from '~/lib/channel/checkin/cadence';
import { SENT_STATUSES } from '~/lib/channel/ledger';
import { type ReviewSubjectRef, familyAreaKey } from '~/lib/reviews/aggregate';
import type { VerdictOutcome, VerdictReader } from '~/lib/reviews/verdict';
import { MID_ACTIVITY_ASK_TEMPLATE_KEY, isUuid, offerIdFromMidActivityDedupeKey } from './claim';
import { midActivityAskEnabled } from './flag';

/**
 * VIL-393 step 4 — a mid-activity answer becomes this household's next find
 * by the path VIL-366 already shipped.
 *
 * The row is an `activity_reviews` verdict. `readHouseholdFindBias` /
 * `biasFindOrder` are what move the next recommendation. Nothing here ranks
 * candidates on its own, and nothing here is said out loud. The parent's
 * sentence is not stored. This pass sends nothing: the ask and the
 * acknowledgment are locked, and no sender is wired.
 */

const ASK_LOOKBACK_MS = 48 * 60 * 60 * 1000;

export interface HouseholdVerdictWrite {
  familyId: string;
  sourceMessageId: string;
  subject: ReviewSubjectRef;
  verdict: 'worth_it' | 'not_worth_it' | 'did_not_attend' | null;
  tags: ActivityReviewTag[];
  childDateOfBirth: string | null;
  now: Date;
}

export type StoreHouseholdVerdictResult =
  | { stored: 'recorded' | 'updated' | 'no_verdict' }
  | { stored: false; reason: 'teen_scoped' | 'no_area' };

/**
 * Write one household verdict into the VIL-366 table, or name why it was not written.
 * `did_not_attend` is stored and is not an opinion — the bias reader already ignores it.
 */
export async function storeHouseholdVerdict(
  database: Database,
  input: HouseholdVerdictWrite,
): Promise<StoreHouseholdVerdictResult> {
  const stage = input.childDateOfBirth ? deriveStage(input.childDateOfBirth, input.now) : null;
  if (stage === 'teenager') return { stored: false, reason: 'teen_scoped' };

  const areaKey = await familyAreaKey(database, input.familyId);
  if (areaKey === null) return { stored: false, reason: 'no_area' };

  const childAgeBand: ActivityReviewAgeBand | null =
    stage === 'newborn' || stage === 'toddler' || stage === 'preschool' || stage === 'child'
      ? stage
      : null;

  let recorded: 'recorded' | 'updated' | 'no_verdict' = 'no_verdict';
  await database.transaction(async (tx) => {
    let inserted = true;
    if (input.verdict !== null) {
      const [row] = await tx
        .insert(schema.activityReviews)
        .values({
          familyId: input.familyId,
          sourceMessageId: input.sourceMessageId,
          subjectSource: input.subject.source,
          subjectRef: input.subject.ref,
          areaKey,
          childAgeBand,
          verdict: input.verdict,
          tags: input.tags,
        })
        .onConflictDoUpdate({
          target: [
            schema.activityReviews.familyId,
            schema.activityReviews.subjectSource,
            schema.activityReviews.subjectRef,
          ],
          set: {
            sourceMessageId: input.sourceMessageId,
            areaKey,
            childAgeBand,
            verdict: input.verdict,
            tags: input.tags,
            updatedAt: input.now,
          },
        })
        .returning({ inserted: sql<boolean>`xmax = 0` });
      inserted = row?.inserted !== false;
      recorded = inserted ? 'recorded' : 'updated';
    }

    await tx.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: 'system',
      actionTaken: 'activity_verdict_read',
      targetTable: 'channel_messages',
      targetId: input.sourceMessageId,
      after: {
        stored: input.verdict !== null,
        verdict: input.verdict,
        tagCount: input.tags.length,
        subjectSource: input.subject.source,
        updated: input.verdict !== null && !inserted,
        lane: 'mid_activity',
      },
    });
  });

  return { stored: recorded };
}

export interface MidActivityAnswerResult {
  skipped: 'flag_off' | null;
  asksExamined: number;
  noReply: number;
  askClosed: number;
  wrongParent: number;
  teenScoped: number;
  noSubject: number;
  noArea: number;
  noVerdict: number;
  recorded: number;
  updated: number;
  deferred: number;
  extractionFailed: number;
}

function emptyAnswers(skipped: 'flag_off' | null): MidActivityAnswerResult {
  return {
    skipped,
    asksExamined: 0,
    noReply: 0,
    askClosed: 0,
    wrongParent: 0,
    teenScoped: 0,
    noSubject: 0,
    noArea: 0,
    noVerdict: 0,
    recorded: 0,
    updated: 0,
    deferred: 0,
    extractionFailed: 0,
  };
}

function subjectOf(
  row: {
    familyId: string;
    placeId: string | null;
    civicVenueId: string | null;
  },
  familyId: string,
): ReviewSubjectRef | null {
  if (row.familyId !== familyId) return null;
  if (row.placeId) return { source: 'place', ref: row.placeId };
  if (row.civicVenueId) return { source: 'civic_venue', ref: row.civicVenueId };
  return null;
}

/**
 * Read replies to a mid-activity ask that actually went out, and store the
 * verdict on the same table the next find already reads.
 *
 * Flag off is a named skip and does no read. There is no sender in this
 * function. The acknowledgment is locked, and a stored verdict still only
 * changes the next find. This pass does not text.
 */
export async function runMidActivityAnswerPass(
  database: Database,
  deps: { verdict: VerdictReader; now: Date },
): Promise<MidActivityAnswerResult> {
  if (!midActivityAskEnabled()) {
    console.info({ env: 'MID_ACTIVITY_ASK_ENABLED' }, 'mid-activity answer: dark, nothing read');
    return emptyAnswers('flag_off');
  }

  const result = emptyAnswers(null);
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
        eq(schema.channelMessages.templateKey, MID_ACTIVITY_ASK_TEMPLATE_KEY),
        inArray(schema.channelMessages.status, [...SENT_STATUSES]),
        gt(schema.channelMessages.createdAt, sql`${since.toISOString()}::timestamptz`),
      ),
    );

  for (const ask of asks) {
    if (ask.parentUserId === null) continue;
    result.asksExamined += 1;
    const offerId = offerIdFromMidActivityDedupeKey(ask.dedupeKey);
    if (offerId === null) {
      result.noSubject += 1;
      continue;
    }
    const stored = await captureAsk(database, deps, result, {
      askMessageId: ask.id,
      familyId: ask.familyId,
      parentUserId: ask.parentUserId,
      askedAt: ask.askedAt,
      offerId,
    });
    if (stored === 'recorded') result.recorded += 1;
    else if (stored === 'updated') result.updated += 1;
  }

  return result;
}

interface AskUnderRead {
  askMessageId: string;
  familyId: string;
  parentUserId: string;
  askedAt: Date;
  offerId: string;
}

async function captureAsk(
  database: Database,
  deps: { verdict: VerdictReader; now: Date },
  result: MidActivityAnswerResult,
  ask: AskUnderRead,
): Promise<'recorded' | 'updated' | 'skipped'> {
  const [offer] = await database
    .select({
      activityKey: schema.authorizedSignupOffers.activityKey,
      childDob: schema.children.dateOfBirth,
    })
    .from(schema.authorizedSignupOffers)
    .innerJoin(schema.children, eq(schema.children.id, schema.authorizedSignupOffers.childId))
    .where(
      and(
        eq(schema.authorizedSignupOffers.id, ask.offerId),
        eq(schema.authorizedSignupOffers.familyId, ask.familyId),
      ),
    )
    .limit(1);
  if (!offer) {
    result.noSubject += 1;
    return 'skipped';
  }
  if (deriveStage(offer.childDob, deps.now) === 'teenager') {
    result.teenScoped += 1;
    return 'skipped';
  }
  if (!isUuid(offer.activityKey)) {
    result.noSubject += 1;
    return 'skipped';
  }

  const [candidate] = await database
    .select({
      familyId: schema.villageCandidates.familyId,
      placeId: schema.villageCandidates.placeId,
      civicVenueId: schema.villageCandidates.civicVenueId,
    })
    .from(schema.villageCandidates)
    .where(
      and(
        eq(schema.villageCandidates.id, offer.activityKey),
        eq(schema.villageCandidates.familyId, ask.familyId),
      ),
    )
    .limit(1);
  const subject = candidate ? subjectOf(candidate, ask.familyId) : null;
  if (subject === null) {
    result.noSubject += 1;
    return 'skipped';
  }

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
        gt(schema.channelMessages.createdAt, sql`${ask.askedAt.toISOString()}::timestamptz`),
      ),
    )
    .orderBy(asc(schema.channelMessages.createdAt))
    .limit(5);

  const own = inbounds.filter((row) => row.parentUserId === ask.parentUserId);
  if (own.length === 0) {
    if (inbounds.length === 0) result.noReply += 1;
    else result.wrongParent += 1;
    return 'skipped';
  }
  const inbound = own[own.length - 1];
  if (!inbound) {
    result.noReply += 1;
    return 'skipped';
  }

  const [zone] = await database
    .select({ timezone: schema.users.timezone })
    .from(schema.users)
    .where(eq(schema.users.id, ask.parentUserId))
    .limit(1);
  if (!zone || !askStillStanding(ask.askedAt, inbound.createdAt, zone.timezone)) {
    result.askClosed += 1;
    return 'skipped';
  }

  const [newer] = await database
    .select({ id: schema.channelMessages.id })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.parentUserId, ask.parentUserId),
        eq(schema.channelMessages.direction, 'out'),
        inArray(schema.channelMessages.status, [...SENT_STATUSES]),
        gt(schema.channelMessages.createdAt, ask.askedAt),
        lte(schema.channelMessages.createdAt, inbound.createdAt),
      ),
    )
    .limit(1);
  if (newer) {
    result.askClosed += 1;
    return 'skipped';
  }

  const outcome = await deps.verdict.read(inbound.body ?? '');
  return applyOutcome(
    database,
    result,
    ask,
    subject,
    offer.childDob,
    inbound.id,
    outcome,
    deps.now,
  );
}

async function applyOutcome(
  database: Database,
  result: MidActivityAnswerResult,
  ask: AskUnderRead,
  subject: ReviewSubjectRef,
  childDateOfBirth: string,
  sourceMessageId: string,
  outcome: VerdictOutcome,
  now: Date,
): Promise<'recorded' | 'updated' | 'skipped'> {
  if (outcome.status === 'deferred') {
    result.deferred += 1;
    return 'skipped';
  }
  if (outcome.status === 'extraction_failed') {
    result.extractionFailed += 1;
    return 'skipped';
  }

  const written = await storeHouseholdVerdict(database, {
    familyId: ask.familyId,
    sourceMessageId,
    subject,
    verdict: outcome.status === 'read' ? outcome.verdict : null,
    tags: outcome.status === 'read' ? outcome.tags : [],
    childDateOfBirth,
    now,
  });
  if (written.stored === false) {
    if (written.reason === 'teen_scoped') result.teenScoped += 1;
    else result.noArea += 1;
    return 'skipped';
  }
  if (written.stored === 'no_verdict') {
    result.noVerdict += 1;
    return 'skipped';
  }
  return written.stored;
}
