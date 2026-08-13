import type { Database } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeTransport } from '~/lib/channel/intake/transport';
import type { OutboundGatePorts } from '~/lib/channel/outbound-gate';
import type { ReminderChild } from '~/lib/loop/templates/reminder/payload';
import { INTRO_FOLLOWUP_ASK } from './copy';
import {
  ACTIVITY_FOLLOWUP_MAX_AGE_DAYS,
  ACTIVITY_FOLLOWUP_MIN_AGE_DAYS,
  type DueActivity,
  type DueIntro,
  FOLLOWUP_ASKS_ALLOWLIST_ENV,
  FOLLOWUP_ASKS_ENABLED_ENV,
  type FollowupFamily,
  type FollowupSweepDeps,
  INTRO_FOLLOWUP_MAX_AGE_DAYS,
  INTRO_FOLLOWUP_MIN_AGE_DAYS,
  activityFollowupWindow,
  introFollowupWindow,
  runFollowupSweep,
} from './run';

const DB = {} as Database;
/** 11:00 in Toronto — outside the 21:00-08:00 proactive quiet window. */
const NOW = new Date('2026-08-12T15:00:00Z');
const DAY_MS = 24 * 3_600_000;

/** 00:00 the next morning in Tokyo at NOW — inside the quiet window, for real, through
 * the gate's own clock rather than a stubbed hold reason. */
const QUIET_ZONE = 'Asia/Tokyo';
const AWAKE_ZONE = 'America/Toronto';

const FAM_A = 'fam-a';
const FAM_B = 'fam-b';

function family(familyId: string): FollowupFamily {
  return { familyId, parentUserId: `user-${familyId}` };
}

function toddler(overrides: Partial<ReminderChild> = {}): ReminderChild {
  return { id: 'child-1', name: 'Maya', dateOfBirth: '2023-02-11', gender: 'girl', ...overrides };
}

function activity(overrides: Partial<DueActivity> = {}): DueActivity {
  return {
    eventId: 'event-1',
    familyId: FAM_A,
    title: 'Swim class',
    startsAt: new Date(NOW.getTime() - 1.5 * DAY_MS),
    childId: null,
    sensitive: false,
    ...overrides,
  };
}

interface Recorded {
  familyId: string;
  parentUserId: string;
  templateKey: string;
  dedupeKey: string;
}

interface Harness {
  deps: FollowupSweepDeps;
  transport: FakeTransport;
  recorded: Recorded[];
  audits: Array<{
    familyId: string;
    actionTaken: string;
    targetTable: string;
    targetId: string;
    after: Record<string, unknown>;
  }>;
}

/**
 * The harness deliberately wires the ledger to itself: `dedupeActive` and the gate's
 * `countProactiveSends` both read the sends this run actually recorded.
 *
 * That is what makes the two rails testable as MECHANISMS rather than as stubs. A second
 * tick is a second `runFollowupSweep` against the same harness, so "does not re-send"
 * is proved by the same key the production ledger would hold; and the one-per-family-
 * per-day rail is proved by the real `PROACTIVE_CAP` arithmetic counting a send this
 * sweep just made, not by a fake that was told to say no.
 */
function harness(
  overrides: {
    families?: FollowupFamily[];
    intros?: DueIntro[];
    discoverable?: Set<string>;
    activities?: Record<string, DueActivity[]>;
    children?: Record<string, ReminderChild[]>;
    timeZone?: string;
  } = {},
): Harness {
  const transport = new FakeTransport();
  const recorded: Recorded[] = [];
  const audits: Harness['audits'] = [];
  const families = overrides.families ?? [family(FAM_A), family(FAM_B)];

  const gate: OutboundGatePorts = {
    channelEnrolled: async () => true,
    watchConsentGranted: async () => true,
    // `since` is ignored: every send in a test happens at NOW, so all of them are inside
    // any window the cap asks for.
    countProactiveSends: async (familyId) => recorded.filter((r) => r.familyId === familyId).length,
    parentTimeZone: async () => overrides.timeZone ?? AWAKE_ZONE,
  };

  const deps: FollowupSweepDeps = {
    selectFamilies: async () => families,
    loadDueIntros: async () => overrides.intros ?? [],
    discoverableUserIds: async (_db, userIds) =>
      overrides.discoverable ?? new Set(userIds),
    loadDueActivities: async (_db, familyId) => overrides.activities?.[familyId] ?? [],
    loadChildren: async (_db, familyId) => overrides.children?.[familyId] ?? [toddler()],
    buildGate: () => gate,
    dedupeActive: async (_db, dedupeKey) => recorded.some((r) => r.dedupeKey === dedupeKey),
    resolveSendablePhone: async (_db, parentUserId) => `+1555${parentUserId}`,
    recordSend: async (_db, write) => {
      recorded.push({
        familyId: write.familyId,
        parentUserId: write.parentUserId,
        templateKey: write.templateKey,
        dedupeKey: write.dedupeKey,
      });
      return 'row-1';
    },
    audit: async (_db, row) => {
      audits.push({
        familyId: row.familyId,
        actionTaken: row.actionTaken,
        targetTable: row.targetTable,
        targetId: row.targetId,
        after: row.after,
      });
    },
    transport,
  };

  return { deps, transport, recorded, audits };
}

