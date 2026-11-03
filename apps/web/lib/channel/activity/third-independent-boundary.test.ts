import type { Database } from '@hale/db';
import { expect, it, vi } from 'vitest';
import { refuseUnbackedSend } from '../reconcile/gate';
import { loadReconcileView } from '../reconcile/view';
import { followUpViolations } from './followup-note';
vi.mock('../reconcile/view', () => ({ loadReconcileView: vi.fn() }));
it('still checks an unbacked booking in the same sentence as the activity continuation', async () => {
  vi.mocked(loadReconcileView).mockResolvedValue({
    openKinds: new Set(['activity_followup']),
    pendingKinds: new Set(),
    registrationLaddered: false,
    mintableWindow: null,
    scheduledTitles: [],
    statedBookings: [],
  });
  const body =
    "Registration opens Tuesday, and I'll keep looking for toddler activities; your well-baby visit is booked.";
  const grounding = {
    subject: 'toddler activities',
    language: 'en',
    picks: [],
    pageEvidence: 'page_has_no_schedule' as const,
    watch: true,
    moreRemaining: 0,
  };
  expect(followUpViolations(body, grounding, true)).toEqual([]);
  const input = {
    familyId: 'family-1',
    body,
    now: new Date('2026-10-15T12:00:00Z'),
    activityFollowUp: true,
  };
  expect(
    await refuseUnbackedSend({} as Database, { ...input, body: body.replace('; your', '. Your') }),
  ).toEqual(['no_scheduled_row']);
  expect(await refuseUnbackedSend({} as Database, input)).toEqual(['no_scheduled_row']);
});
