import type { AgentClient } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { and, eq, inArray, ne } from 'drizzle-orm';
import {
  matchHandWindows,
  productionRegistrationContextPorts,
} from '~/lib/channel/coach/registration-context';
import { f14EnabledFor } from '~/lib/channel/f14';
import {
  type FamilyTextRecipient,
  TEXTABLE_ROLES,
  loadFamilyTextRecipients,
} from '~/lib/channel/family-recipients';
import {
  type OutboundGatePorts,
  assertProactiveSendAllowed,
  buildOutboundGatePorts,
} from '~/lib/channel/outbound-gate';
import { type CandidateDraft, queueCheckInForDecider } from '~/lib/channel/proactive/queue';
import { boundedLine } from '~/lib/channel/proactive/tools';
import { createLiveRegistrationReader } from '../read';
import { REGISTRATION_OPENING_KIND, cityOpeningFacts } from './context';
import { winterCycleLabel } from './cycle';
import { ownCityRegistrationEnabled } from './flag';
import {
  type CityLookup,
  type CityLookupDeps,
  lookupCityRegistration,
  opensForFamily,
  pageSaysNotYet,
  readCityPage,
  readDidNotFinish,
} from './lookup';
import { cachedOfficialSite, wikidataSource } from './official-site';
import { type OwnCity, cityKey, readOwnCity } from './place';
import { searchRegistrationPages } from './search';
import { type StoredCityReading, latestCityReading, recordCityReading } from './store';

/**
 * VIL-684 · the hourly own-city sweep. For every family Hale texts, wherever they live:
 *
 *   1. LOOK UP their city's winter opening when the cached reading is missing or stale —
 *      one lookup per city, shared by every family there. A city Hale already has a page
 *      for is re-read on that page first; only when it no longer verifies is the city
 *      searched again.
 *   2. TELL each parent once, by queueing a `registration_opening` candidate for the
 *      proactive decider. The decider decides whether and when, its writer words it, and
 *      the outbound gate keeps it inside the parent's daytime. Nothing here writes a word
 *      a parent reads, and a writer that fails sends nothing.
 *
 * A family the hand-verified radar already covers is left to it, so one season never
 * reaches a parent from two sources. A date that moved, or one a readable official page
 * now says is not out, drops the tell still waiting on the old one. A read that did not
 * finish, or one that could not be verified, drops nothing and keeps the known date: it
 * is asked again next sweep. A date the page confirms again after it was taken back is
 * queued again.
 */

/** Lookups one run may start. An infra bound on the function's 300 s wall (one lookup is
 * a search turn and up to three page reads), not a send rule: a city left over is looked
 * up next hour. */
export const MAX_CITY_LOOKUPS_PER_RUN = 3;

export const REGISTRATION_OPENING_TEMPLATE_KEY = 'registration-opening';

export interface CityRegistrationSweepResult {
  /** The lane did not run. Null when it ran. */
  skipped: 'flag_off' | null;
  families: number;
  f14Dark: number;
  noChildren: number;
  placeUnknown: number;
  /** The hand-verified radar has a window for this family; it speaks for this season. */
  handRadar: number;
  lookedUp: number;
  verified: number;
  notFound: number;
  /** A lookup that did not finish (search failed, reader busy): nothing stored. */
  retry: number;
  /** No model client on this deploy: due cities were not looked up. */
  noClient: number;
  /** Due cities past this run's lookup bound, left for the next run. */
  deferred: number;
  /** The family's city has no verified opening for them yet. */
  notKnown: number;
  /** Already opened. */
  past: number;
  held: number;
  queued: number;
  duplicate: number;
  /** Tells for a date the page no longer states, dropped. */
  superseded: number;
  /** Cities whose lookup or tells threw. */
  failed: number;
}

function emptyResult(skipped: CityRegistrationSweepResult['skipped']) {
  return {
    skipped,
    families: 0,
    f14Dark: 0,
    noChildren: 0,
    placeUnknown: 0,
    handRadar: 0,
    lookedUp: 0,
    verified: 0,
    notFound: 0,
    retry: 0,
    noClient: 0,
    deferred: 0,
    notKnown: 0,
    past: 0,
    held: 0,
    queued: 0,
    duplicate: 0,
    superseded: 0,
    failed: 0,
  } satisfies CityRegistrationSweepResult;
}

export interface CityRegistrationSweepDeps {
  /** Null when this deploy has no model client: lookups are counted as `noClient`. */
  lookup: CityLookupDeps | null;
  buildGate(database: Database): OutboundGatePorts;
  queueCandidate(database: Database, draft: CandidateDraft): Promise<'queued' | 'duplicate'>;
  f14For(familyId: string): boolean;
  handRadarCovers(database: Database, familyId: string, now: Date): Promise<boolean>;
  recipients(database: Database, familyId: string): Promise<FamilyTextRecipient[]>;
}

