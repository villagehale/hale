import { type RegisteredTool, defineTool } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { selectByActivityQuery } from '~/lib/coach/activity-query';
import { readFamilyTimezone } from '~/lib/dashboard/trail-query';
import { formatCalendarDayLabel } from '~/lib/format/datetime';
import { safeHttpUrl } from '~/lib/format/http-url';
import {
  activityReviewsSurfaceEnabled,
  familyAreaKey,
  offeredSubject,
  readSubjectVerdicts,
  subjectKey,
} from '~/lib/reviews/aggregate';
import { biasFindOrder, readHouseholdFindBias } from '~/lib/reviews/household-bias';
import { toVillageCandidateView } from '~/lib/village/mappers';
import { visibleCandidates } from '~/lib/village/visibility';
import { spokenFind } from './spoken-find';

/**
 * The Village read shared by every surface that offers it (VIL-221 · C2).
 * Family-scoped (rule #1: the handler reads only `ctx.familyId`'s rows). It does
 * not name a childId, so the guarded invoker's child-content check never runs;
 * a teen-attributed row is redacted to category only via the mapper before it
 * can reach the model.
 *
 * The tool takes a `Database` by closure so the same definition is reused with a
 * test db. The harness validates the zod input at the boundary, so a hallucinated
 * arg is rejected before the handler runs.
 */

const MEMORY_RESULT_LIMIT = 15;

/**
 * The childId stand-in used in every `inputExamples` entry.
 *
 * Rule #1, and it is not a style preference: `input_examples` rides in the tool
 * definition, which the API compiles into a grammar and caches for up to 24h
 * SEPARATELY from message content — outside the protections prompts and
 * responses get. A real childId (or name, address, or school) in an example
 * would be family data living in that cache. So examples are always invented,
 * and this all-zero v4 uuid is unmistakably a placeholder rather than a row.
 */
export const EXAMPLE_CHILD_ID = '00000000-0000-4000-8000-000000000000';

/**
 * The family's children currently in the teenager stage, derived LIVE from DOB
 * (never stored) — the source-side teen filter for `search_village`, which never
 * names a childId and so never trips the guard.
 */
async function teenChildIdsForFamily(database: Database, familyId: string): Promise<Set<string>> {
  const children = await database
    .select({ id: schema.children.id, dateOfBirth: schema.children.dateOfBirth })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
  return new Set(
    children.filter((c) => deriveStage(c.dateOfBirth) === 'teenager').map((c) => c.id),
  );
}

function isTeenAttributed(childId: string | null, teenChildIds: ReadonlySet<string>): boolean {
  return childId !== null && teenChildIds.has(childId);
}

/** One activity Hale may actually put in front of a parent. An offer a parent cannot
 * turn up to is not an offer: the title and the day are always present.
 *
 * `venue` is omitted when the title already names that place. Handing both is what
 * makes a reply say "Riverdale Farm visit at Riverdale Farm".
 *
 * NO ID, AND THAT IS LOAD-BEARING. Provenance travels beside the offer, never through
 * it: an id the model can see is an id the model can invent, reword or attach to the
 * wrong pick, and `inputExamples` on this surface are cached outside the protections
 * message content gets (rule #1). See {@link OfferedCandidate}. */
interface OfferableActivity {
  title: string;
  kind: string;
  summary: string;
  venue?: string;
  when: string;
  /** The row's own page, only when it is an absolute http(s) URL. */
  url?: string;
}

/**
 * The same offer as the PROCESS sees it — the row behind each candidate the tool just
 * emitted, so whatever places one can record what placed it.
 *
 * `title` is the exact string the model was handed, which is what makes an EXACT match
 * possible downstream instead of a fuzzy one. A guess is not an identity.
 */
export interface OfferedCandidate {
  title: string;
  /** The verified venue the offer named — the grain a pooled verdict is actually about,
   * since the subject behind it is a place or a civic venue and never a programme. A
   * count that named the title would say three families rated the Saturday storytime
   * when what they rated was the branch it runs in. */
  venue: string;
  candidateId: string;
  placeId: string | null;
  civicVenueId: string | null;
  /** Same page the model was shown, so the reply can carry it without the model writing it. */
  url?: string;
}

