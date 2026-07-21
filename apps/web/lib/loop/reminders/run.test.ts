import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReminderStatus, SuppressReason } from './schedule';
import {
  type ChannelSendJob,
  type DueReminder,
  type LiveEvent,
  type ReminderParent,
  type ReminderRunDeps,
  runReminderCron,
} from './run';

/**
 * VIL-223 · D1 — the hourly reminder run over the pure core. Injected FAKE deps (no
 * DB) + an injected clock, mirroring send.test.ts. Every expectation is derived from
 * the spec: the check-at-send trust gate (a cancelled/gone/moved event NEVER enqueues),
 * the same-evening T-24h batch, the glanceable link-less T-1h, and the compose-not-send
 * LOOP_SEND_ENABLED gate.
 */

const TZ = 'America/Toronto';
// A 10:00 EDT event: startsAt 14:00Z, its T-1h fire moment 13:00Z.
const SUMMER_START = new Date('2026-07-25T14:00:00Z');
const T1H_FIRE = new Date('2026-07-25T13:00:00Z');
const NOW_T1H = new Date('2026-07-25T13:00:00Z');

function dueRow(over: Partial<DueReminder> = {}): DueReminder {
  return {
    id: 'r1',
    familyId: 'fam-1',
    eventRef: 'e1',
    parentUserId: 'p1',
    offset: '-PT1H',
    fireAt: T1H_FIRE,
    timezone: TZ,
    ...over,
  };
}

function liveEvent(over: Partial<LiveEvent> = {}): LiveEvent {
  return {
    id: 'e1',
    startsAt: SUMMER_START,
    deletedAt: null,
    title: 'Checkup',
    childId: 'c1',
    ...over,
  };
}

function makeDeps(over: Partial<ReminderRunDeps> = {}) {
  const enqueued: ChannelSendJob[] = [];
  const marked: { id: string; status: ReminderStatus; reason: SuppressReason | null }[] = [];
  const reanchored: { id: string; fireAt: Date }[] = [];
  const upserts: { eventRef: string; parentUserId: string; offset: string; fireAt: Date }[] = [];
  const captured: { event: string; distinctId: string; props: Record<string, unknown> }[] = [];

  const deps: ReminderRunDeps = {
    selectReminderParents: async () => [],
    loadHorizonEvents: async () => [],
    upsertReminder: async (_db, row) => {
      upserts.push({
        eventRef: row.eventRef,
        parentUserId: row.parentUserId,
        offset: row.offset,
        fireAt: row.fireAt,
      });
    },
    cancelDeletedEventReminders: async () => {},
    loadDueReminders: async () => [],
    loadEvent: async () => null,
    recentInteraction: async () => false,
    markStatus: async (_db, id, status, reason) => {
      marked.push({ id, status, reason });
    },
    reanchor: async (_db, id, fireAt) => {
      reanchored.push({ id, fireAt });
    },
    loadChildren: async () => [
      { id: 'c1', name: 'Maya', dateOfBirth: '2021-01-01', gender: 'girl' },
    ],
    enqueue: async (job) => {
      enqueued.push(job);
    },
    capture: async (event, distinctId, props = {}) => {
      captured.push({ event, distinctId, props });
    },
    ...over,
  };
  return { deps, enqueued, marked, reanchored, upserts, captured };
}

describe('runReminderCron — Phase A converge', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('upserts one reminder per parent×event×offset with the computed fire_at', async () => {
    const parent: ReminderParent = { familyId: 'fam-1', userId: 'p1', timezone: TZ };
    const { deps, upserts } = makeDeps({
      selectReminderParents: async () => [parent],
      loadHorizonEvents: async () => [liveEvent()],
    });
    const result = await runReminderCron({} as never, deps, new Date('2026-07-20T12:00:00Z'));

    expect(upserts.map((u) => u.offset)).toEqual(['-P1D', '-PT1H']);
    // T-1h fire = startsAt − 1h; T-24h fire = 18:00 EDT the day before = 22:00Z.
    expect(upserts.find((u) => u.offset === '-PT1H')?.fireAt.toISOString()).toBe(
      '2026-07-25T13:00:00.000Z',
    );
    expect(upserts.find((u) => u.offset === '-P1D')?.fireAt.toISOString()).toBe(
      '2026-07-24T22:00:00.000Z',
    );
    expect(result.converged).toBe(2);
  });
});

