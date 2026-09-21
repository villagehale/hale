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

/** The parents' reminder lead is a three-member pool (reminder/core.ts) — the same
 * distance in time, three ways, rotating on the event's own family-local day. */
const HOUR_LEADS = /^(?:In an hour|An hour from now|Just about an hour away): /;

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
      dedupeKey: 'reminder:-PT1H:fam-1:g1:e1',
    });
    expect(body(enqueued[0] as ChannelSendJob)).toBe(
      'In an hour - Swim class at 10:00, Stouffville Public School',
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
    // The parents' own copy, and visibly not the caregiver's — theirs carries the address
    // and joins with a dash where this one uses a colon. The LEAD is pooled now (three
    // ways of saying the same distance, rotating on the event's own day), so what is
    // pinned is the lead's shape plus the facts after it, byte for byte.
    const parentText = body(enqueued[0] as ChannelSendJob);
    expect(parentText).toMatch(HOUR_LEADS);
    expect(parentText.replace(HOUR_LEADS, '')).toBe('Swim class at 10:00');
  });
});

/**
 * ONE RECIPIENT, TWO HOUSEHOLDS.
 *
 * A sitter works for the family down the street as well, and a parent of one family is
 * the nanny of another. `event_reminders` rows are (family, event, recipient) triples,
 * so both of those people hold due rows under two different familyIds at the same slot —
 * and the batching that turns rows into messages is the one place the familyId can be
 * dropped. Every assertion below is about WHICH HOUSEHOLD each text belongs to, and the
 * ledger + audit rows the dispatch writes from it.
 */
describe('one recipient, two households', () => {
  afterEach(() => vi.unstubAllEnvs());

  const EVE = new Date('2026-07-24T22:00:00Z'); // 18:00 EDT, the evening before
  const NOW_EVE = new Date('2026-07-24T22:30:00Z');
  const KID_B = { id: 'cb', name: 'Theo', dateOfBirth: '2021-03-04', gender: 'boy' };
  const CHILDREN_BY_FAMILY = new Map([
    ['fam-1', [TODDLER, TEEN]],
    ['fam-2', [KID_B]],
  ]);

  const jobFor = (jobs: readonly ChannelSendJob[], familyId: string): ChannelSendJob => {
    const job = jobs.find((j) => j.familyId === familyId);
    if (!job) throw new Error(`no job for ${familyId}`);
    return job;
  };

  it('texts a sitter seated in two families once per family, not one merged evening under the first', async () => {
    vi.stubEnv('LOOP_SEND_ENABLED', 'true');
    const events = new Map<string, LiveEvent>([
      ['e-a', event({ id: 'e-a', title: 'Swim class', location: 'Rec centre' })],
      ['e-b', event({ id: 'e-b', title: 'Piano', childId: KID_B.id, location: 'Bayview studio' })],
    ]);
    const { deps, enqueued, marked } = makeDeps({
      selectReminderCaregivers: async () => [],
      loadDueReminders: async () => [
        dueRow({
          id: 'r-a',
          familyId: 'fam-1',
          eventRef: 'e-a',
          parentUserId: 's1',
          role: 'babysitter',
          offset: '-P1D',
          fireAt: EVE,
        }),
        dueRow({
          id: 'r-b',
          familyId: 'fam-2',
          eventRef: 'e-b',
          parentUserId: 's1',
          role: 'babysitter',
          offset: '-P1D',
          fireAt: EVE,
        }),
      ],
      loadEvent: async (_db, ref) => events.get(ref) ?? null,
      loadChildren: async (_db, familyId) => CHILDREN_BY_FAMILY.get(familyId) ?? [],
    });
    await runReminderCron(db, deps, NOW_EVE);

    expect(enqueued).toHaveLength(2);
    expect(enqueued.map((j) => j.familyId).sort()).toEqual(['fam-1', 'fam-2']);
    // Each household's evening carries its OWN event and only its own — a merged text
    // would put the second family's child on the first family's ledger + audit row.
    expect(body(jobFor(enqueued, 'fam-1'))).toContain('Swim class');
    expect(body(jobFor(enqueued, 'fam-1'))).not.toContain('Piano');
    expect(body(jobFor(enqueued, 'fam-2'))).toContain('Piano');
    expect(body(jobFor(enqueued, 'fam-2'))).not.toContain('Swim class');
    // And the keys differ. `dedupeActive` matches on the key alone, family-blind, so a
    // T-24h key of recipient+evening would let the FIRST household consume the second
    // household's idempotency and drop its text at the dispatch.
    expect(new Set(enqueued.map((j) => j.dedupeKey)).size).toBe(2);
    expect(marked).toEqual([
      { id: 'r-a', status: 'sent', reason: null },
      { id: 'r-b', status: 'sent', reason: null },
    ]);
  });

  it.each([
    ['the parent row first', ['fam-1', 'fam-2']],
    ['the caregiver row first', ['fam-2', 'fam-1']],
  ] as const)(
    'keeps a parent-of-one/nanny-of-another on the right template for each household — %s',
    async (_label, order) => {
      vi.stubEnv('LOOP_SEND_ENABLED', 'true');
      // fam-1 is HER OWN household, and the due event is her 13-year-old's. fam-2 is the
      // family she nannies for. One user id, two roles, two families, same slot.
      const events = new Map<string, LiveEvent>([
        ['e-teen', event({ id: 'e-teen', title: 'Therapy intake', childId: TEEN.id })],
        ['e-piano', event({ id: 'e-piano', title: 'Piano', childId: KID_B.id, location: 'Bayview studio' })],
      ]);
      const rows: Record<string, DueReminder> = {
        'fam-1': dueRow({
          id: 'r-own',
          familyId: 'fam-1',
          eventRef: 'e-teen',
          parentUserId: 'u1',
          role: 'primary_parent',
        }),
        'fam-2': dueRow({
          id: 'r-work',
          familyId: 'fam-2',
          eventRef: 'e-piano',
          parentUserId: 'u1',
          role: 'nanny',
        }),
      };
      const { deps, enqueued } = makeDeps({
        selectReminderCaregivers: async () => [],
        loadDueReminders: async () => order.map((familyId) => rows[familyId] as DueReminder),
        loadEvent: async (_db, ref) => events.get(ref) ?? null,
        loadChildren: async (_db, familyId) => CHILDREN_BY_FAMILY.get(familyId) ?? [],
      });
      await runReminderCron(db, deps, NOW);

      expect(enqueued).toHaveLength(2);
      // Her own household's reminder is a PARENT's: the parents' template, on her
      // loop_channel, and the teen gate genericizes it there (rule #1).
      const own = jobFor(enqueued, 'fam-1');
      expect(own.templateKey).toBe('reminder');
      expect(own.channel).toBeUndefined();
      expect(body(own)).toMatch(HOUR_LEADS);
      expect(body(own).replace(HOUR_LEADS, '')).toBe('an appointment at 10:00');
      expect(body(own)).not.toContain('Therapy intake');

      // The household she works for is a CAREGIVER's: their template, pinned to sms,
      // under THEIR familyId — and carrying nothing of her own family.
      const work = jobFor(enqueued, 'fam-2');
      expect(work.templateKey).toBe('reminder:caregiver');
      expect(work.channel).toBe('sms');
      expect(body(work)).toContain('Piano');
      expect(body(work)).toContain('Bayview studio');
      expect(JSON.stringify(work.payload)).not.toContain('Therapy intake');
      expect(JSON.stringify(work.payload)).not.toContain('Noor');
    },
  );
});
