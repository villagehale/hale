import { describe, expect, it } from 'vitest';
import type { LoopMessage } from '~/lib/channel/types';
import { BILLING_NOTICE_TEMPLATE_KEY } from './billing-notice';
import { loopTemplateRenderer } from './registry';

/**
 * VIL-218 · B2 — the loop template registry dispatches on templateKey: a registered
 * renderer for its key, the seam's defaultLoopRenderer for everything else (E3
 * templates until they register their own).
 */

function msg(over: Partial<LoopMessage>): LoopMessage {
  return {
    templateKey: 'reminder_t1h',
    familyId: 'fam-1',
    parentUserId: 'user-1',
    category: 'reminder',
    urgency: 'normal',
    payload: {},
    ...over,
  };
}

describe('loopTemplateRenderer', () => {
  it('delegates an unregistered key to defaultLoopRenderer', () => {
    const other = msg({
      templateKey: 'reminder_t1h',
      payload: { text: 'Bath time in an hour', html: '<p>Bath time in an hour</p>' },
    });
    const sms = loopTemplateRenderer.render(other, 'sms', 'generic');
    expect(sms.kind).toBe('sms');
    if (sms.kind === 'sms') {
      expect(sms.text).toBe('Bath time in an hour');
    }
  });

  it('REFUSES a payload with no words in it rather than sending a canned line', () => {
    // Rule #11: a dispatched message whose payload carries no text is a wiring bug, and
    // "You have a new update from Hale." delivered it as a message — the caller looked
    // successful and the parent got a sentence that says nothing.
    const empty = msg({ templateKey: 'reminder_t1h', payload: {} });
    expect(() => loopTemplateRenderer.render(empty, 'sms', 'generic')).toThrow(/no text/i);
  });

  it('VIL-735 · a billing notice renders as the model’s whole text, so the claim gate reads it', () => {
    const notice = msg({
      templateKey: BILLING_NOTICE_TEMPLATE_KEY,
      category: 'alert',
      payload: { text: "You're on Plus now." },
    });
    expect(loopTemplateRenderer.render(notice, 'sms', 'generic')).toEqual({
      kind: 'sms',
      text: "You're on Plus now.",
      modelWritten: true,
    });
    // Positive control: the same payload on an unregistered key is not model-written.
    expect(
      loopTemplateRenderer.render({ ...notice, templateKey: 'other' }, 'sms', 'generic'),
    ).toMatchObject({ modelWritten: false });
  });

  it('VIL-735 · a billing notice with no text throws rather than sending a shell', () => {
    const empty = msg({ templateKey: BILLING_NOTICE_TEMPLATE_KEY, payload: { text: '  ' } });
    expect(() => loopTemplateRenderer.render(empty, 'sms', 'generic')).toThrow(/no written text/);
  });
});
