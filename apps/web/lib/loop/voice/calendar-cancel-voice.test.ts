import { describe, expect, it } from 'vitest';
import {
  type CalendarCancelRequest,
  calendarCancelRefusals,
  calendarCancelUserMessage,
} from './calendar-cancel-voice';

const REQUEST: CalendarCancelRequest = {
  summary: 'Swim class',
  when: 'Thu, Jul 23 at 10:30 AM',
};

describe('calendarCancelRefusals', () => {
  it('passes a short cancellation that names the event and its time', () => {
    expect(
      calendarCancelRefusals(
        'Swim class on Thu, Jul 23 at 10:30 AM is cancelled - you can take it off your calendar.',
        REQUEST,
      ),
    ).toEqual([]);
  });

  it('refuses a text that never says which event, or never says cancelled', () => {
    expect(calendarCancelRefusals('Heads up, plans changed for Thursday.', REQUEST)).toEqual(
      expect.arrayContaining(['summary_missing', 'cancel_word_missing']),
    );
  });

  it('refuses a time it was not handed, a link, and the royal we', () => {
    expect(
      calendarCancelRefusals(
        'We cancelled Swim class at 4:15 - details at https://x.example',
        REQUEST,
      ),
    ).toEqual(expect.arrayContaining(['invented_number', 'carries_link', 'first_person_plural']));
  });

  it('refuses a text over one segment', () => {
    expect(
      calendarCancelRefusals(`Swim class is cancelled. ${'x'.repeat(160)}`, REQUEST),
    ).toContain('over_char_cap');
  });
});

describe('calendarCancelUserMessage', () => {
  it('carries the summary and time, and the refusals only on a retry', () => {
    expect(JSON.parse(calendarCancelUserMessage(REQUEST))).toEqual(REQUEST);
    expect(
      JSON.parse(calendarCancelUserMessage(REQUEST, [{ text: 'x', problems: ['empty'] }])).rejected,
    ).toEqual([{ text: 'x', problems: ['empty'] }]);
  });
});
