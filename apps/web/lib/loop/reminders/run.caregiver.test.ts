import type { Database } from '@hale/db';
import { channelSendJobPayloadSchema } from '@hale/tools-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CaregiverSeat } from '~/lib/loop/caregiver-audience';
import { loopTemplateRenderer } from '~/lib/loop/templates/registry';
import { DEFAULT_LOOP_PREFS } from '~/lib/loop/prefs';
import {
  type ChannelSendJob,
  type DueReminder,
  type LiveEvent,
  type ReminderRunDeps,
  runReminderCron,
} from './run';
import type { ReminderStatus, SuppressReason } from './schedule';

/**
 * VIL-241 · M6 — the event reminders a caregiver was promised, and the three events they
 * must never receive.
 *
 * The parents' rows ride every assertion here as the positive control: every gate added
 * for the caregiver leg is a gate the parents' reminders pass through too, and an absence
 * test with nothing present to compare it against fails open.
 */

const TZ = 'America/Toronto';
const SUMMER_START = new Date('2026-07-25T14:00:00Z'); // 10:00 EDT
const T1H_FIRE = new Date('2026-07-25T13:00:00Z');
const NOW = new Date('2026-07-25T13:00:00Z');

const TODDLER = { id: 'c1', name: 'Mia', dateOfBirth: '2022-06-01', gender: 'girl' };
const TEEN = { id: 'c2', name: 'Noor', dateOfBirth: '2011-06-01', gender: 'girl' };

const GRANDMA: CaregiverSeat = {
  familyId: 'fam-1',
  userId: 'g1',
  role: 'grandparent',
  timezone: TZ,
  weekStartDay: 0,
};

function event(over: Partial<LiveEvent> = {}): LiveEvent {
  return {
    id: 'e1',
    startsAt: SUMMER_START,
    deletedAt: null,
    title: 'Swim class',
    childId: TODDLER.id,
    sensitive: false,
    location: 'Stouffville Public School',
    ...over,
  };
}

function dueRow(over: Partial<DueReminder> = {}): DueReminder {
  return {
    id: 'r1',
    familyId: 'fam-1',
    eventRef: 'e1',
    parentUserId: 'g1',
    offset: '-PT1H',
    fireAt: T1H_FIRE,
    timezone: TZ,
    role: 'grandparent',
    smsChannelActive: true,
    ...over,
  };
}

function makeDeps(over: Partial<ReminderRunDeps> = {}) {
  const enqueued: ChannelSendJob[] = [];
  const marked: { id: string; status: ReminderStatus; reason: SuppressReason | null }[] = [];
  const upserts: { eventRef: string; parentUserId: string; offset: string }[] = [];
  const captures: { event: string; distinctId: string; props: Record<string, unknown> }[] = [];
  const deps: ReminderRunDeps = {
    selectReminderParents: async () => [],
    selectReminderCaregivers: async () => [GRANDMA],
    loadHorizonEvents: async () => [],
    upsertReminder: async (_db, row) => {
      upserts.push({ eventRef: row.eventRef, parentUserId: row.parentUserId, offset: row.offset });
    },
    cancelDeletedEventReminders: async () => {},
    loadDueReminders: async () => [],
    loadEvent: async () => null,
    recentInteraction: async () => false,
    markStatus: async (_db, id, status, reason) => {
      marked.push({ id, status, reason });
    },
    reanchor: async () => {},
    loadChildren: async () => [TODDLER, TEEN],
    enqueue: async (job) => {
      enqueued.push(job);
    },
    capture: async (event, distinctId, props = {}) => {
      captures.push({ event, distinctId, props });
      return 'sent';
    },
    client: null,
    loadNameLevel: async () => 'first_name',
    ...over,
  };
  return { deps, enqueued, marked, upserts, captures };
}

const db = {} as Database;

function body(job: ChannelSendJob): string {
  const rendered = loopTemplateRenderer.render(
    {
      templateKey: job.templateKey,
      familyId: job.familyId,
      parentUserId: job.parentUserId,
      category: job.category,
      urgency: job.urgency,
      payload: job.payload,
    },
    'sms',
    DEFAULT_LOOP_PREFS.childNameLevel,
  );
  if (rendered.kind !== 'sms') throw new Error('expected an sms leg');
  return rendered.text;
}

