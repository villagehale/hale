import { describe, expect, it } from 'vitest';
import { fakeSpokenLineBody } from '~/lib/channel/voice/fakes';
import { judgeSpokenLine, spokenFactSlots } from '~/lib/channel/voice/spoken-line';
import {
  CHECKIN_VOICE_SKILL,
  CHECK_IN_MAX_CHARS,
  CHECK_IN_MAX_NAME_CHARS,
  type CheckInLineRequest,
  checkInLineInput,
  nameableKids,
} from './line-input';

/**
 * Per kind: what the model is handed, what it must carry, and which red lines code
 * holds. The model's actual words are proved by the cached eval
 * (apps/worker/evals/run-checkin-voice-eval.mjs, rule #8).
 */

const EVERY_KIND: CheckInLineRequest[] = [
  { kind: 'first_ask', kids: ['Mia', 'Leo'] },
  { kind: 'later_ask', kids: ['Mia'] },
  { kind: 'how_it_went', activity: 'swim', kids: ['Mia'] },
  { kind: 'cadence_ack', cadence: 'weekly', trigger: 'parent_asked' },
  { kind: 'cadence_ack', cadence: 'weekly', trigger: 'quiet_evenings' },
  { kind: 'cadence_ack', cadence: 'off', trigger: 'parent_asked' },
  { kind: 'cadence_ack', cadence: 'daily', trigger: 'parent_asked' },
  { kind: 'noted_ack', kept: true },
  { kind: 'noted_ack', kept: false },
];

const ASKS = new Set(['first_ask', 'later_ask', 'how_it_went']);

