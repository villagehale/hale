import { schema } from '@hale/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  flushGroupDecisionSyncs,
  queueGroupActivityDecision,
} from '~/lib/channel/linq/family-outbound';
import { writeFact } from '~/lib/memory/facts';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import { COPARENT_DUTY_COPY_LOCKED_ENV } from './copy';
import { DUTY_BURDEN_FACT_KEY, burdenMayLeave, defaultOwnerOffer, noteDutyBurden } from './burden';
import {
  COPARENT_DUTY_BURDEN_SURFACE_ENABLED_ENV,
  COPARENT_DUTY_MEMORY_ENABLED_ENV,
} from './flag';
import { loadDutyMetrics, recordDutyAnswered, recordDutyUndone } from './metrics';
import { type DutyState, commitDutyUpdate } from './model';
import { projectDutyOnFamilyEvent } from './calendar';
import { settleDutyMemory } from './settle';

const GROUP = 'chat-home';
const PERSONAL = 'chat-one-to-one';
const GROUP_MESSAGES = `https://api.linqapp.com/api/partner/v3/chats/${GROUP}/messages`;
const START = new Date('2026-09-29T19:00:00.000Z');
const DAY = new Date('2026-09-24T15:00:00.000Z');

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await db.exec('truncate table families, users cascade');
});

async function secondParent(familyId: string, name: string): Promise<string> {
  const email = `${name}-${familyId}@example.test`;
  const inserted = (await db.database.execute(
    sql`insert into users (email, name) values (${email}, ${name}) returning id`,
  )) as unknown as { rows?: Array<{ id: string }> } | Array<{ id: string }>;
  const user = (Array.isArray(inserted) ? inserted : (inserted.rows ?? []))[0];
  if (!user) throw new Error('second parent insert returned no row');
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: user.id, role: 'co_parent' });
  return user.id;
}

function confirmed(userId: string, eventKey: string): DutyState {
  return {
    role: 'pickup',
    eventKey,
    status: 'confirmed',
    attendance: 'going',
    owner: { kind: 'parent', userId },
    proposedForUserId: null,
    proposedByUserId: null,
    claims: [],
    namedOwner: null,
    confidence: 1,
    kidTitle: 'swim',
  };
}

