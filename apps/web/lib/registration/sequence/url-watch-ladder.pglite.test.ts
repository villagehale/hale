import type { AgentClient } from '@hale/agent';
import { type Municipality, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTransport } from '~/lib/channel/intake/transport';
import type { FetchPage } from '~/lib/registration/verify-sweep';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import type { HeadsUpComposeInput } from './heads-up-compose.js';
import {
  type SequenceRunDeps,
  defaultSequenceRunDeps,
  runRegistrationSequenceCron,
} from './run.js';

/**
 * VIL-423 · a watch a parent's link created has no catalog row (`window_id` NULL), and
 * the sweep must still account for it — through the DEFAULT loader, against the real
 * DDL. The fakes in run.test.ts and the toddler journey both inject `loadLiveSequences`,
 * which is how an inner join on a now-nullable column passed CI.
 *
 * A link watch's legs are HELD (`linkUnread`) until a send-time read of the parent's
 * page exists: nothing is composed, read, sent, keyed or audited for one. Faked only at
 * the ports below; everything else, the loader included, is production code.
 */

const TZ = 'America/Edmonton';
/** Tuesday 22 Sept 2026, 10:00 in Edmonton. */
const OPEN = new Date('2026-09-22T16:00:00.000Z');
/** Inside the heads-up interval (15 Sept 10:00 to 19 Sept 10:00 local). */
const NOW = new Date('2026-09-16T17:00:00.000Z');
/** 20:00 in Edmonton the evening before: the battle-plan interval. */
const BATTLE_PLAN_NOW = new Date('2026-09-22T02:00:00.000Z');

let db: TestDb;
let familyId: string;
let parentUserId: string;
let infoSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  vi.stubEnv('F14_ENABLED', 'true');
  infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
  const seeded = await seedFamily(db.database, 'Link Watch Family');
  familyId = seeded.familyId;
  parentUserId = seeded.parentUserId;
  await db.database
    .update(schema.users)
    .set({ timezone: TZ })
    .where(eq(schema.users.id, parentUserId));
  // No area: phase A proposes nothing, so only the leg phase runs.
  await db.database
    .update(schema.families)
    .set({ areaCoarse: null })
    .where(eq(schema.families.id, familyId));
  await db.database
    .insert(schema.children)
    .values({ familyId, name: 'Wren', dateOfBirth: '2022-03-01', dobPrecision: 'exact' });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  infoSpy.mockRestore();
  await db.exec('truncate table families, users, registration_windows cascade');
});

/** The shortlist card, as the approval spine leaves it: executed is the opt-in, still
 * drafted is pending. */
async function seedAction(state: 'opted_in' | 'pending'): Promise<string> {
  const [event] = await db.database
    .insert(schema.events)
    .values({
      familyId,
      source: 'test',
      eventType: 'registration_shortlist',
      dedupHash: `url-watch-${Math.random()}`,
    })
    .returning({ id: schema.events.id });
  const [action] = await db.database
    .insert(schema.actions)
    .values({
      eventId: event?.id as string,
      familyId,
      actionType: 'send_message',
      payload: {},
      userVisibleState: state === 'opted_in' ? 'autonomous' : 'drafted_for_approval',
      reviewerVerdict: 'approved',
      draftedAt: new Date('2026-09-01T10:00:00.000Z'),
      ...(state === 'opted_in' ? { executedAt: new Date('2026-09-01T10:05:00.000Z') } : {}),
    })
    .returning({ id: schema.actions.id });
  return action?.id as string;
}

async function seedLinkWatch(
  slug: string,
  opensAt: Date | null,
  state: 'opted_in' | 'pending' = 'opted_in',
): Promise<string> {
  const actionId = await seedAction(state);
  const [row] = await db.database
    .insert(schema.registrationSequences)
    .values({
      familyId,
      windowId: null,
      parentUserId,
      actionId,
      courseUrl: `https://register.example.org/courses/${slug}`,
      courseOpensAt: opensAt,
    })
    .returning({ id: schema.registrationSequences.id });
  return row?.id as string;
}

