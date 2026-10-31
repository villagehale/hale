import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { LoopMessage } from '~/lib/channel/types';
import {
  calendarInviteSmsRenderer,
  splitInviteSms,
} from '~/lib/loop/templates/calendar-invite/sms';
import {
  type CalendarInviteVoiceRequest,
  INVITE_LINK_SLOT,
  calendarInviteRefusals,
  calendarInviteUserMessage,
  fillCalendarInvite,
  prepareCalendarInvite,
} from './calendar-invite-voice';

const LINK = `https://app.villagehale.com/api/ics/event/${'a'.repeat(36)}.${'b'.repeat(43)}`;

/** Thu, Jul 23 2026, 10:30 AM in Toronto. */
const STARTS = new Date('2026-07-23T14:30:00.000Z');

const REQUEST: CalendarInviteVoiceRequest = {
  summary: 'Swim class',
  when: 'Thu, Jul 23 at 10:30 AM',
  url: LINK,
  startsAt: STARTS,
  timeZone: 'America/Toronto',
  language: 'en',
};

const PASSING = `Swim class on Thu, Jul 23 at 10:30 AM is on the week. Open this: ${INVITE_LINK_SLOT}`;

describe('calendarInviteRefusals', () => {
  it('passes a line that names the event, states its clock, and leaves the link as a slot', () => {
    expect(calendarInviteRefusals(PASSING, REQUEST)).toEqual([]);
    const filled = fillCalendarInvite(PASSING, LINK);
    expect(filled).toContain(LINK);
    expect(filled).not.toContain(INVITE_LINK_SLOT);
  });

  it('does not treat digits inside the url as numbers the model invented', () => {
    const numbered = `https://app.villagehale.com/api/ics/event/${'1'.repeat(36)}.${'2'.repeat(43)}`;
    expect(calendarInviteRefusals(PASSING, { ...REQUEST, url: numbered })).not.toContain(
      'invented_number',
    );
  });

  it('refuses a text that drops the event, types a url, or skips the slot', () => {
    expect(calendarInviteRefusals('Open this Thu, Jul 23 at 10:30 AM.', REQUEST)).toEqual(
      expect.arrayContaining(['summary_missing', 'link_missing']),
    );
    expect(
      calendarInviteRefusals(`Swim class on Thu, Jul 23 at 10:30 AM: ${LINK}`, REQUEST),
    ).toEqual(expect.arrayContaining(['carries_link', 'link_missing']));
  });

  it('refuses a repeated slot, a second placeholder, and an invented time', () => {
    expect(
      calendarInviteRefusals(
        `We put Swim class at 4:15 on Thu, Jul 23 ${INVITE_LINK_SLOT} and ${INVITE_LINK_SLOT}`,
        REQUEST,
      ),
    ).toEqual(expect.arrayContaining(['link_repeated', 'invented_number', 'when_missing']));
    expect(
      calendarInviteRefusals(
        `Swim class on Thu, Jul 23 at 10:30 AM ${INVITE_LINK_SLOT} [[map]]`,
        REQUEST,
      ),
    ).toContain('stray_slot');
  });

  it('does not refuse length, a lowercase start, or we', () => {
    const long = `${'Swim class '.repeat(40)}on Thu, Jul 23 at 10:30 AM. ${INVITE_LINK_SLOT}`;
    expect(calendarInviteRefusals(long, REQUEST)).toEqual([]);
    expect(
      calendarInviteRefusals(
        `we put Swim class on Thu, Jul 23 at 10:30 AM. ${INVITE_LINK_SLOT}`,
        REQUEST,
      ),
    ).toEqual([]);
  });

  it('refuses a weekday that is not the event, even when the date and clock match', () => {
    expect(
      calendarInviteRefusals(
        `Swim class on Friday, July 23 at 10:30 AM. ${INVITE_LINK_SLOT}`,
        REQUEST,
      ),
    ).toContain('when_missing');
    expect(
      calendarInviteRefusals(`Swim class le jeudi 23 juillet à 10 h 30. ${INVITE_LINK_SLOT}`, {
        ...REQUEST,
        language: 'fr',
      }),
    ).toEqual([]);
  });

  it('refuses a clock or a day that is not the event, even when the digits were handed', () => {
    expect(
      calendarInviteRefusals(
        `Swim class on Jul 10 at 23:30. Open this: ${INVITE_LINK_SLOT}`,
        REQUEST,
      ),
    ).toContain('when_missing');
    expect(
      calendarInviteRefusals(
        `Swim class on Jul 10 at 10:30 AM. Open this: ${INVITE_LINK_SLOT}`,
        REQUEST,
      ),
    ).toContain('when_missing');
    const extra = calendarInviteRefusals(
      `Swim class on Thu, Jul 23 at 10:30 AM, or Jul 10 at 23:30. Open this: ${INVITE_LINK_SLOT}`,
      REQUEST,
    );
    expect(extra).toContain('when_missing');
  });

  it('accepts the same start said in French or Chinese, without the English label', () => {
    expect(
      calendarInviteRefusals(`Swim class le 23 juillet à 10 h 30. ${INVITE_LINK_SLOT}`, {
        ...REQUEST,
        language: 'fr',
      }),
    ).toEqual([]);
    expect(
      calendarInviteRefusals(`Swim class 7月23日上午10:30 ${INVITE_LINK_SLOT}`, {
        ...REQUEST,
        language: 'zh',
      }),
    ).toEqual([]);
  });

  it('keeps an em dash in the summary as the fact, and does not fold it away', () => {
    const named: CalendarInviteVoiceRequest = {
      ...REQUEST,
      summary: 'Maya \u2014 Swim class',
    };
    const raw = `Maya \u2014 Swim class on Thu, Jul 23 at 10:30 AM is on the week. Open this: ${INVITE_LINK_SLOT}`;
    expect(calendarInviteRefusals(raw, named)).toEqual([]);
    expect(
      calendarInviteRefusals(
        `Maya - Swim class on Thu, Jul 23 at 10:30 AM. ${INVITE_LINK_SLOT}`,
        named,
      ),
    ).toContain('summary_missing');
  });
});

