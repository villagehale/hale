import { describe, expect, it } from 'vitest';
import {
  HEALTH_CHECKPOINTS,
  MAX_LINK_URL_LENGTH,
  TEEN_STAGE_MIN_MONTHS,
  checkpointRef,
  refsSharingVisit,
} from './checkpoints';
import { findBannedPhrases } from './framing';

/**
 * VIL-243 · M8 — THE CONTENT REVIEW GATE.
 *
 * Health-admin copy is the one place in Hale where a sentence that reads fine can do
 * real harm: a parent told their child is "behind" on vaccines hears a diagnosis Hale
 * has no standing to make and no data to support. So every string this feature can
 * ever put in front of a parent is linted here, and the lint runs over the RENDERED
 * message — not just the source strings — because a template can assemble a banned
 * phrase out of two innocent halves.
 */

describe('findBannedPhrases', () => {
  it('catches the judgment vocabulary this feature exists to avoid', () => {
    expect(findBannedPhrases('Maya is behind on her shots')).toContain('behind');
    expect(findBannedPhrases('This visit is overdue')).toContain('overdue');
    expect(findBannedPhrases('She should already be walking')).toContain('should');
    expect(findBannedPhrases('a milestone was missed')).toContain('missed');
    expect(findBannedPhrases('possible developmental delay')).toContain('delay');
  });

  it('catches diagnosis-adjacent words even in friendly sentences', () => {
    expect(findBannedPhrases('Nothing to diagnose here, promise')).toContain('diagnose');
    expect(findBannedPhrases('watch for symptoms')).toContain('symptoms');
    expect(findBannedPhrases('perfectly normal for her age')).toContain('normal');
  });

  it('catches second-person pressure, so copy stays an offer', () => {
    expect(findBannedPhrases('You must report this')).toContain('you must');
    expect(findBannedPhrases('Make sure you file it')).toContain('make sure');
    expect(findBannedPhrases("Don't forget the form")).toContain("don't forget");
  });

  /**
   * The cases a literal-string lint waves through. Every one is copy a careful author
   * could plausibly write, which is exactly why the gate has to survive inflection and
   * paraphrase rather than exact spelling.
   */
  it('survives inflection — plurals, participles, adverbs, hyphens', () => {
    const slips = [
      'delays are common',
      'lateness happens',
      'a catch-up clinic',
      'catching up on records',
      'at-risk families',
      'risky for her',
      'diagnosing anything',
      'symptomatic children',
      'other conditions',
      'diseases and disorders',
      'suspensions are issued',
      'penalties may apply',
      'urgently, please',
      'immediate action',
      'abnormalities noted',
      'past due',
      'her record expired',
      'coverage lapsed',
      'an incomplete record',
      'not up to date',
      'this is out of date',
      'non-compliant families',
      'required by law',
      'excluded from school',
      'act now',
      'last chance',
      'running out of time',
      'the deadline is Friday',
      'your child is lagging',
      'she is not where she should be',
    ];
    for (const text of slips) {
      expect({ text, banned: findBannedPhrases(text).length > 0 }).toEqual({ text, banned: true });
    }
  });

  it('survives paraphrase of the second-person instruction', () => {
    const slips = [
      'you will need to report this',
      "you'll need to file it",
      'youll need to file it',
      'you really should report it',
      'be sure that you file it',
    ];
    for (const text of slips) {
      expect({ text, banned: findBannedPhrases(text).length > 0 }).toEqual({ text, banned: true });
    }
  });

  it('is word-bounded, so a legitimate word is not a false positive', () => {
    // 'immunization' contains 'immune'; 'lateral' and 'later' contain 'late';
    // 'commission' contains 'miss'; 'check-up' is not 'catch up'.
    for (const text of [
      'immunization record',
      'a lateral move',
      'later this month',
      'school commission',
      'a dental check-up',
      'with your family doctor',
    ]) {
      expect({ text, banned: findBannedPhrases(text) }).toEqual({ text, banned: [] });
    }
  });

  it('is case-insensitive, and reports what actually matched', () => {
    expect(findBannedPhrases('BEHIND')).toContain('behind');
    expect(findBannedPhrases('several DELAYS')).toContain('delays');
  });

  it('says nothing about copy that is purely administrative', () => {
    expect(findBannedPhrases('Ontario schedules a routine vaccine visit at 6 months.')).toEqual([]);
  });
});

