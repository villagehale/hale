import type { Database } from '@hale/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { refuseUnbackedSend } from '../reconcile/gate';
import { loadReconcileView } from '../reconcile/view';
import { followUpViolations } from './followup-note';
vi.mock('../reconcile/view', () => ({ loadReconcileView: vi.fn() }));
const database = {} as Database;
const now = new Date('2026-10-15T12:00:00Z');
beforeEach(() => {
  vi.mocked(loadReconcileView).mockResolvedValue({
    openKinds: new Set(['activity_followup']),
    pendingKinds: new Set(),
    registrationLaddered: false,
    mintableWindow: null,
    scheduledTitles: [],
    statedBookings: [],
  });
});
describe('registration preamble still retains the meaning of the promise', () => {
  it.each([
    "Markham fall registration opens Tuesday, and I'll remind you.",
    "Markham fall registration opens Tuesday, and I'll text you a reminder.",
    "Markham fall registration opens Tuesday, and I'll make sure to remind you.",
  ])('does not drop the registration object from an unbacked reminder: %s', async (body) => {
    expect(
      followUpViolations(
        body,
        {
          subject: 'toddler activities',
          language: 'en',
          picks: [],
          pageEvidence: 'page_has_no_schedule',
          watch: true,
          moreRemaining: 0,
        },
        true,
      ),
    ).toEqual([]);
    expect(await refuseUnbackedSend(database, { familyId: 'family-1', body, now })).toEqual([
      'no_registration_watch',
    ]);
    expect(
      await refuseUnbackedSend(database, {
        familyId: 'family-1',
        body,
        now,
        activityFollowUp: true,
      }),
    ).toEqual(['no_registration_watch']);
  });
  it('does not re-block an activity continuation because a factual registration preamble includes a clock time', async () => {
    const body =
      "Registration opens Tuesday at 7 a.m., and I'll keep watching and text you when they post them.";
    expect(
      followUpViolations(
        body,
        {
          subject: 'toddler activities',
          language: 'en',
          picks: [],
          pageEvidence: 'page_has_no_schedule',
          watch: true,
          moreRemaining: 0,
        },
        true,
      ),
    ).toEqual([]);
    expect(
      await refuseUnbackedSend(database, {
        familyId: 'family-1',
        body: body.replace(' at 7 a.m.', ''),
        now,
        activityFollowUp: true,
      }),
    ).toEqual([]);
    expect(
      await refuseUnbackedSend(database, {
        familyId: 'family-1',
        body,
        now,
        activityFollowUp: true,
      }),
    ).toEqual([]);
  });
});