/** A catalog ladder in an invented town, opted in, opening at OPEN. */
async function seedCatalogWatch(): Promise<{ windowId: string; sequenceId: string }> {
  const [window] = await db.database
    .insert(schema.registrationWindows)
    .values({
      municipality: 'larchmere' as Municipality,
      programDomain: 'rec_program',
      cycleLabel: 'Fall 2026',
      openAt: OPEN,
      ageMinMonths: null,
      ageMaxMonths: null,
      sourceUrl: 'https://larchmere.example.org/register',
      verifiedAt: new Date('2026-08-01T00:00:00.000Z'),
    })
    .returning({ id: schema.registrationWindows.id });
  const windowId = window?.id as string;
  const actionId = await seedAction('opted_in');
  const [row] = await db.database
    .insert(schema.registrationSequences)
    .values({ familyId, windowId, parentUserId, actionId })
    .returning({ id: schema.registrationSequences.id });
  return { windowId, sequenceId: row?.id as string };
}

interface Ports {
  deps: SequenceRunDeps;
  transport: FakeTransport;
  headsUp: HeadsUpComposeInput[];
  composeEvening: ReturnType<typeof vi.fn>;
  composeMorning: ReturnType<typeof vi.fn>;
  fetchBody: ReturnType<typeof vi.fn>;
}

function ports(): Ports {
  const transport = new FakeTransport();
  const headsUp: HeadsUpComposeInput[] = [];
  const fetchBody = vi.fn(async (url: string) => {
    throw new Error(`unexpected course read: ${url}`);
  });
  const composeEvening = vi.fn(async (_client: AgentClient, facts: { situation: string }) => {
    return `composed evening ${facts.situation}`;
  });
  const composeMorning = vi.fn(async (_client: AgentClient, facts: { situation: string }) => {
    return `composed morning ${facts.situation}`;
  });
  const deps: SequenceRunDeps = {
    ...defaultSequenceRunDeps(),
    transport,
    loadRecipients: async () => [{ parentUserId, timeZone: TZ, role: 'primary_parent' }],
    buildGate: () => ({
      channelEnrolled: async () => true,
      watchConsentGranted: async () => true,
      countProactiveSends: async () => 0,
      proactiveSentSince: async () => false,
      parentTimeZone: async () => TZ,
    }),
    resolveSendablePhone: async () => '+15555550100',
    client: {
      messages: {
        create: async () => {
          throw new Error('compose is injected');
        },
      },
    } as unknown as AgentClient,
    loadLanguage: async () => 'en',
    composeHeadsUp: async (_client, facts) => {
      headsUp.push(facts);
      return `composed heads-up ${facts.window} for ${facts.who} ${facts.next}`;
    },
    composeEvening: composeEvening as unknown as SequenceRunDeps['composeEvening'],
    composeMorning: composeMorning as unknown as SequenceRunDeps['composeMorning'],
    // No leg here is a registration note; a write would be a real model call.
    writeNote: async (_db, _familyId, facts) => {
      throw new Error(`unexpected registration note: ${facts.kind}`);
    },
    fetchBody: fetchBody as unknown as FetchPage,
    refreshCourseAnchor: async () => {
      throw new Error('unexpected anchor refresh');
    },
  };
  return { deps, transport, headsUp, composeEvening, composeMorning, fetchBody };
}

async function sentRows() {
  return db.database
    .select({ dedupeKey: schema.channelMessages.dedupeKey })
    .from(schema.channelMessages)
    .where(eq(schema.channelMessages.familyId, familyId));
}

async function auditRows() {
  return db.database
    .select({ targetId: schema.auditLog.targetId, after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.familyId, familyId));
}

