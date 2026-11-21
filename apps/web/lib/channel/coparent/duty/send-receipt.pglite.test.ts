import type { AgentClient } from '@hale/agent';
import { schema } from '@hale/db';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { LinqSendError } from '~/lib/channel/linq/transport';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import type { OpsPage } from '~/lib/monitoring/failure-page';
import {
  type TestDb,
  createTestDb,
  seedChild,
  seedFamily,
  seedIntegration,
} from '~/lib/testing/pglite';
import { acknowledgeDutyWrite } from './ack';
import {
  type DutySendPorts,
  deliverDutyGroupLine,
  planFamilyDutyAsks,
  sweepDutyAsks,
} from './asks';
import {
  COPARENT_DUTY_MEMORY_ENABLED_ENV,
  COPARENT_DUTY_SENDS_ENABLED_ENV,
  COPARENT_SPLIT_DUTY_ENABLED_ENV,
} from './flag';
import { commitDutyUpdate } from './model';

const KEY = Buffer.alloc(32, 7).toString('base64');
const PHONE_ONE = '+15555550101';
const PHONE_TWO = '+15555550102';

let db: TestDb;

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Sunday 27 Sep 2026, 18:00 in Toronto: inside the night-before window. */
const EVENING = new Date('2026-09-27T22:00:00.000Z');
/** Sunday 27 Sep 2026, 15:00 in Toronto. */
const AFTERNOON = new Date('2026-09-27T19:00:00.000Z');
const MONDAY = new Date('2026-09-28T19:00:00.000Z');
const DAY = new Date('2026-09-24T15:00:00.000Z');
const HOUR_MS = 60 * 60_000;
const later = (hours: number, from: Date = EVENING) => new Date(from.getTime() + hours * HOUR_MS);
const refused = () => new LinqSendError('http_500', 500, false);
const timedOut = () => new LinqSendError('timeout', 0, false);

function pager() {
  const pages: OpsPage[] = [];
  return {
    pages,
    pager: {
      page: async (page: OpsPage) => {
        pages.push(page);
        return 'paged' as const;
      },
    },
  };
}

function ports(
  send: DutySendPorts['send'],
  chatId: string,
  opsPager?: ReturnType<typeof pager>['pager'],
): DutySendPorts {
  return {
    target: async () => ({ channel: 'group', chatId, familyId: 'ignored' }),
    gate: vi.fn(async () => ({ allowed: true as const, optOut: 'short' as const })),
    gatePorts: () => ({
      channelEnrolled: async () => true,
      watchConsentGranted: async () => true,
      countProactiveSends: async () => 0,
      proactiveSentSince: async () => true,
      parentTimeZone: async () => 'America/Toronto',
    }),
    send,
    pager: opsPager,
  };
}

async function outRows(familyId: string) {
  return db.database
    .select({
      status: schema.channelMessages.status,
      errorCode: schema.channelMessages.errorCode,
      providerMessageId: schema.channelMessages.providerMessageId,
      sentAt: schema.channelMessages.sentAt,
    })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, familyId),
        eq(schema.channelMessages.direction, 'out'),
      ),
    )
    .orderBy(asc(schema.channelMessages.createdAt));
}

async function sendAudits(familyId: string, verb: string) {
  return db.database
    .select({ after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.familyId, familyId), eq(schema.auditLog.actionTaken, verb)));
}

function deliver(
  family: { familyId: string; parentUserId: string },
  dedupeKey: string,
  now: Date,
  sendPorts: DutySendPorts,
) {
  return deliverDutyGroupLine(
    db.database,
    {
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      text: 'A model-written duty question.',
      now,
      dedupeKey,
      templateKey: 'linq:group_duty_night_before',
      sendsActive: true,
      composed: true,
    },
    sendPorts,
  );
}

