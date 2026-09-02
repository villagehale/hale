import { describe, expect, it } from 'vitest';
import { MAX_NUDGE_SEGMENTS, NUDGE_OPT_OUT } from '~/lib/channel/nudge/shell';
import { matchKeyword } from '~/lib/channel/intake/keywords';
import { smsEncoding, smsSegments } from '~/lib/channel/sms-segments';
import {
  OPT_OUT_LINE,
  OPT_OUT_PERIOD_DAYS,
  OPT_OUT_SHORT,
  optOutPeriodStart,
  withOptOut,
} from './opt-out';

/**
 * This is a LEGAL INSTRUMENT, not copy. CASL s.6(2)(c)/s.11 want the unsubscribe mechanism
 * set out clearly and prominently in every commercial electronic message, and readily
 * performed. These assertions are the three things that make that true: it is always
 * there, it names the keyword the machine actually honours, and it survives the wire.
 */

describe('withOptOut', () => {
  it('has no variant that omits the unsubscribe', () => {
    // The type has two members and both carry it. There is no third.
    for (const form of ['full', 'short'] as const) {
      const body = withOptOut('Swim moved to Tuesday.', form);
      expect(body, form).toContain('STOP');
      expect(body, form).toMatch(/opt out/);
      expect(body.startsWith('Swim moved to Tuesday.'), form).toBe(true);
    }
  });

  it('gives the full form its own paragraph and the short form its own line', () => {
    expect(withOptOut('Body.', 'full')).toBe('Body.\n\nReply STOP to opt out.');
    expect(withOptOut('Body.', 'short')).toBe('Body.\nSTOP to opt out.');
  });

  it('keeps the short form on a line of its own, not tucked into the sentence', () => {
    // A parenthetical would be shorter and is the version that starts to fail "clearly and
    // prominently". The newline is what keeps the mechanism visible.
    const short = withOptOut('Body.', 'short');
    expect(short.split('\n').at(-1)).toBe(OPT_OUT_SHORT);
    expect(short).not.toMatch(/\(.*STOP.*\)/);
  });

  it('names STOP in the exact case the intake machine answers', () => {
    // The mechanism has to WORK, not just be described. Both forms must name the keyword
    // that lib/channel/intake/keywords.ts claims at the webhook.
    for (const line of [OPT_OUT_LINE, OPT_OUT_SHORT]) {
      expect(line, line).toContain('STOP');
      expect(matchKeyword('STOP'), 'the named keyword must be one the machine honours').toBeTruthy();
    }
  });

  it('is shorter in the short form - that is the whole point of having two', () => {
    expect(withOptOut('Body.', 'short').length).toBeLessThan(
      withOptOut('Body.', 'full').length,
    );
  });

  it('survives the wire in GSM-7 - one fancy character would double every message', () => {
    expect(smsEncoding(OPT_OUT_LINE)).toBe('gsm7');
    expect(smsEncoding(OPT_OUT_SHORT)).toBe('gsm7');
  });

  it('leaves the composed segment budgets conservative for BOTH forms', () => {
    // nudge-voice.ts and health/copy.ts size a message against `\n\n` + the FULL line. The
    // short form is strictly shorter, so those budgets remain the bound for both and needed
    // no change — this is the assertion that keeps that true.
    const longest = 'x'.repeat(200);
    expect(withOptOut(longest, 'short').length).toBeLessThanOrEqual(
      `${longest}\n\n${NUDGE_OPT_OUT}`.length,
    );
    expect(smsSegments(`${longest}\n\n${NUDGE_OPT_OUT}`)).toBeGreaterThanOrEqual(
      smsSegments(withOptOut(longest, 'short')),
    );
    expect(MAX_NUDGE_SEGMENTS).toBe(2);
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
