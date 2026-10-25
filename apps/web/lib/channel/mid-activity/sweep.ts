import { type Database, schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import { and, asc, eq, gte, inArray, isNotNull, isNull, lte } from 'drizzle-orm';
import { SENT_STATUSES, dedupeActive } from '~/lib/channel/ledger';
import {
  type OutboundGatePorts,
  assertProactiveSendAllowed,
  buildOutboundGatePorts,
} from '~/lib/channel/outbound-gate';
import { type CandidateDraft, queueCheckInForDecider } from '~/lib/channel/proactive/queue';
import { boundedLine } from '~/lib/channel/proactive/tools';
import { DEFAULT_TIMEZONE } from '~/lib/format/datetime';
import type { ReviewSubjectRef } from '~/lib/reviews/aggregate';
import {
  MID_ACTIVITY_ASK_TEMPLATE_KEY,
  type MidActivityStart,
  isUuid,
  midActivityAskDedupeKey,
  midActivityStartDedupeKey,
} from './claim';
import {
  type CheckInCadence,
  decideMidActivityAsk,
  firstSessionAskWindow,
  firstSessionEnd,
  preferenceFromCheckIn,
} from './decide';
import { midActivityAskEnabled } from './flag';

/**
 * VIL-393 step 3 — one ask, the evening after the first session. The SENDER IS the
 * proactive decider: a due ask is queued as a `mid_activity_ask` candidate and the
 * decider's writer words it in the parent's language (no locked line), inside the
 * outbound gate, quiet hours and same-item dedupe.
 *
 * What starts an activity:
 *   - a completed authorized signup (its sessions say when the first one ends);
 *   - a Hale-placed calendar plan (a `placement` row an approved action wrote);
 *   - the parent saying they signed up — the coach queues that ask itself, held to
 *     the same evening (`queueSaidSignupAsk`).
 * The check-in cadence says whether the parent wants to be asked; `off` never asks.
 *
 * The payload is FACTS only: the activity's own title and when its first session
 * ended. The writer speaks; nothing here is a sentence.
 *
 * The once-only key is the ledger row the decider writes when the ask actually
 * leaves; queueing claims nothing, so a held ask is retried on a later tick.
 */

const MAX_OFFERS_PER_RUN = 200;

export interface MidActivityAskResult {
  /** `'flag_off'` when the lane did not read. Null when it ran. */
  skipped: 'flag_off' | null;
  examined: number;
  alreadyAsked: number;
  preferenceOff: number;
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
    alreadyAsked: 0,
    preferenceOff: 0,
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

/** How far back a placed plan's first session may have ended and still be asked about. */
const PLAN_LOOKBACK_MS = 2 * 24 * 3_600_000;

function subjectOf(
  row: { familyId: string; placeId: string | null; civicVenueId: string | null },
  familyId: string,
): ReviewSubjectRef | null {
  if (row.familyId !== familyId) return null;
  if (row.placeId) return { source: 'place', ref: row.placeId };
  if (row.civicVenueId) return { source: 'civic_venue', ref: row.civicVenueId };
  return null;
}

/** One activity that has started, from any source, before the ask is decided. */
interface StartedActivity {
  familyId: string;
  title: string | null;
  firstEndedAt: Date;
  dedupeKey: string;
  start: 'signup' | MidActivityStart;
}

interface DueAsk extends StartedActivity {
  parentUserId: string;
  closesAt: Date;
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

async function signupStarts(
  database: Database,
  now: Date,
  result: MidActivityAskResult,
): Promise<StartedActivity[]> {
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
  const out: StartedActivity[] = [];
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
    const firstEndedAt = firstSessionEnd(
      offer.sessions.map((session) => ({
        startsAt: new Date(session.startsAt),
        endsAt: session.endsAt ? new Date(session.endsAt) : null,
      })),
    );
    if (!firstEndedAt) {
      result.noSubject += 1;
      continue;
    }
    out.push({
      familyId: offer.familyId,
      title: candidate.title,
      firstEndedAt,
      dedupeKey: midActivityAskDedupeKey(offer.offerId),
      start: 'signup',
    });
  }
  return out;
}

/** A Hale-placed calendar plan whose (first) session ended recently. */
async function planStarts(
  database: Database,
  now: Date,
  result: MidActivityAskResult,
): Promise<StartedActivity[]> {
  const e = schema.familyEvents;
  const rows = await database
    .select({
      eventId: e.id,
      familyId: e.familyId,
      title: e.title,
      startsAt: e.startsAt,
      endsAt: e.endsAt,
      sensitive: e.sensitive,
      childDob: schema.children.dateOfBirth,
      payload: schema.actions.payload,
    })
    .from(e)
    .innerJoin(schema.actions, eq(schema.actions.id, e.placedByActionId))
    .leftJoin(schema.children, eq(schema.children.id, e.childId))
    .where(
      and(
        eq(e.source, 'placement'),
        isNull(e.deletedAt),
        isNotNull(e.placedByActionId),
        gte(e.startsAt, new Date(now.getTime() - PLAN_LOOKBACK_MS)),
        lte(e.startsAt, now),
      ),
    )
    .orderBy(asc(e.startsAt))
    .limit(MAX_OFFERS_PER_RUN);
  const out: StartedActivity[] = [];
  for (const row of rows) {
    result.examined += 1;
    if (row.sensitive || (row.childDob && deriveStage(row.childDob, now) === 'teenager')) {
      result.teenScoped += 1;
      continue;
    }
    const firstEndedAt = firstSessionEnd([{ startsAt: row.startsAt, endsAt: row.endsAt }]);
    if (!firstEndedAt) continue;
    const ref = (row.payload as { sourceRef?: { table?: unknown; id?: unknown } | null }).sourceRef;
    const candidateId =
      ref?.table === 'family_activity_history' && typeof ref.id === 'string' && isUuid(ref.id)
        ? ref.id
        : null;
    out.push({
      familyId: row.familyId,
      title: row.title,
      firstEndedAt,
      dedupeKey: midActivityStartDedupeKey({ start: 'plan', occurrence: row.eventId, candidateId }),
      start: 'plan',
    });
  }
  return out;
}

/**
 * Decide which started activities are at their one ask, the evening after the first
 * session. Does not send itself: a due ask is queued for the proactive decider.
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
  const started = [
    ...(await signupStarts(database, now, result)),
    ...(await planStarts(database, now, result)),
  ];
  if (started.length === 0) return result;

  const familyIds = [...new Set(started.map((row) => row.familyId))];
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

  const asked = await database
    .select({ dedupeKey: schema.channelMessages.dedupeKey })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.templateKey, MID_ACTIVITY_ASK_TEMPLATE_KEY),
        inArray(schema.channelMessages.status, [...SENT_STATUSES]),
        inArray(
          schema.channelMessages.dedupeKey,
          started.map((row) => row.dedupeKey),
        ),
      ),
    );
  const askedKeys = new Set(asked.map((row) => row.dedupeKey));

  const parents = new Map<string, Awaited<ReturnType<typeof primaryParent>>>();
  const due: DueAsk[] = [];
  for (const activity of started) {
    if (!parents.has(activity.familyId)) {
      parents.set(activity.familyId, await primaryParent(database, activity.familyId));
    }
    const parent = parents.get(activity.familyId);
    if (!parent) {
      result.noSubject += 1;
      continue;
    }
    const cadence = cadenceByFamily.get(activity.familyId);
    const decision = decideMidActivityAsk({
      preference: preferenceFromCheckIn(cadence === undefined ? null : { cadence }),
      firstSessionEndedAt: activity.firstEndedAt,
      timeZone: parent.timeZone,
      now,
      alreadyAsked: askedKeys.has(activity.dedupeKey),
    });
    if (!decision.ask) {
      if (decision.reason === 'already_asked') result.alreadyAsked += 1;
      else if (decision.reason === 'preference_off') result.preferenceOff += 1;
      else if (decision.reason === 'too_soon') result.tooSoon += 1;
      else result.pastWindow += 1;
      continue;
    }
    due.push({ ...activity, parentUserId: parent.parentUserId, closesAt: decision.closesAt });
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

/**
 * The candidate the decider reads: facts only. `what` is the activity's own title (or
 * empty when there is none), `why` names the start and when the first session ended.
 */
export function midActivityAskDraft(input: {
  familyId: string;
  parentUserId: string;
  title: string | null;
  start: 'signup' | MidActivityStart;
  firstEndedAt: Date;
  closesAt: Date;
  dedupeKey: string;
}): CandidateDraft {
  return {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    kind: 'mid_activity_ask',
    category: 'activity_followup',
    templateKey: MID_ACTIVITY_ASK_TEMPLATE_KEY,
    what: boundedLine(input.title ?? ''),
    why: boundedLine(
      `mid_activity_ask start=${input.start} first_session_ended=${input.firstEndedAt.toISOString()}`,
    ),
    sourceUrl: null,
    worthlessAfter: input.closesAt,
    parentRequested: false,
    dedupeKey: input.dedupeKey,
  };
}

async function queueAsk(
  database: Database,
  deps: MidActivityAskDeps,
  ask: DueAsk,
  now: Date,
  result: MidActivityAskResult,
): Promise<void> {
  const verdict = await assertProactiveSendAllowed(
    { familyId: ask.familyId, parentUserId: ask.parentUserId, kind: 'mid_activity_ask', now },
    deps.buildGate(database),
  );
  if (!verdict.allowed) {
    result.held += 1;
    return;
  }
  if (await deps.dedupeActive(ask.dedupeKey, database)) {
    result.alreadyAsked += 1;
    return;
  }
  const queued = await deps.queueCandidate(database, midActivityAskDraft(ask));
  if (queued === 'duplicate') result.duplicate += 1;
  else result.queued += 1;
}

/**
 * VIL-393 · the parent said they signed up (in any words; the coach model decides).
 * Queue the one ask HELD until the evening after the first session, so the decider
 * picks it up then. A start whose evening has already passed is not queued.
 */
export async function queueSaidSignupAsk(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    title: string;
    firstSessionStartsAt: Date;
    firstSessionEndsAt: Date | null;
    candidateId: string | null;
    timeZone: string;
    now: Date;
  },
): Promise<'queued' | 'duplicate' | 'past_window' | 'preference_off' | 'flag_off'> {
  if (!midActivityAskEnabled()) return 'flag_off';
  const [pref] = await database
    .select({ cadence: schema.familyCheckInPrefs.cadence })
    .from(schema.familyCheckInPrefs)
    .where(eq(schema.familyCheckInPrefs.familyId, input.familyId))
    .limit(1);
  if (preferenceFromCheckIn(pref ?? null) === 'off') return 'preference_off';
  const firstEndedAt = firstSessionEnd([
    { startsAt: input.firstSessionStartsAt, endsAt: input.firstSessionEndsAt },
  ]);
  if (!firstEndedAt) return 'past_window';
  const { opensAt, closesAt } = firstSessionAskWindow(firstEndedAt, input.timeZone);
  if (input.now.getTime() >= closesAt.getTime()) return 'past_window';
  const draft = midActivityAskDraft({
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    title: input.title,
    start: 'said',
    firstEndedAt,
    closesAt,
    dedupeKey: midActivityStartDedupeKey({
      start: 'said',
      occurrence: firstEndedAt.toISOString().slice(0, 10),
      candidateId: input.candidateId,
    }),
  });
  const inserted = await database
    .insert(schema.proactiveCandidates)
    .values({ ...draft, status: 'held', holdUntil: opensAt, reason: 'first_session_evening' })
    .onConflictDoNothing({
      target: [schema.proactiveCandidates.familyId, schema.proactiveCandidates.dedupeKey],
    })
    .returning({ id: schema.proactiveCandidates.id });
  return inserted.length === 0 ? 'duplicate' : 'queued';
}