describe('checkInLineInput', () => {
  it('is on the checkin-voice skill, inside two sentences, for every kind in both languages and registers', () => {
    for (const request of EVERY_KIND) {
      for (const language of ['en', 'fr'] as const) {
        for (const address of ['tu', 'vous'] as const) {
          const input = checkInLineInput(request, language, address, { parentName: 'Sam' });
          expect(input.skill).toBe(CHECKIN_VOICE_SKILL);
          expect(input.kind).toBe(request.kind);
          expect(input.language).toBe(language);
          expect(input.address).toBe(address);
          expect(input.maxChars).toBe(CHECK_IN_MAX_CHARS);
          expect(input.questions).toBe(ASKS.has(request.kind) ? 1 : 0);
        }
      }
    }
  });

  it('every kind forbids a keyword ask, scolding and a booking claim; the acks also forbid a "Noted" opener', () => {
    for (const request of EVERY_KIND) {
      const names = checkInLineInput(request, 'en').forbidden?.map((rule) => rule.name) ?? [];
      expect(names).toContain('keyword_ask');
      expect(names).toContain('scolding');
      expect(names).toContain('booking_claim');
      expect(names.includes('noted_opener')).toBe(!ASKS.has(request.kind));
    }
  });

  it('hands the evening asks the kids it may name, and makes it carry them', () => {
    const first = checkInLineInput({ kind: 'first_ask', kids: ['Mia', 'Leo'] }, 'en');
    expect(first.facts).toEqual({ kids: ['Mia', 'Leo'], parentName: null });
    expect(first.mustMention).toEqual(['Mia', 'Leo']);
    expect(first.parentWords).toBeNull();

    const later = checkInLineInput({ kind: 'later_ask', kids: [] }, 'fr');
    expect(later.facts).toEqual({ kids: [], parentName: null });
    expect(later.mustMention).toEqual([]);
    expect(spokenFactSlots(later)).toEqual([]);
  });

  it('hands the anchored ask the activity word for word and the kids as context only', () => {
    const input = checkInLineInput({ kind: 'how_it_went', activity: 'swim', kids: ['Mia'] }, 'en');
    expect(input.facts).toEqual({ activity: 'swim', kids: ['Mia'], parentName: null });
    expect(input.mustMention).toEqual(['swim']);
  });

  it('names the parent only in the household group, and never in a 1:1 thread', () => {
    const group = checkInLineInput({ kind: 'later_ask', kids: ['Mia'] }, 'fr', 'vous', {
      parentName: '  Sam ',
    });
    expect(group.facts).toEqual({ kids: ['Mia'], parentName: 'Sam' });
    expect(group.mustMention).toEqual(['Sam', 'Mia']);

    const unknown = checkInLineInput({ kind: 'later_ask', kids: ['Mia'] }, 'fr', 'vous', {
      parentName: '  ',
    });
    expect(unknown.facts.parentName).toBeNull();
    expect(unknown.mustMention).toEqual(['Mia']);

    const solo = checkInLineInput({ kind: 'later_ask', kids: ['Mia'] }, 'en', 'tu', {
      parentName: 'Sam',
    });
    expect(solo.facts.parentName).toBeNull();
    expect(solo.mustMention).toEqual(['Mia']);
  });

  it('tells the receipt what the cadence is and why, and carries the parent words it answers', () => {
    const asked = checkInLineInput(
      { kind: 'cadence_ack', cadence: 'off', trigger: 'parent_asked' },
      'en',
      'tu',
      { parentWords: 'no thanks' },
    );
    expect(asked.facts).toEqual({ cadence: 'off', trigger: 'parent_asked', parentName: null });
    expect(asked.parentWords).toBe('no thanks');
    expect(asked.mustMention).toEqual([]);

    const quiet = checkInLineInput(
      { kind: 'cadence_ack', cadence: 'weekly', trigger: 'quiet_evenings' },
      'en',
    );
    expect(quiet.facts).toEqual({ cadence: 'weekly', trigger: 'quiet_evenings', parentName: null });
    expect(quiet.parentWords).toBeNull();
  });

  it('tells the thank-you whether the note was kept and nothing about what it said', () => {
    const kept = checkInLineInput({ kind: 'noted_ack', kept: true }, 'en', 'tu', {
      parentWords: 'Long day, park then early bed.',
    });
    expect(kept.facts).toEqual({ kept: true, parentName: null });
    expect(kept.parentWords).toBe('Long day, park then early bed.');
    // A boolean is direction, not a fact slot: the fake body carries no words from the note.
    expect(fakeSpokenLineBody(kept)).toBe('noted_ack: .');

    const dropped = checkInLineInput({ kind: 'noted_ack', kept: false }, 'fr');
    expect(dropped.facts).toEqual({ kept: false, parentName: null });
  });
});

describe('nameableKids', () => {
  it('trims, drops blanks, and gives up the names past the budget rather than the brevity', () => {
    expect(nameableKids([' Mia ', '', 'Leo'])).toEqual(['Mia', 'Leo']);
    const long = ['Maximilian-Alexander', 'Anastasia-Marguerite', 'Bartholomew'];
    expect(long.join(', ').length).toBeGreaterThan(CHECK_IN_MAX_NAME_CHARS);
    expect(nameableKids(long)).toEqual([]);
    const input = checkInLineInput({ kind: 'first_ask', kids: long }, 'en');
    expect(input.facts.kids).toEqual([]);
    expect(input.mustMention).toEqual([]);
  });
});

