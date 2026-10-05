import { describe, expect, it, vi } from 'vitest';
import { fakeSpokenLineBody, fakeSpokenLineComposer } from './fakes';
import {
  type SpokenLineInput,
  assembleSpokenLine,
  judgeSpokenLine,
  speakLine,
  spokenFactSlots,
  spokenLineContext,
  spokenLineToolSchema,
} from './spoken-line';

/**
 * The engine every non-onboarding surface speaks through. The judge is the
 * red line code keeps; the compose/retry/page shape is the one PR #768 set.
 */

const base: SpokenLineInput = {
  skill: 'group-voice',
  kind: 'kid_event',
  language: 'en',
  address: 'vous',
  facts: { kid: 'Maya', event: 'Swim level 2', day: 'Saturday', time: '9:00' },
  questions: 0,
  mustMention: ['Maya', 'Swim level 2'],
};

describe('judgeSpokenLine', () => {
  it('accepts a plain line built from the facts', () => {
    expect(judgeSpokenLine('Maya has Swim level 2 on Saturday at 9:00.', base)).toEqual({
      ok: true,
    });
  });

  it('refuses an empty or over-long body', () => {
    expect(judgeSpokenLine('   ', base)).toEqual({ ok: false, reason: 'empty' });
    expect(judgeSpokenLine('x'.repeat(421), base)).toEqual({ ok: false, reason: 'long' });
    expect(judgeSpokenLine('x'.repeat(41), { ...base, maxChars: 40 })).toEqual({
      ok: false,
      reason: 'long',
    });
  });

  it('holds the question count: none when 0, exactly one and last when 1', () => {
    expect(judgeSpokenLine('Maya has Swim level 2 Saturday 9:00. Ready?', base)).toEqual({
      ok: false,
      reason: 'question',
    });
    const ask = { ...base, questions: 1 as const };
    expect(judgeSpokenLine('Maya has Swim level 2 Saturday at 9:00. Who takes her?', ask)).toEqual({
      ok: true,
    });
    expect(judgeSpokenLine('Who takes Maya to Swim level 2? Saturday at 9:00.', ask)).toEqual({
      ok: false,
      reason: 'question',
    });
    expect(judgeSpokenLine('Swim level 2 for Maya? Saturday? 9:00.', ask)).toEqual({
      ok: false,
      reason: 'question',
    });
  });

  it('does not count a question mark that lives inside a quoted fact', () => {
    const titled = { ...base, facts: { ...base.facts, event: "Who's in?" }, mustMention: ['Maya'] };
    expect(judgeSpokenLine("Maya has Who's in? on Saturday at 9:00.", titled)).toEqual({
      ok: true,
    });
  });

  it('refuses keyword asks, compliance wording, emoji, URLs and phone numbers', () => {
    expect(judgeSpokenLine('Maya has Swim level 2. Reply YES to confirm.', base)).toEqual({
      ok: false,
      reason: 'banned',
    });
    expect(judgeSpokenLine('Maya has Swim level 2. Reply STOP to opt out.', base)).toEqual({
      ok: false,
      reason: 'compliance',
    });
    expect(judgeSpokenLine('Maya has Swim level 2 🏊', base)).toEqual({
      ok: false,
      reason: 'emoji',
    });
    expect(judgeSpokenLine('Maya has Swim level 2, see https://x.test', base)).toEqual({
      ok: false,
      reason: 'invented',
    });
    expect(judgeSpokenLine('Maya has Swim level 2, call 416-555-0100', base)).toEqual({
      ok: false,
      reason: 'invented',
    });
  });

  it('refuses a time, a weekday or a price the facts did not carry', () => {
    expect(judgeSpokenLine('Maya has Swim level 2 on Saturday at 10:30.', base)).toEqual({
      ok: false,
      reason: 'invented',
    });
    expect(judgeSpokenLine('Maya has Swim level 2 on Sunday at 9:00.', base)).toEqual({
      ok: false,
      reason: 'invented',
    });
    expect(judgeSpokenLine('Maya has Swim level 2 Saturday 9:00, $45.', base)).toEqual({
      ok: false,
      reason: 'invented',
    });
    const french = { ...base, language: 'fr' as const, facts: { ...base.facts, day: 'samedi' } };
    expect(judgeSpokenLine('Maya a Swim level 2 dimanche à 9:00.', french)).toEqual({
      ok: false,
      reason: 'invented',
    });
  });

  it('requires every mustMention string, case-insensitively', () => {
    expect(judgeSpokenLine('Swim level 2 is Saturday at 9:00.', base)).toEqual({
      ok: false,
      reason: 'missing',
    });
    expect(judgeSpokenLine('maya has swim level 2 Saturday at 9:00.', base)).toEqual({ ok: true });
  });

  it('holds French register and accents, ignoring quoted English facts', () => {
    const fr: SpokenLineInput = {
      ...base,
      language: 'fr',
      facts: { ...base.facts, day: 'samedi' },
    };
    // "êtes" must not read as the tu-form "tes": the boundary has to be letter-aware.
    expect(judgeSpokenLine('Maya a Swim level 2 samedi à 9:00. Vous êtes prêts.', fr)).toEqual({
      ok: true,
    });
    expect(
      judgeSpokenLine('Maya a Swim level 2 samedi à 9:00. Prévenez-moi côté transport.', fr),
    ).toEqual({
      ok: true,
    });
    expect(judgeSpokenLine('Maya a Swim level 2 samedi a 9:00, pres de chez vous.', fr)).toEqual({
      ok: false,
      reason: 'french',
    });
    expect(
      judgeSpokenLine('Maya a Swim level 2 samedi à 9:00. Tu y vas?', { ...fr, questions: 1 }),
    ).toEqual({
      ok: false,
      reason: 'french',
    });
    // The object pronoun is the tu family too: "chez vous ... ça t'intéresse" is one mixed line.
    expect(
      judgeSpokenLine('Maya a Swim level 2 samedi à 9:00 près de chez vous. Ça t’intéresse?', {
        ...fr,
        questions: 1,
      }),
    ).toEqual({ ok: false, reason: 'french' });
    expect(judgeSpokenLine('Maya a Swim level 2 samedi à 9:00. Je te le rappelle.', fr)).toEqual({
      ok: false,
      reason: 'french',
    });
    // "t" inside a word ("tout", "fait") is not the pronoun.
    expect(judgeSpokenLine('Maya a Swim level 2 samedi à 9:00, tout est en place.', fr)).toEqual({
      ok: true,
    });
    const tu = { ...fr, address: 'tu' as const };
    expect(judgeSpokenLine('Maya a Swim level 2 samedi à 9:00. Votre tour.', tu)).toEqual({
      ok: false,
      reason: 'french',
    });
    expect(
      judgeSpokenLine(
        "Maya a Swim level 2 samedi à 9:00. Je te le rappelle, c'est près de chez toi.",
        tu,
      ),
    ).toEqual({
      ok: true,
    });
    const englishTitle = {
      ...fr,
      facts: { ...fr.facts, event: 'Stage age 3' },
      mustMention: ['Maya'],
    };
    expect(judgeSpokenLine('Maya a Stage age 3 samedi à 9:00.', englishTitle)).toEqual({
      ok: true,
    });
  });

  it('refuses "this link" unless code appends one', () => {
    expect(
      judgeSpokenLine('Maya has Swim level 2 Saturday at 9:00, this link has it.', base),
    ).toEqual({ ok: false, reason: 'link' });
    expect(
      judgeSpokenLine('Maya has Swim level 2 Saturday at 9:00, this link has it.', {
        ...base,
        linkFollows: true,
      }),
    ).toEqual({ ok: true });
  });

  it('names a per-kind red line when it is crossed', () => {
    const guarded = {
      ...base,
      forbidden: [{ name: 'booking_claim', pattern: /\b(booked|registered|signed up)\b/i }],
    };
    expect(judgeSpokenLine('Maya is booked for Swim level 2 Saturday at 9:00.', guarded)).toEqual({
      ok: false,
      reason: 'forbidden:booking_claim',
    });
  });
});

