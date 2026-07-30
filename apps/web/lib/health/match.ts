import { AGE_TOLERANCE_MONTHS } from '~/lib/registration/match-registration-windows';
import {
  HEALTH_CHECKPOINTS,
  type HealthCheckpoint,
  type HealthRegion,
  checkpointOccurrence,
  checkpointRef,
} from './checkpoints';

/**
 * VIL-243 · M8 — which administrative windows this family is INSIDE right now.
 *
 * Pure, no I/O, no model — the same split M3 and M4 use, and for a sharper reason here:
 * a health-admin message is the one Hale sends that a parent may act on without reading
 * twice, so the judgement behind it has to be one a unit test can pin to a month.
 *
 * The three conservatisms:
 *
 *   1. INSIDE THE WINDOW ONLY, and the window's END is hard (see {@link inBand}). That
 *      is what lets every string in the table be written without a hedge: there is no
 *      "you are late" case to word carefully, because it never renders.
 *   2. THE SLACK IS CLAMPED TO THE WINDOW. A DOB derived from "she's about three" earns
 *      the same tolerance the registration matcher grants — but never more slack than
 *      the window is wide. A ±6 tolerance on a two-month infant visit would admit a
 *      newborn and a nine-month-old to the same match, which is not a match, it is a
 *      shrug.
 *   3. A REGION IS PROVEN, NEVER GUESSED. Toronto Public Health's own programs go to
 *      Toronto FSAs; the provincial rows go to Ontario FSAs; a family whose area we do
 *      not have gets NOTHING. Telling an out-of-province parent to file with a health
 *      unit that has never heard of them is worse than silence.
 */

/**
 * Ontario postal codes begin with K, L, M, N or P; every M is Toronto and only Toronto.
 * This is the whole geography this feature needs, and it is a property of Canada Post's
 * FSA allocation rather than a dataset that can go stale — so it lives here as two
 * constants instead of another lookup table to maintain.
 */
const ONTARIO_FSA_LETTERS = new Set(['K', 'L', 'M', 'N', 'P']);
const TORONTO_FSA_LETTER = 'M';

/** The regions a family's coarse area entitles them to. Empty = no health nudge. */
export function healthRegionsFor(areaCoarse: string | null): Set<HealthRegion> {
  const letter = areaCoarse?.trim().toUpperCase().charAt(0) ?? '';
  if (!ONTARIO_FSA_LETTERS.has(letter)) return new Set();
  const regions = new Set<HealthRegion>(['ontario']);
  if (letter === TORONTO_FSA_LETTER) regions.add('toronto');
  return regions;
}

/**
 * A child as the health matcher needs them. Deliberately NOT `RadarChild`: this matcher
 * needs the child's ID (a checkpoint's identity is per-child, so the dedupe and the
 * "done" suppression both key on it) and needs to see 13+ children at all — M4 drops
 * them before deciding, which is right for a weekend suggestion and wrong for a legal
 * obligation the parent carries.
 *
 * `name` is null for every teen by construction at the call site, so a teen's name
 * cannot reach a template even if a later change forgot to check `isTeen`.
 */
export interface HealthChild {
  id: string;
  name: string | null;
  ageMonths: number;
  dobPrecision: 'exact' | 'derived';
  isTeen: boolean;
}

export interface HealthCheckpointMatch {
  checkpoint: HealthCheckpoint;
  /** The child the message is ABOUT — an under-13 whenever there is one, so the ref a
   * "done" reply suppresses is the one the parent was reading about. */
  primaryChildId: string;
  /** This checkpoint's identity for this family right now. Built HERE and carried
   * everywhere, so nothing downstream ever rebuilds it and gets the scope wrong. */
  ref: string;
  /** The children this message may name — exactly the ones {@link ref} suppresses, so
   * a "done" always covers everyone the parent was told about. Empty for a teen-only
   * match, and empty when the parent named nobody. */
  kidNames: string[];
  /** True when EVERY matched child is 13+ — the render goes generic (rule #1). */
  teenOnly: boolean;
  teenCount: number;
  /** Months until this window closes for the primary child. The ordering key. */
  monthsLeft: number;
}

const TABLE_ORDER = new Map(HEALTH_CHECKPOINTS.map((checkpoint, index) => [checkpoint.id, index]));

