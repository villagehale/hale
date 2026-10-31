import type { AgentClient } from '@hale/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReminderDraft } from './compose';
import type { ReminderStatus, SuppressReason } from './schedule';

// The model-written text is an injected port (deps.composeText): these tests drive the
// WIRING (what facts it gets, nothing sent when it returns null), not the writing (that
// is compose.test.ts + the cached eval).
const composeText = vi.fn(
  async () => ({ texts: ['Reminder text.'], bold: null }) as ReminderDraft | null,
);
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
// Its T-24h fire moment: 18:00 EDT the day before.
const T1D_FIRE = new Date('2026-07-24T22:00:00Z');

function dueRow(over: Partial<DueReminder> = {}): DueReminder {
  return {
    id: 'r1',
    familyId: 'fam-1',
    eventRef: 'e1',
    parentUserId: 'p1',
    offset: '-PT1H',
    fireAt: T1H_FIRE,
    timezone: TZ,
    // The POSITIVE CONTROL for every caregiver gate added in VIL-241 · M6: these rows are
    // a parent's, and every existing assertion below is the proof the new role gate did
    // not quietly stop the parents' reminders too.
    role: 'primary_parent',
    // Irrelevant to a parent (their leg never consults it) and required so no fake can
    // omit the fact a caregiver's leg turns on.
    smsChannelActive: true,
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
    sensitive: false,
    location: null,
    googleEventId: null,
    createdBy: null,
    ...over,
  };
}

function makeDeps(over: Partial<ReminderRunDeps> = {}) {
  const enqueued: ChannelSendJob[] = [];
  const marked: { id: string; status: ReminderStatus; reason: SuppressReason | null }[] = [];
  const reanchored: { id: string; fireAt: Date }[] = [];
  const upserts: { eventRef: string; parentUserId: string; offset: string; fireAt: Date }[] = [];
  const captured: { event: string; distinctId: string; props: Record<string, unknown> }[] = [];
  const audited: {
    familyId: string;
    reminderId: string;
    offset: string;
    reason: SuppressReason;
  }[] = [];

  const deps: ReminderRunDeps = {
    selectReminderParents: async () => [],
    selectReminderCaregivers: async () => [],
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
    auditSuppressed: async (_db, row) => {
      audited.push(row);
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
      return 'sent';
    },
    client: {} as AgentClient,
    loadLanguage: async () => 'en',
    composeText: composeText as unknown as ReminderRunDeps['composeText'],
    loadNameLevel: async () => 'generic',
    ...over,
  };
  return { deps, enqueued, marked, reanchored, upserts, captured, audited };
}

