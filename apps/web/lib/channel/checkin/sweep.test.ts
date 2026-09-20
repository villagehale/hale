import type { Database } from '@hale/db';
import { afterEach, describe, expect, it } from 'vitest';
import { F14_ALLOWLIST_ENV, F14_ENABLED_ENV } from '~/lib/channel/f14';
import type { ProactiveHoldReason } from '~/lib/channel/outbound-gate';
import { OPT_OUT_LINE } from '~/lib/channel/opt-out';
import type { CheckInState } from './cadence';
import { CHECK_IN_ASK_TEMPLATE_KEY, CHECK_IN_STEP_DOWN } from './copy';
import {
  type EveningCheckInDeps,
  MAX_CHECK_INS_PER_RUN,
  runEveningCheckInSweep,
} from './sweep';

/**
 * The question Hale asks every evening.
 *
 * What is pinned here: it is dark until armed, it only speaks in the 20:00 local hour,
 * it goes through the outbound gate rather than around it, it never speaks over a
 * registration morning, and the ladder's decisions reach the ledger intact. The gate's
 * own four checks live in outbound-gate.test.ts and the ladder's arithmetic in
 * cadence.test.ts — what matters here is that this sweep cannot reach a transport
 * without both.
 */

const FAMILY = 'fam-1';
const PARENT = 'parent-1';
/** 20:17 in Toronto — the hour the clamp allows and the minute the cron fires. */
const EVENING = new Date('2026-07-06T00:17:00.000Z');

const database = {} as Database;

afterEach(() => {
  delete process.env[F14_ENABLED_ENV];
  delete process.env[F14_ALLOWLIST_ENV];
});

interface Overrides {
  state?: Partial<CheckInState>;
  timeZone?: string;
  hold?: ProactiveHoldReason;
  alreadySent?: boolean;
  registrationStanding?: boolean;
  children?: string[];
}

function harness(overrides: Overrides = {}) {
  const sent: Array<{ to: string; body: string }> = [];
  const ledger: Array<{ dedupeKey: string; templateKey: string }> = [];
  const audits: Array<Record<string, unknown>> = [];
  const threaded: string[] = [];
  const asks: Array<{ silentStreak: number }> = [];
  const cadences: Array<{ cadence: string; silentStreak: number; silentStreakSince?: Date }> = [];

  const deps: EveningCheckInDeps = {
    selectFamilies: async () => [
      { familyId: FAMILY, parentUserId: PARENT, timeZone: overrides.timeZone ?? 'America/Toronto' },
    ],
    loadNamableChildren: async () => overrides.children ?? ['Mia', 'Leo'],
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
      countProactiveSends: async () => (overrides.hold === 'frequency_cap' ? 9 : 0),
      proactiveSentSince: async () => false,
      // The gate reads the PARENT's own clock, which is the family's. The evening
      // instant is 20:17 in Toronto and 02:17 the next morning in Paris, so the hold
      // case moves the parent there and everything else keeps the family's zone.
      parentTimeZone: async () =>
        overrides.hold === 'quiet_hours' ? 'Europe/Paris' : (overrides.timeZone ?? 'America/Toronto'),
    }),
    readinessStanding: async () =>
      overrides.registrationStanding === true
        ? { id: 'seq-1', summary: 'setup on the portal', askedAt: EVENING }
        : null,
    dedupeActive: async () => overrides.alreadySent === true,
    resolveSendablePhone: async () => '+14165550100',
    transport: {
      send: async (input) => {
        sent.push(input);
        return { providerMessageId: 'prov-1' };
      },
    },
    recordSend: async (_db, write) => {
      ledger.push({ dedupeKey: write.dedupeKey, templateKey: write.templateKey });
      return 'msg-1';
    },
    audit: async (_db, row) => {
      audits.push(row);
    },
    threadMessage: async (_db, input) => {
      threaded.push(input.body);
      return 'conv-1';
    },
    recordAsk: async (_db, input) => {
      asks.push({ silentStreak: input.silentStreak });
    },
    recordCadence: async (_db, input) => {
      cadences.push({
        cadence: input.cadence,
        silentStreak: input.silentStreak,
        ...(input.silentStreakSince === undefined
          ? {}
          : { silentStreakSince: input.silentStreakSince }),
      });
    },
  };
  return { deps, sent, ledger, audits, threaded, asks, cadences };
}

