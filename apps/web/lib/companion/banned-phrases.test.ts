import { describe, expect, it } from 'vitest';
import { findBannedPhrases } from './banned-phrases';

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

