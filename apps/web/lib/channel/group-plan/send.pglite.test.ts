import { schema } from '@hale/db';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordWatchConsent } from '~/lib/channel/intake/watch-consent';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { loadEventInvite } from '~/lib/loop/ics-invite';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import {
  type GroupPlan,
  loadGroupPlan,
  productionGroupPlanReportPorts,
  withGroupPlanReport,
} from './send';
import { productionRecordGroupPlanOrigin } from './stamp';

/**
 * VIL-443 (T17) 2/2 against a real database: which placements are a group's plan, the
 * facts read for its text (writing nothing), the real link anyone can open, and the
 * group send — once per revision, with an audit row that carries no title or names.
 * No model runs here: where a text is needed, the composer port returns a fixed one.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const GROUP = 'chat-group-plan';
const GROUP_MESSAGES = `https://api.linqapp.com/api/partner/v3/chats/${GROUP}/messages`;
const MORNING = new Date('2026-11-06T15:00:00.000Z'); // 10:00 Toronto
const NIGHT = new Date('2026-11-07T04:00:00.000Z'); // 23:00 Toronto
const STARTS = new Date('2026-11-07T15:00:00.000Z'); // Sat 10:00 Toronto

let db: TestDb;
let n = 0;

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(() => {
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
  vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec('truncate table families, users cascade');
});

async function user(name: string) {
  n += 1;
  const [row] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `sms:gp-${n}`, name, timezone: 'America/Toronto', locale: 'en' })
    .returning({ id: schema.users.id });
  return row?.id as string;
}

async function seed(opts: { group?: boolean; sensitive?: boolean; language?: string } = {}) {
  const [family] = await db.database
    .insert(schema.families)
    .values({
      displayName: 'Ana + kids',
      provinceOrState: 'ON',
      linqGroupChatId: GROUP,
      primaryLanguage: opts.language ?? 'en',
    })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;
  const ana = await user('Ana Lopez');
  const sam = await user('Sam');
  await db.database.insert(schema.familyMembers).values([
    { familyId, userId: ana, role: 'primary_parent' },
    { familyId, userId: sam, role: 'co_parent' },
  ]);
  const phone = `+1416555${7000 + n}`;
  await db.database.insert(schema.parentChannels).values({
    userId: ana,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    verifiedAt: MORNING,
  });
  await recordWatchConsent(
    db.database,
    {
      familyId,
      userId: ana,
      granted: true,
      verbatimReply: 'yes',
      interpretation: 'the parent said yes to being watched',
      channelMessageId: null,
    },
    MORNING,
  );
  const [event] = await db.database
    .insert(schema.events)
    .values({ familyId, source: 'sms_channel', eventType: 'calendar_change', dedupHash: `d-${n}` })
    .returning({ id: schema.events.id });
  const [action] = await db.database
    .insert(schema.actions)
    .values({
      eventId: event?.id as string,
      familyId,
      actionType: 'calendar_add',
      payload: { title: 'Swim lesson', startsAt: STARTS.toISOString() },
    })
    .returning({ id: schema.actions.id, payload: schema.actions.payload });
  const actionId = action?.id as string;
  const [placed] = await db.database
    .insert(schema.familyEvents)
    .values({
      familyId,
      title: 'Swim lesson',
      startsAt: STARTS,
      location: 'Y on Main',
      source: 'placement',
      sensitive: opts.sensitive ?? false,
      placedByActionId: actionId,
    })
    .returning({ id: schema.familyEvents.id });
  const familyEventId = placed?.id as string;
  await audit(familyId, 'action.calendar_placed', familyEventId);
  if (opts.group ?? true) {
    await productionRecordGroupPlanOrigin(db.database)({ familyId, actor: ana, actionId });
  }
  return { familyId, ana, sam, actionId, familyEventId, payload: action?.payload };
}

async function audit(familyId: string, actionTaken: string, familyEventId: string) {
  await db.database.insert(schema.auditLog).values({
    familyId,
    actor: 'system',
    actionTaken,
    targetTable: 'family_events',
    targetId: familyEventId,
  });
}

async function seat(
  familyId: string,
  userId: string,
  role: 'parent' | 'co_parent' | 'other_family',
) {
  n += 1;
  const phone = `+1905555${7000 + n}`;
  await db.database.insert(schema.linqGroupMembers).values({
    familyId,
    chatId: GROUP,
    userId,
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    role,
  });
}

async function googleWrite(familyId: string, familyEventId: string, owner: string) {
  const [integration] = await db.database
    .insert(schema.integrations)
    .values({
      familyId,
      userId: owner,
      provider: 'gcal',
      status: 'active',
      oauthTokensEncrypted: 'x',
    })
    .returning({ id: schema.integrations.id });
  await db.database
    .update(schema.familyEvents)
    .set({ placedGoogleEventId: 'g-1', placedGoogleIntegrationId: integration?.id as string })
    .where(eq(schema.familyEvents.id, familyEventId));
  await audit(familyId, 'integration.google_calendar_written', familyEventId);
}

/** Every public table's row count: a write anywhere shows. */
async function counts() {
  const tables = (await db.database.execute(
    sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`,
  )) as unknown as { rows: Array<{ table_name: string }> };
  const out: Record<string, number> = {};
  for (const { table_name } of tables.rows) {
    const r = (await db.database.execute(
      sql.raw(`select count(*)::int as c from "${table_name}"`),
    )) as unknown as { rows: Array<{ c: number }> };
    out[table_name] = r.rows[0]?.c ?? 0;
  }
  return out;
}

function linqWire(status = 200) {
  const posted: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    posted.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    if (status !== 200)
      return new Response(JSON.stringify({ error: { code: status } }), { status });
    return new Response(JSON.stringify({ message: { id: `m-${posted.length}` } }), { status: 200 });
  });
  return { fetch: fetchImpl as unknown as typeof fetch, posted };
}

const request = (
  s: { familyId: string; familyEventId: string },
  method: 'REQUEST' | 'CANCEL' = 'REQUEST',
) => ({
  familyId: s.familyId,
  familyEventId: s.familyEventId,
  method,
});

describe('VIL-443 loadGroupPlan, real database', () => {
  it('is not a group plan when the add was drafted 1:1', async () => {
    const s = await seed({ group: false });
    expect(await loadGroupPlan(db.database, request(s), MORNING)).toBeNull();
  });

  it('leaves the drafted payload exactly as the reviewer saw it', async () => {
    const s = await seed();
    expect(s.payload).toEqual({ title: 'Swim lesson', startsAt: STARTS.toISOString() });
  });

  it('reads an added plan without writing anything', async () => {
    const s = await seed();
    const before = await counts();
    const plan = await loadGroupPlan(db.database, request(s), MORNING);
    expect(await counts()).toEqual(before);
    expect(plan).toMatchObject({
      familyId: s.familyId,
      familyEventId: s.familyEventId,
      placedByActionId: s.actionId,
      chatId: GROUP,
      gateUserId: s.ana,
      change: 'added',
      dedupeKey: `group_plan_calendar:${s.familyEventId}:1`,
      event: { title: 'Swim lesson', where: 'Y on Main' },
      reachedUserIds: [],
      language: 'en',
    });
    expect(plan?.members).toHaveLength(2);
    expect(plan?.members).toEqual(
      expect.arrayContaining([
        { userId: s.ana, firstName: 'Ana' },
        { userId: s.sam, firstName: 'Sam' },
      ]),
    );
    expect(plan?.event.when).toMatch(/Sat/);
    expect(plan?.event.when).toMatch(/10:00/);
  });

  it('reads the seated group, including people who are not parents', async () => {
    const s = await seed();
    const rosa = await user('Rosa');
    await seat(s.familyId, s.ana, 'parent');
    await seat(s.familyId, rosa, 'other_family');
    const plan = await loadGroupPlan(db.database, request(s), MORNING);
    expect(plan?.members).toHaveLength(2);
    expect(plan?.members).toEqual(
      expect.arrayContaining([
        { userId: s.ana, firstName: 'Ana' },
        { userId: rosa, firstName: 'Rosa' },
      ]),
    );
  });

  it('counts a calendar as reached only while the latest Google write there landed', async () => {
    const s = await seed();
    await googleWrite(s.familyId, s.familyEventId, s.sam);
    expect((await loadGroupPlan(db.database, request(s), MORNING))?.reachedUserIds).toEqual([
      s.sam,
    ]);
    await audit(s.familyId, 'action.calendar_moved', s.familyEventId);
    await audit(s.familyId, 'integration.google_calendar_failed', s.familyEventId);
    const moved = await loadGroupPlan(db.database, request(s), MORNING);
    expect(moved?.change).toBe('moved');
    expect(moved?.reachedUserIds).toEqual([]);
  });

  it('gives a move its own revision, so the group hears about it once more', async () => {
    const s = await seed();
    const added = await loadGroupPlan(db.database, request(s), MORNING);
    await audit(s.familyId, 'action.calendar_moved', s.familyEventId);
    const moved = await loadGroupPlan(db.database, request(s), MORNING);
    expect(moved?.change).toBe('moved');
    expect(moved?.dedupeKey).not.toBe(added?.dedupeKey);
  });

  it('reads a cancel of a removed row, and nothing for a REQUEST on one', async () => {
    const s = await seed();
    await db.database
      .update(schema.familyEvents)
      .set({ deletedAt: MORNING })
      .where(eq(schema.familyEvents.id, s.familyEventId));
    expect(await loadGroupPlan(db.database, request(s), MORNING)).toBeNull();
    const cancelled = await loadGroupPlan(db.database, request(s, 'CANCEL'), MORNING);
    expect(cancelled).toMatchObject({
      change: 'cancelled',
      dedupeKey: `group_plan_calendar:${s.familyEventId}:cancelled`,
      reachedUserIds: [],
    });
  });

  it('keeps a private event private in the group, as the linked file does', async () => {
    const s = await seed({ sensitive: true });
    const plan = await loadGroupPlan(db.database, request(s), MORNING);
    expect(plan?.event.title).not.toContain('Swim');
    expect(plan?.event.where).toBeNull();
  });

  it("writes in the family's language", async () => {
    const s = await seed({ language: 'fr' });
    const plan = await loadGroupPlan(db.database, request(s), MORNING);
    expect(plan?.language).toBe('fr');
    expect(plan?.event.when).toMatch(/sam/);
  });

  it('is nothing for a family with no group chat', async () => {
    const s = await seed();
    await db.database
      .update(schema.families)
      .set({ linqGroupChatId: null })
      .where(eq(schema.families.id, s.familyId));
    expect(await loadGroupPlan(db.database, request(s), MORNING)).toBeNull();
  });
});

describe('VIL-443 production ports, real database', () => {
  it('gates on the primary parent: daytime passes, night holds', async () => {
    const s = await seed();
    const ports = productionGroupPlanReportPorts(db.database);
    expect(await ports.gate(s.familyId, s.ana, MORNING)).toMatchObject({ allowed: true });
    expect(await ports.gate(s.familyId, s.ana, NIGHT)).toEqual({
      allowed: false,
      reason: 'quiet_hours',
    });
  });

  it('mints a link anyone in the group can open, at the generic floor', async () => {
    const s = await seed({ sensitive: true });
    const link = await productionGroupPlanReportPorts(db.database).mintLink(
      s.familyId,
      s.familyEventId,
    );
    const token = link.split('/api/ics/event/')[1] as string;
    const ics = await loadEventInvite(db.database, token, MORNING);
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).not.toContain('Swim');
  });

  it('sends one text into the group, once per revision, and audits it without the title', async () => {
    const s = await seed();
    const wire = linqWire();
    const ports = productionGroupPlanReportPorts(db.database, {
      fetch: wire.fetch,
      now: () => MORNING,
    });
    const plan = (await loadGroupPlan(db.database, request(s), MORNING)) as GroupPlan;
    expect(await ports.send(plan, 'Swim is set. Add it here: https://x.test/l', 'short')).toBe(
      'sent',
    );
    expect(await ports.send(plan, 'Swim is set again.', 'short')).toBe('already_sent');
    expect(wire.posted.map((p) => p.url)).toEqual([GROUP_MESSAGES]);
    expect(await ports.alreadySent(plan.dedupeKey)).toBe(true);

    const [message] = await db.database
      .select()
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.dedupeKey, plan.dedupeKey));
    expect(message).toMatchObject({
      familyId: s.familyId,
      channel: 'imessage',
      direction: 'out',
      templateKey: 'group_plan_calendar',
      providerChatId: GROUP,
      providerMessageId: 'm-1',
      status: 'sent',
    });
    const rows = await db.database
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.familyId, s.familyId),
          eq(schema.auditLog.actionTaken, 'group_plan.calendar_reported'),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ targetTable: 'channel_messages', targetId: message?.id });
    expect(rows[0]?.after).toEqual({ familyEventId: s.familyEventId, change: 'added' });
  });

  it('marks a send Linq refused as failed, and keeps the revision spent so it never doubles', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = await seed();
    const ports = productionGroupPlanReportPorts(db.database, { fetch: linqWire(400).fetch });
    const plan = (await loadGroupPlan(db.database, request(s), MORNING)) as GroupPlan;
    expect(await ports.send(plan, 'Swim is set.', 'short')).toBe('send_failed');
    const [message] = await db.database
      .select({ status: schema.channelMessages.status })
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.familyId, s.familyId));
    expect(message?.status).toBe('failed');
    expect(await ports.alreadySent(plan.dedupeKey)).toBe(true);
    expect(
      await db.database
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.actionTaken, 'group_plan.calendar_reported')),
    ).toEqual([]);
  });

  it('records an unwritten text against the placing action and sends nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = await seed();
    const plan = (await loadGroupPlan(db.database, request(s), MORNING)) as GroupPlan;
    await productionGroupPlanReportPorts(db.database).unsent(plan);
    const [row] = await db.database
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'group_plan.line_unsent'));
    expect(row).toMatchObject({ targetTable: 'actions', targetId: s.actionId });
    expect(row?.after).toEqual({ familyEventId: s.familyEventId, change: 'added' });
    expect(
      await db.database
        .select()
        .from(schema.channelMessages)
        .where(eq(schema.channelMessages.familyId, s.familyId)),
    ).toEqual([]);
  });

  it('end to end: a group plan reaches the group with its real link, and no 1:1 invite goes', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.stubEnv('GROUP_PLAN_CALENDAR_REPORT_ENABLED', 'true');
    const s = await seed();
    const wire = linqWire();
    const production = productionGroupPlanReportPorts(db.database, {
      fetch: wire.fetch,
      now: () => MORNING,
    });
    const handed: unknown[] = [];
    const inner = { send: vi.fn(async () => ({ status: 'reported', parents: [] }) as const) };
    const sender = withGroupPlanReport(inner, {
      ...production,
      compose: async (input) => {
        handed.push(input);
        return `Swim is set for Saturday at 10. Add it here: ${input.link}`;
      },
    });
    expect(await sender.send(request(s))).toEqual({ status: 'group_reported', outcome: 'sent' });
    expect(inner.send).not.toHaveBeenCalled();
    expect(handed).toEqual([
      expect.objectContaining({
        change: 'added',
        onCalendarOf: [],
        notYet: expect.arrayContaining(['Ana', 'Sam']),
        everyone: false,
        link: expect.stringContaining(`/api/ics/event/${s.familyEventId}.`),
      }),
    ]);
    expect(JSON.stringify(wire.posted[0]?.body)).toContain(`/api/ics/event/${s.familyEventId}.`);
    expect(await sender.send(request(s))).toEqual({
      status: 'group_reported',
      outcome: 'already_sent',
    });
    expect(wire.posted).toHaveLength(1);
  });
});
