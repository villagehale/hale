import { schema } from '@hale/db';
import type {
  CalendarInviteReport,
  CalendarInviteRequest,
  CalendarInviteSender,
} from '@hale/worker/executor';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordWatchConsent } from '~/lib/channel/intake/watch-consent';
import { assertProactiveSendAllowed, buildOutboundGatePorts } from '~/lib/channel/outbound-gate';
import { MAX_REDRIVE_PER_RUN } from '~/lib/channel/redrive-slot';
import { channelGroupNoteKey } from '~/lib/coach/note-key';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { loadEventInvite } from '~/lib/loop/ics-invite';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import {
  emptyGroupPlanRedriveResult,
  runGroupPlanReportRedrive,
  selectOpenGroupPlanHolds,
} from './redrive';
import type { GroupPlanReportInput } from './report';
import {
  type GroupPlan,
  loadGroupPlan,
  productionGroupPlanReportPorts,
  withGroupPlanReport,
} from './send';
import { productionRecordGroupPlanOrigin } from './stamp';

/**
 * VIL-443 (T17) 2/2 against a real database: which placements are a group's plan, the
 * facts read for its text (writing nothing), the real link anyone can open, the group
 * send — once per revision, with an audit row that carries no title or names — and the
 * night hold its 08:00 re-drive sends. No model runs here: where a text is needed, the
 * composer port returns a fixed one.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const GROUP = 'chat-group-plan';
const GROUP_MESSAGES = `https://api.linqapp.com/api/partner/v3/chats/${GROUP}/messages`;
const MORNING = new Date('2026-11-06T15:00:00.000Z'); // 10:00 Toronto
const NIGHT = new Date('2026-11-07T04:00:00.000Z'); // 23:00 Toronto
const STARTS = new Date('2026-11-07T15:00:00.000Z'); // Sat 10:00 Toronto
const ENDS = new Date('2026-11-07T16:00:00.000Z'); // Sat 11:00 Toronto
const PLACE = 'Riverside Y, 120 Main St, Toronto';

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

async function seed(
  opts: {
    group?: boolean;
    /** The chat whose thread drafted the plan, when it is not the family's own group. */
    draftedIn?: string;
    sensitive?: boolean;
    language?: string;
    childDob?: string;
    endsAt?: Date | null;
  } = {},
) {
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
  const [child] = opts.childDob
    ? await db.database
        .insert(schema.children)
        .values({ familyId, name: 'Mia', dateOfBirth: opts.childDob })
        .returning({ id: schema.children.id })
    : [];
  const [placed] = await db.database
    .insert(schema.familyEvents)
    .values({
      familyId,
      title: 'Swim lesson',
      startsAt: STARTS,
      endsAt: opts.endsAt === undefined ? ENDS : opts.endsAt,
      location: PLACE,
      source: 'placement',
      sensitive: opts.sensitive ?? false,
      childId: child?.id ?? null,
      placedByActionId: actionId,
    })
    .returning({ id: schema.familyEvents.id });
  const familyEventId = placed?.id as string;
  await audit(familyId, 'action.calendar_placed', familyEventId);
  let origin: string | null = null;
  if (opts.group ?? true) {
    const [thread] = await db.database
      .insert(schema.conversations)
      .values({ familyId, noteKey: channelGroupNoteKey(opts.draftedIn ?? GROUP) })
      .returning({ id: schema.conversations.id });
    origin = await productionRecordGroupPlanOrigin(db.database)({
      familyId,
      actor: ana,
      actionId,
      conversationId: thread?.id as string,
    });
  }
  return { familyId, ana, sam, actionId, familyEventId, origin, payload: action?.payload };
}

