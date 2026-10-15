import { describe, expect, it } from 'vitest';
import type { LoopMessage } from '~/lib/channel/types';
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
    const emailOut = loopTemplateRenderer.render(other, 'email', 'generic');
    expect(emailOut.kind).toBe('email');
    if (emailOut.kind === 'email') {
      // The seam's default subject when the payload carries none.
      expect(emailOut.subject).toBe('Hale');
    }
  });

  it('REFUSES a payload with no words in it rather than sending a canned line', () => {
    // Rule #11: a dispatched message whose payload carries no text is a wiring bug, and
    // "You have a new update from Hale." delivered it as a message — the caller looked
    // successful and the parent got a sentence that says nothing.
    const empty = msg({ templateKey: 'reminder_t1h', payload: {} });
    for (const channel of ['sms', 'email'] as const) {
      expect(() => loopTemplateRenderer.render(empty, channel, 'generic')).toThrow(/no text/i);
    }
    // Text but no markup is the same bug on the email leg only.
    const textOnly = msg({ templateKey: 'reminder_t1h', payload: { text: 'Bath time' } });
    expect(() => loopTemplateRenderer.render(textOnly, 'email', 'generic')).toThrow(/no html/i);
    expect(loopTemplateRenderer.render(textOnly, 'sms', 'generic').kind).toBe('sms');
  });
});