export function cityLookupDeps(client: AgentClient, database: Database): CityLookupDeps {
  const source = wikidataSource();
  return {
    officialSite: (place, now) => cachedOfficialSite(database, source, place, now),
    search: (place, cycleLabel, today) => searchRegistrationPages(client, place, cycleLabel, today),
    read: createLiveRegistrationReader(client, { yearFromWeekday: true }),
  };
}

export function defaultCityRegistrationSweepDeps(
  client: AgentClient | null,
  database: Database,
): CityRegistrationSweepDeps {
  return {
    lookup: client ? cityLookupDeps(client, database) : null,
    buildGate: buildOutboundGatePorts,
    queueCandidate: queueCheckInForDecider,
    f14For: f14EnabledFor,
    handRadarCovers: async (database, familyId, now) =>
      (await matchHandWindows(productionRegistrationContextPorts(database), familyId, now)).length >
      0,
    recipients: loadFamilyTextRecipients,
  };
}

/** One tell per parent per opening, ever: the city, the season and the calendar day. A
 * moved day is a new key; a re-read that prints (or drops) the time is not. */
export function registrationOpeningDedupeKey(input: {
  familyId: string;
  parentUserId: string;
  place: Pick<OwnCity, 'city' | 'provinceOrState' | 'country' | 'district'>;
  cycleLabel: string;
  openingDate: string;
}): string {
  return [
    REGISTRATION_OPENING_TEMPLATE_KEY,
    input.familyId,
    input.parentUserId,
    cityKey(input.place),
    input.cycleLabel.replace(/\s+/g, '-'),
    input.openingDate,
  ].join(':');
}

/** The reasons the sweep itself takes a waiting tell back for. A row it dropped is not a
 * tell the parent had: when the page confirms that date again, it is queued again. A row
 * the decider dropped, or one already sent, is the decider's and stays. */
const SWEEP_DROP_REASONS = ['date_unconfirmed', 'date_changed'] as const;

/** The families with a seat Hale texts and at least one child. */
async function loadFamilies(database: Database): Promise<string[]> {
  const rows = await database
    .selectDistinct({ familyId: schema.familyMembers.familyId })
    .from(schema.familyMembers)
    .where(inArray(schema.familyMembers.role, [...TEXTABLE_ROLES]));
  return rows.map((row) => row.familyId);
}

async function hasChildren(database: Database, familyId: string): Promise<boolean> {
  const [row] = await database
    .select({ id: schema.children.id })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId))
    .limit(1);
  return row !== undefined;
}

/** This tell's row, in any status: once per parent per opening, ever. */
async function existingTell(
  database: Database,
  familyId: string,
  dedupeKey: string,
): Promise<{ id: string; status: string; reason: string | null } | undefined> {
  const t = schema.proactiveCandidates;
  const [row] = await database
    .select({ id: t.id, status: t.status, reason: t.reason })
    .from(t)
    .where(and(eq(t.familyId, familyId), eq(t.dedupeKey, dedupeKey)))
    .limit(1);
  return row;
}

function droppedBySweep(row: { status: string; reason: string | null }): boolean {
  return (
    row.status === 'dropped' &&
    (SWEEP_DROP_REASONS as readonly (string | null)[]).includes(row.reason)
  );
}

/** Drop this parent's open tells other than `keep` (none when `keep` is null). */
async function dropStaleTells(
  database: Database,
  input: { familyId: string; parentUserId: string; keep: string | null; reason: string },
  now: Date,
): Promise<number> {
  const t = schema.proactiveCandidates;
  const dropped = await database
    .update(t)
    .set({ status: 'dropped', what: '', reason: input.reason, decidedAt: now })
    .where(
      and(
        eq(t.familyId, input.familyId),
        eq(t.parentUserId, input.parentUserId),
        eq(t.kind, REGISTRATION_OPENING_KIND),
        inArray(t.status, ['queued', 'held']),
        ...(input.keep === null ? [] : [ne(t.dedupeKey, input.keep)]),
      ),
    )
    .returning({ id: t.id });
  if (dropped.length > 0) {
    await database.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: 'system',
      actionTaken: 'proactive_cadence_skipped',
      targetTable: 'families',
      targetId: input.familyId,
      after: {
        kind: REGISTRATION_OPENING_KIND,
        reason: input.reason,
        itemIds: dropped.map((row) => row.id),
      },
    });
  }
  return dropped.length;
}

