import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { smsEncoding, smsSegments } from '~/lib/channel/sms-segments';
import {
  type CalendarInviteVoiceRequest,
  INVITE_LINK_SLOT,
  calendarInviteRefusals,
  calendarInviteUserMessage,
  fillCalendarInvite,
  prepareCalendarInvite,
} from './calendar-invite-voice';

const LINK = `https://app.villagehale.com/api/ics/event/${'a'.repeat(36)}.${'b'.repeat(43)}`;

const REQUEST: CalendarInviteVoiceRequest = {
  summary: 'Swim class',
  when: 'Thu, Jul 23 at 10:30 AM',
  url: LINK,
};

const PASSING = `Swim class on Thu, Jul 23 at 10:30 AM is on the week. Open this: ${INVITE_LINK_SLOT}`;

describe('calendarInviteRefusals', () => {
  it('passes a short line that names the event and leaves the link as a slot', () => {
    expect(calendarInviteRefusals(PASSING, REQUEST)).toEqual([]);
    const filled = fillCalendarInvite(PASSING, LINK);
    expect(filled).toContain(LINK);
    expect(filled).not.toContain(INVITE_LINK_SLOT);
    expect({ encoding: smsEncoding(filled), segments: smsSegments(filled) }).toEqual({
      encoding: 'gsm7',
      segments: 2,
    });
  });

  it('does not treat digits inside the url as numbers the model invented', () => {
    const numbered = `https://app.villagehale.com/api/ics/event/${'1'.repeat(36)}.${'2'.repeat(43)}`;
    expect(calendarInviteRefusals(PASSING, { ...REQUEST, url: numbered })).not.toContain(
      'invented_number',
    );
  });

  it('refuses a text that drops the event, types a url, or skips the slot', () => {
    expect(calendarInviteRefusals('Open this to add it to your phone.', REQUEST)).toEqual(
      expect.arrayContaining(['summary_missing', 'link_missing']),
    );
    expect(calendarInviteRefusals(`Swim class is on the week: ${LINK}`, REQUEST)).toEqual(
      expect.arrayContaining(['carries_link', 'link_missing']),
    );
  });

  it('refuses a repeated slot, a second placeholder, the royal we, and an invented time', () => {
    expect(
      calendarInviteRefusals(
        `We put Swim class at 4:15 on the week ${INVITE_LINK_SLOT} and ${INVITE_LINK_SLOT}`,
        REQUEST,
      ),
    ).toEqual(expect.arrayContaining(['link_repeated', 'first_person_plural', 'invented_number']));
    expect(
      calendarInviteRefusals(`Swim class is on the week ${INVITE_LINK_SLOT} [[map]]`, REQUEST),
    ).toContain('stray_slot');
  });

  it('refuses a line that will not fit two segments once the real link is in it', () => {
    const long = `${'Swim class '.repeat(40)}${INVITE_LINK_SLOT}`;
    expect(calendarInviteRefusals(long, REQUEST)).toContain('over_segment_cap');
  });

  it('folds an em dash in the summary before deciding the event was named', () => {
    const named: CalendarInviteVoiceRequest = {
      ...REQUEST,
      summary: 'Maya \u2014 Swim class',
    };
    const raw = `Maya - Swim class on Thu, Jul 23 at 10:30 AM is on the week. Open this: ${INVITE_LINK_SLOT}`;
    expect(calendarInviteRefusals(raw, named)).toEqual([]);
  });
});

describe('prepareCalendarInvite', () => {
  it('fills the slot and folds the dash the model typed', () => {
    const prepared = prepareCalendarInvite(
      `Swim class on Thu, Jul 23 at 10:30 AM is on the week \u2014 open this: ${INVITE_LINK_SLOT}`,
      REQUEST,
    );
    expect(prepared.status).toBe('accepted');
    if (prepared.status !== 'accepted') return;
    expect(prepared.body).toContain('week - open this:');
    expect(prepared.body.endsWith(LINK)).toBe(true);
    expect(prepared.body).not.toContain(INVITE_LINK_SLOT);
  });
});

describe('calendarInviteUserMessage', () => {
  it('hands the slot and the link length, never the url', () => {
    const payload = JSON.parse(calendarInviteUserMessage(REQUEST)) as Record<string, unknown>;
    expect(payload).toEqual({
      summary: REQUEST.summary,
      when: REQUEST.when,
      linkSlot: INVITE_LINK_SLOT,
      urlChars: LINK.length,
      maxSegments: 2,
    });
    expect(calendarInviteUserMessage(REQUEST)).not.toContain(LINK);
    expect(
      JSON.parse(calendarInviteUserMessage(REQUEST, [{ text: 'x', problems: ['empty'] }])).rejected,
    ).toEqual([{ text: 'x', problems: ['empty'] }]);
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
  });
});
