import type { AgentClient } from '@hale/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { groupBothReaderFrench } from '~/lib/channel/linq/group-coparent-copy';
import { calendarCancelSmsText } from '~/lib/loop/templates/calendar-cancel/sms';
import { splitInviteSms } from '~/lib/loop/templates/calendar-invite/sms';
import {
  type CalendarCancelRequest,
  calendarCancelRefusals,
  createCalendarCancelVoice,
} from './calendar-cancel-voice';
import { joinDashes, textDestination, titleDestination } from './calendar-destination';
import {
  type CalendarInviteTimeInput,
  type CalendarInviteTimeJudge,
  type CalendarInviteVoiceRequest,
  INVITE_LINK_SLOT,
  MAX_INVITE_SUMMARY_CHARS,
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
  { row: 'phone with dots', destination: '202.555.0142' },
  { row: 'phone with spaces', destination: '202 555 0142' },
  { row: 'phone with dashes', destination: '202-555-0142' },
  { row: 'a +1 number', destination: '+1 202 555 0142' },
  { row: 'an email address', destination: 'desk@example.test' },
  { row: 'a bare domain', destination: 'pool.example.org' },
  { row: 'a +1 number in year and day groups', destination: '+1 2027 2026 23' },
  { row: "a +1 number in the start's own numbers", destination: '+1 2026 07 23 10 30' },
  { row: 'a number in year groups next to the start', destination: '2027 2026 23' },
  { row: 'a +44 number shaped as a season', destination: '+44 2026-2027' },
  { row: 'a short number in front of a date', destination: '20 23.07.2026' },
  {
    row: 'a phone in Arabic-Indic digits',
    destination: '\u0662\u0660\u0662\u0665\u0665\u0665\u0660\u0661\u0664\u0662',
  },
  {
    row: 'a phone in Devanagari digits',
    destination: '\u0968\u0966\u0968\u096B\u096B\u096B\u0966\u0967\u096A\u0968',
  },
  { row: 'a phone with middle dots', destination: '202\u00B7555\u00B70142' },
  { row: 'a phone with hyphenation points', destination: '202\u2027555\u20270142' },
  { row: 'a phone with underscores', destination: '202_555_0142' },
  { row: 'a lookalike dot (Vai full stop)', destination: 'swim\uA60Eexample' },
  { row: 'an email address with no dotted domain', destination: 'desk@pool' },
  { row: 'a mailto address', destination: 'mailto:desk@pool' },
  { row: 'a scheme with no dotted host', destination: 'swimclub://join' },
  { row: 'a lookalike dot (Syriac supralinear full stop)', destination: 'swim\u0701example' },
  { row: 'an email address with a numeric host', destination: 'desk@10.0.0.1' },
  { row: 'an sms link', destination: 'sms://5550104' },
  { row: 'a mailto with one-letter parts', destination: 'mailto:a@b' },
  { row: 'a tel link', destination: 'tel:+12025550142' },
  { row: 'an sms short code', destination: 'sms:55501' },
  { row: 'a facetime handle', destination: 'facetime:swimdesk' },
  { row: 'a facetime-audio handle', destination: 'facetime-audio:swimdesk' },
  { row: 'an smsto link', destination: 'smsto:55501' },
  { row: 'an sms short code behind a closing bracket', destination: 'sms:)55501' },
  { row: 'a facetime handle behind a closing quote', destination: 'facetime:\u201Dswimdesk' },
  { row: 'a tel link with a bracketed area code', destination: 'tel:(202)5550142' },
  { row: 'a Katakana TLD with the prolonged sound mark', destination: 'shop.\u30BB\u30FC\u30EB' },
  {
    row: 'another Katakana TLD with the prolonged sound mark',
    destination: 'example.\u30B0\u30FC\u30B0\u30EB',
  },
  ...['\u2212', '\u207B', '\u2796', '\u2043', '\u02D7', '\u30FC', '\u2022', '\u2219'].map(
    (sep) => ({
      row: `a phone joined by U+${(sep.codePointAt(0) as number).toString(16).toUpperCase()}`,
      destination: `202${sep}555${sep}0142`,
    }),
  ),
  ...['\u034F', '\uFE0F', '\u{E0100}', '\u180B', '\u17B4'].flatMap((mark) => {
    const hex = (mark.codePointAt(0) as number).toString(16).toUpperCase();
    return [
      { row: `default-ignorable U+${hex} after the dot`, destination: `swim.${mark}example` },
      { row: `default-ignorable U+${hex} before ://`, destination: `swimclub${mark}://join` },
    ];
  }),
  ...['\uFFF9', '\uFFFA', '\uFFFB'].flatMap((mark) => {
    const hex = (mark.codePointAt(0) as number).toString(16).toUpperCase();
    return [
      { row: `format char U+${hex} after the dot`, destination: `swim.${mark}example` },
      { row: `format char U+${hex} after the at sign`, destination: `desk@${mark}pool` },
      { row: `format char U+${hex} inside a phone`, destination: `202${mark}555${mark}0142` },
    ];
  }),
  { row: 'a domain with a heart in its label', destination: 'i\u2764.ws' },
  { row: 'a domain that is one emoji', destination: '\u{1F4A9}.la' },
  { row: 'a domain with a snowman label', destination: '\u2603.net' },
  { row: 'a bare IPv4 address', destination: '10.0.0.1' },
  { row: 'a bare IPv4 address with no letter and six digits', destination: '3.14.15.9' },
  { row: 'a bare IPv4 address right after a dot', destination: '.10.0.0.1' },
  { row: 'a bare IPv4 address joined to a word by a dot', destination: 'at.3.14.15.9' },
  { row: 'a phone joined by swung dashes', destination: '202\u2053555\u20530142' },
  { row: 'a phone joined by tilde operators', destination: '202\u223C555\u223C0142' },
  { row: 'a phone with a bracketed area code', destination: '[202]555-0142' },
  { row: 'a phone with a bracketed exchange', destination: '202[555]0142' },
  { row: 'a phone in fullwidth brackets', destination: '\uFF3B202\uFF3D555\uFF3B0142\uFF3D' },
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
  { row: 'an emoji with a variation selector', words: 'Picnic \u2600\uFE0F' },
  { row: 'an emoji after the name', words: 'Pool party \u{1F389}' },
  { row: 'a three-part level number', words: 'Swim level 1.2.3' },
  { row: 'a scheme name inside a word', words: 'Hotel:Lobby' },
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

  it("another day is not this event's date, so its seven digits read as a number to dial", () => {
    const invite = calendarInviteRefusals(
      `Swim class am 23.07.2031 um 10:30. ${INVITE_LINK_SLOT}`,
      INVITE,
    );
    expect(invite).toContain('invented_number');
    expect(invite).toContain('carries_destination');
    const cancel = calendarCancelRefusals(
      'Swim class am 23.07.2031 um 10:30 ist abgesagt.',
      CANCEL,
    );
    expect(cancel).toContain('invented_number');
    expect(cancel).toContain('carries_destination');
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

/*
 * The phone rule, from the construction (round 2): clocks come out first, then a dial run
 * of 7+ digits is a phone when it starts with '+', is a North American number, or is
 * anything other than exactly ONE calendar fact of THIS event (its own start date in the
 * family's zone, or a season around its year) plus at most one chunk of up to 2 digits.
 */
interface EventAt {
  startsAt: Date;
  timeZone: string;
  when: string;
}

/** Mon, Nov 23 2026, 11:30 PM in Denver (MST, UTC-7): already Nov 24 in UTC. */
const NOV_23: EventAt = {
  startsAt: new Date('2026-11-24T06:30:00.000Z'),
  timeZone: TIME_ZONE,
  when: 'Mon, Nov 23 at 11:30 PM',
};

/** Thu, Jul 23 2026, 10:30 AM in Denver: the start every invite and cancel request above uses. */
const JUL_23: EventAt = { startsAt: STARTS, timeZone: TIME_ZONE, when: WHEN };

/** Mon, Dec 21 2026, 10:00 AM in Denver. */
const DEC_21: EventAt = {
  startsAt: new Date('2026-12-21T17:00:00.000Z'),
  timeZone: TIME_ZONE,
  when: 'Mon, Dec 21 at 10:00 AM',
};

/** Mon, Jan 12 2026, 10:00 AM in Denver. */
const JAN_12: EventAt = {
  startsAt: new Date('2026-01-12T17:00:00.000Z'),
  timeZone: TIME_ZONE,
  when: 'Mon, Jan 12 at 10:00 AM',
};

async function verdicts(words: string, at: EventAt) {
  const invite = writer(echoInvite);
  const cancel = writer(echoCancel);
  const inviteTitle = await createCalendarInviteVoice(() => invite.client, agrees()).compose({
    ...INVITE,
    ...at,
    summary: `Swim class ${words}`,
  });
  const cancelTitle = await createCalendarCancelVoice(() => cancel.client, agrees()).compose({
    ...CANCEL,
    ...at,
    summary: `Swim class ${words}`,
  });
  const inviteText = calendarInviteRefusals(
    `Swim class ${words}, ${at.when}. ${INVITE_LINK_SLOT}`,
    { ...INVITE, ...at },
  ).includes('carries_destination');
  const cancelText = calendarCancelRefusals(`Swim class ${words}, ${at.when}, is off.`, {
    ...CANCEL,
    ...at,
  }).includes('carries_destination');
  return { inviteTitle, cancelTitle, inviteText, cancelText };
}

const HELD = {
  inviteTitle: { status: 'deferred', reason: 'summary_carries_destination' },
  cancelTitle: { status: 'deferred', reason: 'summary_carries_destination' },
  inviteText: true,
  cancelText: true,
};

const PHONES: readonly string[] = [
  '4-16-2055',
  '2026-07-23',
  '555 2026',
  '9123 2019',
  '2019-20 2021',
  '2055-5-12 1-2-2026',
  '2026 11 23 23',
  '23 23 23 23',
  '+1 2026 11 23',
  '2026-07-23 14',
  '202 555 0142',
  '(202) 555-0142',
  '202.555.0142',
  '1-202-555-0142',
  '202 555 0122:30',
  '٢٠٢ ٥٥٥ ٠١٤٢',
  '२०२ ५५५ ०१४२',
  '10:5550142',
  '202 555 01:99',
  '202-555-01:99',
  '202 555 24:00',
  '2031-2032',
  '2026-11-23 2026-11-23',
  '2026-27 4 1',
  '101 2026-11-23',
  '2026-11-23 - - 5',
  '2026-11-23\u00A0-\u3000-\u00A05',
];

const FACTS: readonly string[] = [
  '23.11.2026 10:30',
  'Grade 10 2026-2027',
  'U12 2026-27',
  '2026-2027 Swim Club',
  '23.11.2026',
  '2026-11-23',
  '11.23.2026',
  '2026-11-23 23:30',
  'Level 3 Fall 2026',
  'Grade 10 2026-11-23 10:30',
  '10:30-11:30 2026-11-23',
  '2026-11-23 14',
];

describe('VIL-588 · a run of 7+ digits is a phone unless it is one calendar fact of this event', () => {
  for (const words of PHONES) {
    it(`held for a Nov 23 2026 event: ${words}`, async () => {
      expect(await verdicts(words, NOV_23)).toEqual(HELD);
    });
  }

  for (const words of FACTS) {
    it(`sent for a Nov 23 2026 event: ${words}`, async () => {
      const v = await verdicts(words, NOV_23);
      expect(v.inviteTitle.status).toBe('composed');
      expect(v.cancelTitle.status).toBe('composed');
      expect([v.inviteText, v.cancelText]).toEqual([false, false]);
    });
  }

  it("a session number beside the event's own date is sent; the same words on another day are held", async () => {
    const v = await verdicts('Session 2 2026-01-12', JAN_12);
    expect(v.inviteTitle.status).toBe('composed');
    expect(v.cancelTitle.status).toBe('composed');
    expect([v.inviteText, v.cancelText]).toEqual([false, false]);
    expect(await verdicts('Session 2 2026-01-12', NOV_23)).toEqual(HELD);
  });

  it('a clock only counts with no digit before it: 2314:30 is a phone beside the date', async () => {
    expect(await verdicts('2026-07-2314:30', JUL_23)).toEqual(HELD);
    const control = await verdicts('2026-07-23 14:30', JUL_23);
    expect([control.inviteTitle.status, control.cancelTitle.status]).toEqual([
      'composed',
      'composed',
    ]);
    expect([control.inviteText, control.cancelText]).toEqual([false, false]);
  });

  it('an N11 area code is no North American number, so the date and its chunk are sent', async () => {
    const v = await verdicts('21.12.2026 34', DEC_21);
    expect([v.inviteTitle.status, v.cancelTitle.status]).toEqual(['composed', 'composed']);
    expect([v.inviteText, v.cancelText]).toEqual([false, false]);
    expect(await verdicts('21.12.2026 34', NOV_23)).toEqual(HELD);
  });
});

/** Accepted fail-closed costs: these name no fact of this event, so their 7+ digits are held. */
describe('VIL-588 · fail-closed costs: a number with no fact of this event is held', () => {
  for (const words of [
    'Swim 101 2026',
    'Ages 6-12 2026',
    'Class of 2030 2026-2027',
    'Registration closes 2026-10-15',
    'July 6-10 2026',
  ]) {
    it(`held: ${words}`, async () => {
      expect(await verdicts(words, NOV_23)).toEqual(HELD);
    });
  }
});

describe('VIL-588 · the dash fold is for dial runs only: a letter that looks like a dash stays a letter', () => {
  const july = { year: 2026, month: 7, day: 23 };
  const cases: readonly { words: string; shape: string }[] = [
    { words: 'shop.\u30BB\u30FC\u30EB', shape: 'domain' },
    { words: 'example.\u30B0\u30FC\u30B0\u30EB', shape: 'domain' },
    { words: '202\u30FC555\u30FC0142', shape: 'phone' },
  ];
  for (const { words, shape } of cases) {
    it(`${words} is a ${shape} in a title and in a text`, () => {
      expect(titleDestination(`Swim class ${words}`, july)).toBe(shape);
      expect(textDestination(`Swim class ${words}`, july)).toBe(shape);
    });
  }
});

describe('VIL-588 · a format character never hides a destination', () => {
  const july = { year: 2026, month: 7, day: 23 };
  for (const mark of ['\uFFF9', '\uFFFA', '\uFFFB']) {
    const hex = (mark.codePointAt(0) as number).toString(16).toUpperCase();
    it(`U+${hex} inside a domain, an email and a phone`, () => {
      for (const read of [titleDestination, textDestination]) {
        expect(read(`swim.${mark}example`, july)).toBe('domain');
        expect(read(`desk@${mark}pool`, july)).toBe('email');
        expect(read(`202${mark}555${mark}0142`, july)).toBe('phone');
      }
    });
  }
});

describe('VIL-588 · only a real clock leaves a dial run', () => {
  const july = { year: 2026, month: 7, day: 23 };
  it('01:99 is no clock, so its digits stay in the number', () => {
    for (const read of [titleDestination, textDestination]) {
      expect(read('202 555 01:99', july)).toBe('phone');
      expect(read('202-555-01:99', july)).toBe('phone');
    }
  });
});

describe('VIL-588 · a run of dashes and spaces joins as it always did', () => {
  /** The reference reading, before the anchor that keeps long whitespace linear. */
  const reference = (run: string) => run.replace(/\s*\p{Pd}\s*/gu, '-');

  it('repeated separators join exactly as the reference does', () => {
    for (const run of [
      '1 - - 2',
      '2026-07-23 - - 5',
      ' - - ',
      '1 \u2013 - 2',
      '- -',
      '1\u00A0-\u3000-\u00A02',
      '\u3000\u2013\u00A0-  -\u3000',
      '2026 -\u00A0\u00A0- 11 - - - 23',
    ]) {
      expect(joinDashes(run)).toBe(reference(run));
    }
  });

  it('so do 20,000 runs drawn from spaces, dashes and digits', () => {
    const alphabet = [' ', '\u00A0', '\u3000', '\t', '-', '\u2013', '\u2014', '1', '7', 'a'];
    let seed = 588;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed;
    };
    for (let i = 0; i < 20_000; i += 1) {
      const run = Array.from(
        { length: 1 + (next() % 12) },
        () => alphabet[next() % alphabet.length],
      ).join('');
      expect(joinDashes(run)).toBe(reference(run));
    }
  });

  it("the same date and dashes for the event's own day stay one chunk, so its digits are a phone", async () => {
    expect(await verdicts('2026-07-23 - - 5', JUL_23)).toEqual(HELD);
  });
});

describe('VIL-588 · symbols are label characters, and a bare IPv4 address is a host', () => {
  const july = { year: 2026, month: 7, day: 23 };
  const november = { year: 2026, month: 11, day: 23 };
  for (const words of ['i\u2764.ws', '\u{1F4A9}.la', '\u2603.net']) {
    it(`${words} is a domain`, () => {
      for (const read of [titleDestination, textDestination]) {
        expect(read(`Swim class ${words}`, july)).toBe('domain');
      }
    });
  }
  for (const words of ['10.0.0.1', '3.14.15.9']) {
    it(`${words} is a host by number`, () => {
      for (const read of [titleDestination, textDestination]) {
        expect(read(`Swim class ${words}`, july)).toBe('ip');
      }
    });
  }
  for (const words of ['Swim .10.0.0.1', 'Info at.3.14.15.9']) {
    it(`${words}: a dot before the address does not hide it`, () => {
      for (const read of [titleDestination, textDestination]) {
        expect(read(words, july)).toBe('ip');
      }
    });
  }
  it("the event's own dotted date and a three-part number are no host", () => {
    for (const read of [titleDestination, textDestination]) {
      expect(read('Swim class 23.11.2026', november)).toBeNull();
      expect(read('Swim level 1.2.3', november)).toBeNull();
      expect(read('Picnic \u2600\uFE0F', july)).toBeNull();
      expect(read('Pool party \u{1F389}', july)).toBeNull();
    }
  });
});

describe('VIL-588 · six digits are short of a phone number', () => {
  it('a 6-digit run is sent; one more digit is held', async () => {
    const v = await verdicts('202 555', NOV_23);
    expect([v.inviteTitle.status, v.cancelTitle.status]).toEqual(['composed', 'composed']);
    expect([v.inviteText, v.cancelText]).toEqual([false, false]);
    expect(await verdicts('202 5550', NOV_23)).toEqual(HELD);
  });
});

describe('VIL-588 · the gate reads a title of any length in linear time', () => {
  const july = { year: 2026, month: 7, day: 23 };
  const n = 100_000;
  const BUDGET_MS = 1000;
  const LONG: readonly { row: string; words: string; shape: string | null }[] = [
    { row: 'one long word', words: 'a'.repeat(n), shape: null },
    { row: 'letters after digits', words: '1a'.repeat(n / 2), shape: null },
    { row: 'plus signs', words: '+'.repeat(n), shape: null },
    { row: 'a date run on by dots', words: `2026.07.23${'.'.repeat(n)}1`, shape: 'phone' },
    { row: 'a date run on by brackets', words: `2026.07.23${'('.repeat(n)}1`, shape: 'phone' },
    { row: 'spaces between digits', words: `1${' '.repeat(n)}234567`, shape: 'phone' },
    {
      row: 'no-break spaces between digits',
      words: `1${'\u00a0'.repeat(n)}234567`,
      shape: 'phone',
    },
    { row: 'two combining marks repeated', words: `a${'\u0316\u0301'.repeat(n / 2)}`, shape: null },
    {
      row: 'three combining marks of three classes repeated',
      words: `a${'\u0316\u0301\u0345'.repeat(Math.floor(n / 3))}`,
      shape: null,
    },
    {
      row: 'a halfwidth sound mark and a combining mark of another class repeated',
      words: `\uFF76${'\uFF9E\u0316'.repeat(n / 2)}`,
      shape: null,
    },
  ];
  for (const { row, words, shape } of LONG) {
    it(`${row}: read within ${BUDGET_MS} ms`, () => {
      for (const read of [titleDestination, textDestination]) {
        const started = performance.now();
        expect(read(words, july)).toBe(shape);
        expect(performance.now() - started).toBeLessThan(BUDGET_MS);
      }
    });
  }
});

describe('VIL-588 · the cancel voice tells the parent about an event with a long title', () => {
  /** The title the cancel voice works from: its first MAX_INVITE_SUMMARY_CHARS code points. */
  const cut = (summary: string) => Array.from(summary).slice(0, MAX_INVITE_SUMMARY_CHARS).join('');

  it('a 10,000-character title is cut, and the cut title is written and sent', async () => {
    const summary = 'Swim class '.repeat(1000).slice(0, 10_000);
    const w = writer(echoCancel);
    const j = judge(true);
    const outcome = await createCalendarCancelVoice(() => w.client, j).compose({
      ...CANCEL,
      summary,
    });
    const short = 'Swim class '.repeat(19).slice(0, MAX_INVITE_SUMMARY_CHARS);
    expect(cut(summary)).toBe(short);
    expect(outcome).toEqual({ status: 'composed', body: `${short}, ${WHEN}, is off.` });
    expect(j.seen.map((input) => input.summary)).toEqual([short]);
  });

  it('the cut counts code points, so an emoji is never split', async () => {
    const summary = '\u{1F3CA}'.repeat(MAX_INVITE_SUMMARY_CHARS + 50);
    const w = writer(echoCancel);
    const outcome = await createCalendarCancelVoice(() => w.client, agrees()).compose({
      ...CANCEL,
      summary,
    });
    const short = '\u{1F3CA}'.repeat(MAX_INVITE_SUMMARY_CHARS);
    expect(outcome).toEqual({ status: 'composed', body: `${short}, ${WHEN}, is off.` });
  });

  it('a destination only past the cut never reaches the writer or the text', async () => {
    const summary = `${'Swim class '.repeat(20)}pool.example.org`;
    expect(summary.indexOf('pool.example.org')).toBeGreaterThan(MAX_INVITE_SUMMARY_CHARS);
    const w = writer(echoCancel);
    const outcome = await createCalendarCancelVoice(() => w.client, agrees()).compose({
      ...CANCEL,
      summary,
    });
    expect(outcome).toEqual({
      status: 'composed',
      body: `${cut(summary)}, ${WHEN}, is off.`,
    });
    expect(outcome.status === 'composed' && outcome.body.includes('pool')).toBe(false);
  });

  it('a destination inside the cut of a long title is held before any call', async () => {
    const summary = `Swim class pool.example.org ${'Swim class '.repeat(1000)}`;
    const w = writer(echoCancel);
    const j = judge(true);
    const outcome = await createCalendarCancelVoice(() => w.client, j).compose({
      ...CANCEL,
      summary,
    });
    expect(outcome).toEqual({ status: 'deferred', reason: 'summary_carries_destination' });
    expect(w.calls()).toBe(0);
    expect(j.seen).toEqual([]);
  });

  it('a 100,000-mark title is cut and read within the budget', async () => {
    const summary = `a${'\u0316\u0301'.repeat(50_000)}`;
    const w = writer(echoCancel);
    const started = performance.now();
    const outcome = await createCalendarCancelVoice(() => w.client, agrees()).compose({
      ...CANCEL,
      summary,
    });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(outcome).toEqual({ status: 'composed', body: `${cut(summary)}, ${WHEN}, is off.` });
  });
});

describe('VIL-588 · a scheme name is exempt only when a closing mark and then nothing follow its colon', () => {
  const july = { year: 2026, month: 7, day: 23 };
  it('"bring tel:)" ending the words, or before a space, is no destination', () => {
    for (const read of [titleDestination, textDestination]) {
      expect(read('Swim (bring tel:)', july)).toBeNull();
      expect(read('Swim (bring tel:) on Thu', july)).toBeNull();
      expect(read('Swim (bring tel:', july)).toBeNull();
    }
  });
  it('fail-closed cost: any other character after the closing mark reads as a scheme', () => {
    for (const read of [titleDestination, textDestination]) {
      expect(read('Swim (bring tel:), Thu', july)).toBe('scheme');
      expect(read('sms:)55501', july)).toBe('scheme');
    }
  });
  it('a title ending "tel:)" is written and sent when the writer follows it with a space', async () => {
    const words = 'Swim (bring tel:)';
    const invite = writer((f) => `${f.summary} on ${f.when}. ${INVITE_LINK_SLOT}`);
    expect(
      await createCalendarInviteVoice(() => invite.client, agrees()).compose({
        ...INVITE,
        summary: words,
      }),
    ).toEqual({ status: 'composed', body: `${words} on ${WHEN}. ${LINK}` });
    const cancel = writer((f) => `${f.summary} on ${f.when} is off.`);
    expect(
      await createCalendarCancelVoice(() => cancel.client, agrees()).compose({
        ...CANCEL,
        summary: words,
      }),
    ).toEqual({ status: 'composed', body: `${words} on ${WHEN} is off.` });
  });
});

/*
 * Round 7 · a symbol or a lone combining mark between a label and its TLD, or between the
 * groups of a number, hides nothing: a reader skips it, and a GSM-7 fold (the cancel
 * renderer's until this round) deletes it, so "pool.\u2726org" reads as "pool.org".
 */
const WIRE_EVASIONS: readonly { row: string; destination: string }[] = [
  { row: 'a symbol GSM-7 cannot carry inside a domain', destination: 'pool.\u2726org' },
  { row: 'symbols GSM-7 cannot carry inside a phone', destination: '555\u2726010\u27264477' },
  { row: 'a lone combining mark inside a domain', destination: 'pool.\u0301org' },
];

describe('VIL-588 · round 7: a character the GSM-7 fold deletes never hides a destination', () => {
  for (const { row, destination } of WIRE_EVASIONS) {
    it(`title, both voices: ${row} is held before any call`, async () => {
      const summary = `Swim class - ${destination}`;
      const invite = writer(echoInvite);
      expect(
        await createCalendarInviteVoice(() => invite.client, agrees()).compose({
          ...INVITE,
          summary,
        }),
      ).toEqual({ status: 'deferred', reason: 'summary_carries_destination' });
      const cancel = writer(echoCancel);
      expect(
        await createCalendarCancelVoice(() => cancel.client, agrees()).compose({
          ...CANCEL,
          summary,
        }),
      ).toEqual({ status: 'deferred', reason: 'summary_carries_destination' });
      expect(invite.calls() + cancel.calls()).toBe(0);
    });

    it(`writer text, both voices: ${row} is refused, and nothing is sent`, async () => {
      expect(
        calendarInviteRefusals(
          `Swim class on ${WHEN}, see ${destination} ${INVITE_LINK_SLOT}`,
          INVITE,
        ),
      ).toContain('carries_destination');
      expect(
        calendarCancelRefusals(`Swim class on ${WHEN} is cancelled, see ${destination}`, CANCEL),
      ).toContain('carries_destination');
      const invite = writer(
        (f) => `${f.summary}, ${f.when}, see ${destination} ${INVITE_LINK_SLOT}`,
      );
      expect(
        await createCalendarInviteVoice(() => invite.client, agrees()).compose(INVITE),
      ).toEqual({ status: 'deferred', reason: 'gate_exhausted' });
      const cancel = writer((f) => `${f.summary}, ${f.when}, is off, see ${destination}`);
      expect(
        await createCalendarCancelVoice(() => cancel.client, agrees()).compose(CANCEL),
      ).toEqual({ status: 'deferred', reason: 'gate_exhausted' });
    });
  }

  it('positive control: the same words with the symbol beside a space are sent', async () => {
    const words = 'Swim class \u2726 pool party';
    const invite = writer(echoInvite);
    expect(
      await createCalendarInviteVoice(() => invite.client, agrees()).compose({
        ...INVITE,
        summary: words,
      }),
    ).toEqual({ status: 'composed', body: `${words}, ${WHEN}. ${LINK}` });
    const cancel = writer(echoCancel);
    expect(
      await createCalendarCancelVoice(() => cancel.client, agrees()).compose({
        ...CANCEL,
        summary: words,
      }),
    ).toEqual({ status: 'composed', body: `${words}, ${WHEN}, is off.` });
  });
});

/*
 * Round 7 · the invariant by construction: no renderer changes a calendar text after the
 * gate read it. The invite stopped folding in VIL-515; the cancel renderer's fold was the
 * one step between the gate and the wire, and it is gone, so the gated line IS the wire.
 */
describe('VIL-588 · round 7: the text the gate read is the text that is sent, in both voices', () => {
  const ASIS: readonly { row: string; summary: string }[] = [
    { row: 'an accented name', summary: 'Lo\u00EFc swim class' },
    { row: 'an emoji', summary: 'Picnic \u2600\uFE0F' },
    { row: 'a Chinese name', summary: '\u6E38\u6CF3\u8BFE' },
  ];

  for (const { row, summary } of ASIS) {
    it(`${row} reaches the phone exactly as the gate and the judge read it`, async () => {
      const invite = writer(echoInvite);
      const invited = await createCalendarInviteVoice(() => invite.client, agrees()).compose({
        ...INVITE,
        summary,
      });
      const inviteBody = `${summary}, ${WHEN}. ${LINK}`;
      expect(invited).toEqual({ status: 'composed', body: inviteBody });
      expect(splitInviteSms(inviteBody).join(' ')).toBe(inviteBody);

      const cancel = writer(echoCancel);
      const j = judge(true);
      const cancelled = await createCalendarCancelVoice(() => cancel.client, j).compose({
        ...CANCEL,
        summary,
      });
      const cancelBody = `${summary}, ${WHEN}, is off.`;
      expect(cancelled).toEqual({ status: 'composed', body: cancelBody });
      expect(j.seen.map((input) => input.text)).toEqual([cancelBody]);
      expect(calendarCancelSmsText({ summary, when: WHEN, line: cancelBody })).toBe(cancelBody);
    });
  }

  it('a cancellation written in Chinese is sent, not emptied by a fold', async () => {
    const zh = '\u6E38\u6CF3\u8BFE\u53D6\u6D88\u4E86';
    const w = writer(() => zh);
    const outcome = await createCalendarCancelVoice(() => w.client, agrees()).compose({
      ...CANCEL,
      summary: '\u6E38\u6CF3\u8BFE',
    });
    expect(outcome).toEqual({ status: 'composed', body: zh });
    expect(calendarCancelSmsText({ summary: '\u6E38\u6CF3\u8BFE', when: WHEN, line: zh })).toBe(zh);
  });

  it('a CJK date in the title reaches the writer in both voices, and in the text is sent', async () => {
    const title = '\u6E38\u6CF3\u8BFE2026\u5E747\u670823\u65E5';
    const invite = writer((f) => `Swim class on ${f.when}. ${INVITE_LINK_SLOT}`);
    expect(
      await createCalendarInviteVoice(() => invite.client, agrees()).compose({
        ...INVITE,
        summary: title,
      }),
    ).toEqual({ status: 'composed', body: `Swim class on ${WHEN}. ${LINK}` });
    const cancel = writer((f) => `Swim class on ${f.when} is off.`);
    expect(
      await createCalendarCancelVoice(() => cancel.client, agrees()).compose({
        ...CANCEL,
        summary: title,
      }),
    ).toEqual({ status: 'composed', body: `Swim class on ${WHEN} is off.` });
    const zh = `${title}\u4E0A\u534810:30`;
    expect(calendarInviteRefusals(`${zh}\u3002${INVITE_LINK_SLOT}`, INVITE)).not.toContain(
      'carries_destination',
    );
    expect(calendarCancelRefusals(zh, CANCEL)).not.toContain('carries_destination');
  });
});

describe('VIL-588 · round 7: a zone that cannot be read is a named deferral, not a throw', () => {
  afterEach(() => vi.restoreAllMocks());

  for (const timeZone of ['Not/A_Zone', '']) {
    it(`zone ${JSON.stringify(timeZone)}: both voices defer as time_unjudged and send nothing`, async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const invite = writer(echoInvite);
      expect(
        await createCalendarInviteVoice(() => invite.client, agrees()).compose({
          ...INVITE,
          timeZone,
        }),
      ).toEqual({ status: 'deferred', reason: 'time_unjudged' });
      const cancel = writer(echoCancel);
      expect(
        await createCalendarCancelVoice(() => cancel.client, agrees()).compose({
          ...CANCEL,
          timeZone,
        }),
      ).toEqual({ status: 'deferred', reason: 'time_unjudged' });
      expect(invite.calls() + cancel.calls()).toBe(0);
      expect(error.mock.calls.map((call) => call[0])).toEqual([
        { reason: 'time_unjudged', detail: 'RangeError' },
        { reason: 'time_unjudged', detail: 'RangeError' },
      ]);
    });
  }

  it('positive control: the same request in a real zone is composed', async () => {
    const cancel = writer(echoCancel);
    expect(await createCalendarCancelVoice(() => cancel.client, agrees()).compose(CANCEL)).toEqual({
      status: 'composed',
      body: `Swim class, ${WHEN}, is off.`,
    });
  });
});

describe("VIL-588 · round 7: the time judge's reason restates the title and is never logged", () => {
  afterEach(() => vi.restoreAllMocks());

  /** An invented title word that appears in no log line Hale writes. */
  const TITLE = 'Marigold swim class';

  /**
   * One client at the port for both calls: the writer echoes the facts, and the REAL time
   * judge (createCalendarInviteTimeJudge, the voices' default) gets `judgeAnswer`.
   */
  function writerAndJudge(judgeAnswer: string): { client: AgentClient; judged: () => number } {
    let judged = 0;
    const create = async (body: { messages: { content: string }[] }) => {
      const facts = JSON.parse(body.messages[0]?.content ?? '{}');
      let text: string;
      if ('starts' in facts) {
        judged += 1;
        text = judgeAnswer;
      } else {
        text = JSON.stringify({
          text: 'linkSlot' in facts ? echoInvite(facts) : echoCancel(facts),
        });
      }
      return {
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    };
    return { client: { messages: { create } } as unknown as AgentClient, judged: () => judged };
  }

  function consoleLines(): () => string {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    return () => JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
  }

  const answer = JSON.stringify({
    reason: `The text names ${TITLE} but not at 10:30.`,
    match: false,
  });

  it('a refusal whose reason restates the title: no log line carries it, in either voice', async () => {
    const logged = consoleLines();
    const invite = writerAndJudge(answer);
    const cancel = writerAndJudge(answer);
    const invited = await createCalendarInviteVoice(() => invite.client).compose({
      ...INVITE,
      summary: TITLE,
    });
    const cancelled = await createCalendarCancelVoice(() => cancel.client).compose({
      ...CANCEL,
      summary: TITLE,
    });
    expect(invited.status).toBe('deferred');
    expect(cancelled.status).toBe('deferred');
    expect(invite.judged()).toBeGreaterThan(0);
    expect(cancel.judged()).toBeGreaterThan(0);
    const lines = logged();
    // Positive control: the deferral IS logged, so the spies see Hale's log lines.
    expect(lines).toContain('no text composed, nothing sent');
    expect(lines).not.toContain('Marigold');
  });
});

describe('VIL-588 · round 7: a number in any digit script is checked against the handed facts', () => {
  const invented = [
    { row: 'an Arabic-Indic digit', digit: '\u0664' },
    { row: 'a Devanagari digit', digit: '\u096A' },
    { row: 'a fullwidth digit', digit: '\uFF14' },
  ];
  for (const { row, digit } of invented) {
    it(`${row} the writer added is refused in both voices`, () => {
      expect(
        calendarCancelRefusals(`Swim class, ${WHEN}, group ${digit} is cancelled.`, CANCEL),
      ).toContain('invented_number');
      expect(
        calendarInviteRefusals(`Swim class, ${WHEN}, group ${digit}. ${INVITE_LINK_SLOT}`, INVITE),
      ).toContain('invented_number');
    });
  }

  it('positive control: the same digit handed in the title is not invented', () => {
    const summary = 'Swim class group \u0664';
    expect(
      calendarCancelRefusals(`${summary}, ${WHEN}, is cancelled.`, { ...CANCEL, summary }),
    ).not.toContain('invented_number');
    expect(
      calendarInviteRefusals(`${summary}, ${WHEN}. ${INVITE_LINK_SLOT}`, { ...INVITE, summary }),
    ).not.toContain('invented_number');
  });
});

describe('VIL-588 · round 7: the French group register rewrite after the gate adds no destination', () => {
  /*
   * phone-sms.ts sends a French family group's text through groupBothReaderFrench after
   * the gate. It swaps letter runs for letter runs at word boundaries, so a shape the
   * gate passed cannot appear. Pinned so a new rewrite rule that adds a dot, an at sign
   * or a digit fails here.
   */
  it('no text the gate passes is held once rewritten', () => {
    const atoms = [
      'ta',
      'Ta',
      'ton',
      'Ton',
      'tu veux',
      'Tu veux',
      'envoie-moi',
      '.',
      '@',
      ':',
      '//',
      ' ',
      '-',
      '\u00EF',
      'x',
      'org',
      '5',
      '555',
      '0104',
      '+',
      '\u3002',
      '\u2726',
      '\u0301',
    ];
    let seed = 7;
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    let rewritten = 0;
    const created: string[] = [];
    for (let i = 0; i < 40_000; i += 1) {
      let text = '';
      for (let k = 2 + next(7); k > 0; k -= 1) text += atoms[next(atoms.length)];
      const after = groupBothReaderFrench(text);
      if (after === text) continue;
      rewritten += 1;
      for (const read of [textDestination, titleDestination]) {
        if (read(text, JUL_23_START) === null && read(after, JUL_23_START) !== null) {
          created.push(text);
        }
      }
    }
    // Positive control: the rewrite really ran on thousands of texts.
    expect(rewritten).toBeGreaterThan(5_000);
    expect(created).toEqual([]);
  });
});

const JUL_23_START = { year: 2026, month: 7, day: 23, hour: 10, minute: 30, weekday: 'Thursday' };
