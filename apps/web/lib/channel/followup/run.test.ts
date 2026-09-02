import type { Database } from '@hale/db';
import { withOptOut } from '~/lib/channel/opt-out';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeTransport } from '~/lib/channel/intake/transport';
import type { OutboundGatePorts } from '~/lib/channel/outbound-gate';
import type { ReminderChild } from '~/lib/loop/templates/reminder/payload';
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
import type { ComposeDeferral, FollowupVoiceRequest } from './voice';

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

/**
 * What the fake voice writes. Deterministic and recognisable, standing in for a real
 * composition — whether the model's actual words are any good is measured against real
 * cached Claude in apps/worker/evals/run-followup-voice-eval.mjs (rule #8), and whether
 * the composer recomposes and defers correctly is proved in voice.test.ts. What these
 * tests own is what the SWEEP does with each outcome.
 */
function composedAsk(request: FollowupVoiceRequest): string {
  return request.kind === 'intro'
    ? 'Did you end up connecting with the other family? No pressure either way.'
    : `How was ${request.activity}? No pressure to reply.`;
}

const INTRO_ASK = composedAsk({ kind: 'intro' });

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

const PAIR: DueIntro = {
  proposalId: 'prop-1',
  familyAId: FAM_A,
  familyBId: FAM_B,
  introducedAt: new Date(NOW.getTime() - 3.5 * DAY_MS),
};

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
  /** Every told-anywhere scan this run performed, as [familyId, since]. */
  scans: Array<[string, Date]>;
  /** Every ask that landed in the parent's own text thread (lib/channel/thread.ts). */
  threaded: Array<{ familyId: string; parentUserId: string; body: string }>;
}

/**
 * The harness deliberately wires the ledger to itself: `dedupeActive` and the gate's
 * `countProactiveSends` both read the sends this run actually recorded.
 *
 * That is what makes the two rails testable as MECHANISMS rather than as stubs. A second
 * tick is a second `runFollowupSweep` against the same harness, so "does not re-send" is
 * proved by the same key the production ledger would hold; and the one-per-family-per-day
 * rail is proved by the real `PROACTIVE_CAP` arithmetic counting a send this sweep just
 * made, not by a fake that was told to say no.
 */
function harness(
  overrides: {
    families?: FollowupFamily[];
    intros?: DueIntro[];
    discoverable?: Set<string>;
    activities?: Record<string, DueActivity[]>;
    children?: Record<string, ReminderChild[]>;
    inbound?: Record<string, string[]>;
    timeZone?: string;
    voiceDefers?: ComposeDeferral | null;
    /** What the reconciliation gate says about the wire body (VIL-293). Empty is the
     * ordinary answer: a follow-up ASK claims nothing by design. */
    unbacked?: Awaited<ReturnType<FollowupSweepDeps['refuseUnbackedSend']>>;
  } = {},
): Harness {
  const transport = new FakeTransport();
  const recorded: Recorded[] = [];
  const audits: Harness['audits'] = [];
  const scans: Harness['scans'] = [];
  const threaded: Harness['threaded'] = [];
  const families = overrides.families ?? [family(FAM_A), family(FAM_B)];

  const gate: OutboundGatePorts = {
    channelEnrolled: async () => true,
    watchConsentGranted: async () => true,
    // `since` is ignored: every send in a test happens at NOW, so all of them are inside
    // any window the cap asks for.
    countProactiveSends: async (familyId) => recorded.filter((r) => r.familyId === familyId).length,
    proactiveSentSince: async () => true,
    parentTimeZone: async () => overrides.timeZone ?? AWAKE_ZONE,
  };

  const deps: FollowupSweepDeps = {
    refuseUnbackedSend: async () => overrides.unbacked ?? [],
    selectFamilies: async () => families,
    loadDueIntros: async () => overrides.intros ?? [],
    discoverableUserIds: async (_db, userIds) => overrides.discoverable ?? new Set(userIds),
    loadDueActivities: async (_db, familyId) => overrides.activities?.[familyId] ?? [],
    loadChildren: async (_db, familyId) => overrides.children?.[familyId] ?? [toddler()],
    loadInboundSince: async (_db, familyId, since) => {
      scans.push([familyId, since]);
      return overrides.inbound?.[familyId] ?? [];
    },
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
    threadMessage: async (_db, input) => {
      threaded.push(input);
      return 'conv-1';
    },
    voice: {
      async compose(request) {
        const defer = overrides.voiceDefers;
        return defer ? { status: 'deferred', reason: defer } : { status: 'composed', body: composedAsk(request) };
      },
    },
  };

  return { deps, transport, recorded, audits, scans, threaded };
}

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
    const h = harness({
      activities: {
        [FAM_A]: [activity()],
        [FAM_B]: [activity({ familyId: FAM_B, eventId: 'event-2' })],
      },
    });

    const result = await runFollowupSweep(DB, h.deps, NOW);

    expect(result.enabled).toBe(true);
    expect(h.recorded.map((r) => r.familyId)).toEqual([FAM_A]);
  });
});

