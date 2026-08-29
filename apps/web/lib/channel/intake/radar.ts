import type { AgentClient } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { ageInMonths, deriveStage } from '@hale/types';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { DEFAULT_TIMEZONE } from '~/lib/format/datetime';
import type { HealthChild } from '~/lib/health/match';
import { loadSuppressedCheckpointRefs } from '~/lib/health/reply';
import {
  matchRegistrationWindows,
  resolveMunicipalities,
} from '~/lib/registration/match-registration-windows';
import { type WeatherPort, createOpenMeteoWeather } from '~/lib/weather/open-meteo';
import { voiceClient } from '~/lib/loop/voice/compose';
import type { ExtractedChild } from './extract';
import {
  type RadarCandidate,
  type RadarChild,
  type RadarDecision,
  decideRadar,
} from './radar-decide';
import { composeRadarMessage, promisesFirstFind } from './radar-voice';

/** Words too generic to prove the checkpoint reached the parent. */
const CHECKPOINT_STOPWORDS = new Set([
  'your', 'with', 'them', 'they', 'this', 'that', 'have', 'about', 'their',
  'book', 'call', 'time', 'when', 'week', 'month', 'months', 'year', 'years',
  'child', 'kids', 'ontario', 'free', 'ask', 'now', 'the', 'and', 'for',
]);

/**
 * Whether the composed message actually carries the decided checkpoint: at least
 * one distinctive word of the checkpoint's parent-facing task, or its age phrase
 * ("18 month" / "18-month"), survives in the text. Conservative on purpose — a
 * paraphrase that keeps ANY distinctive task word passes; a compose that dropped
 * the rung entirely cannot.
 */
export function checkpointSurvivedCompose(message: string, task: string): boolean {
  const text = message.toLowerCase();
  const agePhrases = task.toLowerCase().match(/\d+[\s-]?(?:month|year|week)/g) ?? [];
  if (agePhrases.some((phrase) => text.includes(phrase.replace(/[\s-]/g, ' ')) || text.includes(phrase.replace(/[\s-]/g, '-')) || text.includes(phrase))) {
    return true;
  }
  const words = task
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && !CHECKPOINT_STOPWORDS.has(w));
  return words.some((w) => text.includes(w));
}

/**
 * VIL-238 · M3 — the radar: the first real thing Hale has spotted for these kids in
 * this area, said back to the parent within a minute of them texting in.
 *
 * The seam M2 left behind, now filled. Three stages, and the split is the whole design:
 *
 *   GATHER (here)      — read what Hale knows: this family's discovered candidates, the
 *                        municipal registration windows their FSA resolves to, and the
 *                        coarse-area weather.
 *   DECIDE (pure)      — radar-decide.ts: deterministic filters, then a ranking, into a
 *                        structured decision object. No model, so it is unit-testable.
 *   COMPOSE (one call) — radar-voice.ts: the model writes the words around those facts,
 *                        and a message carrying anything else is discarded.
 *
 * What it is allowed to say is bounded by what the DECIDE object contains. When that
 * object is empty — discovery has not run yet, the area has no covered municipality —
 * the honest answer goes out instead ("still learning your area") and `followUpNeeded`
 * tells the caller Hale owes this family a pick later. Nothing here sends that
 * follow-up; the flag is the whole contract.
 */

export interface RadarInput {
  familyId: string;
  children: readonly ExtractedChild[];
  /** The coarse area (FSA), never the full postal code (rule #1). */
  areaCoarse: string | null;
}

export interface RadarPayload {
  message: string;
  /** How many real, grounded items the message is built from. Zero means Hale said so. */
  itemCount: number;
  /** True when nothing could be picked yet — discovery may still be running, and the
   * caller may follow up once it lands. Flag only; this stage sends nothing. */
  followUpNeeded: boolean;
  /**
   * The health checkpoint this message TELLS, or null. The caller marks it told once the
   * message has actually been sent (lib/health/told.ts) — composing is not telling, so
   * nothing here writes it.
   */
  checkpointTold: string | null;
  /**
   * MEM-10 · true when this message carries the forward beat, and Hale has therefore
   * PROMISED this family a first find. The caller records the commitment once the message
   * has actually been sent (lib/commitments/ledger.ts) — composing is not promising, so
   * nothing here writes it. Same discipline, same reason, as `checkpointTold`.
   */
  firstFindPromised: boolean;
}

export interface RadarComposer {
  compose(input: RadarInput): Promise<RadarPayload>;
}

/** Enough days to reach the coming Sunday from any weekday, plus slack. */
const WEATHER_DAYS = 8;

export interface RadarDeps {
  database: Database;
  weather: WeatherPort;
  /** The voice client, or null when voice is unavailable — then the deterministic
   * render goes out and the intake is never blocked on a model being reachable. */
  client: AgentClient | null;
  now?: () => Date;
  timeZone?: string;
}

