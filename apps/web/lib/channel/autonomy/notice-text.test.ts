import { describe, expect, it } from 'vitest';
import { actedNoticeDetail, autonomyNoticeContext, readAutonomyNotice } from './notice-text';

const context = {
  occasion: 'armed' as const,
  actionType: 'send_email',
  localeHint: null,
  recentInbound: [],
  detail: null,
};

describe('readAutonomyNotice', () => {
  it('keeps a non-empty message', () => {
    expect(readAutonomyNotice({ message: '  hello there  ' }, context)).toEqual({
      message: 'hello there',
    });
  });

  it('names an empty or unparsed tool input', () => {
    expect(readAutonomyNotice({ message: '   ' }, context)).toEqual({ skipped: 'unparsed' });
    expect(readAutonomyNotice({}, context)).toEqual({ skipped: 'unparsed' });
  });

  it('names a time or a link the context did not give', () => {
    expect(readAutonomyNotice({ message: 'see https://example.test/x' }, context)).toEqual({
      skipped: 'invented',
    });
    expect(readAutonomyNotice({ message: 'at 9:30' }, context)).toEqual({ skipped: 'invented' });
  });

  it('keeps a long message', () => {
    const message = 'a'.repeat(2000);
    expect(readAutonomyNotice({ message }, context)).toEqual({ message });
  });
});

describe('autonomyNoticeContext', () => {
  it('puts send, never, and one-message on a send-email turn-on', () => {
    const parsed = JSON.parse(autonomyNoticeContext(context));
    expect(parsed.standing).toEqual({
      may: { sendEmail: true, replyToEmail: false, addToCalendar: false },
      never: ['book', 'register', 'pay'],
      stop: 'one_message',
    });
  });

  it('marks reply only when the kind covers replying', () => {
    const parsed = JSON.parse(autonomyNoticeContext({ ...context, actionType: 'reply_to_email' }));
    expect(parsed.standing.may).toEqual({
      sendEmail: false,
      replyToEmail: true,
      addToCalendar: false,
    });
  });

  it('marks add-to-calendar on a calendar add, and not on a move', () => {
    const add = JSON.parse(autonomyNoticeContext({ ...context, actionType: 'calendar_add' }));
    expect(add.standing.may.addToCalendar).toBe(true);
    expect(add.standing.may.sendEmail).toBe(false);
    const moved = JSON.parse(autonomyNoticeContext({ ...context, actionType: 'calendar_move' }));
    expect(moved.standing.may.addToCalendar).toBe(false);
  });

  it('leaves may and never off an on-its-own notice', () => {
    const parsed = JSON.parse(autonomyNoticeContext({ ...context, occasion: 'acted' }));
    expect(parsed.standing).toEqual({ may: null, never: null, stop: 'one_message' });
  });
});

describe('actedNoticeDetail', () => {
  it('joins stored payload fields and the decision reason', () => {
    expect(
      actedNoticeDetail({
        payload: {
          to: ' school@example.com ',
          subject: 'pickup',
          title: '',
          summary: 'Tuesday',
          ignored: 'no',
        },
        reason: ' the kind was on ',
      }),
    ).toBe('school@example.com\npickup\nTuesday\nthe kind was on');
  });

  it('returns null when the execution stored nothing reusable', () => {
    expect(actedNoticeDetail({ payload: {}, reason: '  ' })).toBeNull();
    expect(actedNoticeDetail({ payload: null, reason: null })).toBeNull();
  });
});