afterEach(() => {
  composeText.mockReset();
  composeText.mockImplementation(async () => ({ texts: ['Reminder text.'], bold: null }));
});

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

  it('reminds only the calendar owner about a Google mirror, and still reminds the household about a Hale event', async () => {
    const owner = { familyId: 'fam-1', userId: 'p1', timezone: TZ };
    const coparent = { familyId: 'fam-1', userId: 'p2', timezone: TZ };
    const caregiver = {
      familyId: 'fam-1',
      userId: 'g1',
      role: 'nanny' as const,
      timezone: TZ,
      weekStartDay: 0,
    };
    const mirror = liveEvent({
      id: 'gcal-1',
      title: 'Swim',
      googleEventId: 'ev-swim',
      createdBy: 'p1',
      childId: null,
    });
    const hale = liveEvent({ id: 'hale-1', title: 'Checkup', childId: 'c1' });
    vi.stubEnv('PARENT_CALENDAR_MIRROR_ENABLED', 'true');
    const { deps, upserts } = makeDeps({
      selectReminderParents: async () => [owner, coparent],
      selectReminderCaregivers: async () => [caregiver],
      loadHorizonEvents: async () => [mirror, hale],
    });

    await runReminderCron({} as never, deps, new Date('2026-07-20T12:00:00Z'));

    const who = (eventRef: string) =>
      [
        ...new Set(
          upserts.filter((row) => row.eventRef === eventRef).map((row) => row.parentUserId),
        ),
      ].sort();
    expect(who('gcal-1')).toEqual(['p1']);
    expect(who('hale-1').sort()).toEqual(['g1', 'p1', 'p2']);
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

  it('routes a suppress decision to suppressed status (started)', async () => {
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
        liveEvent({
          id: 'e1',
          startsAt: new Date('2026-07-25T14:00:00Z'),
          title: 'Checkup',
          childId: 'c1',
        }),
      ],
      [
        'e2',
        liveEvent({
          id: 'e2',
          startsAt: new Date('2026-07-25T18:00:00Z'),
          title: 'Swim',
          childId: 'c2',
        }),
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
      dedupeKey: 'reminder:-P1D:fam-1:p1:2026-07-24',
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
      {
        event: 'reminder_sent',
        distinctId: 'p1',
        props: { offset: '-P1D', events: 2, audience: 'parent' },
      },
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
      dedupeKey: 'reminder:-PT1H:fam-1:p1:e1',
    });
    const payload = job?.payload as Record<string, unknown>;
    expect(payload.deepLink).toBeNull();
    expect((payload.events as unknown[]).length).toBe(1);
    expect(marked).toEqual([{ id: 'r1', status: 'sent', reason: null }]);
    expect(captured).toEqual([
      {
        event: 'reminder_sent',
        distinctId: 'p1',
        props: { offset: '-PT1H', events: 1, audience: 'parent' },
      },
    ]);
    expect(result).toMatchObject({ due: 1, fired: 1 });
  });

  it('carries family_events.sensitive into the reminder payload (the template then genericizes)', async () => {
    vi.stubEnv('LOOP_SEND_ENABLED', 'true');
    const { deps, enqueued } = makeDeps({
      loadDueReminders: async () => [dueRow()],
      // A non-teen child's HEALTH placement — sensitive on family_events.
      loadEvent: async () =>
        liveEvent({ title: 'Therapy session', childId: 'c1', sensitive: true }),
    });
    await runReminderCron({} as never, deps, NOW_T1H);
    const payload = enqueued[0]?.payload as Record<string, unknown>;
    const event = (payload.events as { sensitive?: boolean; title: string }[])[0];
    // The flag rides through so eventDescriptor renders "an appointment" for everyone,
    // not just teens (covered by the reminder template tests).
    expect(event?.sensitive).toBe(true);
    expect(event?.title).toBe('Therapy session');
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

describe('runReminderCron — the parent_calendar_mirror lane', () => {
  afterEach(() => vi.unstubAllEnvs());

  const mirror = liveEvent({
    id: 'gcal-1',
    title: 'Swim',
    childId: null,
    googleEventId: 'ev-swim',
    createdBy: 'p1',
  });
  const placement = liveEvent();
  const events = new Map<string, LiveEvent>([
    ['gcal-1', mirror],
    ['e1', placement],
  ]);
  const due = () => [
    dueRow({ id: 'r-mirror', eventRef: 'gcal-1' }),
    dueRow({ id: 'r-placement', eventRef: 'e1' }),
  ];

  it('HOLDS a due reminder on a mirrored event while the lane is off and still sends the placement one', async () => {
    vi.stubEnv('LOOP_SEND_ENABLED', 'true');
    vi.stubEnv('PARENT_CALENDAR_MIRROR_ENABLED', undefined);
    const { deps, enqueued, marked, reanchored } = makeDeps({
      loadDueReminders: async () => due(),
      loadEvent: async (_db, ref) => events.get(ref) ?? null,
    });
    const result = await runReminderCron({} as never, deps, NOW_T1H);

    expect(enqueued.map((job) => job.dedupeKey)).toEqual(['reminder:-PT1H:fam-1:p1:e1']);
    // The held row is not marked, cancelled or re-anchored: it is still 'scheduled'.
    expect(marked).toEqual([{ id: 'r-placement', status: 'sent', reason: null }]);
    expect(reanchored).toEqual([]);
    expect(result).toMatchObject({ due: 2, fired: 1, heldLaneOff: 1, cancelled: 0 });
  });

  it('sends the mirrored reminder too once the lane is exactly true', async () => {
    vi.stubEnv('LOOP_SEND_ENABLED', 'true');
    vi.stubEnv('PARENT_CALENDAR_MIRROR_ENABLED', 'true');
    const { deps, enqueued, marked } = makeDeps({
      loadDueReminders: async () => due(),
      loadEvent: async (_db, ref) => events.get(ref) ?? null,
    });
    const result = await runReminderCron({} as never, deps, NOW_T1H);

    expect(enqueued.map((job) => job.dedupeKey).sort()).toEqual([
      'reminder:-PT1H:fam-1:p1:e1',
      'reminder:-PT1H:fam-1:p1:gcal-1',
    ]);
    expect(marked.map((m) => [m.id, m.status]).sort()).toEqual([
      ['r-mirror', 'sent'],
      ['r-placement', 'sent'],
    ]);
    expect(result).toMatchObject({ due: 2, fired: 2, heldLaneOff: 0 });
  });

  const owner: ReminderParent = { familyId: 'fam-1', userId: 'p1', timezone: TZ };

  it('creates no reminder rows for a mirrored event while the lane is off, and counts them', async () => {
    vi.stubEnv('PARENT_CALENDAR_MIRROR_ENABLED', undefined);
    const { deps, upserts } = makeDeps({
      selectReminderParents: async () => [owner],
      loadHorizonEvents: async () => [mirror, placement],
    });
    const result = await runReminderCron({} as never, deps, new Date('2026-07-20T12:00:00Z'));

    expect(upserts.map((u) => [u.eventRef, u.offset])).toEqual([
      ['e1', '-P1D'],
      ['e1', '-PT1H'],
    ]);
    expect(result).toMatchObject({ converged: 2, notScheduledLaneOff: 2 });
  });

  it('creates the mirrored rows as before once the lane is exactly true', async () => {
    vi.stubEnv('PARENT_CALENDAR_MIRROR_ENABLED', 'true');
    const { deps, upserts } = makeDeps({
      selectReminderParents: async () => [owner],
      loadHorizonEvents: async () => [mirror, placement],
    });
    const result = await runReminderCron({} as never, deps, new Date('2026-07-20T12:00:00Z'));

    expect(upserts.map((u) => [u.eventRef, u.offset])).toEqual([
      ['gcal-1', '-P1D'],
      ['gcal-1', '-PT1H'],
      ['e1', '-P1D'],
      ['e1', '-PT1H'],
    ]);
    expect(result).toMatchObject({ converged: 4, notScheduledLaneOff: 0 });
  });

  it("on relight, SENDS a held evening-before reminder on the event's own day, late, with the voice handed the event's start and now", async () => {
    vi.stubEnv('LOOP_SEND_ENABLED', 'true');
    vi.stubEnv('PARENT_CALENDAR_MIRROR_ENABLED', 'true');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const client = {} as AgentClient;
    // 07:00 EDT on the event's own day: the evening slot passed 13 h ago, the 10:00 event
    // is 3 h off.
    const relightAt = new Date('2026-07-25T11:00:00Z');
    const { deps, enqueued, marked, audited } = makeDeps({
      loadDueReminders: async () => [
        dueRow({ id: 'r-day-before', eventRef: 'gcal-1', offset: '-P1D', fireAt: T1D_FIRE }),
      ],
      loadEvent: async (_db, ref) => events.get(ref) ?? null,
      client,
    });
    const result = await runReminderCron({} as never, deps, relightAt);

    expect(enqueued.map((job) => job.dedupeKey)).toEqual(['reminder:-P1D:fam-1:p1:2026-07-24']);
    expect(marked).toEqual([{ id: 'r-day-before', status: 'sent', reason: null }]);
    expect(audited).toEqual([]);
    expect(result).toMatchObject({ fired: 1, firedLate: 1, suppressed: 0, heldLaneOff: 0 });
    // The writer gets the facts to phrase the day from: the event's own date and the
    // send moment, both in the family's zone, and the start with its meridiem.
    expect(composeText).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        offset: '-P1D',
        now: { date: 'Saturday, July 25, 2026', time: '7:00 AM' },
        events: [expect.objectContaining({ date: 'Saturday, July 25, 2026', start: '10:00 AM' })],
        language: 'en',
      }),
      'fam-1',
    );
    info.mockRestore();
  });

  // A 01:00 EDT event on the 25th: its evening-before slot is 18:00 EDT on the 24th.
  const lateNight = liveEvent({
    id: 'gcal-late',
    title: 'Swim',
    childId: null,
    googleEventId: 'ev-late',
    createdBy: 'p1',
    startsAt: new Date('2026-07-25T05:00:00Z'),
  });
  const heldRow = () =>
    dueRow({ id: 'r-held', eventRef: 'gcal-late', offset: '-P1D', fireAt: T1D_FIRE });

  it('on relight, SENDS a held reminder three hours past its slot whose event has not started, and counts it late', async () => {
    vi.stubEnv('LOOP_SEND_ENABLED', 'true');
    vi.stubEnv('PARENT_CALENDAR_MIRROR_ENABLED', 'true');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    // 21:00 EDT: the slot passed 3 h ago and the event starts in 4 h.
    const relightAt = new Date('2026-07-25T01:00:00Z');
    const { deps, enqueued, marked, audited } = makeDeps({
      loadDueReminders: async () => [heldRow()],
      loadEvent: async () => lateNight,
    });
    const result = await runReminderCron({} as never, deps, relightAt);

    expect(enqueued.map((job) => job.dedupeKey)).toEqual(['reminder:-P1D:fam-1:p1:2026-07-24']);
    expect(marked).toEqual([{ id: 'r-held', status: 'sent', reason: null }]);
    expect(audited).toEqual([]);
    expect(result).toMatchObject({ fired: 1, firedLate: 1, suppressed: 0, heldLaneOff: 0 });
    info.mockRestore();
  });

  it('on relight, DROPS a held reminder whose event started ten minutes ago, with a logged reason and an audit row', async () => {
    vi.stubEnv('LOOP_SEND_ENABLED', 'true');
    vi.stubEnv('PARENT_CALENDAR_MIRROR_ENABLED', 'true');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const relightAt = new Date('2026-07-25T05:10:00Z');
    const { deps, enqueued, marked, audited } = makeDeps({
      loadDueReminders: async () => [heldRow()],
      loadEvent: async () => lateNight,
    });
    const result = await runReminderCron({} as never, deps, relightAt);

    expect(enqueued).toEqual([]);
    expect(marked).toEqual([{ id: 'r-held', status: 'suppressed', reason: 'started' }]);
    expect(audited).toEqual([
      { familyId: 'fam-1', reminderId: 'r-held', offset: '-P1D', reason: 'started' },
    ]);
    expect(info).toHaveBeenCalledWith(
      { familyId: 'fam-1', reminderId: 'r-held', offset: '-P1D', reason: 'started' },
      'reminder: dropped, not sent',
    );
    expect(result).toMatchObject({ fired: 0, firedLate: 0, suppressed: 1 });
    info.mockRestore();
  });
});