describe("the ask in the parent's own thread", () => {
  it('threads every ask it sends, so the answer has an antecedent', async () => {
    // A follow-up is a QUESTION ("how did it go?"), and the reply to it arrives as a
    // coach turn. `channel_messages` stores no body (rule #1), so an unthreaded ask is
    // one the coach reads the answer to with nothing above it.
    const h = harness({ intros: [PAIR] });

    await runFollowupSweep(DB, h.deps, NOW);

    expect(h.threaded).toHaveLength(2);
    expect(h.threaded.map((t) => t.familyId)).toEqual([FAM_A, FAM_B]);
    expect(h.threaded[0]?.body).toBe(INTRO_ASK);
  });

  it('threads the composed ask, never the CASL footer on the wire', async () => {
    const h = harness({ intros: [PAIR] });

    await runFollowupSweep(DB, h.deps, NOW);

    expect(h.transport.bodies()[0]).toBe(withOptOut(INTRO_ASK, 'short'));
    expect(h.threaded[0]?.body).not.toMatch(/STOP/i);
    expect(h.transport.bodies()[0]).toContain(h.threaded[0]?.body ?? ' ');
  });

  it('threads nothing when the voice deferred and no ask went out', async () => {
    // The positive control for the two above: nothing sent, nothing said.
    const h = harness({ intros: [PAIR], voiceDefers: 'client_unavailable' });

    await runFollowupSweep(DB, h.deps, NOW);

    expect(h.transport.bodies()).toEqual([]);
    expect(h.threaded).toEqual([]);
  });
});

