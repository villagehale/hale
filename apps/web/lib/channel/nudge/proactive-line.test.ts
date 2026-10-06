import { describe, expect, it } from 'vitest';
import { fakeSpokenLineBody } from '~/lib/channel/voice/fakes';
import { judgeSpokenLine, spokenFactSlots } from '~/lib/channel/voice/spoken-line';
import {
  PROACTIVE_VOICE_SKILL,
  type ProactiveLineRequest,
  TRAVEL_BRIEF_MAX_CHARS,
  proactiveLineInput,
} from './proactive-line';

/**
 * Per ask: what the model is handed, what it must carry, and which red lines code
 * holds. The model's actual words are proved by the cached eval
 * (apps/worker/evals/run-proactive-voice-eval.mjs, rule #8).
 */

const EVERY_ASK: ProactiveLineRequest[] = [
  { kind: 'empty_saturday', kid: 'Maya' },
  { kind: 'weekday_care', ask: { prompt: 'after_school_named', childId: 'c1', name: 'Maya' } },
  { kind: 'weekday_care', ask: { prompt: 'after_school_household' } },
  {
    kind: 'weekday_care',
    ask: { prompt: 'verified_break', eventKey: 'pa-day-2026-10-09', label: 'PA day' },
  },
  { kind: 'weekday_care', ask: { prompt: 'weekend_fallback' } },
];

describe('proactiveLineInput', () => {
  it('is one question, tu, on the proactive-voice skill, for every ask', () => {
    for (const request of EVERY_ASK) {
      for (const language of ['en', 'fr'] as const) {
        const input = proactiveLineInput(request, language);
        expect(input.skill).toBe(PROACTIVE_VOICE_SKILL);
        expect(input.kind).toBe(request.kind);
        expect(input.language).toBe(language);
        expect(input.address).toBe('tu');
        expect(input.questions).toBe(1);
        expect(input.maxChars).toBe(200);
        expect(input.forbidden?.map((rule) => rule.name)).toEqual(
          request.kind === 'weekday_care' && request.ask.prompt === 'weekend_fallback'
            ? ['booking_claim', 'ca_tinteresse_que']
            : ['booking_claim'],
        );
      }
    }
  });

  it('speaks vous when the ask lands in the household group', () => {
    const input = proactiveLineInput(EVERY_ASK[4] as ProactiveLineRequest, 'fr', 'vous');
    expect(input.address).toBe('vous');
  });

  it('hands the empty-Saturday ask the kid and the day in the right language, and nothing else', () => {
    const en = proactiveLineInput({ kind: 'empty_saturday', kid: 'Maya' }, 'en');
    expect(en.facts).toEqual({ kid: 'Maya', day: 'Saturday' });
    expect(en.mustMention).toEqual(['Maya', 'Saturday']);
    const fr = proactiveLineInput({ kind: 'empty_saturday', kid: 'Maya' }, 'fr');
    expect(fr.facts).toEqual({ kid: 'Maya', day: 'samedi' });
    expect(fr.mustMention).toEqual(['Maya', 'samedi']);
  });

  it('names the one school-age child, and nobody on the household and fallback prompts', () => {
    const named = proactiveLineInput(EVERY_ASK[1] as ProactiveLineRequest, 'en');
    expect(named.facts).toEqual({ prompt: 'after_school', kid: 'Maya' });
    expect(named.mustMention).toEqual(['Maya']);
    // The child id is internal and never reaches the model.
    expect(JSON.stringify(named)).not.toContain('c1');

    const household = proactiveLineInput(EVERY_ASK[2] as ProactiveLineRequest, 'en');
    expect(household.facts).toEqual({ prompt: 'after_school', kid: null });
    expect(household.mustMention).toBeUndefined();

    const fallback = proactiveLineInput(EVERY_ASK[4] as ProactiveLineRequest, 'en');
    expect(fallback.facts).toEqual({ prompt: 'weekend_fallback', optionsSent: false });
    expect(spokenFactSlots(fallback)).toEqual(['weekend_fallback']);
    const sent = proactiveLineInput(
      { kind: 'weekday_care', ask: { prompt: 'weekend_fallback', optionsSent: true } },
      'en',
    );
    expect(sent.facts).toEqual({ prompt: 'weekend_fallback', optionsSent: true });
    expect(
      judgeSpokenLine(
        "Rien de bon ce week-end. Ça t'intéresse que je cherche en semaine?",
        fallback,
      ),
    ).toEqual({ ok: false, reason: 'forbidden:ca_tinteresse_que' });
    expect(
      judgeSpokenLine("Rien de bon ce week-end. Je cherche en semaine, ça t'intéresse?", fallback),
    ).toEqual({ ok: true });
  });

  it('carries a verified break label word for word and not its event key', () => {
    const input = proactiveLineInput(EVERY_ASK[3] as ProactiveLineRequest, 'en');
    expect(input.facts).toEqual({ prompt: 'break', label: 'PA day' });
    expect(input.mustMention).toEqual(['PA day']);
    expect(JSON.stringify(input)).not.toContain('2026-10-09');
  });

  it("hands the travel brief the city, the day phrase, the kids and the venues' own words, and asks nothing", () => {
    const named = proactiveLineInput(TRAVEL, 'en');
    expect(named.questions).toBe(0);
    expect(named.maxChars).toBe(TRAVEL_BRIEF_MAX_CHARS);
    expect(named.facts).toEqual({
      city: 'New York',
      days: 'the 12th to the 15th',
      kids: ['Mia', 'Leo'],
      picks: [MUSEUM, ZOO],
      source: 'the venues own pages',
    });
    // Every published detail is carried as published; a null price is not a slot.
    expect(named.mustMention).toEqual([
      'New York',
      'the 12th to the 15th',
      'Mia',
      'Leo',
      'American Museum of Natural History',
      'open daily 10am-5:30pm',
      'USD 28 adults / 16 kids',
      'Central Park Zoo',
      '10am-5pm',
    ]);
    expect(named.forbidden?.map((rule) => rule.name)).toEqual([
      'booking_claim',
      'been_there_claim',
      'straight_from',
    ]);

    // No under-13 to name: the model is told so (null), never handed an empty list to
    // fill, and the group register reaches it when the brief lands in the household.
    const nobody = proactiveLineInput({ ...TRAVEL_REQUEST, kids: [] }, 'en', 'vous');
    expect(nobody.facts).toMatchObject({ city: 'New York', kids: null });
    expect(nobody.mustMention?.slice(0, 2)).toEqual(['New York', 'the 12th to the 15th']);
    expect(nobody.address).toBe('vous');
  });
});

