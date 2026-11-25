import { schema } from '@hale/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { childNameForStorage } from '~/lib/channel/intake/provision';
import { type TestDb, createTestDb, seedFamily, seedIntegration } from '~/lib/testing/pglite';
import { planFamilyDutyAsks, renderDutyLines } from './asks';
import { COPARENT_DUTY_SENDS_ENABLED_ENV } from './flag';
import { commitDutyUpdate } from './model';

/**
 * Rule #1 · with STATED_CHILD_NAME_ENABLED on, intake stores no name for a child the
 * parent never named. A 13+ child with no name is still a teen: the co-parent duty week
 * overview and the group duty lines carry none of that child's event titles.
 */

const STATED_CHILD_NAME_ENABLED_ENV = 'STATED_CHILD_NAME_ENABLED';
/** Sunday 27 Sep 2026, 18:00 in Toronto. */
const SUNDAY_EVENING = new Date('2026-09-27T22:00:00.000Z');
const MONDAY = new Date('2026-09-28T19:00:00.000Z');
const TUESDAY = new Date('2026-09-29T19:00:00.000Z');

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function household(children: ReadonlyArray<{ name: string | null; years: number }>) {
  const family = await seedFamily(db.database, 'Duty household');
  await db.database
    .update(schema.users)
    .set({ timezone: 'America/Toronto' })
    .where(eq(schema.users.id, family.parentUserId));
  const inserted = (await db.database.execute(
    sql`insert into users (email, name) values (${`sam-${family.familyId}@example.test`}, 'Sam') returning id`,
  )) as unknown as { rows?: Array<{ id: string }> } | Array<{ id: string }>;
  const sam = (Array.isArray(inserted) ? inserted : (inserted.rows ?? []))[0];
  if (!sam) throw new Error('second parent insert returned no row');
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId: family.familyId, userId: sam.id, role: 'co_parent' });
  await db.database
    .update(schema.families)
    .set({ linqGroupChatId: `chat-${family.familyId}` })
    .where(eq(schema.families.id, family.familyId));
  for (const child of children) {
    const born = new Date(SUNDAY_EVENING);
    born.setFullYear(born.getFullYear() - child.years);
    await db.database.insert(schema.children).values({
      familyId: family.familyId,
      name: childNameForStorage(child.name),
      dateOfBirth: born.toISOString().slice(0, 10),
    });
  }
  const integrationId = await seedIntegration(
    db.database,
    family.familyId,
    family.parentUserId,
    'gcal',
  );
  return { ...family, integrationId };
}

async function block(
  home: { familyId: string; parentUserId: string; integrationId: string },
  eventId: string,
  title: string,
  start: Date,
): Promise<void> {
  await db.database.insert(schema.parentCalendarBlocks).values({
    integrationId: home.integrationId,
    eventId,
    familyId: home.familyId,
    userId: home.parentUserId,
    startAt: start,
    endAt: new Date(start.getTime() + 60 * 60 * 1000),
    kidRelated: true,
    title,
    calendarStanding: 'organizer',
    childId: null,
    status: 'confirmed',
    updatedStamp: '1',
  });
  await commitDutyUpdate(db.database, {
    mode: 'write',
    familyId: home.familyId,
    actorUserId: home.parentUserId,
    parentCount: 2,
    subjectKey: eventId,
    eventTitle: title,
    childNames: [],
    slot: {
      role: 'pickup',
      claim: 'self',
      name: null,
      userId: home.parentUserId,
      confidence: 1,
    },
    prior: null,
    source: 'text',
    now: SUNDAY_EVENING,
    childId: null,
    question: false,
    askWhichKid: false,
  });
}

/** What the week overview (folded into the weekly bubble) and the group duty lines are built from. */
async function whatTheDutyComposerSees(familyId: string): Promise<string> {
  const seen: string[] = [];
  for (const bubbleLeaving of [true, false]) {
    const view = await planFamilyDutyAsks(db.database, {
      familyId,
      now: SUNDAY_EVENING,
      bubbleLeaving,
    });
    if (!('plan' in view)) throw new Error('expected a duty plan');
    seen.push(JSON.stringify(view.render.occasions));
    for (const lines of [view.plan.foldLines, view.plan.sendLines]) {
      seen.push(...(renderDutyLines(lines, view.render)?.facts ?? []));
    }
  }
  return seen.join('\n');
}

describe('duty asks · a teenager with no name on file (rule #1)', () => {
  it('stated names lit, an unnamed only child of 14 lends no title to the week overview or a group line', async () => {
    vi.stubEnv(COPARENT_DUTY_SENDS_ENABLED_ENV, 'true');
    vi.stubEnv(STATED_CHILD_NAME_ENABLED_ENV, 'true');
    const home = await household([{ name: null, years: 14 }]);
    await block(home, 'evt-teen-hockey', 'hockey practice', MONDAY);
    const seen = await whatTheDutyComposerSees(home.familyId);
    expect(seen).not.toMatch(/hockey/i);
  });

  it('a named 14-year-old who is the only child is hidden the same way', async () => {
    vi.stubEnv(COPARENT_DUTY_SENDS_ENABLED_ENV, 'true');
    vi.stubEnv(STATED_CHILD_NAME_ENABLED_ENV, 'true');
    const home = await household([{ name: 'Noor', years: 14 }]);
    await block(home, 'evt-named-teen', 'hockey practice', MONDAY);
    const seen = await whatTheDutyComposerSees(home.familyId);
    expect(seen).not.toMatch(/hockey/i);
    expect(seen).not.toContain('Noor');
  });

  it("positive control: a named 8-year-old's title still reaches the week overview and the night-before line", async () => {
    vi.stubEnv(COPARENT_DUTY_SENDS_ENABLED_ENV, 'true');
    vi.stubEnv(STATED_CHILD_NAME_ENABLED_ENV, 'true');
    const home = await household([{ name: 'Maya', years: 8 }]);
    await block(home, 'evt-maya-hockey', 'hockey practice', MONDAY);
    const evening = await planFamilyDutyAsks(db.database, {
      familyId: home.familyId,
      now: SUNDAY_EVENING,
      bubbleLeaving: false,
    });
    if (!('plan' in evening)) throw new Error('expected a duty plan');
    expect(evening.plan.sendLines.map((row) => row.mode)).toContain('night_before');
    expect(
      evening.render.occasions.map((row) => ({ kid: row.kid, eventLabel: row.eventLabel })),
    ).toEqual([{ kid: 'Maya', eventLabel: 'hockey practice' }]);
    const seen = await whatTheDutyComposerSees(home.familyId);
    expect(seen).toContain('Monday hockey practice: Test');
  });

  it("a named 8-year-old and an unnamed 15-year-old: the teen's title is hidden, the 8-year-old's shows", async () => {
    vi.stubEnv(COPARENT_DUTY_SENDS_ENABLED_ENV, 'true');
    vi.stubEnv(STATED_CHILD_NAME_ENABLED_ENV, 'true');
    const home = await household([
      { name: 'Maya', years: 8 },
      { name: null, years: 15 },
    ]);
    await block(home, 'evt-maya-swim', 'Maya swim', MONDAY);
    await block(home, 'evt-teen-driving', 'driving lesson', TUESDAY);
    const seen = await whatTheDutyComposerSees(home.familyId);
    expect(seen).toContain('swim');
    expect(seen).not.toMatch(/driving/i);
  });
});
