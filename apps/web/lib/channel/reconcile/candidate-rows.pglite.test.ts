import { type Municipality, schema } from '@hale/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { townLabel } from '~/lib/channel/intake/radar-voice';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { loadClaimShadowContext } from './candidate-rows';
import { ForeignCandidateRow, buildClaimCandidates } from './candidates';
import type { ReconcileView } from './reconcile';
import { loadReconcileView } from './view';

/**
 * VIL-581 · the claim reader's candidate rows for a real family, against the real DDL.
 * The privacy half is the point: a 13+ child's row and a sensitive row reach the
 * reader only as "A private calendar item", and the zone is the recipient's own.
 * Names and places are invented.
 */

const NOW = new Date('2026-11-03T12:00:00Z');
const DAY = 86_400_000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY);
const PRIVATE = 'A private calendar item';
const MAPLE_BEND = 'maple_bend' as Municipality;

let db: TestDb;
let seq = 0;

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
afterEach(async () => {
  await db.exec('truncate table families, users, registration_windows cascade');
});

async function user(timezone: string): Promise<string> {
  seq += 1;
  const [row] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `sms:claim-rows-${seq}`, name: 'Parent', timezone })
    .returning({ id: schema.users.id });
  return row?.id as string;
}

async function family(opts: { language?: string; primary?: string | null } = {}) {
  const [row] = await db.database
    .insert(schema.families)
    .values({
      displayName: 'Household',
      provinceOrState: 'CO',
      onboardingStage: 'sms_active',
      primaryLanguage: opts.language ?? 'en',
    })
    .returning({ id: schema.families.id });
  const familyId = row?.id as string;
  if (opts.primary) {
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId, userId: opts.primary, role: 'primary_parent' });
  }
  return familyId;
}

async function child(familyId: string, dateOfBirth: string): Promise<string> {
  const [row] = await db.database
    .insert(schema.children)
    .values({ familyId, name: 'Kid', dateOfBirth })
    .returning({ id: schema.children.id });
  return row?.id as string;
}

async function event(
  familyId: string,
  title: string,
  startsAt: Date,
  extra: Partial<typeof schema.familyEvents.$inferInsert> = {},
) {
  await db.database
    .insert(schema.familyEvents)
    .values({ familyId, title, startsAt, source: 'parent', ...extra });
}

/** Family A, seeded per §7 L1: a Denver primary parent in fr, a teen and a toddler. */
async function seedA() {
  const primary = await user('America/Denver');
  const familyId = await family({ language: 'fr', primary });
  const teen = await child(familyId, '2011-01-01');
  const toddler = await child(familyId, '2023-05-01');
  await event(familyId, 'Dentist', at(1));
  await event(familyId, 'Teen practice ZQXJ1', at(2), { childId: teen });
  await event(familyId, 'Clinic ZQXJ2', at(3), { sensitive: true });
  await event(familyId, 'Swim lesson', at(4), { childId: toddler });
  await event(familyId, 'Past ZQXJ4', at(-1));
  await event(familyId, 'Deleted ZQXJ5', at(5), { deletedAt: NOW });
  await event(familyId, 'Mirror ZQXJ6', at(6), { googleEventId: 'g-mirror-1' });
  return { familyId, primary };
}

const ready = async (input: Parameters<typeof loadClaimShadowContext>[1]) => {
  const context = await loadClaimShadowContext(db.database, input);
  if (context.status !== 'ready') throw new Error(`expected ready, got ${context.reason}`);
  return context;
};

describe('loadClaimShadowContext — calendar rows', () => {
  it('household future rows in start order, a teen and a sensitive row redacted', async () => {
    const { familyId } = await seedA();
    const otherFamily = await family({ primary: await user('UTC') });
    await event(otherFamily, 'Other family ZQXJ3', at(1));

    const context = await ready({ familyId, now: NOW, parentUserId: null });
    const events = context.rows.filter((r) => r.source === 'calendar');
    expect(events.map((r) => r.what)).toEqual(['Dentist', PRIVATE, PRIVATE, 'Swim lesson']);
    const wire = JSON.stringify(context.rows);
    expect(wire).not.toContain('ZQXJ');
    // Positive control: titles that may travel do.
    expect(wire).toContain('Dentist');
  });
});

