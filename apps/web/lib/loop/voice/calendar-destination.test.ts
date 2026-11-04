import type { AgentClient } from '@hale/agent';
import { describe, expect, it } from 'vitest';
import {
  type CalendarCancelRequest,
  calendarCancelRefusals,
  createCalendarCancelVoice,
} from './calendar-cancel-voice';
import {
  type CalendarInviteTimeInput,
  type CalendarInviteTimeJudge,
  type CalendarInviteVoiceRequest,
  INVITE_LINK_SLOT,
  calendarInviteRefusals,
  createCalendarInviteVoice,
} from './calendar-invite-voice';

/*
 * VIL-588 · one destination gate for every calendar text Hale writes from an event title.
 * The evasion table below runs through BOTH voices, twice each: as the event title (the
 * text is held before any model call) and as words the writer put in its text (refused
 * as `carries_destination`). Each row's verdict is derived from the invariant: a phone
 * would open it, dial it, or mail it, so it is a destination code did not put there.
 */

const LINK = 'https://app.example.test/api/ics/event/abc.def';

/** Thu, Jul 23 2026, 10:30 AM in Denver (MDT, UTC-6). */
const STARTS = new Date('2026-07-23T16:30:00.000Z');
const WHEN = 'Thu, Jul 23 at 10:30 AM';
const TIME_ZONE = 'America/Denver';

const INVITE: CalendarInviteVoiceRequest = {
  summary: 'Swim class',
  when: WHEN,
  url: LINK,
  startsAt: STARTS,
  timeZone: TIME_ZONE,
  language: 'en',
};

const CANCEL: CalendarCancelRequest = {
  summary: 'Swim class',
  when: WHEN,
  startsAt: STARTS,
  timeZone: TIME_ZONE,
};

const EVASIONS: readonly { row: string; destination: string }[] = [
  { row: 'full-width dots', destination: 'swim\uFF0Eexample\uFF0Eorg' },
  { row: 'halfwidth ideographic dot', destination: 'swim\uFF61example' },
  { row: 'ideographic dot', destination: 'swim\u3002example' },
  {
    row: 'Cyrillic TLD',
    destination: '\u043F\u043B\u0430\u0432\u0430\u043D\u0438\u0435.\u0440\u0444',
  },
  { row: 'punycode TLD', destination: 'swim.xn--p1ai' },
  { row: 'zero-width joiners inside a domain', destination: 'swim\u200D.\u200Dexample' },
  { row: 'phone with dots', destination: '555.010.4477' },
  { row: 'phone with spaces', destination: '555 010 4477' },
  { row: 'phone with dashes', destination: '555-010-4477' },
  { row: 'a +1 number', destination: '+1 555 010 4477' },
  { row: 'an email address', destination: 'desk@example.test' },
  { row: 'a bare domain', destination: 'pool.example.org' },
];

/** Words that look dotted or numbered and are not a destination. */
const CONTROLS: readonly { row: string; words: string }[] = [
  { row: 'a time in the name', words: 'Swim lesson 9:30' },
  { row: 'an abbreviation', words: "St. Mary's" },
  { row: 'a decimal distance', words: '2.5 km' },
  { row: 'a date', words: '11/04' },
  { row: 'a time range', words: '9:30-10:30' },
  { row: 'a school year around the start', words: 'Fall swim 2026-2027' },
  { row: 'a French name', words: 'Cours de natation' },
  { row: 'a Chinese name', words: '游泳课' },
];

