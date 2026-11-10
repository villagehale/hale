import Anthropic from '@anthropic-ai/sdk';
import type { AgentClient } from '@hale/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RecordAgentRunInput } from '~/lib/agent-run';
import { GENERIC_DESCRIPTOR } from '~/lib/loop/templates/reminder/core';
import type { ReminderChild } from '~/lib/loop/templates/reminder/payload';
import {
  type ReminderFactEvent,
  composeReminderTexts,
  isAllDay,
  localClockFact,
  relativeDay,
  reminderFacts,
  reminderRefusals,
  reminderUserMessage,
} from './compose';

const TZ = 'America/Toronto';
const NOW = new Date('2026-10-25T22:00:00Z'); // Sun Oct 25, 6:00 PM EDT
const TEEN: ReminderChild = {
  id: 'c-teen',
  name: 'Rowan',
  dateOfBirth: '2011-03-01',
  gender: null,
};
const KID: ReminderChild = { id: 'c-kid', name: 'Mia', dateOfBirth: '2019-03-01', gender: 'girl' };

function ev(over: Partial<ReminderFactEvent> = {}): ReminderFactEvent {
  return {
    eventRef: 'e1',
    title: 'Jour de congé',
    startsAt: '2026-10-26T19:00:00Z', // 3:00 PM EDT
    endsAt: '2026-10-26T20:00:00Z', // 4:00 PM EDT
    childId: null,
    sensitive: false,
    location: 'Georgetown library',
    ...over,
  };
}

function facts(events: ReminderFactEvent[], children: ReminderChild[] = [], language = 'fr') {
  return reminderFacts({
    events,
    children,
    level: 'first_name',
    timeZone: TZ,
    offset: '-P1D',
    now: NOW,
    planLink: null,
    language,
  });
}

describe('reminderFacts — the facts the model writes the whole text from', () => {
  it('a timed event carries its date, start AND end with AM/PM, place and the language', () => {
    expect(facts([ev()])).toEqual({
      offset: '-P1D',
      now: { date: 'Sunday, October 25, 2026', time: '6:00 PM' },
      events: [
        {
          what: 'Jour de congé',
          for: null,
          day: 'tomorrow',
          date: 'Monday, October 26, 2026',
          allDay: false,
          start: '3:00 PM',
          end: '4:00 PM',
          // Sun 6:00 PM to Mon 3:00 PM is 21 hours.
          minutesUntilStart: 1260,
          location: 'Georgetown library',
          changed: null,
        },
      ],
      planLink: null,
      language: 'fr',
    });
  });

  it('keeps AM distinct from PM', () => {
    expect(localClockFact(new Date('2026-10-26T13:30:00Z'), TZ)).toBe('9:30 AM');
    expect(localClockFact(new Date('2026-10-27T01:30:00Z'), TZ)).toBe('9:30 PM');
  });

  it('an all-day event carries no clock time', () => {
    const allDay = ev({
      title: 'PD Day',
      startsAt: '2026-10-26T04:00:00Z',
      endsAt: '2026-10-27T04:00:00Z',
      location: null,
    });
    expect(facts([allDay], [], 'en').events[0]).toEqual({
      what: 'PD Day',
      for: null,
      day: 'tomorrow',
      date: 'Monday, October 26, 2026',
      allDay: true,
      start: null,
      end: null,
      minutesUntilStart: null,
      location: null,
      changed: null,
    });
  });

  it('a private (teen) event is the bare generic with no place', () => {
    const f = facts([ev({ title: 'therapy', childId: 'c-teen', location: '1 Clinic Rd' })], [TEEN]);
    expect(f.events[0]).toMatchObject({ what: 'an appointment', location: null });
    expect(reminderUserMessage(f)).not.toMatch(/Rowan|therapy|Clinic/);
  });

  it('attributes a younger child at the parent name level', () => {
    expect(facts([ev({ title: 'Swim', childId: 'c-kid' })], [KID]).events[0]).toMatchObject({
      what: 'Swim',
      for: 'Mia',
    });
  });

  it('never hands the model a "child — title" label', () => {
    const msg = reminderUserMessage(facts([ev({ title: 'Swim', childId: 'c-kid' })], [KID]));
    expect(msg).not.toContain('—');
  });

  it('a private event names no child', () => {
    const f = facts([ev({ title: 'therapy', childId: 'c-teen' })], [TEEN]);
    expect(f.events[0]).toMatchObject({ what: 'an appointment', for: null });
  });

  it('says the day from the send moment: today, tomorrow, or null further out', () => {
    expect(
      relativeDay(new Date('2026-10-26T14:00:00Z'), new Date('2026-10-26T11:00:00Z'), TZ),
    ).toBe('today');
    expect(relativeDay(new Date('2026-10-26T19:00:00Z'), NOW, TZ)).toBe('tomorrow');
    // 11:30 PM local on Sunday is still Sunday, not Monday (UTC already rolled over).
    expect(relativeDay(new Date('2026-10-26T03:30:00Z'), NOW, TZ)).toBe('today');
    expect(relativeDay(new Date('2026-10-28T19:00:00Z'), NOW, TZ)).toBeNull();
    // Across the DST change (Nov 1, 2026): Sat evening -> Sun is still tomorrow.
    expect(
      relativeDay(new Date('2026-11-01T15:00:00Z'), new Date('2026-10-31T22:00:00Z'), TZ),
    ).toBe('tomorrow');
  });
});

