import { describe, expect, it } from 'vitest';
import type { LoopMessage } from '~/lib/channel/types';
import { loopTemplateRenderer } from './registry';

/**
 * VIL-218 · B2 — the loop template registry dispatches on templateKey: the
 * weekly_plan renderer for its key, the seam's defaultLoopRenderer for everything
 * else (D1/E3 templates until they register their own).
 */

function msg(over: Partial<LoopMessage>): LoopMessage {
  return {
    templateKey: 'weekly_plan',
    familyId: 'fam-1',
    parentUserId: 'user-1',
    category: 'weekly_plan',
    urgency: 'normal',
    payload: {},
    ...over,
  };
}

describe('loopTemplateRenderer', () => {
  it('routes weekly_plan to the weekly-plan renderer', () => {
    const weeklyPlan = msg({
      templateKey: 'weekly_plan',
      payload: {
        weekStart: '2026-07-20',
        summary: null,
        items: [],
        children: [],
        deepLink: 'https://app.villagehale.com/plan',
        unsubscribeUrl: 'https://app.villagehale.com/unsubscribe?u=user-1&t=daily_digest&sig=abc',
      },
    });
    const sms = loopTemplateRenderer.render(weeklyPlan, 'sms', 'generic');
    expect(sms.kind).toBe('sms');
    if (sms.kind === 'sms') {
      expect(sms.text.startsWith('Hale:')).toBe(true);
    }
  });

  it('delegates a non-weekly_plan key to defaultLoopRenderer', () => {
    const other = msg({ templateKey: 'reminder_t1h', payload: { text: 'Bath time in an hour' } });
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
});
