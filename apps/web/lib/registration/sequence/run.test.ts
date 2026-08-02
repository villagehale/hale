import type { RegistrationWindow } from '@hale/db';
import { schema } from '@hale/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NUDGE_OPT_OUT } from '~/lib/channel/nudge/shell';
import { FakeTransport } from '~/lib/channel/intake/transport';
import {
  type LiveSequence,
  type SequenceFamily,
  type SequenceRunDeps,
  defaultSequenceRunDeps,
  runRegistrationSequenceCron,
} from './run.js';
import type { SequenceChild } from './shortlist.js';

/**
 * VIL-242 · M7 — the registration sequence sweep.
 *
 * The properties under test are the ones a re-fired cron, a moved municipal date or a
 * declined shortlist would break:
 *
 *   - the CLAIM is minted before the shortlist is drafted, so a double tick cannot
 *     produce two approval cards for one window;
 *   - a leg is idempotent per (family, window, leg) at the ledger, so a tick that runs
 *     twice inside one interval sends once;
 *   - the two urgent legs cross quiet hours and nothing else does;
 *   - a moved `open_at` re-anchors the whole ladder, because every leg is computed from
 *     the LIVE window row at send time rather than materialized;
 *   - dark by default: unarmed, the sweep does not even select a family.
 */

const TZ = 'America/Toronto';
/** Tuesday 15 Sept 2026, 06:30 Toronto. */
const OPEN_AT = new Date('2026-09-15T10:30:00.000Z');
/** 10:00 Toronto on 5 Sept — inside the family's shortlist slot, 10 days out. */
const PROPOSAL_TICK = new Date('2026-09-05T14:00:00.000Z');
/** 10:00 Toronto on 8 Sept — inside the heads-up interval. */
const HEADS_UP_TICK = new Date('2026-09-08T14:00:00.000Z');
/** 19:00 Toronto on 14 Sept — the battle-plan slot, inside quiet hours it is not. */
const BATTLE_PLAN_TICK = new Date('2026-09-14T23:00:00.000Z');
/** 06:20 Toronto on 15 Sept — inside quiet hours, inside the go interval. */
const GO_TICK = new Date('2026-09-15T10:20:00.000Z');

function win(overrides: Partial<RegistrationWindow> = {}): RegistrationWindow {
  return {
    id: 'w-1',
    municipality: 'richmond_hill',
    programDomain: 'rec_program',
    cycleLabel: 'Fall 2026',
    previewAt: null,
    residentOpenAt: null,
    openAt: OPEN_AT,
    residentPriorityDays: null,
    waitlistResponseHours: 36,
    ageMinMonths: 36,
    ageMaxMonths: 72,
    sourceUrl: 'https://www.richmondhill.ca/en/things-to-do/Community-Recreation-Guide.aspx',
    verifiedAt: new Date('2026-07-30T04:00:00.000Z'),
    notes: null,
    createdAt: PROPOSAL_TICK,
    updatedAt: PROPOSAL_TICK,
    ...overrides,
  } as RegistrationWindow;
}

function family(overrides: Partial<SequenceFamily> = {}): SequenceFamily {
  return {
    familyId: 'fam-1',
    parentUserId: 'user-1',
    areaCoarse: 'L4B',
    timeZone: TZ,
    ...overrides,
  };
}

/** Maya, 4 years old on the proposal tick — squarely inside the 3-to-6 band. */
const CHILDREN: SequenceChild[] = [{ id: 'child-1', name: 'Maya', dateOfBirth: '2022-05-01' }];

function live(overrides: Partial<LiveSequence> = {}): LiveSequence {
  return {
    sequenceId: 'seq-1',
    familyId: 'fam-1',
    parentUserId: 'user-1',
    timeZone: TZ,
    areaCoarse: 'L4B',
    window: win(),
    optIn: 'opted_in',
    outcome: null,
    waitlistPosition: null,
    waitlistStartedAt: null,
    ...overrides,
  };
}

interface Harness {
  deps: SequenceRunDeps;
  transport: FakeTransport;
  writes: Array<{ table: unknown; payload: Record<string, unknown> }>;
  dedupeKeys: Set<string>;
  claims: Array<{ familyId: string; windowId: string }>;
  drafts: Array<Record<string, unknown>>;
  released: string[];
}

