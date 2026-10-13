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
  it('puts the standing facts on an email kind', () => {
    const parsed = JSON.parse(autonomyNoticeContext(context));
    expect(parsed.standing).toEqual({
      never: ['book', 'register', 'pay'],
      repliesToEmail: true,
      stop: 'one_message',
    });
  });

  it('leaves the email-reply fact off a calendar kind', () => {
    const parsed = JSON.parse(autonomyNoticeContext({ ...context, actionType: 'calendar_add' }));
    expect(parsed.standing.repliesToEmail).toBe(false);
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
