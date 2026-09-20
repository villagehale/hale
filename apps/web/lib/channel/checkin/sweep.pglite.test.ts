import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { F14_ENABLED_ENV } from '~/lib/channel/f14';
import { buildOutboundGatePorts } from '~/lib/channel/outbound-gate';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { PRIVATE_EVENT_WHAT } from '~/lib/channel/coach/tools';
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

/**
 * Postgres stamps `created_at` with the real wall clock while the sweep runs on an
 * injected one, so a ledger row written under a fake evening looks minutes old rather
 * than months. In production those two clocks are the same instant — this puts them back
 * together, so the frequency cap's window is measured against the evening the message
 * actually went out rather than against the moment the test ran.
 */
async function alignLedgerToSendClock(): Promise<void> {
  await db.exec('update channel_messages set created_at = sent_at where sent_at is not null');
}

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
 * The real deps, with only the four things a test cannot have: the phone network, the
 * consent/enrolment state the gate reads from tables this test does not seed, and the
 * registration ladder. Selection, the children read, the dedupe key, the ledger write and
 * the prefs write are all production code.
 */
function prodDeps(
  sent: Array<{ to: string; body: string }>,
  options: { realCap?: boolean } = {},
): EveningCheckInDeps {
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
    resolveSendablePhone: async () => '+14165550100',
    transport: {
      send: async (input) => {
        sent.push(input);
        return { providerMessageId: `prov-${sent.length}` };
      },
    },
  };
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

    const sent: Array<{ to: string; body: string }> = [];
    const first = await runEveningCheckInSweep(db.database, prodDeps(sent), TORONTO_EVENING);
    expect({ inSlot: first.inSlot, asked: first.asked }).toEqual({ inSlot: 1, asked: 1 });
    expect(sent).toHaveLength(1);
    // The four-year-old is named; the fourteen-year-old is not, and the sentence reads as
    // though she were the only child on file (rule #1).
    expect(sent[0]?.body).toContain('with Mia?');
    expect(sent[0]?.body).not.toContain('Noah');

    const [ask] = await db.database
      .select()
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.familyId, toronto.familyId));
    expect(ask?.parentUserId).toBe(toronto.primaryUserId);
    expect(ask?.category).toBe('evening_check_in');
    expect(ask?.templateKey).toBe(CHECK_IN_ASK_TEMPLATE_KEY);
    await alignLedgerToSendClock();
    expect(ask?.dedupeKey).toBe(`evening_check_in:${toronto.familyId}:2026-07-05`);

    // Three hours later it is the Vancouver household's evening, and only theirs.
    const later = await runEveningCheckInSweep(db.database, prodDeps(sent), VANCOUVER_EVENING);
    expect({ inSlot: later.inSlot, asked: later.asked }).toEqual({ inSlot: 1, asked: 1 });
    const [second] = await db.database
      .select()
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.familyId, vancouver.familyId));
    expect(second?.parentUserId).toBe(vancouver.primaryUserId);
  });

  it('asks again the next evening — the nightly cap is not what holds the nightly question', async () => {
    await seedFamily({ primaryTz: 'America/Toronto' });
    const sent: Array<{ to: string; body: string }> = [];
    const first = await runEveningCheckInSweep(
      db.database,
      prodDeps(sent, { realCap: true }),
      TORONTO_EVENING,
    );
    expect(first.asked).toBe(1);
    await alignLedgerToSendClock();

    // The same slot, exactly 24h on — the worst case the cap's window has to clear, since
    // two consecutive evenings can be no further apart than this.
    const nextEvening = new Date(TORONTO_EVENING.getTime() + 24 * 3_600_000);
    const second = await runEveningCheckInSweep(
      db.database,
      prodDeps(sent, { realCap: true }),
      nextEvening,
    );
    expect({ asked: second.asked, capped: second.held.frequency_cap }).toEqual({
      asked: 1,
      capped: 0,
    });
    expect(sent).toHaveLength(2);
  });

  it('puts the least recently asked household at the front of the hour', async () => {
    // Inserted in the OPPOSITE order to the one the sweep must use, so a select that
    // leaned on the table's own order would send these two the other way round.
    const askedLastNight = await seedFamily({ primaryTz: 'America/Toronto' });
    await db.database.insert(schema.familyCheckInPrefs).values({
      familyId: askedLastNight.familyId,
      lastAskedAt: new Date(TORONTO_EVENING.getTime() - 24 * 3_600_000),
    });
    const neverAsked = await seedFamily({ primaryTz: 'America/Toronto' });

    const sent: Array<{ to: string; body: string }> = [];
    const order: string[] = [];
    const deps = prodDeps(sent);
    const { selectFamilies } = deps;
    deps.selectFamilies = async (database) => {
      const rows = await selectFamilies(database);
      order.push(...rows.map((row) => row.familyId));
      return rows;
    };

    await runEveningCheckInSweep(db.database, deps, TORONTO_EVENING);
    expect(order).toEqual([neverAsked.familyId, askedLastNight.familyId]);
  });

  it('is stopped three separate ways from asking twice in one evening', async () => {
    const { familyId } = await seedFamily({ primaryTz: 'America/Toronto' });
    const sent: Array<{ to: string; body: string }> = [];
    await runEveningCheckInSweep(db.database, prodDeps(sent), TORONTO_EVENING);
    expect(sent).toHaveLength(1);
    await alignLedgerToSendClock();

    const tenMinutesOn = new Date(TORONTO_EVENING.getTime() + 10 * 60_000);

    // 1. the prefs row this evening's ask wrote.
    const again = await runEveningCheckInSweep(
      db.database,
      prodDeps(sent, { realCap: true }),
      tenMinutesOn,
    );
    expect(again.skipped.asked_today).toBe(1);

    // 2. with that row gone — a prefs write that never landed — the real frequency cap.
    await db.database
      .delete(schema.familyCheckInPrefs)
      .where(eq(schema.familyCheckInPrefs.familyId, familyId));
    const capped = await runEveningCheckInSweep(
      db.database,
      prodDeps(sent, { realCap: true }),
      tenMinutesOn,
    );
    expect(capped.held.frequency_cap).toBe(1);

    // 3. and with the cap blinded too, the dedupe key on the ledger row itself.
    const deduped = await runEveningCheckInSweep(db.database, prodDeps(sent), tenMinutesOn);
    expect(deduped.duplicate).toBe(1);

    expect(sent).toHaveLength(1);
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
    const sent: Array<{ to: string; body: string }> = [];
    const result = await runEveningCheckInSweep(db.database, prodDeps(sent), TORONTO_EVENING);
    expect(result.asked).toBe(1);
    return { anchor: result.anchor, body: sent[0]?.body ?? '' };
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

    const { anchor, body } = await anchorCounts();
    expect(anchor.anchored).toBe(1);
    expect(body).toContain('swim');

    // THE TEMPLATE KEY DOES NOT CHANGE. A new key for the anchored form would make every
    // anchored evening's answer unattributable, and the ladder would count a silence for
    // a question the parent answered.
    const [ask] = await db.database
      .select()
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.familyId, seeded.familyId));
    expect(ask?.templateKey).toBe(CHECK_IN_ASK_TEMPLATE_KEY);
    await alignLedgerToSendClock();
    expect(
      await eveningCheckInQuestion(db.database, {
        familyId: seeded.familyId,
        parentUserId: seeded.primaryUserId,
        now: new Date(TORONTO_EVENING.getTime() + 20 * 60_000),
      }),
    ).not.toBeNull();
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
    expect(teen.body).not.toContain('orthodontist');
    expect(teen.body).not.toContain(PRIVATE_EVENT_WHAT);
    expect(teen.body).toContain('the kids');

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
    expect(control.body).toContain('orthodontist');
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
    const { anchor, body } = await anchorCounts();
    expect(anchor.private_event).toBe(1);
    expect(body).not.toContain('allergy');
    expect(body).not.toContain(PRIVATE_EVENT_WHAT);
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
    const { anchor, body } = await anchorCounts();
    expect(anchor.placement_lane).toBe(1);
    expect(body).not.toContain('gymnastics');
  });

  it('will not name a family-wide row with no child on it', async () => {
    const seeded = await seedAskedBefore([{ name: 'Mia', dateOfBirth: '2022-03-10' }]);
    await seedEvent({ familyId: seeded.familyId, title: 'Therapy', startsAt: AFTERNOON });
    const { anchor, body } = await anchorCounts();
    expect(anchor.no_child).toBe(1);
    expect(body).not.toContain('Therapy');
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
    const { anchor, body } = await anchorCounts();
    expect(anchor.no_event_today).toBe(1);
    for (const title of ['cancelled swim', 'yesterday soccer', 'bedtime story hour']) {
      expect(body, title).not.toContain(title);
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
    const { anchor, body } = await anchorCounts();
    expect(anchor.anchored).toBe(1);
    expect(body).toContain('gymnastics');
    expect(body).not.toContain('swim');
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
    expect(unspellable.body).toContain('Mia');

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
    expect(oversized.body).toContain('Mia');
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
    expect(off.body).not.toContain('swim');
    expect(off.body).toContain('Mia');
  });

  it('never names the table it reads through', async () => {
    // The tripwire in teen-access-outbound.test.ts bans `familyEvents` from any unlisted
    // file in lib/channel, and this sweep is deliberately not a listed door: its reader is
    // a closure over channelScheduleReader, which projects a private row before this file
    // ever sees it. Asserted on the source so a future edit that opens a fourth door has
    // to delete this test on purpose.
    const source = readFileSync(fileURLToPath(new URL('./sweep.ts', import.meta.url)), 'utf8');
    expect(/\bfamilyEvents\b/.test(source)).toBe(false);
    expect(source).toContain('channelScheduleReader');
  });
});
