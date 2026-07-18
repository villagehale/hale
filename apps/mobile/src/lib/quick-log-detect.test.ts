import { describe, expect, it } from 'vitest';

import { detectQuickLog } from './quick-log-detect';

/**
 * Mobile-side quick-log detection, REPLICATED from the web
 * QUICK_LOG_EPISODE_RULES (apps/web/lib/coach/action-intent.ts) — the native
 * bundle can't import server code, so the regex rules are hand-copied (same
 * pattern as api-types.ts). Detection is pure: a closed set of regexes, no LLM
 * (rule #2). It ADDS amount extraction the web parser leaves to the form
 * (amountMl for a feed, durationMin for a nap) so the mobile confirm card is
 * actionable in one tap. Expected values are derived from the phrasing + the
 * standard 1 oz = 30 ml convention, not copied from the code's output.
 */

describe('detectQuickLog', () => {
  it('detects a feed and converts ounces to millilitres (4oz → 120ml)', () => {
    const match = detectQuickLog('baby had a 4oz bottle');
    expect(match?.kind).toBe('feed');
    if (match?.kind === 'feed') expect(match.amountMl).toBe(120);
  });

  it('detects a feed with an explicit millilitre amount', () => {
    const match = detectQuickLog('Noah had a 90ml bottle at 3pm');
    expect(match?.kind).toBe('feed');
    if (match?.kind === 'feed') {
      expect(match.amountMl).toBe(90);
      expect(match.timeHint).toBe('3pm');
      expect(match.childName).toBe('Noah');
    }
  });

  it('detects a feed with no amount (parent fills it in)', () => {
    const match = detectQuickLog('she had a feed');
    expect(match?.kind).toBe('feed');
    if (match?.kind === 'feed') {
      expect(match.amountMl).toBeUndefined();
      expect(match.feedAmount).toBeUndefined();
    }
  });

  it('lifts a qualitative feed amount from "ate all" (→ all), no invented millilitres', () => {
    const match = detectQuickLog('Sebastian had a bottle and ate all his lunch');
    expect(match?.kind).toBe('feed');
    if (match?.kind === 'feed') {
      expect(match.amountMl).toBeUndefined();
      expect(match.feedAmount).toBe('all');
    }
  });

  it('lifts "most of it" (→ most) and "a little" (→ little)', () => {
    const most = detectQuickLog('had a bottle and ate most of it');
    expect(most?.kind === 'feed' && most.feedAmount).toBe('most');
    const little = detectQuickLog('had a little bottle');
    expect(little?.kind === 'feed' && little.feedAmount).toBe('little');
  });

  it('lifts "half" (→ half)', () => {
    const match = detectQuickLog('had half a bottle');
    expect(match?.kind === 'feed' && match.feedAmount).toBe('half');
  });

  it('prefers a numeric amount over a qualitative one (4oz wins, feedAmount stays unset)', () => {
    const match = detectQuickLog('had a 4oz bottle and finished it all');
    expect(match?.kind).toBe('feed');
    if (match?.kind === 'feed') {
      expect(match.amountMl).toBe(120);
      expect(match.feedAmount).toBeUndefined();
    }
  });

  it('detects a nap and reads its duration in minutes', () => {
    const match = detectQuickLog('took a 45 minute nap this afternoon');
    expect(match?.kind).toBe('nap');
    if (match?.kind === 'nap') {
      expect(match.durationMin).toBe(45);
      expect(match.timeHint).toBe('this afternoon');
    }
  });

  it('detects a nap phrased as "napped" with no duration', () => {
    const match = detectQuickLog('he napped for a bit');
    expect(match?.kind).toBe('nap');
    if (match?.kind === 'nap') expect(match.durationMin).toBeUndefined();
  });

  it('detects a milestone and reads its text after "milestone:"', () => {
    const match = detectQuickLog('Ava hit a milestone: first steps today');
    expect(match?.kind).toBe('milestone');
    if (match?.kind === 'milestone') {
      expect(match.milestone).toBe('first steps today');
      expect(match.childName).toBe('Ava');
    }
  });

  it('detects a diaper from a diaper mention and reads a dirty kind', () => {
    const match = detectQuickLog('changed a dirty diaper for Mira');
    expect(match?.kind).toBe('diaper');
    if (match?.kind === 'diaper') expect(match.diaperKind).toBe('dirty');
  });

  it('detects a diaper from a poop mention with no "diaper" word (dirty kind)', () => {
    const match = detectQuickLog('she pooped after lunch');
    expect(match?.kind).toBe('diaper');
    if (match?.kind === 'diaper') expect(match.diaperKind).toBe('dirty');
  });

  it('reads a wet diaper kind', () => {
    const match = detectQuickLog('just a wet diaper');
    expect(match?.kind).toBe('diaper');
    if (match?.kind === 'diaper') expect(match.diaperKind).toBe('wet');
  });

  it('returns null for an ordinary question (no false log surface)', () => {
    expect(detectQuickLog('is it normal for a toddler to skip a nap?')).toBeNull();
    expect(detectQuickLog('how much should a 6-month-old eat?')).toBeNull();
  });

  it('feed wins when a message reads as both a feed and a nap', () => {
    // Episode order mirrors the web rule set: feed is checked before nap.
    const match = detectQuickLog('had a bottle before her nap');
    expect(match?.kind).toBe('feed');
  });

  it('feed still wins over diaper (episode order feed → nap → diaper → milestone)', () => {
    const match = detectQuickLog('had a bottle then a wet diaper');
    expect(match?.kind).toBe('feed');
  });
});