const PAIR: DueIntro = { proposalId: 'prop-1', familyAId: FAM_A, familyBId: FAM_B };

beforeEach(() => {
  process.env[FOLLOWUP_ASKS_ENABLED_ENV] = 'true';
});

afterEach(() => {
  delete process.env[FOLLOWUP_ASKS_ENABLED_ENV];
  delete process.env[FOLLOWUP_ASKS_ALLOWLIST_ENV];
});

describe('the dark-launch flag', () => {
  it('does not even select families when neither the flag nor the allowlist is armed', async () => {
    delete process.env[FOLLOWUP_ASKS_ENABLED_ENV];
    const h = harness({ intros: [PAIR] });

    const result = await runFollowupSweep(DB, h.deps, NOW);

    expect(result.enabled).toBe(false);
    expect(h.transport.bodies()).toEqual([]);
  });

  it('arms for an allowlisted family only, leaving the rest untouched', async () => {
    delete process.env[FOLLOWUP_ASKS_ENABLED_ENV];
    process.env[FOLLOWUP_ASKS_ALLOWLIST_ENV] = FAM_A;
    const h = harness({ activities: { [FAM_A]: [activity()], [FAM_B]: [activity({ familyId: FAM_B, eventId: 'event-2' })] } });

    const result = await runFollowupSweep(DB, h.deps, NOW);

    expect(result.enabled).toBe(true);
    expect(h.recorded.map((r) => r.familyId)).toEqual([FAM_A]);
  });
});

describe('the intro follow-up', () => {
  it('asks both families once, claims each side, and audits each send', async () => {
    const h = harness({ intros: [PAIR] });

    const result = await runFollowupSweep(DB, h.deps, NOW);

    expect(result.introAsked).toBe(2);
    expect(h.transport.bodies()).toEqual([INTRO_FOLLOWUP_ASK, INTRO_FOLLOWUP_ASK]);
    expect(h.recorded).toEqual([
      {
        familyId: FAM_A,
        parentUserId: `user-${FAM_A}`,
        templateKey: 'followup:intro',
        dedupeKey: 'followup:intro:prop-1:a',
      },
      {
        familyId: FAM_B,
        parentUserId: `user-${FAM_B}`,
        templateKey: 'followup:intro',
        dedupeKey: 'followup:intro:prop-1:b',
      },
    ]);
    expect(h.audits).toEqual([
      {
        familyId: FAM_A,
        actionTaken: 'followup_intro_asked',
        targetTable: 'village_intro_proposals',
        targetId: 'prop-1',
        after: { side: 'a' },
      },
      {
        familyId: FAM_B,
        actionTaken: 'followup_intro_asked',
        targetTable: 'village_intro_proposals',
        targetId: 'prop-1',
        after: { side: 'b' },
      },
    ]);
  });

  /**
   * The claim, not the cap, is what stops the second tick — and the assertion says so.
   * A cap-blocked re-run would look identical on the transport, so `frequency_cap: 0` is
   * the discriminating half: it fails if the dedupe check is ever moved after the gate.
   */
  it('sends nothing on the next tick, because the send already claimed the key', async () => {
    const h = harness({ intros: [PAIR] });
    await runFollowupSweep(DB, h.deps, NOW);

    const second = await runFollowupSweep(DB, h.deps, new Date(NOW.getTime() + 3_600_000));

    expect(second.introAsked).toBe(0);
    expect(second.skipped.already_claimed).toBe(2);
    expect(second.held.frequency_cap).toBe(0);
    expect(h.transport.sent).toHaveLength(2);
  });

  it('skips the whole pair when one side has opted out of intros since', async () => {
    const h = harness({ intros: [PAIR], discoverable: new Set([`user-${FAM_A}`]) });

    const result = await runFollowupSweep(DB, h.deps, NOW);

    expect(result).toMatchObject({ introAsked: 0, skipped: expect.objectContaining({ opted_out: 2 }) });
    expect(h.transport.bodies()).toEqual([]);
  });

  it('skips the whole pair when one side is outside this run scope', async () => {
    const h = harness({ intros: [PAIR], families: [family(FAM_A)] });

    const result = await runFollowupSweep(DB, h.deps, NOW);

    expect(result.skipped.out_of_scope).toBe(2);
    expect(h.transport.bodies()).toEqual([]);
  });
});