/** One row as both halves see it: what the model is shown, and what the process keeps
 * about it. Paired rather than two arrays so a drop can never take one and leave the
 * other — that divergence is a count attached to the wrong activity. */
interface OfferableEntry {
  candidate: OfferableActivity;
  offer: OfferedCandidate | null;
}

/**
 * THE OTHER HALF OF "NEGATIVES ARE NEVER SPOKEN, ONLY RANKED" (founder decision 3).
 *
 * A subject three or more households near this family have answered about, mostly
 * unfavourably, is DROPPED from what the model is shown whenever there is anything else
 * to show — so the parent is never offered it rather than warned about it. Nothing is
 * said about it anywhere, here or downstream: `renderVerdictClause` returns null for the
 * same pool, and this function returns a list, never a sentence.
 *
 * WHEN EVERY OFFER IS IN THAT STATE THEY ALL STAND, in the order they came. Sorting them
 * last is what dropping them already is when there is an alternative, and a parent asking
 * what is on this week is owed the honest list rather than silence.
 *
 * It FAILS OPEN INTO THE ORDINARY ORDER at every step — dark flag, no shared identity, no
 * FSA-shaped area — because the pooled opinion is an improvement on the ranking, never a
 * precondition for answering.
 */
async function withoutPooledNegatives(
  database: Database,
  familyId: string,
  offerable: readonly OfferableEntry[],
): Promise<readonly OfferableEntry[]> {
  if (!activityReviewsSurfaceEnabled()) return offerable;
  const subjectOf = (entry: OfferableEntry) => (entry.offer ? offeredSubject(entry.offer) : null);
  const subjects = offerable
    .map(subjectOf)
    .filter((subject): subject is NonNullable<typeof subject> => subject !== null);
  if (subjects.length === 0) return offerable;
  const areaKey = await familyAreaKey(database, familyId);
  if (areaKey === null) return offerable;

  const verdicts = await readSubjectVerdicts(database, subjects, areaKey);
  const kept = offerable.filter((entry) => {
    const subject = subjectOf(entry);
    return subject === null || verdicts.get(subjectKey(subject))?.majorityNegative !== true;
  });
  return kept.length === 0 ? offerable : kept;
}

/**
 * The Village read, as ONE definition shared by every surface that offers it — Ask in
 * the app and Hale over text (VIL-221 · C2). "Improvements compound across surfaces"
 * is only true if they are the same tool; two copies of this handler would be two
 * teen-redaction filters that can drift, which is the failure rule #1 cannot afford.
 *
 * WHAT A CANDIDATE HAS TO HAVE TO BE OFFERED. A row reaches the model as an offer only
 * when its `venue_name` and `event_date` are both present — the two facts a parent needs
 * to actually go. Everything else is a COUNT.
 *
 * This is structural on purpose. Handing the model a title and a blurb and asking it to
 * police its own confidence produced exactly the failure it sounds like: on launch day
 * Hale surfaced a real find and admitted, in the same breath, that it could not confirm
 * the location or the time. That is not honesty, it is the work handed back — and it was
 * unavoidable, because the model was shown a candidate it had no way to describe and its
 * own rules (never name a place or a time no tool returned) then forced the hedge. A
 * candidate it is never shown cannot be hedged about.
 *
 * The count exists so the silence is not a lie either: "two more still being checked" is
 * a true, forward-looking thing to say, and it is all there is to say. A teen-attributed
 * row is in NEITHER bucket — redaction leaves it with no venue and no date, so it can
 * never be offered, and counting it would have Hale promise to come back about a find it
 * must never mention (rule #1).
 */
