import { describe, expect, it } from 'vitest';
import type { LoopMessage } from '~/lib/channel/types';
import { loopTemplateRenderer } from '../registry';
import { asReminderPayload, type ReminderPayload } from './payload';

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
    text: TEXT,
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
    expect(rendered).toEqual({ kind: 'sms', text: TEXT, recordBody: true });
  });

  it('keeps non-GSM text (zh) untouched', () => {
    const zh = '明天下午3:00到4:00在图书馆有法语宾果活动。';
    const rendered = loopTemplateRenderer.render(message(payload({ text: zh })), 'sms', 'generic');
    expect(rendered.text).toBe(zh);
  });

  it('refuses a payload with no text rather than building one', () => {
    expect(() =>
      asReminderPayload({ ...payload(), text: '' } as unknown as Record<string, unknown>),
    ).toThrow(/missing text/);
    const { text: _t, ...rest } = payload();
    expect(() => asReminderPayload(rest as unknown as Record<string, unknown>)).toThrow(
      /missing text/,
    );
  });
});
