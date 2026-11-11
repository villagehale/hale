import { schema } from '@hale/db';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TEEN_REDACTED_PLACEHOLDER } from '~/lib/dashboard/mappers';
import {
  type WorkstreamOp,
  applyWorkstreamOp,
  expireStaleWorkstreams,
} from '~/lib/memory/workstreams';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { assembleFamilyExport } from './export';

/**
 * VIL-597 G18. The right-to-access copy carries what Hale remembers about the family,
 * and a schema-driven ratchet keeps it that way: every table with a `family_id` is
 * either read by the export or named below with the reason it is not.
 */

const NOW = new Date('2026-11-08T15:00:00.000Z');
const TEEN_NAME = 'Tamsin';

/**
 * The tables that were still unreviewed when the set was frozen (VIL-622). This list
 * only shrinks: a table leaves it when the export reads it or a written reason replaces
 * `unreviewed`. A table that is not on it cannot be marked `unreviewed`, so every table
 * added after the freeze declares its export.
 */
const UNREVIEWED_AT_FREEZE: ReadonlySet<string> = new Set([
  'caregiver_invites',
  'channel_pending_asks',
  'chat_attachments',
  'email_alert_offers',
  'email_forwards_pending',
  'email_sends',
  'event_reminders',
  'family_active_days',
  'family_areas',
  'family_forward_senders',
  'family_interest_settings',
  'family_invites',
  'family_link_wallets',
  'family_plans',
  'family_upgrade_offers',
  'family_watch_subscriptions',
  'group_decision_sync',
  'group_reminders',
  'interest_next_step_offers',
  'join_invites',
  'kid_interests',
  'kid_passport_profiles',
  'kid_relevance_verdicts',
  'linq_group_carpools',
  'linq_group_members',
  'linq_group_onboarding',
  'linq_group_plans',
  'linq_group_polls',
  'linq_group_rosters',
  'linq_multi_family_joins',
  'linq_multi_family_ledger',
  'linq_multi_family_members',
  'linq_poll_options',
  'linq_shared_group_people',
  'mcp_authorization_codes',
  'optional_ask_ledger',
  'parent_calendar_blocks',
  'parent_channels',
  'party_invites',
  'pending_disambiguations',
  'proactive_candidates',
  'provider_signup_sessions',
  'sms_intake_sessions',
  'social_spots',
  'teen_access_grants',
  'village_endorsements',
  'week_plans',
]);

const UNREVIEWED = 'unreviewed';

/** The entries marked unreviewed that the freeze does not hold. */
function unreviewedAfterFreeze(entries: Record<string, string>): string[] {
  return Object.entries(entries)
    .filter(([table, reason]) => reason === UNREVIEWED && !UNREVIEWED_AT_FREEZE.has(table))
    .map(([table]) => table)
    .sort();
}

/**
 * Family tables the export does not read, and why. A new `family_id` table fails the
 * ratchet until it is exported or added here with a reason. Only tables in
 * UNREVIEWED_AT_FREEZE may say `unreviewed`; that is a known gap to work down, not a
 * decision.
 */
