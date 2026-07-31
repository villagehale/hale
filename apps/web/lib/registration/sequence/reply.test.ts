import { describe, expect, it } from 'vitest';
import type { SequenceState } from './schedule.js';
import type { Shortlist } from './shortlist.js';
import {
  type AwaitingSequence,
  type SequenceReplyDeps,
  handleSequenceReply,
  matchCheckInReply,
} from './reply.js';

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
    programDomainLabel: 'recreation programs',
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
}

function deps(sequence: AwaitingSequence | null): { deps: SequenceReplyDeps; recorded: Recorded } {
  const recorded: Recorded = { outcomes: [], reasks: [], loads: 0 };
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
    },
  };
}

function db() {
  return {} as never;
}

function reply(body: string, sequence: AwaitingSequence | null = awaiting(), now = REPLY_AT) {
  const fake = deps(sequence);
  return {
    recorded: fake.recorded,
    outcome: handleSequenceReply(db(), { familyId: 'fam-1', body, now }, fake.deps),
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
    expect(result.reply).toContain('Toronto');
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
    expect(result.reply).toContain('15');
    expect(result.reply).toContain('36h');
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
    expect(result.reply).toContain('48h');
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
    // And says so, rather than implying a guard it cannot keep.
    expect(result.reply.toLowerCase()).toContain('no published');
  });

  it('records a missed window without pretending otherwise', async () => {
    const { outcome, recorded } = reply('missed it');
    const result = await outcome;
    if (result.status !== 'recorded') throw new Error('expected a recorded outcome');
    expect(result.outcome).toBe('missed');
    expect(recorded.outcomes[0]).toMatchObject({ outcome: 'missed' });
  });

  it('re-asks ONCE when the answer is unreadable, then goes quiet', async () => {
    const first = reply('idk it was chaos');
    const firstResult = await first.outcome;
    if (firstResult.status !== 'reasked') throw new Error('expected a re-ask');
    expect(firstResult.reply.toLowerCase()).toContain('got in');
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
