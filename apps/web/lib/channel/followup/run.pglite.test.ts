import { randomUUID } from 'node:crypto';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { recordWatchConsent } from '~/lib/channel/intake/watch-consent';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { type FollowupSweepDeps, defaultFollowupSweepDeps, runFollowupSweep } from './run';

/**
 * WHICH PHONE THE ASK GOES TO, against the real DDL and through the real gate.
 *
 * Every other test of this sweep injects `loadDueActivities`, so the REAL union reader —
 * the one that decides whether a booking or a placement owns a due item, and which parent
 * it belongs to — is never executed by anything. This file drives
 * `defaultFollowupSweepDeps().loadDueActivities` directly, over rows, so the production
 * wiring is pinned rather than assumed.
 *
 * The voice is injected (it is a model call and this file is about the query and the
 * recipient, not the wording); everything else — the gate, the phone resolution, the
 * ledger — is the shipped path.
 */

let db: TestDb;

const NOW = new Date('2026-10-01T15:00:00.000Z');
/** Inside ACTIVITY_FOLLOWUP_MIN/MAX_AGE_DAYS (1..4) — yesterday morning. */
const YESTERDAY = new Date('2026-09-30T13:00:00.000Z');
/** The phone column is encrypted and blind-indexed, and the gate reads BOTH. A fresh
 * pair per household, because `parent_channels_phone_hash_active_idx` is unique ACROSS
 * families over live rows. */
const KEY = Buffer.alloc(32, 7).toString('base64');
let households = 0;

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

interface Household {
  familyId: string;
  primaryUserId: string;
  coParentUserId: string;
  integrationId: string;
  primaryPhone: string;
  coParentPhone: string;
}

/** A two-parent household, both on SMS unless told otherwise, both watch-consented. */
async function household(options: { coParentOnSms?: boolean } = {}): Promise<Household> {
  households += 1;
  const primaryPhone = `+1416555${String(1000 + households * 2).padStart(4, '0')}`;
  const coParentPhone = `+1416555${String(1001 + households * 2).padStart(4, '0')}`;
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Two parents', provinceOrState: 'ON', onboardingStage: 'sms_active' })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;

  const [primary] = await db.database
    .insert(schema.users)
    .values({ email: `${familyId}-a@example.test`, name: 'Ana', timezone: 'America/Toronto' })
    .returning({ id: schema.users.id });
  const [co] = await db.database
    .insert(schema.users)
    .values({ email: `${familyId}-b@example.test`, name: 'Ben', timezone: 'America/Toronto' })
    .returning({ id: schema.users.id });
  const primaryUserId = primary?.id as string;
  const coParentUserId = co?.id as string;

  await db.database.insert(schema.familyMembers).values([
    { familyId, userId: primaryUserId, role: 'primary_parent' },
    { familyId, userId: coParentUserId, role: 'co_parent' },
  ]);

  const channels = [
    {
      userId: primaryUserId,
      familyId,
      kind: 'sms' as const,
      phoneE164Encrypted: encryptString(primaryPhone),
      phoneE164Hash: phoneBlindIndex(primaryPhone),
      verifiedAt: NOW,
    },
  ];
  if (options.coParentOnSms !== false) {
    channels.push({
      userId: coParentUserId,
      familyId,
      kind: 'sms' as const,
      phoneE164Encrypted: encryptString(coParentPhone),
      phoneE164Hash: phoneBlindIndex(coParentPhone),
      verifiedAt: NOW,
    });
  }
  await db.database.insert(schema.parentChannels).values(channels);

  for (const userId of [primaryUserId, coParentUserId]) {
    await recordWatchConsent(
      db.database,
      {
        familyId,
        userId,
        granted: true,
        verbatimReply: 'yes',
        interpretation: 'the parent said yes to being watched',
        channelMessageId: null,
      },
      NOW,
    );
  }

  return {
    familyId,
    primaryUserId,
    coParentUserId,
    integrationId: randomUUID(),
    primaryPhone,
    coParentPhone,
  };
}

async function seedPlacement(h: Household, title = 'Soccer practice'): Promise<string> {
  const [row] = await db.database
    .insert(schema.familyEvents)
    .values({ familyId: h.familyId, title, startsAt: YESTERDAY, source: 'placement' })
    .returning({ id: schema.familyEvents.id });
  return row?.id as string;
}

