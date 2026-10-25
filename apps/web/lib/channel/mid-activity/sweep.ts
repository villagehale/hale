import { type Database, schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { SENT_STATUSES, dedupeActive } from '~/lib/channel/ledger';
import {
  type OutboundGatePorts,
  assertProactiveSendAllowed,
  buildOutboundGatePorts,
} from '~/lib/channel/outbound-gate';
import { type CandidateDraft, queueCheckInForDecider } from '~/lib/channel/proactive/queue';
import { LINE_CHARS } from '~/lib/channel/proactive/tools';
import { DEFAULT_TIMEZONE } from '~/lib/format/datetime';
import { addDaysToKey, dayKeyIn, zonedLocalInstant } from '~/lib/plan/spine';
import type { ReviewSubjectRef } from '~/lib/reviews/aggregate';
import { MID_ACTIVITY_ASK_TEMPLATE_KEY, isUuid, midActivityAskDedupeKey } from './claim';
import {
  type CheckInCadence,
  cadenceFromSessionStarts,
  decideMidActivityAsk,
  preferenceFromCheckIn,
  sessionsElapsed,
} from './decide';
import { midActivityAskEnabled } from './flag';

/**
 * VIL-393 step 3 — ask once, mid-activity. The SENDER IS the proactive decider: a due
 * ask is queued as a `mid_activity_ask` candidate and the decider's writer words it
 * (no locked line), inside the outbound gate, quiet hours and same-item dedupe.
 *
 * The working set is a completed authorized signup: that is the activity the
 * household is in. Session starts say how often it runs. The check-in cadence
 * says how often the parent wants to be asked, and a missing row prefers fewer.
 * A priced session is not a gate. This product does not charge for the ask.
 *
 * The once-only key is the ledger row the decider writes when the ask actually
 * leaves; queueing claims nothing, so a held ask is retried on a later tick.
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
  /** Queued for the decider to word and send. */
  queued: number;
  /** Already queued and still open. */
  duplicate: number;
  /** The outbound gate held this family (quiet hours, consent, STOP). */
  held: number;
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
    queued: 0,
    duplicate: 0,
    held: 0,
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
  title: string | null;
}

export interface MidActivityAskDeps {
  buildGate(database: Database): OutboundGatePorts;
  dedupeActive: typeof dedupeActive;
  queueCandidate(database: Database, draft: CandidateDraft): Promise<'queued' | 'duplicate'>;
}

export function defaultMidActivityAskDeps(): MidActivityAskDeps {
  return {
    buildGate: buildOutboundGatePorts,
    dedupeActive: (key, database) => dedupeActive(key, database),
    queueCandidate: queueCheckInForDecider,
  };
}

/**
 * Decide which completed signups are at their one mid-activity node.
 * Does not send itself: a due ask is queued for the proactive decider.
 */
export async function runMidActivityAskSweep(
  database: Database,
  now: Date = new Date(),
  deps: MidActivityAskDeps = defaultMidActivityAskDeps(),
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
            id: schema.familyActivityHistory.id,
            familyId: schema.familyActivityHistory.familyId,
            placeId: schema.familyActivityHistory.placeId,
            civicVenueId: schema.familyActivityHistory.civicVenueId,
            title: schema.familyActivityHistory.title,
          })
          .from(schema.familyActivityHistory)
          .where(inArray(schema.familyActivityHistory.id, candidateIds));
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
    due.push({ familyId: offer.familyId, offerId: offer.offerId, title: candidate.title });
  }

  const seenFamily = new Set<string>();
  for (const ask of due) {
    if (seenFamily.has(ask.familyId)) {
      result.oneAtATime += 1;
      continue;
    }
    seenFamily.add(ask.familyId);
    await queueAsk(database, deps, ask, now, result);
  }
  if (result.queued > 0) {
    console.info({ queued: result.queued }, 'mid-activity ask: queued for the decider');
  }
  return result;
}

/** The primary parent the ask is addressed to, and their clock. */
async function primaryParent(
  database: Database,
  familyId: string,
): Promise<{ parentUserId: string; timeZone: string } | null> {
  const [row] = await database
    .select({ parentUserId: schema.users.id, timeZone: schema.users.timezone })
    .from(schema.familyMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.familyMembers.userId))
    .where(
      and(
        eq(schema.familyMembers.familyId, familyId),
        eq(schema.familyMembers.role, 'primary_parent'),
      ),
    )
    .limit(1);
  return row
    ? { parentUserId: row.parentUserId, timeZone: row.timeZone ?? DEFAULT_TIMEZONE }
    : null;
}

async function queueAsk(
  database: Database,
  deps: MidActivityAskDeps,
  ask: DueAsk,
  now: Date,
  result: MidActivityAskResult,
): Promise<void> {
  const parent = await primaryParent(database, ask.familyId);
  if (!parent) {
    result.noSubject += 1;
    return;
  }
  const verdict = await assertProactiveSendAllowed(
    { familyId: ask.familyId, parentUserId: parent.parentUserId, kind: 'mid_activity_ask', now },
    deps.buildGate(database),
  );
  if (!verdict.allowed) {
    result.held += 1;
    return;
  }
  const dedupeKey = midActivityAskDedupeKey(ask.offerId);
  if (await deps.dedupeActive(dedupeKey, database)) {
    result.alreadyAsked += 1;
    return;
  }
  // Facts only: the activity's own title. The writer speaks; nothing here is a line.
  const what = `how ${ask.title?.trim() || 'the class they signed up for'} is going so far`;
  const queued = await deps.queueCandidate(database, {
    familyId: ask.familyId,
    parentUserId: parent.parentUserId,
    kind: 'mid_activity_ask',
    category: 'activity_followup',
    templateKey: MID_ACTIVITY_ASK_TEMPLATE_KEY,
    what: what.slice(0, LINE_CHARS),
    why: 'one mid-activity ask; the answer shapes the next find',
    sourceUrl: null,
    // Asked in the evening; lapses at 08:00 two local mornings out.
    worthlessAfter: zonedLocalInstant(
      addDaysToKey(dayKeyIn(now, parent.timeZone), 2),
      '08:00',
      parent.timeZone,
    ),
    parentRequested: false,
    dedupeKey,
  });
  if (queued === 'duplicate') result.duplicate += 1;
  else result.queued += 1;
}