describe('the checkpoint table', () => {
  it('covers the Ontario schedule ages the ticket names', () => {
    const covers = (months: number) =>
      HEALTH_CHECKPOINTS.some(
        (c) =>
          c.region === 'ontario' &&
          c.id.startsWith('immunization_') &&
          months >= c.minMonths &&
          months <= c.maxMonths,
      );
    // 2, 4, 6, 12, 15, 18 months; the 4-6 year booster; grade 7; 14-16 years.
    for (const months of [2, 4, 6, 12, 15, 18, 54, 144, 174]) {
      expect({ months, covered: covers(months) }).toEqual({ months, covered: true });
    }
  });

  it('names an official source and a short in-message link for every row', () => {
    for (const checkpoint of HEALTH_CHECKPOINTS) {
      expect(checkpoint.sourceUrl).toMatch(
        /^https:\/\/(www\.ontario\.ca|www\.toronto\.ca|tph\.icon\.ehealthontario\.ca)\//,
      );
      expect(checkpoint.linkUrl).toMatch(
        /^https:\/\/(www\.ontario\.ca|www\.toronto\.ca|tph\.icon\.ehealthontario\.ca)\//,
      );
      expect({ id: checkpoint.id, len: checkpoint.linkUrl.length <= MAX_LINK_URL_LENGTH }).toEqual({
        id: checkpoint.id,
        len: true,
      });
    }
  });

  it('links the ICON self-report portal from the Toronto records checkpoint', () => {
    const icon = HEALTH_CHECKPOINTS.find((c) => c.region === 'toronto');
    expect(icon?.linkUrl).toBe('https://tph.icon.ehealthontario.ca/#!/welcome');
  });

  it('has unique ids and age-ordered, non-inverted bands', () => {
    const ids = HEALTH_CHECKPOINTS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const checkpoint of HEALTH_CHECKPOINTS) {
      expect({ id: checkpoint.id, ok: checkpoint.minMonths <= checkpoint.maxMonths }).toEqual({
        id: checkpoint.id,
        ok: true,
      });
    }
  });

  it('gives every teen-reachable checkpoint a generic, teen-safe task (rule #1)', () => {
    for (const checkpoint of HEALTH_CHECKPOINTS) {
      // Reachability is the band's END, with NO tolerance: the derived-DOB slack widens
      // the early edge only (match.ts), so a checkpoint reaches a teen exactly when its
      // window does. Adding the tolerance here would model a rule inBand never applies.
      const reachesTeens = checkpoint.maxMonths >= TEEN_STAGE_MIN_MONTHS;
      if (!reachesTeens) continue;
      expect({ id: checkpoint.id, teenSafe: typeof checkpoint.teenSafeTask }).toEqual({
        id: checkpoint.id,
        teenSafe: 'string',
      });
    }
  });

  it('keeps every teen-safe task free of a vaccine or condition specific', () => {
    // The teen render may say WHAT KIND of paperwork it is and nothing else. A row that
    // named the vaccine would be surfacing a 13+ child's health content to a parent.
    for (const checkpoint of HEALTH_CHECKPOINTS) {
      if (checkpoint.teenSafeTask === null) continue;
      expect(checkpoint.teenSafeTask.toLowerCase()).not.toMatch(
        /\b(hpv|hepatitis|meningococcal|tetanus|measles|polio|dose|booster|shot)\b/,
      );
    }
  });

  /**
   * A `visit` names the real-world APPOINTMENT a row is about, and it is what makes a
   * parent's "we booked already" mean the thing they meant. Ontario's enhanced 18-month
   * well-baby visit IS the visit the 18-month vaccines are given at, so the two rows
   * that describe it are one errand — and a family who told us it is booked heard about
   * it twice, seven days apart, because the table could not say so (2026-08-13 → 08-20).
   */
  it('groups only rows a parent could book in one appointment', () => {
    const byVisit = new Map<string, string[]>();
    for (const checkpoint of HEALTH_CHECKPOINTS) {
      if (checkpoint.visit === null) continue;
      byVisit.set(checkpoint.visit, [...(byVisit.get(checkpoint.visit) ?? []), checkpoint.id]);
    }
    // The one real collision in the shipped table, stated as the fixture it is.
    expect(byVisit.get('well_child_18_months')?.sort()).toEqual([
      'immunization_18_months',
      'well_baby_18_months',
    ]);

    for (const [visit, ids] of byVisit) {
      const members = ids.map((id) => HEALTH_CHECKPOINTS.find((c) => c.id === id));
      for (const member of members) {
        // A grouped row must be per-CHILD and one-time: an annual row is scoped to the
        // household and a school year, so folding it in with a child's visit would
        // suppress a whole household off one child's appointment.
        expect({ visit, id: member?.id, annual: member?.annual }).toEqual({
          visit,
          id: member?.id,
          annual: false,
        });
      }
      // Members must actually overlap in age, or they are not one appointment.
      const min = Math.max(...members.map((m) => m?.minMonths ?? 0));
      const max = Math.min(...members.map((m) => m?.maxMonths ?? 0));
      expect({ visit, overlaps: min <= max }).toEqual({ visit, overlaps: true });
    }
  });

  it('never groups a row that is paperwork rather than an appointment', () => {
    for (const id of ['school_records_ispa', 'dental_school_screening', 'immunization_grade_7']) {
      const checkpoint = HEALTH_CHECKPOINTS.find((c) => c.id === id);
      expect({ id, visit: checkpoint?.visit }).toEqual({ id, visit: null });
    }
  });
});

describe('refsSharingVisit', () => {
  const refOf = (id: string, childId: string) => {
    const checkpoint = HEALTH_CHECKPOINTS.find((c) => c.id === id);
    if (!checkpoint) throw new Error(`fixture drift: no checkpoint '${id}'`);
    return checkpointRef(checkpoint, childId, 0);
  };

  it('carries a handled visit across every row that names the same appointment', () => {
    expect([...refsSharingVisit(refOf('immunization_18_months', 'child-1'))].sort()).toEqual(
      [refOf('immunization_18_months', 'child-1'), refOf('well_baby_18_months', 'child-1')].sort(),
    );
  });

  it('keeps the sibling scoped to the SAME child', () => {
    const spread = refsSharingVisit(refOf('well_baby_18_months', 'child-1'));
    expect(spread).not.toContain(refOf('well_baby_18_months', 'child-2'));
    expect(spread).not.toContain(refOf('immunization_18_months', 'child-2'));
  });

  it('widens nothing for a paperwork row', () => {
    const ref = refOf('school_records_ispa', '*');
    expect(refsSharingVisit(ref)).toEqual([ref]);
  });

  it('hands back an unparseable ref untouched rather than guessing', () => {
    expect(refsSharingVisit('not-a-ref')).toEqual(['not-a-ref']);
  });
});