/**
 * The parent's own words about their kids, straight from the conversation that just
 * happened — not a read of the rows, which is why 'derived' is a FACT here rather than
 * an assumption: provisioning wrote these very children from a spoken age moments ago,
 * in this same request, and that is exactly what `dob_precision = 'derived'` records.
 * The sweeps that read STORED rows (lib/channel/nudge/run.ts) take the column instead.
 */
function toRadarChildren(children: readonly ExtractedChild[]): RadarChild[] {
  return children.map((child) => ({
    name: child.name,
    ageMonths: child.ageMonths,
    dobPrecision: 'derived',
  }));
}

/**
 * The family as the two age-sensitive rules need to see them, off the rows provisioning
 * wrote a moment ago — the ONE read that can supply an id, which a checkpoint's identity
 * is built from.
 *
 * `teenChildIds` gates the weekend pick: a 13+ child's activity never rides an SMS to a
 * parent (rule #1). `healthChildren` is the opposite list on purpose — it INCLUDES those
 * children, because a school records check is the parent's obligation for a teenager
 * exactly as it is for a seven-year-old, and only the wording changes. The teen's name
 * is stripped HERE, at the source, so it cannot reach a template even if a later change
 * dropped a downstream check (the same discipline as M4's splitByStage).
 *
 * The stage is derived LIVE from date_of_birth, never stored, and at `now` rather than
 * the wall clock so a child on their thirteenth birthday cannot be teen-gated at one age
 * and band-matched at another.
 */
async function readHealthRoster(
  database: Database,
  familyId: string,
  now: Date,
): Promise<{ teenChildIds: string[]; healthChildren: HealthChild[] }> {
  const rows = await database
    .select({
      id: schema.children.id,
      name: schema.children.name,
      dateOfBirth: schema.children.dateOfBirth,
      dobPrecision: schema.children.dobPrecision,
    })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));

  const teenChildIds: string[] = [];
  const healthChildren: HealthChild[] = [];
  for (const row of rows) {
    const isTeen = deriveStage(row.dateOfBirth, now) === 'teenager';
    if (isTeen) teenChildIds.push(row.id);
    healthChildren.push({
      id: row.id,
      name: isTeen ? null : row.name,
      ageMonths: ageInMonths(row.dateOfBirth, now),
      // Free-form text with an 'exact' default, so only the literal 'derived' buys the
      // tolerance — an unrecognised value must not silently earn six months of it.
      dobPrecision: row.dobPrecision === 'derived' ? 'derived' : 'exact',
      isTeen,
    });
  }
  return { teenChildIds, healthChildren };
}

/**
 * This family's ACTIVE standing candidates. Mirrors the village feed's own predicate
 * (villageActiveFilter in lib/village/queries.ts): family-scoped, not superseded, and
 * the standing run rather than a parent's one-off season search — inlined rather than
 * imported because that module pulls the authenticated session resolver in with it, and
 * the radar runs on an inbound SMS with no session at all.
 */
export async function readCandidates(database: Database, familyId: string): Promise<RadarCandidate[]> {
  const rows = await database
    .select({
      id: schema.villageCandidates.id,
      title: schema.villageCandidates.title,
      venueName: schema.villageCandidates.venueName,
      ageRange: schema.villageCandidates.ageRange,
      priceLevel: schema.villageCandidates.priceLevel,
      indoorOutdoor: schema.villageCandidates.indoorOutdoor,
      eventDate: schema.villageCandidates.eventDate,
      seasons: schema.villageCandidates.seasons,
      childId: schema.villageCandidates.childId,
      confidence: schema.villageCandidates.confidence,
    })
    .from(schema.villageCandidates)
    .where(
      and(
        eq(schema.villageCandidates.familyId, familyId),
        isNull(schema.villageCandidates.supersededAt),
        or(
          eq(schema.villageCandidates.runType, 'standing'),
          // VIL-252 · M16 — free civic sessions (library storytimes, EarlyON
          // drop-ins) are exactly what the free-first ordering below exists to
          // float, and they are dated, so `placements` can only put them on their
          // own day. Omitting them here would leave the radar claiming "still
          // learning your area" for a family with a verified free session on
          // Saturday morning.
          eq(schema.villageCandidates.runType, 'civic'),
          isNull(schema.villageCandidates.runType),
        ),
      ),
    );
  return rows;
}

/** The registration windows this family's FSA can act on. An FSA outside the covered
 * set resolves to no municipality — and then to no query and no claim (M1's rule: a
 * neighbouring town's dates are worse than silence). */
