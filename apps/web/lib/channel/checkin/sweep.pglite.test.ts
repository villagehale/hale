import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PRIVATE_EVENT_WHAT } from '~/lib/channel/coach/tools';
import { F14_ENABLED_ENV } from '~/lib/channel/f14';
import {
  FOLLOWUP_ASKS_ENABLED_ENV,
  defaultFollowupSweepDeps,
  runFollowupSweep,
} from '~/lib/channel/followup/run';
import { buildOutboundGatePorts } from '~/lib/channel/outbound-gate';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { CHECK_IN_ASK_TEMPLATE_KEY } from './copy';
import { eveningCheckInQuestion } from './reply';
import {
  CHECK_IN_ANCHOR_ENABLED_ENV,
  type EveningCheckInDeps,
  defaultEveningCheckInDeps,
  runEveningCheckInSweep,
} from './sweep';

/**
 * The evening sweep through its OWN production wiring, against real Postgres.
 *
 * sweep.test.ts injects `selectFamilies` and `loadNamableChildren`, which means it can
 * never fail on a bug inside either — and both hold a promise the feature is judged on.
 * Deleting the teen filter out of `readNamableChildren` (rule #1) or joining the co-parent
 * instead of the primary parent left all 150 of those tests green. This file is the pin on
 * the two readers themselves, plus the three independent rails that stop a second text the
 * same evening.
 */

/** 20:17 Toronto, which is 17:17 in Vancouver. */
const TORONTO_EVENING = new Date('2026-07-06T00:17:00.000Z');
/** Three hours on: 20:17 Vancouver, 23:17 Toronto. */
const VANCOUVER_EVENING = new Date('2026-07-06T03:17:00.000Z');

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
  process.env[F14_ENABLED_ENV] = 'true';
});

afterAll(async () => {
  delete process.env[F14_ENABLED_ENV];
  await db.close();
});

afterEach(() => {
  delete process.env[CHECK_IN_ANCHOR_ENABLED_ENV];
});

afterEach(async () => {
  await db.exec('truncate table families, users cascade');
});

async function seedFamily(input: {
  primaryTz: string;
  coParentTz?: string;
  stage?: 'sms_active' | 'pending_invite';
  scheduledDeletionAt?: Date;
  children?: Array<{ name: string; dateOfBirth: string }>;
}) {
  const [family] = await db.database
    .insert(schema.families)
    .values({
      displayName: 'Ana + kids',
      provinceOrState: 'ON',
      onboardingStage: input.stage ?? 'sms_active',
      scheduledDeletionAt: input.scheduledDeletionAt ?? null,
    })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;

  const [primary] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `sms:${familyId}:primary`, name: 'Ana', timezone: input.primaryTz })
    .returning({ id: schema.users.id });
  const primaryUserId = primary?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: primaryUserId, role: 'primary_parent' });

  if (input.coParentTz !== undefined) {
    const [co] = await db.database
      .insert(schema.users)
      .values({ externalAuthId: `sms:${familyId}:co`, name: 'Sam', timezone: input.coParentTz })
      .returning({ id: schema.users.id });
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId, userId: co?.id as string, role: 'co_parent' });
  }

  const childIds: Record<string, string> = {};
  for (const child of input.children ?? []) {
    const [row] = await db.database
      .insert(schema.children)
      .values({ familyId, ...child })
      .returning({ id: schema.children.id });
    childIds[child.name] = row?.id as string;
  }
  return { familyId, primaryUserId, childIds };
}

/** One row on the family's calendar, as a parent or a placement would leave it. */
async function seedEvent(input: {
  familyId: string;
  title: string;
  startsAt: Date;
  childId?: string | null;
  source?: 'parent' | 'channel' | 'email' | 'party' | 'placement';
  sensitive?: boolean;
  deletedAt?: Date;
}): Promise<void> {
  await db.database.insert(schema.familyEvents).values({
    familyId: input.familyId,
    title: input.title,
    startsAt: input.startsAt,
    childId: input.childId ?? null,
    source: input.source ?? 'parent',
    sensitive: input.sensitive ?? false,
    deletedAt: input.deletedAt ?? null,
  });
}