async function seedBooking(
  h: Household,
  over: { parentUserId?: string; title?: string; eventId?: string | null } = {},
): Promise<string> {
  const [message] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId: h.familyId,
      parentUserId: over.parentUserId ?? h.coParentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'email_alert',
      templateKey: 'connector:email_alert',
      status: 'sent',
      sentAt: new Date('2026-09-20T15:00:00.000Z'),
    })
    .returning({ id: schema.channelMessages.id });
  const [row] = await db.database
    .insert(schema.activityBookings)
    .values({
      familyId: h.familyId,
      parentUserId: over.parentUserId ?? h.coParentUserId,
      integrationId: h.integrationId,
      messageId: randomUUID(),
      providerHost: 'recreation.brookfield.example.ca',
      title: over.title ?? 'Swim Level 2',
      firstSessionAt: YESTERDAY,
      eventId: over.eventId ?? null,
      channelMessageId: message?.id as string,
    })
    .returning({ id: schema.activityBookings.id });
  return row?.id as string;
}

/** The SHIPPED reader, not an injected one — this is the pin. */
function realReader() {
  return defaultFollowupSweepDeps().loadDueActivities;
}

/** ONE household per run, by the allowlist rather than the global flag: this file shares
 * a pglite instance, so every family a previous test seeded is still selectable and a
 * global arm would make "exactly one text" a count of the whole file. */
function armFor(h: Household): void {
  vi.stubEnv('FOLLOWUP_ASKS_FAMILY_ALLOWLIST', h.familyId);
}

/** The shipped deps with the MODEL replaced and nothing else: the gate, the phone, the
 * ledger, the thread and the union reader are all production's. */
function sweepDeps(transport: FakeTransport): FollowupSweepDeps {
  const base = defaultFollowupSweepDeps();
  return {
    ...base,
    transport,
    voice: { compose: async () => ({ status: 'composed', body: 'How did it go?' }) },
  };
}

describe('defaultFollowupSweepDeps().loadDueActivities — the real union reader', () => {
  it('returns a placement and a booking together, oldest first, each with its OWN parent', async () => {
    const h = await household();
    const placementId = await seedPlacement(h);
    const bookingId = await seedBooking(h);

    const due = await realReader()(
      db.database,
      { familyId: h.familyId, parentUserId: h.primaryUserId },
      NOW,
    );

    expect(due).toHaveLength(2);
    const byTable = Object.fromEntries(due.map((row) => [row.ref.table, row]));
    expect(byTable.family_events).toMatchObject({
      ref: { table: 'family_events', id: placementId },
      // A placement has no mailbox it came from — Hale put it there from an artifact the
      // household approved — so the family's primary is the honest recipient.
      parentUserId: h.primaryUserId,
      title: 'Soccer practice',
    });
    expect(byTable.activity_bookings).toMatchObject({
      ref: { table: 'activity_bookings', id: bookingId },
      // THE ITEM'S OWN PARENT. Blind the column and this assertion moves.
      parentUserId: h.coParentUserId,
      title: 'Swim Level 2',
      childId: null,
      sensitive: false,
    });
  });

  it('asks ONCE for a booking matched to a placement, and ONCE for one matched to a parent row', async () => {
    // BOTH branches. The naive `event_id IS NOT NULL` exclusion passes the first and
    // silently drops the second: a booking whose YES placed a source='parent' row is
    // invisible to the placement reader, which filters source='placement'.
    const h = await household();
    const placementId = await seedPlacement(h, 'Swim Level 2');
    await seedBooking(h, { eventId: placementId });

    const matchedToPlacement = await realReader()(
      db.database,
      { familyId: h.familyId, parentUserId: h.primaryUserId },
      NOW,
    );
    expect(matchedToPlacement.map((row) => row.ref.table)).toEqual(['family_events']);

    const other = await household();
    const [parentRow] = await db.database
      .insert(schema.familyEvents)
      .values({
        familyId: other.familyId,
        title: 'Swim Level 2',
        startsAt: YESTERDAY,
        source: 'parent',
      })
      .returning({ id: schema.familyEvents.id });
    const bookingId = await seedBooking(other, { eventId: parentRow?.id });

    const matchedToParent = await realReader()(
      db.database,
      { familyId: other.familyId, parentUserId: other.primaryUserId },
      NOW,
    );
    expect(matchedToParent).toHaveLength(1);
    expect(matchedToParent[0]?.ref).toEqual({ table: 'activity_bookings', id: bookingId });
  });

  it('honours the window at both ends', async () => {
    const h = await household();
    await seedBooking(h, { title: 'Too old' });
    await db.database
      .update(schema.activityBookings)
      .set({ firstSessionAt: new Date('2026-09-01T13:00:00.000Z') })
      .where(eq(schema.activityBookings.familyId, h.familyId));
    // Tomorrow: it has not happened yet.
    await seedBooking(h, { title: 'Not yet' });
    await db.database
      .update(schema.activityBookings)
      .set({ firstSessionAt: new Date('2026-10-02T13:00:00.000Z') })
      .where(eq(schema.activityBookings.title, 'Not yet'));
    const inWindow = await seedBooking(h, { title: 'Yesterday' });

    const due = await realReader()(
      db.database,
      { familyId: h.familyId, parentUserId: h.primaryUserId },
      NOW,
    );
    expect(due.map((row) => row.ref.id)).toEqual([inWindow]);
  });
});

