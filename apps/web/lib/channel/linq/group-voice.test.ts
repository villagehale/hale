import { describe, expect, it, vi } from 'vitest';
import { fakeSpokenLineBody, fakeSpokenLineComposer } from '~/lib/channel/voice/fakes';
import { judgeSpokenLine } from '~/lib/channel/voice/spoken-line';
import {
  GROUP_VOICE_SKILL,
  type GroupLineRequest,
  NO_BOOKING_CLAIM,
  groupLineInput,
  speakGroupLine,
} from './group-voice';

/**
 * Per kind: what the model is handed, what it must carry, how many questions
 * it may ask, and which red lines code holds. The model's actual words are
 * proved by the cached eval (apps/worker/evals/run-group-voice-eval.mjs).
 */

const EVERY_KIND: GroupLineRequest[] = [
  { kind: 'welcome' },
  { kind: 'member_welcome', adder: 'Barton' },
  { kind: 'member_welcome', adder: null },
  { kind: 'stranger_hold', parentA: 'Barton' },
  { kind: 'name_ack', name: 'Sam' },
  { kind: 'calendar_ask', name: 'Sam' },
  { kind: 'calendar_link', name: 'Sam' },
  { kind: 'calendar_heads_up', name: 'Sam' },
  { kind: 'calendar_receipt', name: 'Sam' },
  { kind: 'gmail_ask', name: 'Sam' },
  { kind: 'gmail_receipt', name: 'Sam' },
  {
    kind: 'kid_event',
    events: [
      { parent: 'Barton', kid: 'Maya', event: 'Swim level 2', day: 'Saturday', time: '9:00' },
    ],
  },
  { kind: 'conflict', kid: 'Maya', event: 'Swim level 2', day: 'Saturday', time: '9:00' },
  { kind: 'who_takes', kid: 'Maya', event: 'Swim level 2', day: 'Saturday', time: '9:00' },
  { kind: 'handoff', name: 'Sam', kid: 'Maya', event: 'Swim level 2', time: '9:00' },
  { kind: 'how_it_went', name: 'Sam', activity: 'gymnastics' },
  { kind: 'how_it_went', name: null, activity: 'gymnastics' },
  { kind: 'both_free', slots: ['Sat 9:00', 'Sun 10:00'] },
  {
    kind: 'decision_sync',
    decisions: [
      {
        parent: 'Barton',
        decision: 'picked',
        activity: 'swim',
        kid: 'Maya',
        day: 'Tue',
        time: '4 pm',
      },
      { parent: null, decision: 'passed', activity: 'piano', kid: 'Maya', day: null, time: null },
      { parent: 'Sam', decision: 'duty', activity: 'soccer', kid: 'Leo', day: 'Sat', time: '9:00' },
    ],
  },
  { kind: 'departure', name: 'Sam' },
  { kind: 'departure', name: null, address: 'tu' },
  { kind: 'empty_saturday', name: 'Sam', kid: 'Maya' },
  { kind: 'empty_saturday', name: null, kid: 'Maya' },
];