/** A writer at the client port: answers every call with the text `write` builds from the facts. */
function writer(write: (facts: { summary: string; when: string }) => string): {
  client: AgentClient;
  calls: () => number;
} {
  let calls = 0;
  const create = async (body: { messages: { content: string }[] }) => {
    calls += 1;
    const facts = JSON.parse(body.messages[0]?.content ?? '{}');
    return {
      content: [{ type: 'text', text: JSON.stringify({ text: write(facts) }) }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  };
  return { client: { messages: { create } } as unknown as AgentClient, calls: () => calls };
}

function judge(verdict: boolean | null): CalendarInviteTimeJudge & {
  seen: CalendarInviteTimeInput[];
} {
  const seen: CalendarInviteTimeInput[] = [];
  return {
    seen,
    matches: async (input) => {
      seen.push(input);
      return verdict;
    },
  };
}

const agrees = () => judge(true);
const echoInvite = (f: { summary: string; when: string }) =>
  `${f.summary}, ${f.when}. ${INVITE_LINK_SLOT}`;
const echoCancel = (f: { summary: string; when: string }) => `${f.summary}, ${f.when}, is off.`;

describe('VIL-588 · evasion table: a destination in the event title holds the text', () => {
  for (const { row, destination } of EVASIONS) {
    const summary = `Swim class - ${destination}`;

    it(`invite: ${row}`, async () => {
      const w = writer(echoInvite);
      const outcome = await createCalendarInviteVoice(() => w.client, agrees()).compose({
        ...INVITE,
        summary,
      });
      expect(outcome).toEqual({ status: 'deferred', reason: 'summary_carries_destination' });
      expect(w.calls()).toBe(0);
    });

    it(`cancel: ${row}`, async () => {
      const w = writer(echoCancel);
      const outcome = await createCalendarCancelVoice(() => w.client, agrees()).compose({
        ...CANCEL,
        summary,
      });
      expect(outcome).toEqual({ status: 'deferred', reason: 'summary_carries_destination' });
      expect(w.calls()).toBe(0);
    });
  }
});

describe('VIL-588 · evasion table: a destination the writer adds is refused', () => {
  for (const { row, destination } of EVASIONS) {
    it(`invite: ${row}`, () => {
      expect(
        calendarInviteRefusals(
          `Swim class on ${WHEN}, see ${destination} ${INVITE_LINK_SLOT}`,
          INVITE,
        ),
      ).toContain('carries_destination');
    });

    it(`cancel: ${row}`, () => {
      expect(
        calendarCancelRefusals(`Swim class on ${WHEN} is cancelled, see ${destination}`, CANCEL),
      ).toContain('carries_destination');
    });
  }
});

describe('VIL-588 · positive controls: dotted or numbered words are not a destination', () => {
  for (const { row, words } of CONTROLS) {
    it(`invite title: ${row} reaches the writer and is sent`, async () => {
      const w = writer(echoInvite);
      const outcome = await createCalendarInviteVoice(() => w.client, agrees()).compose({
        ...INVITE,
        summary: words,
      });
      expect(outcome).toEqual({ status: 'composed', body: `${words}, ${WHEN}. ${LINK}` });
    });

    it(`cancel title: ${row} reaches the writer and is sent`, async () => {
      const w = writer(echoCancel);
      const outcome = await createCalendarCancelVoice(() => w.client, agrees()).compose({
        ...CANCEL,
        summary: words,
      });
      expect(outcome).toEqual({ status: 'composed', body: `${words}, ${WHEN}, is off.` });
    });

    it(`writer text: ${row} is not refused as a destination`, () => {
      expect(
        calendarInviteRefusals(`${words}: Swim class on ${WHEN}. ${INVITE_LINK_SLOT}`, INVITE),
      ).not.toContain('carries_destination');
      expect(
        calendarCancelRefusals(`${words}: Swim class on ${WHEN} is off.`, CANCEL),
      ).not.toContain('carries_destination');
    });
  }

  it('Chinese prose ending a sentence with the ideographic stop is not a domain', () => {
    const zh = '游泳课上午10:30\u3002点这个链接';
    expect(calendarInviteRefusals(`${zh} ${INVITE_LINK_SLOT}`, INVITE)).not.toContain(
      'carries_destination',
    );
    expect(calendarCancelRefusals(zh, CANCEL)).not.toContain('carries_destination');
  });

  it("the start's own date is not a phone number; another date of that shape is", () => {
    expect(
      calendarInviteRefusals(`Swim class am 23.07.2026 um 10:30. ${INVITE_LINK_SLOT}`, INVITE),
    ).not.toContain('carries_destination');
    expect(
      calendarCancelRefusals('Swim class am 23.07.2026 um 10:30 ist abgesagt.', CANCEL),
    ).not.toContain('carries_destination');
    expect(
      calendarInviteRefusals(`Swim class am 23.07.2031 um 10:30. ${INVITE_LINK_SLOT}`, INVITE),
    ).toContain('carries_destination');
    expect(
      calendarCancelRefusals('Swim class am 23.07.2031 um 10:30 ist abgesagt.', CANCEL),
    ).toContain('carries_destination');
  });
});

describe("VIL-588 · a year range is the start's own fact only around the start", () => {
  it('holds a range that reaches past the year beside the start', async () => {
    const w = writer(echoInvite);
    const outcome = await createCalendarInviteVoice(() => w.client, agrees()).compose({
      ...INVITE,
      summary: 'Fall swim 2026-2031',
    });
    expect(outcome).toEqual({ status: 'deferred', reason: 'summary_carries_destination' });
    expect(calendarCancelRefusals(`Fall swim 2026-2031 on ${WHEN} is off.`, CANCEL)).toContain(
      'carries_destination',
    );
  });
});

describe('VIL-588 · the cancel text names the event in any language: the time judge decides', () => {
  const french = 'Le cours de natation du jeudi 23 juillet à 10 h 30 est annulé.';

  it('sends a translated name the judge agrees names this event at this start', async () => {
    const w = writer(() => french);
    const j = judge(true);
    const outcome = await createCalendarCancelVoice(() => w.client, j).compose(CANCEL);
    expect(outcome).toEqual({ status: 'composed', body: french });
    expect(j.seen).toEqual([
      {
        text: french,
        summary: 'Swim class',
        when: WHEN,
        timeZone: TIME_ZONE,
        language: null,
        starts: { year: 2026, month: 7, day: 23, hour: 10, minute: 30, weekday: 'Thursday' },
      },
    ]);
  });

  it('sends nothing when the judge says it does not name this event at this start', async () => {
    const w = writer(() => french);
    const outcome = await createCalendarCancelVoice(() => w.client, judge(false)).compose(CANCEL);
    expect(outcome).toEqual({ status: 'deferred', reason: 'gate_exhausted' });
    expect(w.calls()).toBe(3);
  });

  it('sends nothing, named, when the judge cannot say', async () => {
    const w = writer(() => french);
    const outcome = await createCalendarCancelVoice(() => w.client, judge(null)).compose(CANCEL);
    expect(outcome).toEqual({ status: 'deferred', reason: 'time_unjudged' });
  });
});