const NOT_IN_EXPORT: Record<string, string> = {
  family_sweep_marks: 'scheduling metadata, no family content',
  capability_denials:
    'a capability key and two message ids; each no and correction is an exported audit row',
  family_memory_aliases: 'derived search tokens of facts already exported',
  agent_runs: 'model usage accounting, no family content',
  caregiver_invites: 'unreviewed',
  channel_pending_asks: 'unreviewed',
  chat_attachments: 'unreviewed',
  email_alert_offers: 'unreviewed',
  email_forwards_pending: 'unreviewed',
  email_sends: 'unreviewed',
  event_reminders: 'unreviewed',
  family_active_days: 'unreviewed',
  family_areas: 'unreviewed',
  family_forward_senders: 'unreviewed',
  family_interest_settings: 'unreviewed',
  family_invites: 'unreviewed',
  family_link_wallets: 'unreviewed',
  family_provider_data_keys: 'wrapped DEKs; not family content',
  family_plans: 'unreviewed',
  family_upgrade_offers: 'unreviewed',
  family_watch_subscriptions: 'unreviewed',
  group_decision_sync: 'unreviewed',
  group_reminders: 'unreviewed',
  interest_next_step_offers: 'unreviewed',
  join_invites: 'unreviewed',
  kid_interests: 'unreviewed',
  kid_passport_profiles: 'unreviewed',
  kid_relevance_verdicts: 'unreviewed',
  linq_group_carpools: 'unreviewed',
  linq_group_members: 'unreviewed',
  linq_group_onboarding: 'unreviewed',
  linq_group_plans: 'unreviewed',
  linq_group_polls: 'unreviewed',
  linq_group_rosters: 'unreviewed',
  linq_multi_family_joins: 'unreviewed',
  linq_multi_family_ledger: 'unreviewed',
  linq_multi_family_members: 'unreviewed',
  linq_poll_options: 'unreviewed',
  linq_shared_group_people: 'unreviewed',
  mcp_authorization_codes: 'unreviewed',
  optional_ask_ledger: 'unreviewed',
  parent_calendar_blocks: 'unreviewed',
  parent_channels: 'unreviewed',
  party_invites: 'unreviewed',
  pending_disambiguations: 'unreviewed',
  proactive_candidates: 'unreviewed',
  provider_login_links: 'hashed login tokens; never exported',
  provider_login_notices: 'send ledger of kind and host; body is never stored',
  provider_signup_credentials: 'encrypted city credentials; never exported',
  provider_signup_sessions: 'unreviewed',
  sms_intake_sessions: 'unreviewed',
  social_spots: 'unreviewed',
  teen_access_grants: 'unreviewed',
  team_schedule_changes:
    'VIL-662 pointer from a Gmail id to the calendar move it proposed; the event and action are exported',
  village_endorsements: 'unreviewed',
  week_plans: 'unreviewed',
};

function familyTables(): string[] {
  return (Object.values(schema) as unknown[])
    .filter((value): value is PgTable => value instanceof PgTable)
    .map((table) => getTableConfig(table))
    .filter((config) => config.columns.some((column) => column.name === 'family_id'))
    .map((config) => config.name)
    .sort();
}

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

async function seedParent(familyId: string) {
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `sms:${familyId}:parent`, name: 'Parent' })
    .returning({ id: schema.users.id });
  const userId = user?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId, role: 'primary_parent' });
  return userId;
}

