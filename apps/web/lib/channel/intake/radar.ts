import type { AgentClient } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { DEFAULT_TIMEZONE } from '~/lib/format/datetime';
import {
  matchRegistrationWindows,
  resolveMunicipalities,
} from '~/lib/registration/match-registration-windows';
import { type WeatherPort, createOpenMeteoWeather } from '~/lib/weather/open-meteo';
import { voiceClient } from '~/lib/loop/voice/compose';
import type { ExtractedChild } from './extract';
import { type RadarCandidate, type RadarChild, decideRadar } from './radar-decide';
import { composeRadarMessage } from './radar-voice';

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

/** The family's 13+ children, whose candidates never ride an SMS to a parent (rule #1).
 * Derived LIVE from date_of_birth, never stored — the same rule the village read applies. */
async function readTeenChildIds(database: Database, familyId: string): Promise<string[]> {
  const rows = await database
    .select({ id: schema.children.id, dateOfBirth: schema.children.dateOfBirth })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
  return rows.filter((row) => deriveStage(row.dateOfBirth) === 'teenager').map((row) => row.id);
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

      const [teenChildIds, candidates, windowRows, weather] = await Promise.all([
        readTeenChildIds(deps.database, input.familyId),
        readCandidates(deps.database, input.familyId),
        area ? readWindows(deps.database, area) : Promise.resolve([]),
        // Weather is an input, never a blocker: the port swallows its own failures, and
        // an area we cannot place has no forecast to ask for.
        area ? deps.weather.getDailyOutlook(area, WEATHER_DAYS).catch(() => []) : Promise.resolve([]),
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

      const decision = decideRadar({
        children,
        candidates,
        windows,
        weather,
        teenChildIds,
        now,
        timeZone,
      });

      const message = await composeRadarMessage(decision, {
        familyId: input.familyId,
        database: deps.database,
        client: deps.client,
      });

      return {
        message,
        itemCount: (decision.weekendPick ? 1 : 0) + (decision.registrationLine ? 1 : 0),
        followUpNeeded: decision.followUpNeeded,
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
