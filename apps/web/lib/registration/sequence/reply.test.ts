import { describe, expect, it } from 'vitest';
import type { RegistrationNoteFacts } from './note-compose.js';
import {
  type AwaitingSequence,
  type SequenceReplyDeps,
  handleSequenceReply,
  loadAwaitingSequence,
  matchCheckInReply,
} from './reply.js';
import type { SequenceState } from './schedule.js';
import type { Shortlist } from './shortlist.js';

/**
 * VIL-242 · M7 — what a parent's answer to "how did it go?" is allowed to do.
 *
 * Everything here is DETERMINISTIC, and for a sharper reason than the usual one: this
 * reply starts a CLOCK. A misread "not waitlisted, we got in" would schedule two guards
 * for an offer that does not exist; a misread "waitlisted" filed as a win would drop the
 * guards for one that does — and a family loses a spot because Hale was confident. So
 * matching is anchored and exact, never a substring search, exactly as the CASL keywords
 * and M8's health replies are.
 *
 * Richer conversational handling arrives with C2 (VIL-221). The seam is the `ignored`
 * verdict: C2 owns everything this module declines, and it never has to relitigate the
 * three certainties.
 */

const TZ = 'America/Toronto';
/** Registration opened 15 Sept 2026 at 06:30 Toronto; the parent replies at 11:00. */
const OPEN_AT = new Date('2026-09-15T10:30:00.000Z');
const REPLY_AT = new Date('2026-09-15T15:00:00.000Z');

function shortlist(overrides: Partial<Shortlist> = {}): Shortlist {
  return {
    windowRef: {
      id: 'win-1',
      municipality: 'toronto',
      programDomain: 'rec_program',
      cycleLabel: 'Fall 2026',
    },
    cyclePhrase: 'Fall 2026 recreation programs',
    opensForFamilyAt: OPEN_AT,
    sourceUrl: 'https://www.toronto.ca/explore-enjoy/parks-recreation/',
    isResidentWindow: false,
    residentPriorityDays: null,
    waitlistResponseHours: 36,
    fitNotes: [{ childId: 'c1', name: 'Max', fit: 'in_band' }],
    ageApproximate: false,
    ...overrides,
  };
}

function state(overrides: Partial<SequenceState> = {}): SequenceState {
  return {
    openAt: OPEN_AT,
    timeZone: TZ,
    optIn: 'opted_in',
    outcome: null,
    waitlistStartedAt: null,
    waitlistResponseHours: 36,
    portal: null,
    ...overrides,
  };
}

function awaiting(overrides: Partial<AwaitingSequence> = {}): AwaitingSequence {
  return {
    sequenceId: 'seq-1',
    familyId: 'fam-1',
    parentUserId: 'user-1',
    state: state(),
    shortlist: shortlist(),
    reaskedAt: null,
    ...overrides,
  };
}

interface Recorded {
  outcomes: Array<Record<string, unknown>>;
  reasks: string[];
  loads: number;
  /** The facts every note was written from, in order. */
  notes: RegistrationNoteFacts[];
}

/** The composer seam. It returns the note's kind as its "text", or null for a write that
 * failed; what the model writes is the eval's (vil543-note-eval.mjs). */
function deps(
  sequence: AwaitingSequence | null,
  written: (facts: RegistrationNoteFacts) => string | null = (facts) => `note:${facts.kind}`,
): { deps: SequenceReplyDeps; recorded: Recorded } {
  const recorded: Recorded = { outcomes: [], reasks: [], loads: 0, notes: [] };
  return {
    recorded,
    deps: {
      loadAwaitingSequence: async () => {
        recorded.loads += 1;
        return sequence;
      },
      recordOutcome: async (_db, input) => {
        recorded.outcomes.push(input as unknown as Record<string, unknown>);
      },
      recordReask: async (_db, sequenceId) => {
        recorded.reasks.push(sequenceId);
      },
      writeNote: async (_db, _familyId, facts) => {
        recorded.notes.push(facts);
        return written(facts);
      },
    },
  };
}

function db() {
  return {} as never;
}

function reply(
  body: string,
  sequence: AwaitingSequence | null = awaiting(),
  now = REPLY_AT,
  /** Who texted. Defaults to the parent who claimed the window; a co-parent answering
   * the same check-in passes their own id. */
  parentUserId = 'user-1',
) {
  const fake = deps(sequence);
  return {
    recorded: fake.recorded,
    outcome: handleSequenceReply(db(), { familyId: 'fam-1', parentUserId, body, now }, fake.deps),
  };
}

