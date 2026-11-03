import { describe, expect, it } from 'vitest';
import type { CommitmentKind } from '~/lib/commitments/ledger';
import { extractStateClaims } from './claims';
import { type ReconcileView, reconcile, withoutRefusedClaims } from './reconcile';

const OPENS = new Date('2026-09-01T11:00:00.000Z');

function view(overrides: Partial<ReconcileView> = {}): ReconcileView {
  return {
    openKinds: new Set<CommitmentKind>(),
    pendingKinds: new Set<CommitmentKind>(),
    registrationLaddered: false,
    mintableWindow: null,
    scheduledTitles: [],
    statedBookings: [],
    ...overrides,
  };
}

const verdictFor = (body: string, v: ReconcileView) => reconcile(extractStateClaims(body), v);
const reasons = (body: string, v: ReconcileView) =>
  verdictFor(body, v).refused.map((resolution) => resolution.reason);
const promised = { pendingKinds: new Set<CommitmentKind>(['activity_followup']) };

describe('reconcile — a sentence is backed only when every claim in it is', () => {
  const reproducer =
    "Registration opens Tuesday, and I'll keep looking for toddler activities; your well-baby visit is booked.";

  it('refuses the unbacked booking that rides on a registered follow-up, and cuts the whole sentence', () => {
    const body = `Swim runs Tuesdays at 4. ${reproducer}`;
    const verdict = verdictFor(body, view(promised));

    expect(verdict.refused.map((resolution) => resolution.reason)).toEqual(['no_scheduled_row']);
    expect(
      verdict.resolutions.map((resolution) =>
        resolution.status === 'matched'
          ? `matched:${resolution.matchedBy}`
          : resolution.status === 'refused'
            ? `refused:${resolution.reason}`
            : resolution.status,
      ),
    ).toEqual(['matched:pending_commitment', 'refused:no_scheduled_row']);
    expect(withoutRefusedClaims(body, verdict)).toBe('Swim runs Tuesdays at 4.');
  });

  it('matches a booking only on the words of its own clause', () => {
    const body = 'The toddler gym class is full, but your well-baby visit is booked.';
    expect(reasons(body, view({ scheduledTitles: ['Toddler Tumble'] }))).toEqual([
      'no_scheduled_row',
    ]);

    const backed = verdictFor(body, view({ scheduledTitles: ['Well-baby visit'] }));
    expect(backed.refused).toEqual([]);
    expect(backed.resolutions).toMatchObject([{ status: 'matched', matchedBy: 'scheduled_row' }]);
  });

  it.each([
    ', ',
    '; ',
    ' - ',
    ' — ',
    ': ',
    ' and ',
    ' but ',
    ' plus ',
    ' so ',
    ' also ',
    ' while ',
    ' then ',
    ' & ',
    ' / ',
    '… ',
    '... ',
  ])('refuses the unbacked booking joined to a backed promise by %j', (join) => {
    const body = `I'll keep looking for toddler activities${join}your well-baby visit is booked.`;
    expect(reasons(body, view({ ...promised, scheduledTitles: ['Toddler Tumble'] }))).toEqual([
      'no_scheduled_row',
    ]);
  });

  it('does not let one booked row back a second booking in the same sentence', () => {
    const body = 'Swim is booked, and the dentist is booked.';
    const verdict = verdictFor(body, view({ scheduledTitles: ['Swim lessons'] }));
    expect(verdict.resolutions).toMatchObject([
      { status: 'matched', matchedBy: 'scheduled_row' },
      { status: 'refused', reason: 'no_scheduled_row' },
    ]);
    expect(withoutRefusedClaims(body, verdict)).toBe('');

    expect(reasons(body, view({ scheduledTitles: ['Swim lessons', 'Dentist checkup'] }))).toEqual(
      [],
    );
  });

  it('refuses a second promise the ladder does not back', () => {
    const body = "I'll text you when registration opens, and I'll keep looking for swim classes.";
    expect(reasons(body, view({ registrationLaddered: true }))).toEqual(['no_activity_promise']);
    expect(reasons(body, view({ registrationLaddered: true, ...promised }))).toEqual([]);
  });

  it('mints a watch only when its sentence is sent', () => {
    const body =
      "I'm watching that morning and I'll text you before it goes live, and your well-baby visit is booked.";
    const window = { town: 'Riverton', opensForFamilyAt: OPENS };

    const cut = verdictFor(body, view({ mintableWindow: window }));
    expect(cut.refused.map((resolution) => resolution.reason)).toEqual(['no_scheduled_row']);
    expect(cut.mints).toEqual([]);

    const sent = verdictFor(
      body,
      view({ mintableWindow: window, scheduledTitles: ['Well-baby visit'] }),
    );
    expect(sent.refused).toEqual([]);
    expect(sent.mints).toEqual([
      {
        kind: 'registration_watch',
        summary: 'Riverton registration: a text before it opens.',
        dueAt: OPENS,
      },
    ]);
  });

  it('control: a true booking whose clause names nothing still passes', () => {
    const appositive = 'Your well-baby visit, Tuesday at 10, is booked.';
    expect(reasons(appositive, view({ scheduledTitles: ['Well-baby visit'] }))).toEqual([]);
    expect(reasons(appositive, view())).toEqual(['no_scheduled_row']);

    expect(
      reasons(
        "Toddler Tumble on Saturday at 10 - that's booked.",
        view({ scheduledTitles: ['Toddler Tumble'] }),
      ),
    ).toEqual([]);

    const reported = verdictFor('You said that, for Tuesday, the visit is booked.', view());
    expect(reported.resolutions).toEqual([]);
  });

  it('backs a true booking whose clause names only a time, and only on a matching row', () => {
    const colon = 'Swim lessons at the pool: Saturday 10am is booked.';
    expect(reasons(colon, view({ scheduledTitles: ['Swim lessons'] }))).toEqual([]);
    expect(reasons(colon, view({ scheduledTitles: ['Dentist checkup'] }))).toEqual([
      'no_scheduled_row',
    ]);

    const range = 'Swim class 10 - 11am is booked.';
    expect(reasons(range, view({ scheduledTitles: ['Swim class'] }))).toEqual([]);
    expect(reasons(range, view())).toEqual(['no_scheduled_row']);

    expect(
      reasons(
        "I'll keep looking for toddler activities; Saturday 10am is booked.",
        view({ ...promised, scheduledTitles: ['Toddler Tumble'] }),
      ),
    ).toEqual(['no_scheduled_row']);
  });

  it('control: a lone registered follow-up passes', () => {
    expect(reasons("I'll keep looking for toddler activities.", view(promised))).toEqual([]);
  });

  it('control: a booking with a matching calendar row passes', () => {
    const verdict = verdictFor(
      'Your well-baby visit is booked.',
      view({ scheduledTitles: ['Well-baby visit'] }),
    );
    expect(verdict.resolutions).toMatchObject([{ status: 'matched', matchedBy: 'scheduled_row' }]);
  });

  it('control: a booking the parent stated passes beside a registered follow-up', () => {
    const verdict = verdictFor(
      "I'll keep looking for toddler activities; your well-baby visit is booked.",
      view({ ...promised, statedBookings: ['18-month well-baby visit'] }),
    );
    expect(verdict.refused).toEqual([]);
    expect(verdict.resolutions).toMatchObject([
      { status: 'matched', matchedBy: 'pending_commitment' },
      { status: 'matched', matchedBy: 'parent_stated' },
    ]);
  });
});
