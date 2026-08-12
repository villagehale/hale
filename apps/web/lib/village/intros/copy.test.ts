import { FAMILY_STAGES } from '@hale/types';
import { describe, expect, it } from 'vitest';
import { smsEncoding, smsSegments } from '~/lib/channel/sms-segments';
import {
  DISCOVERABILITY_ASK,
  DISCOVERABILITY_OFF,
  DISCOVERABILITY_ON,
  INTRO_EMAIL_SUBJECT,
  INTRO_NO_ACK,
  INTRO_SOFT_CLOSE,
  INTRO_YES_ACK,
  NO_OPEN_INTRO,
  activityAnchor,
  coarseCard,
  introEmailBody,
  stageWord,
} from './copy';

/**
 * The copy IS the spec, so these assertions are verbatim. What earns its place beyond
 * the string equality is the property tests: the card cannot be handed the other
 * family's identity, the soft close is identical for all three reasons an intro dies,
 * and every outbound body fits GSM-7 inside its segment budget.
 */

/** The counterpart family's strings, as a live test would seed them. Nothing on this
 * list may appear in anything a card renders. */
const COUNTERPART = {
  parentName: 'Priya Raman',
  childName: 'Marisol',
  postal: 'M4K 1N2',
  street: '18 Boulton Avenue',
  exactAge: '31 months',
};

describe('DISCOVERABILITY_ASK', () => {
  it('is the spec sentence, verbatim', () => {
    expect(DISCOVERABILITY_ASK).toBe(
      "Something new: other Hale families are near you. Want me to introduce you when there's a great match? Reply YES INTROS or NO INTROS.",
    );
  });

  it('names both keywords so a bare yes is never needed', () => {
    expect(DISCOVERABILITY_ASK).toContain('YES INTROS');
    expect(DISCOVERABILITY_ASK).toContain('NO INTROS');
  });

  it('asks before it has looked - it never mentions a specific family or place', () => {
    expect(DISCOVERABILITY_ASK).not.toMatch(/[A-Z]\d[A-Z]/);
  });
});

describe('coarseCard', () => {
  it('carries the recipients own child and the other side as a band word only', () => {
    expect(coarseCard('toddler', "Maya's", null)).toBe(
      "A Hale family near you has a toddler around Maya's age. Want an intro? Reply YES INTRO or NO INTRO.",
    );
  });

  it('splices the activity anchor between the fact and the question', () => {
    expect(coarseCard('preschool', "Noah's", activityAnchor('Baby Time', 'Saturday'))).toBe(
      "A Hale family near you has a preschooler around Noah's age. They're also eyeing Baby Time Saturday. Want an intro? Reply YES INTRO or NO INTRO.",
    );
  });

  it('renders a redacted own-child identifier without leaking a name', () => {
    // What loopChildName hands back for a 13+ child, or for the default name level.
    expect(coarseCard('child', "your kid's", null)).toBe(
      "A Hale family near you has a kid around your kid's age. Want an intro? Reply YES INTRO or NO INTRO.",
    );
  });

  it('cannot name the other family - none of their strings can reach the card', () => {
    // Non-vacuity: the counterpart fixture is real data, it just is not an input here.
    expect(COUNTERPART.childName).not.toBe('');
    const card = coarseCard('toddler', "Maya's", activityAnchor('Family Storytime', 'Saturday'));
    for (const secret of Object.values(COUNTERPART)) {
      expect(card, `the coarse card must never carry "${secret}"`).not.toContain(secret);
    }
  });

  it('has a stage word for every stage, and none of them is the raw stage key', () => {
    // 'preschool' and 'teenager' are labels, not nouns a sentence can hold.
    expect(stageWord('preschool')).toBe('preschooler');
    expect(stageWord('teenager')).toBe('teen');
    expect(stageWord('newborn')).toBe('baby');
    expect(stageWord('child')).toBe('kid');
    expect(stageWord('toddler')).toBe('toddler');
  });
});

describe('activityAnchor', () => {
  it('passes the dataset title through verbatim', () => {
    expect(activityAnchor('Ready for Reading (Ages 3-6)', 'Thursday')).toBe(
      "They're also eyeing Ready for Reading (Ages 3-6) Thursday.",
    );
  });
});

describe('INTRO_SOFT_CLOSE', () => {
  it('is the spec sentence, verbatim', () => {
    expect(INTRO_SOFT_CLOSE).toBe("No intro this time - I'll keep an eye out.");
  });

  it('reveals nothing about why - no refusal, no silence, no clock', () => {
    const forbidden = ['no thanks', 'declined', 'passed', 'said no', 'reply', 'expired', 'week'];
    for (const word of forbidden) {
      expect(INTRO_SOFT_CLOSE.toLowerCase()).not.toContain(word);
    }
  });
});

describe('introEmailBody', () => {
  it('names both parents, the shared stage, and hands the thread over', () => {
    const body = introEmailBody({
      parentAFirstName: 'Sam',
      parentBFirstName: 'Priya',
      stage: 'toddler',
      anchorTitle: null,
    });
    expect(body).toContain('Hi Sam and Priya,');
    expect(body).toContain('you each have a toddler');
    expect(body).toContain("I'm stepping back");
    expect(body).not.toContain('eyeing');
  });

  it('adds the anchor line only when there is an activity', () => {
    const body = introEmailBody({
      parentAFirstName: 'Sam',
      parentBFirstName: 'Priya',
      stage: 'preschool',
      anchorTitle: 'Family Storytime',
    });
    expect(body).toContain('You were also both eyeing Family Storytime');
  });

  it('never carries a child name, a postal code or a street', () => {
    const body = introEmailBody({
      parentAFirstName: 'Sam',
      parentBFirstName: 'Priya',
      stage: 'toddler',
      anchorTitle: 'Family Storytime',
    });
    expect(body).not.toContain(COUNTERPART.childName);
    expect(body).not.toContain(COUNTERPART.postal);
    expect(body).not.toContain(COUNTERPART.street);
    expect(body).not.toContain(COUNTERPART.parentName);
  });

  it('has a subject that says nothing a preview pane should not', () => {
    expect(INTRO_EMAIL_SUBJECT).toBe('A Hale family near you');
  });
});

describe('every outbound SMS body', () => {
  /** The worst case each template can produce, so the budget is asserted against the
   * longest real rendering rather than the shortest. */
  const bodies: Array<[string, string]> = [
    ['DISCOVERABILITY_ASK', DISCOVERABILITY_ASK],
    ['DISCOVERABILITY_ON', DISCOVERABILITY_ON],
    ['DISCOVERABILITY_OFF', DISCOVERABILITY_OFF],
    ['INTRO_YES_ACK', INTRO_YES_ACK],
    ['INTRO_NO_ACK', INTRO_NO_ACK],
    ['INTRO_SOFT_CLOSE', INTRO_SOFT_CLOSE],
    ['NO_OPEN_INTRO', NO_OPEN_INTRO],
    ...FAMILY_STAGES.map(
      (stage): [string, string] => [
        `coarseCard:${stage}`,
        coarseCard(stage, "your daughter's", activityAnchor('Ready for Reading (Ages 3-6)', 'Wednesday')),
      ],
    ),
  ];

  it.each(bodies)('%s stays in the GSM-7 alphabet', (_name, body) => {
    expect(smsEncoding(body)).toBe('gsm7');
  });

  it.each(bodies)('%s fits two segments', (_name, body) => {
    expect(smsSegments(body)).toBeLessThanOrEqual(2);
  });
});