async function twoParents(name: string) {
  const family = await seedFamily(db.database, name);
  await db.database
    .update(schema.users)
    .set({ timezone: 'America/Toronto' })
    .where(eq(schema.users.id, family.parentUserId));
  const email = `second-${family.familyId}@example.test`;
  const inserted = (await db.database.execute(
    sql`insert into users (email, name) values (${email}, 'Sam') returning id`,
  )) as unknown as { rows?: Array<{ id: string }> } | Array<{ id: string }>;
  const second = (Array.isArray(inserted) ? inserted : (inserted.rows ?? []))[0];
  if (!second) throw new Error('second parent insert returned no row');
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId: family.familyId, userId: second.id, role: 'co_parent' });
  return { ...family, secondUserId: second.id };
}

async function kidBlock(
  family: { familyId: string; parentUserId: string },
  integrationId: string,
  eventId: string,
  title: string,
  childId?: string,
) {
  await db.database.insert(schema.parentCalendarBlocks).values({
    integrationId,
    eventId,
    familyId: family.familyId,
    userId: family.parentUserId,
    startAt: MONDAY,
    endAt: new Date(MONDAY.getTime() + HOUR_MS),
    kidRelated: true,
    title,
    calendarStanding: 'organizer',
    childId: childId ?? null,
    status: 'confirmed',
    updatedStamp: '1',
  });
}

async function nightBeforeFamily(name: string) {
  const family = await twoParents(name);
  await db.database
    .update(schema.families)
    .set({ linqGroupChatId: `chat-${name}` })
    .where(eq(schema.families.id, family.familyId));
  await seedChild(db.database, family.familyId, 'Robin', 36, undefined, EVENING);
  const integrationId = await seedIntegration(
    db.database,
    family.familyId,
    family.parentUserId,
    'gcal',
  );
  await kidBlock(family, integrationId, `evt-${name}`, 'Robin swim');
  await commitDutyUpdate(db.database, {
    mode: 'write',
    familyId: family.familyId,
    actorUserId: family.parentUserId,
    parentCount: 2,
    subjectKey: `evt-${name}`,
    eventTitle: 'Robin swim',
    childNames: ['Robin'],
    slot: { role: 'pickup', claim: 'self', name: null, userId: family.parentUserId, confidence: 1 },
    prior: null,
    source: 'text',
    now: EVENING,
    childId: null,
    question: false,
    askWhichKid: false,
  });
  return family;
}

/** Two overlapping kids, no family group: the split ask goes to each parent on a 1:1. */
async function splitFamilyOnOneToOnes(name: string) {
  const family = await twoParents(name);
  for (const [userId, phone] of [
    [family.parentUserId, PHONE_ONE],
    [family.secondUserId, PHONE_TWO],
  ] as const) {
    await db.database.insert(schema.parentChannels).values({
      userId,
      familyId: family.familyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(phone),
      phoneE164Hash: phoneBlindIndex(`${phone}-${family.familyId}`),
      verifiedAt: AFTERNOON,
    });
  }
  const robin = await seedChild(db.database, family.familyId, 'Robin', 36, undefined, AFTERNOON);
  const casey = await seedChild(db.database, family.familyId, 'Casey', 48, undefined, AFTERNOON);
  const integrationId = await seedIntegration(
    db.database,
    family.familyId,
    family.parentUserId,
    'gcal',
  );
  await kidBlock(family, integrationId, `evt-${name}-hockey`, 'Robin hockey', robin);
  await kidBlock(family, integrationId, `evt-${name}-dance`, 'Casey dance', casey);
  return family;
}

function scriptedReply(text: string): AgentClient {
  return {
    messages: {
      create: vi.fn(async () => ({
        content: [{ type: 'text', text: JSON.stringify({ text }) }],
        usage: { input_tokens: 12, output_tokens: 8 },
        stop_reason: 'end_turn',
      })),
    },
  } as unknown as AgentClient;
}

async function ackFamily(name: string, chatId: string) {
  const family = await seedFamily(db.database, name);
  await db.database.insert(schema.channelMessages).values({
    familyId: family.familyId,
    parentUserId: family.parentUserId,
    channel: 'imessage',
    direction: 'in',
    category: 'reply',
    providerMessageId: `in-${chatId}`,
    providerChatId: chatId,
    status: 'delivered',
    inGroup: false,
  });
  return family;
}