describe('matchCheckInReply', () => {
  it.each([
    'got in',
    'We got in!',
    'GOT IN',
    'we are in',
    "we're in",
    'registered',
    'got a spot',
    'made it',
  ])('reads %j as a spot', (body) => {
    expect(matchCheckInReply(body)).toEqual({ outcome: 'registered' });
  });

  it.each([
    ['waitlisted #15', 15],
    ['Waitlisted #15', 15],
    ['waitlisted 15', 15],
    ['waitlisted number 15', 15],
    ['we are waitlisted #3', 3],
    ['waitlisted', null],
    ['waitlist', null],
  ] as Array<[string, number | null]>)(
    'reads %j as a waitlist at position %s',
    (body, position) => {
      expect(matchCheckInReply(body)).toEqual({ outcome: 'waitlisted', position });
    },
  );

  it.each(['missed it', 'we missed it', 'no luck', "didn't get in", 'didnt get in', 'it was full'])(
    'reads %j as a missed window',
    (body) => {
      expect(matchCheckInReply(body)).toEqual({ outcome: 'missed' });
    },
  );

  it('does NOT read a negated waitlist as a waitlist — the substring trap', () => {
    // "not waitlisted" contains "waitlisted". A loose match would start a 36-hour
    // clock for an offer that does not exist and never mention the spot they got.
    expect(matchCheckInReply('not waitlisted, we got in')).toBeNull();
    expect(matchCheckInReply('no waitlist thankfully')).toBeNull();
  });

  it('does NOT read ordinary conversation as an answer', () => {
    expect(matchCheckInReply('what time does the pool open')).toBeNull();
    expect(matchCheckInReply('thanks!')).toBeNull();
    expect(matchCheckInReply('')).toBeNull();
  });

  it('ignores an implausible waitlist position rather than filing a phone number', () => {
    expect(matchCheckInReply('waitlisted #4165550100')).toEqual({
      outcome: 'waitlisted',
      position: null,
    });
  });

  it('reads a normalized curly apostrophe the way a phone keyboard types it', () => {
    expect(matchCheckInReply('we’re in')).toEqual({ outcome: 'registered' });
    expect(matchCheckInReply('didn’t get in')).toEqual({ outcome: 'missed' });
  });
});

