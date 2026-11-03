import type { Database } from '@hale/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { refuseUnbackedSend } from './gate';
import type { ReconcileView } from './reconcile';
import { loadReconcileView } from './view';

vi.mock('./view', () => ({ loadReconcileView: vi.fn() }));

const database = {} as Database;
const input = {
  familyId: 'family-1',
  now: new Date('2026-10-15T12:00:00Z'),
  body: "Registration opens Tuesday, September 1, and I'll keep watching and text you when they post them.",
};

let view: ReconcileView;
beforeEach(() => {
  view = {
    openKinds: new Set(['activity_followup']),
    pendingKinds: new Set(),
    registrationLaddered: false,
    mintableWindow: null,
    scheduledTitles: [],
    statedBookings: [],
  };
  vi.mocked(loadReconcileView).mockResolvedValue(view);
});

describe('an activity continuation already checked by its composer', () => {
  it.each(['; ', ', ', ' and ', ' but ', ' — ', '—', ' - ', ': ', '. '])(
    'checks a same-message booking independently of the activity continuation (%j)',
    async (separator) => {
      const body = `Registration opens Tuesday, and I'll keep looking for toddler activities${separator}Your well-baby visit is booked.`;
      expect(
        await refuseUnbackedSend(database, { ...input, body, activityFollowUp: true }),
      ).toEqual(['no_scheduled_row']);
      view.scheduledTitles = ['Toddler activities'];
      expect(
        await refuseUnbackedSend(database, { ...input, body, activityFollowUp: true }),
      ).toEqual(['no_scheduled_row']);
      view.scheduledTitles = ['Well-baby visit'];
      expect(
        await refuseUnbackedSend(database, { ...input, body, activityFollowUp: true }),
      ).toEqual([]);
    },
  );

  it('checks a booking before the activity continuation too', async () => {
    const body = "Your well-baby visit is booked; I'll keep looking for toddler activities.";
    expect(await refuseUnbackedSend(database, { ...input, body, activityFollowUp: true })).toEqual([
      'no_scheduled_row',
    ]);
    view.statedBookings = ['The well-baby visit is booked'];
    expect(await refuseUnbackedSend(database, { ...input, body, activityFollowUp: true })).toEqual(
      [],
    );
  });

  it('one backed booking cannot hide another unbacked booking', async () => {
    const body =
      "I'll keep looking for activities; your dentist is booked and your swim lesson is booked.";
    view.scheduledTitles = ['Dentist'];
    expect(await refuseUnbackedSend(database, { ...input, body, activityFollowUp: true })).toEqual([
      'no_scheduled_row',
    ]);
  });

  it('a backed booking cannot exempt an actual registration reminder', async () => {
    const body =
      "Markham registration opens Tuesday, and I'll remind you; your well-baby visit is booked.";
    view.scheduledTitles = ['Well-baby visit'];
    expect(await refuseUnbackedSend(database, { ...input, body, activityFollowUp: true })).toEqual([
      'no_registration_watch',
    ]);
  });

  it('uses the open activity promise instead of inferring a registration watch from its words', async () => {
    expect(await refuseUnbackedSend(database, { ...input, activityFollowUp: true })).toEqual([]);
  });

  it.each([
    "Registration opens Tuesday at 7 a.m., and I'll keep watching and text you when they post them.",
    "Registration for fall opens Tuesday at 7 a.m., and I'll keep watching and text you when they post them.",
    "Registration opens Tuesday after Labour Day, and I'll keep watching and text you when they post them.",
    "Registration opens Tuesday at 7 a.m., and I'll keep looking for toddler activities and text you what I find.",
    "Registration opens Tuesday, and I'll check the activity details and text you what I find.",
  ])(
    'requires positive activity-continuation evidence regardless of the public fact: %s',
    async (body) => {
      expect(
        await refuseUnbackedSend(database, { ...input, body, activityFollowUp: true }),
      ).toEqual([]);
      expect(await refuseUnbackedSend(database, { ...input, body })).toEqual([
        'no_registration_watch',
      ]);
    },
  );

  it.each([undefined, false])(
    'keeps the existing check without a continuation (%s)',
    async (activityFollowUp) => {
      expect(await refuseUnbackedSend(database, { ...input, activityFollowUp })).toEqual([
        'no_registration_watch',
      ]);
    },
  );

  it('still requires an open activity promise', async () => {
    view.openKinds = new Set();
    expect(await refuseUnbackedSend(database, { ...input, activityFollowUp: true })).toEqual([
      'no_registration_watch',
    ]);
  });

  it.each([
    "I'll keep looking for toddler activities and text you what I find. I'll remind you before Markham fall registration opens.",
    "I'll keep looking for toddler activities, and I'll remind you before Markham fall registration opens.",
    "Registration opens Tuesday, September 1, and I'll remind you before it opens.",
    "I'll keep looking for classes and text you when Markham registration opens.",
    "I'm watching Markham registration and I'll text you before it opens.",
    "Before Markham registration opens, I'll text you.",
    "When Markham registration opens, I'll text you.",
    "For Markham registration opening, I'll remind you.",
    "Markham fall registration opens Tuesday, and I'll text you.",
    "Markham fall registration opens Tuesday, and I'll make sure to notify you.",
    "Markham fall registration opens Tuesday, and I'll keep watching.",
    "Markham fall registration opens Tuesday, and I'll keep looking for activities and remind you.",
    "Markham fall registration opens Tuesday, and I'll keep watching and text you when they post them and remind you.",
    "Markham fall registration opens Tuesday, and I'll keep watching and text you when they post them. I'll remind you.",
  ])('keeps an additional registration promise subject to its own ledger: %s', async (body) => {
    expect(await refuseUnbackedSend(database, { ...input, body, activityFollowUp: true })).toEqual([
      'no_registration_watch',
    ]);
    view.openKinds = new Set([...view.openKinds, 'registration_watch']);
    expect(await refuseUnbackedSend(database, { ...input, body, activityFollowUp: true })).toEqual(
      [],
    );
  });

  it.each([
    ['Your well-baby visit is booked.', 'no_scheduled_row'],
    ["I'll send an invite to that number.", 'no_coparent_invite'],
    ["I'll cut the one sec messages and just answer.", 'self_referential'],
  ])('still checks the additional claim: %s', async (extra, reason) => {
    expect(
      await refuseUnbackedSend(database, {
        ...input,
        body: `${input.body} ${extra}`,
        activityFollowUp: true,
      }),
    ).toEqual([reason]);
  });
});