/**
 * The real deps, with only what a test cannot have: the consent and enrolment state the
 * gate reads from tables this test does not seed, and the registration ladder. Selection,
 * the children read, and the candidate write are production code. The sweep does not text.
 */
function prodDeps(options: { realCap?: boolean } = {}): EveningCheckInDeps {
  return {
    ...defaultEveningCheckInDeps(),
    buildGate: (database) => ({
      ...buildOutboundGatePorts(database),
      channelEnrolled: async () => true,
      watchConsentGranted: async () => true,
      proactiveSentSince: async () => false,
      ...(options.realCap === true ? {} : { countProactiveSends: async () => 0 }),
    }),
    readinessStanding: async () => null,
  };
}

async function candidateFor(familyId: string) {
  const [row] = await db.database
    .select()
    .from(schema.proactiveCandidates)
    .where(eq(schema.proactiveCandidates.familyId, familyId));
  return row;
}

describe('who the sweep actually selects, and what it may call their children', () => {
  it("runs on the PRIMARY parent's clock and never names a teenager", async () => {
    // Two live households whose parents are in opposite zones, so a join on the wrong
    // member sends at the wrong hour rather than merely picking the wrong row.
    const toronto = await seedFamily({
      primaryTz: 'America/Toronto',
      coParentTz: 'America/Vancouver',
      children: [
        { name: 'Mia', dateOfBirth: '2022-03-10' },
        { name: 'Noah', dateOfBirth: '2012-02-01' },
      ],
    });
    const vancouver = await seedFamily({
      primaryTz: 'America/Vancouver',
      coParentTz: 'America/Toronto',
    });
    await seedFamily({ primaryTz: 'America/Toronto', stage: 'pending_invite' });
    await seedFamily({ primaryTz: 'America/Toronto', scheduledDeletionAt: new Date() });

    const first = await runEveningCheckInSweep(db.database, prodDeps(), TORONTO_EVENING);
    expect({ inSlot: first.inSlot, queued: first.queued }).toEqual({ inSlot: 1, queued: 1 });
    const offer = await candidateFor(toronto.familyId);
    // The four-year-old is a fact the writer may name. The fourteen-year-old is not.
    expect(offer?.what).toContain('Mia');
    expect(offer?.what).not.toContain('Noah');
    expect(offer?.parentUserId).toBe(toronto.primaryUserId);
    expect(offer?.kind).toBe('evening_check_in');
    expect(offer?.templateKey).toBe(CHECK_IN_ASK_TEMPLATE_KEY);
    expect(offer?.dedupeKey).toBe(`evening_check_in:${toronto.familyId}:2026-07-05`);
    expect(offer?.what).not.toMatch(/\b(?:reply|text|send)\s+[A-Z]{2,}\b/);

    // Three hours later it is the Vancouver household's evening, and only theirs.
    const later = await runEveningCheckInSweep(db.database, prodDeps(), VANCOUVER_EVENING);
    expect({ inSlot: later.inSlot, queued: later.queued }).toEqual({ inSlot: 1, queued: 1 });
    const second = await candidateFor(vancouver.familyId);
    expect(second?.parentUserId).toBe(vancouver.primaryUserId);
  });

  it('offers again the next evening — queueing is not a send, so the cap does not hold it', async () => {
    await seedFamily({ primaryTz: 'America/Toronto' });
    const first = await runEveningCheckInSweep(
      db.database,
      prodDeps({ realCap: true }),
      TORONTO_EVENING,
    );
    expect(first.queued).toBe(1);

    // The same slot, exactly 24h on. The dedupe key is the local date, so tonight's
    // row does not hold tomorrow's question. A count is not a hold.
    const nextEvening = new Date(TORONTO_EVENING.getTime() + 24 * 3_600_000);
    const second = await runEveningCheckInSweep(
      db.database,
      prodDeps({ realCap: true }),
      nextEvening,
    );
    expect({ queued: second.queued, quiet: second.held.quiet_hours }).toEqual({
      queued: 1,
      quiet: 0,
    });
  });

  it('puts the least recently asked household at the front of the hour', async () => {
    const askedLastNight = await seedFamily({ primaryTz: 'America/Toronto' });
    await db.database.insert(schema.familyCheckInPrefs).values({
      familyId: askedLastNight.familyId,
      lastAskedAt: new Date(TORONTO_EVENING.getTime() - 24 * 3_600_000),
    });
    const neverAsked = await seedFamily({ primaryTz: 'America/Toronto' });

    const order: string[] = [];
    const deps = prodDeps();
    const { selectFamilies } = deps;
    deps.selectFamilies = async (database) => {
      const rows = await selectFamilies(database);
      order.push(...rows.map((row) => row.familyId));
      return rows;
    };

    await runEveningCheckInSweep(db.database, deps, TORONTO_EVENING);
    expect(order).toEqual([neverAsked.familyId, askedLastNight.familyId]);
  });

  it('is stopped two ways from offering twice in one evening, and a prior send is not a third', async () => {
    const seeded = await seedFamily({ primaryTz: 'America/Toronto' });
    await runEveningCheckInSweep(db.database, prodDeps(), TORONTO_EVENING);
    expect(await candidateFor(seeded.familyId)).toBeDefined();

    const tenMinutesOn = new Date(TORONTO_EVENING.getTime() + 10 * 60_000);

    // 1. The candidate's dedupe key. Queueing does not stamp last_asked_at.
    const again = await runEveningCheckInSweep(db.database, prodDeps(), tenMinutesOn);
    expect(again.duplicate).toBe(1);

    // 2. A send that already landed tonight. The ask clock is the send, not the queue.
    await db.database
      .delete(schema.proactiveCandidates)
      .where(eq(schema.proactiveCandidates.familyId, seeded.familyId));
    await db.database.insert(schema.familyCheckInPrefs).values({
      familyId: seeded.familyId,
      lastAskedAt: tenMinutesOn,
    });
    const asked = await runEveningCheckInSweep(db.database, prodDeps(), tenMinutesOn);
    expect(asked.skipped.asked_today).toBe(1);

    // A count of tonight's send is not a hold. With the ask clock cleared, the
    // same evening can be offered again.
    await db.database
      .delete(schema.familyCheckInPrefs)
      .where(eq(schema.familyCheckInPrefs.familyId, seeded.familyId));
    await db.database.insert(schema.channelMessages).values({
      familyId: seeded.familyId,
      parentUserId: seeded.primaryUserId,
      channel: 'sms',
      direction: 'out',
      category: 'evening_check_in',
      templateKey: CHECK_IN_ASK_TEMPLATE_KEY,
      status: 'sent',
      dedupeKey: `evening_check_in:sent:${seeded.familyId}`,
      createdAt: tenMinutesOn,
      sentAt: tenMinutesOn,
    });
    const afterSend = await runEveningCheckInSweep(
      db.database,
      prodDeps({ realCap: true }),
      tenMinutesOn,
    );
    expect(afterSend.queued).toBe(1);
    expect(afterSend.held.quiet_hours).toBe(0);
  });
});

