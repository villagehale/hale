import { describe, expect, it } from 'vitest';
import { fakeSpokenLineBody } from '~/lib/channel/voice/fakes';
import { judgeSpokenLine } from '~/lib/channel/voice/spoken-line';
import {
  DUTY_MAX_CHARS,
  DUTY_OVERVIEW_MAX_CHARS,
  DUTY_OVERVIEW_MAX_ENTRIES,
  DUTY_VOICE_SKILL,
  type DutyLineRequest,
  dutyLineInput,
  overviewEntries,
} from './line-input';

/**
 * Per kind: what the model is handed, what it must carry, and which red lines code
 * holds. The model's actual words are proved by the cached eval
 * (apps/worker/evals/run-duty-voice-eval.mjs, rule #8).
 */

const EVERY_KIND: DutyLineRequest[] = [
  {
    kind: 'week_overview',
    entries: [
      { day: 'Monday', event: 'swim', owner: 'Sam' },
      { day: 'Thursday', event: 'piano', owner: null },
    ],
  },
  { kind: 'reask', kid: 'Maya', event: 'swim', day: 'Tuesday', time: '3:00pm' },
  { kind: 'night_before', owner: 'Sam', kid: 'Maya', event: 'swim', time: '3:00pm' },
  {
    kind: 'owner',
    owner: 'Sam',
    kid: 'Maya',
    event: 'swim',
    day: 'Tuesday',
    time: '3:00pm',
    recorded: false,
  },
  {
    kind: 'owner',
    owner: 'Sam',
    kid: 'Maya',
    event: 'swim',
    day: 'Tuesday',
    time: '3:00pm',
    recorded: true,
  },
  { kind: 'nobody_yet', kid: 'Maya', event: 'swim', day: 'Tuesday', time: '3:00pm' },
  { kind: 'which_kid', name: 'Sam', kids: ['Maya', 'Leo'] },
  { kind: 'both_claimed', event: 'swim', day: 'Tuesday', parentA: 'Sam', parentB: 'Jo' },
  { kind: 'silent_parent', name: 'Jo', event: 'swim', day: 'Tuesday' },
];

const ASKS = new Set(['reask', 'nobody_yet', 'which_kid', 'both_claimed']);
const TO_ONE_PARENT = new Set(['which_kid', 'silent_parent']);

