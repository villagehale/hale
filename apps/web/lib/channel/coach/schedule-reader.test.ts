import { invokeTool } from '@hale/agent';
import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildGuardDeps } from '~/lib/coach/guards';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import type { ChannelDraftInput, ChannelDraftPort } from './draft';
import { PRIVATE_EVENT_WHAT, buildChannelCoachTools, channelScheduleReader } from './tools';

/**
 * VIL-270 · THE DOOR REDACTS.
 *
 * `lib/channel` is an outbound tree (teen-access-outbound.test.ts): nothing in it has an
 * authenticated in-app viewer, so nothing in it may hold a private row's raw content.
 * The reader is the only door family_events comes through, and this drives the REAL one
 * against a real Postgres — no fake of the reader can be asked whether the reader
 * redacts.
 *
 * Private is decided by the repo's ONE predicate (`isPrivateEvent`, reminder/core.ts):
 * a 13+ child's row by the deterministic age gate, or a `sensitive` row at any age. What
 * survives the projection is the row's SHAPE — id, times, childId, and the teen/sensitive
 * flags the draft needs — because the skill still lets a parent move or cancel a private
 * item by day and time (coach-channel-sms.md:702-703).
 */

const NOW = new Date('2026-07-30T12:00:00.000Z'); // Thu 08:00 in Toronto
const THU_4_30 = new Date('2026-07-30T20:30:00.000Z');
const WEEK_START = new Date('2026-07-27T04:00:00.000Z');
const WEEK_END = new Date('2026-08-03T03:59:00.000Z');

const TEEN_DOB = '2010-06-01'; // 16 at NOW
const TODDLER_DOB = '2024-06-01'; // 2 at NOW
/**
 * Twelve years, eleven months and twenty-nine days before NOW — NOT a teenager at the
 * injected clock, and a teenager at every real wall clock this suite will ever run at.
 * That asymmetry is the point: it goes red the moment the reader derives the age gate
 * from `new Date()` instead of the `now` the turn threaded in.
 */
const ALMOST_TEEN_DOB = '2013-08-01';

const TEEN_TITLE = 'Dr. Patel — eating-disorder therapy';
const TEEN_PLACE = 'Sunnybrook, 4th floor';

interface Fixture {
  familyId: string;
  teenEventId: string;
  sensitiveEventId: string;
  sensitiveUnattributedEventId: string;
  toddlerEventId: string;
  familyWideEventId: string;
  almostTeenEventId: string;
  teenChildId: string;
}