/**
 * VIL-550 · the writer said "about an hour" for an event 18 minutes away: the hourly tick
 * sends a T-1h anywhere from 0 to 60 minutes before the start. It gets the exact minutes,
 * so its words can match the clock. Chicago is CDT (UTC-5) before Nov 1.
 */
describe('reminderFacts — minutesUntilStart, the exact gap the writer phrases (VIL-550)', () => {
  const CHICAGO = 'America/Chicago';
  const at = (now: string, over: Partial<ReminderFactEvent> = {}) =>
    reminderFacts({
      events: [
        ev({ title: 'Toddler gym', startsAt: '2026-10-26T15:30:00Z', endsAt: null, ...over }),
      ],
      children: [],
      level: 'first_name',
      timeZone: CHICAGO,
      offset: '-PT1H',
      now: new Date(now),
      planLink: null,
      language: 'en',
    });

  it('is 18 for a 10:30 AM event at the 10:12 AM tick', () => {
    const facts = at('2026-10-26T15:12:00Z');
    expect(facts.now.time).toBe('10:12 AM');
    expect(facts.events[0]).toMatchObject({ start: '10:30 AM', minutesUntilStart: 18 });
  });

  it('is 60 an hour out, and rounds to the nearest whole minute', () => {
    expect(at('2026-10-26T14:30:00Z').events[0]?.minutesUntilStart).toBe(60);
    expect(at('2026-10-26T15:12:30Z').events[0]?.minutesUntilStart).toBe(18);
  });

  it('is null for an all-day item, which has no clock start', () => {
    const allDay = at('2026-10-25T22:00:00Z', {
      startsAt: '2026-10-26T05:00:00Z',
      endsAt: '2026-10-27T05:00:00Z',
    });
    expect(allDay.events[0]).toMatchObject({ allDay: true, minutesUntilStart: null });
  });
});

describe('isAllDay', () => {
  it('midnight to midnight is all-day; a 3-4 PM event is not', () => {
    expect(isAllDay(new Date('2026-10-26T04:00:00Z'), new Date('2026-10-27T04:00:00Z'), TZ)).toBe(
      true,
    );
    expect(isAllDay(new Date('2026-10-26T04:00:00Z'), null, TZ)).toBe(true);
    expect(isAllDay(new Date('2026-10-26T19:00:00Z'), new Date('2026-10-26T20:00:00Z'), TZ)).toBe(
      false,
    );
    expect(isAllDay(new Date('2026-10-26T04:00:00Z'), new Date('2026-10-26T05:00:00Z'), TZ)).toBe(
      false,
    );
  });
});