describe('family memory in the right-to-access copy', () => {
  it('exports facts, episodes, jobs and promises, with a 13+ child withheld', async () => {
    const { familyId, parentUserId: actorUserId } = await seedFamily(db.database);
    const [kid, teen] = await db.database
      .insert(schema.children)
      .values([
        { familyId, name: 'Pip', dateOfBirth: '2023-01-10' },
        { familyId, name: TEEN_NAME, dateOfBirth: '2012-02-01' },
      ])
      .returning({ id: schema.children.id });
    const kidId = kid?.id as string;
    const teenId = teen?.id as string;

    await db.database.insert(schema.familyMemoryFacts).values([
      {
        familyId,
        childId: kidId,
        factType: 'routine',
        factKey: 'afternoon_nap',
        factValue: 'naps after lunch',
      },
      {
        familyId,
        factType: 'preference',
        factKey: 'old_pref',
        factValue: 'used to like trains',
        validUntil: new Date('2026-10-15T00:00:00.000Z'),
      },
      { familyId, childId: teenId, factType: 'medical', factKey: 'teen_key', factValue: 'raw' },
      {
        familyId,
        factType: 'routine',
        factKey: 'debate',
        factValue: `${TEEN_NAME} has debate on Saturdays`,
      },
    ]);
    await db.database.insert(schema.familyMemoryEpisodes).values([
      {
        familyId,
        occurredAt: new Date('2026-11-01T12:00:00.000Z'),
        episodeType: 'outing',
        summary: 'library morning',
        deletedAt: new Date('2026-11-02T00:00:00.000Z'),
      },
      {
        familyId,
        childId: teenId,
        occurredAt: new Date('2026-11-03T12:00:00.000Z'),
        episodeType: 'concern',
        summary: 'teen raw summary',
      },
    ]);
    await db.database.insert(schema.familyWorkstreams).values([
      {
        familyId,
        title: 'find a swim class',
        status: 'open',
        createdFrom: 'msg-1',
        updatedFrom: 'msg-1',
        expiresAt: new Date('2026-12-01T00:00:00.000Z'),
      },
      {
        familyId,
        title: 'teen raw title',
        status: 'open',
        childIds: [teenId],
        createdFrom: 'msg-2',
        updatedFrom: 'msg-2',
        expiresAt: new Date('2026-12-01T00:00:00.000Z'),
      },
    ]);
    await db.database.insert(schema.agentCommitments).values([
      {
        familyId,
        commitmentKind: 'first_find',
        createdFrom: 'msg-3',
        summary: 'your first weekend find lands in a day or two',
        heardFacts: ['when:time:9:15', 'price:free'],
        dueAt: new Date('2026-11-10T00:00:00.000Z'),
      },
      {
        familyId,
        commitmentKind: 'plan_offer',
        createdFrom: 'msg-4',
        subjectChildId: teenId,
        summary: 'teen raw promise',
        heardFacts: ['when:time:teen-raw-anchor'],
        dueAt: new Date('2026-11-11T00:00:00.000Z'),
      },
    ]);

    const doc = await assembleFamilyExport(db.database, familyId, {
      actorUserId,
      loadTrail: async () => [],
      now: NOW,
    });

    const byKey = new Map(doc.memory.facts.map((fact) => [fact.factKey, fact]));
    expect(byKey.get('afternoon_nap')).toMatchObject({ child: 'Pip', value: 'naps after lunch' });
    expect(byKey.get('old_pref')?.invalidatedAt).toBe('2026-10-15T00:00:00.000Z');
    expect(doc.memory.facts.filter((f) => f.factKey === TEEN_REDACTED_PLACEHOLDER)).toHaveLength(2);
    expect(doc.memory.episodes).toEqual([
      expect.objectContaining({
        episodeType: 'outing',
        summary: null,
        deletedAt: '2026-11-02T00:00:00.000Z',
      }),
      expect.objectContaining({ summary: TEEN_REDACTED_PLACEHOLDER, child: null }),
    ]);
    expect(doc.memory.workstreams.map((w) => w.title)).toEqual([
      'find a swim class',
      TEEN_REDACTED_PLACEHOLDER,
    ]);
    expect(doc.memory.commitments).toEqual([
      expect.objectContaining({
        kind: 'first_find',
        summary: 'your first weekend find lands in a day or two',
        heardFacts: ['when:time:9:15', 'price:free'],
      }),
      expect.objectContaining({
        kind: 'plan_offer',
        summary: TEEN_REDACTED_PLACEHOLDER,
        heardFacts: null,
        withheld: 'teen',
      }),
    ]);

    const text = JSON.stringify(doc.memory);
    expect(text).not.toContain(TEEN_NAME);
    expect(text).not.toContain('raw');
    expect(text).not.toContain(teenId);
    // A removed episode keeps its dates and type, never its words.
    expect(text).not.toContain('library morning');
  });

  it("withholds another adult's one-to-one memory, and keeps the requester's and the shared", async () => {
    const { familyId, parentUserId: parentA } = await seedFamily(db.database);
    const [userB] = await db.database
      .insert(schema.users)
      .values({ externalAuthId: `sms:${familyId}:coparent`, name: 'Co-parent' })
      .returning({ id: schema.users.id });
    const parentB = userB?.id as string;
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId, userId: parentB, role: 'co_parent' });

    const message = async (
      parentUserId: string,
      direction: 'in' | 'out',
      inGroup: boolean | null,
    ) => {
      const [row] = await db.database
        .insert(schema.channelMessages)
        .values({
          familyId,
          parentUserId,
          channel: 'sms',
          direction,
          category: 'reply',
          status: 'sent',
          inGroup,
        })
        .returning({ id: schema.channelMessages.id });
      return row?.id as string;
    };
    const fromA = await message(parentA, 'in', false);
    const fromB = await message(parentB, 'in', false);
    const inGroup = await message(parentB, 'in', true);
    const toA = await message(parentA, 'out', null);
    const toB = await message(parentB, 'out', null);

    const workstream = (title: string, createdFrom: string) => ({
      familyId,
      title,
      status: 'open' as const,
      createdFrom,
      updatedFrom: createdFrom,
      expiresAt: new Date('2026-12-01T00:00:00.000Z'),
    });
    await db.database
      .insert(schema.familyWorkstreams)
      .values([
        workstream('A asked for a swim class', fromA),
        workstream('B private job', fromB),
        workstream('group carpool plan', inGroup),
      ]);
    const commitment = (
      kind: 'first_find' | 'plan_offer',
      summary: string,
      createdFrom: string,
    ) => ({
      familyId,
      commitmentKind: kind,
      createdFrom,
      summary,
      heardFacts: [`price:money:${summary}`],
      dueAt: new Date('2026-11-10T00:00:00.000Z'),
    });
    await db.database
      .insert(schema.agentCommitments)
      .values([
        commitment('first_find', 'a find for A', toA),
        commitment('plan_offer', 'B private promise', toB),
      ]);
    await db.database.insert(schema.familyMemoryFacts).values([
      { familyId, factType: 'logistic', factKey: 'pickup', factValue: 'pickup at three' },
      { familyId, factType: 'preference', factKey: 'b_private', factValue: 'B private feeling' },
      {
        familyId,
        factType: 'logistic',
        factKey: 'dropoff',
        factValue: 'dropoff at eight',
        sourceAudience: 'one_to_one',
        sourceUserId: parentB,
      },
    ]);

    const doc = await assembleFamilyExport(db.database, familyId, {
      actorUserId: parentA,
      loadTrail: async () => [],
      now: NOW,
    });

    expect(doc.memory.workstreams.map((w) => [w.title, w.withheld])).toEqual([
      ['A asked for a swim class', null],
      [null, 'another_adult'],
      ['group carpool plan', null],
    ]);
    expect(doc.memory.commitments.map((c) => [c.summary, c.heardFacts, c.withheld])).toEqual([
      ['a find for A', ['price:money:a find for A'], null],
      [null, null, 'another_adult'],
    ]);
    // A logistic is shared by R7 only when the row says where it was said: B's 1:1
    // dropoff reaches A; an unrecorded pickup is held back like any unrecorded fact.
    expect(doc.memory.facts.map((f) => [f.factKey, f.value, f.withheld])).toEqual([
      [null, null, 'source_not_recorded'],
      [null, null, 'source_not_recorded'],
      ['dropoff', 'dropoff at eight', null],
    ]);
    expect(JSON.stringify(doc.memory)).not.toContain('B private');
    expect(JSON.stringify(doc.memory)).not.toContain('pickup at three');
  });

  it('withholds unattributed memory once a co-parent has left the household', async () => {
    const departed = async (trace: 'texted' | 'audit_only') => {
      const { familyId, parentUserId: parentA } = await seedFamily(db.database);
      const [userB] = await db.database
        .insert(schema.users)
        .values({ externalAuthId: `sms:${familyId}:departed`, name: 'Departed' })
        .returning({ id: schema.users.id });
      const parentB = userB?.id as string;
      if (trace === 'texted') {
        await db.database.insert(schema.channelMessages).values({
          familyId,
          parentUserId: parentB,
          channel: 'sms',
          direction: 'in',
          category: 'reply',
          status: 'sent',
          inGroup: false,
        });
      } else {
        await db.database.insert(schema.auditLog).values({
          familyId,
          actor: parentB,
          actionTaken: 'co_parent_access_withdrawn',
          targetTable: 'family_members',
          targetId: parentB,
        });
      }
      await db.database.insert(schema.familyMemoryFacts).values([
        { familyId, factType: 'logistic', factKey: 'pickup', factValue: 'pickup at three' },
        { familyId, factType: 'preference', factKey: 'b_private', factValue: 'B private feeling' },
        {
          familyId,
          factType: 'logistic',
          factKey: 'dropoff',
          factValue: 'dropoff at eight',
          sourceAudience: 'family',
          sourceUserId: parentA,
        },
      ]);
      return assembleFamilyExport(db.database, familyId, {
        actorUserId: parentA,
        loadTrail: async () => [],
        now: NOW,
      });
    };

    for (const trace of ['texted', 'audit_only'] as const) {
      const doc = await departed(trace);
      expect(doc.members.coParent).toBeNull();
      expect(doc.memory.facts.map((f) => [f.factKey, f.value, f.withheld])).toEqual([
        [null, null, 'source_not_recorded'],
        [null, null, 'source_not_recorded'],
        ['dropoff', 'dropoff at eight', null],
      ]);
      expect(JSON.stringify(doc.memory)).not.toContain('B private');
    }
  });

  it('withholds a job another adult last rewrote, even when the group opened it', async () => {
    const { familyId, parentUserId: parentA } = await seedFamily(db.database);
    const [userB] = await db.database
      .insert(schema.users)
      .values({ externalAuthId: `sms:${familyId}:coparent`, name: 'Co-parent' })
      .returning({ id: schema.users.id });
    const parentB = userB?.id as string;
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId, userId: parentB, role: 'co_parent' });
    const message = async (parentUserId: string, inGroup: boolean) => {
      const [row] = await db.database
        .insert(schema.channelMessages)
        .values({
          familyId,
          parentUserId,
          channel: 'sms',
          direction: 'in',
          category: 'reply',
          status: 'sent',
          inGroup,
        })
        .returning({ id: schema.channelMessages.id });
      return row?.id as string;
    };
    const group = await message(parentB, true);
    const fromA = await message(parentA, false);
    const fromB = await message(parentB, false);
    const workstream = (title: string, createdFrom: string, updatedFrom: string) => ({
      familyId,
      title,
      nextStep: `${title} next`,
      status: 'open' as const,
      createdFrom,
      updatedFrom,
      expiresAt: new Date('2026-12-01T00:00:00.000Z'),
    });
    await db.database
      .insert(schema.familyWorkstreams)
      .values([
        workstream('group plan B retitled', group, fromB),
        workstream('group plan A retitled', group, fromA),
      ]);

    const doc = await assembleFamilyExport(db.database, familyId, {
      actorUserId: parentA,
      loadTrail: async () => [],
      now: NOW,
    });

    expect(doc.memory.workstreams.map((w) => [w.title, w.nextStep, w.withheld])).toEqual([
      [null, null, 'another_adult'],
      ['group plan A retitled', 'group plan A retitled next', null],
    ]);
    expect(JSON.stringify(doc.memory)).not.toContain('B retitled');
  });

  it('withholds a job whose writers are not all on record: expired after a change, or changed twice', async () => {
    const { familyId, parentUserId: parentA } = await seedFamily(db.database);
    const [userB] = await db.database
      .insert(schema.users)
      .values({ externalAuthId: `sms:${familyId}:coparent`, name: 'Co-parent' })
      .returning({ id: schema.users.id });
    const parentB = userB?.id as string;
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId, userId: parentB, role: 'co_parent' });
    const message = async (parentUserId: string, inGroup: boolean) => {
      const [row] = await db.database
        .insert(schema.channelMessages)
        .values({
          familyId,
          parentUserId,
          channel: 'sms',
          direction: 'in',
          category: 'reply',
          status: 'sent',
          inGroup,
        })
        .returning({ id: schema.channelMessages.id });
      return row?.id as string;
    };
    const group = await message(parentB, true);
    const fromA = await message(parentA, false);
    const fromB = await message(parentB, false);

    let clock = new Date('2026-11-01T10:00:00.000Z').getTime();
    const tick = () => {
      clock += 60_000;
      return new Date(clock);
    };
    const expiresAt = '2026-11-05T00:00:00.000Z';
    const later = '2026-12-01T00:00:00.000Z';
    const open = async (title: string, provenance: string) => {
      const result = await applyWorkstreamOp(db.database, {
        familyId,
        provenance,
        now: tick(),
        op: { action: 'open', title, nextStep: `${title} next`, expiresAt },
      });
      if (!('id' in result)) throw new Error(`open refused: ${result.outcome}`);
      return result.id;
    };
    const update = (id: string, provenance: string, op: Partial<WorkstreamOp>) =>
      applyWorkstreamOp(db.database, {
        familyId,
        provenance,
        now: tick(),
        op: { action: 'update', id, ...op },
      });

    const expiredAfterB = await open('pool plan one', group);
    await update(expiredAfterB, fromB, { nextStep: 'B secret step one' });
    const middleB = await open('pool plan two', group);
    await update(middleB, fromB, { nextStep: 'B secret step two' });
    await update(middleB, fromA, { status: 'waiting_on_parent', expiresAt: later });
    await open('A job that expired', fromA);
    const groupThenA = await open('group plan A changed', group);
    await update(groupThenA, fromA, { nextStep: 'A step', expiresAt: later });
    expect(
      await expireStaleWorkstreams(db.database, new Date('2026-11-06T00:00:00.000Z'), familyId),
    ).toBe(2);

    const doc = await assembleFamilyExport(db.database, familyId, {
      actorUserId: parentA,
      loadTrail: async () => [],
      now: NOW,
    });

    expect(doc.memory.workstreams.map((w) => [w.title, w.nextStep, w.status, w.withheld])).toEqual([
      [null, null, 'dropped', 'source_not_recorded'],
      [null, null, 'waiting_on_parent', 'source_not_recorded'],
      ['A job that expired', 'A job that expired next', 'dropped', null],
      ['group plan A changed', 'A step', 'open', null],
    ]);
    expect(JSON.stringify(doc.memory)).not.toContain('B secret');
  });

  it('reads every family table, or names why not', async () => {
    const { familyId } = await seedFamily(db.database);
    const actorUserId = await seedParent(familyId);
    const read = new Set<string>();
    const query = db.client.query.bind(db.client);
    const spy = vi.spyOn(db.client, 'query').mockImplementation((async (
      text: string,
      ...rest: unknown[]
    ) => {
      for (const match of text.matchAll(/\b(?:from|join)\s+"([a-z_0-9]+)"/gi)) {
        read.add(match[1] as string);
      }
      return (query as (...args: unknown[]) => unknown)(text, ...rest);
    }) as typeof db.client.query);
    try {
      await assembleFamilyExport(db.database, familyId, { actorUserId, now: NOW });
    } finally {
      spy.mockRestore();
    }

    const unread = familyTables().filter((table) => !read.has(table));
    expect(unread).toEqual(Object.keys(NOT_IN_EXPORT).sort());
    // group_list_items has no family_id, so the schema scan above cannot see it; the
    // export reads it through group_lists.
    expect(read.has('group_list_items')).toBe(true);
  });

  it('marks no table unreviewed that the freeze does not hold', () => {
    expect(unreviewedAfterFreeze(NOT_IN_EXPORT)).toEqual([]);
    expect(unreviewedAfterFreeze({ ...NOT_IN_EXPORT, a_table_added_later: UNREVIEWED })).toEqual([
      'a_table_added_later',
    ]);
    // Every frozen table is still a family table nobody exports; one that the export now
    // reads, or that has a reason, comes off the freeze.
    for (const table of UNREVIEWED_AT_FREEZE) {
      expect(NOT_IN_EXPORT[table], table).toBe(UNREVIEWED);
    }
  });
});