describe('runReminderCron — the model writes the whole reminder; no text, nothing sent', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('puts the written text on the payload, byte for byte', async () => {
    vi.stubEnv('LOOP_SEND_ENABLED', 'true');
    composeText.mockResolvedValue({
      texts: ['heads up for tomorrow', 'Swim is at 10, until 11.'],
      bold: null,
    });
    const { deps, enqueued } = makeDeps({
      loadDueReminders: async () => [dueRow()],
      loadEvent: async () => liveEvent({ endsAt: new Date('2026-07-25T15:00:00Z') }),
    });
    await runReminderCron({} as never, deps, NOW_T1H);

    const payload = enqueued[0]?.payload as Record<string, unknown>;
    expect(payload.texts).toEqual(['heads up for tomorrow', 'Swim is at 10, until 11.']);
    expect(payload).not.toHaveProperty('voice');
    // VIL-474 · no bold returned, no bold on the payload.
    expect(payload).not.toHaveProperty('bold');
  });

  it('VIL-474: a source-data change on the live event reaches the writer as a fact', async () => {
    vi.stubEnv('LOOP_SEND_ENABLED', 'true');
    const { deps } = makeDeps({
      loadDueReminders: async () => [dueRow()],
      loadEvent: async () =>
        liveEvent({
          location: 'Main St pool',
          change: { field: 'venue', previousLocation: 'Georgetown library' },
        }),
    });
    await runReminderCron({} as never, deps, NOW_T1H);
    expect(composeText).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        events: [
          expect.objectContaining({ changed: { field: 'venue', from: 'Georgetown library' } }),
        ],
      }),
      expect.anything(),
    );
  });

  it('VIL-474: carries the writer’s bold words onto the payload untouched', async () => {
    vi.stubEnv('LOOP_SEND_ENABLED', 'true');
    composeText.mockResolvedValue({ texts: ['Swim moved to 4:30 today.'], bold: '4:30' });
    const { deps, enqueued } = makeDeps({
      loadDueReminders: async () => [dueRow()],
      loadEvent: async () => liveEvent({ endsAt: new Date('2026-07-25T15:00:00Z') }),
    });
    await runReminderCron({} as never, deps, NOW_T1H);

    const payload = enqueued[0]?.payload as Record<string, unknown>;
    expect(payload.texts).toEqual(['Swim moved to 4:30 today.']);
    expect(payload.bold).toBe('4:30');
  });

  it('hands the writer the redacted facts: date, start and end with AM/PM, place, language', async () => {
    vi.stubEnv('LOOP_SEND_ENABLED', 'true');
    const loadNameLevel = vi.fn(async () => 'relation' as const);
    const { deps } = makeDeps({
      loadDueReminders: async () => [dueRow()],
      loadEvent: async () =>
        liveEvent({ endsAt: new Date('2026-07-25T15:00:00Z'), location: 'Main St pool' }),
      loadLanguage: async () => 'fr',
      loadNameLevel,
    });
    await runReminderCron({} as never, deps, NOW_T1H);

    expect(loadNameLevel).toHaveBeenCalledWith({}, 'p1');
    expect(composeText).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        offset: '-PT1H',
        planLink: null,
        language: 'fr',
        events: [
          expect.objectContaining({
            date: 'Saturday, July 25, 2026',
            allDay: false,
            start: '10:00 AM',
            end: '11:00 AM',
            location: 'Main St pool',
          }),
        ],
      }),
      'fam-1',
    );
  });

  it('sends NOTHING when the text could not be written: suppressed unwritten, audited, logged', async () => {
    vi.stubEnv('LOOP_SEND_ENABLED', 'true');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    composeText.mockResolvedValue(null);
    const { deps, enqueued, marked, audited } = makeDeps({
      loadDueReminders: async () => [dueRow()],
      loadEvent: async () => liveEvent(),
    });
    const result = await runReminderCron({} as never, deps, NOW_T1H);

    expect(enqueued).toEqual([]);
    expect(marked).toEqual([{ id: 'r1', status: 'suppressed', reason: 'unwritten' }]);
    expect(audited).toEqual([expect.objectContaining({ reminderId: 'r1', reason: 'unwritten' })]);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ familyId: 'fam-1' }),
      'reminder: no text written, nothing sent',
    );
    expect(result).toMatchObject({ fired: 0, suppressed: 1 });
    error.mockRestore();
    info.mockRestore();
  });

  it('sends NOTHING when no model client is configured', async () => {
    vi.stubEnv('LOOP_SEND_ENABLED', 'true');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { deps, enqueued, marked } = makeDeps({
      loadDueReminders: async () => [dueRow()],
      loadEvent: async () => liveEvent(),
      client: null,
    });
    await runReminderCron({} as never, deps, NOW_T1H);

    expect(composeText).not.toHaveBeenCalled();
    expect(enqueued).toEqual([]);
    expect(marked).toEqual([{ id: 'r1', status: 'suppressed', reason: 'unwritten' }]);
    error.mockRestore();
    info.mockRestore();
  });

  it('skips the compose call (and the name-level read) entirely when compose-not-send is off', async () => {
    vi.stubEnv('LOOP_SEND_ENABLED', '');
    const loadNameLevel = vi.fn(async () => 'relation' as const);
    const { deps } = makeDeps({
      loadDueReminders: async () => [dueRow()],
      loadEvent: async () => liveEvent(),
      loadNameLevel,
    });
    await runReminderCron({} as never, deps, NOW_T1H);

    expect(loadNameLevel).not.toHaveBeenCalled();
    expect(composeText).not.toHaveBeenCalled();
  });
});
