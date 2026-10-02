import { type Database, schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { SENT_STATUSES } from '~/lib/channel/ledger';
import type { ReviewSubjectRef } from '~/lib/reviews/aggregate';
import { MID_ACTIVITY_ASK_TEMPLATE_KEY, isUuid, midActivityAskDedupeKey } from './claim';
import { midActivityAsk, midActivityCopyMayLeave } from './copy';
import {
  type CheckInCadence,
  cadenceFromSessionStarts,
  decideMidActivityAsk,
  preferenceFromCheckIn,
  sessionsElapsed,
} from './decide';
import { midActivityAskEnabled } from './flag';

/**
 * VIL-393 step 3 — ask once, mid-activity. The line is locked. No sender is wired.
 *
 * The working set is a completed authorized signup: that is the activity the
 * household is in. Session starts say how often it runs. The check-in cadence
 * says how often the parent wants to be asked, and a missing row prefers fewer.
 * A priced session is not a gate. This product does not charge for the ask.
 *
 * A due ask whose locked line can leave is `unwired`: no `channel_messages`
 * row is written. Writing one would claim the once-only key for a text that
 * never left. `placeholder` stays for a line that still cannot leave.
 */

const MAX_OFFERS_PER_RUN = 200;

export interface MidActivityAskResult {
  /** `'flag_off'` when the lane did not read. Null when it ran. */
  skipped: 'flag_off' | null;
  examined: number;
  placeholder: number;
  alreadyAsked: number;
  preferenceOff: number;
  tooRare: number;
  tooSoon: number;
  pastWindow: number;
  noSubject: number;
  teenScoped: number;
  /** A second activity was also due. One household hears about one. */
  oneAtATime: number;
  /**
   * Copy could leave and no sender is wired. Named rather than counted as a
   * send: this sweep does not text. Zero while the line is still a placeholder.
   */
  unwired: number;
}

function emptyAsk(skipped: 'flag_off' | null): MidActivityAskResult {
  return {
    skipped,
    examined: 0,
    placeholder: 0,
    alreadyAsked: 0,
    preferenceOff: 0,
    tooRare: 0,
    tooSoon: 0,
    pastWindow: 0,
    noSubject: 0,
    teenScoped: 0,
    oneAtATime: 0,
    unwired: 0,
  };
}

function startsOf(sessions: readonly { startsAt: string }[]): Date[] {
  const starts: Date[] = [];
  for (const session of sessions) {
    const at = new Date(session.startsAt);
    if (Number.isNaN(at.getTime())) continue;
    starts.push(at);
  }
  return starts;
}

function subjectOf(
  row: { familyId: string; placeId: string | null; civicVenueId: string | null },
  familyId: string,
): ReviewSubjectRef | null {
  if (row.familyId !== familyId) return null;
  if (row.placeId) return { source: 'place', ref: row.placeId };
  if (row.civicVenueId) return { source: 'civic_venue', ref: row.civicVenueId };
  return null;
}

interface DueAsk {
  familyId: string;
  offerId: string;
}

/**
 * Decide which completed signups are at their one mid-activity node.
 * Does not send. A due ask whose copy cannot leave is `placeholder`.
 */
export async function runMidActivityAskSweep(
  database: Database,
  now: Date = new Date(),
): Promise<MidActivityAskResult> {
  if (!midActivityAskEnabled()) {
    console.info({ env: 'MID_ACTIVITY_ASK_ENABLED' }, 'mid-activity ask: dark, nothing read');
    return emptyAsk('flag_off');
  }

  const result = emptyAsk(null);
  const offers = await database
    .select({
      offerId: schema.authorizedSignupOffers.id,
      familyId: schema.authorizedSignupOffers.familyId,
      activityKey: schema.authorizedSignupOffers.activityKey,
      sessions: schema.authorizedSignupOffers.sessions,
      childDob: schema.children.dateOfBirth,
    })
    .from(schema.authorizedSignupOffers)
    .innerJoin(schema.children, eq(schema.children.id, schema.authorizedSignupOffers.childId))
    .where(eq(schema.authorizedSignupOffers.status, 'completed'))
    .orderBy(asc(schema.authorizedSignupOffers.createdAt))
    .limit(MAX_OFFERS_PER_RUN);

  if (offers.length === 0) return result;

  const familyIds = [...new Set(offers.map((offer) => offer.familyId))];
  const prefs = await database
    .select({
      familyId: schema.familyCheckInPrefs.familyId,
      cadence: schema.familyCheckInPrefs.cadence,
    })
    .from(schema.familyCheckInPrefs)
    .where(inArray(schema.familyCheckInPrefs.familyId, familyIds));
  const cadenceByFamily = new Map<string, CheckInCadence>(
    prefs.map((row) => [row.familyId, row.cadence]),
  );

  const candidateIds = [
    ...new Set(offers.map((offer) => offer.activityKey).filter((key) => isUuid(key))),
  ];
  const candidates =
    candidateIds.length === 0
      ? []
      : await database
          .select({
            id: schema.villageCandidates.id,
            familyId: schema.villageCandidates.familyId,
            placeId: schema.villageCandidates.placeId,
            civicVenueId: schema.villageCandidates.civicVenueId,
          })
          .from(schema.villageCandidates)
          .where(inArray(schema.villageCandidates.id, candidateIds));
  const candidateById = new Map(candidates.map((row) => [row.id, row]));

  const dedupeKeys = offers.map((offer) => midActivityAskDedupeKey(offer.offerId));
  const asked = await database
    .select({ dedupeKey: schema.channelMessages.dedupeKey })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.templateKey, MID_ACTIVITY_ASK_TEMPLATE_KEY),
        inArray(schema.channelMessages.status, [...SENT_STATUSES]),
        inArray(schema.channelMessages.dedupeKey, dedupeKeys),
      ),
    );
  const askedKeys = new Set(asked.map((row) => row.dedupeKey));

  const due: DueAsk[] = [];
  for (const offer of offers) {
    result.examined += 1;
    if (deriveStage(offer.childDob, now) === 'teenager') {
      result.teenScoped += 1;
      continue;
    }
    const candidate = isUuid(offer.activityKey) ? candidateById.get(offer.activityKey) : undefined;
    if (!candidate || subjectOf(candidate, offer.familyId) === null) {
      result.noSubject += 1;
      continue;
    }
    const starts = startsOf(offer.sessions);
    const decision = decideMidActivityAsk({
      cadence: cadenceFromSessionStarts(starts),
      preference: preferenceFromCheckIn(
        cadenceByFamily.has(offer.familyId)
          ? { cadence: cadenceByFamily.get(offer.familyId) as CheckInCadence }
          : null,
      ),
      sessionsElapsed: sessionsElapsed(starts, now),
      sessionsPlanned: starts.length,
      alreadyAsked: askedKeys.has(midActivityAskDedupeKey(offer.offerId)),
    });
    if (!decision.ask) {
      if (decision.reason === 'already_asked') result.alreadyAsked += 1;
      else if (decision.reason === 'preference_off') result.preferenceOff += 1;
      else if (decision.reason === 'too_rare') result.tooRare += 1;
      else if (decision.reason === 'too_soon') result.tooSoon += 1;
      else result.pastWindow += 1;
      continue;
    }
    due.push({ familyId: offer.familyId, offerId: offer.offerId });
  }

  const seenFamily = new Set<string>();
  for (const ask of due) {
    if (seenFamily.has(ask.familyId)) {
      result.oneAtATime += 1;
      continue;
    }
    seenFamily.add(ask.familyId);
    if (!midActivityCopyMayLeave(midActivityAsk(null, 'en'))) {
      result.placeholder += 1;
      continue;
    }
    result.unwired += 1;
  }

  if (result.placeholder > 0) {
    console.info(
      { placeholder: result.placeholder },
      'mid-activity ask: due, held because the line is still a design placeholder',
    );
  }
  if (result.unwired > 0) {
    console.info(
      { unwired: result.unwired },
      'mid-activity ask: copy may leave but no sender is wired',
    );
  }
  return result;
}
