import { describe, expect, it } from 'vitest';
import type { LoopMessage } from '~/lib/channel/types';
import { loopTemplateRenderer } from '../registry';
import { type ReminderPayload, asReminderPayload } from './payload';

/**
 * The reminder renderer adds nothing to the model's text: no day lead, no
 * "title at time" line, no list, no link, no folding. What was written is what is sent,
 * and the dispatch is asked to keep it on the ledger row.
 */

const TEXT = 'Tomorrow at 3:00 PM there is French bingo at the library, until 4:00 PM.';

function payload(over: Partial<ReminderPayload> = {}): ReminderPayload {
  return {
    offset: '-P1D',
    timeZone: 'America/Toronto',
    events: [
      { eventRef: 'e1', title: 'Jour de congé', startsAt: '2026-10-26T19:00:00Z', childId: null },
    ],
    children: [],
    deepLink: 'https://app.villagehale.com/plan',
    unsubscribeUrl: null,
    texts: [TEXT],
    ...over,
  };
}

function message(p: ReminderPayload): LoopMessage {
  return {
    templateKey: 'reminder',
    familyId: 'fam-1',
    parentUserId: 'p1',
    category: 'reminder',
    urgency: 'normal',
    payload: p as unknown as Record<string, unknown>,
  } as LoopMessage;
}

describe('reminder renderer — the text is the whole message', () => {
  it('sends the model text byte for byte, with no prefix, line or link added', () => {
    const rendered = loopTemplateRenderer.render(message(payload()), 'sms', 'first_name');
    expect(rendered).toEqual({ kind: 'sms', text: TEXT, texts: [TEXT], recordBody: true });
  });

  it('carries several texts in the order the model wrote them, unsplit and unjoined', () => {
    const texts = ['hey, heads up for tomorrow', 'tour at 10', 'storytime 1:30 to 2:15'];
    const rendered = loopTemplateRenderer.render(message(payload({ texts })), 'sms', 'first_name');
    expect(rendered.texts).toEqual(texts);
  });

  it('reads a job enqueued before multi-text (one `text`) as one text', () => {
    const { texts: _t, ...rest } = payload();
    const legacy = { ...rest, text: TEXT } as unknown as Record<string, unknown>;
    expect(asReminderPayload(legacy).texts).toEqual([TEXT]);
  });

  it('keeps non-GSM text (zh) untouched', () => {
    const zh = '明天下午3:00到4:00在图书馆有法语宾果活动。';
    const rendered = loopTemplateRenderer.render(
      message(payload({ texts: [zh] })),
      'sms',
      'generic',
    );
    expect(rendered.text).toBe(zh);
  });

  it('refuses a payload with no text rather than building one', () => {
    expect(() =>
      asReminderPayload({ ...payload(), texts: [] } as unknown as Record<string, unknown>),
    ).toThrow(/missing texts/);
    expect(() =>
      asReminderPayload({ ...payload(), texts: ['ok', ' '] } as unknown as Record<string, unknown>),
    ).toThrow(/missing texts/);
    const { texts: _t, ...rest } = payload();
    expect(() => asReminderPayload(rest as unknown as Record<string, unknown>)).toThrow(
      /missing texts/,
    );
  });
});