describe('runReminderCron — Phase B fire (the check-at-send trust gate)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('NEVER enqueues a due reminder whose live event is soft-deleted — marks it cancelled', async () => {
    // THE trust test: the send is gated on a fresh classify of the LIVE event. A
    // soft-deleted event (deletedAt set) classifies 'cancel' → status cancelled, no send.
    // Remove run.ts's `case 'cancel'` and this event falls through unhandled → marked
    // stays empty → this fails.
    vi.stubEnv('LOOP_SEND_ENABLED', 'true');
    const deleted = liveEvent({ deletedAt: new Date('2026-07-24T09:00:00Z') });
    const { deps, enqueued, marked } = makeDeps({
      loadDueReminders: async () => [dueRow()],
      loadEvent: async () => deleted,
    });
    const result = await runReminderCron({} as never, deps, NOW_T1H);

    expect(enqueued).toHaveLength(0);
    expect(marked).toEqual([{ id: 'r1', status: 'cancelled', reason: null }]);
    expect(result).toMatchObject({ due: 1, fired: 0, cancelled: 1 });
  });

  it('NEVER enqueues a due reminder whose event no longer exists — marks it cancelled', async () => {
    vi.stubEnv('LOOP_SEND_ENABLED', 'true');
    const { deps, enqueued, marked } = makeDeps({
      loadDueReminders: async () => [dueRow()],
      loadEvent: async () => null,
    });
    const result = await runReminderCron({} as never, deps, NOW_T1H);

    expect(enqueued).toHaveLength(0);
    expect(marked).toEqual([{ id: 'r1', status: 'cancelled', reason: null }]);
    expect(result).toMatchObject({ due: 1, cancelled: 1 });
  });

  it('re-anchors (does NOT enqueue) a due reminder whose event moved', async () => {
    vi.stubEnv('LOOP_SEND_ENABLED', 'true');
    // The row's fire_at is for the old time; the live event moved a day later, so its
    // recomputed T-1h fire_at no longer matches → stale → reanchor, no send this tick.
    const moved = liveEvent({ startsAt: new Date('2026-07-26T14:00:00Z') });
    const { deps, enqueued, marked, reanchored } = makeDeps({
      loadDueReminders: async () => [dueRow()],
      loadEvent: async () => moved,
    });
    const result = await runReminderCron({} as never, deps, NOW_T1H);

    expect(enqueued).toHaveLength(0);
    expect(marked).toHaveLength(0);
    expect(reanchored).toEqual([{ id: 'r1', fireAt: new Date('2026-07-26T13:00:00Z') }]);
    expect(result).toMatchObject({ fired: 0 });
  });

  it('routes a suppress decision to suppressed status (started, and missed)', async () => {
    vi.stubEnv('LOOP_SEND_ENABLED', 'true');
    // started: the event has already begun (startsAt ≤ now).
    {
      const started = liveEvent({ startsAt: new Date('2026-07-25T13:00:00Z') });
      const { deps, enqueued, marked } = makeDeps({
        loadDueReminders: async () => [dueRow({ fireAt: new Date('2026-07-25T12:00:00Z') })],
        loadEvent: async () => started,
      });
      const result = await runReminderCron({} as never, deps, new Date('2026-07-25T13:00:00Z'));
      expect(marked).toEqual([{ id: 'r1', status: 'suppressed', reason: 'started' }]);
      expect(enqueued).toHaveLength(0);
      expect(result).toMatchObject({ suppressed: 1, fired: 0 });
    }
    // missed: the T-24h slot passed by more than the grace, event not yet started.
    {
      const { deps, enqueued, marked } = makeDeps({
        loadDueReminders: async () => [
          dueRow({ offset: '-P1D', fireAt: new Date('2026-07-24T22:00:00Z') }),
        ],
        loadEvent: async () => liveEvent(),
      });
      const result = await runReminderCron({} as never, deps, new Date('2026-07-25T02:00:00Z'));
      expect(marked).toEqual([{ id: 'r1', status: 'suppressed', reason: 'missed' }]);
      expect(enqueued).toHaveLength(0);
      expect(result).toMatchObject({ suppressed: 1 });
    }
  });
});