function harness(
  options: {
    families?: SequenceFamily[];
    windows?: RegistrationWindow[];
    sequences?: LiveSequence[];
    children?: SequenceChild[];
    claimedWindowIds?: Set<string>;
    /** A claim that loses the race returns null, exactly as ON CONFLICT DO NOTHING does. */
    claimReturnsNull?: boolean;
    draftThrows?: boolean;
    enrolled?: boolean;
    consented?: boolean;
    transport?: FakeTransport | null;
  } = {},
): Harness {
  const writes: Harness['writes'] = [];
  const dedupeKeys = new Set<string>();
  const claims: Harness['claims'] = [];
  const drafts: Harness['drafts'] = [];
  const released: string[] = [];
  const transport = options.transport === undefined ? new FakeTransport() : options.transport;

  const deps: SequenceRunDeps = {
    selectFamilies: async () => options.families ?? [family()],
    loadChildren: async () => options.children ?? CHILDREN,
    loadWindows: async () => options.windows ?? [],
    loadClaimedWindowIds: async () => options.claimedWindowIds ?? new Set<string>(),
    claimWindow: async (_db, input) => {
      if (options.claimReturnsNull) return null;
      claims.push({ familyId: input.familyId, windowId: input.windowId });
      return `seq-${claims.length}`;
    },
    draftShortlist: async (_db, input) => {
      if (options.draftThrows) throw new Error('reviewer unavailable');
      drafts.push(input as unknown as Record<string, unknown>);
      return `action-${drafts.length}`;
    },
    attachAction: async () => {},
    releaseClaim: async (_db, sequenceId) => {
      released.push(sequenceId);
    },
    loadLiveSequences: async () => options.sequences ?? [],
    buildGate: () => ({
      channelEnrolled: async () => options.enrolled ?? true,
      watchConsentGranted: async () => options.consented ?? true,
      countProactiveSends: async () => 0,
      parentTimeZone: async () => TZ,
    }),
    dedupeActive: async (_db, key) => dedupeKeys.has(key),
    resolveSendTarget: async () => '+14165550100',
    recordSend: async (_db, write) => {
      writes.push({
        table: schema.channelMessages,
        payload: write as unknown as Record<string, unknown>,
      });
      dedupeKeys.add(write.dedupeKey);
      return `msg-${writes.length}`;
    },
    audit: async (_db, row) => {
      writes.push({ table: schema.auditLog, payload: row as unknown as Record<string, unknown> });
    },
    transport,
  };

  return {
    deps,
    transport: transport ?? new FakeTransport(),
    writes,
    dedupeKeys,
    claims,
    drafts,
    released,
  };
}

function db() {
  return {} as never;
}

function auditActions(writes: Harness['writes']): string[] {
  return writes.filter((w) => w.table === schema.auditLog).map((w) => String(w.payload.actionTaken));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the D21 dark-launch flag', () => {
  it('does nothing at all when neither the flag nor the allowlist is armed', async () => {
    const h = harness({ windows: [win()] });
    const result = await runRegistrationSequenceCron(db(), h.deps, PROPOSAL_TICK);
    expect(result.enabled).toBe(false);
    expect(h.claims).toEqual([]);
    expect(h.transport.sent).toHaveLength(0);
  });

  it('reads F14_ENABLED strictly, so a stored trailing newline stays OFF', async () => {
    // `vercel env add` from a piped echo stores 'true\n'.
    vi.stubEnv('F14_ENABLED', 'true\n');
    const h = harness({ windows: [win()] });
    expect((await runRegistrationSequenceCron(db(), h.deps, PROPOSAL_TICK)).enabled).toBe(false);
  });

  it('runs for an allowlisted family while the flag is off', async () => {
    vi.stubEnv('F14_FAMILY_ALLOWLIST', 'fam-1');
    const h = harness({ windows: [win()] });
    const result = await runRegistrationSequenceCron(db(), h.deps, PROPOSAL_TICK);
    expect(result.enabled).toBe(true);
    expect(h.claims).toHaveLength(1);
  });
});