describe('loadClaimShadowContext — ledger rows', () => {
  it('open follow-up and registration commitments by due time; fulfilled and spot_watch absent', async () => {
    const { familyId } = await seedA();
    const commit = (
      commitmentKind: 'activity_followup' | 'registration_watch' | 'spot_watch',
      summary: string,
      dueAt: Date,
      extra: { fulfilledAt?: Date; fulfilledBy?: string } = {},
    ) =>
      db.database
        .insert(schema.agentCommitments)
        .values({ familyId, commitmentKind, summary, dueAt, createdFrom: 'msg-test', ...extra });
    await commit('registration_watch', 'Watch Y', at(3));
    await commit('activity_followup', 'Follow X', at(2));
    await commit('activity_followup', 'Done ZQXJ7', at(1), {
      fulfilledAt: NOW,
      fulfilledBy: 'msg-done',
    });
    await commit('spot_watch', 'Spot ZQXJ8', at(1));

    const context = await ready({ familyId, now: NOW, parentUserId: null });
    const open = context.rows.filter((r) => r.source === 'open_commitment');
    expect(open.map((r) => [r.kind, r.what])).toEqual([
      ['activity_followup', 'Follow X'],
      ['registration_watch', 'Watch Y'],
    ]);
    expect(JSON.stringify(context.rows)).not.toContain('ZQXJ');
  });

  it('a live sequence is a program row, and registrationLaddered agrees with it', async () => {
    const { familyId, primary } = await seedA();
    const window = async (cycleLabel: string) => {
      const [row] = await db.database
        .insert(schema.registrationWindows)
        .values({
          municipality: MAPLE_BEND,
          programDomain: 'swim',
          cycleLabel,
          openAt: at(20),
          sourceUrl: 'https://register.example.org/window',
          verifiedAt: NOW,
        })
        .returning({ id: schema.registrationWindows.id });
      return row?.id as string;
    };
    await db.database
      .insert(schema.registrationSequences)
      .values({ familyId, windowId: await window('winter'), parentUserId: primary });
    await db.database.insert(schema.registrationSequences).values({
      familyId,
      windowId: await window('autumn'),
      parentUserId: primary,
      outcome: 'registered',
    });

    const context = await ready({ familyId, now: NOW, parentUserId: null });
    const live = context.rows.filter((r) => r.source === 'live_sequence');
    expect(live.map((r) => r.what)).toEqual([`${townLabel(MAPLE_BEND)} swim winter registration`]);
    expect(
      (await loadReconcileView(db.database, { familyId, now: NOW })).registrationLaddered,
    ).toBe(live.length > 0);

    const bare = await family({ primary: await user('UTC') });
    const bareContext = await ready({ familyId: bare, now: NOW, parentUserId: null });
    const bareLive = bareContext.rows.filter((r) => r.source === 'live_sequence');
    expect(bareLive).toEqual([]);
    expect(
      (await loadReconcileView(db.database, { familyId: bare, now: NOW })).registrationLaddered,
    ).toBe(false);
  });

  it('a live watched page is a g row with its host only; a released one is absent', async () => {
    const { familyId, primary } = await seedA();
    const spot = (label: string, sourceUrl: string, extra: object = {}) =>
      db.database.insert(schema.watchedSpots).values({
        familyId,
        parentUserId: primary,
        sourceUrl,
        label,
        expiresAt: at(60),
        createdFrom: 'msg-watch',
        ...extra,
      });
    await spot('Saturday swim, ages 3-5', 'https://register.example.org/x');
    await spot('Released ZQXJ9', 'https://register.example.org/y', {
      releasedAt: NOW,
      releasedReason: 'expired',
    });

    const context = await ready({ familyId, now: NOW, parentUserId: null });
    const pages = context.rows.filter((r) => r.source === 'watched_page');
    expect(pages).toEqual([
      {
        familyId,
        source: 'watched_page',
        kind: 'spot_watch',
        what: 'Saturday swim, ages 3-5',
        host: 'register.example.org',
      },
    ]);
    expect(JSON.stringify(context.rows)).not.toContain('https://');
  });
});