describe('runReminderCron — batching + compose-not-send', () => {
  afterEach(() => vi.unstubAllEnvs());

  it("merges a parent's two same-evening T-24h events into ONE batched job listing both", async () => {
    vi.stubEnv('LOOP_SEND_ENABLED', 'true');
    const EVE = new Date('2026-07-24T22:00:00Z'); // 18:00 EDT on 07-24
    const NOW_EVE = new Date('2026-07-24T22:30:00Z'); // 30m into the slot, both events future
    const events = new Map<string, LiveEvent>([
      [
        'e1',
        {
          id: 'e1',
          startsAt: new Date('2026-07-25T14:00:00Z'),
          deletedAt: null,
          title: 'Checkup',
          childId: 'c1',
        },
      ],
      [
        'e2',
        {
          id: 'e2',
          startsAt: new Date('2026-07-25T18:00:00Z'),
          deletedAt: null,
          title: 'Swim',
          childId: 'c2',
        },
      ],
    ]);
    const { deps, enqueued, marked, captured } = makeDeps({
      loadDueReminders: async () => [
        dueRow({ id: 'r1', eventRef: 'e1', offset: '-P1D', fireAt: EVE }),
        dueRow({ id: 'r2', eventRef: 'e2', offset: '-P1D', fireAt: EVE }),
      ],
      loadEvent: async (_db, ref) => events.get(ref) ?? null,
    });
    const result = await runReminderCron({} as never, deps, NOW_EVE);

    expect(enqueued).toHaveLength(1);
    const job = enqueued[0];
    expect(job).toMatchObject({
      templateKey: 'reminder',
      category: 'reminder',
      urgency: 'normal',
      parentUserId: 'p1',
      dedupeKey: 'reminder:-P1D:p1:2026-07-24',
    });
    const payload = job?.payload as Record<string, unknown>;
    expect(payload.offset).toBe('-P1D');
    expect(payload.deepLink).toMatch(/\/plan$/);
    expect((payload.events as { eventRef: string }[]).map((e) => e.eventRef)).toEqual(['e1', 'e2']);
    // Both merged rows are marked sent; telemetry is coarse (offset + count).
    expect(marked).toEqual([
      { id: 'r1', status: 'sent', reason: null },
      { id: 'r2', status: 'sent', reason: null },
    ]);
    expect(captured).toEqual([
      { event: 'reminder_sent', distinctId: 'p1', props: { offset: '-P1D', events: 2 } },
    ]);
    expect(result).toMatchObject({ fired: 2 });
  });

  it('fires a T-1h reminder as its own job with NO deep link, marks sent + captures (flag on)', async () => {
    vi.stubEnv('LOOP_SEND_ENABLED', 'true');
    const { deps, enqueued, marked, captured } = makeDeps({
      loadDueReminders: async () => [dueRow()],
      loadEvent: async () => liveEvent(),
    });
    const result = await runReminderCron({} as never, deps, NOW_T1H);

    expect(enqueued).toHaveLength(1);
    const job = enqueued[0];
    expect(job).toMatchObject({
      category: 'reminder',
      urgency: 'time_sensitive',
      dedupeKey: 'reminder:-PT1H:p1:e1',
    });
    const payload = job?.payload as Record<string, unknown>;
    expect(payload.deepLink).toBeNull();
    expect((payload.events as unknown[]).length).toBe(1);
    expect(marked).toEqual([{ id: 'r1', status: 'sent', reason: null }]);
    expect(captured).toEqual([
      { event: 'reminder_sent', distinctId: 'p1', props: { offset: '-PT1H', events: 1 } },
    ]);
    expect(result).toMatchObject({ due: 1, fired: 1 });
  });

  it('compose-not-send: LOOP_SEND_ENABLED off → nothing enqueued, nothing marked sent', async () => {
    vi.stubEnv('LOOP_SEND_ENABLED', '');
    const { deps, enqueued, marked, captured } = makeDeps({
      loadDueReminders: async () => [dueRow()],
      loadEvent: async () => liveEvent(),
    });
    const result = await runReminderCron({} as never, deps, NOW_T1H);

    expect(enqueued).toHaveLength(0);
    expect(marked).toHaveLength(0); // the fire row stays 'scheduled'
    expect(captured).toHaveLength(0);
    expect(result).toMatchObject({ due: 1, fired: 0, sendEnabled: false });
  });
});
