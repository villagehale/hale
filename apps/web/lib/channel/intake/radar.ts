import type { AgentClient } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { ageInMonths, deriveStage } from '@hale/types';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { type ActivityFinder, createActivityFinder } from '~/lib/channel/activity/lane';
import { DEFAULT_TIMEZONE } from '~/lib/format/datetime';
import type { HealthChild } from '~/lib/health/match';
import { voiceClient } from '~/lib/loop/voice/compose';
import { activityClient } from '~/lib/pipeline/client';
import { resolveMunicipalities } from '~/lib/registration/match-registration-windows';
import { type WeatherPort, createOpenMeteoWeather } from '~/lib/weather/open-meteo';
import type { ExtractedChild } from './extract';
import { type RadarCandidate, type RadarChild, decideYearFinds } from './radar-decide';
import { type RadarMessage, promisesFirstFind } from './radar-voice';
import { collectYearOpenLines, renderYearOpen, yearOpenEmptyMessage } from './year-open';

/** Words too generic to prove the checkpoint reached the parent. */
const CHECKPOINT_STOPWORDS = new Set([
  'your',
  'with',
  'them',
  'they',
  'this',
  'that',
  'have',
  'about',
  'their',
  'book',
  'call',
  'time',
  'when',
  'week',
  'month',
  'months',
  'year',
  'years',
  'child',
  'kids',
  'ontario',
  'free',
  'ask',
  'now',
  'the',
  'and',
  'for',
]);

/**
 * Whether the composed message actually carries the decided checkpoint: at least
 * one distinctive word of the checkpoint's parent-facing task, or its age phrase
 * ("18 month" / "18-month"), survives in the text. Conservative on purpose — a
 * paraphrase that keeps ANY distinctive task word passes; a compose that dropped
 * the rung entirely cannot.
 */
export function checkpointSurvivedCompose(message: string, task: string): boolean {
  return phraseSurvivedCompose(message, task);
}

/**
 * VIL-360 · whether the composed message actually carries the decided weekend pick —
 * the same rule, because it answers the same question about a different block.
 *
 * The weekday fallback says "Those are weekend options" and points AT THIS MESSAGE.
 * D23's corollary is that the anchor must be a specific artefact Hale can check, and
 * the artefact is the sentence the parent read, not the decision behind it: the
 * composer samples at temperature 1 and the P0 below records that it can drop a
 * decided block. Failing this costs an ask that never fires; passing it wrongly is
 * Hale telling a family what it just sent them.
 */
export function weekendPickSurvivedCompose(message: string, title: string): boolean {
  return phraseSurvivedCompose(message, title);
}

/** One rule, two callers: a distinctive word (or age phrase) of the decided block
 * survives in the text. A second copy is how the two markers start disagreeing about
 * what counts as having been said. */