describe('groupLineInput', () => {
  it('names the skill, speaks vous in the group, and is writable for every kind in both languages', () => {
    for (const request of EVERY_KIND) {
      for (const language of ['en', 'fr'] as const) {
        const input = groupLineInput(request, language);
        expect(input.skill).toBe(GROUP_VOICE_SKILL);
        expect(input.kind).toBe(request.kind);
        expect(input.language).toBe(language);
        const oneParent =
          request.kind === 'calendar_ask' ||
          request.kind === 'calendar_link' ||
          request.kind === 'calendar_heads_up' ||
          request.kind === 'gmail_ask';
        expect(input.address).toBe(
          request.kind === 'departure' && request.address
            ? request.address
            : oneParent
              ? 'tu'
              : 'vous',
        );
        // The fake writes from the same facts, so a kind the judge cannot pass is caught here.
        expect(() => fakeSpokenLineBody(input)).not.toThrow();
      }
    }
  });

  it('asks exactly one question only where the moment is a question', () => {
    const asks = new Set([
      'welcome',
      'member_welcome',
      'stranger_hold',
      'calendar_ask',
      'gmail_ask',
      'conflict',
      'who_takes',
      'how_it_went',
      'both_free',
      'empty_saturday',
    ]);
    for (const request of EVERY_KIND) {
      expect(groupLineInput(request, 'en').questions).toBe(asks.has(request.kind) ? 1 : 0);
    }
  });

  it('holds the no-booking red line on every line that could be mistaken for a receipt', () => {
    const guarded = new Set([
      'calendar_receipt',
      'gmail_receipt',
      'kid_event',
      'conflict',
      'who_takes',
      'handoff',
      'both_free',
      'decision_sync',
      'empty_saturday',
    ]);
    for (const request of EVERY_KIND) {
      const input = groupLineInput(request, 'en');
      expect((input.forbidden ?? []).includes(NO_BOOKING_CLAIM)).toBe(guarded.has(request.kind));
    }
  });

  it('lets the asks say "this link" because code appends the card, and nothing else may', () => {
    for (const request of EVERY_KIND) {
      const input = groupLineInput(request, 'en');
      const ask = request.kind === 'calendar_link' || request.kind === 'gmail_ask';
      expect(input.linkFollows ?? false).toBe(ask);
    }
  });

  it('anchors each line on the facts it is about', () => {
    expect(groupLineInput({ kind: 'name_ack', name: 'Sam' }, 'en')).toMatchObject({
      facts: { name: 'Sam' },
      questions: 0,
    });
    expect(
      groupLineInput(
        {
          kind: 'kid_event',
          events: [
            { parent: 'Barton', kid: 'Maya', event: 'Swim', day: 'Saturday', time: '9:00' },
            { parent: 'Barton', kid: 'Leo', event: 'Soccer', day: 'Saturday', time: '11:00' },
          ],
        },
        'en',
      ),
    ).toMatchObject({
      mustMention: ['Maya', 'Swim', '9:00', 'Leo', 'Soccer', '11:00'],
      maxChars: 400,
    });
    expect(
      groupLineInput(
        { kind: 'handoff', name: 'Sam', kid: 'Maya', event: 'Swim', time: '9:00' },
        'fr',
      ),
    ).toMatchObject({
      facts: { name: 'Sam', kid: 'Maya', event: 'Swim', time: '9:00', when: 'demain' },
      mustMention: ['Sam', 'Maya', 'Swim', '9:00'],
    });
    expect(
      groupLineInput({ kind: 'how_it_went', name: null, activity: 'gym' }, 'en'),
    ).toMatchObject({
      facts: { name: null, activity: 'gym' },
      mustMention: ['gym'],
      maxChars: 200,
    });
    expect(groupLineInput({ kind: 'both_free', slots: ['Sat 9', 'Sun 10'] }, 'en')).toMatchObject({
      facts: { slots: ['Sat 9', 'Sun 10'] },
      mustMention: ['Sat 9', 'Sun 10'],
    });
    expect(groupLineInput({ kind: 'empty_saturday', name: null, kid: 'Maya' }, 'fr')).toMatchObject(
      { facts: { name: null, kid: 'Maya', day: 'samedi' }, mustMention: ['Maya', 'samedi'] },
    );
    expect(groupLineInput({ kind: 'departure', name: null }, 'en')).toMatchObject({
      facts: { name: null },
      mustMention: [],
      address: 'vous',
    });
  });

  it('hands over the parent words and recent turns without putting them in the facts', () => {
    const input = groupLineInput({ kind: 'calendar_ask', name: 'Sam' }, 'en', {
      parentWords: 'ready',
      recentTurns: [{ role: 'hale', body: 'earlier' }],
    });
    expect(input.parentWords).toBe('ready');
    expect(input.recentTurns).toEqual([{ role: 'hale', body: 'earlier' }]);
    expect(input.facts).toEqual({ name: 'Sam' });
  });
});

