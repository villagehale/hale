import type { Database } from '@hale/db';
import { afterEach, describe, expect, it } from 'vitest';
import { F14_ALLOWLIST_ENV, F14_ENABLED_ENV } from '~/lib/channel/f14';
import type { ProactiveHoldReason } from '~/lib/channel/outbound-gate';
import type { CandidateDraft } from '~/lib/channel/proactive/queue';
import type { CheckInState } from './cadence';
import { CHECK_IN_ASK_TEMPLATE_KEY } from './copy';
import {
  CHECK_IN_ANCHOR_ENABLED_ENV,
  type EveningCheckInDeps,
  MAX_CHECK_INS_PER_RUN,
  type TodayActivity,
  runEveningCheckInSweep,
} from './sweep';

/**
 * The evening offer.
 *
 * What is pinned here: it is dark until armed, it only queues in the 20:00 local hour,
 * it goes through the outbound gate, it never queues over a registration morning, and
 * silence does not step the cadence down. The gate's own checks live in
 * outbound-gate.test.ts. The sweep does not text.
 */

const FAMILY = 'fam-1';
const PARENT = 'parent-1';
/** 20:17 in Toronto — the hour the clamp allows and the minute the cron fires. */
const EVENING = new Date('2026-07-06T00:17:00.000Z');
const KEYWORD = /\b(?:reply|text|send)\s+[A-Z]{2,}\b/;

const database = {} as Database;

afterEach(() => {
  delete process.env[F14_ENABLED_ENV];
  delete process.env[F14_ALLOWLIST_ENV];
  delete process.env[CHECK_IN_ANCHOR_ENABLED_ENV];
});

interface Overrides {
  state?: Partial<CheckInState>;
  timeZone?: string;
  hold?: ProactiveHoldReason;
  recentSends?: number;
  alreadySent?: boolean;
  registrationStanding?: boolean;
  children?: string[];
  today?: TodayActivity | (() => Promise<TodayActivity>);
  queue?: 'queued' | 'duplicate';
}

function harness(overrides: Overrides = {}) {
  const queued: CandidateDraft[] = [];
  const audits: Array<Record<string, unknown>> = [];

  const deps: EveningCheckInDeps = {
    selectFamilies: async () => [
      { familyId: FAMILY, parentUserId: PARENT, timeZone: overrides.timeZone ?? 'America/Toronto' },
    ],
    loadNamableChildren: async () => overrides.children ?? ['Mia', 'Leo'],
    readTodayActivity: async () => {
      const today = overrides.today ?? { anchor: null, reason: 'no_event_today' as const };
      return typeof today === 'function' ? today() : today;
    },
    readState: async () => ({
      cadence: 'daily' as const,
      silentStreak: 0,
      lastAskedAt: null,
      lastAnsweredAt: null,
      silentStreakSince: null,
      ...overrides.state,
    }),
    buildGate: () => ({
      channelEnrolled: async () => overrides.hold !== 'not_enrolled',
      watchConsentGranted: async () => overrides.hold !== 'no_watch_consent',
      countProactiveSends: async () => 0,
      proactiveSentSince: async () => false,
      parentTimeZone: async () =>
        overrides.hold === 'quiet_hours'
          ? 'Europe/Paris'
          : (overrides.timeZone ?? 'America/Toronto'),
    }),
    readinessStanding: async () =>
      overrides.registrationStanding === true
        ? { id: 'seq-1', summary: 'setup on the portal', askedAt: EVENING }
        : null,
    dedupeActive: async () => overrides.alreadySent === true,
    queueCandidate: async (_db, draft) => {
      if (overrides.queue === 'duplicate') return 'duplicate';
      queued.push(draft);
      return 'queued';
    },
    audit: async (_db, row) => {
      audits.push(row);
    },
  };
  return { deps, queued, audits };
}