describe('channelScheduleReader — the projection at the door (VIL-270)', () => {
  let db: TestDb;
  let fx: Fixture;

  // Booted in a hook, not the test body: pglite boot + migrations routinely exceed the
  // 5s test timeout, and hooks carry their own budget.
  beforeEach(async () => {
    db = await createTestDb();
    fx = await seedFixture(db);
  });

  afterEach(async () => {
    await db.close();
  });

  async function seedChildWithDob(familyId: string, name: string, dob: string): Promise<string> {
    const [child] = await db.database
      .insert(schema.children)
      .values({ familyId, name, dateOfBirth: dob })
      .returning({ id: schema.children.id });
    if (!child) throw new Error('children insert returned no row');
    return child.id;
  }

  async function seedEvent(values: {
    familyId: string;
    childId: string | null;
    title: string;
    location: string | null;
    sensitive?: boolean;
  }): Promise<string> {
    const [event] = await db.database
      .insert(schema.familyEvents)
      .values({
        familyId: values.familyId,
        childId: values.childId,
        title: values.title,
        location: values.location,
        sensitive: values.sensitive ?? false,
        startsAt: THU_4_30,
        source: 'channel',
      })
      .returning({ id: schema.familyEvents.id });
    if (!event) throw new Error('family_events insert returned no row');
    return event.id;
  }

  async function seedFixture(handle: TestDb): Promise<Fixture> {
    const { familyId } = await seedFamily(handle.database);
    const teenChildId = await seedChildWithDob(familyId, 'Nadia', TEEN_DOB);
    const toddlerChildId = await seedChildWithDob(familyId, 'Leo', TODDLER_DOB);
    const almostTeenChildId = await seedChildWithDob(familyId, 'Sam', ALMOST_TEEN_DOB);
    return {
      familyId,
      teenChildId,
      teenEventId: await seedEvent({
        familyId,
        childId: teenChildId,
        title: TEEN_TITLE,
        location: TEEN_PLACE,
      }),
      sensitiveEventId: await seedEvent({
        familyId,
        childId: toddlerChildId,
        title: 'Cardiology follow-up',
        location: 'SickKids, 4B',
        sensitive: true,
      }),
      sensitiveUnattributedEventId: await seedEvent({
        familyId,
        childId: null,
        title: 'Couples counselling — Dr. Mensah',
        location: 'Bloor & Spadina, suite 300',
        sensitive: true,
      }),
      toddlerEventId: await seedEvent({
        familyId,
        childId: toddlerChildId,
        title: 'Swim lesson',
        location: 'West pool',
      }),
      familyWideEventId: await seedEvent({
        familyId,
        childId: null,
        title: 'Neighbourhood BBQ',
        location: 'Trinity Bellwoods',
      }),
      almostTeenEventId: await seedEvent({
        familyId,
        childId: almostTeenChildId,
        title: 'Robotics club',
        location: 'Room 4',
      }),
    };
  }

  function reader() {
    return channelScheduleReader(db.database, NOW);
  }

  async function resolved(eventId: string) {
    const event = await reader().resolveEvent(fx.familyId, eventId);
    if (!event) throw new Error(`resolveEvent returned null for ${eventId}`);
    return event;
  }

  async function inWeek(eventId: string) {
    const events = await reader().eventsInWeek(fx.familyId, WEEK_START, WEEK_END);
    const event = events.find((e) => e.eventId === eventId);
    if (!event) throw new Error(`eventsInWeek did not return ${eventId}`);
    return event;
  }

  it("projects a teen's row on BOTH reads — the shape survives, the content does not", async () => {
    for (const event of [await resolved(fx.teenEventId), await inWeek(fx.teenEventId)]) {
      expect(event.title).toBe(PRIVATE_EVENT_WHAT);
      expect(event.location).toBeNull();
      // The handle and the time are the parent's to know — that is what makes
      // "move my Thursday 4:30 thing" still work (coach-channel-sms.md:702-703).
      expect(event.eventId).toBe(fx.teenEventId);
      expect(event.startsAt).toEqual(THU_4_30);
      expect(event.childId).toBe(fx.teenChildId);
      expect(event.teen).toBe(true);
      expect(event.sensitive).toBe(false);
    }
  });

  it('projects a sensitive non-teen row the same way, and says so on the row', async () => {
    const event = await resolved(fx.sensitiveEventId);

    expect(event.title).toBe(PRIVATE_EVENT_WHAT);
    expect(event.location).toBeNull();
    expect(event.teen).toBe(false);
    expect(event.sensitive).toBe(true);
  });

  it('projects a sensitive row that names no child — the two gates are independent', async () => {
    // The parent's own therapy hour: `addToCalendar` takes childId and sensitive as
    // independent fields (internal-writes.ts:193-196), so a row can be flagged private
    // with nothing to join a child on. `sensitive` is then the ONLY mark on it, and a
    // projection that reached for the child join first would hand this one out raw.
    for (const event of [
      await resolved(fx.sensitiveUnattributedEventId),
      await inWeek(fx.sensitiveUnattributedEventId),
    ]) {
      expect(event.title).toBe(PRIVATE_EVENT_WHAT);
      expect(event.location).toBeNull();
      expect(event.childId).toBeNull();
      expect(event.teen).toBe(false);
      expect(event.sensitive).toBe(true);
    }
  });

  it('leaves a toddler-linked row raw — the projection is a gate, not a blanket', async () => {
    const event = await resolved(fx.toddlerEventId);

    expect(event.title).toBe('Swim lesson');
    expect(event.location).toBe('West pool');
    expect(event.teen).toBe(false);
  });

  it('leaves an UNATTRIBUTED row raw — nullable child_id is private nowhere', async () => {
    // Deliberate, and pinned so it stays visible: teen-ness on this table hangs entirely
    // off the nullable child_id join, and propose_calendar_add's childId is optional and
    // model-supplied. A teen item written with no link is raw on every surface — and it
    // arrives that way by a second path too: family_events.child_id is `onDelete: 'set
    // null'` (family-events.ts:36), so hard-deleting a 13+ child un-privates every row
    // that was theirs. Closing both is a write-path decision (attribution authority),
    // not a reader projection.
    const event = await resolved(fx.familyWideEventId);

    expect(event.title).toBe('Neighbourhood BBQ');
    expect(event.location).toBe('Trinity Bellwoods');
    expect(event.teen).toBe(false);
  });

  it('decides the age gate at the injected clock, not at wall time', async () => {
    const event = await resolved(fx.almostTeenEventId);

    expect(event.teen).toBe(false);
    expect(event.title).toBe('Robotics club');
  });
});