/**
 * Bring one city's reading up to date. A known page is re-read first; a page that no
 * longer verifies, or no page at all, is a fresh lookup. Returns the reading to use,
 * which is the stored one when nothing new could be read.
 *
 * A KNOWN DATE GIVES WAY ONLY TO A READABLE OFFICIAL PAGE THAT SAYS THE SEASON IS NOT
 * OUT. A read that did not finish asks again next sweep and searches nothing; a page that
 * could not be verified (a shaky read, a refusal, a yearless date) is not evidence the
 * date is gone, so it keeps the date too.
 */
async function refreshCity(
  database: Database,
  lookup: CityLookupDeps,
  place: OwnCity,
  cycleLabel: string,
  prior: StoredCityReading | null,
  now: Date,
  result: CityRegistrationSweepResult,
): Promise<StoredCityReading | null> {
  result.lookedUp += 1;
  const keep = (reason: string) => {
    result.retry += 1;
    console.info({ reason }, 'own-city registration: lookup did not finish');
    return prior;
  };
  let knownPageSaysNotYet = false;
  if (prior?.status === 'verified') {
    const again = await readCityPage(
      lookup.read,
      { place, cycleLabel, municipality: prior.municipality, sourceUrl: prior.sourceUrl },
      now,
    );
    if (again.status === 'verified' && opensForFamily(again, place)) {
      await recordCityReading(
        database,
        place,
        cycleLabel,
        {
          status: 'verified',
          municipality: prior.municipality,
          sourceUrl: prior.sourceUrl,
          reading: again,
        },
        now,
      );
      result.verified += 1;
      return latestCityReading(database, place, cycleLabel);
    }
    if (readDidNotFinish(again)) {
      return keep(`known_page_unread:${'reason' in again ? again.reason : again.status}`);
    }
    knownPageSaysNotYet = pageSaysNotYet(again, place);
  }
  const found = await lookupCityRegistration(lookup, place, cycleLabel, now);
  let outcome: Exclude<CityLookup, { status: 'retry' }>;
  if (found.status === 'verified' || prior?.status !== 'verified') {
    if (found.status === 'retry') return keep(found.reason);
    outcome = found;
  } else if (found.status === 'not_found' && found.reason === 'not_published') {
    outcome = found;
  } else if (knownPageSaysNotYet) {
    outcome = {
      status: 'not_found',
      reason: 'not_published',
      municipality: prior.municipality,
      tried: [{ url: prior.sourceUrl, outcome: 'says_not_yet' }],
    };
  } else {
    return keep(found.status === 'retry' ? found.reason : `unconfirmed:${found.reason}`);
  }
  await recordCityReading(database, place, cycleLabel, outcome, now);
  if (outcome.status === 'verified') result.verified += 1;
  else {
    result.notFound += 1;
    console.info(
      { reason: outcome.reason, tried: outcome.tried.map((page) => page.outcome) },
      'own-city registration: no verified opening',
    );
  }
  return latestCityReading(database, place, cycleLabel);
}

export async function runCityRegistrationSweep(
  database: Database,
  deps: CityRegistrationSweepDeps,
  now: Date = new Date(),
): Promise<CityRegistrationSweepResult> {
  if (!ownCityRegistrationEnabled()) {
    console.info(
      { env: 'OWN_CITY_REGISTRATION_ENABLED' },
      'own-city registration: dark, nothing read',
    );
    return emptyResult('flag_off');
  }
  const result: CityRegistrationSweepResult = emptyResult(null);
  const cycleLabel = winterCycleLabel(now);

  // Who, and where. A family the hand radar covers is not looked up for.
  const byCity = new Map<string, { place: OwnCity; familyIds: string[] }>();
  for (const familyId of await loadFamilies(database)) {
    result.families += 1;
    if (!deps.f14For(familyId)) {
      result.f14Dark += 1;
      continue;
    }
    if (!(await hasChildren(database, familyId))) {
      result.noChildren += 1;
      continue;
    }
    const own = await readOwnCity(database, familyId);
    if (own.status !== 'known') {
      result.placeUnknown += 1;
      continue;
    }
    if (await deps.handRadarCovers(database, familyId, now)) {
      result.handRadar += 1;
      continue;
    }
    const key = cityKey(own.place);
    const city = byCity.get(key) ?? { place: own.place, familyIds: [] };
    city.familyIds.push(familyId);
    byCity.set(key, city);
  }

  // Busiest cities first, so a bounded run reaches the most families.
  const cities = [...byCity.values()].sort((a, b) => b.familyIds.length - a.familyIds.length);
  const gate = deps.buildGate(database);
  let lookupsLeft = MAX_CITY_LOOKUPS_PER_RUN;
  for (const { place, familyIds } of cities) {
    // One city failing is that city's outcome, counted by name, never the other cities'.
    try {
      let reading = await latestCityReading(database, place, cycleLabel);
      const due = reading === null || reading.reverifyAt.getTime() <= now.getTime();
      if (due && deps.lookup === null) result.noClient += 1;
      else if (due && lookupsLeft === 0) result.deferred += 1;
      else if (due && deps.lookup !== null) {
        lookupsLeft -= 1;
        reading = await refreshCity(database, deps.lookup, place, cycleLabel, reading, now, result);
      }

      for (const familyId of familyIds) {
        await tellFamily(
          database,
          deps,
          gate,
          { familyId, place, cycleLabel, reading },
          now,
          result,
        );
      }
    } catch (err) {
      result.failed += 1;
      // The fault class only: a postgres-js message can carry a row's values.
      console.error(
        { fault: err instanceof Error ? err.name : typeof err },
        'own-city registration: city failed',
      );
    }
  }
  if (result.queued > 0 || result.superseded > 0) {
    console.info(
      { queued: result.queued, superseded: result.superseded },
      'own-city registration: tells queued for the decider',
    );
  }
  return result;
}