describe('the intro follow-up', () => {
  it('asks both families once, claims each side, and audits each send', async () => {
    const h = harness({ intros: [PAIR] });

    const result = await runFollowupSweep(DB, h.deps, NOW);

    expect(result.introAsked).toBe(2);
    expect(h.transport.bodies()).toEqual([
      withOptOut(INTRO_ASK, 'short'),
      withOptOut(INTRO_ASK, 'short'),
    ]);
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

  /**
   * The told-anywhere screen. A parent who has already said how it went does not get
   * asked how it went — the redundancy that reads as nobody listening.
   *
   * Only family A said something, and only family A is spared: the screen is a fact
   * about what THAT household told us, never a property of the pair.
   */
  it('does not ask a family that already said how the intro went', async () => {
    const h = harness({
      intros: [PAIR],
      inbound: { [FAM_A]: ['we met up for coffee, they were lovely'] },
    });

    const result = await runFollowupSweep(DB, h.deps, NOW);

    expect(result.skipped.already_discussed).toBe(1);
    expect(result.introAsked).toBe(1);
    expect(h.recorded.map((r) => r.familyId)).toEqual([FAM_B]);
  });

  /** Scanned from the introduction forward, so what a family said BEFORE they were
   * introduced can never suppress the question about how it went. */
  it('scans only what the family said after the introduction', async () => {
    const h = harness({ intros: [PAIR] });

    await runFollowupSweep(DB, h.deps, NOW);

    expect(h.scans).toEqual([
      [FAM_A, PAIR.introducedAt],
      [FAM_B, PAIR.introducedAt],
    ]);
  });

  it('expires an intro nobody got to in time, and names it', async () => {
    const h = harness({
      intros: [{ ...PAIR, introducedAt: new Date(NOW.getTime() - (INTRO_FOLLOWUP_MAX_AGE_DAYS + 0.02) * DAY_MS) }],
    });

    const result = await runFollowupSweep(DB, h.deps, NOW);

    expect(result.skipped.window_passed).toBe(2);
    expect(h.transport.bodies()).toEqual([]);
  });

  it('skips the whole pair when one side has opted out of intros since', async () => {
    const h = harness({ intros: [PAIR], discoverable: new Set([`user-${FAM_A}`]) });

    const result = await runFollowupSweep(DB, h.deps, NOW);

    expect(result).toMatchObject({
      introAsked: 0,
      skipped: expect.objectContaining({ opted_out: 2 }),
    });
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
    expect(h.transport.bodies()).toEqual([
      withOptOut('How was Swim class? No pressure to reply.', 'short'),
    ]);
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

  /** The parent already reported on it in their own words. Note they never used the
   * title — "storytime" is the one distinctive word, which is all the screen needs. */
  it('does not ask about an activity the parent already reported on', async () => {
    const h = harness({
      activities: { [FAM_A]: [activity({ title: 'Saturday Storytime' })] },
      inbound: { [FAM_A]: ['storytime was packed but she loved it'] },
    });

    const result = await runFollowupSweep(DB, h.deps, NOW);

    expect(result.skipped.already_discussed).toBe(1);
    expect(h.transport.bodies()).toEqual([]);
  });

  it('expires an activity nobody got to in time, and names it', async () => {
    const h = harness({
      activities: {
        [FAM_A]: [
          activity({ startsAt: new Date(NOW.getTime() - (ACTIVITY_FOLLOWUP_MAX_AGE_DAYS + 0.02) * DAY_MS) }),
        ],
      },
    });

    const result = await runFollowupSweep(DB, h.deps, NOW);

    expect(result.skipped.window_passed).toBe(1);
    expect(h.transport.bodies()).toEqual([]);
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
    ["a 13+ child's placement", activity({ childId: 'teen-1', title: 'Orthodontist' })],
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

  /** A private item must not even reach the voice: the model is never handed the title
   * of a teen's or a health item, so there is nothing for it to leak. */
  it('never hands a private item to the composer', async () => {
    const composed: FollowupVoiceRequest[] = [];
    const h = harness({ activities: { [FAM_A]: [activity({ sensitive: true })] } });
    const wrapped = {
      ...h.deps,
      voice: {
        async compose(request: FollowupVoiceRequest) {
          composed.push(request);
          return h.deps.voice.compose(request);
        },
      },
    };

    await runFollowupSweep(DB, wrapped, NOW);

    expect(composed).toEqual([]);
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
    expect(h.transport.bodies()).toEqual([
      withOptOut(INTRO_ASK, 'short'),
      withOptOut(INTRO_ASK, 'short'),
    ]);
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

describe('when the voice has nothing sendable', () => {
  /**
   * The founder doctrine's load-bearing consequence: with no canned line underneath, a
   * composer that cannot produce a sendable ask must leave everything exactly as it
   * found it. Nothing sent, nothing claimed, nothing audited — and the very next tick
   * tries again and succeeds.
   */
  it('sends nothing, claims nothing, and asks again on the next tick', async () => {
    const h = harness({ activities: { [FAM_A]: [activity()] }, voiceDefers: 'gate_exhausted' });

    const deferredRun = await runFollowupSweep(DB, h.deps, NOW);

    expect(deferredRun).toMatchObject({ activityAsked: 0, composeDeferred: 1 });
    expect(h.transport.bodies()).toEqual([]);
    expect(h.recorded).toEqual([]);
    expect(h.audits).toEqual([]);

    const composing = harness({ activities: { [FAM_A]: [activity()] } });
    const retry = await runFollowupSweep(DB, composing.deps, new Date(NOW.getTime() + 3_600_000));

    expect(retry.activityAsked).toBe(1);
    expect(composing.transport.bodies()).toEqual([
      withOptOut('How was Swim class? No pressure to reply.', 'short'),
    ]);
  });

  /**
   * VIL-293. A deferral is the voice having nothing to say; this is the voice saying
   * something untrue. They are counted apart because the fault is in different places —
   * and neither may leave the claim spent.
   */
  it('refuses a composed ask whose wire body claims a row that does not exist', async () => {
    const h = harness({
      activities: { [FAM_A]: [activity()] },
      unbacked: ['no_scheduled_row'],
    });

    const result = await runFollowupSweep(DB, h.deps, NOW);

    expect(result).toMatchObject({ activityAsked: 0, refusedAtSend: 1, composeDeferred: 0 });
    expect(h.transport.bodies()).toEqual([]);
    expect(h.recorded).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  it.each([
    ['no client', 'client_unavailable'],
    ['a deploy without the skill', 'skill_unavailable'],
    ['an upstream outage', 'model_failed'],
  ] as const)('counts a deferral from %s without sending', async (_label, reason) => {
    const h = harness({ intros: [PAIR], voiceDefers: reason });

    const result = await runFollowupSweep(DB, h.deps, NOW);

    expect(result.composeDeferred).toBe(2);
    expect(h.transport.bodies()).toEqual([]);
  });
});

/**
 * The windows are the feature's backfill guard, and they are the one piece of it that a
 * dep-injected test cannot see (the predicate lives in SQL). Exporting the arithmetic and
 * pinning it here is what keeps the SQL and the intent on one number.
 */
describe('the due windows', () => {
  it('opens the intro ask three days after the introduction and shuts it at five', () => {
    const { earliest, latest } = introFollowupWindow(NOW);

    expect(latest).toEqual(new Date(NOW.getTime() - INTRO_FOLLOWUP_MIN_AGE_DAYS * DAY_MS));
    expect(earliest).toEqual(new Date(NOW.getTime() - INTRO_FOLLOWUP_MAX_AGE_DAYS * DAY_MS));
  });

  it('opens the activity ask a day after the start and shuts it at four', () => {
    const { earliest, latest } = activityFollowupWindow(NOW);

    expect(latest).toEqual(new Date(NOW.getTime() - ACTIVITY_FOLLOWUP_MIN_AGE_DAYS * DAY_MS));
    expect(earliest).toEqual(new Date(NOW.getTime() - ACTIVITY_FOLLOWUP_MAX_AGE_DAYS * DAY_MS));
  });

  /** The query reaches one tick PAST the window so a row that has just aged out is seen
   * once and counted, rather than silently ceasing to match. */
  it.each([
    ['intro', introFollowupWindow],
    ['activity', activityFollowupWindow],
  ])('reaches past the %s window so an expiry can be observed', (_label, windowOf) => {
    const { floor, earliest, latest } = windowOf(NOW);

    expect(floor.getTime()).toBeLessThan(earliest.getTime());
    expect(earliest.getTime()).toBeLessThan(latest.getTime());
  });
});