describe('reminderRefusals — structure only, never wording', () => {
  const f = facts([ev()]);
  it('refuses no texts, an empty text, and any link not handed', () => {
    expect(reminderRefusals([], f)).toEqual(['empty']);
    expect(reminderRefusals(['  '], f)).toEqual(['empty']);
    expect(reminderRefusals(['ok', ' '], f)).toEqual(['empty_text']);
    expect(reminderRefusals(['ok', 'Voir https://evil.example'], f)).toEqual(['other_link']);
    expect(reminderRefusals(['Demain à 15 h, bingo à la bibliothèque.'], f)).toEqual([]);
  });
  it('has no character cap and no text-count cap (VIL-467)', () => {
    expect(reminderRefusals(['x'.repeat(2000)], f)).toEqual([]);
    expect(
      reminderRefusals(
        Array.from({ length: 9 }, (_, i) => `text ${i}`),
        f,
      ),
    ).toEqual([]);
  });
  it('allows the handed plan link', () => {
    const withLink = { ...f, planLink: 'https://app.villagehale.com/plan' };
    expect(reminderRefusals(['Plan: https://app.villagehale.com/plan'], withLink)).toEqual([]);
  });
});

/**
 * VIL-551 · two things the same morning whose times run into each other. The writer said
 * "both are on Thursday morning" and never that they overlap: an overlap read off two
 * clock strings is an inference the skill forbids, so code states it as a fact.
 */
describe('reminderFacts — overlaps, the clash stated as a fact (VIL-551)', () => {
  const at = (startsAt: string, endsAt: string | null, title: string, eventRef: string) =>
    ev({ eventRef, title, startsAt, endsAt });
  const swim = at('2026-10-26T14:00:00Z', '2026-10-26T15:00:00Z', 'Swim', 'e1'); // 10-11 AM
  const swimTimes = { startsAt: swim.startsAt, endsAt: swim.endsAt };

  it('names, on each event, the other events whose times run into it', () => {
    const [a, b] = facts([swim, at('2026-10-26T14:30:00Z', '2026-10-26T15:30:00Z', 'Art', 'e2')])
      .events;
    expect(a?.overlaps).toEqual(['Art']);
    expect(b?.overlaps).toEqual(['Swim']);
  });

  it('an event with no end overlaps one it starts inside, or one starting with it', () => {
    const inside = facts([swim, at('2026-10-26T14:15:00Z', null, 'Dentist', 'e2')]).events;
    expect(inside[1]?.overlaps).toEqual(['Swim']);
    const same = facts([
      at('2026-10-26T14:00:00Z', null, 'Dentist', 'e1'),
      at('2026-10-26T14:00:00Z', null, 'Photos', 'e2'),
    ]).events;
    expect(same[0]?.overlaps).toEqual(['Photos']);
  });

  it('back-to-back, apart, or all-day is no overlap, and adds no key', () => {
    const plain = facts([
      swim,
      at('2026-10-26T15:00:00Z', '2026-10-26T16:00:00Z', 'Art', 'e2'), // starts as swim ends
      at('2026-10-26T19:00:00Z', null, 'Piano', 'e3'),
      at('2026-10-26T04:00:00Z', '2026-10-27T04:00:00Z', 'PD Day', 'e4'), // all day
    ]).events;
    for (const event of plain) expect(event).not.toHaveProperty('overlaps');
  });

  it('a teen event a sibling’s overlaps names is the generic descriptor, never its title', () => {
    const [teen, sibling] = reminderFacts({
      events: [
        ev({ eventRef: 'e1', title: 'therapy', childId: 'c-teen', ...swimTimes }),
        ev({ eventRef: 'e2', title: 'Swim', childId: 'c-kid', ...swimTimes }),
      ],
      children: [TEEN, KID],
      level: 'first_name',
      timeZone: TZ,
      offset: '-P1D',
      now: NOW,
      planLink: null,
      language: 'en',
    }).events;
    // Positive control: the two do overlap, and the sibling's own title still reaches the teen's.
    expect(teen?.overlaps).toEqual(['Swim']);
    expect(sibling?.overlaps).toEqual([GENERIC_DESCRIPTOR]);
    expect(JSON.stringify(sibling)).not.toMatch(/therapy|Rowan/);
  });
});

