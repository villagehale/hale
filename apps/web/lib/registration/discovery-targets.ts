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
  sourceUrl: string;
  /** Why this is a gap — quoted in the digest so the line explains itself. */
  gap: string;
}

const TORONTO_REGISTER =
  'https://www.toronto.ca/explore-enjoy/parks-recreation/how-to-use-our-services/how-to-register-for-recreation-programs/';
const HALTON_HILLS_REGISTER =
  'https://www.haltonhills.ca/en/explore-and-play/program-registration.aspx';

/**
 * The coverage gaps M1 recorded, watched weekly so they close themselves.
 * Toronto registers swim inside its seasonal cycle rather than separately, so
 * both domains ride the same page and the same announcement.
 */
export const DISCOVERY_TARGETS: readonly DiscoveryTarget[] = [
  {
    municipality: 'toronto',
    programDomain: 'rec_program',
    cycleLabel: 'Fall 2026',
    sourceUrl: TORONTO_REGISTER,
    gap: 'Toronto publishes no Fall 2026 seasonal dates ("Registration dates will be announced at a later date").',
  },
  {
    municipality: 'toronto',
    programDomain: 'swim',
    cycleLabel: 'Fall 2026',
    sourceUrl: TORONTO_REGISTER,
    gap: 'Toronto registers swim inside the seasonal cycle; the same unpublished Fall 2026 date covers it.',
  },
  {
    municipality: 'halton_hills',
    programDomain: 'rec_program',
    cycleLabel: 'Fall 2026',
    sourceUrl: HALTON_HILLS_REGISTER,
    gap: 'Halton Hills publishes no seasonal date table at all — the page still reads "Summer Registration On Now!".',
  },
  {
    municipality: 'halton_hills',
    programDomain: 'rec_program',
    cycleLabel: 'Winter 2027',
    sourceUrl: HALTON_HILLS_REGISTER,
    gap: 'Halton Hills opened Fall 2026 on Sep 1 and has posted nothing since; the winter cycle is what a family there is now waiting on.',
  },
];

/**
 * The cycle Hale is watching for in this town and domain, given the one that has just
 * gone. Null when nothing is registered — and then the reply says "the next dates"
 * rather than naming a season nobody published.
 *
 * `alreadyOpened` is excluded because the sweep does NOT prune a target whose window
 * has since arrived (runVerifySweep walks every target unconditionally), so the list
 * keeps a gap that has closed. Handing that label back as the cycle still to come
 * would tell a parent their town's next registration is the one they have already
 * missed — the exact confusion this whole field exists to remove.
 */
export function nextWatchedCycle(
  municipality: string,
  programDomain: string,
  alreadyOpened: string,
): string | null {
  return (
    DISCOVERY_TARGETS.find(
      (target) =>
        target.municipality === municipality &&
        target.programDomain === programDomain &&
        target.cycleLabel !== alreadyOpened,
    )?.cycleLabel ?? null
  );
}
