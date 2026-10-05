import { describe, expect, it } from 'vitest';
import { fakeSpokenLineBody, fakeSpokenLineComposer } from '~/lib/channel/voice/fakes';
import { judgeSpokenLine, spokenFactSlots } from '~/lib/channel/voice/spoken-line';
import type { Nudge } from './nudge-decide.js';
import { NUDGE_VOICE_SKILL, nudgeDayLabel, nudgeLineInput } from './nudge-line-input';
import {
  NUDGE_OPT_OUT,
  type VoicedNudge,
  isSpokenAskNudge,
  isVoicedNudge,
  nudgeVoiceContext,
  speakNudgeLine,
} from './nudge-voice.js';

/**
 * VIL-239 · M4 — COMPOSE's pure seam, after VIL-413 / VIL-417.
 *
 * What is proved:
 *   - the model is handed the decision's facts and no internal identifiers;
 *   - per kind, what the line must carry and which red lines code holds;
 *   - a line that invents a time or a link, writes the opt-out line itself, asks a
 *     question, claims urgency Hale was not given, or blows the budget is REFUSED;
 *   - there is no deterministic sentence underneath: a voice that cannot write the
 *     line is `unsent`, and the sweep (run.test.ts) sends nothing.
 * The model's own words are proved by the cached eval (apps/worker/evals/run-nudge-eval.mjs).
 */

const REGISTRATION: Nudge = {
  kind: 'registration',
  windowRef: {
    id: 'window-uuid-1',
    municipality: 'richmond_hill',
    programDomain: 'rec_program',
    cycleLabel: 'Fall 2026',
  },
  opensAtLocal: 'Aug 5, 10:30 a.m.',
  kidNames: ['Maya', 'Leo'],
  residentNote: 'residents can register first',
  ageApproximate: false,
};

const SWAP: Nudge = {
  kind: 'weather_swap',
  candidateRef: { id: 'cand-uuid-1', title: 'Library story time', venueName: 'Riverdale Library' },
  day: 'saturday',
  kidNames: ['Maya'],
  weatherFact: 'the weekend forecast is wet',
  whyFacts: ['free', 'indoor'],
};

const BARE_SWAP: Nudge = {
  kind: 'weather_swap',
  candidateRef: { id: 'cand-uuid-2', title: 'Splash pad', venueName: null },
  day: 'sunday',
  kidNames: [],
  weatherFact: 'the forecast looks dry',
  whyFacts: [],
};

const DROP_IN: Nudge = {
  kind: 'weekday_dropin',
  candidateRef: { id: 'cand-uuid-3', title: 'EarlyON drop-in', venueName: 'Armour Heights' },
  eventDate: '2026-08-04',
  weekday: 'tuesday',
  kidNames: ['Mia'],
};

const BARE_DROP_IN: Nudge = {
  kind: 'weekday_dropin',
  candidateRef: { id: 'cand-uuid-4', title: 'Baby storytime', venueName: null },
  eventDate: '2026-08-05',
  weekday: 'wednesday',
  kidNames: [],
};

/** The kinds a model may compose. M8's health checkpoints are deliberately absent —
 * they are static copy and never touch the voice path (see health/copy.ts). */
const ALL: VoicedNudge[] = [REGISTRATION, SWAP, BARE_SWAP, DROP_IN, BARE_DROP_IN];