describe('assembleSpokenLine', () => {
  it('keeps a statement as the single line field', () => {
    expect(assembleSpokenLine(0, { line: '  Maya has Swim level 2.  ' })).toBe(
      'Maya has Swim level 2.',
    );
  });

  it('puts the question last and adds no words of its own', () => {
    expect(
      assembleSpokenLine(1, {
        before: 'Sam, this link is just for you.',
        question: "Want your calendar in the kids' year too?",
      }),
    ).toBe("Sam, this link is just for you. Want your calendar in the kids' year too?");
    expect(assembleSpokenLine(1, { before: '', question: 'Who is taking it?' })).toBe(
      'Who is taking it?',
    );
  });

  it('closes the sentence before the question, and puts no space before ?', () => {
    expect(
      assembleSpokenLine(1, {
        before: "Sam, Maya's Saturday looks open",
        question: "Want me to find something nearby that's actually running that day?",
      }),
    ).toBe(
      "Sam, Maya's Saturday looks open. Want me to find something nearby that's actually running that day?",
    );
    expect(
      assembleSpokenLine(1, {
        before: "Le samedi de Maya a l'air libre en ce moment",
        question: 'Vous voulez que je cherche quelque chose ?',
      }),
    ).toBe(
      "Le samedi de Maya a l'air libre en ce moment. Vous voulez que je cherche quelque chose?",
    );
    expect(
      assembleSpokenLine(1, {
        before: 'Ton coparent a quitté Hale.',
        question: 'Tu veux que je reste ?',
      }),
    ).toBe('Ton coparent a quitté Hale. Tu veux que je reste?');
  });

  it('keeps a question the model wrote in both fields once', () => {
    expect(
      assembleSpokenLine(1, {
        before: 'Sam, how did gymnastics go',
        question: 'How did gymnastics go?',
      }),
    ).toBe('Sam. How did gymnastics go?');
    expect(
      assembleSpokenLine(1, {
        before: 'The weekend options I just sent.',
        question: 'Would weekday care help too? Would weekday care help too?',
      }),
    ).toBe('The weekend options I just sent. Would weekday care help too?');
  });

  it('keeps the questions-0 tool schema stable for the statement evals', () => {
    expect(JSON.stringify(spokenLineToolSchema(0))).toBe(
      JSON.stringify({
        type: 'object',
        properties: { line: { type: 'string' } },
        required: ['line'],
      }),
    );
    expect(spokenLineToolSchema(1).required).toEqual(['before', 'question']);
  });
});