describe('reminderFacts — parking and what to bring (VIL-468)', () => {
  it('passes stated parking and bring facts through as written', () => {
    const [event] = facts([
      ev({ notes: { parking: 'Lot B behind the rink', bring: 'skates and a helmet' } }),
    ]).events;
    expect(event).toMatchObject({ parking: 'Lot B behind the rink', bring: 'skates and a helmet' });
  });

  it('adds no key when nothing was stated, so the request is unchanged', () => {
    const plain = reminderUserMessage(facts([ev()]));
    expect(reminderUserMessage(facts([ev({ notes: null })]))).toBe(plain);
    expect(reminderUserMessage(facts([ev({ notes: { parking: '  ' } })]))).toBe(plain);
    expect(facts([ev()]).events[0]).not.toHaveProperty('parking');
    expect(facts([ev()]).events[0]).not.toHaveProperty('bring');
  });

  it('a private event carries no logistics, like its place', () => {
    const [event] = facts([
      ev({ sensitive: true, notes: { parking: 'Lot B', bring: 'health card' } }),
    ]).events;
    expect(event?.location).toBeNull();
    expect(event).not.toHaveProperty('parking');
    expect(event).not.toHaveProperty('bring');
  });
});

/**
 * VIL-563 · why nothing was written, named. A fake client stands at the AgentClient port
 * (mechanics only, the structured.test.ts pattern): it answers in whichever shape the
 * request asked for, or throws what the SDK throws. The wording is the eval's job.
 */