describe('handleSequenceReply', () => {
  it('declines everything when no window is waiting on an answer — the common case', async () => {
    const { outcome, recorded } = reply('got in', null);
    await expect(outcome).resolves.toEqual({ status: 'ignored', reason: 'no_open_window' });
    // One indexed lookup and nothing else. Most inbound traffic lands here.
    expect(recorded.loads).toBe(1);
    expect(recorded.outcomes).toEqual([]);
    expect(recorded.reasks).toEqual([]);
  });

  it('declines once the sequence already has an outcome', async () => {
    const settled = awaiting({ state: state({ outcome: 'registered' }) });
    await expect(reply('waitlisted #4', settled).outcome).resolves.toEqual({
      status: 'ignored',
      reason: 'no_open_window',
    });
  });

  it('declines an answer that arrives after the reply window has closed', async () => {
    const late = new Date('2026-09-19T15:00:00.000Z');
    await expect(reply('got in', awaiting(), late).outcome).resolves.toEqual({
      status: 'ignored',
      reason: 'no_open_window',
    });
  });

  it('declines for a family that never approved the shortlist', async () => {
    const pending = awaiting({ state: state({ optIn: 'pending' }) });
    await expect(reply('got in', pending).outcome).resolves.toEqual({
      status: 'ignored',
      reason: 'no_open_window',
    });
  });

  it('records a spot and celebrates it', async () => {
    const { outcome, recorded } = reply('we got in!');
    const result = await outcome;
    if (result.status !== 'recorded') throw new Error('expected a recorded outcome');
    expect(result.outcome).toBe('registered');
    expect(result.reply).toBe('note:outcome_registered');
    expect(recorded.notes).toEqual([
      expect.objectContaining({
        kind: 'outcome_registered',
        window: expect.stringContaining('Toronto'),
      }),
    ]);
    expect(recorded.outcomes).toEqual([
      {
        sequenceId: 'seq-1',
        familyId: 'fam-1',
        parentUserId: 'user-1',
        windowRef: shortlist().windowRef,
        outcome: 'registered',
        position: null,
        waitlistStartedAt: null,
        waitlistDeadlineAt: null,
        now: REPLY_AT,
      },
    ]);
  });

  it('starts the waitlist clock from the parent’s own message, on the municipality’s rule', async () => {
    const { outcome, recorded } = reply('waitlisted #15');
    const result = await outcome;
    if (result.status !== 'recorded') throw new Error('expected a recorded outcome');
    expect(result.outcome).toBe('waitlisted');
    expect(recorded.outcomes[0]).toMatchObject({
      outcome: 'waitlisted',
      position: 15,
      waitlistStartedAt: REPLY_AT,
      // Toronto publishes 36h; 36h after 11:00 on 15 Sept is 23:00 local on 16 Sept.
      waitlistDeadlineAt: new Date('2026-09-17T03:00:00.000Z'),
    });
    // The note is written from the SAME deadline that was stored.
    expect(recorded.notes[0]).toMatchObject({
      kind: 'outcome_waitlisted',
      position: 15,
      responseHours: 36,
      deadline: { date: 'Wednesday, September 16, 2026', time: '11:00 p.m.' },
    });
  });

  it('uses the municipality’s own response window, never a Hale default', async () => {
    const markham = awaiting({
      shortlist: shortlist({
        windowRef: {
          id: 'win-2',
          municipality: 'markham',
          programDomain: 'camp',
          cycleLabel: 'Summer 2027 Camps',
        },
        waitlistResponseHours: 48,
      }),
      state: state({ waitlistResponseHours: 48 }),
    });
    const { outcome, recorded } = reply('waitlisted #2', markham);
    const result = await outcome;
    if (result.status !== 'recorded') throw new Error('expected a recorded outcome');
    expect(recorded.outcomes[0]).toMatchObject({
      // 48h after 11:00 on 15 Sept is 11:00 on 17 Sept.
      waitlistDeadlineAt: new Date('2026-09-17T15:00:00.000Z'),
    });
    expect(recorded.notes[0]).toMatchObject({ kind: 'outcome_waitlisted', responseHours: 48 });
  });

  it('sets NO clock where the municipality publishes no response window', async () => {
    const noClock = awaiting({
      shortlist: shortlist({ waitlistResponseHours: null }),
      state: state({ waitlistResponseHours: null }),
    });
    const { outcome, recorded } = reply('waitlisted #7', noClock);
    const result = await outcome;
    if (result.status !== 'recorded') throw new Error('expected a recorded outcome');
    expect(recorded.outcomes[0]).toMatchObject({ outcome: 'waitlisted', waitlistDeadlineAt: null });
    // And hands no deadline, so the note cannot imply a guard Hale cannot keep.
    expect(recorded.notes[0]).toMatchObject({
      kind: 'outcome_waitlisted',
      responseHours: null,
      deadline: null,
    });
  });

  it('records a missed window without pretending otherwise', async () => {
    const { outcome, recorded } = reply('missed it');
    const result = await outcome;
    if (result.status !== 'recorded') throw new Error('expected a recorded outcome');
    expect(result.outcome).toBe('missed');
    expect(recorded.outcomes[0]).toMatchObject({ outcome: 'missed' });
    expect(recorded.notes[0]).toMatchObject({ kind: 'outcome_missed', town: 'Toronto' });
  });

  it('still records the outcome when the note cannot be written, and sends nothing', async () => {
    const sequence = awaiting();
    const failed = deps(sequence, () => null);
    const result = await handleSequenceReply(
      db(),
      { familyId: 'fam-1', parentUserId: 'user-1', body: 'we got in', now: REPLY_AT },
      failed.deps,
    );
    expect(result).toEqual({ status: 'recorded', outcome: 'registered', reply: null });
    expect(failed.recorded.outcomes).toHaveLength(1);
  });

  it('re-asks ONCE when the answer is unreadable, then goes quiet', async () => {
    const first = reply('idk it was chaos');
    const firstResult = await first.outcome;
    // The coach answers it (VIL-221 · C2); this module writes no note of its own.
    expect(firstResult).toEqual({ status: 'reasked' });
    expect(first.recorded.notes).toEqual([]);
    expect(first.recorded.reasks).toEqual(['seq-1']);

    // The stamp is what spends it. A second unreadable message inside the same window
    // is met with silence, and falls through to whatever else can answer it.
    const spent = awaiting({ reaskedAt: REPLY_AT });
    const second = reply('still no idea', spent);
    await expect(second.outcome).resolves.toEqual({ status: 'ignored', reason: 'reask_spent' });
    expect(second.recorded.reasks).toEqual([]);
  });

  it('records nothing at all on a re-ask', async () => {
    const { outcome, recorded } = reply('idk it was chaos');
    await outcome;
    expect(recorded.outcomes).toEqual([]);
  });
});

/**
 * VIL-338 · the reply path has to be judged against the SAME morning the ladder ran on.
 *
 * `runLegForSequence` anchors every leg on `course_opens_at` where a course is bound, so
 * the check-in question goes out four hours after the COURSE's morning. A reply path
 * still measuring from the M1 row's instant would ask on one morning and listen on
 * another: for a household whose page opens EARLIER than the row, "we got in" arrives
 * before the window this path thinks has even opened, and is heard by nobody.
 */