describe('nudgeVoiceContext', () => {
  it('hands the model the facts and no internal identifiers', () => {
    const context = JSON.stringify(nudgeVoiceContext(SWAP));
    expect(context).toContain('Library story time');
    expect(context).toContain('the weekend forecast is wet');
    expect(context).not.toContain('cand-uuid-1');
  });

  it('names the town rather than the internal municipality token', () => {
    const context = JSON.stringify(nudgeVoiceContext(REGISTRATION));
    expect(context).toContain('Richmond Hill');
    expect(context).not.toContain('richmond_hill');
    expect(context).not.toContain('window-uuid-1');
  });

  it('tells the model which kind of nudge it is writing', () => {
    expect(nudgeVoiceContext(REGISTRATION).kind).toBe('registration');
    expect(nudgeVoiceContext(SWAP).kind).toBe('weather_swap');
    expect(nudgeVoiceContext(DROP_IN).kind).toBe('weekday_dropin');
  });

  /** The weekday find's context carries a DAY and no date and no time: the row it came
   * from has neither in a form this message may state, and a model handed the ISO key
   * would put it in the text. */
  it('hands the weekday find its day and withholds the raw date', () => {
    const context = JSON.stringify(nudgeVoiceContext(DROP_IN));
    expect(context).toContain('tuesday');
    expect(context).toContain('EarlyON drop-in');
    expect(context).not.toContain('2026-08-04');
    expect(context).not.toContain('cand-uuid-3');
  });
});

describe('nudgeLineInput', () => {
  it('is a statement on the nudge-voice skill with the two red lines, for every find', () => {
    for (const nudge of ALL) {
      for (const language of ['en', 'fr'] as const) {
        const input = nudgeLineInput(nudgeVoiceContext(nudge), language);
        expect(input.skill).toBe(NUDGE_VOICE_SKILL);
        expect(input.kind).toBe(nudge.kind);
        expect(input.questions).toBe(0);
        expect(input.address).toBe('tu');
        expect(input.maxChars).toBe(220);
        expect(input.forbidden?.map((rule) => rule.name)).toEqual([
          'booking_claim',
          'invented_urgency',
        ]);
      }
    }
  });

  it('speaks vous when the bubble lands in the household group', () => {
    expect(nudgeLineInput(nudgeVoiceContext(SWAP), 'fr', 'vous').address).toBe('vous');
  });

  it('anchors a registration on the town and the kids, and hands over the only time', () => {
    const input = nudgeLineInput(nudgeVoiceContext(REGISTRATION), 'en');
    expect(input.mustMention).toEqual(['Richmond Hill', 'Maya', 'Leo']);
    expect(spokenFactSlots(input)).toEqual(
      expect.arrayContaining(['Fall 2026', 'Aug 5, 10:30 a.m.', 'residents can register first']),
    );
  });

  it('anchors a find on its title, its day and the kids, and grounds the venue', () => {
    const swap = nudgeLineInput(nudgeVoiceContext(SWAP), 'en');
    expect(swap.mustMention).toEqual(['Library story time', 'Saturday', 'Maya']);
    expect(spokenFactSlots(swap)).toEqual(
      expect.arrayContaining(['Riverdale Library', 'the weekend forecast is wet', 'free']),
    );
    const dropIn = nudgeLineInput(nudgeVoiceContext(DROP_IN), 'en');
    expect(dropIn.mustMention).toEqual(['EarlyON drop-in', 'Tuesday', 'Mia']);
    expect(spokenFactSlots(dropIn)).not.toContain('2026-08-04');
  });

  it('hands the day over the way a person writes it: capitalized in English, French in French', () => {
    expect(nudgeDayLabel('saturday', 'fr')).toBe('samedi');
    expect(nudgeDayLabel('tuesday', 'en')).toBe('Tuesday');
    expect(nudgeDayLabel('wednesday', 'en')).toBe('Wednesday');
    expect(nudgeDayLabel('someday', 'en')).toBe('someday');
    const input = nudgeLineInput(nudgeVoiceContext(DROP_IN), 'fr');
    expect(input.facts.day).toBe('mardi');
    expect(input.mustMention).toContain('mardi');
  });
});