describe('the dark-launch gate', () => {
  it('selects nobody at all while F14 is unarmed', async () => {
    const { deps, sent } = harness();
    const result = await runEveningCheckInSweep(database, deps, EVENING);
    expect(result.enabled).toBe(false);
    expect(result.inSlot).toBe(0);
    expect(sent).toEqual([]);
  });

  it('reaches one allowlisted household with the flag still off', async () => {
    process.env[F14_ALLOWLIST_ENV] = FAMILY;
    const { deps, sent } = harness();
    const result = await runEveningCheckInSweep(database, deps, EVENING);
    expect(result.asked).toBe(1);
    expect(sent).toHaveLength(1);
  });
});

describe('the evening slot', () => {
  it('says nothing at any other local hour', async () => {
    process.env[F14_ENABLED_ENV] = 'true';
    const { deps, sent } = harness();
    // 21:17 Toronto — one hour late is past the clamp and past the quiet-hours floor.
    const result = await runEveningCheckInSweep(
      database,
      deps,
      new Date('2026-07-06T01:17:00.000Z'),
    );
    expect(result.inSlot).toBe(0);
    expect(sent).toEqual([]);
  });

  it('follows the family clock, not the server clock', async () => {
    process.env[F14_ENABLED_ENV] = 'true';
    const { deps, sent } = harness({ timeZone: 'America/Vancouver' });
    // The same instant is 17:17 in Vancouver.
    expect((await runEveningCheckInSweep(database, deps, EVENING)).inSlot).toBe(0);
    const later = harness({ timeZone: 'America/Vancouver' });
    const result = await runEveningCheckInSweep(
      database,
      later.deps,
      new Date('2026-07-06T03:17:00.000Z'),
    );
    expect(result.asked).toBe(1);
    expect(sent).toEqual([]);
    expect(later.sent).toHaveLength(1);
  });
});

describe('an hour with more households in it than one run may carry', () => {
  it('counts every one of them and says how many it left for tomorrow', async () => {
    process.env[F14_ENABLED_ENV] = 'true';
    const { deps, sent } = harness();
    const over = MAX_CHECK_INS_PER_RUN + 2;
    deps.selectFamilies = async () =>
      Array.from({ length: over }, (_, index) => ({
        familyId: `fam-${index}`,
        parentUserId: `parent-${index}`,
        timeZone: 'America/Toronto',
      }));

    const result = await runEveningCheckInSweep(database, deps, EVENING);
    // inSlot is the HOUR, not the batch: a bound that also shrank the number it reported
    // would hide the one condition this counter exists to surface.
    expect({ inSlot: result.inSlot, overflow: result.overflow, asked: result.asked }).toEqual({
      inSlot: over,
      overflow: 2,
      asked: MAX_CHECK_INS_PER_RUN,
    });
    expect(sent).toHaveLength(MAX_CHECK_INS_PER_RUN);
  });

  it('spends the bound on households that are due, not on the ones at the front', async () => {
    process.env[F14_ENABLED_ENV] = 'true';
    const { deps, sent } = harness();
    const over = MAX_CHECK_INS_PER_RUN + 2;
    deps.selectFamilies = async () =>
      Array.from({ length: over }, (_, index) => ({
        familyId: `fam-${index}`,
        parentUserId: `parent-${index}`,
        timeZone: 'America/Toronto',
      }));
    // The selection is ordered least-recently-asked first, and the two at the very front
    // of that queue are exactly the households the ladder has nothing to send: a family
    // that switched the question off is never asked again, so its last_asked_at never
    // moves and it sits at the head of the order forever. A bound applied before the
    // ladder spends two of its hundred on them every evening.
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
      asked: result.asked,
      off: result.skipped.cadence_off,
    }).toEqual({ inSlot: over, overflow: 0, asked: MAX_CHECK_INS_PER_RUN, off: 2 });
    expect(sent).toHaveLength(MAX_CHECK_INS_PER_RUN);
  });
});

