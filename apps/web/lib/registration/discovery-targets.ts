import type { Municipality, ProgramDomain } from '@hale/db';

/**
 * The cycles the dataset is WAITING on, and the pages that would publish them.
 *
 * A leaf module, split out of verify-sweep.ts (VIL-259) when the radar acquired a
 * second reason to read it: the weekly sweep watches these pages so the gaps close
 * themselves, and the between-cycles reply names the cycle being watched for, so a
 * family whose season has gone hears what Hale is waiting on rather than silence. The
 * sweep's own module drags a model client, Resend and the provider pre-flight in with
 * it, none of which belong anywhere near a stranger's first text.
 *
 * The schema's rule is what makes a list like this necessary at all: a municipality
 * that has not published its next date yet gets NO row, never a placeholder — so the
 * only record that a cycle is expected is the one kept here by hand.
 */
export interface DiscoveryTarget {
  municipality: Municipality;
  programDomain: ProgramDomain;
  /** The cycle we are waiting on, in the words a parent would use. */
  cycleLabel: string;
  /**
   * Every page that might publish the date. One URL was how Fall 2026 was missed:
   * the how-to-register page stayed "dates will be announced later" while the
   * date was on the register page and in a news release. The sweep reads each
   * URL and a find on any of them is a publication.
   */
  sourceUrls: readonly string[];
  /** Why this is a gap — quoted in the digest so the line explains itself. */
  gap: string;
}

/** The page that carries Toronto's own "Upcoming Registration Dates" table and its
 * season look-ahead. The how-to-register page is where the Fall 2026 posting was missed:
 * it explains the mechanics and links the dates rather than printing them. */
const TORONTO_REGISTER =
  'https://www.toronto.ca/explore-enjoy/parks-recreation/program-activities/register-for-recreation-activities/';
/** The City's news index. Fall 2026 was a release on this index while the
 * how-to-register page still said the dates would be announced later. */
const TORONTO_NEWS = 'https://www.toronto.ca/news/';
const TORONTO_WATCH = [TORONTO_REGISTER, TORONTO_NEWS] as const;
const HALTON_HILLS_REGISTER =
  'https://www.haltonhills.ca/en/explore-and-play/program-registration.aspx';
const WHITCHURCH_STOUFFVILLE_PLAY_BOOK = 'https://www.townofws.ca/play/recreation/programs/play-book/';
const NEWMARKET_PROGRAMS = 'https://www.newmarket.ca/recreation-parks/programs-camps';
const EAST_GWILLIMBURY_GUIDE =
  'https://www.eastgwillimbury.ca/en/living-in-eg/health-and-active-living-guide.aspx';
const GEORGINA_PROGRAMS = 'https://www.georgina.ca/things-do/recreation/programs-0';

/**
 * The coverage gaps, watched weekly so they close themselves. Toronto registers swim
 * inside its seasonal cycle rather than separately, so both domains ride the same page
 * and the same announcement; Whitchurch-Stouffville runs one window for the whole Play
 * Book, so one target covers the town.
 *
 * A target LEAVES this list by hand once its row lands (the Fall 2026 entries went when
 * Toronto's and Halton Hills' rows were seeded): the sweep walks every target
 * unconditionally and never prunes one, so a closed gap left here is a "new window
 * published - add?" digest line every Monday for a cycle already in the dataset.
 */
export const DISCOVERY_TARGETS: readonly DiscoveryTarget[] = [
  {
    municipality: 'toronto',
    programDomain: 'rec_program',
    cycleLabel: 'Winter 2027',
    sourceUrls: TORONTO_WATCH,
    gap: 'Toronto prints no Winter 2027 date, only a look-ahead: registration "is anticipated to occur between December 1 to 9" with programs browsable from November 17.',
  },
  {
    municipality: 'toronto',
    programDomain: 'swim',
    cycleLabel: 'Winter 2027',
    sourceUrls: TORONTO_WATCH,
    gap: 'Toronto registers swim inside the seasonal cycle; the same unpublished Winter 2027 date covers it.',
  },
  {
    municipality: 'halton_hills',
    programDomain: 'rec_program',
    cycleLabel: 'Winter 2027',
    sourceUrls: [HALTON_HILLS_REGISTER],
    gap: 'Halton Hills opened Fall 2026 on Sep 1 and has posted nothing since; the winter cycle is what a family there is now waiting on.',
  },
  {
    municipality: 'whitchurch_stouffville',
    programDomain: 'rec_program',
    cycleLabel: 'Winter 2027',
    sourceUrls: [WHITCHURCH_STOUFFVILLE_PLAY_BOOK],
    gap: 'Whitchurch-Stouffville publishes its dates only inside the seasonal Play Book, and the page still offers the Fall 2026 one. The Town runs a single window for the whole book, so swim and the winter-break camps arrive on this date too.',
  },
  {
    municipality: 'newmarket',
    programDomain: 'rec_program',
    cycleLabel: 'Winter 2027',
    sourceUrls: [NEWMARKET_PROGRAMS],
    gap: 'Newmarket prints its dates only inside the seasonal magazine PDF, never on this landing page, and the magazine on offer is still the Fall 2026 one. One window covers the whole magazine, swim included.',
  },
  {
    municipality: 'east_gwillimbury',
    programDomain: 'rec_program',
    cycleLabel: 'Winter 2027',
    sourceUrls: [EAST_GWILLIMBURY_GUIDE],
    gap: 'East Gwillimbury\'s guide is titled "Fall 2026 and Winter 2027" but the page publishes only the fall registration dates. One window covers the whole guide, swim included.',
  },
  {
    municipality: 'georgina',
    programDomain: 'rec_program',
    cycleLabel: 'Winter 2027',
    sourceUrls: [GEORGINA_PROGRAMS],
    gap: 'Georgina posts one cycle at a time on this page and has posted nothing since the fall block. Watch THIS page: the Town\'s recreation-general-information page was still carrying the spring block in September.',
  },
];

/**
 * The cycle Hale is watching for in this town and domain, given every cycle label the
 * dataset already holds for it. Null when nothing is left to watch for — and then the
 * reply says "the next dates" rather than naming a season.
 *
 * Decided against the ROWS, never against the list alone, because the list is hand-kept
 * and the weekly sweep does NOT prune a target whose window has since arrived
 * (runVerifySweep walks every target unconditionally). A target whose cycle is posted is
 * a closed gap the list has not noticed, and handing it back would tell a parent their
 * town's next registration is the one they missed last season — the exact confusion this
 * field exists to remove.
 */
export function nextWatchedCycle(
  municipality: string,
  programDomain: string,
  knownCycleLabels: ReadonlySet<string>,
): string | null {
  return (
    DISCOVERY_TARGETS.find(
      (target) =>
        target.municipality === municipality &&
        target.programDomain === programDomain &&
        !knownCycleLabels.has(target.cycleLabel),
    )?.cycleLabel ?? null
  );
}