export async function readWindows(database: Database, areaCoarse: string) {
  const municipalities = resolveMunicipalities(areaCoarse);
  if (municipalities.length === 0) return [];
  return database
    .select()
    .from(schema.registrationWindows)
    .where(inArray(schema.registrationWindows.municipality, municipalities));
}

export function createRadarComposer(deps: RadarDeps): RadarComposer {
  const timeZone = deps.timeZone ?? DEFAULT_TIMEZONE;
  return {
    async compose(input) {
      const now = deps.now?.() ?? new Date();
      const children = toRadarChildren(input.children);
      const area = input.areaCoarse;

      const [roster, candidates, windowRows, weather, suppressedCheckpointRefs] = await Promise.all([
        readHealthRoster(deps.database, input.familyId, now),
        readCandidates(deps.database, input.familyId),
        area ? readWindows(deps.database, area) : Promise.resolve([]),
        // Weather is an input, never a blocker: the port swallows its own failures, and
        // an area we cannot place has no forecast to ask for.
        area ? deps.weather.getDailyOutlook(area, WEATHER_DAYS).catch(() => []) : Promise.resolve([]),
        // Empty for every family this composer actually serves — they were provisioned
        // seconds ago. Read anyway rather than assumed: the assumption is the kind that
        // survives the code that made it true, and a checkpoint raised twice is exactly
        // the nagging M8 exists to remove.
        loadSuppressedCheckpointRefs(deps.database, input.familyId),
      ]);

      const windows = area
        ? matchRegistrationWindows({
            windows: windowRows,
            postal: area,
            childrenAgesMonths: children
              .map((child) => child.ageMonths)
              .filter((age): age is number => age !== null),
            now,
          })
        : [];

      // THE FIRST FIND IS PRE-CONSENT — the watch offer rides on this very message
      // (machine.ts appends WATCH_OFFER to it), so health-checkpoint content may not:
      // a vaccine flag before the parent has consented to being watched is exactly what
      // the 2026-08-28 ads-week audit observed live, twice. The rung is dropped HERE,
      // at the one composer that serves the intake first find, AFTER the decide so the
      // cascade's other rungs are untouched. Nothing is marked told, so the post-consent
      // surfaces (the 48h nudge, lib/channel/nudge/run.ts — gated on watch consent)
      // raise the same checkpoint once consent exists. The told-marker plumbing below is
      // typed against the unfiltered decision on purpose: it is the machinery any future
      // POST-consent radar surface re-enables, and on this path it can only ever be null.
      const decision: RadarDecision = {
        ...decideRadar({
          children,
          candidates,
          windows,
          weather,
          teenChildIds: roster.teenChildIds,
          healthChildren: roster.healthChildren,
          areaCoarse: area,
          suppressedCheckpointRefs,
          now,
          timeZone,
        }),
        checkpoint: null,
      };

      const message = await composeRadarMessage(decision, {
        familyId: input.familyId,
        database: deps.database,
        client: deps.client,
      });

      // Launch-day review P0 (2026-08-11): the decision yielding at DECIDE is not
      // enough — the composer samples at temperature 1 and CAN drop the checkpoint
      // from the rendered text. A told-marker written for words the parent never
      // read suppresses that checkpoint permanently and silently. So the marker is
      // earned by the MESSAGE: only a ref whose task words survived composition
      // counts as told (rule #11: the dropped case is logged, never silent).
      const checkpointTold =
        decision.checkpoint && checkpointSurvivedCompose(message, decision.checkpoint.task)
          ? decision.checkpoint.ref
          : null;
      if (decision.checkpoint && !checkpointTold) {
        console.warn(
          'radar compose dropped the decided checkpoint from the text; NOT marking told - it may be raised again',
          { ref: decision.checkpoint.ref },
        );
      }

      return {
        message,
        itemCount:
          (decision.weekendPick ? 1 : 0) +
          (decision.registrationLine ? 1 : 0) +
          (decision.checkpoint ? 1 : 0),
        followUpNeeded: decision.followUpNeeded,
        checkpointTold,
        // Earned by the SENT TEXT, exactly as the told-marker above now is: the composer
        // is handed the beat as one fact among several and may leave it out, and a debt
        // recorded for words nobody read puts this family in the overdue column for a
        // promise Hale never made. Cheaper than the checkpoint's containment guard
        // because the beat is a FIXED sentence — there is no paraphrase to survive.
        firstFindPromised: promisesFirstFind(message),
      };
    },
  };
}

/** The production wiring: the live database, Open-Meteo over coarse coordinates, and
 * the shared voice client (null when voice is unavailable — see composeRadarMessage). */
export function defaultRadarComposer(database: Database): RadarComposer {
  return createRadarComposer({
    database,
    weather: createOpenMeteoWeather(),
    client: voiceClient(),
  });
}