describe('what goes out', () => {
  it('asks the long way the first time, with the opt-out on the wire and not in the thread', async () => {
    process.env[F14_ENABLED_ENV] = 'true';
    const { deps, sent, ledger, threaded, audits, asks } = harness();
    await runEveningCheckInSweep(database, deps, EVENING);

    expect(sent[0]?.body).toBe(
      `Quick one before the day's gone: how did today go with Mia and Leo? One line is plenty. Reply LESS for weekly, or NO to skip these.\n\n${OPT_OUT_LINE}`,
    );
    expect(threaded[0]).not.toContain(OPT_OUT_LINE);
    expect(ledger[0]).toEqual({
      dedupeKey: 'evening_check_in:fam-1:2026-07-05',
      templateKey: CHECK_IN_ASK_TEMPLATE_KEY,
    });
    expect(audits[0]?.actionTaken).toBe('evening_check_in_sent');
    expect(asks).toEqual([{ silentStreak: 0 }]);
  });

  it('asks the short way once the family has been asked before', async () => {
    process.env[F14_ENABLED_ENV] = 'true';
    const { deps, sent } = harness({
      state: { lastAskedAt: new Date(EVENING.getTime() - 24 * 3_600_000), silentStreak: 0 },
    });
    await runEveningCheckInSweep(database, deps, EVENING);
    // Which of the five it is belongs to the rotation (copy.test.ts owns the members).
    // What belongs HERE is that the sweep asked the LATER question and not the first one:
    // the keywords are printed once in a lifetime, and printing them again would teach a
    // parent an opt-out they have already been offered.
    const body = sent[0]?.body ?? '';
    expect(body).toContain('Mia and Leo');
    expect(body).not.toContain('Reply LESS for weekly');
    expect(body).not.toContain("Quick one before the day's gone");
  });

  it('asks a different one of the five the next evening', async () => {
    process.env[F14_ENABLED_ENV] = 'true';
    // The property a pool exists for, through the sweep rather than through the composer:
    // the occasion is derived from the family's own clock inside runForFamily, so a sweep
    // that stopped passing it — or passed a constant — reads identically two nights
    // running and nothing else in this file would notice.
    const bodies = [0, 1, 2, 3, 4, 5].map(() => '');
    for (const [index, dayOffset] of [0, 1, 2, 3, 4, 5].entries()) {
      const { deps, sent } = harness({
        state: { lastAskedAt: new Date(EVENING.getTime() - 24 * 3_600_000), silentStreak: 0 },
      });
      await runEveningCheckInSweep(
        database,
        deps,
        new Date(EVENING.getTime() + dayOffset * 24 * 3_600_000),
      );
      bodies[index] = sent[0]?.body ?? '';
    }
    for (let i = 1; i < bodies.length; i++) {
      expect(bodies[i], `evening ${i}`).not.toBe(bodies[i - 1]);
    }
    // Five members, so the sixth evening comes back round to the first — the rotation,
    // not a stream of new sentences.
    expect(bodies[5]).toBe(bodies[0]);
  });

  it('never names a teenager', async () => {
    process.env[F14_ENABLED_ENV] = 'true';
    // A household of one 4-year-old and one 14-year-old arrives here with the teen
    // already dropped at the source, so the sentence cannot leak the name back.
    const { deps, sent } = harness({ children: ['Mia'] });
    await runEveningCheckInSweep(database, deps, EVENING);
    // Named, whichever of the five tonight is — the slot is the same in every member.
    expect(sent[0]?.body).toContain('Mia');
    expect(sent[0]?.body).not.toContain('Noah');

    const teensOnly = harness({ children: [] });
    await runEveningCheckInSweep(database, teensOnly.deps, EVENING);
    expect(teensOnly.sent[0]?.body).toContain('the kids');
  });
});