/**
 * THE ANCHOR, THROUGH ITS OWN PRODUCTION WIRING.
 *
 * `defaultEveningCheckInDeps().readTodayActivity` is the thing under test, not a fake of
 * it: the six subtractions live inside that closure, and a hand-built reader would be
 * testing this file's opinion of what a teen's row looks like rather than what the
 * projecting door actually hands over (memory: injected fakes hide callee bugs; pin
 * production wiring, not just units).
 *
 * The clock is TORONTO_EVENING — 20:17 on 2026-07-05 in Toronto — so "earlier today" is
 * anything before 00:17Z on the 6th, and 21:30 local has not happened yet.
 */
describe('what the evening question may name', () => {
  /** 16:00 on 2026-07-05 in Toronto. */
  const AFTERNOON = new Date('2026-07-05T20:00:00.000Z');
  /** 17:00 the same day. */
  const LATE_AFTERNOON = new Date('2026-07-05T21:00:00.000Z');
  /** 21:30 the same day — after the 20:17 ask. */
  const TONIGHT = new Date('2026-07-06T01:30:00.000Z');
  /** 16:00 the day BEFORE. */
  const YESTERDAY = new Date('2026-07-04T20:00:00.000Z');

  async function anchorCounts() {
    const result = await runEveningCheckInSweep(db.database, prodDeps(), TORONTO_EVENING);
    expect(result.queued).toBe(1);
    const [row] = await db.database
      .select({ what: schema.proactiveCandidates.what })
      .from(schema.proactiveCandidates);
    return { anchor: result.anchor, what: row?.what ?? '' };
  }

  /** A household that has been asked before, so tonight is a pooled question. */
  async function seedAskedBefore(children: Array<{ name: string; dateOfBirth: string }>) {
    const seeded = await seedFamily({ primaryTz: 'America/Toronto', children });
    await db.database.insert(schema.familyCheckInPrefs).values({
      familyId: seeded.familyId,
      lastAskedAt: new Date(TORONTO_EVENING.getTime() - 24 * 3_600_000),
    });
    process.env[CHECK_IN_ANCHOR_ENABLED_ENV] = 'true';
    return seeded;
  }

  it("names an under-13's own activity from earlier today, and files it as the standing question", async () => {
    const seeded = await seedAskedBefore([{ name: 'Mia', dateOfBirth: '2022-03-10' }]);
    await seedEvent({
      familyId: seeded.familyId,
      title: 'swim',
      startsAt: AFTERNOON,
      childId: seeded.childIds.Mia as string,
    });

    const { anchor, what } = await anchorCounts();
    expect(anchor.anchored).toBe(1);
    expect(what).toContain('swim');

    const offer = await candidateFor(seeded.familyId);
    expect(offer?.templateKey).toBe(CHECK_IN_ASK_TEMPLATE_KEY);

    const [row] = await db.database
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, seeded.familyId));
    expect(row?.actionTaken).toBe('evening_check_in_queued');
    expect(row?.after).toEqual({ anchored: true });
    expect(JSON.stringify(row)).not.toContain('swim');

    // A queue is not a question. The standing ask appears when the review sends.
    expect(
      await eveningCheckInQuestion(db.database, {
        familyId: seeded.familyId,
        parentUserId: seeded.primaryUserId,
        now: new Date(TORONTO_EVENING.getTime() + 20 * 60_000),
      }),
    ).toBeNull();
  });

  it("will not name a 13-year-old's row, and does not say one exists — with the sibling case as the control", async () => {
    // A 14-year-old at the clock above. The absence assertion below fails OPEN on its own
    // (a lane that anchored nothing at all would pass it), so the second household is the
    // positive control: the SAME code path, one year of age apart, does name it.
    const teenOnly = await seedAskedBefore([{ name: 'Noah', dateOfBirth: '2012-02-01' }]);
    await seedEvent({
      familyId: teenOnly.familyId,
      title: 'orthodontist',
      startsAt: AFTERNOON,
      childId: teenOnly.childIds.Noah as string,
    });

    const teen = await anchorCounts();
    expect(teen.anchor.private_event).toBe(1);
    expect(teen.anchor.anchored).toBe(0);
    expect(teen.what).not.toContain('orthodontist');
    expect(teen.what).not.toContain(PRIVATE_EVENT_WHAT);
    expect(teen.what).toBe('how the day went');

    await db.exec('truncate table families, users cascade');
    const sibling = await seedAskedBefore([{ name: 'Mia', dateOfBirth: '2022-03-10' }]);
    await seedEvent({
      familyId: sibling.familyId,
      title: 'orthodontist',
      startsAt: AFTERNOON,
      childId: sibling.childIds.Mia as string,
    });
    const control = await anchorCounts();
    expect(control.anchor.anchored).toBe(1);
    expect(control.what).toContain('orthodontist');
  });

  it('will not name a sensitive row even for an under-13', async () => {
    const seeded = await seedAskedBefore([{ name: 'Mia', dateOfBirth: '2022-03-10' }]);
    await seedEvent({
      familyId: seeded.familyId,
      title: 'allergy clinic',
      startsAt: AFTERNOON,
      childId: seeded.childIds.Mia as string,
      sensitive: true,
    });
    const { anchor, what } = await anchorCounts();
    expect(anchor.private_event).toBe(1);
    expect(what).not.toContain('allergy');
    expect(what).not.toContain(PRIVATE_EVENT_WHAT);
  });

  it('leaves what Hale itself placed to the follow-up lane', async () => {
    // Both sweeps fire in the same hourly tick under separate gate budgets, so without
    // this the same event is named twice in thirteen hours in two different registers.
    const seeded = await seedAskedBefore([{ name: 'Mia', dateOfBirth: '2022-03-10' }]);
    await seedEvent({
      familyId: seeded.familyId,
      title: 'gymnastics',
      startsAt: AFTERNOON,
      childId: seeded.childIds.Mia as string,
      source: 'placement',
    });
    const { anchor, what } = await anchorCounts();
    expect(anchor.placement_lane).toBe(1);
    expect(what).not.toContain('gymnastics');
    const [row] = await db.database
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, seeded.familyId));
    expect(row?.after).toEqual({ anchored: false });

    // POSITIVE CONTROL, a household over: the absence above fails open on its own, and
    // the only difference here is the provenance column. Same child, same title, same
    // hour — a row the FAMILY left is named.
    await db.exec('truncate table families, users cascade');
    const own = await seedAskedBefore([{ name: 'Mia', dateOfBirth: '2022-03-10' }]);
    await seedEvent({
      familyId: own.familyId,
      title: 'gymnastics',
      startsAt: AFTERNOON,
      childId: own.childIds.Mia as string,
      source: 'parent',
    });
    const control = await anchorCounts();
    expect(control.anchor.anchored).toBe(1);
    expect(control.what).toContain('gymnastics');
  });

  it('will not name a family-wide row with no child on it', async () => {
    const seeded = await seedAskedBefore([{ name: 'Mia', dateOfBirth: '2022-03-10' }]);
    await seedEvent({ familyId: seeded.familyId, title: 'Therapy', startsAt: AFTERNOON });
    const { anchor, what } = await anchorCounts();
    expect(anchor.no_child).toBe(1);
    expect(what).not.toContain('Therapy');

    // POSITIVE CONTROL: the same row with a child on it IS named, so the silence above is
    // the childId subtraction and not the anchor lane failing to run.
    await db.exec('truncate table families, users cascade');
    const hers = await seedAskedBefore([{ name: 'Mia', dateOfBirth: '2022-03-10' }]);
    await seedEvent({
      familyId: hers.familyId,
      title: 'Therapy',
      startsAt: AFTERNOON,
      childId: hers.childIds.Mia as string,
    });
    const control = await anchorCounts();
    expect(control.anchor.anchored).toBe(1);
    expect(control.what).toContain('Therapy');
  });

  it('ignores a cancelled row, a row from yesterday, and a row that has not happened yet', async () => {
    const seeded = await seedAskedBefore([{ name: 'Mia', dateOfBirth: '2022-03-10' }]);
    const childId = seeded.childIds.Mia as string;
    await seedEvent({
      familyId: seeded.familyId,
      title: 'cancelled swim',
      startsAt: AFTERNOON,
      childId,
      deletedAt: new Date('2026-07-05T12:00:00.000Z'),
    });
    await seedEvent({
      familyId: seeded.familyId,
      title: 'yesterday soccer',
      startsAt: YESTERDAY,
      childId,
    });
    await seedEvent({
      familyId: seeded.familyId,
      title: 'bedtime story hour',
      startsAt: TONIGHT,
      childId,
    });
    const { anchor, what } = await anchorCounts();
    expect(anchor.no_event_today).toBe(1);
    for (const title of ['cancelled swim', 'yesterday soccer', 'bedtime story hour']) {
      expect(what, title).not.toContain(title);
    }
  });

  it('takes the LATEST of two that already happened today', async () => {
    const seeded = await seedAskedBefore([{ name: 'Mia', dateOfBirth: '2022-03-10' }]);
    const childId = seeded.childIds.Mia as string;
    await seedEvent({ familyId: seeded.familyId, title: 'swim', startsAt: AFTERNOON, childId });
    await seedEvent({
      familyId: seeded.familyId,
      title: 'gymnastics',
      startsAt: LATE_AFTERNOON,
      childId,
    });
    const { anchor, what } = await anchorCounts();
    expect(anchor.anchored).toBe(1);
    expect(what).toContain('gymnastics');
    expect(what).not.toContain('swim');
  });

  it('refuses a title it cannot spell, and one that will not fit', async () => {
    const seeded = await seedAskedBefore([{ name: 'Mia', dateOfBirth: '2022-03-10' }]);
    await seedEvent({
      familyId: seeded.familyId,
      title: 'natation à la piscine — mercredi',
      startsAt: AFTERNOON,
      childId: seeded.childIds.Mia as string,
    });
    const unspellable = await anchorCounts();
    expect(unspellable.anchor.not_gsm7).toBe(1);
    expect(unspellable.what).toContain('Mia');

    await db.exec('truncate table families, users cascade');
    const long = await seedAskedBefore([{ name: 'Mia', dateOfBirth: '2022-03-10' }]);
    await seedEvent({
      familyId: long.familyId,
      title: `${'Stouffville Leisure Centre parent and tot swim '.repeat(4)}session`,
      startsAt: AFTERNOON,
      childId: long.childIds.Mia as string,
    });
    const oversized = await anchorCounts();
    expect(oversized.anchor.over_segment).toBe(1);
    expect(oversized.what).toContain('Mia');
  });

  it("is off unless the flag is exactly 'true' — a trailing newline is not", async () => {
    const seeded = await seedAskedBefore([{ name: 'Mia', dateOfBirth: '2022-03-10' }]);
    await seedEvent({
      familyId: seeded.familyId,
      title: 'swim',
      startsAt: AFTERNOON,
      childId: seeded.childIds.Mia as string,
    });
    process.env[CHECK_IN_ANCHOR_ENABLED_ENV] = 'true\n';
    const off = await anchorCounts();
    expect(off.anchor.flag_off).toBe(1);
    expect(off.what).not.toContain('swim');
    expect(off.what).toContain('Mia');
  });

  it('never names the table it reads through', async () => {
    // The tripwire in teen-access-outbound.test.ts bans `familyEvents` from any unlisted
    // file in lib/channel, and this sweep is deliberately not a listed door: its reader is
    // a closure over channelScheduleReader, which projects a private row before this file
    // ever sees it. Asserted on the source so a future edit that opens a fifth door has
    // to delete this test on purpose.
    const source = readFileSync(fileURLToPath(new URL('./sweep.ts', import.meta.url)), 'utf8');
    expect(/\bfamilyEvents\b/.test(source)).toBe(false);
    expect(source).toContain('channelScheduleReader');
  });
});

