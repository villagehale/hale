import { describe, expect, it } from 'vitest';
import { menuShape } from './coach-channel-menu-gate.mjs';

describe('menuShape', () => {
  /**
   * The reply that got through. Live, from the verifier's mutation run of 2026-08-26:
   * the errands CANNOT row was deleted and the coach answered with this, at voice=4,
   * passing every check in the corpus.
   */
  it('catches the refusal that got through', () => {
    expect(
      menuShape(
        'Ordering groceries is past me - I handle the family schedule, activities, and parenting questions.',
      ),
    ).toBe(
      'Ordering groceries is past me - I handle the family schedule, activities, and parenting questions.',
    );
  });

  /** The skill's own worked example of the shape, quoted in coach-channel-sms.md. */
  it('catches the one the skill already forbids in prose', () => {
    expect(
      menuShape(
        "That's past me - I handle the family schedule, parenting questions, and finding activities. Anything on that side?",
      ),
    ).toContain('I handle the family schedule');
  });

  it('catches it without the Oxford comma, which is not what makes it a menu', () => {
    expect(menuShape('I help with schedules, activities and parenting.')).not.toBeNull();
  });

  /** THE POSITIVE CONTROL for the good answer — the shape the fixture is supposed to get. */
  it('clears the one-clause refusal', () => {
    expect(menuShape('Ordering groceries is past what I can do.')).toBeNull();
  });

  /**
   * Two is a choice, not a menu. A reply offering the parent the doors that exist for
   * the thing they asked about is the product working, and a gate that failed it would
   * push every answer vaguer.
   */
  it('clears a two-item offer about the thing that was actually asked', () => {
    expect(menuShape('I can move it or cancel it - which?')).toBeNull();
  });

  /** A list is only a menu when it is a list of HALE. Three real things is a week. */
  it('clears a list that is about the family and not about Hale', () => {
    expect(
      menuShape('Thursday has swim at 4:30, soccer at 5:15, and the dentist at 6.'),
    ).toBeNull();
  });

  it('clears a capability sentence and a separate list, which is two ordinary breaths', () => {
    expect(menuShape('I can do that. Thursday has swim, soccer, and the dentist.')).toBeNull();
  });
});
