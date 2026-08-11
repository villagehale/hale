import { describe, expect, it } from 'vitest';
import { parseInboundEmailEvent } from './payload';

/** The documented `email.received` shape (resend.com/docs/webhooks/emails/received). */
function event(dataOverrides: Record<string, unknown> = {}, type = 'email.received') {
  return JSON.stringify({
    type,
    created_at: '2026-08-11T23:41:12.126Z',
    data: {
      email_id: '56761188-7520-42d8-8898-ff6fc54ce618',
      created_at: '2026-08-11T23:41:11.894Z',
      from: 'Sam <sam@example.com>',
      to: ['hale@mail.villagehale.com'],
      cc: [],
      bcc: [],
      message_id: '<111-222-333@mail.example.com>',
      subject: 'Re: your week',
      attachments: [],
      ...dataOverrides,
    },
  });
}

describe('parseInboundEmailEvent', () => {
  it('lifts the fields the leg acts on out of a documented payload', () => {
    expect(parseInboundEmailEvent(event())).toEqual({
      emailId: '56761188-7520-42d8-8898-ff6fc54ce618',
      from: 'Sam <sam@example.com>',
      to: ['hale@mail.villagehale.com'],
      messageId: '<111-222-333@mail.example.com>',
      subject: 'Re: your week',
      attachmentCount: 0,
      receivedAt: new Date('2026-08-11T23:41:11.894Z'),
    });
  });

  it('counts attachments', () => {
    const parsed = parseInboundEmailEvent(
      event({ attachments: [{ id: 'a', filename: 'x.png' }, { id: 'b', filename: 'y.pdf' }] }),
    );
    expect(parsed?.attachmentCount).toBe(2);
  });

  /**
   * One endpoint can be subscribed to several event types, and a delivery event carries
   * a completely different `data` shape. Acting on one as if it were an inbound message
   * would route a bounce notification into a family's conversation.
   */
  it('ignores any event type that is not email.received', () => {
    for (const type of ['email.delivered', 'email.bounced', 'contact.created', '']) {
      expect(parseInboundEmailEvent(event({}, type))).toBeNull();
    }
  });

  it('returns null rather than throwing on malformed JSON', () => {
    for (const body of ['', 'not json', '{', '[]', 'null', '"a string"', '123']) {
      expect(parseInboundEmailEvent(body)).toBeNull();
    }
  });

  it('returns null when a field the leg cannot proceed without is missing', () => {
    for (const missing of ['email_id', 'from', 'message_id']) {
      expect(parseInboundEmailEvent(event({ [missing]: undefined }))).toBeNull();
    }
  });

  it('returns null when a required field is the wrong type', () => {
    expect(parseInboundEmailEvent(event({ email_id: 42 }))).toBeNull();
    expect(parseInboundEmailEvent(event({ from: null }))).toBeNull();
    expect(parseInboundEmailEvent(event({ to: 'not-an-array' }))).toBeNull();
  });

  it('tolerates an absent subject, which is not a reason to drop a message', () => {
    expect(parseInboundEmailEvent(event({ subject: undefined }))?.subject).toBe('');
  });

  it('tolerates absent recipient and attachment lists', () => {
    const parsed = parseInboundEmailEvent(event({ to: undefined, attachments: undefined }));
    expect(parsed?.to).toEqual([]);
    expect(parsed?.attachmentCount).toBe(0);
  });

  /** The event's own `created_at` is a fallback for the data timestamp. */
  it('falls back to the envelope timestamp when the message has none', () => {
    expect(parseInboundEmailEvent(event({ created_at: undefined }))?.receivedAt).toEqual(
      new Date('2026-08-11T23:41:12.126Z'),
    );
  });

  it('returns null when neither timestamp can be read', () => {
    const body = JSON.stringify({
      type: 'email.received',
      data: { email_id: 'e', from: 'a@b.test', message_id: '<m>' },
    });
    expect(parseInboundEmailEvent(body)).toBeNull();
  });

  it('falls back to the envelope when the message timestamp is unparseable', () => {
    expect(parseInboundEmailEvent(event({ created_at: 'whenever' }))?.receivedAt).toEqual(
      new Date('2026-08-11T23:41:12.126Z'),
    );
  });

  /** An `Invalid Date` would flow silently into a ledger row and a rate-limit window. */
  it('returns null when no timestamp anywhere is parseable, never an Invalid Date', () => {
    const body = JSON.stringify({
      type: 'email.received',
      created_at: 'whenever',
      data: { email_id: 'e', from: 'a@b.test', message_id: '<m>', created_at: 'also whenever' },
    });
    expect(parseInboundEmailEvent(body)).toBeNull();
  });
});