async function audit(
  familyId: string,
  actionTaken: string,
  familyEventId: string,
  occurredAt?: Date,
) {
  await db.database.insert(schema.auditLog).values({
    familyId,
    actor: 'system',
    actionTaken,
    targetTable: 'family_events',
    targetId: familyEventId,
    ...(occurredAt ? { occurredAt } : {}),
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

/** The chat's roster (group onboarding v2), in the given status, with these members. */
async function roster(
  familyId: string,
  status: 'confirmed' | 'roles_proposed',
  members: Array<{
    status: 'known_parent' | 'confirmed' | 'asked';
    confirmedRole?: 'grandparent' | 'nanny';
  }>,
) {
  const [row] = await db.database
    .insert(schema.linqGroupRosters)
    .values({ chatId: GROUP, familyId, source: 'new_group', status })
    .returning({ id: schema.linqGroupRosters.id });
  for (const member of members) {
    n += 1;
    await db.database.insert(schema.linqGroupRosterMembers).values({
      rosterId: row?.id as string,
      chatId: GROUP,
      phoneE164Hash: phoneBlindIndex(`+1647555${7000 + n}`),
      status: member.status,
      confirmedRole: member.confirmedRole ?? null,
    });
  }
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

/** Linq, answering `status` to every send after the first `landsFirst`. */
function linqWire(status = 200, landsFirst = 0) {
  const posted: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    posted.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    if (status !== 200 && posted.length > landsFirst)
      return new Response(JSON.stringify({ error: { code: status } }), { status });
    return new Response(JSON.stringify({ message: { id: `m-${posted.length}` } }), { status: 200 });
  });
  return { fetch: fetchImpl as unknown as typeof fetch, posted };
}

/** The text of each message posted, in order. */
function postedTexts(posted: Array<{ body: unknown }>) {
  return posted.map(
    (p) => (p.body as { message: { parts: Array<{ value: string }> } }).message.parts[0]?.value,
  );
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

  it('records the origin, naming the chat, only for a plan made in the household group', async () => {
    const s = await seed();
    expect(s.origin).toBe('recorded');
    const [row] = await db.database
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'group_plan.drafted'));
    expect(row).toMatchObject({ targetTable: 'actions', targetId: s.actionId, actor: s.ana });
    expect(row?.after).toEqual({ chatId: GROUP });
  });

  it('is not a group plan when it was made in another group chat', async () => {
    const s = await seed({ draftedIn: 'chat-shared-with-another-family' });
    expect(s.origin).toBe('outside_household_group');
    expect(
      await db.database
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.actionTaken, 'group_plan.drafted')),
    ).toEqual([]);
    expect(await loadGroupPlan(db.database, request(s), MORNING)).toBeNull();
  });

  it('is not a group plan once the family group is another chat', async () => {
    const s = await seed();
    await db.database
      .update(schema.families)
      .set({ linqGroupChatId: 'chat-claimed-later' })
      .where(eq(schema.families.id, s.familyId));
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
      event: { title: 'Swim lesson', where: PLACE },
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
    expect(plan?.event.starts).toMatch(/Sat/);
    expect(plan?.event.starts).toMatch(/10:00/);
    expect(plan?.event.ends).toMatch(/11:00/);
    expect(plan?.event.ends).not.toMatch(/Sat/);
  });

  it('says no end for a plan placed without one, rather than guessing', async () => {
    const s = await seed({ endsAt: null });
    const plan = await loadGroupPlan(db.database, request(s), MORNING);
    expect(plan?.event.ends).toBeNull();
    expect(plan?.event.starts).toMatch(/10:00/);
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

  it('does not count a calendar the move never wrote to, until a write there lands', async () => {
    const s = await seed();
    await googleWrite(s.familyId, s.familyEventId, s.sam);
    const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);
    // T6 skipped the update (no token, flag off): a move with no Google outcome after it.
    await audit(s.familyId, 'action.calendar_moved', s.familyEventId, later(1));
    expect((await loadGroupPlan(db.database, request(s), MORNING))?.reachedUserIds).toEqual([]);
    await audit(s.familyId, 'integration.google_calendar_written', s.familyEventId, later(2));
    expect((await loadGroupPlan(db.database, request(s), MORNING))?.reachedUserIds).toEqual([
      s.sam,
    ]);
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

  it('classifies the plan the way the group audience gate reads a placed row', async () => {
    const classOf = async (opts: Parameters<typeof seed>[0]) => {
      const s = await seed(opts);
      const plan = await loadGroupPlan(db.database, request(s), MORNING);
      await db.exec('truncate table families, users cascade');
      return plan?.contentClass;
    };
    expect(await classOf({})).toBe('schedule');
    expect(await classOf({ childDob: '2022-04-01' })).toBe('event_logistics');
    expect(await classOf({ childDob: '2022-04-01', sensitive: true })).toBe('health');
    expect(await classOf({ childDob: '2011-02-01' })).toBe('teen_content');
  });

  it("writes in the family's language", async () => {
    const s = await seed({ language: 'fr' });
    const plan = await loadGroupPlan(db.database, request(s), MORNING);
    expect(plan?.language).toBe('fr');
    expect(plan?.event.starts).toMatch(/sam/);
    expect(plan?.event.ends).toMatch(/11( h |:)00/);
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

  it('does not ask for watch consent: a parent said yes to the plan', async () => {
    const s = await seed();
    await recordWatchConsent(
      db.database,
      {
        familyId: s.familyId,
        userId: s.ana,
        granted: false,
        verbatimReply: 'no thanks',
        interpretation: 'the parent declined being watched',
        channelMessageId: null,
      },
      new Date(MORNING.getTime() + 60_000),
    );
    const proactive = await assertProactiveSendAllowed(
      { familyId: s.familyId, parentUserId: s.ana, kind: 'calendar_alert', now: MORNING },
      buildOutboundGatePorts(db.database),
    );
    expect(proactive).toEqual({ allowed: false, reason: 'no_watch_consent' });
    const ports = productionGroupPlanReportPorts(db.database);
    expect(await ports.gate(s.familyId, s.ana, MORNING)).toMatchObject({ allowed: true });
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
    const one = (text: string) => ({ messages: [text], keyed: 0 });
    expect(await ports.send(plan, one('Swim is set. Add it here: https://x.test/l'), 'short')).toBe(
      'sent',
    );
    expect(await ports.send(plan, one('Swim is set again.'), 'short')).toBe('already_sent');
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
    expect(rows[0]?.after).toEqual({
      familyEventId: s.familyEventId,
      change: 'added',
      messages: 1,
      landed: 1,
    });
  });

  /** Each of the family's outbound rows, in the order the messages went. */
  async function rowsOf(familyId: string) {
    return db.database
      .select({
        dedupeKey: schema.channelMessages.dedupeKey,
        status: schema.channelMessages.status,
        providerMessageId: schema.channelMessages.providerMessageId,
        errorCode: schema.channelMessages.errorCode,
      })
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.familyId, familyId))
      .orderBy(schema.channelMessages.providerMessageId);
  }

  it('sends a few messages in order, keying the revision on the one carrying the link', async () => {
    const s = await seed();
    const wire = linqWire();
    const ports = productionGroupPlanReportPorts(db.database, {
      fetch: wire.fetch,
      now: () => MORNING,
    });
    const plan = (await loadGroupPlan(db.database, request(s), MORNING)) as GroupPlan;
    const messages = ['Swim is set for Saturday.', 'Add it: https://x.test/l', 'See you there.'];
    expect(await ports.send(plan, { messages, keyed: 1 }, 'short')).toBe('sent');
    expect(postedTexts(wire.posted)).toEqual(messages);
    expect(await rowsOf(s.familyId)).toEqual([
      {
        dedupeKey: `${plan.dedupeKey}#0`,
        status: 'sent',
        providerMessageId: 'm-1',
        errorCode: null,
      },
      { dedupeKey: plan.dedupeKey, status: 'sent', providerMessageId: 'm-2', errorCode: null },
      {
        dedupeKey: `${plan.dedupeKey}#2`,
        status: 'sent',
        providerMessageId: 'm-3',
        errorCode: null,
      },
    ]);
    const [audited] = await db.database
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'group_plan.calendar_reported'));
    expect(audited?.after).toEqual({
      familyEventId: s.familyEventId,
      change: 'added',
      messages: 3,
      landed: 3,
    });
    expect(await ports.send(plan, { messages, keyed: 1 }, 'short')).toBe('already_sent');
    expect(wire.posted).toHaveLength(3);
  });

  it('stops at a message that did not land, and fails the link it never got to', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = await seed();
    const wire = linqWire(400, 1);
    const ports = productionGroupPlanReportPorts(db.database, { fetch: wire.fetch });
    const plan = (await loadGroupPlan(db.database, request(s), MORNING)) as GroupPlan;
    const messages = [
      'Swim is set for Saturday.',
      '10 to 11 at the Y.',
      'Add it: https://x.test/l',
    ];
    expect(await ports.send(plan, { messages, keyed: 2 }, 'short')).toBe('send_failed');
    expect(postedTexts(wire.posted)).toEqual(messages.slice(0, 2));
    expect(
      Object.fromEntries((await rowsOf(s.familyId)).map((r) => [r.dedupeKey, r.status])),
    ).toEqual({
      [`${plan.dedupeKey}#0`]: 'sent',
      [`${plan.dedupeKey}#1`]: 'failed',
      [plan.dedupeKey]: 'failed',
    });
    expect(
      await db.database
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.actionTaken, 'group_plan.calendar_reported')),
    ).toEqual([]);
  });

  it('is partly sent when the link landed and a message after it did not', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = await seed();
    const wire = linqWire(400, 1);
    const ports = productionGroupPlanReportPorts(db.database, { fetch: wire.fetch });
    const plan = (await loadGroupPlan(db.database, request(s), MORNING)) as GroupPlan;
    const messages = ['Swim is set. Add it: https://x.test/l', 'See you there.'];
    expect(await ports.send(plan, { messages, keyed: 0 }, 'short')).toBe('partly_sent');
    expect(
      Object.fromEntries((await rowsOf(s.familyId)).map((r) => [r.dedupeKey, r.status])),
    ).toEqual({ [plan.dedupeKey]: 'sent', [`${plan.dedupeKey}#1`]: 'failed' });
    const [audited] = await db.database
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'group_plan.calendar_reported'));
    expect(audited?.after).toMatchObject({ messages: 2, landed: 1 });
  });

  it('marks a send Linq refused as failed, and keeps the revision spent so it never doubles', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = await seed();
    const ports = productionGroupPlanReportPorts(db.database, { fetch: linqWire(400).fetch });
    const plan = (await loadGroupPlan(db.database, request(s), MORNING)) as GroupPlan;
    expect(await ports.send(plan, { messages: ['Swim is set.'], keyed: 0 }, 'short')).toBe(
      'send_failed',
    );
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
    const inner = {
      send: vi.fn(async (): Promise<CalendarInviteReport> => ({ status: 'reported', parents: [] })),
    };
    const sender = withGroupPlanReport(inner, {
      ...production,
      compose: async (input) => {
        handed.push(input);
        return ['Swim is set for Saturday, 10 to 11.', `Add it here: ${input.link}`];
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
        event: expect.objectContaining({ where: PLACE, ends: expect.stringMatching(/11:00/) }),
      }),
    ]);
    expect(wire.posted).toHaveLength(2);
    expect(JSON.stringify(wire.posted[1]?.body)).toContain(`/api/ics/event/${s.familyEventId}.`);
    expect(await sender.send(request(s))).toEqual({
      status: 'group_reported',
      outcome: 'already_sent',
    });
    expect(wire.posted).toHaveLength(2);
  });

  async function reportAt(now: Date, wire: ReturnType<typeof linqWire>) {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('GROUP_PLAN_CALENDAR_REPORT_ENABLED', 'true');
    const s = await seed();
    const inner = {
      send: vi.fn(async (): Promise<CalendarInviteReport> => ({ status: 'reported', parents: [] })),
    };
    const compose = vi.fn(async (input: { link: string | null }) => [`Swim is set: ${input.link}`]);
    const sender = withGroupPlanReport(inner, {
      ...productionGroupPlanReportPorts(db.database, { fetch: wire.fetch, now: () => now }),
      compose,
    });
    return { report: await sender.send(request(s)), inner, compose, sender, s };
  }

  it('holds the group text for the morning, once, and texts no parent tonight', async () => {
    const wire = linqWire();
    const { report, inner, compose, sender, s } = await reportAt(NIGHT, wire);
    expect(report).toEqual({ status: 'group_reported', outcome: 'held:quiet_hours' });
    expect(await sender.send(request(s))).toEqual(report);
    expect(inner.send).not.toHaveBeenCalled();
    expect(compose).not.toHaveBeenCalled();
    expect(wire.posted).toEqual([]);
    const plan = (await loadGroupPlan(db.database, request(s), NIGHT)) as GroupPlan;
    const holds = await db.database
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'group_plan.report_held'));
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({
      familyId: s.familyId,
      targetTable: 'actions',
      targetId: s.actionId,
      occurredAt: NIGHT,
    });
    expect(holds[0]?.after).toEqual({
      familyEventId: s.familyEventId,
      dedupeKey: plan.dedupeKey,
      method: 'REQUEST',
      change: 'added',
      gateUserId: s.ana,
    });
  });

  it('gives the parents their own invites when Linq refuses the group text', async () => {
    const wire = linqWire(400);
    const { report, inner } = await reportAt(MORNING, wire);
    expect(report).toEqual({ status: 'reported', parents: [], groupNotTold: 'send_failed' });
    expect(inner.send).toHaveBeenCalledTimes(1);
    expect(wire.posted).toHaveLength(1);
  });

  describe('with group onboarding v2, the group hears only what everyone in it may', () => {
    async function run(opts: Parameters<typeof seed>[0], setUp: (familyId: string) => unknown) {
      vi.spyOn(console, 'info').mockImplementation(() => {});
      vi.stubEnv('GROUP_PLAN_CALENDAR_REPORT_ENABLED', 'true');
      vi.stubEnv('LINQ_GROUP_ONBOARDING_V2_ENABLED', 'true');
      const s = await seed(opts);
      await setUp(s.familyId);
      const wire = linqWire();
      const inner = {
        send: vi.fn(
          async (): Promise<CalendarInviteReport> => ({ status: 'reported', parents: [] }),
        ),
      };
      const sender = withGroupPlanReport(inner, {
        ...productionGroupPlanReportPorts(db.database, { fetch: wire.fetch, now: () => MORNING }),
        compose: async (input) => [`Swim is set. Add it here: ${input.link}`],
      });
      return { report: await sender.send(request(s)), inner, posted: wire.posted };
    }

    it('reports to a confirmed group of parents and a grandparent', async () => {
      const { report, inner, posted } = await run({ childDob: '2022-04-01' }, (familyId) =>
        roster(familyId, 'confirmed', [
          { status: 'known_parent' },
          { status: 'confirmed', confirmedRole: 'grandparent' },
        ]),
      );
      expect(report).toEqual({ status: 'group_reported', outcome: 'sent' });
      expect(inner.send).not.toHaveBeenCalled();
      expect(posted.map((p) => p.url)).toEqual([GROUP_MESSAGES]);
    });

    it("gives the parents their own invites for a teen's plan, and the group nothing", async () => {
      const { report, inner, posted } = await run({ childDob: '2011-02-01' }, (familyId) =>
        roster(familyId, 'confirmed', [{ status: 'known_parent' }]),
      );
      expect(report).toEqual({
        status: 'reported',
        parents: [],
        groupNotTold: 'audience:group_audience_refused',
      });
      expect(inner.send).toHaveBeenCalledTimes(1);
      expect(posted).toEqual([]);
    });

    it('gives the parents their own invites while the roster is not confirmed', async () => {
      const { report, inner, posted } = await run({}, (familyId) =>
        roster(familyId, 'roles_proposed', [{ status: 'known_parent' }, { status: 'asked' }]),
      );
      expect(report).toEqual({
        status: 'reported',
        parents: [],
        groupNotTold: 'audience:group_roles_unconfirmed',
      });
      expect(inner.send).toHaveBeenCalledTimes(1);
      expect(posted).toEqual([]);
    });
  });
});