describe('converge — which events a caregiver seat materializes at all', () => {
  it("writes rows for the household's schedule and skips the teenager's and the health one", async () => {
    const events = [
      event({ id: 'e-toddler' }),
      event({ id: 'e-teen', childId: TEEN.id }),
      event({ id: 'e-health', sensitive: true }),
      event({ id: 'e-family', childId: null }),
    ];
    const { deps, upserts } = makeDeps({
      selectReminderParents: async () => [{ familyId: 'fam-1', userId: 'p1', timezone: TZ }],
      loadHorizonEvents: async () => events,
    });
    await runReminderCron(db, deps, NOW);

    const caregiverRefs = [...new Set(upserts.filter((u) => u.parentUserId === 'g1').map((u) => u.eventRef))];
    expect(caregiverRefs.sort()).toEqual(['e-family', 'e-toddler']);

    // POSITIVE CONTROL: the parent still materializes every one of the four.
    const parentRefs = [...new Set(upserts.filter((u) => u.parentUserId === 'p1').map((u) => u.eventRef))];
    expect(parentRefs.sort()).toEqual(['e-family', 'e-health', 'e-teen', 'e-toddler']);
  });
});

describe('fire — what actually reaches a caregiver', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('texts the time and the address, on the caregiver template, pinned to sms', async () => {
    vi.stubEnv('LOOP_SEND_ENABLED', 'true');
    const { deps, enqueued } = makeDeps({
      loadDueReminders: async () => [dueRow()],
      loadEvent: async () => event(),
    });
    await runReminderCron(db, deps, NOW);

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      templateKey: 'reminder:caregiver',
      parentUserId: 'g1',
      category: 'reminder',
      channel: 'sms',
      dedupeKey: 'reminder:-PT1H:g1:e1',
    });
    expect(body(enqueued[0] as ChannelSendJob)).toBe(
      'Hale: in an hour - Swim class at 10:00, Stouffville Public School',
    );
    // And the pin survives the contract the drain parses the job through — the one place
    // a dropped `channel` key would silently route a caregiver's text to email.
    const parsed = channelSendJobPayloadSchema.parse({
      ...enqueued[0],
      familyId: '11111111-1111-4111-8111-111111111111',
      parentUserId: '22222222-2222-4222-8222-222222222222',
    });
    expect(parsed.channel).toBe('sms');
  });

  it('runs no voice stage and offers no /plan link for a caregiver', async () => {
    vi.stubEnv('LOOP_SEND_ENABLED', 'true');
    const loadNameLevel = vi.fn(async () => 'first_name' as const);
    const { deps, enqueued } = makeDeps({
      loadDueReminders: async () => [dueRow()],
      loadEvent: async () => event(),
      // A client IS available — the caregiver leg must decline it rather than merely
      // inherit a null one.
      client: {} as ReminderRunDeps['client'],
      loadNameLevel,
    });
    await runReminderCron(db, deps, NOW);
    expect(loadNameLevel).not.toHaveBeenCalled();
    expect(body(enqueued[0] as ChannelSendJob)).not.toMatch(/https?:\/\//);
    expect(JSON.stringify(enqueued[0]?.payload)).not.toContain('deepLink');
  });

  it("suppresses, by name, a due row for a teenager's event", async () => {
    vi.stubEnv('LOOP_SEND_ENABLED', 'true');
    const { deps, enqueued, marked } = makeDeps({
      loadDueReminders: async () => [dueRow(), dueRow({ id: 'r2', parentUserId: 'p1', role: 'primary_parent' })],
      loadEvent: async () => event({ childId: TEEN.id }),
    });
    const result = await runReminderCron(db, deps, NOW);

    expect(marked).toContainEqual({ id: 'r1', status: 'suppressed', reason: 'out_of_scope' });
    expect(enqueued.map((j) => j.parentUserId)).toEqual(['p1']); // the parent still gets it
    expect(result.suppressed).toBe(1);
  });

  it('suppresses a health-flagged event for a caregiver and sends it to the parent', async () => {
    vi.stubEnv('LOOP_SEND_ENABLED', 'true');
    const { deps, enqueued, marked } = makeDeps({
      loadDueReminders: async () => [dueRow(), dueRow({ id: 'r2', parentUserId: 'p1', role: 'primary_parent' })],
      loadEvent: async () => event({ sensitive: true }),
    });
    await runReminderCron(db, deps, NOW);
    expect(marked).toContainEqual({ id: 'r1', status: 'suppressed', reason: 'out_of_scope' });
    expect(enqueued.map((j) => j.templateKey)).toEqual(['reminder']);
  });

  it('suppresses a seat whose channel has since been revoked — the row carries the revocation', async () => {
    vi.stubEnv('LOOP_SEND_ENABLED', 'true');
    const { deps, enqueued, marked } = makeDeps({
      // Her STOP revoked the channel. The reminder row written last week is still sitting
      // there, due, and now arrives with the live join saying her number is gone.
      loadDueReminders: async () => [dueRow({ smsChannelActive: false })],
      loadEvent: async () => event(),
    });
    await runReminderCron(db, deps, NOW);
    expect(enqueued).toEqual([]);
    expect(marked).toEqual([{ id: 'r1', status: 'suppressed', reason: 'out_of_scope' }]);
  });

  it('still fires for a seat the converge audience did not list this run — a fan-out bound is not a refusal', async () => {
    vi.stubEnv('LOOP_SEND_ENABLED', 'true');
    const { deps, enqueued, marked } = makeDeps({
      // The converge selector is a FAN-OUT list: it may be bounded, re-ordered or empty
      // for reasons that say nothing about THIS row's recipient. Reading it as the fire
      // gate's truth turns a cap into a permanent `out_of_scope` on a live seat's reminder.
      selectReminderCaregivers: async () => [],
      loadDueReminders: async () => [dueRow()],
      loadEvent: async () => event(),
    });
    await runReminderCron(db, deps, NOW);
    expect(enqueued.map((j) => j.parentUserId)).toEqual(['g1']);
    expect(marked).toEqual([{ id: 'r1', status: 'sent', reason: null }]);
  });

  it('suppresses a row whose recipient holds no seat in the family any more', async () => {
    vi.stubEnv('LOOP_SEND_ENABLED', 'true');
    const { deps, enqueued, marked } = makeDeps({
      loadDueReminders: async () => [dueRow({ role: null })],
      loadEvent: async () => event(),
    });
    await runReminderCron(db, deps, NOW);
    expect(enqueued).toEqual([]);
    expect(marked).toEqual([{ id: 'r1', status: 'suppressed', reason: 'out_of_scope' }]);
  });

  it("suppresses a DEPARTED co-parent's due row while the seated parent's fires", async () => {
    vi.stubEnv('LOOP_SEND_ENABLED', 'true');
    // `coparent/depart.ts` deletes the family_members row and nothing else — the
    // event_reminders written while they were seated stay 'scheduled' and due. Before the
    // role gate they kept firing the household's events at someone who had left; now the
    // live seat, not the ledger row, decides. A behaviour change for the parents' leg,
    // and the only one.
    const { deps, enqueued, marked } = makeDeps({
      selectReminderCaregivers: async () => [],
      loadDueReminders: async () => [
        dueRow({ id: 'r-gone', parentUserId: 'p-gone', role: null }),
        dueRow({ id: 'r-here', parentUserId: 'p1', role: 'co_parent' }),
      ],
      loadEvent: async () => event(),
    });
    await runReminderCron(db, deps, NOW);
    expect(enqueued.map((j) => j.parentUserId)).toEqual(['p1']);
    expect(marked).toContainEqual({ id: 'r-gone', status: 'suppressed', reason: 'out_of_scope' });
  });

  it('tags the send with the audience it reached, so a caregiver ping is separable from a parent one', async () => {
    vi.stubEnv('LOOP_SEND_ENABLED', 'true');
    const { deps, captures } = makeDeps({
      loadDueReminders: async () => [
        dueRow(),
        dueRow({ id: 'r2', parentUserId: 'p1', role: 'primary_parent' }),
      ],
      loadEvent: async () => event(),
    });
    await runReminderCron(db, deps, NOW);
    expect(
      captures
        .filter((c) => c.event === 'reminder_sent')
        .map((c) => ({ distinctId: c.distinctId, audience: c.props.audience })),
    ).toEqual([
      { distinctId: 'g1', audience: 'caregiver' },
      { distinctId: 'p1', audience: 'parent' },
    ]);
  });

  it("leaves the parents' reminder exactly as it was (positive control)", async () => {
    vi.stubEnv('LOOP_SEND_ENABLED', 'true');
    const { deps, enqueued } = makeDeps({
      selectReminderCaregivers: async () => [],
      loadDueReminders: async () => [dueRow({ parentUserId: 'p1', role: 'primary_parent' })],
      loadEvent: async () => event(),
    });
    await runReminderCron(db, deps, NOW);
    expect(enqueued[0]).toMatchObject({ templateKey: 'reminder', parentUserId: 'p1' });
    expect(enqueued[0]?.channel).toBeUndefined();
    // The parents' own copy, byte for byte what it was before this leg existed — and
    // visibly not the caregiver's, which leads with the sender and carries the address.
    expect(body(enqueued[0] as ChannelSendJob)).toBe('In an hour: Swim class at 10:00');
  });
});
