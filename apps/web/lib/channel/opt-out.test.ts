import { describe, expect, it } from 'vitest';
import { matchKeyword } from '~/lib/channel/intake/keywords';
import { smsEncoding } from '~/lib/channel/sms-segments';
import {
  OPT_OUT_LINE,
  OPT_OUT_PERIOD_DAYS,
  OPT_OUT_SHORT,
  optOutPeriodStart,
  withOptOut,
} from './opt-out';

/**
 * Outbound texts do not carry an opt-out footer (founder decision, 2026-10-01).
 * Inbound STOP is a different path: matchKeyword still honours it.
 */

describe('withOptOut', () => {
  it('returns the body unchanged for both forms', () => {
    for (const form of ['full', 'short'] as const) {
      expect(withOptOut('Swim moved to Tuesday.', form), form).toBe('Swim moved to Tuesday.');
    }
  });

  it('does not append either opt-out line', () => {
    for (const form of ['full', 'short'] as const) {
      const body = withOptOut('Body.', form);
      expect(body, form).toBe('Body.');
      expect(body, form).not.toContain(OPT_OUT_LINE);
      expect(body, form).not.toContain(OPT_OUT_SHORT);
    }
  });

  it('still names STOP as the keyword the intake machine answers', () => {
    // The footer is gone. The keyword is not. Both strings stay the ones a composer
    // must not write, and STOP itself is still what lib/channel/intake/keywords.ts
    // claims at the webhook.
    for (const line of [OPT_OUT_LINE, OPT_OUT_SHORT]) {
      expect(line, line).toContain('STOP');
    }
    expect(matchKeyword('STOP'), 'a parent who texts STOP is still opted out').toBeTruthy();
  });

  it('keeps both lines in GSM-7, so quoting one cannot double a segment', () => {
    expect(smsEncoding(OPT_OUT_LINE)).toBe('gsm7');
    expect(smsEncoding(OPT_OUT_SHORT)).toBe('gsm7');
  });
});

describe('optOutPeriodStart', () => {
  it('is an epoch-anchored grid, so every recipient agrees on the boundary unstored', () => {
    const a = new Date('2026-07-15T18:00:00.000Z');
    const b = new Date('2026-07-16T04:00:00.000Z');
    expect(optOutPeriodStart(a)).toEqual(optOutPeriodStart(b));
    expect(optOutPeriodStart(a).getTime() % (OPT_OUT_PERIOD_DAYS * 24 * 3_600_000)).toBe(0);
  });

  it('moves to a new period within the period length', () => {
    const start = optOutPeriodStart(new Date('2026-07-15T18:00:00.000Z'));
    const later = new Date(start.getTime() + OPT_OUT_PERIOD_DAYS * 24 * 3_600_000);
    expect(optOutPeriodStart(later).getTime()).toBeGreaterThan(start.getTime());
  });
});