describe('VIL-443 the 08:00 re-drive of a group text quiet hours held', () => {
  const DAWN = new Date('2026-11-07T13:12:00.000Z'); // Sat 08:12 Toronto
  const NEXT_DAWN = new Date('2026-11-08T13:12:00.000Z'); // Sun 08:12 Toronto
  const LATER_NIGHT = new Date(NIGHT.getTime() + 30 * 60_000); // 23:30 Toronto

  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('GROUP_PLAN_CALENDAR_REPORT_ENABLED', 'true');
  });

  /** The placement's own sender, as the cron builds it, on a fake Linq and a stand-in
   * composer. */
  function senderAt(
    now: Date,
    opts: {
      wire?: ReturnType<typeof linqWire>;
      compose?: (input: GroupPlanReportInput) => Promise<string[] | null>;
    } = {},
  ) {
    const wire = opts.wire ?? linqWire();
    const inner = {
      send: vi.fn(async (): Promise<CalendarInviteReport> => ({ status: 'reported', parents: [] })),
    };
    const sender = withGroupPlanReport(inner, {
      ...productionGroupPlanReportPorts(db.database, { fetch: wire.fetch, now: () => now }),
      compose:
        opts.compose ??
        (async (input) => [
          input.link ? `Swim is set. Add it here: ${input.link}` : 'Swim is off.',
        ]),
    });
    return { sender, inner, wire };
  }

  async function holdAt(
    at: Date,
    s: { familyId: string; familyEventId: string },
    method: 'REQUEST' | 'CANCEL' = 'REQUEST',
  ) {
    expect(await senderAt(at).sender.send(request(s, method))).toEqual({
      status: 'group_reported',
      outcome: 'held:quiet_hours',
    });
  }

  const redrive = (sender: CalendarInviteSender, at: Date) =>
    runGroupPlanReportRedrive(db.database, { sender }, at);

  /** Each release row's `after`, the outcomes sorted. */
  async function releases(familyId: string) {
    const rows = await db.database
      .select({ after: schema.auditLog.after })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.familyId, familyId),
          eq(schema.auditLog.actionTaken, 'group_plan.report_released'),
        ),
      );
    return rows
      .map((row) => row.after as { dedupeKey: string; outcome: string })
      .sort((a, b) => a.outcome.localeCompare(b.outcome));
  }

  it('sends the held text into the group at 08:00 with its real link, once, and closes the hold', async () => {
    const s = await seed();
    await holdAt(NIGHT, s);
    const plan = (await loadGroupPlan(db.database, request(s), DAWN)) as GroupPlan;
    const dawn = senderAt(DAWN);
    expect(await redrive(dawn.sender, DAWN)).toEqual({
      ...emptyGroupPlanRedriveResult(),
      open: 1,
      due: 1,
      sent: 1,
    });
    expect(dawn.inner.send).not.toHaveBeenCalled();
    expect(postedTexts(dawn.wire.posted)).toEqual([
      expect.stringContaining(`/api/ics/event/${s.familyEventId}.`),
    ]);
    expect(await releases(s.familyId)).toEqual([
      { familyEventId: s.familyEventId, dedupeKey: plan.dedupeKey, outcome: 'sent' },
    ]);

    const later = new Date(DAWN.getTime() + 30 * 60_000);
    expect(await redrive(senderAt(later, { wire: dawn.wire }).sender, later)).toMatchObject({
      open: 0,
      due: 0,
      sent: 0,
    });
    expect(dawn.wire.posted).toHaveLength(1);
  });

  it('sends nothing outside the 08:00 hour, and still owes the text', async () => {
    const s = await seed();
    await holdAt(NIGHT, s);
    const { sender, wire, inner } = senderAt(DAWN);
    for (const at of [new Date('2026-11-07T12:12:00.000Z'), new Date('2026-11-07T14:12:00.000Z')]) {
      expect(await redrive(sender, at)).toMatchObject({ open: 1, due: 0, sent: 0 });
    }
    expect(wire.posted).toEqual([]);
    expect(inner.send).not.toHaveBeenCalled();
    expect(await releases(s.familyId)).toEqual([]);
    expect(await selectOpenGroupPlanHolds(db.database, DAWN)).toHaveLength(1);
  });

  it('sends a plan moved overnight once, at its latest time', async () => {
    const s = await seed();
    await holdAt(NIGHT, s);
    await db.database
      .update(schema.familyEvents)
      .set({
        startsAt: new Date(STARTS.getTime() + 3_600_000),
        endsAt: new Date(ENDS.getTime() + 3_600_000),
      })
      .where(eq(schema.familyEvents.id, s.familyEventId));
    await audit(s.familyId, 'action.calendar_moved', s.familyEventId);
    await holdAt(LATER_NIGHT, s);
    const handed: GroupPlanReportInput[] = [];
    const dawn = senderAt(DAWN, {
      compose: async (input) => {
        handed.push(input);
        return [`Swim moved. Add it here: ${input.link}`];
      },
    });
    expect(await redrive(dawn.sender, DAWN)).toMatchObject({
      open: 2,
      due: 2,
      sent: 1,
      alreadySent: 1,
    });
    expect(handed).toEqual([
      expect.objectContaining({
        change: 'moved',
        event: expect.objectContaining({ starts: expect.stringMatching(/11:00/) }),
      }),
    ]);
    expect(dawn.wire.posted).toHaveLength(1);
    expect((await releases(s.familyId)).map((r) => r.outcome)).toEqual(['alreadySent', 'sent']);
  });

  it('releases a plan already under way by its morning, unsent', async () => {
    const s = await seed();
    await holdAt(NIGHT, s);
    const { sender, wire, inner } = senderAt(NEXT_DAWN);
    expect(await redrive(sender, NEXT_DAWN)).toMatchObject({ open: 1, due: 1, started: 1 });
    expect(wire.posted).toEqual([]);
    expect(inner.send).not.toHaveBeenCalled();
    expect((await releases(s.familyId)).map((r) => r.outcome)).toEqual(['started']);
  });

  it('drops an added plan removed overnight, and tells the group it is off', async () => {
    const s = await seed();
    await holdAt(NIGHT, s);
    await db.database
      .update(schema.familyEvents)
      .set({ deletedAt: LATER_NIGHT })
      .where(eq(schema.familyEvents.id, s.familyEventId));
    await holdAt(LATER_NIGHT, s, 'CANCEL');
    const dawn = senderAt(DAWN);
    expect(await redrive(dawn.sender, DAWN)).toMatchObject({
      open: 2,
      due: 2,
      gone: 1,
      sent: 1,
    });
    expect(postedTexts(dawn.wire.posted)).toEqual(['Swim is off.']);
    expect(dawn.inner.send).not.toHaveBeenCalled();
    expect((await releases(s.familyId)).map((r) => r.outcome)).toEqual(['gone', 'sent']);
  });

  it('gives the parents their own invites by day when Linq refuses the group text at 08:00', async () => {
    const s = await seed();
    await holdAt(NIGHT, s);
    const dawn = senderAt(DAWN, { wire: linqWire(400) });
    expect(await redrive(dawn.sender, DAWN)).toMatchObject({ due: 1, toParents: 1 });
    expect(dawn.inner.send).toHaveBeenCalledWith(request(s));
    expect((await releases(s.familyId)).map((r) => r.outcome)).toEqual(['toParents']);
  });

  it('sends nothing canned when the model writes nothing at 08:00, and does not ask again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = await seed();
    await holdAt(NIGHT, s);
    const dawn = senderAt(DAWN, { compose: async () => null });
    expect(await redrive(dawn.sender, DAWN)).toMatchObject({ due: 1, unwritten: 1 });
    expect(dawn.wire.posted).toEqual([]);
    expect(dawn.inner.send).not.toHaveBeenCalled();
    expect((await releases(s.familyId)).map((r) => r.outcome)).toEqual(['unwritten']);
    expect(await selectOpenGroupPlanHolds(db.database, DAWN)).toEqual([]);
  });

  it('keeps a hold for the next morning when the gate still reads night or the send throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = await seed();
    await holdAt(NIGHT, s);
    const stillNight = {
      send: vi.fn(
        async (): Promise<CalendarInviteReport> => ({
          status: 'group_reported',
          outcome: 'held:quiet_hours',
        }),
      ),
    };
    expect(await redrive(stillNight, DAWN)).toMatchObject({ due: 1, heldAgain: 1 });
    const throwing = { send: vi.fn(async () => Promise.reject(new Error('db'))) };
    expect(await redrive(throwing, DAWN)).toMatchObject({ due: 1, errored: 1 });
    expect(await releases(s.familyId)).toEqual([]);
    expect(await selectOpenGroupPlanHolds(db.database, DAWN)).toHaveLength(1);
  });

  it('stops re-driving a hold once it is a week old', async () => {
    const s = await seed();
    await holdAt(NIGHT, s);
    const weekOn = new Date('2026-11-14T13:12:00.000Z'); // Sat 08:12 Toronto, a week on
    const { sender, wire } = senderAt(weekOn);
    expect(await redrive(sender, weekOn)).toMatchObject({ open: 0, due: 0 });
    expect(wire.posted).toEqual([]);
  });

  it('serves the longest-held first and counts what its cap defers', async () => {
    const s = await seed();
    const over = MAX_REDRIVE_PER_RUN + 1;
    const events = await db.database
      .insert(schema.familyEvents)
      .values(
        Array.from({ length: over }, (_, i) => ({
          familyId: s.familyId,
          title: `Plan ${i}`,
          startsAt: STARTS,
          source: 'placement' as const,
        })),
      )
      .returning({ id: schema.familyEvents.id });
    // Inserted newest-first, so a read that trusts heap order serves the wrong end.
    await db.database.insert(schema.auditLog).values(
      events.map((event, i) => ({
        familyId: s.familyId,
        actor: 'system',
        actionTaken: 'group_plan.report_held',
        targetTable: 'actions',
        targetId: s.actionId,
        occurredAt: new Date(NIGHT.getTime() - i * 60_000),
        after: {
          familyEventId: event.id,
          dedupeKey: `group_plan_calendar:${event.id}:1`,
          method: 'REQUEST',
          change: 'added',
          gateUserId: s.ana,
        },
      })),
    );
    const sender = {
      send: vi.fn(
        async (_request: CalendarInviteRequest): Promise<CalendarInviteReport> => ({
          status: 'group_reported',
          outcome: 'sent',
        }),
      ),
    };
    expect(await redrive(sender, DAWN)).toMatchObject({
      open: over,
      due: over,
      deferred: 1,
      sent: MAX_REDRIVE_PER_RUN,
    });
    const served = sender.send.mock.calls.map(([req]) => req.familyEventId);
    expect(served).not.toContain(events[0]?.id);
    expect(served[0]).toBe(events[over - 1]?.id);
  });
});