describe('loadAwaitingSequence · the anchor', () => {
  const WINDOW = {
    id: 'w-1',
    municipality: 'markham',
    programDomain: 'rec_program',
    cycleLabel: 'Fall 2026',
    previewAt: null,
    residentOpenAt: null,
    openAt: new Date('2026-09-15T10:30:00.000Z'),
    residentPriorityDays: null,
    waitlistResponseHours: 36,
    ageMinMonths: 36,
    ageMaxMonths: 72,
    sourceUrl: 'https://www.markham.ca/en/recreation/registration.aspx',
    verifiedAt: new Date('2026-07-30T04:00:00.000Z'),
    notes: null,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
  };

  /** Just enough of a Drizzle handle for the loader's three reads, in call order: the
   * sequence row, the family's children, and the approval spine's own columns. */
  function chainDb(sequenceRow: Record<string, unknown>) {
    let call = 0;
    return {
      select: () => {
        const which = call++;
        if (which === 0) {
          return {
            from: () => ({
              innerJoin: () => ({
                innerJoin: () => ({
                  innerJoin: () => ({
                    where: () => ({
                      orderBy: () => ({ limit: async () => [sequenceRow] }),
                    }),
                  }),
                }),
              }),
            }),
          };
        }
        if (which === 1) {
          return {
            from: () => ({
              where: async () => [
                { id: 'child-1', name: 'Maya', dateOfBirth: '2022-05-01', dobPrecision: 'exact' },
              ],
            }),
          };
        }
        return {
          from: () => ({
            where: () => ({
              limit: async () => [
                { executedAt: new Date('2026-09-01T00:00:00.000Z'), revertedAt: null },
              ],
            }),
          }),
        };
      },
    } as never;
  }

  it('runs on the bound course’s clock, not the M1 row’s', async () => {
    const bound = await loadAwaitingSequence(
      chainDb({
        sequenceId: 'seq-1',
        parentUserId: 'user-1',
        reaskedAt: null,
        actionId: 'action-1',
        window: WINDOW,
        timezone: 'America/Toronto',
        areaCoarse: 'L3R',
        courseOpensAt: new Date('2026-09-12T10:30:00.000Z'),
      }),
      'fam-1',
      new Date('2026-09-12T15:00:00.000Z'),
    );

    // Three days EARLIER than the row. Anchor on the row and `awaitingOutcome` says the
    // window has not opened yet, so the parent's "we got in" on the real morning is
    // heard by nobody.
    expect(bound?.state.openAt).toEqual(new Date('2026-09-12T10:30:00.000Z'));
  });

  it('runs on the M1 row for a household that has bound nothing', async () => {
    // The positive control, and today's behaviour for the thirteen municipalities.
    const unbound = await loadAwaitingSequence(
      chainDb({
        sequenceId: 'seq-1',
        parentUserId: 'user-1',
        reaskedAt: null,
        actionId: 'action-1',
        window: WINDOW,
        timezone: 'America/Toronto',
        areaCoarse: 'L3R',
        courseOpensAt: null,
      }),
      'fam-1',
      new Date('2026-09-15T15:00:00.000Z'),
    );

    expect(unbound?.state.openAt).toEqual(WINDOW.openAt);
  });
});

/**
 * THE CHECK-IN NOW REACHES BOTH PARENTS (audit 2026-09-17), so either of them may be the
 * one who answers "How did that go?".
 *
 * The SEQUENCE is the household's — one row per family per window — and nothing here
 * changed to keep that true: the loader selects on `outcome IS NULL`, so whichever parent
 * answers first settles it and the other's later message finds nothing open ("declines
 * once the sequence already has an outcome", above). What DID have to change is the
 * receipt: the outcome is attributed to the parent who typed it, not to the seat that
 * happened to claim the window.
 */
describe('either parent answering the check-in', () => {
  const CO_PARENT = 'user-2';

  it('records the co-parent’s report under THEIR id, against the family’s one sequence', async () => {
    const { outcome, recorded } = reply('we got in!', awaiting(), REPLY_AT, CO_PARENT);

    const result = await outcome;
    expect(result.status).toBe('recorded');
    expect(recorded.outcomes).toHaveLength(1);
    expect(recorded.outcomes[0]).toMatchObject({
      sequenceId: 'seq-1',
      familyId: 'fam-1',
      // Kills stamping `sequence.parentUserId`: rule #6's trail would put the primary
      // parent's name on a sentence the co-parent sent.
      parentUserId: CO_PARENT,
      outcome: 'registered',
    });
  });
});
