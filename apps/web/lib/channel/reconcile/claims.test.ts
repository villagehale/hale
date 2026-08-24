import { describe, expect, it } from 'vitest';
import { claimsNoLedgerCanBack, extractStateClaims } from './claims';

/**
 * The corpus is the 2026-08-21/22 audit, verbatim, plus the deterministic templates that
 * have been on the wire since launch. Both halves are load-bearing: an extractor that
 * only catches the audit is one that refuses START_ACK on Monday.
 */

const kinds = (body: string) => extractStateClaims(body).map((claim) => claim.kind);

describe('extractStateClaims — the audit sentences', () => {
  it('reads the Aug 21 registration watch as a registration_watch claim', () => {
    expect(kinds("I'm watching that morning and I'll text you before it goes live.")).toEqual([
      'registration_watch',
    ]);
  });

  it('reads the Aug 12 activity promise as an activity_followup claim', () => {
    expect(
      kinds("I'm checking details on 5 finds nearby - I'll text you the good ones."),
    ).toEqual(['activity_followup']);
  });

  it('reads the Aug 12 behaviour promise as self-referential', () => {
    expect(kinds("I'll cut the one sec messages and just answer.")).toEqual(['self_referential']);
  });

  it('reads a booking assertion as a scheduled_event claim', () => {
    expect(kinds('Your well-baby visit is booked.')).toEqual(['scheduled_event']);
  });

  it('carries the sentence span so a lane that cannot re-ask can drop it', () => {
    const body = "Swim runs Tuesdays at 4. I'll cut the one sec messages and just answer.";
    const [claim] = extractStateClaims(body);
    expect(claim?.sentence).toBe("I'll cut the one sec messages and just answer.");
    expect(body.replace(claim?.sentence ?? '', '').trim()).toBe('Swim runs Tuesdays at 4.');
  });

  it('reads several claims out of one body, in order', () => {
    expect(
      kinds(
        "I'm watching that morning and I'll text you before it goes live. Your well-baby visit is booked.",
      ),
    ).toEqual(['registration_watch', 'scheduled_event']);
  });

  it('reads the 2026-08-20 come-back promise when it names what it is coming back about', () => {
    expect(kinds("I'll keep looking and come back to you on fall swim lessons.")).toEqual([
      'activity_followup',
    ]);
  });

  it('reads I have added as a scheduled_event claim', () => {
    expect(kinds("I've added the dentist appointment for Thursday.")).toEqual(['scheduled_event']);
  });
});

describe('extractStateClaims — the false positives that would break production', () => {
  it('leaves a second-person prediction alone', () => {
    expect(kinds("You'll want to register soon - Halton Hills opens Sep 1.")).toEqual([]);
  });

  it('leaves a quoted parent promise alone', () => {
    expect(kinds('Your note said "I\'ll sign her up Monday" so I have not touched it.')).toEqual(
      [],
    );
  });

  it('leaves a reported parent promise alone even unquoted', () => {
    expect(kinds("You said you'll register her Monday.")).toEqual([]);
  });

  it('leaves a refusal alone — the true version of the same claim', () => {
    expect(kinds("I can't watch a site and ping you when registration opens.")).toEqual([]);
  });

  it('leaves an offer-shaped question alone', () => {
    expect(kinds('Want me to watch that morning and text you before it opens?')).toEqual([]);
  });

  it('leaves an absence assertion alone', () => {
    expect(kinds("Drafted - reply YES and it goes on your week. Nothing's booked until you call the clinic.")).toEqual([]);
  });

  it.each([
    ["You're back - I'll text you when something needs doing.", 'START_ACK'],
    [
      "You're in - I'll text you the week's schedule and pickup reminders, and nothing else.",
      'caregiver accepted',
    ],
    ["I've already texted them - I'll let you know as soon as they answer.", 'caregiver pending'],
    ['Approved - book a checkup. I\'ll let you know once it\'s done.', 'approval receipt'],
    ["Thanks - I'll use that from now on.", 'name captured'],
    [
      "I'm still double-checking that one myself - nothing for you to do yet, I'll come back to you on it.",
      'not_reviewer_approved',
    ],
    ["Sorry - that one filled. Noted, and I'll flag the next Halton Hills window early.", 'missed'],
    [
      'Halton Hills Fall 2026 recreation registration opens Sep 1, 7:00 a.m. for Noah. I\'ll send your plan the evening before.',
      'heads_up leg',
    ],
    [
      'Tomorrow: Halton Hills Fall 2026 opens 7:00 a.m. for Noah. Sign in tonight and have this open: https://x.test/a',
      'battle_plan leg',
    ],
    ['Halton Hills Fall 2026 opens 7:00 a.m. Your link: https://x.test/a', 'go leg'],
    ["Kids' names and ages, and I'll get to work.", 'cold start'],
    [
      "I'm still learning what's on around you - I'll have a pick for you soon.",
      'radar still learning',
    ],
    [
      "I'm mapping what's near you now - nothing to point you to yet, and no registration date coming up.",
      'radar mapping',
    ],
    ['All on your calendar.', 'weekly plan placed'],
  ])('%s (%s) is not a claim this primitive owns, or is one a live row backs', (body) => {
    // The two that ARE claims here are the ladder's own legs, and they are backed by the
    // live sequence — reconcile.ts asserts that. What must never happen is a THIRD kind
    // appearing, or a self-referential refusal on a shipped template.
    expect(claimsNoLedgerCanBack(body)).toEqual([]);
  });

  it('keeps "7:00 a.m." inside its sentence rather than shattering the leg', () => {
    // The abbreviation is why the split needs a capital after it. Shattered, the leg's
    // first sentence loses "for Noah" and the span a drop-the-sentence lane would cut is
    // wrong. Neither half claims a watch: the ladder promises a PLAN, which is its own
    // ledger kind, and it never says it is watching.
    expect(
      extractStateClaims(
        "Halton Hills Fall 2026 recreation registration opens Sep 1, 7:00 a.m. for Noah. I'll send your plan the evening before.",
      ),
    ).toEqual([]);
  });

  it('reads a one-sentence watch promise the ladder legs never make', () => {
    expect(kinds("I'll text you when Halton Hills registration opens.")).toEqual([
      'registration_watch',
    ]);
  });
});

describe('claimsNoLedgerCanBack', () => {
  it('returns only the claims no row anywhere could satisfy', () => {
    const body =
      "Your well-baby visit is booked. I'll cut the one sec messages and just answer. I'm watching that morning and I'll text you before it goes live.";
    expect(claimsNoLedgerCanBack(body).map((claim) => claim.kind)).toEqual(['self_referential']);
  });

  it('is empty for an ordinary reply', () => {
    expect(claimsNoLedgerCanBack('Swim runs Tuesdays at 4 at the Gellert.')).toEqual([]);
  });
});
