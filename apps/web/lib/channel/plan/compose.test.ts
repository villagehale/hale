import { describe, expect, it, vi } from 'vitest';
import { MAX_PLAN_SEGMENTS, sendablePlan } from './compose';

/**
 * The structural gates — what may and may not reach a parent's phone as a plan.
 *
 * The QUALITY of a plan is an eval against real cached Claude (rule #8, see
 * apps/worker/evals/run-coach-plan-eval.mjs). What is pinned here is the part a prompt
 * cannot guarantee: the shapes that must never be sent whatever the model wrote, and
 * the all-or-nothing rule that keeps a sequence from arriving with a hole in it.
 */

/** A body of `n` GSM-7 characters — enough to push a message over the segment budget
 * without depending on any particular sentence. */
const chars = (n: number) => 'a'.repeat(n);

const GOOD = [
  'Nights 1-3: put her down drowsy but awake, then wait 5 minutes before going in.',
  'Nights 4-7: same start, but stretch the wait to 10 minutes. Expect night 2 to be the hardest.',
];

describe('sendablePlan', () => {
  it('passes a plan through as ordered, flattened messages', () => {
    expect(sendablePlan(GOOD)).toEqual({ status: 'composed', messages: GOOD });
  });

  it('flattens markdown a phone would print literally', () => {
    const outcome = sendablePlan(['**Nights 1-3:** down drowsy.', '- Nights 4-7: wait 10 min.']);

    expect(outcome).toEqual({
      status: 'composed',
      messages: ['Nights 1-3: down drowsy.', 'Nights 4-7: wait 10 min.'],
    });
  });

  it('refuses a one-message plan — that is the answer they already had', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(sendablePlan([GOOD[0] as string])).toEqual({
      status: 'unavailable',
      reason: 'wrong_shape',
    });
    logged.mockRestore();
  });

  it('refuses a four-message plan', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(sendablePlan([...GOOD, 'Week 2: hold the line.', 'Week 3: extra.'])).toEqual({
      status: 'unavailable',
      reason: 'wrong_shape',
    });
    logged.mockRestore();
  });

  it('fails the WHOLE plan when one stage is over budget, never a plan with a hole', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Dropping the offending message would text a parent nights 1-3 and nights 8-14
    // with the middle missing and nothing saying so.
    const outcome = sendablePlan([GOOD[0] as string, chars(600), GOOD[1] as string]);

    expect(outcome).toEqual({ status: 'unavailable', reason: 'unsendable' });
    logged.mockRestore();
  });

  it('allows a stage that fills the plan budget a coach reply would not get', () => {
    // Three segments, not two: a plan stage trimmed to a coach reply's length is the
    // amputation this whole arc exists to undo.
    const outcome = sendablePlan([GOOD[0] as string, chars(MAX_PLAN_SEGMENTS * 153)]);

    expect(outcome.status).toBe('composed');
  });

  it('refuses a plan that names a dose', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    // The one shape whose cost is a parent measuring something out on Hale's word.
    const outcome = sendablePlan([GOOD[0] as string, 'If she is still fussing, 5ml should settle her.']);

    expect(outcome).toEqual({ status: 'unavailable', reason: 'unsendable' });
    logged.mockRestore();
  });

  it('refuses a plan carrying a link', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const outcome = sendablePlan([GOOD[0] as string, 'More at https://example.com/sleep']);

    expect(outcome).toEqual({ status: 'unavailable', reason: 'unsendable' });
    logged.mockRestore();
  });

  it('refuses a plan that would cost double to send', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    // One curly apostrophe flips the whole body to UCS-2 and halves the budget.
    const outcome = sendablePlan([GOOD[0] as string, 'Night 4: hold the line — it settles \u{1F634}']);

    expect(outcome).toEqual({ status: 'unavailable', reason: 'unsendable' });
    logged.mockRestore();
  });

  it('substitutes rather than refuses when the plan reaches for the health line', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    // A parent whose plan turned out to be about a hurt child must get the reviewed
    // line, never "I could not put that together". No body is carried out of here.
    const outcome = sendablePlan([GOOD[0] as string, 'If the fever climbs, call 811 right away.']);

    expect(outcome).toEqual({ status: 'safety' });
    logged.mockRestore();
  });

  it('reads a plan of empty strings as the wrong shape rather than as whitespace', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(sendablePlan(['', '  ', ''])).toEqual({
      status: 'unavailable',
      reason: 'wrong_shape',
    });
    logged.mockRestore();
  });
});
