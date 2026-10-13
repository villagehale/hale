import { AUTONOMY_ALLOWED_KINDS } from '@hale/worker/autonomy-gate';
import { describe, expect, it } from 'vitest';
import {
  AUTONOMY_MAY_KINDS,
  actedNoticeDetail,
  autonomyNoticeContext,
  noticeStanding,
  readAutonomyNotice,
} from './notice-text';

const context = {
  occasion: 'armed' as const,
  actionType: 'send_email',
  localeHint: null,
  recentInbound: [],
  detail: null,
  why: null,
};

const MAY_FALSE = {
  sendEmail: false,
  replyToEmail: false,
  addToCalendar: false,
  updateCalendar: false,
  moveCalendar: false,
  cancelCalendar: false,
  sharePhotos: false,
  addToDigest: false,
  addToRoutine: false,
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
      may: { ...MAY_FALSE, sendEmail: true },
      never: ['book', 'register', 'pay'],
      stop: 'one_message',
    });
  });

  it('marks reply only when the kind covers replying', () => {
    const parsed = JSON.parse(autonomyNoticeContext({ ...context, actionType: 'reply_to_email' }));
    expect(parsed.standing.may).toEqual({ ...MAY_FALSE, replyToEmail: true });
  });

  it('marks add-to-calendar on a calendar add, and move on a move', () => {
    const add = JSON.parse(autonomyNoticeContext({ ...context, actionType: 'calendar_add' }));
    expect(add.standing.may.addToCalendar).toBe(true);
    expect(add.standing.may.sendEmail).toBe(false);
    expect(add.standing.may.moveCalendar).toBe(false);
    const moved = JSON.parse(autonomyNoticeContext({ ...context, actionType: 'calendar_move' }));
    expect(moved.standing.may.addToCalendar).toBe(false);
    expect(moved.standing.may.moveCalendar).toBe(true);
  });

  it('gives every grantable kind at least one thing Hale may do', () => {
    expect([...AUTONOMY_ALLOWED_KINDS].sort()).toEqual([...AUTONOMY_MAY_KINDS].sort());
    for (const kind of AUTONOMY_ALLOWED_KINDS) {
      const standing = noticeStanding({ occasion: 'armed', actionType: kind });
      const trues = Object.values(standing.may ?? {}).filter(Boolean);
      expect(trues.length).toBeGreaterThan(0);
    }
  });

  it('leaves may and never off an on-its-own notice', () => {
    const parsed = JSON.parse(autonomyNoticeContext({ ...context, occasion: 'acted' }));
    expect(parsed.standing).toEqual({ may: null, never: null, stop: 'one_message' });
  });
});

describe('actedNoticeDetail', () => {
  it('labels stored payload fields and keeps the decision reason apart', () => {
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
    ).toEqual({
      detail: { to: 'school@example.com', subject: 'pickup', summary: 'Tuesday' },
      why: 'the kind was on',
    });
  });

  it('returns null when the execution stored nothing reusable', () => {
    expect(actedNoticeDetail({ payload: {}, reason: '  ' })).toEqual({ detail: null, why: null });
    expect(actedNoticeDetail({ payload: null, reason: null })).toEqual({
      detail: null,
      why: null,
    });
  });
});

describe('readAutonomyNotice detail slots', () => {
  it('allows a time that is in a labelled field and rejects one that is only in why', () => {
    const labelled = {
      ...context,
      occasion: 'acted' as const,
      detail: { summary: 'pickup at 9:30' },
      why: 'because of https://only-in-why.example/x',
    };
    expect(readAutonomyNotice({ message: 'Sent the 9:30 pickup' }, labelled)).toEqual({
      message: 'Sent the 9:30 pickup',
    });
    expect(readAutonomyNotice({ message: 'see https://only-in-why.example/x' }, labelled)).toEqual({
      skipped: 'invented',
    });
  });
});
