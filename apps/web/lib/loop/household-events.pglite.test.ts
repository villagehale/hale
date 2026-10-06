import { invokeTool } from '@hale/agent';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelDraftPort } from '~/lib/channel/coach/draft';
import { buildChannelCoachTools, channelScheduleReader } from '~/lib/channel/coach/tools';
import { loadSaturdayPlans } from '~/lib/channel/nudge/saturday-plans';
import { buildGuardDeps } from '~/lib/coach/guards';
import {
  type TestDb,
  createTestDb,
  seedChild,
  seedFamily,
  seedIntegration,
} from '~/lib/testing/pglite';
import { readTeenSafeFamilyEventsInWindow } from './assistant-events';
import { loadIcsFeed } from './ics-feed';
import { listFamilyEventsInWindow } from './queries';

/**
 * A mirror of one parent's Google Calendar is Hale's own note for that parent's
 * reminders (VIL-416). It is not a household fact: no reader the other parent, a
 * subscribed feed, an MCP client or the coach can reach may return it.
 *
 * Every case seeds the same pair in the same family and window — a Hale-authored YES
 * (googleEventId null) and a mirror — so the YES is the positive control: a reader
 * that returned nothing would fail the first assertion, not pass the second.
 */

const NOW = new Date('2026-10-07T16:00:00.000Z');
const SATURDAY_11AM = new Date('2026-10-10T15:00:00.000Z');
const SATURDAY_2PM = new Date('2026-10-10T18:00:00.000Z');
const WINDOW_START = new Date('2026-10-05T00:00:00.000Z');
const WINDOW_END = new Date('2026-10-12T00:00:00.000Z');
const TZ = 'America/Toronto';
const FEED_TOKEN = 'feed-token-household-boundary';

const YES_TITLE = 'Swim lesson';
const MIRROR_TITLE = 'Private appointment from one calendar';

let db: TestDb;
let familyId: string;
let parentUserId: string;
let childId: string;
let yesId: string;
let mirrorId: string;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  const family = await seedFamily(db.database);
  familyId = family.familyId;
  parentUserId = family.parentUserId;
  childId = await seedChild(db.database, familyId, 'Test Kid', 48, undefined, NOW);
  const integrationId = await seedIntegration(db.database, familyId, parentUserId, 'gcal');
  await db.database
    .update(schema.families)
    .set({ icsShareToken: `${FEED_TOKEN}-${familyId}` })
    .where(eq(schema.families.id, familyId));

  const [yes] = await db.database
    .insert(schema.familyEvents)
    .values({
      familyId,
      childId,
      title: YES_TITLE,
      startsAt: SATURDAY_11AM,
      location: 'Community pool',
      source: 'parent',
      createdBy: parentUserId,
    })
    .returning({ id: schema.familyEvents.id });
  const [mirror] = await db.database
    .insert(schema.familyEvents)
    .values({
      familyId,
      title: MIRROR_TITLE,
      startsAt: SATURDAY_2PM,
      location: 'Somewhere private',
      source: 'parent',
      createdBy: parentUserId,
      googleEventId: 'google-event-mirror',
      integrationId,
    })
    .returning({ id: schema.familyEvents.id });
  if (!yes || !mirror) throw new Error('family_events seed returned no row');
  yesId = yes.id;
  mirrorId = mirror.id;
});

describe('a calendar mirror stays out of every household reader', () => {
  it('the composer window read returns the YES and not the mirror', async () => {
    const rows = await listFamilyEventsInWindow(db.database, familyId, WINDOW_START, WINDOW_END);
    expect(rows.map((row) => row.id)).toEqual([yesId]);
  });

  it('the ICS feed carries the YES and not the mirror', async () => {
    const ics = await loadIcsFeed(db.database, `${FEED_TOKEN}-${familyId}`, NOW);
    expect(ics).toContain(YES_TITLE);
    expect(ics).not.toContain(MIRROR_TITLE);
    expect(ics).not.toContain('Somewhere private');
  });

  it('the MCP upcoming-events read returns the YES and not the mirror', async () => {
    const events = await readTeenSafeFamilyEventsInWindow(
      db.database,
      familyId,
      WINDOW_START,
      WINDOW_END,
      NOW,
    );
    expect(events.map((event) => event.id)).toEqual([yesId]);
  });

  it('the coach week read and event resolver see the YES and not the mirror', async () => {
    const reader = channelScheduleReader(db.database, NOW);
    const week = await reader.eventsInWeek(familyId, WINDOW_START, WINDOW_END);
    expect(week.map((event) => event.eventId)).toEqual([yesId]);
    expect(await reader.resolveEvent(familyId, yesId)).toMatchObject({ eventId: yesId });
    expect(await reader.resolveEvent(familyId, mirrorId)).toBeNull();
  });

  it('the empty-Saturday read counts the YES child and does not mark the household busy for the mirror', async () => {
    const plans = await loadSaturdayPlans(db.database, familyId, NOW, TZ);
    expect([...plans.busyChildIds]).toEqual([childId]);
    expect(plans.householdBusy).toBe(false);
  });
});

describe('propose_calendar_cancel cannot reach a mirror', () => {
  function harness() {
    const draft = vi.fn<ChannelDraftPort['draft']>(async () => ({ actionId: 'action-1' }));
    const tools = buildChannelCoachTools({
      familyId,
      reader: channelScheduleReader(db.database, NOW),
      draftPort: { draft },
      villageTool: null,
      activity: null,
      spots: null,
      now: NOW,
    });
    const tool = tools.find((entry) => entry.name === 'propose_calendar_cancel');
    if (!tool) throw new Error('propose_calendar_cancel is not registered');
    const deps = buildGuardDeps(db.database);
    return {
      draft,
      cancel: (eventId: string) =>
        invokeTool(tool, { eventId }, { familyId, actor: parentUserId }, deps),
    };
  }

  it('drafts a cancel for the YES', async () => {
    const { draft, cancel } = harness();
    await expect(cancel(yesId)).resolves.toMatchObject({ drafted: true });
    expect(draft).toHaveBeenCalledTimes(1);
  });

  it("refuses the mirror's id with the not-on-this-calendar wording and drafts nothing", async () => {
    const { draft, cancel } = harness();
    await expect(cancel(mirrorId)).rejects.toThrow(
      `Event ${mirrorId} is not on this family's calendar`,
    );
    expect(draft).not.toHaveBeenCalled();
  });
});