function slackFor(checkpoint: HealthCheckpoint, child: HealthChild): number {
  if (child.dobPrecision !== 'derived') return 0;
  return Math.min(AGE_TOLERANCE_MONTHS, checkpoint.maxMonths - checkpoint.minMonths);
}

/**
 * The slack is applied to the EARLY edge ONLY, and the asymmetry is the whole safety
 * argument of this feature.
 *
 * A derived DOB can be wrong in both directions, so symmetric slack looks like the
 * neutral choice. It isn't. Admitting a child who READS as past the window means
 * telling a parent about a visit their child has already aged out of — which is the
 * "you are late" message this feature exists not to send, arriving with no way to word
 * it kindly. Admitting a child who reads as slightly too YOUNG costs nothing: the copy
 * describes a window that is opening, and if the age was over-stated the sweep simply
 * sees them again next week.
 *
 * So: early yes, late never. The failure modes are not symmetric, so the tolerance
 * is not either.
 */
function inBand(checkpoint: HealthCheckpoint, child: HealthChild): boolean {
  return (
    child.ageMonths >= checkpoint.minMonths - slackFor(checkpoint, child) &&
    child.ageMonths <= checkpoint.maxMonths
  );
}

interface Admitted {
  child: HealthChild;
  ref: string;
  monthsLeft: number;
}

export function matchHealthCheckpoints(input: {
  children: readonly HealthChild[];
  areaCoarse: string | null;
  /** Checkpoints this family must not be raised about again: already told, or told to
   * us as done. See loadSuppressedCheckpointRefs for why those are one set. */
  suppressedRefs: ReadonlySet<string>;
  now: Date;
}): HealthCheckpointMatch[] {
  const regions = healthRegionsFor(input.areaCoarse);
  if (regions.size === 0) return [];

  const matches: HealthCheckpointMatch[] = [];
  for (const checkpoint of HEALTH_CHECKPOINTS) {
    if (!regions.has(checkpoint.region)) continue;
    const occurrence = checkpointOccurrence(checkpoint, input.now);

    const admitted: Admitted[] = [];
    for (const child of input.children) {
      // Fail-closed: a row with no generic wording is SILENCE for a 13+ child, never
      // the specific wording (rule #1).
      if (child.isTeen && checkpoint.teenSafeTask === null) continue;
      if (!inBand(checkpoint, child)) continue;

      const ref = checkpointRef(checkpoint, child.id, occurrence);
      if (input.suppressedRefs.has(ref)) continue;
      admitted.push({ child, ref, monthsLeft: checkpoint.maxMonths - child.ageMonths });
    }
    if (admitted.length === 0) continue;

    const named = admitted.filter((entry) => !entry.child.isTeen);
    const soonest = (entries: Admitted[]) =>
      entries.reduce((best, entry) => (entry.monthsLeft < best.monthsLeft ? entry : best));
    const primary = soonest(named.length > 0 ? named : admitted);

    // THE ROLL CALL IS EXACTLY THE REF'S SCOPE, and that is the invariant rather than a
    // stylistic choice. A household-scoped ref (the annual records check) is suppressed
    // for everyone at once, so the message may name everyone. A child-scoped ref is
    // suppressed for ONE child, so naming a sibling would promise something the
    // suppression cannot keep: twins both at six months would be named together, the
    // parent would reply "done", and the sibling's still-open ref would raise the same
    // paperwork again the following week. Scope the words to the identity and the
    // mismatch cannot exist.
    const covered = checkpoint.annual ? named : named.filter((entry) => entry === primary);

    matches.push({
      checkpoint,
      primaryChildId: primary.child.id,
      ref: primary.ref,
      kidNames: covered
        .map((entry) => entry.child.name)
        .filter((name): name is string => typeof name === 'string' && name.trim().length > 0),
      teenOnly: named.length === 0,
      teenCount: admitted.length - named.length,
      monthsLeft: primary.monthsLeft,
    });
  }

  // The window that closes soonest wins: a two-month infant visit expires while a
  // school-age record check is still wide open, and the expiring one is the only one
  // where waiting a week costs the family anything. Ties fall back to table order
  // (age), so a run is stable.
  return matches.sort(
    (a, b) =>
      a.monthsLeft - b.monthsLeft ||
      (TABLE_ORDER.get(a.checkpoint.id) ?? 0) - (TABLE_ORDER.get(b.checkpoint.id) ?? 0),
  );
}
