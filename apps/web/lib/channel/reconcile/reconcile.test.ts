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
    statedBookings: [],
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

/**
 * VIL-337 · a watched course page backs the watch sentence too.
 *
 * The ack a parent gets after `watch_for_opening` — "I'm watching that class and I'll
 * text you when a spot opens" — is classified `registration_watch` by kindOf, and before
 * this it was refused twice and rewritten away while the row it names was one send from
 * existing. The widening is two membership checks; the negative control below is what
 * keeps it from becoming "any open commitment backs any watch sentence".
 */
describe('reconcile — the spot watch', () => {
  const body = "I'm watching that class and I'll text you when a spot opens.";

  it('MATCHES the watch this very send is about to arm', () => {
    const verdict = verdictFor(body, view({ pendingKinds: new Set(['spot_watch']) }));
    expect(verdict.refused).toEqual([]);
    expect(verdict.mints).toEqual([]);
    expect(verdict.resolutions[0]).toMatchObject({
      status: 'matched',
      matchedBy: 'pending_commitment',
    });
  });

  it('MATCHES a watch this family already has open', () => {
    const verdict = verdictFor(body, view({ openKinds: new Set(['spot_watch']) }));
    expect(verdict.refused).toEqual([]);
    expect(verdict.resolutions[0]).toMatchObject({
      status: 'matched',
      matchedBy: 'open_commitment',
    });
  });

  it('REFUSES the same sentence with no watch, no window and no ladder', () => {
    // THE NEGATIVE CONTROL. Without it the two tests above pass on a branch that
    // matches every registration claim regardless of what is in the view.
    const verdict = verdictFor(body, view());
    expect(verdict.mints).toEqual([]);
    expect(verdict.refused.map((r) => r.reason)).toEqual(['no_registration_watch']);
  });

  it('does not let an unrelated open commitment back it', () => {
    const verdict = verdictFor(body, view({ openKinds: new Set(['activity_followup']) }));
    expect(verdict.refused.map((r) => r.reason)).toEqual(['no_registration_watch']);
  });

  /**
   * THE WIDENING IS ONLY AS WIDE AS THE SENTENCE. `kindOf` reads every "I'll text you
   * before X opens" as `registration_watch`, so a MUNICIPAL-MORNING promise and a
   * one-class spot promise arrive here as the same kind — and a watched course page
   * cannot back the morning. The town's season is the ladder's job; one page in Markham
   * says nothing about when Markham's fall registration goes live.
   *
   * A NAMED SEASON IS ALSO THE END OF THE SPOT REFUSAL. These two are refused with the
   * registration reason rather than the spot one, because there is no wording of a
   * season a course page could back: the re-ask has to send the model off the morning,
   * not hand it a word to add to it.
   */
  it('REFUSES a municipal-morning promise that only a watched course page could back', () => {
    const morning = "I'll text you before Markham fall registration opens.";

    const verdict = verdictFor(morning, view({ openKinds: new Set(['spot_watch']) }));

    expect(verdict.mints).toEqual([]);
    expect(verdict.refused.map((r) => r.reason)).toEqual(['no_registration_watch']);
  });

  it('REFUSES the same morning promise against a spot watch this send is about to arm', () => {
    const morning = "I'm watching that morning and I'll text you before it goes live.";

    const verdict = verdictFor(morning, view({ pendingKinds: new Set(['spot_watch']) }));

    expect(verdict.refused.map((r) => r.reason)).toEqual(['no_registration_watch']);
  });

  /**
   * THE ONE WORD THAT BYPASSED THE NARROWING. A watched course page backs a sentence
   * about that page; the widening above reads the sentence for the words a `watched_spots`
   * row is about. So a MUNICIPAL promise that also happens to carry one of those words
   * ("...before a spot opens" about a town's fall registration) walked straight through
   * it — and the refusal's own re-ask copy, which asks for exactly that word, is what a
   * refused model reaches for first. A season is not a class however it is worded, so the
   * spot words only count when nothing in the sentence names the season.
   */
  it('REFUSES a registration morning that borrows a spot word', () => {
    // Both halves of the season, one sentence each: the calendar slice it is named after
    // and the town's own word for the cycle, which is `claims.ts`'s list read here.
    for (const borrowed of [
      "I'm watching Markham fall registration and I'll text you before a spot opens.",
      "I'm watching sign-ups for that one and I'll text you when a spot opens.",
    ]) {
      const verdict = verdictFor(borrowed, view({ openKinds: new Set(['spot_watch']) }));

      expect(verdict.mints, borrowed).toEqual([]);
      expect(verdict.refused.map((r) => r.reason), borrowed).toEqual(['no_registration_watch']);
    }
  });

  it('REFUSES the minimal edit the spot re-ask invites', () => {
    // What a model does with "say a spot, a seat, a space or the waitlist": it keeps the
    // municipal subject and appends the word. That edit must not buy the sentence a pass.
    const appended =
      "I'm watching that morning and I'll text you before it goes live so you can grab a spot.";

    const verdict = verdictFor(appended, view({ pendingKinds: new Set(['spot_watch']) }));

    expect(verdict.refused.map((r) => r.reason)).toEqual(['no_registration_watch']);
  });

  it('still backs the spot word when the sentence is about one class', () => {
    // THE POSITIVE CONTROL for the two refusals above: the season check must not swallow
    // the arming ack itself, which is the sentence this whole widening exists for.
    const ack = "I'm watching that class and I'll text you when a spot opens.";

    const verdict = verdictFor(ack, view({ openKinds: new Set(['spot_watch']) }));

    expect(verdict.refused).toEqual([]);
    expect(verdict.resolutions[0]).toMatchObject({
      status: 'matched',
      matchedBy: 'open_commitment',
    });
  });

  it('backs the spot-shaped words a watch can actually be about', () => {
    // THE POSITIVE CONTROL for the two refusals above: the narrowing must not collapse
    // into "a spot watch backs nothing". Each of these is a sentence the arming turn
    // really writes, and each names the thing the row is a row about.
    for (const sentence of [
      "I'm watching that class and I'll text you when a seat opens.",
      "I'll text you the moment a space opens up in that one.",
      "I'm watching the waitlist and I'll let you know.",
    ]) {
      const verdict = verdictFor(sentence, view({ openKinds: new Set(['spot_watch']) }));
      expect(verdict.refused, sentence).toEqual([]);
    }
  });

  /**
   * THE BAND THE NARROWING OPENED. An arming ack that says "when it opens up" instead of
   * a spot word is refused — correctly, the widening is only as wide as the sentence —
   * but under `no_registration_watch` the re-ask told the model to "say nothing about
   * watching", steering it off the watch it had legitimately just armed. The refusal a
   * spot watch produces is its own, and it names the word the sentence is missing.
   */
  it('tells a model with a spot watch WHICH word its ack is missing', () => {
    const vague = "I'm watching that class and I'll text you when it opens up.";

    const verdict = verdictFor(vague, view({ pendingKinds: new Set(['spot_watch']) }));

    expect(verdict.refused.map((r) => r.reason)).toEqual(['spot_watch_unshaped']);
    const [violation] = reconcileViolations(verdict);
    expect(violation).toContain('spot');
    expect(violation).toContain('waitlist');
    // And what it is NOT watching, because the word alone is what a municipal sentence
    // borrows: the re-ask names the object as well as the word.
    expect(violation).toContain('not a registration morning');
    expect(violation).not.toContain('say nothing about watching');
  });

  it('keeps the plain refusal for a family with no spot watch at all', () => {
    // THE OTHER WAY. The spot-specific reason is a fact about the ledger, not about the
    // sentence: the same vague ack from a family watching nothing is still the ordinary
    // unbacked-watch refusal, and its re-ask still says to stop claiming a watch.
    const vague = "I'm watching that class and I'll text you when it opens up.";

    const verdict = verdictFor(vague, view());

    expect(verdict.refused.map((r) => r.reason)).toEqual(['no_registration_watch']);
    expect(reconcileViolations(verdict)[0]).toContain('say nothing about watching');
  });

  it('lets a running municipal ladder back the morning even while a spot watch is open', () => {
    // The spot refusal is the LAST word, not the first: a family that has both a watched
    // course page and a live registration ladder is telling the truth about the morning.
    const morning = "I'm watching that morning and I'll text you before it goes live.";

    const verdict = verdictFor(
      morning,
      view({ openKinds: new Set(['spot_watch']), registrationLaddered: true }),
    );

    expect(verdict.refused).toEqual([]);
    expect(verdict.resolutions[0]).toMatchObject({ status: 'matched', matchedBy: 'live_sequence' });
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

  /**
   * VIL-294 · the coexistence case. Hale holds no calendar row for a visit the PARENT
   * booked and never gave a time for — so before the inbound half existed, the only
   * sentence the gate could produce here was a deletion of a true acknowledgement.
   * A fact the parent stated is a row, and it backs the ack of itself.
   */
  it('MATCHES a booking the PARENT told us about, with nothing on the calendar', () => {
    const verdict = verdictFor(
      'Your 18-month visit is booked.',
      view({
        scheduledTitles: [],
        statedBookings: ['Ontario runs a longer 18-month well-baby visit with your family doctor.'],
      }),
    );
    expect(verdict.refused).toEqual([]);
    expect(verdict.resolutions[0]).toMatchObject({
      status: 'matched',
      matchedBy: 'parent_stated',
    });
  });

  it('still REFUSES a booking the parent never stated and nothing holds', () => {
    const verdict = verdictFor(
      'Your swim lesson is booked.',
      view({
        statedBookings: ['Ontario runs a longer 18-month well-baby visit with your family doctor.'],
      }),
    );
    expect(verdict.refused.map((r) => r.reason)).toEqual(['no_scheduled_row']);
  });

  it('prefers the calendar row when both could back the claim', () => {
    const verdict = verdictFor(
      'Your well-baby visit is booked.',
      view({
        scheduledTitles: ['Well-baby checkup'],
        statedBookings: ['Ontario runs a longer 18-month well-baby visit with your family doctor.'],
      }),
    );
    expect(verdict.resolutions[0]).toMatchObject({ status: 'matched', matchedBy: 'scheduled_row' });
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