describe('the judge on group lines', () => {
  const kidEvent = groupLineInput(
    {
      kind: 'kid_event',
      events: [
        { parent: 'Barton', kid: 'Maya', event: 'Swim level 2', day: 'Saturday', time: '9:00' },
      ],
    },
    'en',
  );

  it('passes a heads-up written from the facts and refuses a booking claim', () => {
    expect(judgeSpokenLine('Heads up, Maya has Swim level 2 Saturday at 9:00.', kidEvent)).toEqual({
      ok: true,
    });
    expect(
      judgeSpokenLine("I've booked Maya into Swim level 2 Saturday at 9:00.", kidEvent),
    ).toEqual({ ok: false, reason: 'forbidden:booking_claim' });
    expect(
      judgeSpokenLine("J'ai inscrit Maya à Swim level 2 samedi à 9:00.", {
        ...groupLineInput(
          {
            kind: 'kid_event',
            events: [
              { parent: 'Barton', kid: 'Maya', event: 'Swim level 2', day: 'samedi', time: '9:00' },
            ],
          },
          'fr',
        ),
      }),
    ).toEqual({ ok: false, reason: 'forbidden:booking_claim' });
  });

  it('refuses a who-takes line that forgets the event or adds a second question', () => {
    const who = groupLineInput(
      { kind: 'who_takes', kid: 'Maya', event: 'Swim level 2', day: 'Saturday', time: '9:00' },
      'en',
    );
    expect(judgeSpokenLine('Maya has Swim level 2 Saturday at 9:00. Who takes her?', who)).toEqual({
      ok: true,
    });
    expect(judgeSpokenLine('Maya is on Saturday at 9:00. Who takes her?', who)).toEqual({
      ok: false,
      reason: 'missing',
    });
    expect(
      judgeSpokenLine(
        'Maya has Swim level 2 Saturday at 9:00. Barton? Or Sam, who takes her?',
        who,
      ),
    ).toEqual({ ok: false, reason: 'question' });
  });

  it('keeps one French register, and a stored vous wins over the tu default', () => {
    const fr = groupLineInput({ kind: 'gmail_ask', name: 'Sam' }, 'fr');
    expect(fr.address).toBe('tu');
    expect(judgeSpokenLine('Sam, ton calendrier aide. Tu veux ce lien?', fr)).toEqual({ ok: true });
    expect(
      judgeSpokenLine('Sam, votre calendrier aide à voir les semaines. Vous voulez ce lien?', fr),
    ).toEqual({ ok: false, reason: 'french' });
    expect(
      groupLineInput({ kind: 'calendar_ask', name: 'Sam', address: 'vous' }, 'fr').address,
    ).toBe('vous');
  });

  it('ends the calendar ask on the question and refuses the kids year', () => {
    const ask = groupLineInput({ kind: 'calendar_ask', name: 'Sam' }, 'en');
    expect(
      judgeSpokenLine(
        "Sam, would you want the kids' stuff on your calendar? That way I can keep it in sync.",
        ask,
      ),
    ).toEqual({ ok: false, reason: 'question' });
    expect(
      judgeSpokenLine(
        "Sam, that way I can keep the kids' stuff in sync. Would you want it on your calendar?",
        ask,
      ),
    ).toEqual({ ok: false, reason: 'forbidden:calendar_sync' });
    expect(
      judgeSpokenLine(
        "Sam, I'll keep things straight between the two of you. Want the kids' events on your calendar?",
        ask,
      ),
    ).toEqual({ ok: false, reason: 'forbidden:calendar_sync' });
    expect(
      judgeSpokenLine(
        "Sam, the kids' stuff can show on your calendar. Want the kids' events on your calendar?",
        ask,
      ),
    ).toEqual({ ok: true });
    expect(
      judgeSpokenLine(
        "Sam, I can see what's already there for reminders. Want the kids' events on your calendar?",
        ask,
      ),
    ).toEqual({ ok: true });
    const fr = groupLineInput({ kind: 'calendar_ask', name: 'Sam' }, 'fr');
    expect(
      judgeSpokenLine("Sam, ça te dit d'avoir l'année des enfants sur ton calendrier?", fr),
    ).toEqual({ ok: false, reason: 'forbidden:kids_year' });
  });

  it('splits the link note from the heads-up and refuses we, no worries, and coaching', () => {
    const link = groupLineInput({ kind: 'calendar_link', name: 'Sam' }, 'en');
    expect(link.maxChars).toBe(220);
    expect(link.linkFollows).toBe(true);
    expect(judgeSpokenLine('Sam, this link is just for you.', link)).toEqual({ ok: true });
    const heads = groupLineInput({ kind: 'calendar_heads_up', name: 'Sam' }, 'en');
    expect(heads.maxChars).toBe(220);
    expect(heads.linkFollows).toBeUndefined();
    expect(
      judgeSpokenLine(
        "Google may say Hale is not verified yet, because I'm still in review. No problem if you'd rather wait.",
        heads,
      ),
    ).toEqual({ ok: true });
    expect(
      judgeSpokenLine(
        'Google may say Hale is not verified yet. This link will work while you wait.',
        heads,
      ),
    ).toEqual({ ok: false, reason: 'link' });
    expect(
      judgeSpokenLine(
        "Google may say Hale is not verified yet, because we are still in Google's review.",
        heads,
      ),
    ).toEqual({ ok: false, reason: 'forbidden:we_for_hale' });
    expect(
      judgeSpokenLine(
        'Google may say Hale is not verified yet. No worries if you would rather wait.',
        heads,
      ),
    ).toEqual({ ok: false, reason: 'forbidden:soft_safe' });
    expect(judgeSpokenLine('If Google warns you, tap Advanced and carry on.', heads)).toEqual({
      ok: false,
      reason: 'forbidden:google_coaching',
    });
  });

  it('lets a 1:1 departure be tu and refuses vous there', () => {
    const tu = groupLineInput(
      { kind: 'departure', name: 'Sam', address: 'tu', remaining: 1 },
      'fr',
    );
    expect(
      judgeSpokenLine(
        "Sam est parti. L'horaire des enfants et les rappels restent. Je suis toujours là.",
        tu,
      ),
    ).toEqual({ ok: true });
    expect(judgeSpokenLine('Sam, votre coparent a quitté Hale. Je suis toujours là.', tu)).toEqual({
      ok: false,
      reason: 'french',
    });
  });

  it('refuses a departure that drops the still-here close', () => {
    const tu = groupLineInput({ kind: 'departure', name: null, address: 'tu', remaining: 1 }, 'fr');
    expect(
      judgeSpokenLine("Ton coparent part doucement. L'horaire des enfants reste.", tu),
    ).toEqual({
      ok: false,
      reason: 'close',
    });
    expect(judgeSpokenLine('Ton coparent part doucement. Je reste là.', tu)).toEqual({
      ok: false,
      reason: 'close',
    });
    const en = groupLineInput({ kind: 'departure', name: 'Sam', remaining: 1 }, 'en');
    expect(judgeSpokenLine('Sam left. The schedule and the reminders stay.', en)).toEqual({
      ok: false,
      reason: 'close',
    });
    expect(
      judgeSpokenLine("Sam left. The kids' schedule and the reminders stay. I'm still here.", en),
    ).toEqual({ ok: true });
    expect(
      judgeSpokenLine(
        "Sam's moving on. The kids' schedule and the reminders stay. I'm still here.",
        en,
      ),
    ).toEqual({ ok: false, reason: 'forbidden:breakup' });
    const fr = groupLineInput({ kind: 'departure', name: 'Sam', remaining: 1 }, 'fr');
    expect(
      judgeSpokenLine(
        "Sam s'en va. L'horaire des enfants et les rappels restent. Je suis toujours là.",
        fr,
      ),
    ).toEqual({ ok: false, reason: 'forbidden:breakup' });
    expect(
      judgeSpokenLine(
        "Sam a quitté le groupe. L'horaire des enfants et les rappels restent. Je suis toujours là.",
        fr,
      ),
    ).toEqual({ ok: true });
    expect(
      judgeSpokenLine(
        "Sam left. I'm still here for you, and the kids' schedule and reminders stay as they are.",
        en,
      ),
    ).toEqual({ ok: false, reason: 'close' });
    expect(
      judgeSpokenLine(
        "Sam a quitté le groupe. Je suis toujours là, et l'horaire des enfants et les rappels restent.",
        fr,
      ),
    ).toEqual({ ok: false, reason: 'close' });
  });

  it('refuses the kids year, and you both unless two people remain', () => {
    const one = groupLineInput({ kind: 'departure', name: 'Sam', remaining: 1 }, 'en');
    expect(
      judgeSpokenLine("Sam left. The kids' year stays as it is. I'm still here.", one),
    ).toEqual({ ok: false, reason: 'forbidden:kids_year' });
    expect(
      judgeSpokenLine("Sam left. You both still have the schedule. I'm still here.", one),
    ).toEqual({ ok: false, reason: 'forbidden:both' });
    const two = groupLineInput({ kind: 'departure', name: 'Sam', remaining: 2 }, 'en');
    expect(
      judgeSpokenLine(
        "Sam left. You both still have the schedule and the reminders. I'm still here.",
        two,
      ),
    ).toEqual({ ok: true });
    const fr = groupLineInput({ kind: 'welcome' }, 'fr');
    expect(
      judgeSpokenLine("Je suis Hale. Ce fil, c'est l'année des enfants. Comment vous appeler?", fr),
    ).toEqual({
      ok: false,
      reason: 'forbidden:kids_year',
    });
  });
});

describe('speakGroupLine', () => {
  it('composes from the request and returns the body', async () => {
    const voice = fakeSpokenLineComposer();
    const result = await speakGroupLine(voice, { kind: 'name_ack', name: 'Sam' }, 'en', {
      parentWords: 'Sam',
    });
    expect(result).toEqual({
      body: fakeSpokenLineBody(groupLineInput({ kind: 'name_ack', name: 'Sam' }, 'en')),
      source: 'composed',
      fallback: null,
    });
    expect(voice.calls[0]?.input.parentWords).toBe('Sam');
  });

  it('pages and sends nothing when the model fails twice', async () => {
    const page = vi.fn(async (_text: string) => undefined);
    const result = await speakGroupLine(
      fakeSpokenLineComposer({ fail: true }),
      { kind: 'welcome' },
      'en',
      { page },
    );
    expect(result.source).toBe('unsent');
    expect(page).toHaveBeenCalledWith(
      'spoken line unsent skill=group-voice kind=welcome reason=model_failed',
    );
  });
});