describe('spokenFactSlots / spokenLineContext', () => {
  it('flattens scalars, lists and rows into the strings the judge accepts', () => {
    const input: SpokenLineInput = {
      ...base,
      facts: {
        name: 'Sam',
        count: 3,
        unknown: null,
        flag: true,
        slots: ['Sat 9:00', 'Sun 10:00'],
        decisions: [{ parent: 'Barton', activity: 'swim', day: null }],
      },
      mustMention: ['Sam'],
      parentWords: 'who takes her',
      recentTurns: [{ role: 'hale', body: 'earlier line' }],
    };
    expect(spokenFactSlots(input)).toEqual([
      'Sam',
      '3',
      'Sat 9:00',
      'Sun 10:00',
      'Barton',
      'swim',
      'Sam',
      'who takes her',
      'earlier line',
    ]);
  });

  it('hands the model facts and direction only', () => {
    const context = spokenLineContext(base) as Record<string, unknown>;
    expect(Object.keys(context).sort()).toEqual(
      [
        'address',
        'facts',
        'kind',
        'language',
        'linkFollows',
        'mustMention',
        'parentWords',
        'questions',
        'recentTurns',
      ].sort(),
    );
    expect(JSON.stringify(context)).not.toMatch(/skill|familyId|phone|https?:/);
  });
});