function ackInput(
  family: { familyId: string; parentUserId: string },
  chatId: string,
  wireFetch: typeof fetch,
  overrides: Partial<Parameters<typeof acknowledgeDutyWrite>[0]> = {},
): Parameters<typeof acknowledgeDutyWrite>[0] {
  return {
    database: db.database,
    familyId: family.familyId,
    actorUserId: family.parentUserId,
    source: 'llm',
    now: DAY,
    timeZone: 'America/Toronto',
    inboundChatId: chatId,
    inboundMessageId: `in-${chatId}`,
    language: 'en',
    name: 'Sam',
    kid: 'Robin',
    event: 'swim',
    day: 'Saturday',
    time: '3:00pm',
    fetch: wireFetch,
    replyClient: scriptedReply('Sam has swim on Saturday at 3:00pm.'),
    clockMs: () => 0,
    ...overrides,
  };
}

function linqFetch(answers: number[]) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (url: string) => {
    calls.push(String(url));
    const status = answers.shift() ?? 201;
    return new Response(JSON.stringify({ message: { id: `out-${calls.length}` } }), { status });
  });
  return { fetch: fetchMock as unknown as typeof fetch, calls };
}

describe('a duty ask is sent only once Linq accepts it', () => {
  it('holds no accepted status while the send is still in the air', async () => {
    vi.stubEnv(COPARENT_DUTY_SENDS_ENABLED_ENV, 'true');
    const family = await seedFamily(db.database, 'In the air');
    let during: string | undefined;
    const send = vi.fn(async () => {
      during = (await outRows(family.familyId))[0]?.status;
      throw refused();
    });
    const delivered = await deliver(
      family,
      `air-${family.familyId}`,
      EVENING,
      ports(send, 'chat-air', pager().pager),
    );
    expect(during).toBe('failed');
    expect(delivered).toEqual({ status: 'not_sent', reason: 'http_500' });
  });

  it('marks an accepted send sent, with the provider id (positive control)', async () => {
    vi.stubEnv(COPARENT_DUTY_SENDS_ENABLED_ENV, 'true');
    const family = await seedFamily(db.database, 'Accepted');
    const send = vi.fn(async () => ({ providerMessageId: 'linq-accepted' }));
    const delivered = await deliver(
      family,
      `ok-${family.familyId}`,
      EVENING,
      ports(send, 'chat-ok'),
    );
    expect(delivered).toEqual({ status: 'sent', chatId: 'chat-ok' });
    const rows = await outRows(family.familyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'sent',
      errorCode: null,
      providerMessageId: 'linq-accepted',
    });
    expect(rows[0]?.sentAt?.toISOString()).toBe(EVENING.toISOString());
  });

  it('waits out the backoff, then retries a refusal under a new Linq key', async () => {
    vi.stubEnv(COPARENT_DUTY_SENDS_ENABLED_ENV, 'true');
    const family = await seedFamily(db.database, 'Retry');
    const key = `retry-${family.familyId}`;
    const send = vi
      .fn<DutySendPorts['send']>()
      .mockRejectedValueOnce(refused())
      .mockResolvedValueOnce({ providerMessageId: 'linq-second' });
    const sendPorts = ports(send, 'chat-retry', pager().pager);

    await deliver(family, key, EVENING, sendPorts);
    const early = await deliver(family, key, new Date(EVENING.getTime() + 60_000), sendPorts);
    expect(early).toEqual({ status: 'held', reason: 'send_retry_backoff' });
    expect(send).toHaveBeenCalledTimes(1);

    const retried = await deliver(family, key, later(1), sendPorts);
    expect(retried).toEqual({ status: 'sent', chatId: 'chat-retry' });
    expect(send.mock.calls.map((call) => call[0].sendKey)).toEqual([key, `${key}:retry:1`]);
    expect((await outRows(family.familyId)).map((row) => row.status)).toEqual(['failed', 'sent']);

    const again = await deliver(family, key, later(2), sendPorts);
    expect(again).toEqual({ status: 'skipped', reason: 'deduped' });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('keeps the Linq key after a timeout, so a text that did leave is not sent twice', async () => {
    vi.stubEnv(COPARENT_DUTY_SENDS_ENABLED_ENV, 'true');
    const family = await seedFamily(db.database, 'Timed out');
    const key = `timeout-${family.familyId}`;
    const send = vi
      .fn<DutySendPorts['send']>()
      .mockRejectedValueOnce(refused())
      .mockRejectedValueOnce(timedOut())
      .mockRejectedValueOnce(refused())
      .mockResolvedValueOnce({ providerMessageId: 'linq-original' });
    const sendPorts = ports(send, 'chat-timeout', pager().pager);

    for (const hours of [0, 1, 2, 3]) await deliver(family, key, later(hours), sendPorts);

    const unconfirmed = `${key}:retry:1`;
    expect(send.mock.calls.map((call) => call[0].sendKey)).toEqual([
      key,
      unconfirmed,
      unconfirmed,
      unconfirmed,
    ]);
    expect((await outRows(family.familyId)).at(-1)?.status).toBe('sent');
  });

  it('drops after the last try with a named reason, audits it and pages #ops once', async () => {
    vi.stubEnv(COPARENT_DUTY_SENDS_ENABLED_ENV, 'true');
    const family = await seedFamily(db.database, 'Exhausted');
    const key = `gone-${family.familyId}`;
    const send = vi.fn<DutySendPorts['send']>().mockRejectedValue(refused());
    const ops = pager();
    const sendPorts = ports(send, 'chat-gone', ops.pager);

    const results = [];
    for (const hours of [0, 1, 2, 3, 4]) {
      results.push(await deliver(family, key, later(hours), sendPorts));
    }
    expect(send).toHaveBeenCalledTimes(4);
    expect(results[3]).toEqual({ status: 'not_sent', reason: 'send_retries_exhausted' });
    expect(results[4]).toEqual({ status: 'skipped', reason: 'send_retries_exhausted' });
    expect(ops.pages).toEqual([
      { site: 'duty_unsent', facts: { surface: 'ask', reason: 'send_refused' }, count: 1 },
    ]);
    expect((await outRows(family.familyId)).every((row) => row.status === 'failed')).toBe(true);
    expect(await sendAudits(family.familyId, 'duty_send_failed')).toHaveLength(3);
    expect(await sendAudits(family.familyId, 'duty_send_dropped')).toEqual([
      {
        after: {
          surface: 'ask',
          failure: 'http_500',
          attempts: 4,
          reason: 'send_retries_exhausted',
        },
      },
    ]);
  });

  it('never re-sends a text Linq accepted when a receipt later fails it', async () => {
    vi.stubEnv(COPARENT_DUTY_SENDS_ENABLED_ENV, 'true');
    const family = await seedFamily(db.database, 'Undelivered');
    const key = `receipt-${family.familyId}`;
    const accept = vi.fn(async () => ({ providerMessageId: 'linq-took-it' }));
    await deliver(family, key, EVENING, ports(accept, 'chat-receipt'));
    await db.database
      .update(schema.channelMessages)
      .set({ status: 'failed', errorCode: 'undelivered' })
      .where(eq(schema.channelMessages.providerMessageId, 'linq-took-it'));

    const send = vi.fn<DutySendPorts['send']>();
    const result = await deliver(family, key, later(1), ports(send, 'chat-receipt'));

    expect(result).toEqual({ status: 'skipped', reason: 'deduped' });
    expect(send).not.toHaveBeenCalled();
  });

  it('leaves a running claim alone, and retries a crashed one under its Linq key', async () => {
    vi.stubEnv(COPARENT_DUTY_SENDS_ENABLED_ENV, 'true');
    const family = await seedFamily(db.database, 'Crashed');
    const key = `crash-${family.familyId}`;
    await db.database.insert(schema.channelMessages).values({
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      channel: 'imessage',
      direction: 'out',
      category: 'duty_ask',
      dedupeKey: key,
      status: 'failed',
      errorCode: 'send_in_flight',
      createdAt: EVENING,
    });
    const send = vi
      .fn<DutySendPorts['send']>()
      .mockResolvedValue({ providerMessageId: 'linq-after-crash' });
    const sendPorts = ports(send, 'chat-crash', pager().pager);

    const running = await deliver(family, key, new Date(EVENING.getTime() + 60_000), sendPorts);
    expect(running).toEqual({ status: 'skipped', reason: 'deduped' });
    expect(send).not.toHaveBeenCalled();

    const retried = await deliver(family, key, later(1), sendPorts);
    expect(retried).toEqual({ status: 'sent', chatId: 'chat-crash' });
    expect(send.mock.calls[0]?.[0].sendKey).toBe(key);
  });

  it('a retry through the sweep is a fresh model compose, and no compose sends nothing', async () => {
    vi.stubEnv(COPARENT_DUTY_SENDS_ENABLED_ENV, 'true');
    await nightBeforeFamily('sweep-retry');
    const send = vi
      .fn<DutySendPorts['send']>()
      .mockRejectedValueOnce(refused())
      .mockResolvedValueOnce({ providerMessageId: 'linq-swept' });
    const sendPorts = ports(send, 'chat-sweep-retry', pager().pager);
    const composeNight = vi
      .fn()
      .mockResolvedValueOnce('First model wording.')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('Second model wording.');
    const sweep = (now: Date) =>
      sweepDutyAsks(db.database, {
        now,
        ports: sendPorts,
        replyClient: scriptedReply('unused'),
        composeNight,
      });

    expect((await sweep(EVENING)).sent).toBe(0);
    expect((await sweep(later(1))).sent).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect((await sweep(later(2))).sent).toBe(1);
    expect(composeNight).toHaveBeenCalledTimes(3);
    expect(send.mock.calls.map((call) => call[0].text)).toEqual([
      'First model wording.',
      'Second model wording.',
    ]);
  });

  it('on 1:1s, retries only the parent Linq refused and opens the question once', async () => {
    vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
    vi.stubEnv(COPARENT_SPLIT_DUTY_ENABLED_ENV, 'true');
    const family = await splitFamilyOnOneToOnes('direct-retry');
    let refusals = 1;
    let accepted = 0;
    const sendDirect = vi.fn<NonNullable<DutySendPorts['sendDirect']>>(async (input) => {
      if (input.to === PHONE_TWO && refusals > 0) {
        refusals -= 1;
        throw refused();
      }
      accepted += 1;
      return { providerMessageId: `linq-direct-${accepted}` };
    });
    const sendPorts: DutySendPorts = {
      ...ports(
        vi.fn(async () => ({ providerMessageId: 'unused' })),
        'unused',
        pager().pager,
      ),
      target: async () => ({ channel: 'legacy' }),
      sendDirect,
    };
    const sweep = (now: Date) =>
      sweepDutyAsks(db.database, {
        now,
        ports: sendPorts,
        replyClient: scriptedReply('Who drives Robin to hockey and who drives Casey to dance?'),
      });

    await sweep(AFTERNOON);
    await sweep(later(1, AFTERNOON));
    await sweep(later(2, AFTERNOON));

    const toEach = sendDirect.mock.calls.map((call) => call[0].to);
    expect(toEach.filter((to) => to === PHONE_ONE)).toHaveLength(1);
    expect(toEach.filter((to) => to === PHONE_TWO)).toHaveLength(2);
    const view = await planFamilyDutyAsks(db.database, {
      familyId: family.familyId,
      now: later(2, AFTERNOON),
      bubbleLeaving: false,
    });
    if ('skipped' in view) throw new Error(`plan skipped: ${view.skipped}`);
    expect(view.open?.unanswered).toBe(1);
  });
});

describe('a duty ack is sent only once Linq accepts it', () => {
  it('leaves no sent row for a refused restatement, rewrites each retry, pages when spent', async () => {
    vi.stubEnv(COPARENT_DUTY_MEMORY_ENABLED_ENV, 'true');
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const family = await ackFamily('Ack refused', 'chat-ack-refused');
    const wire = linqFetch([500, 500, 500, 500]);
    const ops = pager();
    const client = scriptedReply('Sam has swim on Saturday at 3:00pm.');
    const ack = await acknowledgeDutyWrite(
      ackInput(family, 'chat-ack-refused', wire.fetch, { pager: ops.pager, replyClient: client }),
    );
    expect(ack).toEqual({
      status: 'skipped',
      reason: 'send_retries_exhausted',
      sent: false,
      text: null,
    });
    const rows = await outRows(family.familyId);
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.status === 'failed' && row.errorCode === 'http_500')).toBe(true);
    expect(vi.mocked(client.messages.create).mock.calls).toHaveLength(4);
    expect(ops.pages).toEqual([
      { site: 'duty_unsent', facts: { surface: 'ack', reason: 'send_refused' }, count: 1 },
    ]);
  });

  it('marks an accepted restatement sent (positive control)', async () => {
    vi.stubEnv(COPARENT_DUTY_MEMORY_ENABLED_ENV, 'true');
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const family = await ackFamily('Ack ok', 'chat-ack-ok');
    const wire = linqFetch([201]);
    const ops = pager();
    const ack = await acknowledgeDutyWrite(
      ackInput(family, 'chat-ack-ok', wire.fetch, { pager: ops.pager }),
    );
    expect(ack.status).toBe('restated');
    const rows = await outRows(family.familyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'sent', errorCode: null });
    expect(rows[0]?.sentAt?.toISOString()).toBe(DAY.toISOString());
    expect(ops.pages).toEqual([]);
  });

  it('marks a refused tapback failed, not sent, and a retried one sent', async () => {
    vi.stubEnv(COPARENT_DUTY_MEMORY_ENABLED_ENV, 'true');
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const family = await ackFamily('Tap refused', 'chat-tap-refused');
    const wire = linqFetch([500, 201]);
    const ops = pager();
    const ack = await acknowledgeDutyWrite(
      ackInput(family, 'chat-tap-refused', wire.fetch, { source: 'rules', pager: ops.pager }),
    );
    expect(ack).toEqual({ status: 'tapback', sent: false, text: null });
    expect((await outRows(family.familyId)).map((row) => row.status)).toEqual(['failed', 'sent']);
    expect(ops.pages).toEqual([]);
  });

  it('stops retrying once another send could outrun the webhook, and pages', async () => {
    vi.stubEnv(COPARENT_DUTY_MEMORY_ENABLED_ENV, 'true');
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const family = await ackFamily('Ack slow', 'chat-ack-slow');
    const wire = linqFetch([500, 201]);
    const ops = pager();
    let ms = 0;
    const clockMs = () => {
      ms += 3_000;
      return ms;
    };
    const ack = await acknowledgeDutyWrite(
      ackInput(family, 'chat-ack-slow', wire.fetch, { pager: ops.pager, clockMs }),
    );
    expect(ack).toMatchObject({ status: 'skipped', reason: 'send_retries_exhausted' });
    expect(wire.calls).toHaveLength(1);
    expect(ops.pages).toHaveLength(1);
  });
});

describe('with the duty flags off', () => {
  it('neither sweep nor ack sends, claims or pages anything', async () => {
    const family = await nightBeforeFamily('flags-off');
    const send = vi.fn<DutySendPorts['send']>();
    const ops = pager();
    const swept = await sweepDutyAsks(db.database, {
      now: EVENING,
      ports: ports(send, 'chat-flags-off', ops.pager),
    });
    const wire = linqFetch([]);
    const ack = await acknowledgeDutyWrite(
      ackInput(family, 'chat-flags-off', wire.fetch, { pager: ops.pager }),
    );

    expect(swept.enabled).toBe(false);
    expect(ack).toMatchObject({ status: 'skipped', reason: 'flag_off' });
    expect(send).not.toHaveBeenCalled();
    expect(wire.calls).toEqual([]);
    expect(await outRows(family.familyId)).toEqual([]);
    expect(ops.pages).toEqual([]);
  });
});