const MUSEUM = {
  name: 'American Museum of Natural History',
  when: 'open daily 10am-5:30pm',
  price: 'USD 28 adults / 16 kids',
};
const ZOO = { name: 'Central Park Zoo', when: '10am-5pm', price: null };

const TRAVEL_REQUEST = {
  kind: 'travel_brief' as const,
  city: 'New York',
  days: 'the 12th to the 15th',
  kids: ['Mia', 'Leo'],
  picks: [MUSEUM, ZOO],
};
const TRAVEL: ProactiveLineRequest = TRAVEL_REQUEST;

const GOOD_BRIEF =
  "You're in New York the 12th to the 15th - a couple of things on for Mia and Leo. American Museum of Natural History, open daily 10am-5:30pm, USD 28 adults / 16 kids. Central Park Zoo, 10am-5pm. That's off their own pages, not from anyone who's been.";

describe('the judge on a travel brief', () => {
  it("accepts the fake composer and a whole brief in the venues' words", () => {
    const input = proactiveLineInput(TRAVEL, 'en');
    expect(judgeSpokenLine(fakeSpokenLineBody(input), input)).toEqual({ ok: true });
    expect(judgeSpokenLine(GOOD_BRIEF, input)).toEqual({ ok: true });
  });

  it('refuses a question, a dropped kid, a dropped price, a been-there claim, and a time no page gave', () => {
    const input = proactiveLineInput(TRAVEL, 'en');
    expect(judgeSpokenLine(`${GOOD_BRIEF} Want more?`, input)).toEqual({
      ok: false,
      reason: 'question',
    });
    expect(judgeSpokenLine(GOOD_BRIEF.replace(' and Leo', ''), input)).toEqual({
      ok: false,
      reason: 'missing',
    });
    expect(judgeSpokenLine(GOOD_BRIEF.replace(', USD 28 adults / 16 kids', ''), input)).toEqual({
      ok: false,
      reason: 'missing',
    });
    expect(
      judgeSpokenLine(
        GOOD_BRIEF.replace(
          "That's off their own pages, not from anyone who's been.",
          'Parents love the zoo.',
        ),
        input,
      ),
    ).toEqual({ ok: false, reason: 'forbidden:been_there_claim' });
    expect(
      judgeSpokenLine(
        GOOD_BRIEF.replace(
          "That's off their own pages, not from anyone who's been.",
          'Both details are straight from the venues own pages.',
        ),
        input,
      ),
    ).toEqual({ ok: false, reason: 'forbidden:straight_from' });
    expect(
      judgeSpokenLine(
        GOOD_BRIEF.replace(
          "That's off their own pages, not from anyone who's been.",
          "Details straight from the venue's own page.",
        ),
        input,
      ),
    ).toEqual({ ok: false, reason: 'forbidden:straight_from' });
    expect(
      judgeSpokenLine(
        GOOD_BRIEF.replace(
          "That's off their own pages, not from anyone who's been.",
          "Details straight from the venues' own pages.",
        ),
        input,
      ),
    ).toEqual({ ok: false, reason: 'forbidden:straight_from' });
    expect(
      judgeSpokenLine(
        GOOD_BRIEF.replace(
          'Central Park Zoo, 10am-5pm',
          'Central Park Zoo, 10am-5pm, last entry 16:30',
        ),
        input,
      ),
    ).toEqual({
      ok: false,
      reason: 'invented',
    });
  });
});