describe('the dark-launch gate', () => {
  it('selects nobody at all while F14 is unarmed', async () => {
    const { deps, queued } = harness();
    const result = await runEveningCheckInSweep(database, deps, EVENING);
    expect(result.enabled).toBe(false);
    expect(result.inSlot).toBe(0);
    expect(queued).toEqual([]);
  });

  it('reaches one allowlisted household with the flag still off', async () => {
    process.env[F14_ALLOWLIST_ENV] = FAMILY;
    const { deps, queued } = harness();
    const result = await runEveningCheckInSweep(database, deps, EVENING);
    expect(result.queued).toBe(1);
    expect(queued).toHaveLength(1);
  });

  it('offers a household that is not on the allowlist when F14_ENABLED is exactly true', async () => {
    process.env[F14_ENABLED_ENV] = 'true';
    process.env[F14_ALLOWLIST_ENV] = 'someone-else';
    const { deps, queued } = harness();
    const result = await runEveningCheckInSweep(database, deps, EVENING);
    expect(result.queued).toBe(1);
    expect(queued).toHaveLength(1);
  });
});

describe('the evening slot', () => {
  it('queues nothing at any other local hour', async () => {
    process.env[F14_ENABLED_ENV] = 'true';
    const { deps, queued } = harness();
    const result = await runEveningCheckInSweep(
      database,
      deps,
      new Date('2026-07-06T01:17:00.000Z'),
    );
    expect(result.inSlot).toBe(0);
    expect(queued).toEqual([]);
  });

  it('follows the family clock, not the server clock', async () => {
    process.env[F14_ENABLED_ENV] = 'true';
    const { deps, queued } = harness({ timeZone: 'America/Vancouver' });
    expect((await runEveningCheckInSweep(database, deps, EVENING)).inSlot).toBe(0);
    expect(queued).toEqual([]);
    const later = harness({ timeZone: 'America/Vancouver' });
    const result = await runEveningCheckInSweep(
      database,
      later.deps,
      new Date('2026-07-06T03:17:00.000Z'),
    );
    expect(result.queued).toBe(1);
    expect(later.queued).toHaveLength(1);
  });
});

describe('an hour with more households in it than one run may carry', () => {
  it('counts every one of them and says how many it left for tomorrow', async () => {
    process.env[F14_ENABLED_ENV] = 'true';
    const { deps, queued } = harness();
    const over = MAX_CHECK_INS_PER_RUN + 2;
    deps.selectFamilies = async () =>
      Array.from({ length: over }, (_, index) => ({
        familyId: `fam-${index}`,
        parentUserId: `parent-${index}`,
        timeZone: 'America/Toronto',
      }));

    const result = await runEveningCheckInSweep(database, deps, EVENING);
    expect({ inSlot: result.inSlot, overflow: result.overflow, queued: result.queued }).toEqual({
      inSlot: over,
      overflow: 2,
      queued: MAX_CHECK_INS_PER_RUN,
    });
    expect(queued).toHaveLength(MAX_CHECK_INS_PER_RUN);
  });

  it('spends the bound on households that are due, not on a stored stop', async () => {
    process.env[F14_ENABLED_ENV] = 'true';
    const { deps, queued } = harness();
    const over = MAX_CHECK_INS_PER_RUN + 2;
    deps.selectFamilies = async () =>
      Array.from({ length: over }, (_, index) => ({
        familyId: `fam-${index}`,
        parentUserId: `parent-${index}`,
        timeZone: 'America/Toronto',
      }));
    const quiet = new Set(['fam-0', 'fam-1']);
    deps.readState = async (_db, familyId) => ({
      cadence: quiet.has(familyId) ? ('off' as const) : ('daily' as const),
      silentStreak: 0,
      lastAskedAt: null,
      lastAnsweredAt: null,
      silentStreakSince: null,
    });

    const result = await runEveningCheckInSweep(database, deps, EVENING);
    expect({
      inSlot: result.inSlot,
      overflow: result.overflow,
      queued: result.queued,
      off: result.skipped.cadence_off,
    }).toEqual({ inSlot: over, overflow: 0, queued: MAX_CHECK_INS_PER_RUN, off: 2 });
    expect(queued).toHaveLength(MAX_CHECK_INS_PER_RUN);
  });
});