describe('duty calendar memory', () => {
  it('overwrites the owner on family_events and keeps the previous one in the audit', async () => {
    vi.stubEnv(COPARENT_DUTY_MEMORY_ENABLED_ENV, 'true');
    const family = await seedFamily(db.database, 'Duty');
    const sam = await secondParent(family.familyId, 'Sam');
    const subjectKey = 'who-takes/2026-09-29T19:00:00.000Z/swim';
    const [event] = await db.database
      .insert(schema.familyEvents)
      .values({
        familyId: family.familyId,
        title: 'Maya swim',
        startsAt: START,
        source: 'parent',
      })
      .returning({ id: schema.familyEvents.id });
    const factKey = `duty/${encodeURIComponent(subjectKey)}/pickup`;
    const first = await projectDutyOnFamilyEvent(db.database, {
      familyId: family.familyId,
      actorUserId: family.parentUserId,
      factKey,
      subjectKey,
      state: confirmed(family.parentUserId, subjectKey),
      now: DAY,
    });
    expect(first).toEqual({ status: 'updated', eventId: event?.id });
    const second = await projectDutyOnFamilyEvent(db.database, {
      familyId: family.familyId,
      actorUserId: sam,
      factKey,
      subjectKey,
      state: confirmed(sam, subjectKey),
      now: new Date(DAY.getTime() + 60_000),
    });
    expect(second.status).toBe('updated');
    const rows = await db.database
      .select()
      .from(schema.familyEvents)
      .where(eq(schema.familyEvents.familyId, family.familyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.dutyOwnerUserId).toBe(sam);
    expect(rows[0]?.deletedAt).toBeNull();
    const audits = await db.database
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, family.familyId));
    const projected = audits.filter((row) => row.actionTaken === 'duty_calendar_projected');
    expect(projected).toHaveLength(2);
    expect(JSON.stringify(projected[1]?.before)).toContain(family.parentUserId);
  });

  it('does not store or speak a non-kid title', async () => {
    vi.stubEnv(COPARENT_DUTY_MEMORY_ENABLED_ENV, 'true');
    const family = await seedFamily(db.database, 'Adult');
    const subjectKey = 'who-takes/2026-09-29T19:00:00.000Z/review';
    await db.database.insert(schema.familyEvents).values({
      familyId: family.familyId,
      title: 'Quarterly board review',
      startsAt: START,
      source: 'parent',
    });
    const projected = await projectDutyOnFamilyEvent(db.database, {
      familyId: family.familyId,
      actorUserId: family.parentUserId,
      factKey: `duty/${encodeURIComponent(subjectKey)}/attend`,
      subjectKey,
      state: confirmed(family.parentUserId, subjectKey),
      now: DAY,
    });
    expect(projected).toEqual({ status: 'skipped', reason: 'non_kid_title' });
    const [row] = await db.database
      .select({ dutyOwnerUserId: schema.familyEvents.dutyOwnerUserId })
      .from(schema.familyEvents);
    expect(row?.dutyOwnerUserId).toBeNull();
    const audits = await db.database.select().from(schema.auditLog);
    expect(JSON.stringify(audits)).not.toContain('Quarterly board review');
  });

  it('undoes by overwrite and does not delete the fact or the event', async () => {
    vi.stubEnv(COPARENT_DUTY_MEMORY_ENABLED_ENV, 'true');
    const family = await seedFamily(db.database, 'Undo');
    await secondParent(family.familyId, 'Sam');
    await seedChild(db.database, family.familyId, 'Maya', 36, undefined, DAY);
    const subjectKey = 'who-takes/2026-09-29T19:00:00.000Z/maya%20swim';
    await db.database.insert(schema.familyEvents).values({
      familyId: family.familyId,
      title: 'Maya swim',
      startsAt: START,
      source: 'parent',
    });
    const written = await commitDutyUpdate(db.database, {
      mode: 'write',
      familyId: family.familyId,
      actorUserId: family.parentUserId,
      parentCount: 2,
      subjectKey,
      eventTitle: 'Maya swim',
      childNames: ['Maya'],
      slot: {
        role: 'pickup',
        claim: 'self',
        name: null,
        userId: family.parentUserId,
        confidence: 1,
      },
      prior: null,
      source: 'text',
      now: DAY,
      childId: null,
      question: false,
      askWhichKid: false,
    });
    expect(written.written).toBe(true);
    const dutyKey = written.factKey as string;
    const beforeFacts = await db.database
      .select({ id: schema.familyMemoryFacts.id })
      .from(schema.familyMemoryFacts)
      .where(eq(schema.familyMemoryFacts.factKey, dutyKey));
    expect(beforeFacts).toHaveLength(1);
    const settled = await settleDutyMemory(db.database, {
      familyId: family.familyId,
      actorUserId: family.parentUserId,
      text: 'never mind',
      now: new Date(DAY.getTime() + 5 * 60 * 1000),
      inboundChatId: PERSONAL,
      inboundMessageId: 'msg-1',
      surface: 'reply',
      timeZone: 'America/Toronto',
    });
    expect(settled.status).toBe('undone');
    expect(settled.spoken).toBeNull();
    const facts = await db.database
      .select({
        id: schema.familyMemoryFacts.id,
        validUntil: schema.familyMemoryFacts.validUntil,
      })
      .from(schema.familyMemoryFacts)
      .where(eq(schema.familyMemoryFacts.factKey, dutyKey));
    expect(facts).toHaveLength(2);
    expect(facts.some((row) => row.validUntil !== null)).toBe(true);
    expect(facts.some((row) => row.validUntil === null)).toBe(true);
    const events = await db.database.select({ id: schema.familyEvents.id }).from(schema.familyEvents);
    expect(events).toHaveLength(1);
  });
});

