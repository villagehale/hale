import type { ProgramDomain } from '@hale/db';
import { ageInMonths, deriveStage } from '@hale/types';
import {
  AGE_TOLERANCE_MONTHS,
  type RegistrationMatch,
} from '~/lib/registration/match-registration-windows';

/**
 * VIL-242 · M7 — the shortlist Hale drafts for a parent days before a window opens.
 *
 * THE HARD BOUNDARY, restated as a data rule. D8 forbids bot circumvention and
 * credentialed auto-submission; this file is where the same discipline shows up in the
 * content. The M1 dataset holds a municipality, a program domain, a cycle label, an age
 * band, a source URL and a set of dates — and that is the entire shortlist. It holds no
 * program names, no class times, no instructor slots, so this object has nowhere to put
 * one. "Tadpole Level 2, Tuesdays 4:30" would be a sentence a parent plans their
 * 6:30 a.m. around, and Hale has never seen that page.
 *
 * What Hale CAN add is the part a parent cannot do at 6:29 with one hand: which of
 * their children the published band admits, whether that rests on a spoken-age
 * tolerance, whether their postal code buys a head start, and the direct link.
 *
 * Rule #1, and a deliberate divergence from M4. The nudge sweep drops 13+ children
 * before matching at all, so a teen's registration window is invisible to it. Here they
 * are matched and their fit note is NAMELESS — the same call M8 made for health
 * checkpoints, for the same reason: a teenager's swim-lesson registration closes
 * whether or not Hale is comfortable talking about it, and silence would cost the
 * family the spot. What changes for a 13+ child is the WORDING, never the existence of
 * the message, and the name is stripped HERE, at the source.
 */

export interface SequenceChild {
  id: string;
  name: string;
  dateOfBirth: string;
}

export type AgeFit = 'in_band' | 'near_band';

export interface FitNote {
  childId: string;
  /** Null for a 13+ child — never named on this surface (rule #1). */
  name: string | null;
  /** `near_band` means the child only fits on the ±6-month tolerance the matcher
   * grants a DOB derived from a spoken age, so the copy must hedge. */
  fit: AgeFit;
}

export interface Shortlist {
  windowRef: {
    id: string;
    municipality: string;
    programDomain: ProgramDomain;
    cycleLabel: string;
  };
  /** How the municipality's own domain reads in a sentence to a parent. */
  programDomainLabel: string;
  /** When THIS family can first register — the resident date where they have one. */
  opensForFamilyAt: Date;
  /** The municipal page itself. The one link the whole sequence points at, because
   * Hale never stands between a parent and the registration form. */
  sourceUrl: string;
  isResidentWindow: boolean;
  /** The published head start in days, only where this family can use it. */
  residentPriorityDays: number | null;
  /** The published waitlist response window, carried so the post-window clock can be
   * set from the municipality's own rule rather than a Hale default. */
  waitlistResponseHours: number | null;
  fitNotes: FitNote[];
  /** True when NO child is squarely in band — the whole shortlist is a hedge. */
  ageApproximate: boolean;
}

/** How each M1 program domain reads to a parent. Reviewed copy, not a prettified
 * enum: "rec_program" is our word for it, "recreation programs" is theirs. */
const PROGRAM_DOMAIN_LABEL: Record<ProgramDomain, string> = {
  rec_program: 'recreation programs',
  camp: 'camps',
  swim: 'swim lessons',
  after_school_care: 'before-and-after-school care',
};

/** How a child of `ageMonths` sits against a published band, or null when the band
 * excludes them even with the tolerance. Mirrors the matcher's own conservatism:
 * a near-edge child is INCLUDED and flagged, never silently dropped. */
function fitOf(ageMonths: number, min: number | null, max: number | null): AgeFit | null {
  if (min !== null && ageMonths < min - AGE_TOLERANCE_MONTHS) return null;
  if (max !== null && ageMonths > max + AGE_TOLERANCE_MONTHS) return null;
  if (min !== null && ageMonths < min) return 'near_band';
  if (max !== null && ageMonths > max) return 'near_band';
  return 'in_band';
}

/**
 * The shortlist for one matched window, or null when no child in the family fits it —
 * in which case there is nothing for a parent to approve and no sequence to run.
 *
 * The fit notes are computed from the children directly rather than read off
 * `matchedChildAgesMonths`: that field carries AGES, and two siblings can share one, so
 * mapping back through it would attach a note to the wrong child in exactly the
 * households this feature is hardest for.
 */
export function buildShortlist(
  match: RegistrationMatch,
  children: readonly SequenceChild[],
  now: Date,
): Shortlist | null {
  const { window } = match;
  const fitNotes: FitNote[] = [];
  for (const child of children) {
    const fit = fitOf(ageInMonths(child.dateOfBirth, now), window.ageMinMonths, window.ageMaxMonths);
    if (fit === null) continue;
    const isTeen = deriveStage(child.dateOfBirth, now) === 'teenager';
    fitNotes.push({ childId: child.id, name: isTeen ? null : child.name, fit });
  }
  if (fitNotes.length === 0) return null;

  return {
    windowRef: {
      id: window.id,
      municipality: window.municipality,
      programDomain: window.programDomain,
      cycleLabel: window.cycleLabel,
    },
    programDomainLabel: PROGRAM_DOMAIN_LABEL[window.programDomain],
    opensForFamilyAt: match.opensForFamilyAt,
    sourceUrl: window.sourceUrl,
    isResidentWindow: match.isResidentWindow,
    // A head start nobody can use is not a fact about this family.
    residentPriorityDays: match.isResidentWindow ? window.residentPriorityDays : null,
    waitlistResponseHours: window.waitlistResponseHours,
    fitNotes,
    ageApproximate: match.ageApproximate,
  };
}