describe('the ask reaches the item’s own parent', () => {
  it("texts the CO-PARENT for their booking and the PRIMARY for a placement", async () => {
    // The blocker this PR exists for: co-parent B's Gmail produced a question on primary
    // parent A's phone, one to four days after a class A may not know B registered for.
    // MUTATION: send to `family.parentUserId` instead of `event.parentUserId` and the
    // first half goes red while the second stays green - that asymmetry is the test.
    const h = await household();
    await seedBooking(h);
    const transport = new FakeTransport();
    armFor(h);

    const result = await runFollowupSweep(db.database, sweepDeps(transport), NOW);

    expect(result.activityAsked).toBe(1);
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.to).toBe(h.coParentPhone);
    expect(transport.sent.map((sent) => sent.to)).not.toContain(h.primaryPhone);

    // THE POSITIVE CONTROL. Without it, "A received nothing" passes on a sweep that
    // texts nobody at all.
    const other = await household();
    await seedPlacement(other);
    const second = new FakeTransport();
    armFor(other);
    const placementRun = await runFollowupSweep(db.database, sweepDeps(second), NOW);
    expect(placementRun.activityAsked).toBe(1);
    expect(second.sent.map((sent) => sent.to)).toContain(other.primaryPhone);
  });

  it('threads and audits against the item, and its parent, and nobody else', async () => {
    const h = await household();
    const bookingId = await seedBooking(h);
    const transport = new FakeTransport();
    armFor(h);

    await runFollowupSweep(db.database, sweepDeps(transport), NOW);

    const ledger = await db.database
      .select()
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.familyId, h.familyId));
    const ask = ledger.find((row) => row.templateKey === 'followup:activity');
    expect(ask?.parentUserId).toBe(h.coParentUserId);
    // The key is the booking's own uuid; uuids do not collide across tables, so the key
    // space needs no prefix.
    expect(ask?.dedupeKey).toBe(`followup:activity:${bookingId}`);

    const audit = await db.database
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, h.familyId));
    const asked = audit.find((row) => row.actionTaken === 'followup_activity_asked');
    expect(asked).toMatchObject({ targetTable: 'activity_bookings', targetId: bookingId });
    // The title is NOT recorded: the row already points at the table that holds it, and a
    // trail that copies content is a second place to leak it from (rule #1).
    expect(JSON.stringify(asked?.after)).not.toContain('Swim Level 2');
  });

  it("keeps a placement's dedupe key byte-identical to what it was before the union", async () => {
    // Nothing already claimed may be re-asked across this refactor. `ref.id` IS the event
    // id for a placement, so the string is unchanged.
    const h = await household();
    const placementId = await seedPlacement(h);
    const transport = new FakeTransport();
    armFor(h);

    await runFollowupSweep(db.database, sweepDeps(transport), NOW);

    const ledger = await db.database
      .select()
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.familyId, h.familyId));
    expect(ledger.find((row) => row.templateKey === 'followup:activity')?.dedupeKey).toBe(
      `followup:activity:${placementId}`,
    );
  });

  it('holds the ask as not_enrolled when the booking’s parent is not on SMS', async () => {
    // The gate names it, so no new FollowupSkipReason is needed - adding one would be a
    // second name for something that already has one.
    const h = await household({ coParentOnSms: false });
    await seedBooking(h);
    const transport = new FakeTransport();
    armFor(h);

    const result = await runFollowupSweep(db.database, sweepDeps(transport), NOW);

    expect(result.activityAsked).toBe(0);
    expect(result.held.not_enrolled).toBe(1);
    // And nothing was sent to the OTHER parent as a consolation.
    expect(transport.sent).toHaveLength(0);
  });
});