/**
 * THE TWO LANES, IN THE ORDER THE CRON RUNS THEM (app/api/cron/nudge/route.ts: the
 * follow-up sweep, then the evening check-in).
 *
 * They sit in SEPARATE gate categories, so nothing in the rails stops one family getting
 * both in the same tick — which is correct only while they are asking about different
 * events. The whole provenance subtraction exists for this, and neither lane knows the
 * other exists, so this is the only place a regression would show: an anchor that stopped
 * refusing placements would name yesterday's gymnastics at 20:17 and the composed
 * follow-up would ask about the same gymnastics an hour later, in a second register.
 */
describe('the evening anchor and the composed follow-up, in one tick', () => {
  /** 16:00 today in Toronto — the family's own row. */
  const TODAY_AFTERNOON = new Date('2026-07-05T20:00:00.000Z');
  /** 09:00 YESTERDAY in Toronto — the placement, inside the follow-up's 1-4 day window. */
  const YESTERDAY_MORNING = new Date('2026-07-04T13:00:00.000Z');

  it("asks about the family's own day, and about what Hale placed, as two different asks", async () => {
    const seeded = await seedFamily({
      primaryTz: 'America/Toronto',
      children: [{ name: 'Mia', dateOfBirth: '2022-03-10' }],
    });
    await db.database.insert(schema.familyCheckInPrefs).values({
      familyId: seeded.familyId,
      lastAskedAt: new Date(TORONTO_EVENING.getTime() - 24 * 3_600_000),
    });
    process.env[CHECK_IN_ANCHOR_ENABLED_ENV] = 'true';
    process.env[FOLLOWUP_ASKS_ENABLED_ENV] = 'true';
    const childId = seeded.childIds.Mia as string;
    await seedEvent({
      familyId: seeded.familyId,
      title: 'gymnastics',
      startsAt: YESTERDAY_MORNING,
      childId,
      source: 'placement',
    });
    await seedEvent({
      familyId: seeded.familyId,
      title: 'swim',
      startsAt: TODAY_AFTERNOON,
      childId,
      source: 'parent',
    });

    // The follow-up first, exactly as the tick does it. Its voice is the one injected
    // port here: what the model's words are worth is measured in the eval suite (rule
    // #8), and what this test owns is WHICH EVENT each lane picked.
    const followupSent: Array<{ to: string; body: string }> = [];
    const followup = await runFollowupSweep(
      db.database,
      {
        ...defaultFollowupSweepDeps(),
        buildGate: (database) => ({
          ...buildOutboundGatePorts(database),
          channelEnrolled: async () => true,
          watchConsentGranted: async () => true,
          proactiveSentSince: async () => false,
        }),
        resolveSendablePhone: async () => '+14165550100',
        transport: {
          send: async (input) => {
            followupSent.push(input);
            return { providerMessageId: `followup-${followupSent.length}` };
          },
        },
        voice: {
          compose: async (request) => ({
            status: 'composed',
            body:
              request.kind === 'activity'
                ? `How did ${request.activity} go in the end? No pressure to reply.`
                : 'Did you end up connecting?',
          }),
        },
      },
      TORONTO_EVENING,
    );

    // A count is not a hold. The follow-up that just went out does not stop the
    // evening offer. The two lanes still name different activities.
    const checkIn = await runEveningCheckInSweep(
      db.database,
      prodDeps({ realCap: true }),
      TORONTO_EVENING,
    );

    expect({ followup: followup.activityAsked, checkIn: checkIn.queued }).toEqual({
      followup: 1,
      checkIn: 1,
    });
    const offer = await candidateFor(seeded.familyId);
    // Two events, two lanes, and the evening lane queues facts rather than a sentence.
    expect(followupSent[0]?.body).toContain('gymnastics');
    expect(followupSent[0]?.body).not.toContain('swim');
    expect(offer?.what).toContain('swim');
    expect(offer?.what).not.toContain('gymnastics');
    expect(checkIn.anchor.anchored).toBe(1);
  });

  afterEach(() => {
    delete process.env[FOLLOWUP_ASKS_ENABLED_ENV];
  });
});