describe('loadClaimShadowContext — the zone is the recipient’s own', () => {
  it('no recipient named: the primary parent’s zone and the family language', async () => {
    const { familyId } = await seedA();
    const context = await ready({ familyId, now: NOW, parentUserId: null });
    expect(context.language).toBe('fr');
    expect(context.timeZone).toBe('America/Denver');
  });

  it('a second parent is read in their own zone, not the primary’s', async () => {
    const { familyId } = await seedA();
    const second = await user('America/Phoenix');
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId, userId: second, role: 'co_parent' });
    const context = await ready({ familyId, now: NOW, parentUserId: second });
    expect(context.timeZone).toBe('America/Phoenix');
  });

  it('a recipient who is not a member of this family is no_time_zone: an id cannot borrow a zone', async () => {
    const { familyId } = await seedA();
    const outsider = await user('America/Phoenix');
    expect(
      await loadClaimShadowContext(db.database, { familyId, now: NOW, parentUserId: outsider }),
    ).toEqual({ status: 'skipped', reason: 'no_time_zone' });
  });

  it('an unknown recipient is no_time_zone, never a default zone', async () => {
    const { familyId } = await seedA();
    expect(
      await loadClaimShadowContext(db.database, {
        familyId,
        now: NOW,
        parentUserId: '00000000-0000-4000-8000-000000000000',
      }),
    ).toEqual({ status: 'skipped', reason: 'no_time_zone' });
  });

  it('a family with no primary parent and no recipient named is no_time_zone', async () => {
    const orphan = await family({ primary: null });
    expect(
      await loadClaimShadowContext(db.database, { familyId: orphan, now: NOW, parentUserId: null }),
    ).toEqual({
      status: 'skipped',
      reason: 'no_time_zone',
    });
  });
});

describe('loadClaimShadowContext — the coach’s view and pending intents', () => {
  it('a passed-in mintable window is w1 by town; a pending follow-up is p1', async () => {
    const { familyId } = await seedA();
    const view: ReconcileView = {
      openKinds: new Set(),
      pendingKinds: new Set(),
      registrationLaddered: false,
      mintableWindow: { town: 'Riverford', opensForFamilyAt: at(10) },
      scheduledTitles: [],
      statedBookings: ['Checkup'],
    };
    const context = await ready({
      familyId,
      now: NOW,
      parentUserId: null,
      view,
      pending: { activityFollowup: 'Swim classes', spotWatch: null },
    });
    const by = (source: string) => context.rows.filter((r) => r.source === source);
    expect(by('mintable_window').map((r) => r.what)).toEqual(['Riverford registration']);
    expect(by('pending').map((r) => [r.kind, r.what])).toEqual([
      ['activity_followup', 'Swim classes'],
    ]);
    expect(by('parent_stated').map((r) => r.what)).toEqual(['Checkup']);
  });
});

describe('loadClaimShadowContext — family scope', () => {
  it('every row is this family’s; the builder accepts them and refuses them for another', async () => {
    const { familyId } = await seedA();
    const context = await ready({ familyId, now: NOW, parentUserId: null });
    expect(context.rows.length).toBeGreaterThan(0);
    expect(context.rows.every((r) => r.familyId === familyId)).toBe(true);
    expect(() => buildClaimCandidates(familyId, context.rows, context.timeZone)).not.toThrow();
    expect(() => buildClaimCandidates('another-family', context.rows, context.timeZone)).toThrow(
      ForeignCandidateRow,
    );
  });
});