describe('the texted verbs over the real door (VIL-270)', () => {
  let db: TestDb;
  let fx: { familyId: string; teenEventId: string; teenChildId: string };

  beforeEach(async () => {
    db = await createTestDb();
    const { familyId } = await seedFamily(db.database);
    const [child] = await db.database
      .insert(schema.children)
      .values({ familyId, name: 'Nadia', dateOfBirth: TEEN_DOB })
      .returning({ id: schema.children.id });
    if (!child) throw new Error('children insert returned no row');
    const [event] = await db.database
      .insert(schema.familyEvents)
      .values({
        familyId,
        childId: child.id,
        title: TEEN_TITLE,
        location: TEEN_PLACE,
        startsAt: THU_4_30,
        source: 'channel',
      })
      .returning({ id: schema.familyEvents.id });
    if (!event) throw new Error('family_events insert returned no row');
    fx = { familyId, teenEventId: event.id, teenChildId: child.id };
  });

  afterEach(async () => {
    await db.close();
  });

  function harness() {
    const drafts: ChannelDraftInput[] = [];
    const draftPort: ChannelDraftPort = {
      async draft(input) {
        drafts.push(input);
        return { actionId: `action-${drafts.length}` };
      },
    };
    const tools = buildChannelCoachTools({
      familyId: fx.familyId,
      reader: channelScheduleReader(db.database, NOW),
      draftPort,
      villageTool: null,
      activity: null,
      spots: null,
      now: NOW,
    });
    // The REAL guard, wired exactly as both channel surfaces wire it: no viewer, so no
    // grant is consultable (runtime.ts:428, relay-deps.ts:121).
    const deps = buildGuardDeps(db.database);
    return {
      drafts,
      call(name: string, input: unknown) {
        const tool = tools.find((t) => t.name === name);
        if (!tool) throw new Error(`no tool named ${name}`);
        return invokeTool(tool, input, { familyId: fx.familyId, actor: 'system' }, deps);
      },
    };
  }

  it('still moves a private item by day and time — and drafts none of its content', async () => {
    const h = harness();

    const result = await h.call('propose_calendar_move', {
      eventId: fx.teenEventId,
      date: '2026-07-31',
      time: '16:30',
      weekday: 'fri',
    });

    expect(result).toMatchObject({ drafted: true });
    const draft = h.drafts[0];
    expect(draft?.teenContent).toBe(true);
    expect(draft?.payload.reversalHandle).toBe(fx.teenEventId);
    expect(JSON.stringify(draft)).not.toContain(TEEN_TITLE);
    expect(JSON.stringify(draft)).not.toContain(TEEN_PLACE);
  });

  it('still cancels a private item — and drafts none of its content', async () => {
    const h = harness();

    await h.call('propose_calendar_cancel', { eventId: fx.teenEventId });

    const draft = h.drafts[0];
    expect(draft?.teenContent).toBe(true);
    expect(draft?.payload.reversalHandle).toBe(fx.teenEventId);
    expect(JSON.stringify(draft)).not.toContain(TEEN_TITLE);
    expect(JSON.stringify(draft)).not.toContain(TEEN_PLACE);
  });

  it('hands the model a week with the private item present but not described', async () => {
    const h = harness();

    const week = await h.call('lookup_week', {});

    expect(JSON.stringify(week)).toContain(PRIVATE_EVENT_WHAT);
    expect(JSON.stringify(week)).not.toContain(TEEN_TITLE);
    expect(JSON.stringify(week)).not.toContain(TEEN_PLACE);
  });
});