function phraseSurvivedCompose(message: string, task: string): boolean {
  const text = message.toLowerCase();
  const agePhrases = task.toLowerCase().match(/\d+[\s-]?(?:month|year|week)/g) ?? [];
  if (
    agePhrases.some(
      (phrase) =>
        text.includes(phrase.replace(/[\s-]/g, ' ')) ||
        text.includes(phrase.replace(/[\s-]/g, '-')) ||
        text.includes(phrase),
    )
  ) {
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
 *   GATHER (here)      — this family's discovered candidates, the coarse-area weather,
 *                        and which children are 13+ (so a teen's own session never
 *                        rides an SMS to a parent).
 *   DECIDE (pure)      — decideYearFinds: up to three age-fit weekend sessions.
 *   SAY                — year-open.ts: those sessions, filled toward three by a live
 *                        search when fewer than two are already in hand. A registration
 *                        date is not this message. The voice model is not called.
 *
 * What it is allowed to say is bounded by what the DECIDE object contains. When that
 * object is empty — discovery has not run yet, the area has no covered municipality —
 * a Toronto FSA still sends the VIL-320 city pin (VIL-334: leftover mapping is not
 * the Toronto first-hello). Unpinned towns get the honest leftover and
 * `followUpNeeded` tells the caller Hale owes this family a pick later. Nothing here
 * sends that follow-up; the flag is the whole contract.
 */

export interface RadarInput {
  familyId: string;
  children: readonly ExtractedChild[];
  /** The coarse area (FSA), never the full postal code (rule #1). */
  areaCoarse: string | null;
}

/**
 * VIL-360 · the `channel_messages.template_key` stamped on the intake radar's first
 * text WHEN it carried a weekend pick.
 *
 * The radar's messages are otherwise anonymous — the transcript is the record — but
 * this one row is the D23 anchor for the weekday fallback: "those are weekend
 * options" is only sayable to a family Hale actually sent one to, and the weather swap
 * (the other anchor) is rare by construction. Without the stamp the ask fires for
 * nobody.
 *
 * FORWARD-ONLY. A household onboarded before this shipped has a null `template_key` on
 * its first text, and nothing back-fills it: re-deriving the claim from a row whose
 * body was deliberately never stored would be a guess.
 */
export const INTAKE_RADAR_WEEKEND_PICK_TEMPLATE_KEY = 'intake:radar:weekend_pick';

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
  /**
   * VIL-360 · true when the DECISION this message was composed from carried a weekend
   * pick, so the caller can stamp {@link INTAKE_RADAR_WEEKEND_PICK_TEMPLATE_KEY} on the
   * row that carried it.
   *
   * Earned by the COMPOSED TEXT, exactly as `checkpointTold` and `firstFindPromised`
   * are, and for a reason of its own. What this flag unlocks is a deictic claim — the
   * ask says "those are all weekend finds" and points at this very message — and D23's
   * corollary is that such an anchor must be a specific artefact Hale can check.
   * `placements` guarantees that a pick which was NAMED was a weekend one; it cannot
   * make a message that named nothing into a find.
   */
  weekendPickOffered: boolean;
  /**
   * True when this text names at least one age-fit thing. A registration date is
   * not a win. The turtle card, the inbox ask, and the co-parent ask wait on this.
   */
  findWon: boolean;
  /**
   * The three rule #11 outcomes of the one turn, carried so a test and any future
   * caller can read what the log line below says. See {@link RadarMessage}: an
   * `actionMove` WITH an `actionHeld` is the compute-and-hold state the dark flag
   * exists to produce.
   */
  actionMove: RadarMessage['actionMove'];
  actionHeld: RadarMessage['actionHeld'];
  voiceFallback: RadarMessage['voiceFallback'];
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
  /**
   * Live age-fit search used when fewer than two civic finds are already in hand.
   * Null is a named skip (`not_configured`), never a silent empty list that then
   * gets filled with a registration date.
   */
  yearFinder?: ActivityFinder | null;
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
export async function readCandidates(
  database: Database,
  familyId: string,
): Promise<RadarCandidate[]> {
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
      // WHICH DISCOVERY LAYER WROTE THE ROW. Selected because a claim about a
      // WEEKDAY session's day rests on it and on nothing else: the civic sweep
      // dates its rows from a feed it verified, while an LLM-discovered row's
      // date and url are model output (village/discover.ts). `summary` is
      // deliberately NOT selected alongside it - nothing renders one today, and
      // an unread column on this hot path is a field the next reader assumes is
      // checked.
      source: schema.villageCandidates.source,
      // WHERE THE ROW'S OWN PAGE IS, and what a parent does when they get there. Both
      // are rendered only off a `civic_registry` row (radar-decide accessFor): that
      // source's url is the venue's own and its access mode is what the feed published,
      // while an LLM row's url "is often guessed" (village/discover.ts). Selected
      // beside `source` because the decision cannot apply that rule without all three.
      sourceUrl: schema.villageCandidates.sourceUrl,
      access: schema.villageCandidates.access,
      whenLabel: schema.villageCandidates.whenLabel,
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

      // Registration windows stay readable (`readWindows`) for later nudges. They are
      // not loaded for this message: a district date is not a substitute for an age-fit
      // find, and a row that is in memory is a row that can leak into the text.
      const [roster, candidates, weather] = await Promise.all([
        readHealthRoster(deps.database, input.familyId, now),
        readCandidates(deps.database, input.familyId),
        // Weather is an input, never a blocker: the port swallows its own failures, and
        // an area we cannot place has no forecast to ask for.
        area
          ? deps.weather.getDailyOutlook(area, WEATHER_DAYS).catch(() => [])
          : Promise.resolve([]),
      ]);

      // Pre-consent. The watch offer rides on this text, so a health checkpoint may
      // not: nothing here is marked told, and the post-consent nudge raises it later.
      const civic = decideYearFinds({
        children,
        candidates,
        windows: [],
        pastCycle: null,
        stillOpenCycle: null,
        weather,
        teenChildIds: roster.teenChildIds,
        healthChildren: roster.healthChildren,
        areaCoarse: area,
        suppressedCheckpointRefs: new Set(),
        now,
        timeZone,
      });
      const opened = await collectYearOpenLines({
        civic,
        children,
        areaCoarse: area,
        finder: deps.yearFinder ?? null,
        familyId: input.familyId,
      });
      const message =
        opened.lines.length > 0 ? renderYearOpen(opened.lines) : yearOpenEmptyMessage();
      const findWon = opened.lines.length > 0;

      // No child name, no postal code. The finder outcome is the fact an operator
      // needs when the first text is empty (rule #11).
      console.info('intake year open', {
        familyId: input.familyId,
        findWon,
        finder: opened.finder,
        lines: opened.lines.length,
      });

      return {
        message,
        itemCount: opened.lines.length,
        followUpNeeded: !findWon,
        // This path never decides a checkpoint, so it never marks one told.
        checkpointTold: null,
        // Year contents can mix a weekend session with a live search that is not a
        // weekend find. Stamping the D23 anchor would let weekday-care say "those are
        // all weekend finds" about a list that is the year's contents.
        weekendPickOffered: false,
        firstFindPromised: promisesFirstFind(message),
        findWon,
        actionMove: null,
        actionHeld: 'no_move',
        // This reply does not call the voice model. 'no_client' is the existing name
        // for that: the words are the year-open list, not a sampled sentence.
        voiceFallback: 'no_client',
      };
    },
  };
}

/** The production wiring: the live database, Open-Meteo over coarse coordinates, and
 * the activity lane's web search when fewer than two civic finds are already in hand.
 * The voice client stays on the deps for callers that still pass one; this reply does
 * not call it. */
export function defaultRadarComposer(database: Database): RadarComposer {
  return createRadarComposer({
    database,
    weather: createOpenMeteoWeather(),
    client: voiceClient(),
    yearFinder: createActivityFinder(activityClient),
  });
}
