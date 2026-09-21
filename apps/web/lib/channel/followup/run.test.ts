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
  daycareFollowupWindow,
  introFollowupWindow,
  runFollowupSweep,
} from './run';
import { WEEKDAY_CARE_ENABLED_ENV } from '~/lib/care/weekday';
import type { DaycareSubject, WeekdayCareFact } from '~/lib/care/weekday';
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
  if (request.kind === 'intro') {
    return 'Did you end up connecting with the other family? No pressure either way.';
  }
  if (request.kind === 'daycare') {
    return request.provider === null
      ? 'How is daycare going? No pressure to reply.'
      : `How is ${request.provider} going? No pressure to reply.`;
  }
  return `How was ${request.activity}? No pressure to reply.`;
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
    ref: { table: 'family_events', id: 'event-1' },
    familyId: FAM_A,
    parentUserId: `user-${FAM_A}`,
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
    /** VIL-360 · the daycare answers in the window, superseded ones included. */
    daycareSubjects?: Record<string, DaycareSubject[]>;
    /** ...and what is LIVE now, which is how `care_changed` becomes visible. */
    weekdayCare?: Record<string, WeekdayCareFact[]>;
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
    loadDueActivities: async (_db, fam) => overrides.activities?.[fam.familyId] ?? [],
    loadDaycareSubjects: async (_db, familyId) => overrides.daycareSubjects?.[familyId] ?? [],
    loadWeekdayCare: async (_db, familyId) =>
      overrides.weekdayCare?.[familyId] ??
      (overrides.daycareSubjects?.[familyId] ?? []).map((subject) => ({
        factId: subject.factId,
        childId: subject.childId,
        care: 'daycare' as const,
        provider: subject.provider,
        validFrom: subject.validFrom,
      })),
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
  delete process.env[WEEKDAY_CARE_ENABLED_ENV];
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
        [FAM_B]: [
          activity({
            familyId: FAM_B,
            parentUserId: `user-${FAM_B}`,
            ref: { table: 'family_events', id: 'event-2' },
          }),
        ],
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

/**
 * VIL-360 · stage 3 — "how is it going?", days after a parent said their child had
 * started daycare.
 *
 * Once per child ever, so the two things that matter most are the refusals: a household
 * whose answer has MOVED ON since the window opened must not be asked, and the ask must
 * never go twice.
 */