describe('prepareCalendarInvite', () => {
  it('fills the slot and leaves accents, dashes, and other scripts as written', () => {
    const prepared = prepareCalendarInvite(
      `Swim class on Thu, Jul 23 at 10:30 AM \u2014 Chlo\u00e9 \u5468 ${INVITE_LINK_SLOT}`,
      REQUEST,
    );
    expect(prepared.status).toBe('accepted');
    if (prepared.status !== 'accepted') return;
    expect(prepared.body).toContain('\u2014');
    expect(prepared.body).toContain('Chlo\u00e9');
    expect(prepared.body).toContain('\u5468');
    expect(prepared.body.endsWith(LINK)).toBe(true);
    expect(prepared.body).not.toContain(INVITE_LINK_SLOT);
  });
});

describe('calendarInviteUserMessage', () => {
  it('hands the language and the slot, never the url or a segment budget', () => {
    const payload = JSON.parse(calendarInviteUserMessage(REQUEST)) as Record<string, unknown>;
    expect(payload).toEqual({
      summary: REQUEST.summary,
      when: REQUEST.when,
      language: 'en',
      linkSlot: INVITE_LINK_SLOT,
    });
    expect(calendarInviteUserMessage({ ...REQUEST, language: 'fr' })).toContain('"language":"fr"');
    expect(calendarInviteUserMessage(REQUEST)).not.toContain(LINK);
    expect(calendarInviteUserMessage(REQUEST)).not.toContain('maxSegments');
    expect(
      JSON.parse(calendarInviteUserMessage(REQUEST, [{ text: 'x', problems: ['empty'] }])).rejected,
    ).toEqual([{ text: 'x', problems: ['empty'] }]);
  });
});

describe('splitInviteSms', () => {
  it('sends a short line whole and splits a long one without cutting the link', () => {
    const short = `Swim class. ${LINK}`;
    expect(splitInviteSms(short)).toEqual([short]);
    const long = `${'Swim class on Thu, Jul 23 at 10:30 AM. '.repeat(8)}${LINK}`;
    const parts = splitInviteSms(long);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join(' ')).toBe(long);
    expect(parts.filter((part) => part.includes('https://'))).toEqual([
      parts.find((part) => part.includes(LINK)),
    ]);
    expect(parts.some((part) => part.includes(LINK))).toBe(true);
  });

  it('does not fold the model line on the way out', () => {
    const line = `Swim class on Thu, Jul 23 at 10:30 AM \u2014 Chlo\u00e9 \u5468 ${LINK}`;
    const rendered = calendarInviteSmsRenderer.render(
      {
        templateKey: 'calendar_invite_sms',
        familyId: 'fam',
        parentUserId: 'parent',
        category: 'approval',
        urgency: 'time_sensitive',
        channel: 'sms',
        payload: {
          summary: 'Swim class',
          when: 'Thu, Jul 23 at 10:30 AM',
          url: LINK,
          line,
        },
      } satisfies LoopMessage,
      'sms',
      'generic',
    );
    const wire = rendered.texts?.join(' ') ?? rendered.text;
    expect(wire).toContain('\u2014');
    expect(wire).toContain('Chlo\u00e9');
    expect(wire).toContain('\u5468');
    expect(wire).toContain(LINK);
  });
});

describe('VIL-515 · the invite template authors no fixed confirmation', () => {
  it('has no parent-facing Added line left in the sms module', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../templates/calendar-invite/sms.ts', import.meta.url)),
      'utf8',
    );
    expect(source).not.toContain('Added -');
    expect(source).not.toContain("Tap to put it on your phone's calendar");
    expect(source).not.toContain('gsmSafe');
  });
});