describe('the shortlist proposal', () => {
  it('claims the window BEFORE drafting, so a double tick cannot mint two cards', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ windows: [win()], claimReturnsNull: true });
    const result = await runRegistrationSequenceCron(db(), h.deps, PROPOSAL_TICK);
    // The claim lost the race (the unique index rejected it), so nothing was drafted.
    expect(h.drafts).toEqual([]);
    expect(result.proposed).toBe(0);
  });

  it('drafts one shortlist for the soonest unclaimed window', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ windows: [win()] });
    const result = await runRegistrationSequenceCron(db(), h.deps, PROPOSAL_TICK);
    expect(result.proposed).toBe(1);
    expect(h.claims).toEqual([{ familyId: 'fam-1', windowId: 'w-1' }]);
    expect(h.drafts[0]).toMatchObject({
      familyId: 'fam-1',
      intentKind: 'registration_shortlist',
      childId: null,
    });
    // The rationale is the reviewed copy, carrying the link and no invented program.
    expect(String(h.drafts[0]?.rationale)).toContain(
      'https://www.richmondhill.ca/en/things-to-do/Community-Recreation-Guide.aspx',
    );
    expect(auditActions(h.writes)).toContain('registration_shortlist_drafted');
  });

  it('proposes at most ONE window per family per run', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const second = win({ id: 'w-2', cycleLabel: 'Fall 2026 Swim', programDomain: 'swim' });
    const h = harness({ windows: [win(), second] });
    await runRegistrationSequenceCron(db(), h.deps, PROPOSAL_TICK);
    expect(h.claims).toHaveLength(1);
  });

  it('never re-proposes a window it has already claimed', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ windows: [win()], claimedWindowIds: new Set(['w-1']) });
    await runRegistrationSequenceCron(db(), h.deps, PROPOSAL_TICK);
    expect(h.claims).toEqual([]);
  });

  it('proposes ONE window at a time, not one more on every tick of the slot', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    // The slot is a whole HOUR and the cron ticks every five minutes. Without this
    // rule the second tick would claim the next window, and a family with three
    // matched dates would wake up to three approval cards fifteen minutes apart.
    const second = win({ id: 'w-2', cycleLabel: 'Fall 2026 Swim', programDomain: 'swim' });
    const h = harness({ windows: [win(), second], claimedWindowIds: new Set(['w-1']) });
    await runRegistrationSequenceCron(db(), h.deps, PROPOSAL_TICK);
    expect(h.claims).toEqual([]);
  });

  it('only proposes inside the family’s local shortlist slot', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    // 15:00 Toronto — a perfectly ordinary tick, and not the slot.
    const h = harness({ windows: [win()] });
    await runRegistrationSequenceCron(db(), h.deps, new Date('2026-09-05T19:00:00.000Z'));
    expect(h.claims).toEqual([]);
  });

  it('does not propose a window that is further out than the lead time', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const distant = win({ openAt: new Date('2026-12-01T11:30:00.000Z') });
    const h = harness({ windows: [distant] });
    await runRegistrationSequenceCron(db(), h.deps, PROPOSAL_TICK);
    expect(h.claims).toEqual([]);
  });

  it('does not propose a window no child in the family fits', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({
      windows: [win()],
      children: [{ id: 'child-1', name: 'Ada', dateOfBirth: '2012-05-01' }],
    });
    await runRegistrationSequenceCron(db(), h.deps, PROPOSAL_TICK);
    expect(h.claims).toEqual([]);
  });

  it('releases the claim when the draft fails, so the next tick can retry', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ windows: [win()], draftThrows: true });
    const result = await runRegistrationSequenceCron(db(), h.deps, PROPOSAL_TICK);
    // A claim with no shortlist behind it would block M4's nudge AND never run a leg:
    // the family would go silent about a date they were owed.
    expect(h.released).toEqual(['seq-1']);
    expect(result.proposed).toBe(0);
    expect(result.failed).toBe(1);
  });
});