describe('duty group sync', () => {
  it('echoes a 1:1 duty decision to the group after 10 minutes, in at most 3 lines', async () => {
    vi.stubEnv(COPARENT_DUTY_MEMORY_ENABLED_ENV, 'true');
    vi.stubEnv(COPARENT_DUTY_COPY_LOCKED_ENV, 'true');
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    vi.stubEnv('LINQ_GROUP_COPARENT', 'on');
    vi.stubEnv('LINQ_CONTACT_CARD_SHARE', 'off');
    const family = await seedFamily(db.database, 'Sync');
    await db.database
      .update(schema.families)
      .set({ linqGroupChatId: GROUP })
      .where(eq(schema.families.id, family.familyId));
    await db.database
      .update(schema.users)
      .set({ name: 'Barton' })
      .where(eq(schema.users.id, family.parentUserId));
    const activities = ['swim', 'daycare', 'soccer', 'piano'] as const;
    for (const [index, activity] of activities.entries()) {
      const queued = await queueGroupActivityDecision(db.database, {
        familyId: family.familyId,
        parentUserId: family.parentUserId,
        originChatId: PERSONAL,
        decision: {
          decision: 'duty',
          activity,
          kid: 'Maya',
          day: 'Saturday',
          time: '3:00pm',
        },
        now: new Date(DAY.getTime() + index * 1000),
      });
      expect(queued).toBe('queued');
    }
    const urls: string[] = [];
    const bodies: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      urls.push(String(url));
      if (init?.body) bodies.push(String(init.body));
      return new Response(JSON.stringify({ message: { id: 'msg-1' } }), { status: 201 });
    });
    const early = await flushGroupDecisionSyncs(db.database, {
      now: new Date(DAY.getTime() + 4 * 1000),
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(early.sent).toBe(0);
    expect(urls).toEqual([]);
    const flushed = await flushGroupDecisionSyncs(db.database, {
      now: new Date(DAY.getTime() + 10 * 60 * 1000 + 4000),
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(flushed.sent).toBe(1);
    expect(urls).toEqual([GROUP_MESSAGES]);
    const payload = JSON.parse(bodies[0] ?? '{}') as {
      message?: { parts?: Array<{ value?: string }> };
    };
    const spoken = (payload.message?.parts?.[0]?.value ?? '').split('\n');
    expect(spoken.length).toBeLessThanOrEqual(3);
    expect(spoken.some((line) => line.includes('piano'))).toBe(false);
    for (const line of spoken) {
      expect(line.endsWith('Say so here if that changes.')).toBe(true);
    }
    expect(bodies.join('\n')).not.toMatch(/reply stop|unsubscribe/i);
  });

  it('holds the echo in quiet hours and does not queue a non-kid title or a group-originated 1:1', async () => {
    vi.stubEnv(COPARENT_DUTY_MEMORY_ENABLED_ENV, 'true');
    vi.stubEnv(COPARENT_DUTY_COPY_LOCKED_ENV, 'true');
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    vi.stubEnv('LINQ_GROUP_COPARENT', 'on');
    vi.stubEnv('LINQ_CONTACT_CARD_SHARE', 'off');
    const family = await seedFamily(db.database, 'Quiet');
    await db.database
      .update(schema.families)
      .set({ linqGroupChatId: GROUP })
      .where(eq(schema.families.id, family.familyId));
    await db.database
      .update(schema.users)
      .set({ name: 'Barton' })
      .where(eq(schema.users.id, family.parentUserId));
    const quiet = new Date('2026-09-25T02:30:00.000Z');
    const queued = await queueGroupActivityDecision(db.database, {
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      originChatId: PERSONAL,
      decision: { decision: 'duty', activity: 'swim', kid: 'Maya', day: 'Saturday', time: '3:00pm' },
      now: new Date(quiet.getTime() - 11 * 60 * 1000),
    });
    expect(queued).toBe('queued');
    const fetchMock = vi.fn(async () => new Response('{}', { status: 201 }));
    const held = await flushGroupDecisionSyncs(db.database, {
      now: quiet,
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(held).toEqual({ sent: 0, held: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
    const adult = await queueGroupActivityDecision(db.database, {
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      originChatId: PERSONAL,
      decision: {
        decision: 'duty',
        activity: 'Quarterly board review',
        kid: 'Maya',
        day: 'Saturday',
        time: '3:00pm',
      },
      now: DAY,
    });
    expect(adult).toBe('skipped');
    const fromGroup = await queueGroupActivityDecision(db.database, {
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      originChatId: GROUP,
      decision: { decision: 'duty', activity: 'daycare', kid: 'Maya', day: 'Monday', time: '9:00am' },
      now: DAY,
    });
    expect(fromGroup).toBe('skipped');
  });
});

describe('duty burden and metrics', () => {
  it('keeps rolling counts inside the system', async () => {
    vi.stubEnv(COPARENT_DUTY_MEMORY_ENABLED_ENV, 'true');
    vi.stubEnv(COPARENT_DUTY_BURDEN_SURFACE_ENABLED_ENV, 'true');
    const family = await seedFamily(db.database, 'Burden');
    await secondParent(family.familyId, 'Sam');
    for (const iso of ['2026-08-01T15:00:00.000Z', '2026-08-08T15:00:00.000Z', '2026-08-15T15:00:00.000Z']) {
      const subject = `who-takes/${iso}/swim`;
      await writeFact(db.database, {
        familyId: family.familyId,
        childId: null,
        factType: 'logistic',
        factKey: `duty/${encodeURIComponent(subject)}/pickup`,
        factValue: {
          schemaVersion: 1,
          kind: 'duty',
          status: 'confirmed',
          role: 'pickup',
          owner: { kind: 'parent', userId: family.parentUserId },
        },
        confidence: 1,
        inferredBy: 'coparent_duty_test',
        validFrom: new Date(iso),
      });
    }
    const summary = await noteDutyBurden(db.database, { familyId: family.familyId, now: DAY });
    const offer = defaultOwnerOffer(summary?.recurring ?? []);
    expect(offer?.takes).toBeGreaterThanOrEqual(3);
    expect(offer?.mayLeave).toBe(false);
    expect(offer?.text).not.toMatch(/\d/);
    expect(burdenMayLeave()).toBe(false);
    const asked = await settleDutyMemory(db.database, {
      familyId: family.familyId,
      actorUserId: family.parentUserId,
      text: "who's done more pickups",
      now: DAY,
      inboundChatId: PERSONAL,
      inboundMessageId: 'msg-1',
      surface: 'reply',
    });
    expect(asked).toEqual({
      status: 'skipped',
      reason: 'burden_internal',
      sent: false,
      spoken: null,
    });
    const [stored] = await db.database
      .select({ factValue: schema.familyMemoryFacts.factValue })
      .from(schema.familyMemoryFacts)
      .where(eq(schema.familyMemoryFacts.factKey, DUTY_BURDEN_FACT_KEY));
    expect(JSON.stringify(stored?.factValue)).toContain(family.parentUserId);
  });

  it('reports owner share, time to first answer, and undos inside 10 minutes', async () => {
    vi.stubEnv(COPARENT_DUTY_MEMORY_ENABLED_ENV, 'true');
    const family = await seedFamily(db.database, 'Metrics');
    const soon = new Date(DAY.getTime() + 2 * 60 * 60 * 1000);
    const later = new Date(DAY.getTime() + 4 * 60 * 60 * 1000);
    await db.database.insert(schema.familyEvents).values([
      {
        familyId: family.familyId,
        title: 'Maya swim',
        startsAt: soon,
        source: 'parent',
        dutyOwnerUserId: family.parentUserId,
        dutyOwnerKind: 'parent',
        dutyOwnerLabel: 'Test',
        dutySetAt: DAY,
      },
      {
        familyId: family.familyId,
        title: 'Maya daycare',
        startsAt: later,
        source: 'parent',
      },
    ]);
    const factKey = 'duty/swim/pickup';
    await writeFact(db.database, {
      familyId: family.familyId,
      childId: null,
      factType: 'logistic',
      factKey: 'duty-ask/open',
      factValue: { eventKey: factKey },
      confidence: 1,
      inferredBy: 'coparent_duty_test',
      validFrom: new Date(DAY.getTime() - 30 * 60 * 1000),
    });
    await recordDutyAnswered(db.database, {
      familyId: family.familyId,
      actorUserId: family.parentUserId,
      factKey,
      now: DAY,
      source: 'text',
      confirmed: true,
    });
    await recordDutyUndone(db.database, {
      familyId: family.familyId,
      actorUserId: family.parentUserId,
      factKey,
      recordedAt: DAY,
      now: new Date(DAY.getTime() + 4 * 60 * 1000),
    });
    const metrics = await loadDutyMetrics(db.database, family.familyId, DAY);
    expect(metrics.eventsWithOwner24hAhead).toEqual({ considered: 2, owned: 1, share: 0.5 });
    expect(metrics.timeToFirstAnswerMs).toBe(30 * 60 * 1000);
    expect(metrics.undoneWithin10Minutes).toEqual({ recorded: 1, undone: 1, share: 1 });
  });
});
