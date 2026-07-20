import { describe, expect, it } from 'vitest';
import { PUSH_PREF_ROWS } from './notification-prefs-rows';

/**
 * The Notifications section must surface EXACTLY the two push booleans the store
 * persists — never the prototype's fuller mocked list (email/appt/med/promo), which
 * has no backend (rule #1: no fabricated category). These pin the rows to the two
 * real notification_prefs streams; the values are the backend's, not copied from
 * the component's current output.
 */

describe('notification prefs rows', () => {
  it('renders exactly the two persisted push streams, in order', () => {
    expect(PUSH_PREF_ROWS.map((r) => r.pref)).toEqual(['pushNewPicks', 'pushHealthReminders']);
  });

  it('invents no third category', () => {
    expect(PUSH_PREF_ROWS).toHaveLength(2);
  });

  it('gives every row a human label and description', () => {
    for (const row of PUSH_PREF_ROWS) {
      expect(row.label.length).toBeGreaterThan(0);
      expect(row.description.length).toBeGreaterThan(0);
    }
  });
});
