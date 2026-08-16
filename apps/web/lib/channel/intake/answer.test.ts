import { describe, expect, it } from 'vitest';
import { SAFETY_REPLY } from '~/lib/channel/off-domain/copy';
import { WATCH_OFFER_ASK } from './copy';
import {
  type IntakeAnswerInput,
  MAX_REPLY_CHARS,
  createIntakeAnswerComposer,
  intakeAnswerContext,
  readPair,
  refusals,
} from './answer';

/**
 * The gates around the mid-signup answer. Whether Hale writes a GOOD one is the eval's
 * job against real cached Claude (rule #8, apps/worker/evals/run-intake-answer-eval.mjs);
 * what this file owns is what may reach a parent's phone at all.
 */

const INPUT: IntakeAnswerInput = {
  parentWords: 'Does Sebastian need an eye exam?',
  pendingAsk: WATCH_OFFER_ASK,
  children: [{ name: 'Sebastian', ageMonths: 48, agePrecision: 'years' }],
};

const RETURN = 'Still want me watching the registration dates?';

function problems(answer: string, returnLine = RETURN, input = INPUT) {
  return refusals(answer, returnLine, input);
}

describe('intake answer · what may not go out', () => {
  it('passes a grounded, plain answer with Hale\'s question on the end', () => {
    expect(problems("I'm not a doctor, but Ontario covers a yearly eye check for kids.")).toEqual(
      [],
    );
  });

  it('refuses a claim that Hale is already doing the work — nothing has been agreed to', () => {
    // The exact shape a warm model reaches for on the consent turn, and every one of
    // them is false at the moment it would be sent.
    for (const claim of [
      "I'll keep an eye on that for you.",
      "I'm already tracking his checkups.",
      "I've found a few clinics nearby.",
      'From now on you will hear from me when one opens.',
    ]) {
      expect(problems(claim), claim).toContain('claimed_work');
    }
  });

  it('lets an honest present-tense answer through, so the gate is not just "any first person"', () => {
    // The positive control for the rule above: same voice, no claim of work underway.
    expect(problems("I don't book appointments, so that one's yours to make.")).toEqual([]);
  });

  it('refuses a sentence that points at an app a texting parent does not have', () => {
    expect(problems('You can see all of it in the app.')).toContain('points_at_the_app');
  });

  it('refuses a link, a second question, and a return line that asks nothing', () => {
    expect(problems('Have a look at https://example.com for the schedule.')).toContain(
      'carries_link',
    );
    expect(problems('Which eye did you mean?')).toContain('answer_carries_question');
    expect(problems('OHIP covers it.', 'So let me know')).toContain('return_asks_nothing');
  });

  it('refuses the verbatim re-ask — the bug this stage exists to end', () => {
    expect(problems('OHIP covers it.', WATCH_OFFER_ASK)).toContain('return_repeats_the_ask');
    // The positive control: a different sentence asking the same thing is the point.
    expect(problems('OHIP covers it.', 'Want me keeping an eye on it?')).toEqual([]);
  });

  it('refuses an invented time and a body a carrier would bill twice', () => {
    expect(problems('Clinics near you open at 9:30 most days.')).toContain('invented_fact');
    expect(problems('OHIP covers it — free every year.')).toContain('not_gsm7');
    // The cap is on the JOINED body, because that is what a carrier bills: a long half
    // riding behind a short one is a message that sends perfectly well.
    expect(problems('x'.repeat(MAX_REPLY_CHARS), RETURN)).toContain('over_char_cap');
    expect(problems('x'.repeat(MAX_REPLY_CHARS - RETURN.length - 1), RETURN)).toEqual([]);
  });

  it('refuses a claim of being human unless it says what Hale actually is', () => {
    // The live draw that made this a gate: "It's a real person on the other end."
    expect(problems("It's a real person on the other end.")).toContain('claimed_to_be_human');
    // The positive control, and the reason this is a conditional rather than a banned
    // phrase: the honest answer contains the same words.
    expect(problems("No - I'm an AI, not a real person.")).toEqual([]);
  });

  it('refuses the present-tense "I watch", and lets its denial through', () => {
    expect(problems('I watch for registration dates all year.')).toContain('claimed_work');
    expect(problems("I don't watch anything until you say so.")).toEqual([]);
  });

  it('lets the child the parent named through, and nothing they did not', () => {
    expect(problems('Sebastian is 48 months of pure chaos, and yes they check eyes free.')).toEqual(
      [],
    );
  });
});

describe('intake answer · reading the pair', () => {
  it('joins the two halves into one text', () => {
    const outcome = readPair({ answer: 'OHIP covers it.', returnLine: RETURN }, INPUT);
    expect(outcome).toEqual({ status: 'answered', body: `OHIP covers it. ${RETURN}` });
  });

  it('reads an empty answer as "they did not ask anything" rather than a refusal', () => {
    expect(readPair({ answer: '   ', returnLine: RETURN }, INPUT)).toEqual({
      status: 'nothing_to_answer',
    });
  });

  it('substitutes the reviewed safety line when the composer reaches for a referral', () => {
    // Before every other gate: this parent must never get a signup question instead.
    const outcome = readPair(
      { answer: 'Call 811 if you are worried', returnLine: `${'x'.repeat(200)}?` },
      INPUT,
    );
    expect(outcome).toEqual({ status: 'safety' });
  });

  it('names WHY a body was refused rather than sending it', () => {
    expect(readPair({ answer: "I'll watch that for you.", returnLine: RETURN }, INPUT)).toEqual({
      status: 'unavailable',
      reason: 'unusable',
    });
  });
});

describe('intake answer · the emergency tripwire', () => {
  it('answers an emergency with no model in the loop at all', async () => {
    // Intake has never had the router's screened safety lane. A client that throws on
    // use proves the token check runs BEFORE anything reaches a provider.
    const exploding = {
      messages: {
        create: () => {
          throw new Error('the model must not have been called');
        },
      },
    } as never;
    const composer = createIntakeAnswerComposer(exploding);

    expect(
      await composer.compose({ ...INPUT, parentWords: "she's not breathing, what do I do" }),
    ).toEqual({ status: 'safety' });
    // And the machine turns that into the reviewed line (machine.test.ts asserts the send).
    expect(SAFETY_REPLY).toContain('811');
  });
});

describe('intake answer · what the model is shown', () => {
  it('sees the words, the ask and the children — never the session or the postal code', () => {
    const context = intakeAnswerContext(INPUT) as Record<string, unknown>;
    expect(Object.keys(context).sort()).toEqual(['children', 'parentWords', 'pendingAsk']);
    expect(context.children).toEqual([{ name: 'Sebastian', ageMonths: 48 }]);
    // The consent ask goes in WITHOUT the privacy URL that rides with it in the message.
    expect(JSON.stringify(context)).not.toContain('http');
  });
});
