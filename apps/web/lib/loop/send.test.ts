import { type Database, schema } from '@hale/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LOOP_PREFS } from '~/lib/loop/prefs';
import {
  type ChannelSendJob,
  type SendParentRow,
  type SundaySendDeps,
  isSendMoment,
  runSundaySendCron,
  selectParentsToSend,
} from './send';

/**
 * VIL-218 · B2 Sunday send job. Deterministic → plain Vitest with injected deps +
 * clock. Proves: the local send-moment selection (DST-safe), the compose-not-send
 * LOOP_SEND_ENABLED gate, the family:week:parent dedupe key, no-plan skipping, and
 * the payload assembled from the artifact + children.
 */

// DEFAULT_LOOP_PREFS.weeklyPlanSendTime is 08:00:00; weekStartDay=1 (Mon) → send Mon.
// 2026-01-19 and 2026-07-20 are both Mondays (EST/PST winter, EDT/PDT summer).

describe('isSendMoment — the local send weekday + time, one-hour slot, DST-safe', () => {
  const view = { ...DEFAULT_LOOP_PREFS };

  it('matches each parent at their own local Monday 08:00, winter and summer', () => {
    // Toronto EST (UTC-5): Mon 08:00 local = Mon 13:00Z.
    expect(isSendMoment(view, new Date('2026-01-19T13:00:00Z'), 'America/Toronto', 1)).toBe(true);
    // Vancouver PST (UTC-8): Mon 08:00 local = Mon 16:00Z.
    expect(isSendMoment(view, new Date('2026-01-19T16:00:00Z'), 'America/Vancouver', 1)).toBe(true);
    // Toronto EDT (UTC-4) summer: Mon 08:00 local = Mon 12:00Z.
    expect(isSendMoment(view, new Date('2026-07-20T12:00:00Z'), 'America/Toronto', 1)).toBe(true);
  });

  it('holds the one-hour slot open (08:00–08:59 local) and closes it after', () => {
    expect(isSendMoment(view, new Date('2026-01-19T13:59:00Z'), 'America/Toronto', 1)).toBe(true); // 08:59
    expect(isSendMoment(view, new Date('2026-01-19T14:00:00Z'), 'America/Toronto', 1)).toBe(false); // 09:00
    expect(isSendMoment(view, new Date('2026-01-19T12:59:00Z'), 'America/Toronto', 1)).toBe(false); // 07:59
  });

  it('does not match the wrong weekday', () => {
    // Sunday 07:00 Toronto (2026-01-18 is a Sunday) with a Monday-start week.
    expect(isSendMoment(view, new Date('2026-01-18T13:00:00Z'), 'America/Toronto', 1)).toBe(false);
  });

  it('sends Sunday morning for a Sunday-start week (weekStartDay=0)', () => {
    // weekStartDay 0 → send weekday = Sunday. 2026-01-18 is a Sunday.
    expect(isSendMoment(view, new Date('2026-01-18T13:00:00Z'), 'America/Toronto', 0)).toBe(true);
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
      // KEY-STRICT, like the real store: the composer keys the artifact on the
      // week's Monday. NOW is Mon 08:00 Toronto Jan 19 — the brief sends the
      // morning the week starts, so the only findable key is TODAY, 2026-01-19.
      // A wrong-week lookup returns null — this is what catches a mismatched
      // send-vs-compose week key (the first prod probe found that class).
      readPlan: async (_db, _familyId, weekStart) => {
        readPlanWeekStart = weekStart;
        return weekStart === '2026-01-19' ? plan : null;
      },
      loadChildren: async () => [
        { id: 'c1', name: 'Maya', dateOfBirth: '2021-01-01', gender: 'girl' },
      ],
      enqueue: async (job) => {
        enqueued.push(job);
      },
      capture: async (event, distinctId) => {
        captured.push({ event, distinctId });
        return 'sent';
      },
      ...over,
    };
    return { deps, enqueued, captured, weekStartOf: () => readPlanWeekStart };
  }

  const NOW = new Date('2026-01-19T13:00:00Z'); // Mon 08:00 Toronto

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
    // Monday morning of the week the brief opens — the key the composer wrote
    // the artifact under the day before (cron.ts weekWindow offset 1).
    expect(weekStartOf()).toBe('2026-01-19');
  });

  it('keys a Sunday-start parent on the UPCOMING Monday (artifacts are Monday-keyed)', async () => {
    vi.stubEnv('LOOP_SEND_ENABLED', 'true');
    const { deps, weekStartOf } = makeDeps({
      selectParents: async () => [{ ...parent, weekStartDay: 0 }],
    });
    // Sunday-start → their brief sends Sunday 07:00. 2026-01-18 is a Sunday;
    // Toronto EST 07:00 = 12:00Z. Their Sun–Sat week's Monday key is TOMORROW.
    await runSundaySendCron({} as never, deps, new Date('2026-01-18T13:00:00Z'));
    expect(weekStartOf()).toBe('2026-01-19');
  });
});

/**
 * VIL-260 · WS2 — the QR/text cohort. A family provisioned from a text has NO email
 * address (provision.ts stores users.email = null), so an email-channel parent among
 * them has nowhere for the plan to land. That has to be a SELECTION decision: letting
 * them through produces a `failed` channel_messages row every single Sunday, which
 * reads in the ledger and in X1 exactly like a provider outage.
 */
describe('selectParentsToSend — deliverability', () => {
  const MEMBER = {
    familyId: 'fam-1',
    userId: 'u1',
    timezone: 'America/Toronto',
    weekStartDay: 1,
  };

  /** A Drizzle stand-in for the two reads this path makes: the member+user join, and
   * loadLoopPrefsView's per-parent lookup. `where` clauses are not evaluated — the
   * rows handed in ARE the answer. */
  function fakeDb(
    members: Array<typeof MEMBER & { email: string | null }>,
    prefs: Array<Record<string, unknown>>,
  ) {
    return {
      select: () => ({
        from: (table: unknown) =>
          table === schema.loopPrefs
            ? { where: () => ({ limit: async () => prefs }) }
            : { innerJoin: () => ({ where: async () => members }) },
      }),
    } as unknown as Database;
  }

  const NOW = new Date('2026-01-19T13:00:00Z'); // Mon 08:00 Toronto

  it('skips an email-channel parent with no email address', async () => {
    const db = fakeDb([{ ...MEMBER, email: null }], [{ ...DEFAULT_LOOP_PREFS }]);
    expect(await selectParentsToSend(db, NOW)).toEqual([]);
  });

  it('still selects that parent once their channel is one they can be reached on', async () => {
    const db = fakeDb(
      [{ ...MEMBER, email: null }],
      [{ ...DEFAULT_LOOP_PREFS, loopChannel: 'sms' }],
    );
    const selected = await selectParentsToSend(db, NOW);
    expect(selected.map((row) => row.userId)).toEqual(['u1']);
  });

  it('selects an email-channel parent who has an address', async () => {
    const db = fakeDb([{ ...MEMBER, email: 'parent@x.com' }], [{ ...DEFAULT_LOOP_PREFS }]);
    const selected = await selectParentsToSend(db, NOW);
    expect(selected.map((row) => row.userId)).toEqual(['u1']);
  });
});
