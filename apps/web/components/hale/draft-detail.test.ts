import { describe, expect, it } from 'vitest';
import { extraKeys } from './draft-detail';

/**
 * VIL-260 · WS3 — "view what Hale drafted" is the parent's window onto the payload,
 * and anything the body does not render falls through to a labeled line. Before the
 * fix that line was where the engine's machinery surfaced: a registration shortlist
 * showed "intent kind: registration_shortlist" and a week-plan placement showed its
 * 64-character `action_hash`. Meaning, not machinery.
 */
describe('extraKeys — what falls through to a labeled line', () => {
  it('never leaks the reviewer idempotency hash or the engine routing token', () => {
    const payload = {
      title: 'Burlington swim lessons',
      summary: 'Registration opens Saturday.',
      source_url: 'https://www.burlington.ca/registering',
      intentKind: 'registration_shortlist',
      action_hash: 'cced7a668e769cf5dd5123c26f94763043ad4db803af451513cdf6b7d084a2d9',
      childId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    };
    const shown = new Set(['title', 'summary', 'source_url', 'coverage_note']);

    expect(extraKeys(payload, shown)).toEqual([]);
  });

  it('never leaves a calendar placement’s raw UTC instant to be printed', () => {
    const payload = {
      title: 'Swim lesson',
      startsAt: '2026-07-01T14:00:00.000Z',
      endsAt: null,
      location: 'Centennial Pool',
      reversalHandle: 'fe-1',
      privacySensitive: false,
      action_hash: 'abc',
    };
    const shown = new Set([
      'title',
      'when',
      'date',
      'location',
      'startsAt',
      'endsAt',
      'starts_at',
      'ends_at',
    ]);

    expect(extraKeys(payload, shown)).toEqual([]);
  });

  it('still surfaces a genuine unlabeled field rather than swallowing it', () => {
    // The degradation path is deliberate: a field with no bespoke label is shown as a
    // labeled line, never dropped and never dumped as JSON.
    expect(extraKeys({ title: 'x', coverage_note: 'partial coverage' }, new Set(['title']))).toEqual(
      ['coverage_note'],
    );
  });
});