describe('what is queued', () => {
  it('hands the decider facts, never a script and never a keyword', async () => {
    process.env[F14_ENABLED_ENV] = 'true';
    const { deps, queued, audits } = harness();
    await runEveningCheckInSweep(database, deps, EVENING);

    expect(queued[0]).toMatchObject({
      familyId: FAMILY,
      parentUserId: PARENT,
      kind: 'evening_check_in',
      category: 'evening_check_in',
      templateKey: CHECK_IN_ASK_TEMPLATE_KEY,
      why: 'evening check-in',
      dedupeKey: 'evening_check_in:fam-1:2026-07-05',
      parentRequested: false,
    });
    expect(queued[0]?.what).toBe('Mia, Leo');
    expect(queued[0]?.what).not.toMatch(KEYWORD);
    expect(audits[0]?.actionTaken).toBe('evening_check_in_queued');
    expect(audits[0]?.after).toEqual({ anchored: false });
  });

  it('names an under-13 the caller already kept, and drops a name that will not spell', async () => {
    process.env[F14_ENABLED_ENV] = 'true';
    const named = harness({ children: ['Mia'] });
    await runEveningCheckInSweep(database, named.deps, EVENING);
    expect(named.queued[0]?.what).toBe('Mia');
    expect(named.queued[0]?.what).not.toContain('Noah');

    const teensOnly = harness({ children: [] });
    await runEveningCheckInSweep(database, teensOnly.deps, EVENING);
    expect(teensOnly.queued[0]?.what).toBe('how the day went');

    const accent = harness({ children: ['娜'] });
    await runEveningCheckInSweep(database, accent.deps, EVENING);
    expect(accent.queued[0]?.what).toBe('how the day went');
  });

  it('still offers after silence, including a stored weekly cadence', async () => {
    process.env[F14_ENABLED_ENV] = 'true';
    const { deps, queued, audits } = harness({
      state: {
        cadence: 'weekly',
        silentStreak: 3,
        lastAskedAt: new Date(EVENING.getTime() - 8 * 24 * 3_600_000),
      },
    });
    const result = await runEveningCheckInSweep(database, deps, EVENING);
    expect(result.queued).toBe(1);
    expect(queued).toHaveLength(1);
    expect(audits.map((row) => row.actionTaken)).toEqual(['evening_check_in_queued']);
    expect(JSON.stringify(queued)).not.toMatch(KEYWORD);
  });
});

describe('what stops it', () => {
  it('records the gate holds and writes nothing', async () => {
    process.env[F14_ENABLED_ENV] = 'true';
    for (const hold of ['not_enrolled', 'no_watch_consent', 'quiet_hours'] as const) {
      const { deps, queued, audits } = harness({ hold });
      const result = await runEveningCheckInSweep(database, deps, EVENING);
      expect(result.held[hold], hold).toBe(1);
      expect(result.queued, hold).toBe(0);
      expect(queued, hold).toEqual([]);
      expect(audits, hold).toEqual([]);
    }
  });

  it('queues nothing when the ledger already has this evening', async () => {
    process.env[F14_ENABLED_ENV] = 'true';
    const { deps, queued } = harness({ alreadySent: true });
    const result = await runEveningCheckInSweep(database, deps, EVENING);
    expect(result.duplicate).toBe(1);
    expect(queued).toEqual([]);
  });

  it('names a duplicate candidate rather than offering twice', async () => {
    process.env[F14_ENABLED_ENV] = 'true';
    const { deps, audits } = harness({ queue: 'duplicate' });
    const result = await runEveningCheckInSweep(database, deps, EVENING);
    expect(result.duplicate).toBe(1);
    expect(result.queued).toBe(0);
    expect(audits).toEqual([]);
  });

  it('stays quiet while the registration ladder is waiting on an answer', async () => {
    process.env[F14_ENABLED_ENV] = 'true';
    const { deps, queued } = harness({ registrationStanding: true });
    const result = await runEveningCheckInSweep(database, deps, EVENING);
    expect(result.heldForRegistration).toBe(1);
    expect(queued).toEqual([]);
  });

  it('honours a stored stop without reading the calendar', async () => {
    process.env[F14_ENABLED_ENV] = 'true';
    let reads = 0;
    const { deps, queued } = harness({
      state: { cadence: 'off' },
      today: async () => {
        reads += 1;
        return { anchor: 'swim' };
      },
    });
    const result = await runEveningCheckInSweep(database, deps, EVENING);
    expect(result.skipped.cadence_off).toBe(1);
    expect(queued).toEqual([]);
    expect(reads).toBe(0);
  });
});

