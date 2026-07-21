import type { schema } from '@hale/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LOOP_PREFS } from '~/lib/loop/prefs';
import {
  type ChannelSendJob,
  type SendParentRow,
  type SundaySendDeps,
  isSendMoment,
  runSundaySendCron,
} from './send';

/**
 * VIL-218 · B2 Sunday send job. Deterministic → plain Vitest with injected deps +
 * clock. Proves: the local send-moment selection (DST-safe), the compose-not-send
 * LOOP_SEND_ENABLED gate, the family:week:parent dedupe key, no-plan skipping, and
 * the payload assembled from the artifact + children.
 */

// DEFAULT_LOOP_PREFS.weeklyPlanSendTime is 19:30:00; weekStartDay=1 (Mon) → send Sun.
// 2026-01-18 and 2026-07-19 are both Sundays (EST/PST winter, EDT/PDT summer).

describe('isSendMoment — the local send weekday + time, one-hour slot, DST-safe', () => {
  const view = { ...DEFAULT_LOOP_PREFS };

  it('matches each parent at their own local Sunday 19:30, winter and summer', () => {
    // Toronto EST (UTC-5): Sun 19:30 local = Mon 00:30Z.
    expect(isSendMoment(view, new Date('2026-01-19T00:30:00Z'), 'America/Toronto', 1)).toBe(true);
    // Vancouver PST (UTC-8): Sun 19:30 local = Mon 03:30Z.
    expect(isSendMoment(view, new Date('2026-01-19T03:30:00Z'), 'America/Vancouver', 1)).toBe(true);
    // Toronto EDT (UTC-4) summer: Sun 19:30 local = Sun 23:30Z.
    expect(isSendMoment(view, new Date('2026-07-19T23:30:00Z'), 'America/Toronto', 1)).toBe(true);
  });

  it('holds the one-hour slot open (19:30–20:29 local) and closes it after', () => {
    expect(isSendMoment(view, new Date('2026-01-19T01:29:00Z'), 'America/Toronto', 1)).toBe(true); // 20:29
    expect(isSendMoment(view, new Date('2026-01-19T01:30:00Z'), 'America/Toronto', 1)).toBe(false); // 20:30
    expect(isSendMoment(view, new Date('2026-01-19T00:29:00Z'), 'America/Toronto', 1)).toBe(false); // 19:29
  });

  it('does not match the wrong weekday', () => {
    // Saturday 19:30 Toronto (2026-01-17 is a Saturday) with a Monday-start week.
    expect(isSendMoment(view, new Date('2026-01-18T00:30:00Z'), 'America/Toronto', 1)).toBe(false);
  });

  it('sends Saturday for a Sunday-start week (weekStartDay=0)', () => {
    // weekStartDay 0 → send weekday = Saturday. 2026-01-17 is a Saturday.
    expect(isSendMoment(view, new Date('2026-01-18T00:30:00Z'), 'America/Toronto', 0)).toBe(true);
  });
});

describe('runSundaySendCron', () => {
  afterEach(() => vi.unstubAllEnvs());

  const parent: SendParentRow = {
    familyId: 'fam-1',
    userId: 'u1',
    timezone: 'America/Toronto',
    weekStartDay: 1,
    view: { ...DEFAULT_LOOP_PREFS },
  };

  const plan = {
    id: 'wp-1',
    familyId: 'fam-1',
    weekStart: '2026-01-12',
    composedAt: new Date(),
    summary: 'A calm week.',
    items: [
      { kind: 'appointment', title: 'Maya — checkup', childIds: ['c1'], startsAt: '2026-01-14T10:00', endsAt: null, location: null, sourceRef: null, needs: 'calendar_add', privacySensitive: true },
      { kind: 'village', title: 'Storytime', childIds: [], startsAt: '2026-01-17T10:30', endsAt: null, location: null, sourceRef: null, needs: 'none', privacySensitive: false },
    ],
    status: 'composed',
  } as unknown as schema.WeekPlan;

  function makeDeps(over: Partial<SundaySendDeps> = {}) {
    const enqueued: ChannelSendJob[] = [];
    const captured: { event: string; distinctId: string }[] = [];
    let readPlanWeekStart = '';
    const deps: SundaySendDeps = {
      selectParents: async () => [parent],
      readPlan: async (_db, _familyId, weekStart) => {
        readPlanWeekStart = weekStart;
        return plan;
      },
      loadChildren: async () => [
        { id: 'c1', name: 'Maya', dateOfBirth: '2021-01-01', gender: 'girl' },
      ],
      enqueue: async (job) => {
        enqueued.push(job);
      },
      capture: async (event, distinctId) => {
        captured.push({ event, distinctId });
      },
      ...over,
    };
    return { deps, enqueued, captured, weekStartOf: () => readPlanWeekStart };
  }

  const NOW = new Date('2026-01-19T00:30:00Z'); // Sun 19:30 Toronto

  it('enqueues one weekly_plan job per matching parent when LOOP_SEND_ENABLED is on', async () => {
    vi.stubEnv('LOOP_SEND_ENABLED', 'true');
    const { deps, enqueued, captured, weekStartOf } = makeDeps();
    const result = await runSundaySendCron({} as never, deps, NOW);

    expect(result).toMatchObject({ matched: 1, enqueued: 1, skippedNoPlan: 0, sendEnabled: true });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      templateKey: 'weekly_plan',
      familyId: 'fam-1',
      parentUserId: 'u1',
      category: 'weekly_plan',
      dedupeKey: `fam-1:${weekStartOf()}:u1`,
    });
    // Payload carries the artifact items + loaded children + deep link.
    const payload = enqueued[0]?.payload as Record<string, unknown>;
    expect((payload.items as unknown[]).length).toBe(2);
    expect((payload.children as { name: string }[])[0]?.name).toBe('Maya');
    expect(payload.deepLink).toMatch(/\/plan$/);
    expect(captured).toEqual([{ event: 'loop_plan_sent', distinctId: 'u1' }]);
  });

  it('compose-not-send: enqueues NOTHING when LOOP_SEND_ENABLED is off (default)', async () => {
    vi.stubEnv('LOOP_SEND_ENABLED', '');
    const { deps, enqueued, captured } = makeDeps();
    const result = await runSundaySendCron({} as never, deps, NOW);

    expect(result).toMatchObject({ matched: 1, enqueued: 0, sendEnabled: false });
    expect(enqueued).toHaveLength(0);
    expect(captured).toHaveLength(0);
  });

  it('skips a matched parent whose family has no composed plan for the week', async () => {
    vi.stubEnv('LOOP_SEND_ENABLED', 'true');
    const { deps, enqueued } = makeDeps({ readPlan: async () => null });
    const result = await runSundaySendCron({} as never, deps, NOW);

    expect(result).toMatchObject({ matched: 1, enqueued: 0, skippedNoPlan: 1 });
    expect(enqueued).toHaveLength(0);
  });

  it('dedupe key is family:weekStart:parent (A2 suffixes it per channel)', async () => {
    vi.stubEnv('LOOP_SEND_ENABLED', 'true');
    const { deps, enqueued, weekStartOf } = makeDeps();
    await runSundaySendCron({} as never, deps, NOW);
    expect(enqueued[0]?.dedupeKey).toBe(`fam-1:${weekStartOf()}:u1`);
    expect(weekStartOf()).toBe('2026-01-12'); // Monday of the current week (not Sun-start)
  });
});