describe('the ladder, for a watch a parent’s link created', () => {
  it('holds an opted-in link watch’s due heads-up by name, beside a catalog ladder that sends', async () => {
    const linkId = await seedLinkWatch('swim-a', OPEN);
    const catalog = await seedCatalogWatch();
    const p = ports();

    const result = await runRegistrationSequenceCron(db.database, p.deps, NOW);

    expect(result.evaluated).toBe(2);
    expect(result.linkUnread).toBe(1);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);

    // The one send is the catalog's, under main's key and facts.
    const rows = await sentRows();
    expect(rows).toEqual([
      {
        dedupeKey: `registration_sequence:${familyId}:${catalog.windowId}:heads_up:${parentUserId}`,
      },
    ]);
    expect(p.headsUp).toHaveLength(1);
    expect(p.headsUp[0]).toMatchObject({
      window: 'Larchmere Fall 2026 recreation programs',
      who: 'Wren',
    });

    // Nothing is keyed or audited for the link watch; the catalog's audit row is the
    // positive control that the audit path ran at all.
    expect(rows.some((row) => row.dedupeKey?.includes(linkId))).toBe(false);
    const audits = await auditRows();
    expect(audits.some((row) => JSON.stringify(row.after).includes(catalog.windowId))).toBe(true);
    expect(audits.some((row) => row.targetId === linkId)).toBe(false);
    expect(audits.some((row) => JSON.stringify(row.after).includes(linkId))).toBe(false);

    expect(infoSpy).toHaveBeenCalledWith(
      {
        outcome: 'registration_link_watch_unread',
        watches: [{ sequenceId: linkId, leg: 'heads_up' }],
      },
      expect.any(String),
    );
  });

  it('accounts for two link watches in one family, each by id', async () => {
    const swim = await seedLinkWatch('swim-a', OPEN);
    const skate = await seedLinkWatch('skate-b', OPEN);
    const p = ports();

    const result = await runRegistrationSequenceCron(db.database, p.deps, NOW);

    expect(result.evaluated).toBe(2);
    expect(result.linkUnread).toBe(2);
    expect(result.sent).toBe(0);
    const call = infoSpy.mock.calls.find(
      ([fields]) => (fields as { outcome?: string }).outcome === 'registration_link_watch_unread',
    );
    const watches = (call?.[0] as { watches: Array<{ sequenceId: string; leg: string }> }).watches;
    expect(watches).toHaveLength(2);
    expect(watches).toEqual(
      expect.arrayContaining([
        { sequenceId: swim, leg: 'heads_up' },
        { sequenceId: skate, leg: 'heads_up' },
      ]),
    );
  });

  it('gives an undated link watch no dated leg and names it, beside a dated one that is held', async () => {
    const undatedId = await seedLinkWatch('dance-c', null);
    const datedId = await seedLinkWatch('swim-a', OPEN);
    const p = ports();

    const result = await runRegistrationSequenceCron(db.database, p.deps, NOW);

    expect(result.undated).toBe(1);
    expect(result.linkUnread).toBe(1);
    expect(result.sent).toBe(0);
    expect(infoSpy).toHaveBeenCalledWith(
      { outcome: 'registration_link_watch_undated', sequenceIds: [undatedId] },
      expect.any(String),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      {
        outcome: 'registration_link_watch_unread',
        watches: [{ sequenceId: datedId, leg: 'heads_up' }],
      },
      expect.any(String),
    );
  });

  it('reads nothing and composes nothing at battle-plan time', async () => {
    const linkId = await seedLinkWatch('swim-a', OPEN);
    const p = ports();

    const result = await runRegistrationSequenceCron(db.database, p.deps, BATTLE_PLAN_NOW);

    expect(result.linkUnread).toBe(1);
    expect(p.fetchBody).toHaveBeenCalledTimes(0);
    expect(p.composeEvening).toHaveBeenCalledTimes(0);
    expect(result.read).toBe(0);
    expect(result.sent).toBe(0);
    expect(infoSpy).toHaveBeenCalledWith(
      {
        outcome: 'registration_link_watch_unread',
        watches: [{ sequenceId: linkId, leg: 'battle_plan' }],
      },
      expect.any(String),
    );
  });

  it('keeps a pasted link the parent never approved quiet: a paste is not consent', async () => {
    const pendingId = await seedLinkWatch('skate-b', OPEN, 'pending');
    const optedInId = await seedLinkWatch('swim-a', OPEN);
    const p = ports();

    const result = await runRegistrationSequenceCron(db.database, p.deps, NOW);

    expect(result.quiet).toBe(1);
    expect(result.linkUnread).toBe(1);
    expect(infoSpy).toHaveBeenCalledWith(
      {
        outcome: 'registration_link_watch_unread',
        watches: [{ sequenceId: optedInId, leg: 'heads_up' }],
      },
      expect.any(String),
    );
    expect(infoSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({
        watches: expect.arrayContaining([expect.objectContaining({ sequenceId: pendingId })]),
      }),
      expect.any(String),
    );
  });
});