describe('the activity anchor', () => {
  const offered = (overrides: Parameters<typeof harness>[0] = {}) => {
    process.env[F14_ENABLED_ENV] = 'true';
    return harness({
      state: { lastAskedAt: new Date(EVENING.getTime() - 24 * 3_600_000), silentStreak: 0 },
      ...overrides,
    });
  };

  it('puts the activity on the candidate once the flag is armed', async () => {
    process.env[CHECK_IN_ANCHOR_ENABLED_ENV] = 'true';
    const { deps, queued, audits } = offered({ today: { anchor: 'swim' }, children: ['Mia'] });
    const result = await runEveningCheckInSweep(database, deps, EVENING);
    expect(result.anchor.anchored).toBe(1);
    expect(queued[0]?.what).toBe('swim, Mia');
    expect(queued[0]?.what).not.toMatch(KEYWORD);
    expect(audits[0]?.after).toEqual({ anchored: true });
    expect(JSON.stringify(audits[0])).not.toContain('swim');
  });

  it("is off until the flag says exactly 'true', and a trailing newline is not 'true'", async () => {
    for (const value of [undefined, '', 'false', 'TRUE', '1', 'true\n', ' true']) {
      if (value === undefined) delete process.env[CHECK_IN_ANCHOR_ENABLED_ENV];
      else process.env[CHECK_IN_ANCHOR_ENABLED_ENV] = value;
      const { deps, queued } = offered({ today: { anchor: 'swim' }, children: ['Mia'] });
      const result = await runEveningCheckInSweep(database, deps, EVENING);
      expect(result.anchor.flag_off, JSON.stringify(value)).toBe(1);
      expect(queued[0]?.what, JSON.stringify(value)).toBe('Mia');
      expect(queued[0]?.what, JSON.stringify(value)).not.toContain('swim');
    }
    process.env[CHECK_IN_ANCHOR_ENABLED_ENV] = 'true';
    const armed = offered({ today: { anchor: 'swim' } });
    expect((await runEveningCheckInSweep(database, armed.deps, EVENING)).anchor.anchored).toBe(1);
  });

  it('counts each refusal as itself', async () => {
    process.env[CHECK_IN_ANCHOR_ENABLED_ENV] = 'true';
    for (const reason of [
      'no_event_today',
      'private_event',
      'placement_lane',
      'no_child',
      'not_gsm7',
    ] as const) {
      const { deps, queued } = offered({ today: { anchor: null, reason }, children: ['Mia'] });
      const result = await runEveningCheckInSweep(database, deps, EVENING);
      expect(result.anchor[reason], reason).toBe(1);
      expect(result.anchor.anchored, reason).toBe(0);
      expect(queued[0]?.what, reason).toBe('Mia');
    }
  });

  it('counts a title longer than one line as over_segment, and still offers the name', async () => {
    process.env[CHECK_IN_ANCHOR_ENABLED_ENV] = 'true';
    const { deps, queued } = offered({ today: { anchor: 'x'.repeat(200) }, children: ['Mia'] });
    const result = await runEveningCheckInSweep(database, deps, EVENING);
    expect(result.anchor.over_segment).toBe(1);
    expect(result.anchor.anchored).toBe(0);
    expect(queued[0]?.what).toBe('Mia');
  });

  it('still offers when the read throws, and says the read threw', async () => {
    process.env[CHECK_IN_ANCHOR_ENABLED_ENV] = 'true';
    const { deps, queued } = offered({
      today: async () => {
        throw new Error('calendar read exploded');
      },
    });
    const result = await runEveningCheckInSweep(database, deps, EVENING);
    expect(result.anchor.read_failed).toBe(1);
    expect(result.failed).toBe(0);
    expect(queued).toHaveLength(1);
  });

  it('anchors a first evening the same way as any other', async () => {
    process.env[CHECK_IN_ANCHOR_ENABLED_ENV] = 'true';
    process.env[F14_ENABLED_ENV] = 'true';
    const { deps, queued } = harness({ today: { anchor: 'swim' }, children: ['Mia'] });
    const result = await runEveningCheckInSweep(database, deps, EVENING);
    expect(result.anchor.anchored).toBe(1);
    expect(queued[0]?.what).toContain('swim');
  });

  it('never reads the calendar for a household it is not going to offer', async () => {
    process.env[CHECK_IN_ANCHOR_ENABLED_ENV] = 'true';
    process.env[F14_ENABLED_ENV] = 'true';
    let reads = 0;
    const { deps } = harness({
      hold: 'not_enrolled',
      today: async () => {
        reads += 1;
        return { anchor: 'swim' };
      },
    });
    await runEveningCheckInSweep(database, deps, EVENING);
    expect(reads).toBe(0);
  });
});
