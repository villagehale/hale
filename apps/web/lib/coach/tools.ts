import { type RegisteredTool, defineTool } from '@hale/agent';
import type { Database } from '@hale/db';
import { z } from 'zod';
import type { ActivityQuery } from '~/lib/channel/activity/deidentify';
import {
  type ActivityFinder,
  type ActivityPick,
  createActivityFinder,
} from '~/lib/channel/activity/lane';
import { linkRef } from '~/lib/channel/coach/activity-links';
import { topUpShortRadar } from '~/lib/channel/coach/radar-top-up';
import { activityClient } from '~/lib/pipeline/client';
import {
  activityReviewsSurfaceEnabled,
  familyAreaKey,
  offeredSubject,
  readSubjectVerdicts,
  subjectKey,
} from '~/lib/reviews/aggregate';
import { biasFindOrder, readHouseholdFindBias } from '~/lib/reviews/household-bias';
import { findFamilyActivities, recordActivityOffers } from '~/lib/village/live';

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
  /** A ref for the row's own page, never the URL. The one id the model sees, and on
   * purpose: the reply cites it and code attaches that exact page, so an invented ref
   * attaches nothing and a typed URL is dropped (channel/coach/activity-links.ts). */
  ref?: string;
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
  pick: ActivityPick;
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
  finder?: ActivityFinder,
): RegisteredTool {
  return defineTool({
    name: 'search_village',
    description:
      'Find current local activities from live web sources for THIS family. Keep the public program/operator name in query and the requested month, year or date range in window, including on retries. Household names, addresses and postal codes must not be included. Unknown times remain unknown. Never answer from saved history.',
    inputSchema: z.object({ query: z.string().optional(), window: z.string().optional() }),
    // Invented values only — examples are compiled into a cached grammar that sits
    // outside the protections message content gets (rule #1). See EXAMPLE_CHILD_ID.
    inputExamples: [{ query: 'swim' }, {}],
    monetary: false,
    touchesChildContent: false,
    handler: async (input, ctx) => {
      const now = new Date();
      // The finder `findFamilyActivities` calls is the radar read. The same finder
      // is the one live search VIL-522 may spend afterwards, and only then — a
      // short radar tops up once, a radar that already has two suitable finds
      // does not search again. Intake and the nudge keep the single read.
      const resolved = finder ?? createActivityFinder(activityClient);
      let searched: ActivityQuery | null = null;
      const radarRead: ActivityFinder = {
        async find(query) {
          searched = query;
          return resolved.find(query);
        },
      };
      const found = await findFamilyActivities(database, ctx.familyId, {
        subject: input.query,
        window: input.window,
        finder: radarRead,
        now,
      });
      const query = searched;
      const picks =
        found.reason === null && query
          ? (
              await topUpShortRadar({
                radar: found.picks,
                liveSearch: async () => {
                  const extra = await resolved.find(query);
                  if (!extra.found) {
                    console.info(
                      { reason: extra.reason },
                      'coach find: live top-up came back empty',
                    );
                    return [];
                  }
                  return extra.picks;
                },
              })
            ).picks
          : found.picks;
      const offerable: OfferableEntry[] = picks.map((pick) => ({
        pick,
        candidate: {
          title: pick.name,
          kind: 'activity',
          summary: [pick.ageFit, pick.when, pick.price].filter(Boolean).join(' — '),
          venue: pick.sourceName,
          when: pick.when ?? 'Current time could not be verified',
          // A ref, not the page: the reply cites it and code attaches the URL.
          ...(pick.sourceUrl ? { ref: linkRef(pick.sourceUrl) } : {}),
        },
        offer: {
          title: pick.name,
          venue: pick.sourceName,
          candidateId: '',
          placeId: pick.placeId ?? null,
          civicVenueId: pick.civicVenueId ?? null,
        },
      }));

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
      const receipts = await recordActivityOffers(
        database,
        ctx.familyId,
        ordered.map((entry) => entry.pick),
        now,
      );
      const offered = receipts.map((row) => ({
        title: row.title,
        venue: row.venueName ?? '',
        candidateId: row.id,
        placeId: row.placeId,
        civicVenueId: row.civicVenueId,
        url: row.sourceUrl ?? undefined,
      }));
      // EXACTLY the rows that went out as `candidates` — never the in-verification
      // count and never a teen-attributed row, which has no venue and no date and must
      // not be nameable at all (rule #1).
      onOffered?.(offered);

      return {
        candidates,
        inVerification: 0,
        standingOption: null,
        liveRead: found.reason ?? 'verified',
      };
    },
  });
}
