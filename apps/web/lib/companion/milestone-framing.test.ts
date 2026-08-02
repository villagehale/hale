import { type FamilyStage, companionForChild, milestoneStatusLabel } from '@hale/types';
import { describe, expect, it } from 'vitest';
import { findBannedPhrases } from '~/lib/health/framing';

/**
 * VIL-260 · WS5 — the framing lint, pointed at DEVELOPMENT copy.
 *
 * The lint was written for health-admin copy (VIL-243 · M8), but the register it
 * polices is the same one rule #1 forbids everywhere: a claim about the CHILD
 * ("behind", "delayed", "should already", "on track") that Hale has no baseline
 * to make. Milestone copy is where that temptation is strongest, and it was
 * already half-lost — a typically-developing 47-month-old had every toddler row
 * flagged "worth asking", which is the alarmist reading in everything but wording.
 *
 * The corpus is EVERY parent-facing development string the companion can produce:
 * each stage's milestone names and notes, each timing label in both done states,
 * and the "what matters now / what's next" guidance for every stage AND for the
 * preschool sub-band inside the child stage. Adding a milestone or rewriting a
 * guidance line runs through this automatically.
 */

/** One age per stage, plus both halves of the over-wide child stage. */
const AGES_MONTHS = [2, 11, 13, 24, 47, 49, 66, 96, 150, 160, 200] as const;

function developmentCopy(): Array<{ where: string; text: string }> {
  const now = new Date(2026, 5, 15);
  const corpus: Array<{ where: string; text: string }> = [];

  for (const months of AGES_MONTHS) {
    const dob = new Date(now.getFullYear(), now.getMonth() - months, now.getDate());
    const view = companionForChild({ dateOfBirth: dob }, now);
    const at = `${months}mo (${view.stage as FamilyStage})`;

    for (const line of view.whatsNow) corpus.push({ where: `${at} whatsNow`, text: line });
    corpus.push({ where: `${at} whatsNext`, text: view.whatsNext });

    for (const milestone of view.milestones) {
      corpus.push({ where: `${at} milestone`, text: milestone.what });
      corpus.push({ where: `${at} milestone note`, text: milestone.note });
      for (const done of [false, true]) {
        corpus.push({
          where: `${at} label ${milestone.timing}/done=${done}`,
          text: milestoneStatusLabel({ timing: milestone.timing, done }),
        });
      }
    }
  }
  return corpus;
}

describe('development copy passes the framing lint (rule #1)', () => {
  it('never judges the child, diagnoses, alarms, or instructs', () => {
    for (const { where, text } of developmentCopy()) {
      expect({ where, text, banned: findBannedPhrases(text) }).toEqual({
        where,
        text,
        banned: [],
      });
    }
  });

  it('really is linting a corpus, not an empty list', () => {
    // A guard against the lint quietly passing because the corpus collapsed.
    const corpus = developmentCopy();
    expect(corpus.length).toBeGreaterThan(100);
    expect(new Set(corpus.map((c) => c.text)).size).toBeGreaterThan(30);
  });

  it('would catch the framing it exists to forbid', () => {
    // Red-anchor: the lint is only meaningful if these fail it.
    expect(findBannedPhrases('She should already be walking')).not.toEqual([]);
    expect(findBannedPhrases('Your toddler is behind on language')).not.toEqual([]);
    expect(findBannedPhrases('possible developmental delay')).not.toEqual([]);
    expect(findBannedPhrases('not on track for this stage')).not.toEqual([]);
  });
});