describe('dutyLineInput', () => {
  it('is on the duty-voice skill, with the ask budget each moment always had, in both languages', () => {
    for (const request of EVERY_KIND) {
      for (const language of ['en', 'fr'] as const) {
        const input = dutyLineInput(request, language);
        expect(input.skill).toBe(DUTY_VOICE_SKILL);
        expect(input.kind).toBe(request.kind);
        expect(input.language).toBe(language);
        expect(input.questions).toBe(ASKS.has(request.kind) ? 1 : 0);
        expect(input.maxChars).toBe(
          request.kind === 'week_overview' ? DUTY_OVERVIEW_MAX_CHARS : DUTY_MAX_CHARS,
        );
      }
    }
  });

  it('speaks to the group as vous, and to one named parent as tu', () => {
    for (const request of EVERY_KIND) {
      expect(dutyLineInput(request, 'fr').address).toBe(
        TO_ONE_PARENT.has(request.kind) ? 'tu' : 'vous',
      );
    }
  });

  it('every kind forbids a keyword ask, a booking claim, scorekeeping and Hale driving anyone', () => {
    for (const request of EVERY_KIND) {
      const names = dutyLineInput(request, 'en').forbidden?.map((rule) => rule.name) ?? [];
      expect(names).toEqual(['keyword_ask', 'booking_claim', 'scorekeeping', 'hale_drives']);
    }
  });

  it('makes every line carry every name, day, event and time it was handed', () => {
    expect(
      dutyLineInput(
        { kind: 'reask', kid: 'Maya', event: 'swim', day: 'Tuesday', time: '3:00pm' },
        'en',
      ).mustMention,
    ).toEqual(['Maya', 'swim', 'Tuesday', '3:00pm']);
    expect(
      dutyLineInput(
        { kind: 'both_claimed', event: 'swim', day: 'mardi', parentA: 'Sam', parentB: 'Jo' },
        'fr',
      ).mustMention,
    ).toEqual(['swim', 'mardi', 'Sam', 'Jo']);
    expect(
      dutyLineInput({ kind: 'which_kid', name: 'Sam', kids: ['Maya', 'Leo'] }, 'en').mustMention,
    ).toEqual(['Sam', 'Maya', 'Leo']);
    const owner = dutyLineInput(
      {
        kind: 'owner',
        owner: 'Sam',
        kid: 'Maya',
        event: 'swim',
        day: 'Tuesday',
        time: '3:00pm',
        recorded: true,
      },
      'en',
    );
    expect(owner.facts).toEqual({
      owner: 'Sam',
      kid: 'Maya',
      event: 'swim',
      day: 'Tuesday',
      time: '3:00pm',
      recorded: true,
    });
    expect(owner.mustMention).toEqual(['Sam', 'Maya', 'swim', 'Tuesday', '3:00pm']);
  });

  it('hands the overview every entry as day, event and owner, and makes it carry each owner it has', () => {
    const input = dutyLineInput(EVERY_KIND[0] as DutyLineRequest, 'en');
    expect(input.facts).toEqual({
      entries: [
        { day: 'Monday', event: 'swim', owner: 'Sam' },
        { day: 'Thursday', event: 'piano', owner: null },
      ],
    });
    // A null owner is not a slot: "nobody yet" is the model's to say, in its own words.
    expect(input.mustMention).toEqual(['Monday', 'swim', 'Sam', 'Thursday', 'piano']);
  });

  it('cuts a busy week at the first six entries rather than handing the model a line it cannot fit', () => {
    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const entries = days.map((day) => ({ day, event: 'swim', owner: null }));
    expect(overviewEntries(entries)).toHaveLength(DUTY_OVERVIEW_MAX_ENTRIES);
    const input = dutyLineInput({ kind: 'week_overview', entries }, 'en');
    expect(input.mustMention).not.toContain('Sunday');
    expect(JSON.stringify(input.facts)).not.toContain('Sunday');
  });

  it('the fake composer satisfies every kind, so the plumbing tests have a body to send', () => {
    for (const request of EVERY_KIND) {
      for (const language of ['en', 'fr'] as const) {
        const input = dutyLineInput(request, language);
        expect(judgeSpokenLine(fakeSpokenLineBody(input), input)).toEqual({ ok: true });
      }
    }
  });

  it('refuses the lane red lines in a real line', () => {
    const reask = dutyLineInput(
      { kind: 'reask', kid: 'Maya', event: 'swim', day: 'Tuesday', time: '3:00pm' },
      'en',
    );
    expect(
      judgeSpokenLine("Still nobody on Maya's swim, Tuesday at 3:00pm. Who's taking it?", reask),
    ).toEqual({ ok: true });
    // "Reply YES" is on the judge's own banned list; the lane's rule catches the rest of
    // the old keyword vocabulary too.
    expect(
      judgeSpokenLine(
        "Still nobody on Maya's swim, Tuesday at 3:00pm. Text DAILY if you take it?",
        reask,
      ),
    ).toMatchObject({ ok: false, reason: 'forbidden:keyword_ask' });
    expect(
      judgeSpokenLine("Maya's swim, Tuesday at 3:00pm - your turn, Jo. Who's taking it?", reask),
    ).toMatchObject({ ok: false, reason: 'forbidden:scorekeeping' });
    expect(
      judgeSpokenLine(
        "Nobody has Maya's swim, Tuesday at 3:00pm. I'll drive if nobody can?",
        reask,
      ),
    ).toMatchObject({ ok: false, reason: 'forbidden:hale_drives' });

    const night = dutyLineInput(
      { kind: 'night_before', owner: 'Sam', kid: 'Maya', event: 'swim', time: '3:00pm' },
      'en',
    );
    expect(
      judgeSpokenLine(
        "Tomorrow Sam has Maya's swim at 3:00pm. If that changes, just say so here.",
        night,
      ),
    ).toEqual({ ok: true });
    // No question where the moment allows none, even a natural one.
    expect(
      judgeSpokenLine("Tomorrow Sam has Maya's swim at 3:00pm. Still the plan?", night),
    ).toMatchObject({ ok: false });
    // A time the lane never gave is invented.
    expect(
      judgeSpokenLine("Tomorrow Sam has Maya's swim at 3:00pm, so leave by 2:30pm.", night),
    ).toMatchObject({ ok: false, reason: 'invented' });
  });

  it('holds the French register the moment gives', () => {
    const toGroup = dutyLineInput(
      { kind: 'both_claimed', event: 'natation', day: 'mardi', parentA: 'Sam', parentB: 'Jo' },
      'fr',
    );
    expect(
      judgeSpokenLine(
        'Vous avez dit tous les deux que vous aviez natation mardi. Qui le prend, Sam ou Jo ?',
        toGroup,
      ),
    ).toEqual({ ok: true });
    const toOne = dutyLineInput(
      { kind: 'silent_parent', name: 'Jo', event: 'natation', day: 'mardi' },
      'fr',
    );
    expect(judgeSpokenLine('Jo, à toi de nous dire pour natation mardi.', toOne)).toEqual({
      ok: true,
    });
    expect(judgeSpokenLine('Jo, à vous de nous dire pour natation mardi.', toOne)).toMatchObject({
      ok: false,
      reason: 'french',
    });
  });
});
