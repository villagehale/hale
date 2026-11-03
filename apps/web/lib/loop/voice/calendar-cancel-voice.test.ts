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

  it('refuses a text that never names the event', () => {
    expect(calendarCancelRefusals('Heads up, plans changed for Thursday.', REQUEST)).toEqual([
      'summary_missing',
    ]);
  });

  it('VIL-450: no wording rules - any language, any voice, any length passes the fact gate', () => {
    for (const body of [
      'Swim class 取消了，记得从日历里删掉。',
      'Swim class est annulé, tu peux le retirer de ton calendrier.',
      'تم إلغاء Swim class، يمكنك حذفه من التقويم.',
      'swim class is off - Hale will leave it to you to clear it, we hope that helps',
      `Swim class is off. ${'Sorry about that. '.repeat(12)}`,
    ]) {
      expect(calendarCancelRefusals(body, REQUEST), body).toEqual([]);
    }
  });

  it('refuses a time it was not handed and a link', () => {
    expect(
      calendarCancelRefusals(
        'We cancelled Swim class at 4:15 - details at https://x.example',
        REQUEST,
      ),
    ).toEqual(expect.arrayContaining(['invented_number', 'carries_link']));
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
