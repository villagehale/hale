import { describe, expect, it } from 'vitest';
import { fakeSpokenLineBody } from '~/lib/channel/voice/fakes';
import { judgeSpokenLine, spokenFactSlots } from '~/lib/channel/voice/spoken-line';
import {
  PROACTIVE_VOICE_SKILL,
  type ProactiveLineRequest,
  TRAVEL_OPENING_MAX_CHARS,
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

  it('hands the travel opening the city, the day phrase and the kids, asks nothing, and bans a find of its own', () => {
    const named = proactiveLineInput(TRAVEL, 'en');
    expect(named.questions).toBe(0);
    expect(named.maxChars).toBe(TRAVEL_OPENING_MAX_CHARS);
    expect(named.facts).toEqual({
      city: 'New York',
      days: 'the 12th to the 15th',
      kids: ['Mia', 'Leo'],
    });
    expect(named.mustMention).toEqual(['New York', 'the 12th to the 15th', 'Mia', 'Leo']);
    expect(named.forbidden?.map((rule) => rule.name)).toEqual(['booking_claim', 'travel_find']);

    // No under-13 to name: the model is told so (null), never handed an empty list to
    // fill, and the group register reaches it when the brief lands in the household.
    const nobody = proactiveLineInput({ ...TRAVEL_REQUEST, kids: [] }, 'en', 'vous');
    expect(nobody.facts).toEqual({ city: 'New York', days: 'the 12th to the 15th', kids: null });
    expect(nobody.mustMention).toEqual(['New York', 'the 12th to the 15th']);
    expect(nobody.address).toBe('vous');
  });
});

const TRAVEL_REQUEST = {
  kind: 'travel_brief' as const,
  city: 'New York',
  days: 'the 12th to the 15th',
  kids: ['Mia', 'Leo'],
};
const TRAVEL: ProactiveLineRequest = TRAVEL_REQUEST;

describe('the judge on a travel opening', () => {
  it('accepts the fake composer and an opening that leads into the finds', () => {
    const input = proactiveLineInput(TRAVEL, 'en');
    expect(judgeSpokenLine(fakeSpokenLineBody(input), input)).toEqual({ ok: true });
    expect(
      judgeSpokenLine(
        "You're in New York the 12th to the 15th. A couple of things on for Mia and Leo:",
        input,
      ),
    ).toEqual({ ok: true });
  });

  it('refuses a question, a dropped kid, a find of its own, and a time the trip never gave', () => {
    const input = proactiveLineInput(TRAVEL, 'en');
    expect(
      judgeSpokenLine('New York the 12th to the 15th with Mia and Leo. Want some ideas?', input),
    ).toEqual({ ok: false, reason: 'question' });
    expect(
      judgeSpokenLine(
        "You're in New York the 12th to the 15th. A couple of things for Mia:",
        input,
      ),
    ).toEqual({ ok: false, reason: 'missing' });
    expect(
      judgeSpokenLine(
        "You're in New York the 12th to the 15th. The museum is great for Mia and Leo:",
        input,
      ),
    ).toEqual({ ok: false, reason: 'forbidden:travel_find' });
    expect(
      judgeSpokenLine(
        "You're in New York the 12th to the 15th. Things on for Mia and Leo from 10:00:",
        input,
      ),
    ).toEqual({ ok: false, reason: 'invented' });
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