describe('the judge on a find', () => {
  it('accepts the fake composer on every find in both languages', () => {
    for (const nudge of ALL) {
      for (const language of ['en', 'fr'] as const) {
        const input = nudgeLineInput(nudgeVoiceContext(nudge), language);
        expect(judgeSpokenLine(fakeSpokenLineBody(input), input)).toEqual({ ok: true });
      }
    }
  });

  it('accepts a grounded, short line', () => {
    const input = nudgeLineInput(nudgeVoiceContext(SWAP), 'en');
    expect(
      judgeSpokenLine(
        'The weekend forecast is wet, so Saturday: Library story time at Riverdale Library for Maya.',
        input,
      ),
    ).toEqual({ ok: true });
  });

  it('refuses a line that invents a time, a link, or a second day', () => {
    const input = nudgeLineInput(nudgeVoiceContext(SWAP), 'en');
    expect(
      judgeSpokenLine('Library story time for Maya starts at 9:15 on Saturday.', input),
    ).toEqual({ ok: false, reason: 'invented' });
    expect(
      judgeSpokenLine(
        'Saturday: Library story time for Maya. Register at https://x.example.ca.',
        input,
      ),
    ).toEqual({ ok: false, reason: 'invented' });
    expect(
      judgeSpokenLine('Saturday: Library story time for Maya, or Sunday if it clears.', input),
    ).toEqual({ ok: false, reason: 'invented' });
  });

  it('refuses the opt-out line, a question, a booking claim, and urgency Hale was not given', () => {
    const input = nudgeLineInput(nudgeVoiceContext(REGISTRATION), 'en');
    const base = 'Richmond Hill Fall 2026 registration opens Aug 5, 10:30 a.m. for Maya and Leo.';
    expect(judgeSpokenLine(`${base} ${NUDGE_OPT_OUT}`, input)).toEqual({
      ok: false,
      reason: 'compliance',
    });
    expect(judgeSpokenLine(`${base} Want me to set a reminder?`, input)).toEqual({
      ok: false,
      reason: 'question',
    });
    expect(judgeSpokenLine(`${base} I've registered them.`, input)).toEqual({
      ok: false,
      reason: 'forbidden:booking_claim',
    });
    expect(judgeSpokenLine(`${base} Spots fill fast.`, input)).toEqual({
      ok: false,
      reason: 'forbidden:invented_urgency',
    });
  });

  it('refuses a line past the skill ceiling', () => {
    const input = nudgeLineInput(nudgeVoiceContext(SWAP), 'en');
    expect(judgeSpokenLine('Library story time suits Maya on Saturday. '.repeat(8), input)).toEqual(
      { ok: false, reason: 'long' },
    );
  });
});

describe('speakNudgeLine', () => {
  it('speaks the find through the composer with the facts, language and register', async () => {
    const voice = fakeSpokenLineComposer();
    const line = await speakNudgeLine(voice, DROP_IN, 'fr', 'vous');
    expect(line.source).toBe('composed');
    expect(line.body).toContain('EarlyON drop-in');
    expect(voice.calls[0]?.input).toMatchObject({
      skill: 'nudge-voice',
      kind: 'weekday_dropin',
      language: 'fr',
      address: 'vous',
    });
  });

  it('is unsent, with no sentence underneath, when the model fails twice', async () => {
    const voice = fakeSpokenLineComposer({ fail: true });
    const line = await speakNudgeLine(voice, SWAP, 'en', 'tu');
    expect(line).toEqual({ body: '', source: 'unsent', fallback: 'model_failed' });
    expect(voice.calls.map((call) => call.prompt)).toEqual(['full', 'short']);
  });
});

describe('the kind guards', () => {
  it('split the sweep three ways: spoken asks, voiced finds, and static health copy', () => {
    for (const nudge of ALL) {
      expect(isVoicedNudge(nudge)).toBe(true);
      expect(isSpokenAskNudge(nudge)).toBe(false);
    }
    const ask: Nudge = { kind: 'weekday_care', ask: { prompt: 'weekend_fallback' } };
    expect(isSpokenAskNudge(ask)).toBe(true);
    expect(isVoicedNudge(ask)).toBe(false);
  });
});