describe('what stops it', () => {
  it('records the gate holds and writes nothing, so silence is not counted against the family', async () => {
    process.env[F14_ENABLED_ENV] = 'true';
    for (const hold of [
      'not_enrolled',
      'no_watch_consent',
      'frequency_cap',
      'quiet_hours',
    ] as const) {
      const { deps, sent, asks, cadences } = harness({ hold });
      const result = await runEveningCheckInSweep(database, deps, EVENING);
      expect(result.held[hold], hold).toBe(1);
      expect(result.asked, hold).toBe(0);
      expect(sent, hold).toEqual([]);
      expect([...asks, ...cadences], hold).toEqual([]);
    }
  });

  it('sends nothing on a second tick inside the same evening', async () => {
    process.env[F14_ENABLED_ENV] = 'true';
    const { deps, sent, asks } = harness({ alreadySent: true });
    const result = await runEveningCheckInSweep(database, deps, EVENING);
    expect(result.duplicate).toBe(1);
    expect(sent).toEqual([]);
    expect(asks).toEqual([]);
  });

  it('stays quiet while the registration ladder is waiting on an answer', async () => {
    process.env[F14_ENABLED_ENV] = 'true';
    // The readiness question closes the moment ANY outbound reaches this parent, so a
    // cheerful evening text would silently cost them the registration morning.
    const { deps, sent, asks } = harness({ registrationStanding: true });
    const result = await runEveningCheckInSweep(database, deps, EVENING);
    expect(result.heldForRegistration).toBe(1);
    expect(sent).toEqual([]);
    expect(asks).toEqual([]);
  });
});

describe('the ladder, end to end', () => {
  it('announces the step down to weekly, once, and leaves the ask clock alone', async () => {
    process.env[F14_ENABLED_ENV] = 'true';
    const lastAsked = new Date(EVENING.getTime() - 24 * 3_600_000);
    const { deps, sent, ledger, cadences, asks, audits } = harness({
      state: { cadence: 'daily', silentStreak: 2, lastAskedAt: lastAsked },
    });
    const result = await runEveningCheckInSweep(database, deps, EVENING);

    expect(result.steppedDownToWeekly).toBe(1);
    expect(sent[0]?.body.startsWith(CHECK_IN_STEP_DOWN)).toBe(true);
    // Its own dedupe key, anchored on the ask being stepped down from — so a retry
    // tomorrow cannot announce the same change twice.
    expect(ledger[0]?.dedupeKey).toBe(`evening_check_in:weekly:${FAMILY}:${lastAsked.toISOString()}`);
    expect(audits[0]?.actionTaken).toBe('evening_check_in_stepped_down');
    // The counter is baselined on this evening, so the lapse this rung just answered is
    // not read off the timestamps again by the first weekly question (which would make
    // "three more" mean two).
    expect(cadences).toEqual([
      { cadence: 'weekly', silentStreak: 0, silentStreakSince: EVENING },
    ]);
    expect(asks).toEqual([]);
  });

  it('goes dormant without a word, and leaves a receipt that it did', async () => {
    process.env[F14_ENABLED_ENV] = 'true';
    const { deps, sent, cadences, audits } = harness({
      state: {
        cadence: 'weekly',
        silentStreak: 2,
        lastAskedAt: new Date(EVENING.getTime() - 8 * 24 * 3_600_000),
      },
    });
    const result = await runEveningCheckInSweep(database, deps, EVENING);

    expect(result.dormant).toBe(1);
    expect(sent).toEqual([]);
    expect(cadences).toEqual([{ cadence: 'off', silentStreak: 3 }]);
    // Going quiet is the one state change with no message, so the audit row is the only
    // evidence it was a decision rather than a breakage.
    expect(audits[0]?.actionTaken).toBe('evening_check_in_stopped');
  });

  it('honours a parent who said no, without reading their children or their clock', async () => {
    process.env[F14_ENABLED_ENV] = 'true';
    const { deps, sent } = harness({ state: { cadence: 'off' } });
    const result = await runEveningCheckInSweep(database, deps, EVENING);
    expect(result.skipped.cadence_off).toBe(1);
    expect(sent).toEqual([]);
  });
});
