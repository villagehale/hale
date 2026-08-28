import { describe, expect, it } from 'vitest';
import { EMERGENCY_REPLY, MENTAL_CRISIS_REPLY, SAFETY_REPLY } from '~/lib/channel/off-domain/copy';
import { MARKHAM_FIRST, TORONTO_FIRST_REC } from '~/lib/channel/rec-morning';
import { ADULT_LEARN_DOOR } from './adult-learn';
import {
  type IntakeAnswerInput,
  MAX_REPLY_CHARS,
  createIntakeAnswerComposer,
  intakeAnswerContext,
  readPair,
  refusals,
} from './answer';
import { COLD_START_ASK, WATCH_OFFER_ASK } from './copy';
import { AFTER_PROVISION_RETURN_ASK, CHEER_UP_REPLY, NO_CURRENT_SOURCE_YET } from './live-lookup';
import { NOT_POSTED_YET, OFFICIAL_PAGE_RETURN_ASK } from './official-page';

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
  it("passes a grounded, plain answer with Hale's question on the end", () => {
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
    // And the machine turns that into Call 911 now. (machine.test.ts asserts the send).
    expect(EMERGENCY_REPLY).toBe('Call 911 now.');
    expect(EMERGENCY_REPLY).not.toContain('811');
    expect(EMERGENCY_REPLY).not.toContain('?');
    expect(SAFETY_REPLY).toContain('811');
    expect(SAFETY_REPLY).not.toBe(EMERGENCY_REPLY);
  });

  it('answers a Toronto swim clock question with reviewed copy, no model', async () => {
    const exploding = {
      messages: {
        create: () => {
          throw new Error('the model must not have been called');
        },
      },
    } as never;
    const composer = createIntakeAnswerComposer(exploding);
    const outcome = await composer.compose({
      ...INPUT,
      parentWords: 'When does Toronto swim registration open?',
    });
    expect(outcome.status).toBe('answered');
    if (outcome.status !== 'answered') return;
    expect(outcome.body).toBe(`${TORONTO_FIRST_REC} Still want me watching?`);
    expect(outcome.body.toLowerCase()).not.toContain('activeto');
    expect(outcome.body.toLowerCase()).not.toContain('unofficial');
    expect(outcome.body.toLowerCase()).not.toContain('efun');
    expect(outcome.body).not.toMatch(/I'm an AI/i);
    expect(outcome.body).not.toMatch(/https?:\/\//i);
    expect(outcome.body).not.toContain(WATCH_OFFER_ASK);
  });

  it('answers a Markham rec ask with the locked leftover, no model, no Toronto clock', async () => {
    const exploding = {
      messages: {
        create: () => {
          throw new Error('the model must not have been called');
        },
      },
    } as never;
    const composer = createIntakeAnswerComposer(exploding);
    const outcome = await composer.compose({
      ...INPUT,
      parentWords: 'Markham fall rec dates?',
    });
    expect(outcome.status).toBe('answered');
    if (outcome.status !== 'answered') return;
    expect(outcome.body).toBe(`${MARKHAM_FIRST} Still want me watching?`);
    expect(outcome.body).not.toContain('7:00');
    expect(outcome.body).not.toMatch(/Sept?\s*15/i);
    expect(outcome.body.toLowerCase()).not.toContain('activeto');
    expect(outcome.body).not.toMatch(/I'm an AI/i);
  });

  it('uses a collected L3R postal to switch a generic rec ask to Markham', async () => {
    const exploding = {
      messages: {
        create: () => {
          throw new Error('the model must not have been called');
        },
      },
    } as never;
    const composer = createIntakeAnswerComposer(exploding);
    const outcome = await composer.compose({
      ...INPUT,
      parentWords: 'when is fall rec?',
      postalCode: 'L3R',
    });
    expect(outcome.status).toBe('answered');
    if (outcome.status !== 'answered') return;
    expect(outcome.body).toBe(`${MARKHAM_FIRST} Still want me watching?`);
  });

  it("answers adult-learn / I wanna learn swimming with the kids-only door, never I don't do that", async () => {
    const exploding = {
      messages: {
        create: () => {
          throw new Error('the model must not have been called');
        },
      },
    } as never;
    const composer = createIntakeAnswerComposer(exploding);

    const first = await composer.compose({
      parentWords: 'I wanna learn swimming',
      pendingAsk: COLD_START_ASK,
      children: [],
    });
    expect(first.status).toBe('answered');
    if (first.status !== 'answered') return;
    expect(first.body).toBe(`${ADULT_LEARN_DOOR} ${COLD_START_ASK}`);
    expect(first.body).toContain("I'm a kids' rec helper, not adult lessons");
    expect(first.body).not.toContain("I don't do that");
    expect(first.body).not.toMatch(/\b(Sept|Sep|Aug|Nov|Dec)\b/);
    expect(first.body).not.toMatch(/\d{1,2}:\d{2}/);

    const mid = await composer.compose({
      ...INPUT,
      parentWords: 'adult lessons',
    });
    expect(mid.status).toBe('answered');
    if (mid.status !== 'answered') return;
    expect(mid.body).toContain(ADULT_LEARN_DOOR);
    expect(mid.body).not.toContain("I don't do that");
  });

  it('answers a rec/camp question that misses the city pins without a model', async () => {
    // VIL-326: "When does swim registration open near me?" is not Toronto /
    // Markham / YMCA, so the 544/548/555 pins miss. The old path invented a
    // clock (refused) or returned unavailable, and greet sent the ask alone.
    const exploding = {
      messages: {
        create: () => {
          throw new Error('the model must not have been required to invent a clock');
        },
      },
    } as never;
    const composer = createIntakeAnswerComposer(exploding);
    const outcome = await composer.compose({
      parentWords: 'When does swim registration open near me?',
      pendingAsk: COLD_START_ASK,
      children: [],
    });
    expect(outcome.status).toBe('answered');
    if (outcome.status !== 'answered') return;
    expect(outcome.body).toContain(NOT_POSTED_YET);
    expect(outcome.body).toContain(OFFICIAL_PAGE_RETURN_ASK);
    expect(outcome.body).not.toBe(COLD_START_ASK);
    expect(outcome.body).not.toContain(COLD_START_ASK);
    expect(outcome.body).not.toContain("I don't do that");
    expect(outcome.body).not.toMatch(/https?:\/\//);
    expect(outcome.body).not.toMatch(/I'm an AI/i);
  });

  it('answers from official notes when search grounds a date, still no invented clock', async () => {
    const notes = 'Hamilton swim registration opens September 8 at 7:00 a.m.';
    const client = {
      messages: {
        create: async (req: { tools?: Array<{ type?: string }> }) => {
          if (req.tools?.[0]?.type === 'web_search_20250305') {
            return {
              content: [
                { type: 'text', text: notes },
                {
                  type: 'web_search_tool_result',
                  tool_use_id: 'srvtu_1',
                  content: [
                    {
                      type: 'web_search_result',
                      url: 'https://www.hamilton.ca/recreation',
                      title: 'Swim registration',
                    },
                  ],
                },
              ],
            };
          }
          throw new Error('compose must not run when notes already ground a date');
        },
      },
    } as never;
    const composer = createIntakeAnswerComposer(client);
    const outcome = await composer.compose({
      parentWords: 'Hamilton swim registration dates?',
      pendingAsk: COLD_START_ASK,
      children: [],
    });
    expect(outcome.status).toBe('answered');
    if (outcome.status !== 'answered') return;
    expect(outcome.body).toContain('September 8');
    expect(outcome.body).toContain('7:00');
    expect(outcome.body).toContain(OFFICIAL_PAGE_RETURN_ASK);
    expect(outcome.body).not.toContain(COLD_START_ASK);
    expect(outcome.body).not.toContain("I don't do that");
    expect(outcome.body).not.toMatch(/https?:\/\//);
  });

  it('answers a raising-kids question without a model inventing a method', async () => {
    // VIL-327: a nap question used to hit intake-answer with tools: [] and
    // either invent a method or fall through to the pending ask alone.
    const exploding = {
      messages: {
        create: () => {
          throw new Error('the model must not invent a nap method from memory');
        },
      },
    } as never;
    const composer = createIntakeAnswerComposer(exploding);
    const outcome = await composer.compose({
      parentWords: 'How do I get him to nap?',
      pendingAsk: COLD_START_ASK,
      children: [],
    });
    expect(outcome.status).toBe('answered');
    if (outcome.status !== 'answered') return;
    expect(outcome.body).toContain(NO_CURRENT_SOURCE_YET);
    expect(outcome.body).toContain(OFFICIAL_PAGE_RETURN_ASK);
    expect(outcome.body).not.toBe(COLD_START_ASK);
    expect(outcome.body).not.toContain(COLD_START_ASK);
    expect(outcome.body).not.toContain("I don't do that");
    expect(outcome.body).not.toMatch(/https?:\/\//);
    expect(outcome.body).not.toMatch(/I'?m a therapist/i);
  });

  it('answers a leftover factual question from search notes, never from memory', async () => {
    const notes = 'The official White House page names the current United States president.';
    const client = {
      messages: {
        create: async (req: { tools?: Array<{ type?: string }> }) => {
          if (req.tools?.[0]?.type === 'web_search_20250305') {
            return {
              content: [
                { type: 'text', text: notes },
                {
                  type: 'web_search_tool_result',
                  tool_use_id: 'srvtu_2',
                  content: [
                    {
                      type: 'web_search_result',
                      url: 'https://www.whitehouse.gov',
                      title: 'The White House',
                    },
                  ],
                },
              ],
            };
          }
          throw new Error('compose must not invent a leftover fact from memory');
        },
      },
    } as never;
    const composer = createIntakeAnswerComposer(client);
    const outcome = await composer.compose({
      parentWords: 'Who is the US president?',
      pendingAsk: COLD_START_ASK,
      children: [],
    });
    expect(outcome.status).toBe('answered');
    if (outcome.status !== 'answered') return;
    expect(outcome.body).toContain('United States president');
    expect(outcome.body).toContain(OFFICIAL_PAGE_RETURN_ASK);
    expect(outcome.body).not.toContain(COLD_START_ASK);
    expect(outcome.body).not.toContain("I don't do that");
    expect(outcome.body).not.toMatch(/https?:\/\//);
  });

  it('answers a non-crisis therapist-find from live lookup or no current source', async () => {
    const exploding = {
      messages: {
        create: () => {
          throw new Error('the model must not invent a hotline or a clinic');
        },
      },
    } as never;
    const composer = createIntakeAnswerComposer(exploding);
    const outcome = await composer.compose({
      parentWords: 'I need a therapist',
      pendingAsk: COLD_START_ASK,
      children: [],
    });
    expect(outcome.status).toBe('answered');
    if (outcome.status !== 'answered') return;
    expect(outcome.body).toContain(NO_CURRENT_SOURCE_YET);
    expect(outcome.body).toContain(OFFICIAL_PAGE_RETURN_ASK);
    expect(outcome.body).not.toContain(COLD_START_ASK);
    expect(outcome.body).not.toMatch(/I'?m a therapist/i);
    expect(outcome.body).not.toMatch(/https?:\/\//);
  });

  it('answers a cheer-up with reviewed warmth, not a clinical method', async () => {
    const exploding = {
      messages: {
        create: () => {
          throw new Error('cheer-up is reviewed copy, not a model');
        },
      },
    } as never;
    const composer = createIntakeAnswerComposer(exploding);
    const outcome = await composer.compose({
      parentWords: 'cheer me up',
      pendingAsk: COLD_START_ASK,
      children: [],
    });
    expect(outcome.status).toBe('answered');
    if (outcome.status !== 'answered') return;
    expect(outcome.body).toContain(CHEER_UP_REPLY);
    expect(outcome.body).toContain(OFFICIAL_PAGE_RETURN_ASK);
    expect(outcome.body).not.toMatch(/diagnos|treatment plan|I'?m a therapist/i);
    expect(outcome.body).not.toContain(COLD_START_ASK);
    expect(outcome.body).not.toContain(AFTER_PROVISION_RETURN_ASK);
  });

  it('answers a crisis inbound with the reviewed 988 line and no return ask', async () => {
    const exploding = {
      messages: {
        create: () => {
          throw new Error('a crisis must not reach a model');
        },
      },
    } as never;
    const composer = createIntakeAnswerComposer(exploding);
    expect(
      await composer.compose({
        parentWords: 'I want to die',
        pendingAsk: COLD_START_ASK,
        children: [],
      }),
    ).toEqual({ status: 'mental_crisis' });
    expect(MENTAL_CRISIS_REPLY).toBe(
      "If you're in crisis, call 988 any time. If it's an emergency, call 911.",
    );
    expect(MENTAL_CRISIS_REPLY).toContain('988');
    expect(MENTAL_CRISIS_REPLY).toContain('911');
    expect(MENTAL_CRISIS_REPLY).not.toContain('?');
    expect(MENTAL_CRISIS_REPLY).not.toContain('811');
    expect(MENTAL_CRISIS_REPLY).not.toContain('not something I should advise on');
    expect(SAFETY_REPLY).toContain('811');
    expect(SAFETY_REPLY).not.toContain('988');
    expect(MENTAL_CRISIS_REPLY).not.toBe(EMERGENCY_REPLY);
    expect(MENTAL_CRISIS_REPLY).not.toBe('Call 911 now.');
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