/** Put a tell the sweep itself took back on the queue again, as a fresh candidate. */
async function requeueTell(
  database: Database,
  id: string,
  draft: CandidateDraft,
  now: Date,
): Promise<'queued' | 'duplicate'> {
  const t = schema.proactiveCandidates;
  const revived = await database
    .update(t)
    .set({
      status: 'queued',
      reason: null,
      decision: null,
      holdUntil: null,
      decidedAt: null,
      what: draft.what,
      why: draft.why,
      sourceUrl: draft.sourceUrl,
      worthlessAfter: draft.worthlessAfter,
      createdAt: now,
    })
    .where(and(eq(t.id, id), eq(t.status, 'dropped'), inArray(t.reason, [...SWEEP_DROP_REASONS])))
    .returning({ id: t.id });
  return revived.length === 0 ? 'duplicate' : 'queued';
}

async function tellFamily(
  database: Database,
  deps: CityRegistrationSweepDeps,
  gate: OutboundGatePorts,
  input: {
    familyId: string;
    place: OwnCity;
    cycleLabel: string;
    reading: StoredCityReading | null;
  },
  now: Date,
  result: CityRegistrationSweepResult,
): Promise<void> {
  const { familyId, place, cycleLabel, reading } = input;
  const recipients = await deps.recipients(database, familyId);
  if (reading?.status !== 'verified') {
    result.notKnown += 1;
    // A page that now says nothing for this season takes back a date still waiting.
    if (reading?.status === 'not_found') {
      for (const { parentUserId } of recipients) {
        result.superseded += await dropStaleTells(
          database,
          { familyId, parentUserId, keep: null, reason: 'date_unconfirmed' },
          now,
        );
      }
    }
    return;
  }
  const facts = cityOpeningFacts(place, cycleLabel, reading.reading, now);
  if (facts === null) {
    result.past += 1;
    return;
  }
  for (const { parentUserId } of recipients) {
    const dedupeKey = registrationOpeningDedupeKey({
      familyId,
      parentUserId,
      place,
      cycleLabel,
      openingDate: facts.openingDate,
    });
    result.superseded += await dropStaleTells(
      database,
      { familyId, parentUserId, keep: dedupeKey, reason: 'date_changed' },
      now,
    );
    const existing = await existingTell(database, familyId, dedupeKey);
    if (existing !== undefined && !droppedBySweep(existing)) {
      result.duplicate += 1;
      continue;
    }
    // Before the queue, so a parent the gate refuses now is asked again next hour.
    const verdict = await assertProactiveSendAllowed(
      { familyId, parentUserId, kind: 'registration_opening', now },
      gate,
    );
    if (!verdict.allowed) {
      result.held += 1;
      continue;
    }
    const general = facts.generalOpens ? `; everyone else ${facts.generalOpens}` : '';
    const draft: CandidateDraft = {
      familyId,
      parentUserId,
      kind: 'registration_opening',
      category: 'nudge',
      templateKey: REGISTRATION_OPENING_TEMPLATE_KEY,
      what: boundedLine(
        `${facts.town} ${facts.programs} registration opens ${facts.opensFor}${general}`,
      ),
      why: `registration_opening read=${reading.readAt.toISOString()}`,
      sourceUrl: reading.sourceUrl,
      worthlessAfter: facts.opensAt,
      parentRequested: false,
      dedupeKey,
    };
    const queued =
      existing === undefined
        ? await deps.queueCandidate(database, draft)
        : await requeueTell(database, existing.id, draft, now);
    if (queued === 'duplicate') {
      result.duplicate += 1;
      continue;
    }
    result.queued += 1;
    await database.insert(schema.auditLog).values({
      familyId,
      actor: 'system',
      actionTaken: 'proactive_cadence_queued',
      targetTable: 'families',
      targetId: familyId,
      after: { kind: REGISTRATION_OPENING_KIND, sourceUrl: reading.sourceUrl },
    });
  }
}