describe('speakLine', () => {
  it('sends the composed line on the first try and pages nobody', async () => {
    const voice = fakeSpokenLineComposer();
    const page = vi.fn(async (_text: string) => undefined);
    const result = await speakLine(voice, base, { page });
    expect(result).toEqual({ body: fakeSpokenLineBody(base), source: 'composed', fallback: null });
    expect(voice.calls.map((call) => call.prompt)).toEqual(['full']);
    expect(page).not.toHaveBeenCalled();
  });

  it('retries once on the short prompt when the first line is unusable', async () => {
    const voice = fakeSpokenLineComposer({ failFullPrompt: true });
    const page = vi.fn(async (_text: string) => undefined);
    const result = await speakLine(voice, base, { page });
    expect(result.source).toBe('retry');
    expect(result.body).toBe(fakeSpokenLineBody(base));
    expect(voice.calls.map((call) => call.prompt)).toEqual(['full', 'short']);
    expect(page).not.toHaveBeenCalled();
  });

  it('sends nothing and pages #ops once when both attempts fail', async () => {
    const voice = fakeSpokenLineComposer({ fail: true });
    const page = vi.fn(async (_text: string) => undefined);
    const result = await speakLine(voice, base, { page });
    expect(result).toEqual({ body: '', source: 'unsent', fallback: 'model_failed' });
    expect(voice.calls.map((call) => call.prompt)).toEqual(['full', 'short']);
    expect(page).toHaveBeenCalledTimes(1);
    expect(page.mock.calls[0]?.[0]).toBe(
      'spoken line unsent skill=group-voice kind=kid_event reason=model_failed',
    );
  });

  it('retries once and hands the refusal back: question mark, a missing name, the register', async () => {
    const ask: SpokenLineInput = {
      ...base,
      questions: 1,
      mustMention: ['Sam', 'Maya'],
      language: 'fr',
      address: 'tu',
    };
    let attempts = 0;
    const voice = fakeSpokenLineComposer({
      body: (input) => {
        attempts += 1;
        // A real question, the names present, and vous inside a tu line: the
        // register check is what refuses it, and that reason is what the retry sees.
        return attempts === 1
          ? 'Sam, Maya has Swim level 2 on Saturday at 9:00. Ça vous intéresse?'
          : fakeSpokenLineBody(input);
      },
    });
    const page = vi.fn(async (_text: string) => undefined);
    const result = await speakLine(voice, ask, { page });
    expect(result.source).toBe('retry');
    expect(result.fallback).toBeNull();
    expect(voice.calls[0]?.rejected).toBeUndefined();
    expect(voice.calls[1]?.prompt).toBe('short');
    expect(voice.calls[1]?.rejected?.reason).toBe('french');
    expect(voice.calls[1]?.rejected?.line).toContain('vous');
    expect(page).not.toHaveBeenCalled();
  });

  it('judges every attempt: a leaky line on both prompts is unusable, not sent', async () => {
    const voice = fakeSpokenLineComposer({ body: 'Maya has Swim level 2 Sunday at 9:00.' });
    const page = vi.fn(async (_text: string) => undefined);
    const result = await speakLine(voice, base, { page });
    expect(result).toEqual({ body: '', source: 'unsent', fallback: 'unusable' });
    expect(page).toHaveBeenCalledTimes(1);
    expect(page.mock.calls[0]?.[0]).toContain('reason=unusable');
  });

  it('keeps names and parent words out of the #ops page', async () => {
    const voice = fakeSpokenLineComposer({ fail: true });
    const page = vi.fn(async (_text: string) => undefined);
    await speakLine(voice, { ...base, parentWords: 'is Maya swimming' }, { page });
    const text = String(page.mock.calls[0]?.[0]);
    expect(text).not.toContain('Maya');
    expect(text).not.toContain('swimming');
  });

  it('treats a hung attempt as a failure and moves to the short prompt', async () => {
    const hung: Parameters<typeof speakLine>[0] = {
      compose: (input, options) =>
        options?.prompt === 'short'
          ? Promise.resolve({ line: fakeSpokenLineBody(input) })
          : new Promise(() => undefined),
    };
    const page = vi.fn(async (_text: string) => undefined);
    const result = await speakLine(hung, base, { page, attemptTimeoutMs: 20 });
    expect(result.source).toBe('retry');
    expect(page).not.toHaveBeenCalled();
  });

  it('names a missing skill when the full prompt cannot load it', async () => {
    const noSkill: Parameters<typeof speakLine>[0] = {
      compose: (_input, options) =>
        options?.prompt === 'short'
          ? Promise.reject(new Error('model down'))
          : Promise.reject(new Error('ENOENT: skill not found')),
    };
    const page = vi.fn(async (_text: string) => undefined);
    const result = await speakLine(noSkill, base, { page });
    expect(result.fallback).toBe('model_failed');
    expect(result.source).toBe('unsent');
  });

  it('names voice_unavailable and pages when there is no composer at all (rule #11)', async () => {
    const page = vi.fn(async (_text: string) => undefined);
    const result = await speakLine(undefined, base, { page });
    expect(result).toEqual({ body: '', source: 'unsent', fallback: 'voice_unavailable' });
    expect(page.mock.calls[0]?.[0]).toContain('reason=voice_unavailable');
  });

  it('starts on the short prompt when asked, and does not retry past it', async () => {
    const voice = fakeSpokenLineComposer({ fail: true });
    const page = vi.fn(async (_text: string) => undefined);
    const result = await speakLine(voice, base, { page, prompt: 'short' });
    expect(result.source).toBe('unsent');
    expect(voice.calls.map((call) => call.prompt)).toEqual(['short']);
    expect(page).toHaveBeenCalledTimes(1);
  });

  it('survives a failing pager without throwing', async () => {
    const voice = fakeSpokenLineComposer({ fail: true });
    const page = vi.fn(async (_text: string) => {
      throw new Error('slack down');
    });
    await expect(speakLine(voice, base, { page })).resolves.toMatchObject({ source: 'unsent' });
  });
});
