import { afterEach, describe, expect, it, vi } from 'vitest';
import { cityRecLine } from '~/lib/channel/rec-morning';
import type { CityOpeningFacts } from '~/lib/registration/city/context';
import { adultLearnDoor } from './adult-learn';
import {
  type IntakeAnswerInput,
  createIntakeAnswerComposer,
  intakeAnswerContext,
  readPair,
  refusals,
} from './answer';

/** #868: the fixed ask is gone; any pending-ask text is a fixture. */
const COLD_START_ASK = 'cold start ask (test fixture)';
/** #868: the fixed ask is gone; any pending-ask text is a fixture. */
const WATCH_OFFER_ASK = 'watch offer ask (test fixture)';

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

/** No own-city reading for the parent's town (VIL-684): the rec-morning lane may answer. */
const noOwnTown = async () => null;

/** A town with an opening on file, as postalOwnCityOpening returns it. */
const MARKHAM_OPENING: CityOpeningFacts = {
  town: 'Markham',
  programs: 'Winter 2027',
  opensFor: 'Dec 1, 6:30 a.m.',
  opensAt: new Date('2026-12-01T11:30:00Z'),
  statedDates: ['2026-12-01'],
  generalOpens: null,
  line: 'Markham Winter 2027 registration opens Dec 1, 6:30 a.m.',
  phrases: ['Dec 1, 6:30 a.m.'],
};

const LONG_ANSWER = [
  ...Array(6).fill('Most kids get a vision check at their regular visit, and it is free.'),
  'Do it.',
].join(' ');

/** The composer reads the clock itself, and a city's rec line is derived against it,
 * so the rec-morning specs below pin the clock rather than the sentence. */
const REC_MORNING_NOW = new Date('2026-09-17T14:00:00.000Z');

function atRecMorningNow(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(REC_MORNING_NOW);
}

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

  it('refuses an invented time and sends an accented reply', () => {
    expect(problems('Clinics near you open at 9:30 most days.')).toContain('invented_fact');
    expect(problems('OHIP covers it — free every year.')).not.toContain('not_gsm7');
  });

  it('never refuses an answer for its length (no character caps)', () => {
    expect(LONG_ANSWER).toHaveLength(420);
    expect(problems(LONG_ANSWER, RETURN)).toEqual([]);
  });

  it('still runs every other gate on a long answer', () => {
    expect(problems(`${LONG_ANSWER} See https:// for more.`, RETURN)).toEqual(['carries_link']);
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

  it('sends a long answer rather than swapping it for the script reply', () => {
    const outcome = readPair({ answer: LONG_ANSWER, returnLine: RETURN }, INPUT);
    expect(outcome).toEqual({ status: 'answered', body: `${LONG_ANSWER} ${RETURN}` });
  });

  it('reads an empty answer as "they did not ask anything" rather than a refusal', () => {
    expect(readPair({ answer: '   ', returnLine: RETURN }, INPUT)).toEqual({
      status: 'nothing_to_answer',
    });
  });

  it('names WHY a body was refused rather than sending it', () => {
    expect(readPair({ answer: "I'll watch that for you.", returnLine: RETURN }, INPUT)).toEqual({
      status: 'unavailable',
      reason: 'unusable',
    });
  });
});

