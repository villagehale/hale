import { describe, expect, it } from 'vitest';

import { nextDeleteState, scheduledDeletionCopy, shareLinkLabel } from './privacy-data';

describe('nextDeleteState — the two-step delete gate (no autonomous erasure)', () => {
  it('a first tap only reveals the confirm step, it never posts', () => {
    expect(nextDeleteState('idle', 'start')).toBe('confirming');
  });

  it('idle never jumps straight to pending on a confirm event (must pass through confirming)', () => {
    expect(nextDeleteState('idle', 'confirm')).toBe('idle');
  });

  it('only an explicit confirm from the revealed step starts the post', () => {
    expect(nextDeleteState('confirming', 'confirm')).toBe('pending');
  });

  it('a post that resolves 202 lands the scheduled success', () => {
    expect(nextDeleteState('pending', 'success')).toBe('scheduled');
  });

  it('a failed post becomes a retryable error, and a retry re-enters pending', () => {
    expect(nextDeleteState('pending', 'failure')).toBe('error');
    expect(nextDeleteState('error', 'confirm')).toBe('pending');
  });

  it('cancel from any pre-success state backs out to idle', () => {
    expect(nextDeleteState('confirming', 'cancel')).toBe('idle');
    expect(nextDeleteState('error', 'cancel')).toBe('idle');
  });

  it('the scheduled success is terminal — no event moves off it', () => {
    for (const event of ['start', 'confirm', 'cancel', 'success', 'failure'] as const) {
      expect(nextDeleteState('scheduled', event)).toBe('scheduled');
    }
  });

  it('a spurious success/failure before a post is in flight is a no-op', () => {
    expect(nextDeleteState('confirming', 'success')).toBe('confirming');
    expect(nextDeleteState('idle', 'failure')).toBe('idle');
  });
});

describe('shareLinkLabel — the human name for a link kind (never the raw enum)', () => {
  it('labels a week plan and a local pick', () => {
    expect(shareLinkLabel('week_plan')).toBe('This week with Hale');
    expect(shareLinkLabel('activity')).toBe('A local pick');
  });
});

describe('scheduledDeletionCopy — the honest scheduled-date line', () => {
  it('states the long-form date and the cancel note', () => {
    // Derive the expected date the same way the function does (independent of TZ),
    // then assert the copy composes that date + the standing cancel note.
    const iso = '2026-07-16T12:00:00.000Z';
    const expectedDate = new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    expect(scheduledDeletionCopy(iso)).toBe(
      `Deletion scheduled for ${expectedDate}. Contact us before then to cancel.`,
    );
    expect(expectedDate).toContain('July');
  });

  it('falls back to a date-less line when the instant is missing', () => {
    expect(scheduledDeletionCopy(null)).toBe(
      'Deletion scheduled. Contact us before it completes to cancel.',
    );
  });

  it('never shows "Invalid Date" for an unparseable instant', () => {
    const copy = scheduledDeletionCopy('not-a-date');
    expect(copy).not.toContain('Invalid Date');
    expect(copy).toBe('Deletion scheduled. Contact us before it completes to cancel.');
  });
});
