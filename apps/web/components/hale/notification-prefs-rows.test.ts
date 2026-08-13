import { describe, expect, it } from 'vitest';
import { PUSH_PREF_ROWS } from './notification-prefs-rows';

/**
 * The Notifications section must surface EXACTLY the push streams that are both
 * persisted AND actually sent — never the prototype's fuller mocked list
 * (email/appt/med/promo), which has no backend (rule #1: no fabricated category),
 * and never a switch over a stream nothing triggers. The values are the backend's,
 * not copied from the component's current output.
 */

describe('notification prefs rows', () => {
  it('renders exactly the push streams that are really sent', () => {
    expect(PUSH_PREF_ROWS.map((r) => r.pref)).toEqual(['pushNewPicks']);
  });

  it('offers no switch for health reminders — nothing triggers that stream', () => {
    // /api/cron/push-reminders exists but is absent from vercel.json's crons, so the
    // health-reminder push never fires. A control over it would be a dead switch.
    expect(PUSH_PREF_ROWS.map((r) => r.pref)).not.toContain('pushHealthReminders');
  });

  it('gives every row a human label and description', () => {
    for (const row of PUSH_PREF_ROWS) {
      expect(row.label.length).toBeGreaterThan(0);
      expect(row.description.length).toBeGreaterThan(0);
    }
  });
});