describe('the activity follow-up', () => {
  it('names the placed activity for an ordinary event', async () => {
    const h = harness({ activities: { [FAM_A]: [activity()] } });

    const result = await runFollowupSweep(DB, h.deps, NOW);

    expect(result.activityAsked).toBe(1);
    expect(h.transport.bodies()).toEqual(['How was Swim class?']);
    expect(h.recorded[0]).toMatchObject({
      templateKey: 'followup:activity',
      dedupeKey: 'followup:activity:event-1',
    });
    expect(h.audits).toEqual([
      {
        familyId: FAM_A,
        actionTaken: 'followup_activity_asked',
        targetTable: 'family_events',
        targetId: 'event-1',
        after: { startsAt: activity().startsAt.toISOString() },
      },
    ]);
  });

  /**
   * A private item gets NO follow-up rather than a genericized one. "How was an
   * appointment?" is a question that discloses that SOMETHING private happened while
   * being useless to answer — and for a 13+ child it would be Hale volunteering the
   * existence of their calendar to a parent, unprompted, which is precisely what rule #1
   * forbids. Both routes into `isPrivateEvent` are checked, because the age gate and the
   * sensitive flag are independent floors.
   */
  it.each([
    ['a health-flagged placement', activity({ sensitive: true })],
    [
      "a 13+ child's placement",
      activity({ childId: 'teen-1', title: 'Orthodontist' }),
    ],
  ])('sends nothing about %s, and names the skip', async (_label, event) => {
    const h = harness({
      activities: { [FAM_A]: [event] },
      children: {
        [FAM_A]: [toddler(), toddler({ id: 'teen-1', name: 'Ari', dateOfBirth: '2010-04-02' })],
      },
    });

    const result = await runFollowupSweep(DB, h.deps, NOW);

    expect(result).toMatchObject({
      activityAsked: 0,
      skipped: expect.objectContaining({ private_item: 1 }),
    });
    expect(h.transport.bodies()).toEqual([]);
  });
});

describe('the rails every follow-up rides', () => {
  /**
   * One follow-up per family per day, and the intro one wins. Nothing in this file
   * implements that precedence: the intro stage simply runs first, its send consumes the
   * family's single daily slot in `PROACTIVE_CAP`, and the activity ask is held by the
   * gate on the way out.
   */
  it('gives the day to the intro ask and holds the activity ask behind the cap', async () => {
    const h = harness({ intros: [PAIR], activities: { [FAM_A]: [activity()] } });

    const result = await runFollowupSweep(DB, h.deps, NOW);

    expect(result.introAsked).toBe(2);
    expect(result.activityAsked).toBe(0);
    expect(result.held.frequency_cap).toBe(1);
    expect(h.transport.bodies()).toEqual([INTRO_FOLLOWUP_ASK, INTRO_FOLLOWUP_ASK]);
  });

  it('defers rather than texting a parent inside their quiet hours', async () => {
    const h = harness({ activities: { [FAM_A]: [activity()] }, timeZone: QUIET_ZONE });

    const result = await runFollowupSweep(DB, h.deps, NOW);

    expect(result.held.quiet_hours).toBe(1);
    expect(result.activityAsked).toBe(0);
    expect(h.transport.bodies()).toEqual([]);
    // Deferred, not consumed: nothing claimed the key, so the morning tick asks.
    expect(h.recorded).toEqual([]);
  });
});

/**
 * The windows are the feature's backfill guard, and they are the one piece of it that a
 * dep-injected test cannot see (the predicate lives in SQL). Exporting the arithmetic and
 * pinning it here is what keeps the SQL and the intent on one number.
 */
describe('the due windows', () => {
  it('opens the intro ask three days after the introduction and shuts it at ten', () => {
    const { earliest, latest } = introFollowupWindow(NOW);

    expect(latest).toEqual(new Date(NOW.getTime() - INTRO_FOLLOWUP_MIN_AGE_DAYS * DAY_MS));
    expect(earliest).toEqual(new Date(NOW.getTime() - INTRO_FOLLOWUP_MAX_AGE_DAYS * DAY_MS));
  });

  it('opens the activity ask a day after the start and shuts it at two', () => {
    const { earliest, latest } = activityFollowupWindow(NOW);

    expect(latest).toEqual(new Date(NOW.getTime() - ACTIVITY_FOLLOWUP_MIN_AGE_DAYS * DAY_MS));
    expect(earliest).toEqual(new Date(NOW.getTime() - ACTIVITY_FOLLOWUP_MAX_AGE_DAYS * DAY_MS));
  });

  /** A ceiling that is not below the floor is the whole point: without it the first tick
   * after launch texts every family ever introduced, none of which carries a claim. */
  it('keeps every ceiling strictly older than its floor', () => {
    expect(INTRO_FOLLOWUP_MAX_AGE_DAYS).toBeGreaterThan(INTRO_FOLLOWUP_MIN_AGE_DAYS);
    expect(ACTIVITY_FOLLOWUP_MAX_AGE_DAYS).toBeGreaterThan(ACTIVITY_FOLLOWUP_MIN_AGE_DAYS);
  });
});