describe('the legs', () => {
  it('sends the heads-up with the opt-out appended exactly once', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ sequences: [live({ optIn: 'pending' })] });
    const result = await runRegistrationSequenceCron(db(), h.deps, HEADS_UP_TICK);

    expect(result.sent).toBe(1);
    const body = h.transport.bodies()[0] as string;
    expect(body).toContain('Richmond Hill');
    expect(body).toContain('Maya');
    expect(body.endsWith(NUDGE_OPT_OUT)).toBe(true);
    expect(body.split(NUDGE_OPT_OUT)).toHaveLength(2);
  });

  it('writes the ledger row under its own category and its audit row (rule #6)', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ sequences: [live()] });
    await runRegistrationSequenceCron(db(), h.deps, HEADS_UP_TICK);

    const ledger = h.writes.filter((w) => w.table === schema.channelMessages);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.payload).toMatchObject({
      familyId: 'fam-1',
      parentUserId: 'user-1',
      channel: 'sms',
      category: 'registration_sequence',
      templateKey: 'registration_sequence:heads_up',
      status: 'sent',
    });
    // Never the rendered body (rule #1).
    expect(ledger[0]?.payload.body).toBeUndefined();
    expect(auditActions(h.writes)).toContain('registration_sequence_leg_sent');
  });

  it('is idempotent per (family, window, leg) under a double cron fire', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ sequences: [live()] });
    await runRegistrationSequenceCron(db(), h.deps, HEADS_UP_TICK);
    // The same interval, five minutes later: the ladder is still due, the ledger says
    // it already went.
    const second = await runRegistrationSequenceCron(
      db(),
      h.deps,
      new Date(HEADS_UP_TICK.getTime() + 5 * 60_000),
    );
    expect(second).toMatchObject({ sent: 0, deduped: 1 });
    expect(h.transport.sent).toHaveLength(1);
    expect([...h.dedupeKeys]).toEqual(['registration_sequence:fam-1:w-1:heads_up']);
  });

  it('withholds the battle plan from a family that has not approved the shortlist', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ sequences: [live({ optIn: 'pending' })] });
    const result = await runRegistrationSequenceCron(db(), h.deps, BATTLE_PLAN_TICK);
    expect(result.sent).toBe(0);
    expect(h.transport.sent).toHaveLength(0);
  });

  it('says nothing at all to a family that declined the shortlist', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    for (const tick of [HEADS_UP_TICK, BATTLE_PLAN_TICK, GO_TICK]) {
      const h = harness({ sequences: [live({ optIn: 'declined' })] });
      await runRegistrationSequenceCron(db(), h.deps, tick);
      expect(h.transport.sent).toHaveLength(0);
    }
  });

  it('crosses quiet hours for the go leg, which is worthless late', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    // 06:20 Toronto is inside the 21:00-08:00 proactive quiet window.
    const h = harness({ sequences: [live()] });
    const result = await runRegistrationSequenceCron(db(), h.deps, GO_TICK);
    expect(result.sent).toBe(1);
    expect(h.transport.bodies()[0]).toContain(
      'https://www.richmondhill.ca/en/things-to-do/Community-Recreation-Guide.aspx',
    );
  });

  it('holds a non-urgent leg inside quiet hours and sends it on the next tick after', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    // 21:30 Toronto on 8 Sept: past the heads-up slot so the leg IS due, and inside
    // quiet hours so it is held. The interval is days wide, so the hold is a deferral
    // rather than a lost message — which is the whole reason legs are intervals.
    const h = harness({ sequences: [live()] });
    const held = await runRegistrationSequenceCron(
      db(),
      h.deps,
      new Date('2026-09-09T01:30:00.000Z'),
    );
    expect(held.held.quiet_hours).toBe(1);
    expect(h.transport.sent).toHaveLength(0);

    const later = await runRegistrationSequenceCron(
      db(),
      h.deps,
      new Date('2026-09-09T14:00:00.000Z'),
    );
    expect(later.sent).toBe(1);
  });

  it('sends nothing to a family that pressed STOP', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ sequences: [live()], enrolled: false });
    const result = await runRegistrationSequenceCron(db(), h.deps, HEADS_UP_TICK);
    expect(result.held.not_enrolled).toBe(1);
    expect(h.transport.sent).toHaveLength(0);
  });

  it('re-anchors the whole ladder when a municipality MOVES the date', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    // The window that was due to open on 15 Sept now opens on 22 Sept. Nothing is
    // materialized, so the ladder simply recomputes: what was the heads-up tick is
    // now a week too early and nothing is due.
    const moved = live({ window: win({ openAt: new Date('2026-09-22T10:30:00.000Z') }) });
    const h = harness({ sequences: [moved] });
    const result = await runRegistrationSequenceCron(db(), h.deps, HEADS_UP_TICK);
    expect(result.sent).toBe(0);

    const onTime = await runRegistrationSequenceCron(
      db(),
      h.deps,
      new Date('2026-09-15T14:00:00.000Z'),
    );
    expect(onTime.sent).toBe(1);
  });

  it('anchors the whole ladder on the RESIDENT date for a resident family', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    // Richmond Hill opens to residents a week early. L4B resolves to Richmond Hill
    // alone, so this family registers on the 8th — anchoring the ladder on the general
    // date would send them the go leg a week after they could have registered.
    const resident = live({
      areaCoarse: 'L4B',
      window: win({ residentOpenAt: new Date('2026-09-08T10:30:00.000Z'), residentPriorityDays: 7 }),
    });
    const h = harness({ sequences: [resident] });

    // 06:20 Toronto on the 8th: the go leg for the RESIDENT date.
    const result = await runRegistrationSequenceCron(
      db(),
      h.deps,
      new Date('2026-09-08T10:20:00.000Z'),
    );
    expect(result.sent).toBe(1);
    expect([...h.dedupeKeys]).toEqual(['registration_sequence:fam-1:w-1:go']);
  });

  it('anchors on the general date for a family whose FSA is not that town', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    // L3P is Markham, not Richmond Hill: no head start, so nothing is due on the 8th.
    const nonResident = live({
      areaCoarse: 'L3P',
      window: win({ residentOpenAt: new Date('2026-09-08T10:30:00.000Z'), residentPriorityDays: 7 }),
    });
    const h = harness({ sequences: [nonResident] });
    const result = await runRegistrationSequenceCron(
      db(),
      h.deps,
      new Date('2026-09-08T10:20:00.000Z'),
    );
    expect(result.sent).toBe(0);
  });

  it('asks the check-in question four hours after the open', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ sequences: [live()] });
    await runRegistrationSequenceCron(db(), h.deps, new Date('2026-09-15T14:30:00.000Z'));
    expect(h.transport.bodies()[0]).toContain('How did');
  });

  it('runs the waitlist guards off the parent’s reported clock', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const waitlisted = live({
      outcome: 'waitlisted',
      waitlistPosition: 15,
      waitlistStartedAt: new Date('2026-09-15T15:00:00.000Z'),
    });
    const h = harness({ sequences: [waitlisted] });
    // Half of Richmond Hill's 36h from 11:00 on the 15th is 05:00 on the 16th — inside
    // quiet hours, so it defers; 10:00 local is the first tick that may send.
    const result = await runRegistrationSequenceCron(
      db(),
      h.deps,
      new Date('2026-09-16T14:00:00.000Z'),
    );
    expect(result.sent).toBe(1);
    expect(h.transport.bodies()[0]).toContain('36h');
    expect([...h.dedupeKeys]).toEqual(['registration_sequence:fam-1:w-1:waitlist_half']);
  });

  it('is quiet on a tick where no leg is due — the common case', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ sequences: [live()] });
    const result = await runRegistrationSequenceCron(
      db(),
      h.deps,
      new Date('2026-09-01T14:00:00.000Z'),
    );
    expect(result).toMatchObject({ sent: 0, quiet: 1 });
    expect(h.writes).toEqual([]);
  });

  it('wires the real Twilio transport into the default deps (VIL-260)', async () => {
    const { transport } = defaultSequenceRunDeps();
    expect(transport).not.toBeNull();
    // Not merely non-null: the REAL outbound leg, which refuses by naming its missing
    // credentials rather than silently reporting a leg nobody sent.
    vi.stubEnv('TWILIO_ACCOUNT_SID', '');
    await expect(
      transport?.send({ to: '+14165550100', body: 'never leaves: no credentials' }),
    ).rejects.toThrow(/twilio not configured/);
  });

  it('writes the ledger row and the audit row for the leg it sent', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ sequences: [live()] });
    const result = await runRegistrationSequenceCron(db(), h.deps, HEADS_UP_TICK);

    expect(result).toMatchObject({ sent: 1, composed: 0 });
    expect(h.transport.sent).toHaveLength(1);
    const ledger = h.writes.filter((w) => w.table === schema.channelMessages);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.payload).toMatchObject({
      channel: 'sms',
      category: 'registration_sequence',
      status: 'sent',
      templateKey: 'registration_sequence:heads_up',
      dedupeKey: 'registration_sequence:fam-1:w-1:heads_up',
    });
    expect(
      h.writes
        .filter((w) => w.table === schema.auditLog)
        .map((w) => String(w.payload.actionTaken)),
    ).toContain('registration_sequence_leg_sent');
  });

  it('lets one family’s bad data fail without silencing the next family', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({
      sequences: [
        live(),
        live({ sequenceId: 'seq-2', familyId: 'fam-2', parentUserId: 'user-2' }),
      ],
    });
    const boom: SequenceRunDeps = {
      ...h.deps,
      resolveSendTarget: async (_db, parentUserId) => {
        if (parentUserId === 'user-1') throw new Error('bad row');
        return '+14165550101';
      },
    };
    const result = await runRegistrationSequenceCron(db(), boom, HEADS_UP_TICK);
    expect(result.failed).toBe(1);
    expect(result.sent).toBe(1);
  });
});