describe('the daycare follow-up', () => {
  const CHILD = 'child-mia';
  /** Five days before NOW - inside the 3-to-10-day window. */
  const SAID_AT = new Date(NOW.getTime() - 5 * 24 * 3_600_000);

  function subject(overrides: Partial<DaycareSubject> = {}): DaycareSubject {
    return {
      factId: 'fact-1',
      childId: CHILD,
      provider: 'Little Sprouts',
      validFrom: SAID_AT,
      ...overrides,
    };
  }

  function armed(overrides: Parameters<typeof harness>[0] = {}) {
    process.env[WEEKDAY_CARE_ENABLED_ENV] = 'true';
    return harness({ families: [family(FAM_A)], ...overrides });
  }

  it('asks once, naming the place the parent named', async () => {
    const h = armed({ daycareSubjects: { [FAM_A]: [subject()] } });

    const result = await runFollowupSweep(DB, h.deps, NOW);

    expect(result.daycareAsked).toBe(1);
    expect(h.transport.bodies()[0]).toContain('Little Sprouts');
    expect(h.recorded[0]).toMatchObject({
      templateKey: 'followup:daycare',
      dedupeKey: `followup:daycare:${CHILD}`,
    });
    // The trail points at the fact it asked about and carries neither the provider nor
    // the child (rule #1).
    const trail = h.audits.find((row) => row.actionTaken === 'followup_daycare_asked');
    expect(trail?.targetId).toBe('fact-1');
    expect(JSON.stringify(trail?.after)).not.toContain('Little Sprouts');
  });

  it('asks generically when no provider was captured, and invents none', async () => {
    const h = armed({ daycareSubjects: { [FAM_A]: [subject({ provider: null })] } });

    await runFollowupSweep(DB, h.deps, NOW);

    expect(h.transport.bodies()[0]).toContain('daycare');
    expect(h.transport.bodies()[0]).not.toContain('Little Sprouts');
  });

  it('never asks twice - the key carries no date', async () => {
    const h = armed({ daycareSubjects: { [FAM_A]: [subject()] } });

    await runFollowupSweep(DB, h.deps, NOW);
    const again = await runFollowupSweep(DB, h.deps, new Date(NOW.getTime() + 86_400_000));

    expect(again.daycareAsked).toBe(0);
    expect(again.skipped.already_claimed).toBe(1);
  });

  /** THE REFUSAL THIS STAGE EXISTS TO BE ABLE TO NAME. "How is daycare going?" to a
   * household that has just told Hale their child is home again is the worst message
   * this lane could send — and a reader that only saw live rows would drop it in
   * silence rather than count it. */
  it('refuses when the answer moved on, and says why', async () => {
    const h = armed({
      daycareSubjects: { [FAM_A]: [subject()] },
      weekdayCare: {
        [FAM_A]: [
          { factId: 'fact-2', childId: CHILD, care: 'home', provider: null, validFrom: NOW },
        ],
      },
    });

    const result = await runFollowupSweep(DB, h.deps, NOW);

    expect(result.daycareAsked).toBe(0);
    expect(result.skipped.care_changed).toBe(1);
    expect(h.transport.bodies()).toEqual([]);
  });

  /**
   * THE SAME REFUSAL, ON THE ANSWER THAT MOVES MOST OFTEN. A family that changes
   * daycare has said `daycare` twice, so a check that compared the care VALUE saw no
   * change and asked - "How is Little Sprouts going?" about the place the parent had
   * just said their child LEFT, spending the once-per-child key on it forever. The
   * subject is superseded when the live row is a DIFFERENT ROW, not when its word
   * changed.
   */
  it('refuses when a newer answer superseded the one whose window opened', async () => {
    const h = armed({
      daycareSubjects: { [FAM_A]: [subject()] },
      weekdayCare: {
        [FAM_A]: [
          {
            factId: 'fact-2',
            childId: CHILD,
            care: 'daycare',
            provider: 'Bright Horizons',
            validFrom: NOW,
          },
        ],
      },
    });

    const result = await runFollowupSweep(DB, h.deps, NOW);

    expect(result.daycareAsked).toBe(0);
    expect(result.skipped.care_changed).toBe(1);
    expect(h.transport.bodies()).toEqual([]);
  });

  /** The positive control beside it: the live row IS the subject, so the ask goes. An
   * identity check that refused everything would pass the test above on its own. */
  it('asks when the live row is the very row whose window opened', async () => {
    const h = armed({
      daycareSubjects: { [FAM_A]: [subject()] },
      weekdayCare: {
        [FAM_A]: [
          {
            factId: 'fact-1',
            childId: CHILD,
            care: 'daycare',
            provider: 'Little Sprouts',
            validFrom: SAID_AT,
          },
        ],
      },
    });

    const result = await runFollowupSweep(DB, h.deps, NOW);

    expect(result.daycareAsked).toBe(1);
    expect(h.transport.bodies()[0]).toContain('Little Sprouts');
  });

  /**
   * THE FLAG IS STRICT, AND THIS IS THE VALUE THAT MAKES IT MATTER. `vercel env add`
   * from a piped `echo` stores a TRAILING NEWLINE, so a var that prints as `true` is
   * really `'true\n'` — and a truthiness check would read that as ON and start texting
   * households a dark feature. The positive control is every other case in this block,
   * which sets the same var to `'true'` and gets an ask.
   */
  it('stays dark for a flag value that only looks like true', async () => {
    const h = armed({ daycareSubjects: { [FAM_A]: [subject()] } });
    process.env[WEEKDAY_CARE_ENABLED_ENV] = 'true\n';

    const result = await runFollowupSweep(DB, h.deps, NOW);

    expect(result.daycareAsked).toBe(0);
    expect(h.transport.bodies()).toEqual([]);
  });

  it('a home answer never produces a follow-up at all', async () => {
    // No daycare subject, because the reader only returns daycare answers - the
    // positive control is every case above, which uses the identical harness.
    const h = armed({ daycareSubjects: { [FAM_A]: [] } });

    const result = await runFollowupSweep(DB, h.deps, NOW);

    expect(result.daycareAsked).toBe(0);
    expect(h.transport.bodies()).toEqual([]);
  });

  it('counts a subject that aged out, once, rather than dropping it', async () => {
    const window = daycareFollowupWindow(NOW);
    const h = armed({
      daycareSubjects: {
        [FAM_A]: [subject({ validFrom: new Date(window.earliest.getTime() - 60_000) })],
      },
    });

    const result = await runFollowupSweep(DB, h.deps, NOW);

    expect(result.skipped.window_passed).toBe(1);
    expect(result.daycareAsked).toBe(0);
  });

  /** The sentence that CREATED this subject said the provider's name, and the scan is
   * inclusive at its lower bound — so an anchor at `validFrom` would screen every ask
   * against the answer that earned it and the follow-up would reach nobody. Found by
   * the journey test; pinned here. */
  it('does not screen itself against the message that created the subject', async () => {
    const h = armed({
      daycareSubjects: { [FAM_A]: [subject()] },
      inbound: { [FAM_A]: ["she's at Little Sprouts now"] },
    });

    const result = await runFollowupSweep(DB, h.deps, NOW);

    expect(result.daycareAsked).toBe(1);
    // ...and the scan it DID run started past that instant.
    expect(h.scans[0]?.[1].getTime()).toBeGreaterThan(SAID_AT.getTime());
  });

  it('does not ask a family that already told Hale how it is going', async () => {
    const h = armed({
      daycareSubjects: { [FAM_A]: [subject()] },
      inbound: { [FAM_A]: ['drop off was rough again this morning'] },
    });

    const result = await runFollowupSweep(DB, h.deps, NOW);

    expect(result.daycareAsked).toBe(0);
    expect(result.skipped.already_discussed).toBe(1);
  });

  it('leaves the claim unspent when the voice defers', async () => {
    const h = armed({ daycareSubjects: { [FAM_A]: [subject()] }, voiceDefers: 'model_failed' });

    const first = await runFollowupSweep(DB, h.deps, NOW);
    expect(first.composeDeferred).toBe(1);
    expect(h.recorded).toEqual([]);

    // The next tick composes again, because nothing was claimed.
    const h2 = armed({ daycareSubjects: { [FAM_A]: [subject()] } });
    expect((await runFollowupSweep(DB, h2.deps, NOW)).daycareAsked).toBe(1);
  });

  it('is dark until its own flag is set', async () => {
    const h = harness({
      families: [family(FAM_A)],
      daycareSubjects: { [FAM_A]: [subject()] },
    });

    const result = await runFollowupSweep(DB, h.deps, NOW);

    expect(result.daycareAsked).toBe(0);
    expect(h.transport.bodies()).toEqual([]);
  });
});