export function searchVillageTool(
  database: Database,
  /**
   * Told about every candidate this call OFFERED — the `onDraft`/`onOffer` shape, and
   * for the same reason: the tool's return value belongs to the model and this does
   * not. Absent on a surface that places nothing (a parity test), so there is no
   * path that collects a provenance nobody will use.
   */
  onOffered?: (offers: readonly OfferedCandidate[]) => void,
): RegisteredTool {
  return defineTool({
    name: 'search_village',
    description:
      "Local classes, groups, and activities already discovered for THIS family's area, optionally filtered by a free-text query against title/summary. `candidates` are OFFERABLE: each carries a verified `venue` and `when`, so it can be named to a parent whole. Quote `title` as given — do not paraphrase it — and use only that candidate's `when`. A date from a different candidate does not belong on this one. `inVerification` is a COUNT of finds whose place or date has not checked out yet — they are deliberately not listed, and there is nothing to tell a parent about them beyond that they are being checked. Teen-attributed candidates appear in neither (rule #1). `standingOption` appears ONLY when there are no candidates: one verified free drop-in place in the family's own municipality that is simply always there. It is a PLACE, not an event — it carries no date, and its `cadence` is the source's own words about when it runs, which is often an instruction to check the current schedule.",
    inputSchema: z.object({ query: z.string().optional() }),
    // Invented values only — examples are compiled into a cached grammar that sits
    // outside the protections message content gets (rule #1). See EXAMPLE_CHILD_ID.
    inputExamples: [{ query: 'swim' }, {}],
    monetary: false,
    touchesChildContent: false,
    handler: async (input, ctx) => {
      const teenChildIds = await teenChildIdsForFamily(database, ctx.familyId);
      const timeZone = await readFamilyTimezone(database, ctx.familyId);
      const now = new Date();

      const currentRunRows = await database
        .select()
        .from(schema.villageCandidates)
        .where(
          and(
            eq(schema.villageCandidates.familyId, ctx.familyId),
            isNull(schema.villageCandidates.supersededAt),
          ),
        )
        .orderBy(
          desc(schema.villageCandidates.confidence),
          desc(schema.villageCandidates.discoveredAt),
        )
        .limit(MEMORY_RESULT_LIMIT);

      const views = selectByActivityQuery(
        visibleCandidates(currentRunRows, now, timeZone).map((row) =>
          toVillageCandidateView(row, isTeenAttributed(row.childId, teenChildIds)),
        ),
        input.query,
        now,
        timeZone,
      );

      const rowsById = new Map(currentRunRows.map((row) => [row.id, row]));
      const offerable: OfferableEntry[] = [];
      let inVerification = 0;
      for (const view of views) {
        if (view.teenAttributed) continue;
        const venue = (view.venueName ?? '').trim();
        if (venue === '' || view.eventDate === null) {
          inVerification += 1;
          continue;
        }
        const row = rowsById.get(view.id);
        const spoken = spokenFind(view.title, venue);
        const url = safeHttpUrl(view.sourceUrl);
        const whenLabel = row?.whenLabel?.trim() ?? '';
        const day = formatCalendarDayLabel(view.eventDate, now);
        offerable.push({
          candidate: {
            title: spoken.title,
            kind: view.kind,
            summary: view.summary,
            ...(spoken.venue === null ? {} : { venue: spoken.venue }),
            when: whenLabel === '' ? day : `${day}, ${whenLabel}`,
            ...(url === null ? {} : { url }),
          },
          offer: row
            ? {
                // The title the model was handed, so a later exact match is that
                // string and not the stored column it was cleaned from.
                title: spoken.title,
                venue,
                candidateId: row.id,
                placeId: row.placeId,
                civicVenueId: row.civicVenueId,
                ...(url === null ? {} : { url }),
              }
            : null,
        });
      }

      const offerableNow = await withoutPooledNegatives(database, ctx.familyId, offerable);
      // VIL-366 · this household's own verdicts, after the pooled #677 drop. A
      // worth_it floats; a not_worth_it is dropped when anything else remains.
      // Neither step returns a sentence.
      const householdBias = await readHouseholdFindBias(database, ctx.familyId);
      const ordered = biasFindOrder(
        offerableNow,
        (entry) => (entry.offer ? offeredSubject(entry.offer) : null),
        householdBias,
      );
      const candidates = ordered.map((entry) => entry.candidate);
      const offered = ordered.flatMap((entry) => (entry.offer ? [entry.offer] : []));
      // EXACTLY the rows that went out as `candidates` — never the in-verification
      // count and never a teen-attributed row, which has no venue and no date and must
      // not be nameable at all (rule #1).
      onOffered?.(offered);

      // No canned standing place. A fixed Baby/Toddler storytime was something the
      // coach could "hand over", so the live web search never ran — and it was the
      // wrong age. An empty candidate list is the signal the skill already treats as
      // "call find_activities this turn". The field stays on the result so a turn that
      // still receives one (an eval fixture) can name it; production does not fill it.
      return { candidates, inVerification, standingOption: null };
    },
  });
}