describe('composeReminderTexts names why nothing was written (VIL-563)', () => {
  afterEach(() => vi.restoreAllMocks());

  const USAGE = {
    input_tokens: 1000,
    output_tokens: 100,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  type Reply = { texts: string[] } | 'truncated' | unknown;

  function apiError(status: number, type: string, message: string): unknown {
    return Anthropic.APIError.generate(
      status,
      { type: 'error', error: { type, message } },
      undefined,
      { 'request-id': 'req_probe' },
    );
  }
  const SERVER_ERROR = () => apiError(500, 'api_error', 'Internal server error');
  const OVERLOADED = () => apiError(503, 'overloaded_error', 'Overloaded');
  const USAGE_LIMIT = () =>
    apiError(
      400,
      'invalid_request_error',
      'You have reached your specified API usage limits. You will regain access on 2026-12-01 at 00:00 UTC.',
    );

  function answer(request: { tools?: unknown[] }, input: { texts: string[] }): Anthropic.Message {
    const content = request.tools
      ? [{ type: 'tool_use', id: 'tu_0', name: 'reminder_texts', input }]
      : [{ type: 'text', text: JSON.stringify(input) }];
    return {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'test',
      stop_reason: request.tools ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      usage: USAGE,
      content,
    } as unknown as Anthropic.Message;
  }

  function fakeClient(...replies: Reply[]) {
    const create = vi.fn(async (request: { tools?: unknown[] }) => {
      if (replies.length === 0) throw new Error('fake client: no reply left');
      const next = replies.shift();
      if (next === 'truncated') {
        return {
          ...answer(request, { texts: ['cut'] }),
          stop_reason: 'max_tokens',
          content: [{ type: 'text', text: '{"texts":["cu' }],
        } as unknown as Anthropic.Message;
      }
      if (next && typeof next === 'object' && 'texts' in next) {
        return answer(request, next as { texts: string[] });
      }
      throw next;
    });
    return { client: { messages: { create } } as unknown as AgentClient, create };
  }

  const near = reminderFacts({
    events: [ev({ title: 'Toddler gym', startsAt: '2026-10-26T15:30:00Z', endsAt: null })],
    children: [],
    level: 'first_name',
    timeZone: 'America/Chicago',
    offset: '-PT1H',
    now: new Date('2026-10-26T15:12:00Z'),
    planLink: null,
    language: 'en',
  });

  async function compose(...replies: Reply[]) {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client, create } = fakeClient(...replies);
    const runs: RecordAgentRunInput[] = [];
    const outcome = await composeReminderTexts(client, near, 'fam-1', async (run) => {
      runs.push(run);
    });
    return { outcome, runs, create };
  }

  it('a provider error on both attempts is unavailable, not refused, with a failed run per attempt', async () => {
    const { outcome, runs, create } = await compose(SERVER_ERROR(), SERVER_ERROR());
    expect(outcome).toEqual({
      status: 'unavailable',
      cause: 'transient',
      httpStatus: 500,
      errorType: 'api_error',
    });
    expect(create).toHaveBeenCalledTimes(2);
    expect(runs).toHaveLength(2);
    for (const run of runs) {
      expect(run).toMatchObject({
        familyId: 'fam-1',
        agentName: 'reminder-voice',
        modelUsed: 'claude-sonnet-5-5',
        status: 'failed',
        promptTokens: 0,
        completionTokens: 0,
        costUsd: 0,
      });
    }
  });

  it('a usage limit stops at the first attempt: a second call cannot succeed', async () => {
    const { outcome, runs, create } = await compose(USAGE_LIMIT(), { texts: ['unreached'] });
    expect(outcome).toEqual({
      status: 'unavailable',
      cause: 'usage_limit',
      httpStatus: 400,
      errorType: 'invalid_request_error',
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(runs).toHaveLength(1);
  });

  it('two answers with a link nobody handed are refused, which is terminal', async () => {
    const linked = { texts: ['Toddler gym soon, details at https://example.com/x'] };
    const { outcome, runs } = await compose(linked, linked);
    expect(outcome).toEqual({ status: 'refused', refusals: ['other_link'] });
    expect(runs.map((run) => run.status)).toEqual(['failed', 'failed']);
  });

  it('a refused answer then a provider error is unavailable, so the reminder is not lost', async () => {
    const linked = { texts: ['Toddler gym soon, details at https://example.com/x'] };
    const { outcome } = await compose(linked, OVERLOADED());
    expect(outcome).toEqual({
      status: 'unavailable',
      cause: 'transient',
      httpStatus: 503,
      errorType: 'overloaded_error',
    });
  });

  it('two answers cut off at the token budget are refused: the model answered, unusably', async () => {
    const { outcome } = await compose('truncated', 'truncated');
    expect(outcome).toEqual({ status: 'refused', refusals: ['structured:truncated'] });
  });

  it('a throw that is not the provider is our bug: rejected as unexpected after one call', async () => {
    const { outcome, runs, create } = await compose(new TypeError('a bug'), {
      texts: ['unreached'],
    });
    expect(outcome).toEqual({
      status: 'rejected',
      cause: 'unexpected',
      httpStatus: null,
      errorType: null,
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(runs.map((run) => run.status)).toEqual(['failed']);
  });

  it('a 400 that is not a usage limit is Hale’s own request: rejected as bad_request after one call', async () => {
    const badRequest = apiError(400, 'invalid_request_error', 'messages: invalid shape');
    const { outcome, runs, create } = await compose(badRequest, { texts: ['unreached'] });
    expect(outcome).toEqual({
      status: 'rejected',
      cause: 'bad_request',
      httpStatus: 400,
      errorType: 'invalid_request_error',
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ agentName: 'reminder-voice', status: 'failed', costUsd: 0 });
  });

  it.each([
    [408, 'timeout_error'],
    [409, 'conflict_error'],
  ])(
    'a %i is retryable, not Hale’s request: unavailable after both attempts',
    async (status, type) => {
      const retryable = () => apiError(status, type, 'try again');
      const { outcome, runs, create } = await compose(retryable(), retryable());
      expect(outcome).toEqual({
        status: 'unavailable',
        cause: 'transient',
        httpStatus: status,
        errorType: type,
      });
      expect(create).toHaveBeenCalledTimes(2);
      expect(runs).toHaveLength(2);
    },
  );

  it.each([
    [401, 'authentication_error', 'invalid x-api-key', 'auth', 1],
    [403, 'permission_error', 'Your API key does not have permission', 'auth', 1],
    [429, 'rate_limit_error', 'Number of requests has exceeded your rate limit', 'quota', 2],
    [
      400,
      'invalid_request_error',
      'Your credit balance is too low to access the Anthropic API.',
      'billing',
      1,
    ],
  ])(
    'a %i %s is %s, which clears without a code change: held as unavailable, never rejected',
    async (status, type, message, cause, calls) => {
      const failure = () => apiError(status, type, message);
      const { outcome, runs, create } = await compose(failure(), failure());
      expect(outcome).toEqual({ status: 'unavailable', cause, httpStatus: status, errorType: type });
      expect(create).toHaveBeenCalledTimes(calls);
      expect(runs).toHaveLength(calls);
    },
  );

  it('positive control: an overload on both attempts stays unavailable, with a run per attempt', async () => {
    const { outcome, runs, create } = await compose(OVERLOADED(), OVERLOADED());
    expect(outcome).toEqual({
      status: 'unavailable',
      cause: 'transient',
      httpStatus: 503,
      errorType: 'overloaded_error',
    });
    expect(create).toHaveBeenCalledTimes(2);
    expect(runs).toHaveLength(2);
  });

  it('two answers that fail the output schema are refused as schema: the model answered, unusably', async () => {
    const { outcome, runs } = await compose({ texts: [] }, { texts: [] });
    expect(outcome).toEqual({ status: 'refused', refusals: ['schema'] });
    expect(runs.map((run) => run.status)).toEqual(['failed', 'failed']);
  });

  it("a 400 that quotes the request logs only the provider's status and error type, never its message", async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const quoting = () =>
      apiError(400, 'invalid_request_error', 'messages.0.content: "Toddler gym" is not valid');
    const { outcome } = await compose(quoting(), quoting());

    expect(outcome).toEqual({
      status: 'rejected',
      cause: 'bad_request',
      httpStatus: 400,
      errorType: 'invalid_request_error',
    });
    const logged = [console.warn, console.error, console.info].flatMap(
      (log) => vi.mocked(log).mock.calls,
    );
    // Positive control: the attempt was logged, with what tells a bad request from an outage.
    expect(console.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        cause: 'bad_request',
        httpStatus: 400,
        errorType: 'invalid_request_error',
      }),
      'reminder: compose failed',
    );
    expect(JSON.stringify(logged)).not.toContain('Toddler gym');
  });

  it('positive control: a usable answer is written, with one completed, costed run', async () => {
    const { outcome, runs, create } = await compose({ texts: ['Toddler gym at 10:30 AM.'] });
    expect(outcome).toEqual({
      status: 'written',
      draft: { texts: ['Toddler gym at 10:30 AM.'], bold: null },
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(runs).toHaveLength(1);
    // Sonnet at $2 in and $10 out per MTok: 1000 x 2 / 1e6 + 100 x 10 / 1e6.
    expect(runs[0]).toMatchObject({
      agentName: 'reminder-voice',
      status: 'completed',
      promptTokens: 1000,
      completionTokens: 100,
    });
    expect(runs[0]?.costUsd).toBeCloseTo(0.003, 9);
  });
});