describe('intake answer · the emergency tripwire', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers a Toronto swim clock question with reviewed copy, no model', async () => {
    const exploding = {
      messages: {
        create: () => {
          throw new Error('the model must not have been called');
        },
      },
    } as never;
    const composer = createIntakeAnswerComposer(exploding, noOwnTown);
    atRecMorningNow();
    const outcome = await composer.compose({
      ...INPUT,
      parentWords: 'When does Toronto swim registration open?',
      // VIL-591: rec-morning answers only a family whose collected place is in the GTA.
      postalCode: 'M5V',
    });
    expect(outcome.status).toBe('answered');
    if (outcome.status !== 'answered') return;
    expect(outcome.body.startsWith(cityRecLine('toronto', REC_MORNING_NOW) as string)).toBe(true);
    expect(outcome.body).toContain('non-residents Friday Sep 25 at 7 a.m.');
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
    const composer = createIntakeAnswerComposer(exploding, noOwnTown);
    atRecMorningNow();
    const outcome = await composer.compose({
      ...INPUT,
      parentWords: 'Markham fall rec dates?',
      // VIL-591: rec-morning answers only a family whose collected place is in the GTA.
      postalCode: 'M5V',
    });
    expect(outcome.status).toBe('answered');
    if (outcome.status !== 'answered') return;
    expect(outcome.body.startsWith(cityRecLine('markham', REC_MORNING_NOW) as string)).toBe(true);
    expect(outcome.body).toContain('Markham');
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
    const composer = createIntakeAnswerComposer(exploding, noOwnTown);
    atRecMorningNow();
    const outcome = await composer.compose({
      ...INPUT,
      parentWords: 'when is fall rec?',
      postalCode: 'L3R',
    });
    expect(outcome.status).toBe('answered');
    if (outcome.status !== 'answered') return;
    expect(outcome.body.startsWith(cityRecLine('markham', REC_MORNING_NOW) as string)).toBe(true);
  });

  it("leaves a town's date question to the read once that town's own page has a date", async () => {
    const exploding = {
      messages: {
        create: () => {
          throw new Error('the intake model was asked');
        },
      },
    } as never;
    const asked: string[] = [];
    const markhamRead = async (postal: string) => {
      asked.push(postal);
      return MARKHAM_OPENING;
    };
    atRecMorningNow();
    const outcome = await createIntakeAnswerComposer(exploding, markhamRead).compose({
      ...INPUT,
      parentWords: 'when does winter rec registration open?',
      postalCode: 'L3R',
    });
    // Not the hand dataset's "not posted yet": the turn goes on to the grounded answer
    // (here a model that throws, so nothing at all).
    expect(outcome).toMatchObject({ status: 'unavailable' });
    expect(asked).toEqual(['L3R']);
    // Positive control: with no reading for the town, the rec-morning lane answers it.
    const control = await createIntakeAnswerComposer(exploding, noOwnTown).compose({
      ...INPUT,
      parentWords: 'when does winter rec registration open?',
      postalCode: 'L3R',
    });
    expect(control.status).toBe('answered');
  });

  it('asks about the own town only for a question about that town', async () => {
    const exploding = {
      messages: {
        create: () => {
          throw new Error('the model must not have been called');
        },
      },
    } as never;
    const asked: string[] = [];
    atRecMorningNow();
    const outcome = await createIntakeAnswerComposer(exploding, async (postal) => {
      asked.push(postal);
      return MARKHAM_OPENING;
    }).compose({
      ...INPUT,
      parentWords: 'When does Toronto swim registration open?',
      postalCode: 'L3R',
    });
    expect(outcome.status).toBe('answered');
    expect(asked).toEqual([]);
  });

  it("answers adult-learn / I wanna learn swimming with the kids-only door, never I don't do that", async () => {
    const exploding = {
      messages: {
        create: () => {
          throw new Error('the model must not have been called');
        },
      },
    } as never;
    const composer = createIntakeAnswerComposer(exploding, noOwnTown);

    const first = await composer.compose({
      parentWords: 'I wanna learn swimming',
      pendingAsk: COLD_START_ASK,
      children: [],
    });
    expect(first.status).toBe('answered');
    if (first.status !== 'answered') return;
    expect(first.body.startsWith(adultLearnDoor(null))).toBe(true);
    expect(first.body).not.toContain(COLD_START_ASK);
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
    expect(mid.body).toContain(adultLearnDoor(null));
    expect(mid.body).not.toContain("I don't do that");
  });

  describe('the path is the model read, never the words', () => {
    type Read = { askKind: string; answer?: string; returnLine?: string };
    type Search = { notes: string; url: string };

    /**
     * A client at the wire, not a model stand-in for behaviour: it hands back the read
     * the test stipulates and, when asked to search, the stipulated notes. Whether the
     * model READS a French rec question as program_dates is the eval's job (en/fr/zh/es,
     * run-intake-answer-eval.mjs); this owns what the composer does with each read.
     */
    function wire(read: Read, search: Search | null) {
      type Request = { tools?: Array<{ type?: string; name?: string }>; messages?: unknown };
      const requests: Request[] = [];
      const client = {
        messages: {
          create: async (req: Request) => {
            requests.push(req);
            if (req.tools?.[0]?.type === 'web_search_20250305') {
              if (search === null) throw new Error('this read must not search');
              return {
                content: [
                  { type: 'text', text: search.notes },
                  {
                    type: 'web_search_tool_result',
                    tool_use_id: 'srvtu_1',
                    content: [{ type: 'web_search_result', url: search.url, title: 'source' }],
                  },
                ],
              };
            }
            return {
              stop_reason: 'end_turn',
              usage: { input_tokens: 0, output_tokens: 0 },
              content: [
                { type: 'text', text: JSON.stringify({ answer: '', returnLine: '', ...read }) },
              ],
            };
          },
        },
      } as never;
      const searches = () =>
        requests.filter((req) => req.tools?.[0]?.type === 'web_search_20250305');
      const searched = () => searches().length;
      const searchedWords = () => JSON.stringify(searches().map((req) => req.messages));
      return { client, searched, searchedWords };
    }

    const ASK = { pendingAsk: COLD_START_ASK, children: [] };

    it('a program_dates read searches official pages, in any language', async () => {
      const { client, searched } = wire(
        { askKind: 'program_dates' },
        {
          notes: 'Swim registration opens September 8 at 7:00 a.m.',
          url: 'https://example.org/rec',
        },
      );
      const outcome = await createIntakeAnswerComposer(client, noOwnTown).compose({
        ...ASK,
        parentWords: 'Quand ouvrent les inscriptions à la natation?',
      });
      expect(searched()).toBe(1);
      expect(outcome.status).toBe('answered');
      if (outcome.status !== 'answered') return;
      expect(outcome.body).toContain('September 8');
      expect(outcome.body).not.toMatch(/https?:\/\//);
    });

    it('a program_dates read with no posted date owes the not-posted line', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const { client } = wire(
        { askKind: 'program_dates' },
        { notes: 'The city has not announced winter dates.', url: 'https://example.org/rec' },
      );
      const outcome = await createIntakeAnswerComposer(client, noOwnTown).compose({
        ...ASK,
        parentWords: '冬令营什么时候开始报名？',
      });
      expect(outcome).toEqual({ status: 'unavailable', reason: 'not_posted' });
    });

    it('a current_source read searches a current source and restates it', async () => {
      const { client, searched } = wire(
        { askKind: 'current_source' },
        {
          notes: 'Most toddlers drop to one nap between 15 and 18 months, the society says.',
          url: 'https://example.org/sleep',
        },
      );
      const outcome = await createIntakeAnswerComposer(client, noOwnTown).compose({
        ...ASK,
        parentWords: '¿Cuándo deja la segunda siesta?',
      });
      expect(searched()).toBe(1);
      expect(outcome.status).toBe('answered');
      if (outcome.status !== 'answered') return;
      expect(outcome.body).toContain('one nap');
    });

    it('a current_source read search cannot ground owes the no-source line', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const { client } = wire({ askKind: 'current_source' }, { notes: '', url: 'https://x.org' });
      const outcome = await createIntakeAnswerComposer(client, noOwnTown).compose({
        ...ASK,
        parentWords: '¿Cómo hago para que duerma la siesta?',
      });
      expect(outcome).toEqual({ status: 'unavailable', reason: 'no_source' });
    });

    describe('a child named in any language never reaches the search', () => {
      const NOTES = {
        notes: 'Registration opens September 8 at 7:00 a.m., the city page says.',
        url: 'https://example.org/rec',
      };
      const CASES = [
        { askKind: 'program_dates', name: '小明', words: '小明什么时候可以报名游泳课？' },
        {
          askKind: 'program_dates',
          name: 'Zoé',
          words: 'Quand ouvrent les inscriptions au camp pour Zoé?',
        },
        {
          askKind: 'current_source',
          name: 'José',
          words: '¿Cuándo deja la siesta José? Tiene dos años.',
        },
        // Positive control: the English name the old \b scrub already caught.
        { askKind: 'program_dates', name: 'Ava', words: 'When does swim open for Ava?' },
      ];

      for (const { askKind, name, words } of CASES) {
        it(`${askKind} for ${name}: searched, without the name`, async () => {
          vi.spyOn(console, 'error').mockImplementation(() => {});
          const { client, searched, searchedWords } = wire({ askKind }, NOTES);
          await createIntakeAnswerComposer(client, noOwnTown).compose({
            pendingAsk: COLD_START_ASK,
            children: [{ name, ageMonths: 48, agePrecision: 'years' }],
            parentWords: words,
          });
          expect(searched()).toBe(1);
          expect(searchedWords().toLowerCase()).not.toContain(name.toLowerCase());
        });
      }

      it('a name the scrub cannot remove stops the search, and owes the line', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const { client, searched } = wire({ askKind: 'program_dates' }, NOTES);
        const outcome = await createIntakeAnswerComposer(client, noOwnTown).compose({
          pendingAsk: COLD_START_ASK,
          children: [{ name: 'Zoé', ageMonths: 48, agePrecision: 'years' }],
          parentWords: 'Quand ouvrent les inscriptions au camp pour Zoe?',
        });
        expect(searched()).toBe(0);
        expect(outcome).toEqual({ status: 'unavailable', reason: 'not_posted' });
        expect(error).toHaveBeenCalledWith(
          { reason: 'names_a_child' },
          'intake answer: official page not grounded',
        );
      });
    });

    describe('the health-line tripwire reads every outcome, not only answer_here', () => {
      const SICK = 'wait my daughter has a 40 fever and she is barely waking up';
      const DATES = { notes: 'Swim registration opens September 8.', url: 'https://example.org' };
      const SLEEP = { notes: 'Most toddlers drop to one nap by 18 months.', url: 'https://x.org' };
      // Each case puts the 911 in a different place the composer can emit from: the
      // read's own fields, or the search notes a body is restated from.
      const CASES = [
        {
          askKind: 'program_dates',
          read: { answer: 'If this is an emergency, call 911.' },
          search: DATES,
          clean: DATES,
          withoutIt: 'answered',
        },
        {
          askKind: 'current_source',
          read: {},
          search: { ...SLEEP, notes: 'Call 911 if a child with a fever will not wake.' },
          clean: SLEEP,
          withoutIt: 'answered',
        },
        {
          askKind: 'cheer_up',
          read: { returnLine: 'Call 911 now if she will not wake?' },
          search: null,
          clean: null,
          withoutIt: 'unavailable',
        },
      ] as const;

      it('answer_here: substitutes for a pair the gates would refuse, too', async () => {
        // This parent must never get the script's signup question instead.
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const { client } = wire(
          {
            askKind: 'answer_here',
            answer: 'Call 911 if you are worried',
            returnLine: COLD_START_ASK,
          },
          null,
        );
        const outcome = await createIntakeAnswerComposer(client, noOwnTown).compose({
          ...ASK,
          parentWords: SICK,
        });
        expect(outcome).toEqual({ status: 'safety' });
      });

      for (const { askKind, read, search, clean, withoutIt } of CASES) {
        it(`${askKind}: a 911 the model or its search wrote sends the safety line`, async () => {
          vi.spyOn(console, 'error').mockImplementation(() => {});
          const { client } = wire({ askKind, ...read }, search);
          const outcome = await createIntakeAnswerComposer(client, noOwnTown).compose({
            ...ASK,
            parentWords: SICK,
          });
          expect(outcome).toEqual({ status: 'safety' });
        });

        it(`${askKind}: positive control, the same text with no 911 keeps its path`, async () => {
          vi.spyOn(console, 'error').mockImplementation(() => {});
          const { client } = wire({ askKind }, clean);
          const outcome = await createIntakeAnswerComposer(client, noOwnTown).compose({
            ...ASK,
            parentWords: SICK,
          });
          expect(outcome.status).toBe(withoutIt);
        });
      }
    });

    it('a current_source read naming a child the scrub cannot remove never searches', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { client, searched } = wire(
        { askKind: 'current_source' },
        { notes: 'Most toddlers drop to one nap by 18 months.', url: 'https://x.org' },
      );
      const outcome = await createIntakeAnswerComposer(client, noOwnTown).compose({
        pendingAsk: COLD_START_ASK,
        children: [{ name: 'Zoé', ageMonths: 30, agePrecision: 'years' }],
        parentWords: 'Comment aider Zoe à faire la sieste?',
      });
      expect(searched()).toBe(0);
      expect(outcome).toEqual({ status: 'unavailable', reason: 'no_source' });
      expect(error).toHaveBeenCalledWith(
        { reason: 'names_a_child' },
        'intake answer: current source not grounded',
      );
    });

    it('a cheer_up read owes the cheer-up line and searches nothing', async () => {
      const { client, searched } = wire({ askKind: 'cheer_up' }, null);
      const outcome = await createIntakeAnswerComposer(client, noOwnTown).compose({
        ...ASK,
        parentWords: '今天好累，给我打打气吧',
      });
      expect(searched()).toBe(0);
      expect(outcome).toEqual({ status: 'unavailable', reason: 'cheer_up' });
    });

    it('an answer_here read is answered in the model words, even full of rec words', async () => {
      // Positive control for the three above: the same composer, a different read, and
      // "swimming lessons" no longer sends it searching.
      const { client, searched } = wire(
        {
          askKind: 'answer_here',
          answer: "Booking isn't something I do.",
          returnLine: 'Want to send me their names and ages?',
        },
        null,
      );
      const outcome = await createIntakeAnswerComposer(client, noOwnTown).compose({
        ...ASK,
        parentWords: 'When does swim registration open? Can you book the swimming lessons?',
      });
      expect(searched()).toBe(0);
      expect(outcome).toEqual({
        status: 'answered',
        body: "Booking isn't something I do. Want to send me their names and ages?",
      });
    });
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
