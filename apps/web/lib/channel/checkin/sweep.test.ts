import type { Database } from '@hale/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { F14_ALLOWLIST_ENV, F14_ENABLED_ENV } from '~/lib/channel/f14';
import { groupAddressedLine } from '~/lib/channel/linq/group-coparent-copy';
import { OPT_OUT_LINE } from '~/lib/channel/opt-out';
import type { ProactiveHoldReason } from '~/lib/channel/outbound-gate';
import { nightlyOccasion } from '~/lib/channel/variant';
import type { CheckInState } from './cadence';
import { CHECK_IN_ASK_TEMPLATE_KEY, CHECK_IN_STEP_DOWN, composeCheckInAsk } from './copy';
import {
  CHECK_IN_ANCHOR_ENABLED_ENV,
  type EveningCheckInDeps,
  MAX_CHECK_INS_PER_RUN,
  type TodayActivity,
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
  delete process.env[CHECK_IN_ANCHOR_ENABLED_ENV];
});

interface Overrides {
  state?: Partial<CheckInState>;
  timeZone?: string;
  hold?: ProactiveHoldReason;
  alreadySent?: boolean;
  registrationStanding?: boolean;
  children?: string[];
  today?: TodayActivity | (() => Promise<TodayActivity>);
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
      countProactiveSends: async () => (overrides.hold === 'frequency_cap' ? 9 : 0),
      proactiveSentSince: async () => false,
      // The gate reads the PARENT's own clock, which is the family's. The evening
      // instant is 20:17 in Toronto and 02:17 the next morning in Paris, so the hold
      // case moves the parent there and everything else keeps the family's zone.
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
    expect(ledger[0]?.dedupeKey).toBe(
      `evening_check_in:weekly:${FAMILY}:${lastAsked.toISOString()}`,
    );
    expect(audits[0]?.actionTaken).toBe('evening_check_in_stepped_down');
    // The counter is baselined on this evening, so the lapse this rung just answered is
    // not read off the timestamps again by the first weekly question (which would make
    // "three more" mean two).
    expect(cadences).toEqual([{ cadence: 'weekly', silentStreak: 0, silentStreakSince: EVENING }]);
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

/**
 * THE ANCHOR'S OUTCOMES — the counting, and the flag.
 *
 * WHICH ROWS may be named is the reader's business and is pinned over real Postgres in
 * sweep.pglite.test.ts, through the production wiring, because a fake reader can never
 * fail on a bug inside the real one. What is pinned HERE is the part the sweep owns: that
 * an outcome is counted for every household it asked, that "there was nothing" and "there
 * was something Hale would not say" are different numbers, and that the flag is read the
 * one way that survives a trailing newline.
 */
describe('the activity anchor', () => {
  const asked = (overrides: Parameters<typeof harness>[0] = {}) => {
    process.env[F14_ENABLED_ENV] = 'true';
    return harness({
      state: { lastAskedAt: new Date(EVENING.getTime() - 24 * 3_600_000), silentStreak: 0 },
      ...overrides,
    });
  };

  it('names the activity and counts it, once the flag is armed', async () => {
    process.env[CHECK_IN_ANCHOR_ENABLED_ENV] = 'true';
    const { deps, sent, threaded } = asked({ today: { anchor: 'swim' } });
    const result = await runEveningCheckInSweep(database, deps, EVENING);
    expect(result.anchor.anchored).toBe(1);
    expect(sent[0]?.body).toContain('swim');
    // The thread the coach re-reads carries the composed sentence, never the wire body.
    expect(threaded[0]).toContain('swim');
    expect(threaded[0]).not.toContain(OPT_OUT_LINE);
  });

  it("is off until the flag says exactly 'true', and a trailing newline is not 'true'", async () => {
    // `vercel env add` from a piped echo stores 'true\n'. A truthiness check would read
    // that as ON and start naming calendar rows in an unprompted nightly text.
    for (const value of [undefined, '', 'false', 'TRUE', '1', 'true\n', ' true']) {
      if (value === undefined) delete process.env[CHECK_IN_ANCHOR_ENABLED_ENV];
      else process.env[CHECK_IN_ANCHOR_ENABLED_ENV] = value;
      const { deps, sent } = asked({ today: { anchor: 'swim' } });
      const result = await runEveningCheckInSweep(database, deps, EVENING);
      expect(result.anchor.flag_off, JSON.stringify(value)).toBe(1);
      expect(result.anchor.anchored, JSON.stringify(value)).toBe(0);
      // Off is not degraded: it is the day question, which is the shipped message.
      expect(sent[0]?.body, JSON.stringify(value)).toContain('Mia and Leo');
      expect(sent[0]?.body, JSON.stringify(value)).not.toContain('swim');
    }
    // The positive control, or every assertion above would pass on a flag nothing reads.
    process.env[CHECK_IN_ANCHOR_ENABLED_ENV] = 'true';
    const armed = asked({ today: { anchor: 'swim' } });
    expect((await runEveningCheckInSweep(database, armed.deps, EVENING)).anchor.anchored).toBe(1);
  });

  it('counts each refusal as itself and never as another one', async () => {
    process.env[CHECK_IN_ANCHOR_ENABLED_ENV] = 'true';
    for (const reason of [
      'no_event_today',
      'private_event',
      'placement_lane',
      'no_child',
      'not_gsm7',
    ] as const) {
      const { deps, sent } = asked({ today: { anchor: null, reason } });
      const result = await runEveningCheckInSweep(database, deps, EVENING);
      expect(result.anchor[reason], reason).toBe(1);
      expect(result.anchor.anchored, reason).toBe(0);
      expect(result.anchor.no_event_today, reason).toBe(reason === 'no_event_today' ? 1 : 0);
      expect(sent[0]?.body, reason).toContain('Mia and Leo');
    }
  });

  it('counts a title the budget refused as over_segment, not as a quiet day', async () => {
    process.env[CHECK_IN_ANCHOR_ENABLED_ENV] = 'true';
    const { deps, sent } = asked({ today: { anchor: 'x'.repeat(200) } });
    const result = await runEveningCheckInSweep(database, deps, EVENING);
    expect(result.anchor.over_segment).toBe(1);
    expect(result.anchor.anchored).toBe(0);
    expect(result.anchor.no_event_today).toBe(0);
    expect(sent[0]?.body).toContain('Mia and Leo');
  });

  it('still asks when the read throws, and says the read threw', async () => {
    process.env[CHECK_IN_ANCHOR_ENABLED_ENV] = 'true';
    const { deps, sent } = asked({
      today: async () => {
        throw new Error('calendar read exploded');
      },
    });
    const result = await runEveningCheckInSweep(database, deps, EVENING);
    expect(result.anchor.read_failed).toBe(1);
    expect(result.failed).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it("does not anchor a household's first ever question, and says so", async () => {
    process.env[CHECK_IN_ANCHOR_ENABLED_ENV] = 'true';
    process.env[F14_ENABLED_ENV] = 'true';
    const { deps, sent } = harness({ today: { anchor: 'swim' } });
    const result = await runEveningCheckInSweep(database, deps, EVENING);
    expect(result.anchor.first_ask).toBe(1);
    expect(result.anchor.anchored).toBe(0);
    expect(sent[0]?.body).toContain("Quick one before the day's gone");
  });

  it('records on the audit row whether the evening named anything, and never what', async () => {
    // The trail can count anchored evenings without the row ever carrying a title.
    // audit_log is immutable and PIPEDA-exportable and has none of the teen redaction a
    // memory read has, so the FLAG goes on it and the activity never does.
    process.env[CHECK_IN_ANCHOR_ENABLED_ENV] = 'true';
    process.env[F14_ENABLED_ENV] = 'true';
    const asked = {
      cadence: 'daily' as const,
      lastAskedAt: new Date(EVENING.getTime() - 24 * 3_600_000),
    };

    const named = harness({ state: asked, today: { anchor: 'swim' } });
    await runEveningCheckInSweep(database, named.deps, EVENING);
    expect(named.audits[0]?.after).toEqual({ cadence: 'daily', anchored: true });
    expect(JSON.stringify(named.audits[0])).not.toContain('swim');

    // The day form is not a degraded message — it is the one this lane shipped with — so
    // the row says so rather than saying nothing.
    const day = harness({ state: asked, today: { anchor: null, reason: 'no_event_today' } });
    await runEveningCheckInSweep(database, day.deps, EVENING);
    expect(day.audits[0]?.after).toEqual({ cadence: 'daily', anchored: false });
  });

  it('counts nothing for the step-down notice, which asks nothing', async () => {
    process.env[CHECK_IN_ANCHOR_ENABLED_ENV] = 'true';
    process.env[F14_ENABLED_ENV] = 'true';
    const { deps, sent } = harness({
      state: {
        cadence: 'daily',
        lastAskedAt: new Date(EVENING.getTime() - 24 * 3_600_000),
        silentStreak: 2,
      },
      today: { anchor: 'swim' },
    });
    const result = await runEveningCheckInSweep(database, deps, EVENING);
    expect(result.steppedDownToWeekly).toBe(1);
    expect(Object.values(result.anchor).reduce((a, b) => a + b, 0)).toBe(0);
    expect(sent[0]?.body).toBe(`${CHECK_IN_STEP_DOWN}\n\n${OPT_OUT_LINE}`);
  });

  it('never reads the calendar for a household it is not going to ask', async () => {
    // The read joins the names read on the same side of the gate: a family already asked,
    // or over budget, must not cost a read of what their children did today.
    process.env[CHECK_IN_ANCHOR_ENABLED_ENV] = 'true';
    process.env[F14_ENABLED_ENV] = 'true';
    let reads = 0;
    const { deps } = harness({
      hold: 'frequency_cap',
      today: async () => {
        reads += 1;
        return { anchor: 'swim' };
      },
    });
    await runEveningCheckInSweep(database, deps, EVENING);
    expect(reads).toBe(0);
  });
});

/** A select double that answers the group resolver and the name read, and nothing else. */
function groupDatabase(name: string | null): Database {
  const select = (fields: object) => {
    const keys = Object.keys(fields);
    let rows: Array<Record<string, unknown>> = [];
    if (keys.includes('linqGroupChatId')) rows = [{ linqGroupChatId: 'chat-home' }];
    else if (keys.includes('primaryLanguage')) rows = [{ primaryLanguage: 'en' }];
    else if (keys.includes('name') && keys.length === 1) rows = [{ name }];
    else if (keys.includes('timezone')) rows = [{ timezone: 'America/Toronto' }];
    const limited = Object.assign(Promise.resolve(rows), {
      limit: async () => rows,
    });
    const chain = {
      from: () => chain,
      where: () => limited,
      limit: async () => rows,
    };
    return chain;
  };
  return { select } as unknown as Database;
}

describe('a claimed group', () => {
  afterEach(() => {
    process.env.LINQ_API_KEY = undefined;
    vi.unstubAllGlobals();
  });

  it('prefixes the evening when the parent is known, and leaves an unknown parent unprefixed', async () => {
    process.env[F14_ENABLED_ENV] = 'true';
    process.env.LINQ_API_KEY = 'linq_test_key_not_a_secret';
    const bodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.body) bodies.push(String(init.body));
        return new Response(JSON.stringify({ message: { id: 'chk-1' } }), { status: 201 });
      }),
    );
    const asked = { lastAskedAt: new Date(EVENING.getTime() - 24 * 3_600_000) };
    const expected = composeCheckInAsk({
      first: false,
      childNames: ['Mia', 'Leo'],
      todayActivity: null,
      familyId: FAMILY,
      occasion: nightlyOccasion(EVENING, 'America/Toronto'),
    });
    const named = harness({ state: asked, children: ['Mia', 'Leo'] });
    await runEveningCheckInSweep(groupDatabase('Sam'), named.deps, EVENING);
    expect(named.sent).toEqual([]);
    expect(bodies.join('\n')).toContain(groupAddressedLine('Sam', expected.body));

    bodies.length = 0;
    const unknown = harness({ state: asked, children: ['Mia', 'Leo'] });
    await runEveningCheckInSweep(groupDatabase(null), unknown.deps, EVENING);
    expect(unknown.sent).toEqual([]);
    expect(bodies.join('\n')).toContain(expected.body);
    expect(bodies.join('\n')).not.toContain('Sam,');
  });

  it('does not prefix the step-down notice', async () => {
    process.env[F14_ENABLED_ENV] = 'true';
    process.env.LINQ_API_KEY = 'linq_test_key_not_a_secret';
    const bodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.body) bodies.push(String(init.body));
        return new Response(JSON.stringify({ message: { id: 'chk-2' } }), { status: 201 });
      }),
    );
    const { deps, sent } = harness({
      state: {
        cadence: 'daily',
        lastAskedAt: new Date(EVENING.getTime() - 24 * 3_600_000),
        silentStreak: 2,
      },
    });
    await runEveningCheckInSweep(groupDatabase('Sam'), deps, EVENING);
    expect(sent).toEqual([]);
    expect(bodies.join('\n')).toContain(CHECK_IN_STEP_DOWN);
    expect(bodies.join('\n')).not.toContain('Sam,');
  });
});