describe('the judge on a proactive ask', () => {
  it('accepts the fake composer on every ask in both languages', () => {
    for (const request of EVERY_ASK) {
      for (const language of ['en', 'fr'] as const) {
        const input = proactiveLineInput(request, language);
        expect(judgeSpokenLine(fakeSpokenLineBody(input), input)).toEqual({ ok: true });
      }
    }
  });

  it('refuses a line that drops the kid, asks twice, or invents a day or a time', () => {
    const input = proactiveLineInput({ kind: 'empty_saturday', kid: 'Maya' }, 'en');
    expect(judgeSpokenLine('Saturday looks open. Want one nearby find?', input)).toEqual({
      ok: false,
      reason: 'missing',
    });
    expect(judgeSpokenLine('Saturday looks open for Maya. Want a find? Or Sunday?', input)).toEqual(
      { ok: false, reason: 'question' },
    );
    expect(
      judgeSpokenLine('Saturday looks open for Maya. Want one nearby find at 10:00?', input),
    ).toEqual({ ok: false, reason: 'invented' });
  });

  it('refuses a keyword ask, a booking claim, and vous in a 1:1 French ask', () => {
    const en = proactiveLineInput(EVERY_ASK[4] as ProactiveLineRequest, 'en');
    expect(judgeSpokenLine('Those were weekend options. Reply yes for weekdays too?', en)).toEqual({
      ok: false,
      reason: 'banned',
    });
    expect(
      judgeSpokenLine("Those were weekend options. I've booked a weekday one, want it?", en),
    ).toEqual({ ok: false, reason: 'forbidden:booking_claim' });
    const fr = proactiveLineInput(EVERY_ASK[4] as ProactiveLineRequest, 'fr');
    expect(
      judgeSpokenLine(
        'Ça, c’était pour la fin de semaine. Vous voulez une idée pour la semaine ?',
        fr,
      ),
    ).toEqual({ ok: false, reason: 'french' });
    expect(
      judgeSpokenLine(
        'Ça, c’était pour la fin de semaine. Tu veux une idée pour la semaine aussi ?',
        fr,
      ),
    ).toEqual({ ok: true });
  });
});
