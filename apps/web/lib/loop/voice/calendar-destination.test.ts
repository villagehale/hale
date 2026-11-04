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
  { row: 'a +1 number in year and day groups', destination: '+1 2027 2026 23' },
  { row: "a +1 number in the start's own numbers", destination: '+1 2026 07 23 10 30' },
  { row: 'a number in year groups next to the start', destination: '2027 2026 23' },
  { row: 'a +44 number shaped as a season', destination: '+44 2026-2027' },
  { row: 'a short number in front of a date', destination: '20 23.07.2026' },
  {
    row: 'a phone in Arabic-Indic digits',
    destination: '\u0665\u0665\u0665\u0660\u0661\u0660\u0664\u0664\u0667\u0667',
  },
  {
    row: 'a phone in Devanagari digits',
    destination: '\u096B\u096B\u096B\u0966\u0967\u0966\u096A\u096A\u096D\u096D',
  },
  { row: 'a phone with middle dots', destination: '555\u00B7010\u00B74477' },
  { row: 'a phone with hyphenation points', destination: '555\u2027010\u20274477' },
  { row: 'a phone with underscores', destination: '555_010_4477' },
  { row: 'a lookalike dot (Vai full stop)', destination: 'swim\uA60Eexample' },
  { row: 'an email address with no dotted domain', destination: 'desk@pool' },
  { row: 'a mailto address', destination: 'mailto:desk@pool' },
  { row: 'a scheme with no dotted host', destination: 'swimclub://join' },
];

/** Words that look dotted or numbered and are not a destination. */
const CONTROLS: readonly { row: string; words: string }[] = [
  { row: 'a time in the name', words: 'Swim lesson 9:30' },
  { row: 'an abbreviation', words: "St. Mary's" },
  { row: 'a decimal distance', words: '2.5 km' },
  { row: 'a date', words: '11/04' },
  { row: 'a time range', words: '9:30-10:30' },
  { row: 'a school year around the start', words: 'Fall swim 2026-2027' },
  { row: 'a short season', words: 'Fall swim 2026-27' },
  { row: 'an age group and a season', words: 'Soccer U12 2026-2027' },
  { row: 'a grade and a season', words: 'Grade 5 2026-2027 swim' },
  { row: 'a level and a spaced season', words: 'Swim Level 3 2026 - 2027' },
  { row: 'a course number and a year', words: 'Swim 101 2026' },
  { row: 'an age range and a year', words: 'Ages 6-12 2026' },
  { row: 'a wide age range and a year', words: 'Ages 10-14 2026' },
  { row: 'a class year and a season', words: 'Class of 2030 2026-2027' },
  { row: 'a spaced at sign', words: 'Swim @ Riverside' },
  {
    row: 'a date in Arabic-Indic digits',
    words: 'Swim class \u0662\u0663.\u0660\u0667.\u0662\u0660\u0662\u0666',
  },
  {
    row: 'a season in Devanagari digits',
    words: 'Swim \u0968\u0966\u0968\u096C-\u0968\u0966\u0968\u096D',
  },
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

  it('a day.month.year date is a date, not a phone number; the same digits as no date are', () => {
    expect(
      calendarInviteRefusals(`Swim class am 23.07.2026 um 10:30. ${INVITE_LINK_SLOT}`, INVITE),
    ).not.toContain('carries_destination');
    expect(
      calendarCancelRefusals('Swim class am 23.07.2026 um 10:30 ist abgesagt.', CANCEL),
    ).not.toContain('carries_destination');
    expect(
      calendarInviteRefusals(`Swim class am 23.17.2026 um 10:30. ${INVITE_LINK_SLOT}`, INVITE),
    ).toContain('carries_destination');
    expect(
      calendarCancelRefusals('Swim class am 23.17.2026 um 10:30 ist abgesagt.', CANCEL),
    ).toContain('carries_destination');
  });

  it('another day is a date too; a digit the writer invented is refused as one', () => {
    const invite = calendarInviteRefusals(
      `Swim class am 23.07.2031 um 10:30. ${INVITE_LINK_SLOT}`,
      INVITE,
    );
    expect(invite).toContain('invented_number');
    expect(invite).not.toContain('carries_destination');
    const cancel = calendarCancelRefusals(
      'Swim class am 23.07.2031 um 10:30 ist abgesagt.',
      CANCEL,
    );
    expect(cancel).toContain('invented_number');
    expect(cancel).not.toContain('carries_destination');
  });
});

describe('VIL-588 · a phone number is a phone even when every group is a number of the start', () => {
  /** Fri, Jan 23 2026, 8:30 AM in Denver (MST, UTC-7): 1, 2026, 23, 8 and 30 are all its own. */
  const january = { startsAt: new Date('2026-01-23T15:30:00.000Z'), timeZone: TIME_ZONE };
  const when = 'Fri, Jan 23 at 8:30 AM';
  const numbers = ['+1 2027 2026 23', '+1 2026 01 23 08 30', '2027 2026 23'];

  for (const number of numbers) {
    it(`holds the title and refuses the text: ${number}`, async () => {
      const summary = `Swim class ${number}`;
      const invite = writer(echoInvite);
      expect(
        await createCalendarInviteVoice(() => invite.client, agrees()).compose({
          ...INVITE,
          ...january,
          when,
          summary,
        }),
      ).toEqual({ status: 'deferred', reason: 'summary_carries_destination' });
      const cancel = writer(echoCancel);
      expect(
        await createCalendarCancelVoice(() => cancel.client, agrees()).compose({
          ...CANCEL,
          ...january,
          when,
          summary,
        }),
      ).toEqual({ status: 'deferred', reason: 'summary_carries_destination' });
      expect(invite.calls() + cancel.calls()).toBe(0);
      expect(
        calendarInviteRefusals(`Swim class, ${when}, call ${number} ${INVITE_LINK_SLOT}`, {
          ...INVITE,
          ...january,
          when,
        }),
      ).toContain('carries_destination');
      expect(
        calendarCancelRefusals(`Swim class, ${when}, is off, call ${number}`, {
          ...CANCEL,
          ...january,
          when,
        }),
      ).toContain('carries_destination');
    });
  }
});

describe('VIL-588 · in an event title every ideographic stop is a dot', () => {
  const summary = '\u4F8B\u5B50\u3002\u4E2D\u56FD';

  it('invite: a Han-label domain written with the ideographic stop is held', async () => {
    const w = writer(echoInvite);
    const outcome = await createCalendarInviteVoice(() => w.client, agrees()).compose({
      ...INVITE,
      summary,
    });
    expect(outcome).toEqual({ status: 'deferred', reason: 'summary_carries_destination' });
    expect(w.calls()).toBe(0);
  });

  it('cancel: a Han-label domain written with the ideographic stop is held', async () => {
    const w = writer(echoCancel);
    const outcome = await createCalendarCancelVoice(() => w.client, agrees()).compose({
      ...CANCEL,
      summary,
    });
    expect(outcome).toEqual({ status: 'deferred', reason: 'summary_carries_destination' });
    expect(w.calls()).toBe(0);
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
