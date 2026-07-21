import { describe, expect, it } from 'vitest';
import { REASK_AFTER_MS, nextPromptAction } from './push-permission';

/**
 * The moment-of-value permission decision. Expected values are derived from the spec:
 * a granted OS permission just (re)registers the token; a denied one is idle (the OS
 * won't re-prompt — only the Settings deep-link can help); an undetermined one offers
 * the explainer unless the parent declined within the re-ask window (30 days).
 */
const NOW = new Date('2026-07-21T12:00:00.000Z');

describe('nextPromptAction', () => {
  it('registers (no prompt) when the OS permission is already granted', () => {
    expect(nextPromptAction('granted', null, NOW)).toBe('register');
    // Even a prior decline is moot once granted (the parent turned it on since).
    expect(nextPromptAction('granted', { kind: 'declined', at: NOW.toISOString() }, NOW)).toBe(
      'register',
    );
  });

  it('stays idle when the OS permission is denied (Settings path only, never re-prompt)', () => {
    expect(nextPromptAction('denied', null, NOW)).toBe('idle');
    expect(nextPromptAction('denied', { kind: 'declined', at: NOW.toISOString() }, NOW)).toBe(
      'idle',
    );
  });

  it('offers the explainer when undetermined and never asked', () => {
    expect(nextPromptAction('undetermined', null, NOW)).toBe('offer');
  });

  it('stays idle when undetermined but the parent declined within the re-ask window', () => {
    const declinedAt = new Date(NOW.getTime() - (REASK_AFTER_MS - 1)).toISOString();
    expect(nextPromptAction('undetermined', { kind: 'declined', at: declinedAt }, NOW)).toBe('idle');
  });

  it('re-offers once the re-ask window has elapsed since the decline (>= 30 days)', () => {
    const declinedAt = new Date(NOW.getTime() - REASK_AFTER_MS).toISOString();
    expect(nextPromptAction('undetermined', { kind: 'declined', at: declinedAt }, NOW)).toBe(
      'offer',
    );
  });
});
