import { describe, expect, it } from 'vitest';
import type { CommitmentKind } from '~/lib/commitments/ledger';
import { extractStateClaims } from './claims';
import {
  type ReconcileView,
  reconcile,
  reconcileViolations,
  withoutRefusedClaims,
} from './reconcile';

const OPENS = new Date('2026-09-01T11:00:00.000Z');

function view(overrides: Partial<ReconcileView> = {}): ReconcileView {
  return {
    openKinds: new Set<CommitmentKind>(),
    pendingKinds: new Set<CommitmentKind>(),
    registrationLaddered: false,
    mintableWindow: null,
    scheduledTitles: [],
    ...overrides,
  };
}

const verdictFor = (body: string, v: ReconcileView) => reconcile(extractStateClaims(body), v);

describe('reconcile — the registration watch', () => {
  const body = "I'm watching that morning and I'll text you before it goes live.";

  it('MINTS against a matched, armed window — the Aug 21 turn, kept', () => {
    const verdict = verdictFor(
      body,
      view({ mintableWindow: { town: 'Halton Hills', opensForFamilyAt: OPENS } }),
    );
    expect(verdict.refused).toEqual([]);
    expect(verdict.mints).toEqual([
      {
        kind: 'registration_watch',
        summary: 'Halton Hills registration: a text before it opens.',
        dueAt: OPENS,
      },
    ]);
  });

  it('MATCHES a ladder that is already running, and mints nothing', () => {
    const verdict = verdictFor(
      body,
      view({
        registrationLaddered: true,
        mintableWindow: { town: 'Halton Hills', opensForFamilyAt: OPENS },
      }),
    );
    expect(verdict.mints).toEqual([]);
    expect(verdict.resolutions[0]).toMatchObject({ status: 'matched', matchedBy: 'live_sequence' });
  });

  it('MATCHES a watch already on the ledger', () => {
    const verdict = verdictFor(body, view({ openKinds: new Set(['registration_watch']) }));
    expect(verdict.mints).toEqual([]);
    expect(verdict.resolutions[0]).toMatchObject({
      status: 'matched',
      matchedBy: 'open_commitment',
    });
  });

  it('REFUSES when no window matched and no ladder runs — there is nothing to watch with', () => {
    const verdict = verdictFor(body, view());
    expect(verdict.mints).toEqual([]);
    expect(verdict.refused.map((r) => r.reason)).toEqual(['no_registration_watch']);
  });
});

describe('reconcile — the activity follow-up', () => {
  const body = "I'm checking details on 5 finds nearby - I'll text you the good ones.";

  it('REFUSES when the promise tool was never called — the Aug 12 turn', () => {
    expect(verdictFor(body, view()).refused.map((r) => r.reason)).toEqual(['no_activity_promise']);
  });

  it('MATCHES the promise this very send is about to write', () => {
    const verdict = verdictFor(body, view({ pendingKinds: new Set(['activity_followup']) }));
    expect(verdict.refused).toEqual([]);
    expect(verdict.resolutions[0]).toMatchObject({
      status: 'matched',
      matchedBy: 'pending_commitment',
    });
  });

  it('MATCHES an open promise from an earlier turn — a sweep already owes them', () => {
    const verdict = verdictFor(body, view({ openKinds: new Set(['activity_followup']) }));
    expect(verdict.refused).toEqual([]);
  });

  it('never mints one itself — the subject would come from the model\'s own prose', () => {
    expect(verdictFor(body, view()).mints).toEqual([]);
  });
});

describe('reconcile — the booking claim', () => {
  it('REFUSES a booking for a family with nothing on the calendar', () => {
    expect(verdictFor('Your well-baby visit is booked.', view()).refused.map((r) => r.reason)).toEqual([
      'no_scheduled_row',
    ]);
  });

  it('MATCHES a live placement that shares a word with the claim', () => {
    const verdict = verdictFor(
      'Your well-baby visit is booked.',
      view({ scheduledTitles: ['Well-baby checkup'] }),
    );
    expect(verdict.refused).toEqual([]);
    expect(verdict.resolutions[0]).toMatchObject({ status: 'matched', matchedBy: 'scheduled_row' });
  });

  it('REFUSES a booking that shares nothing with what is actually on the calendar', () => {
    const verdict = verdictFor(
      'Your swim lesson is booked.',
      view({ scheduledTitles: ['Well-baby checkup'] }),
    );
    expect(verdict.refused.map((r) => r.reason)).toEqual(['no_scheduled_row']);
  });
});

describe('reconcile — the promise nothing can back', () => {
  it('REFUSES a self-referential promise however full the ledger is', () => {
    const verdict = verdictFor(
      "I'll cut the one sec messages and just answer.",
      view({
        openKinds: new Set(['activity_followup', 'registration_watch']),
        registrationLaddered: true,
        mintableWindow: { town: 'Halton Hills', opensForFamilyAt: OPENS },
        scheduledTitles: ['Well-baby checkup'],
      }),
    );
    expect(verdict.refused.map((r) => r.reason)).toEqual(['self_referential']);
    expect(verdict.mints).toEqual([]);
  });
});

describe('reconcile — what a refused body produces', () => {
  const body =
    "Swim runs Tuesdays at 4 at the Gellert. I'll cut the one sec messages and just answer.";

  it('names the violation for the re-ask, deduplicated', () => {
    const violations = reconcileViolations(verdictFor(body, view()));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('promises to change how Hale itself behaves');
  });

  it('cuts the refused sentence and leaves the rest verbatim', () => {
    expect(withoutRefusedClaims(body, verdictFor(body, view()))).toBe(
      'Swim runs Tuesdays at 4 at the Gellert.',
    );
  });

  it('returns empty when the whole reply was the unbacked claim', () => {
    const only = "I'll cut the one sec messages and just answer.";
    expect(withoutRefusedClaims(only, verdictFor(only, view()))).toBe('');
  });

  it('leaves a clean body untouched and asks for nothing', () => {
    const clean = 'Swim runs Tuesdays at 4 at the Gellert.';
    const verdict = verdictFor(clean, view());
    expect(verdict.refused).toEqual([]);
    expect(reconcileViolations(verdict)).toEqual([]);
    expect(withoutRefusedClaims(clean, verdict)).toBe(clean);
  });
});