describe('the judge on a check-in line', () => {
  it('accepts the fake composer on every kind, language and register', () => {
    for (const request of EVERY_KIND) {
      for (const language of ['en', 'fr'] as const) {
        for (const address of ['tu', 'vous'] as const) {
          const input = checkInLineInput(request, language, address, {
            parentName: 'Sam',
            parentWords: 'fine',
          });
          expect(judgeSpokenLine(fakeSpokenLineBody(input), input)).toEqual({ ok: true });
        }
      }
    }
  });

  it("accepts a friend-voiced ask and refuses the lane's old fixed sentences", () => {
    const first = checkInLineInput({ kind: 'first_ask', kids: ['Mia'] }, 'en');
    expect(
      judgeSpokenLine(
        "One line is plenty, and if you'd rather not get these, just say - how did today go with Mia?",
        first,
      ),
    ).toEqual({ ok: true });
    // The pinned first ask: its question was not the last sentence, and it taught two words.
    expect(
      judgeSpokenLine(
        "Quick one before the day's gone: how did today go with Mia? One line is plenty. Reply LESS for weekly, or NO to skip these.",
        first,
      ),
    ).toEqual({ ok: false, reason: 'question' });
    expect(
      judgeSpokenLine("Reply LESS if you'd like these weekly - how did today go with Mia?", first),
    ).toEqual({ ok: false, reason: 'forbidden:keyword_ask' });
    expect(
      judgeSpokenLine('Écris NON si tu veux arrêter - comment ça s’est passé avec Mia ?', {
        ...first,
        language: 'fr',
      }),
    ).toEqual({ ok: false, reason: 'forbidden:keyword_ask' });
  });

  it('refuses an ask with no question, a dropped kid, or a word to type for the way out', () => {
    const later = checkInLineInput({ kind: 'later_ask', kids: ['Mia'] }, 'en');
    expect(judgeSpokenLine('Let me know how today went with Mia.', later)).toEqual({
      ok: false,
      reason: 'question',
    });
    expect(judgeSpokenLine('How did today go?', later)).toEqual({ ok: false, reason: 'missing' });
    expect(
      judgeSpokenLine(
        'Thanks - that shapes what I look for next weekend. Reply NO to drop these.',
        {
          ...checkInLineInput({ kind: 'noted_ack', kept: true }, 'en'),
        },
      ),
    ).toEqual({ ok: false, reason: 'banned' });
  });

  it('refuses the old step-down notice, a "Noted" opener, and a remark on the silence', () => {
    const stepDown = checkInLineInput(
      { kind: 'cadence_ack', cadence: 'weekly', trigger: 'quiet_evenings' },
      'en',
    );
    expect(
      judgeSpokenLine("I'll check in weekly instead - reply DAILY to switch back.", stepDown),
    ).toEqual({ ok: false, reason: 'forbidden:keyword_ask' });
    expect(
      judgeSpokenLine(
        "Didn't hear from you the last few nights, so I'll check in weekly instead.",
        stepDown,
      ),
    ).toEqual({ ok: false, reason: 'forbidden:scolding' });
    expect(
      judgeSpokenLine(
        "I'll check in weekly from here. Nightly is yours again whenever you want it.",
        stepDown,
      ),
    ).toEqual({ ok: true });

    const noted = checkInLineInput({ kind: 'noted_ack', kept: true }, 'en');
    expect(judgeSpokenLine('Noted - that shapes what I look for next weekend.', noted)).toEqual({
      ok: false,
      reason: 'forbidden:noted_opener',
    });
    expect(judgeSpokenLine('Thanks - that shapes what I look for next weekend.', noted)).toEqual({
      ok: true,
    });
  });

  it('holds the register in French and carries the activity on an anchored ask', () => {
    const fr = checkInLineInput({ kind: 'how_it_went', activity: 'natation', kids: ['Léo'] }, 'fr');
    expect(judgeSpokenLine('Comment s’est passée votre natation aujourd’hui ?', fr)).toEqual({
      ok: false,
      reason: 'french',
    });
    expect(judgeSpokenLine('Alors, comment s’est passée la natation aujourd’hui ?', fr)).toEqual({
      ok: true,
    });
    expect(judgeSpokenLine('Alors, comment s’est passée la journée de Léo ?', fr)).toEqual({
      ok: false,
      reason: 'missing',
    });

    const group = checkInLineInput(
      { kind: 'how_it_went', activity: 'swim', kids: ['Mia'] },
      'en',
      'vous',
      {
        parentName: 'Sam',
      },
    );
    expect(judgeSpokenLine('Sam, how did swim go today?', group)).toEqual({ ok: true });
    expect(judgeSpokenLine('How did swim go today?', group)).toEqual({
      ok: false,
      reason: 'missing',
    });
  });
});
