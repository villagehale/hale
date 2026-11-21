import type { AgentClient } from '@hale/agent';
import { schema } from '@hale/db';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LinqSendError } from '~/lib/channel/linq/transport';
import { PROACTIVE_CADENCE_ENV } from '~/lib/channel/proactive/flag';
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
  type DutyDirectTarget,
  type DutySendPorts,
  deliverDutyDirectLines,
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
import { settleStrandedDutySends } from './send-receipt';

const KEY = Buffer.alloc(32, 7).toString('base64');
const PHONE_ONE = '+15555550101';
const PHONE_TWO = '+15555550102';
const PHONE_THREE = '+15555550103';
const PHONE_FOUR = '+15555550104';
const PHONE_FIVE = '+15555550105';
const PHONE_SIX = '+15555550106';
const PHONE_SEVEN = '+15555550107';
const PHONE_EIGHT = '+15555550108';
const PHONE_NINE = '+15555550109';
const PHONE_TEN = '+15555550110';
const PHONE_ELEVEN = '+15555550111';
const PHONE_TWELVE = '+15555550112';
const PHONE_THIRTEEN = '+15555550113';
const PHONE_FOURTEEN = '+15555550114';
const PHONE_FIFTEEN = '+15555550115';
const PHONE_SIXTEEN = '+15555550116';
const PHONE_SEVENTEEN = '+15555550117';
const PHONE_EIGHTEEN = '+15555550118';
const PHONE_NINETEEN = '+15555550119';
const PHONE_TWENTY = '+15555550120';

let db: TestDb;

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

// With the decider live an ask waits in its queue and never reaches this send path.
beforeEach(() => {
  vi.stubEnv(PROACTIVE_CADENCE_ENV, 'off');
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
const refused = () => new LinqSendError('http_400', 400, true);
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
      parentUserId: schema.channelMessages.parentUserId,
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
    .select({ audience: schema.auditLog.audience, after: schema.auditLog.after })
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
  start: Date = MONDAY,
) {
  await db.database.insert(schema.parentCalendarBlocks).values({
    integrationId,
    eventId,
    familyId: family.familyId,
    userId: family.parentUserId,
    startAt: start,
    endAt: new Date(start.getTime() + HOUR_MS),
    kidRelated: true,
    title,
    calendarStanding: 'organizer',
    childId: childId ?? null,
    status: 'confirmed',
    updatedStamp: '1',
  });
}

async function nightBeforeFamily(name: string, start: Date = MONDAY, at: Date = EVENING) {
  const family = await twoParents(name);
  await db.database
    .update(schema.families)
    .set({ linqGroupChatId: `chat-${name}` })
    .where(eq(schema.families.id, family.familyId));
  await seedChild(db.database, family.familyId, 'Robin', 36, undefined, at);
  const integrationId = await seedIntegration(
    db.database,
    family.familyId,
    family.parentUserId,
    'gcal',
  );
  await kidBlock(family, integrationId, `evt-${name}`, 'Robin swim', undefined, start);
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
    now: at,
    childId: null,
    question: false,
    askWhichKid: false,
  });
  return family;
}

/** Two overlapping kids, no family group: the split ask goes to each parent on a 1:1. */
async function splitFamilyOnOneToOnes(
  name: string,
  phones: readonly [string, string] = [PHONE_ONE, PHONE_TWO],
) {
  const family = await twoParents(name);
  for (const [userId, phone] of [
    [family.parentUserId, phones[0]],
    [family.secondUserId, phones[1]],
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

function scriptedReply(text: string, duringCompose?: () => void): AgentClient {
  return {
    messages: {
      create: vi.fn(async () => {
        duringCompose?.();
        return {
          content: [{ type: 'text', text: JSON.stringify({ text }) }],
          usage: { input_tokens: 12, output_tokens: 8 },
          stop_reason: 'end_turn',
        };
      }),
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
    expect(delivered).toEqual({ status: 'not_sent', reason: 'http_400' });
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

  it('waits out the backoff, then retries under the same Linq key, so nothing lands twice', async () => {
    vi.stubEnv(COPARENT_DUTY_SENDS_ENABLED_ENV, 'true');
    const family = await seedFamily(db.database, 'Retry');
    const key = `retry-${family.familyId}`;
    const send = vi
      .fn<DutySendPorts['send']>()
      .mockRejectedValueOnce(timedOut())
      .mockResolvedValueOnce({ providerMessageId: 'linq-second' });
    const sendPorts = ports(send, 'chat-retry', pager().pager);

    await deliver(family, key, EVENING, sendPorts);
    const early = await deliver(family, key, new Date(EVENING.getTime() + 60_000), sendPorts);
    expect(early).toEqual({ status: 'held', reason: 'send_retry_backoff' });
    expect(send).toHaveBeenCalledTimes(1);

    const retried = await deliver(family, key, later(1), sendPorts);
    expect(retried).toEqual({ status: 'sent', chatId: 'chat-retry' });
    expect(send.mock.calls.map((call) => call[0].sendKey)).toEqual([key, key]);
    expect((await outRows(family.familyId)).map((row) => row.status)).toEqual(['failed', 'sent']);

    const again = await deliver(family, key, later(2), sendPorts);
    expect(again).toEqual({ status: 'skipped', reason: 'deduped' });
    expect(send).toHaveBeenCalledTimes(2);
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
    expect(new Set(send.mock.calls.map((call) => call[0].sendKey))).toEqual(new Set([key]));
    expect(results[3]).toEqual({ status: 'not_sent', reason: 'send_retries_exhausted' });
    expect(results[4]).toEqual({ status: 'skipped', reason: 'send_retries_exhausted' });
    expect(ops.pages).toEqual([
      { site: 'duty_unsent', facts: { surface: 'ask', reason: 'send_refused' }, count: 1 },
    ]);
    const rows = await outRows(family.familyId);
    expect(rows.every((row) => row.status === 'failed')).toBe(true);
    expect(rows.at(-1)?.errorCode).toBe('send_retries_exhausted');
    expect(await sendAudits(family.familyId, 'duty_send_failed')).toHaveLength(3);
    expect(await sendAudits(family.familyId, 'duty_send_dropped')).toEqual([
      {
        audience: null,
        after: {
          surface: 'ask',
          failure: 'send_refused',
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
});

describe('a split ask on 1:1s', () => {
  const openAt = async (familyId: string, now: Date) => {
    const view = await planFamilyDutyAsks(db.database, { familyId, now, bubbleLeaving: false });
    if ('skipped' in view) throw new Error(`plan skipped: ${view.skipped}`);
    return view.open;
  };

  it('opens the question at the first acceptance, then retries only the refused parent', async () => {
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
    const client = scriptedReply('Who drives Robin to hockey and who drives Casey to dance?');
    const sweep = (now: Date) =>
      sweepDutyAsks(db.database, { now, ports: sendPorts, replyClient: client });
    const compose = vi.mocked(client.messages.create);

    await sweep(AFTERNOON);
    expect(await openAt(family.familyId, AFTERNOON)).toMatchObject({
      split: true,
      unanswered: 1,
      silentNamed: false,
    });

    await sweep(later(1, AFTERNOON));
    const retryPrompt = JSON.stringify(compose.mock.calls.at(-1));
    expect(retryPrompt).toContain('Robin hockey');
    expect(retryPrompt).not.toContain('1 unanswered');
    await sweep(later(2, AFTERNOON));

    expect(compose).toHaveBeenCalledTimes(2);
    const toEach = sendDirect.mock.calls.map((call) => call[0]);
    expect(toEach.filter((call) => call.to === PHONE_ONE)).toHaveLength(1);
    const second = toEach.filter((call) => call.to === PHONE_TWO);
    expect(second).toHaveLength(2);
    expect(second[1]?.sendKey).toBe(second[0]?.sendKey);
    expect(await openAt(family.familyId, later(2, AFTERNOON))).toMatchObject({
      unanswered: 1,
      silentNamed: false,
    });
    expect(await sendAudits(family.familyId, 'duty_send_failed')).toEqual([
      {
        audience: family.secondUserId,
        after: { surface: 'ask', failure: 'send_refused', attempts: 1 },
      },
    ]);
  });

  it("reads each parent's gate: no text to a parent on hold, no compose, nothing re-noted", async () => {
    vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
    vi.stubEnv(COPARENT_SPLIT_DUTY_ENABLED_ENV, 'true');
    const family = await splitFamilyOnOneToOnes('direct-held', [PHONE_THREE, PHONE_FOUR]);
    const plan = await planFamilyDutyAsks(db.database, {
      familyId: family.familyId,
      now: AFTERNOON,
      bubbleLeaving: false,
    });
    if ('skipped' in plan) throw new Error(`plan skipped: ${plan.skipped}`);
    const heldUser = plan.render.parentIds[1];
    const heldPhone = heldUser === family.parentUserId ? PHONE_THREE : PHONE_FOUR;
    const otherPhone = heldPhone === PHONE_THREE ? PHONE_FOUR : PHONE_THREE;
    let onHold = false;
    let refusals = 1;
    let accepted = 0;
    const sendDirect = vi.fn<NonNullable<DutySendPorts['sendDirect']>>(async (input) => {
      if (input.to === heldPhone && refusals > 0) {
        refusals -= 1;
        throw refused();
      }
      accepted += 1;
      return { providerMessageId: `linq-held-${accepted}` };
    });
    const gate: DutySendPorts['gate'] = async (request) =>
      onHold && request.parentUserId === heldUser
        ? { allowed: false, reason: 'opt_out_unread' }
        : { allowed: true, optOut: 'short' };
    const sendPorts: DutySendPorts = {
      ...ports(
        vi.fn(async () => ({ providerMessageId: 'unused' })),
        'unused',
        pager().pager,
      ),
      target: async () => ({ channel: 'legacy' }),
      gate,
      sendDirect,
    };
    const client = scriptedReply('Who drives Robin to hockey and who drives Casey to dance?');
    const sweep = (now: Date) =>
      sweepDutyAsks(db.database, { now, ports: sendPorts, replyClient: client });

    await sweep(AFTERNOON);
    onHold = true;
    await sweep(later(1, AFTERNOON));
    await sweep(later(2, AFTERNOON));

    const toEach = sendDirect.mock.calls.map((call) => call[0].to);
    expect(toEach.filter((to) => to === otherPhone)).toHaveLength(1);
    expect(toEach.filter((to) => to === heldPhone)).toHaveLength(1);
    expect(vi.mocked(client.messages.create)).toHaveBeenCalledTimes(1);
    expect(await openAt(family.familyId, later(2, AFTERNOON))).toMatchObject({
      unanswered: 1,
      silentNamed: false,
    });
  });
});

const onHold = { allowed: false, reason: 'opt_out_unread' } as const;
const allowed = { allowed: true, optOut: 'short' } as const;
const SPLIT_TEXT = 'Who drives Robin to hockey and who drives Casey to dance?';

function directPorts(
  sendDirect: NonNullable<DutySendPorts['sendDirect']>,
  gate: DutySendPorts['gate'],
): DutySendPorts {
  return {
    ...ports(
      vi.fn(async () => ({ providerMessageId: 'unused' })),
      'unused',
      pager().pager,
    ),
    target: async () => ({ channel: 'legacy' }),
    gate,
    sendDirect,
  };
}

function accepting() {
  let accepted = 0;
  return vi.fn<NonNullable<DutySendPorts['sendDirect']>>(async () => {
    accepted += 1;
    return { providerMessageId: `linq-gated-${accepted}` };
  });
}

describe('each parent is gated at the moment of sending', () => {
  it('a parent held during the compose is not texted, and the other still is', async () => {
    vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
    vi.stubEnv(COPARENT_SPLIT_DUTY_ENABLED_ENV, 'true');
    const family = await splitFamilyOnOneToOnes('gate-compose', [PHONE_FIVE, PHONE_SIX]);
    let held = false;
    const sendDirect = accepting();
    const client = scriptedReply(SPLIT_TEXT, () => {
      held = true;
    });

    await sweepDutyAsks(db.database, {
      now: AFTERNOON,
      ports: directPorts(sendDirect, async (request) =>
        held && request.parentUserId === family.secondUserId ? onHold : allowed,
      ),
      replyClient: client,
    });

    expect(vi.mocked(client.messages.create)).toHaveBeenCalledTimes(1);
    expect(sendDirect.mock.calls.map((call) => call[0].to)).toEqual([PHONE_FIVE]);
    const rows = await outRows(family.familyId);
    expect(rows.filter((row) => row.parentUserId === family.secondUserId)).toEqual([]);
    expect(
      rows.filter((row) => row.parentUserId === family.parentUserId).map((row) => row.status),
    ).toEqual(['sent']);
  });

  it('a parent held during a retry compose is not texted again', async () => {
    vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
    vi.stubEnv(COPARENT_SPLIT_DUTY_ENABLED_ENV, 'true');
    const family = await splitFamilyOnOneToOnes('gate-retry', [PHONE_SEVEN, PHONE_EIGHT]);
    let held = false;
    let refusals = 1;
    const sendDirect = vi.fn<NonNullable<DutySendPorts['sendDirect']>>(async (input) => {
      if (input.to === PHONE_EIGHT && refusals > 0) {
        refusals -= 1;
        throw refused();
      }
      return { providerMessageId: 'linq-gated-retry' };
    });
    const sendPorts = directPorts(sendDirect, async (request) =>
      held && request.parentUserId === family.secondUserId ? onHold : allowed,
    );

    await sweepDutyAsks(db.database, {
      now: AFTERNOON,
      ports: sendPorts,
      replyClient: scriptedReply(SPLIT_TEXT),
    });
    await sweepDutyAsks(db.database, {
      now: later(1, AFTERNOON),
      ports: sendPorts,
      replyClient: scriptedReply(SPLIT_TEXT, () => {
        held = true;
      }),
    });

    expect(sendDirect.mock.calls.filter((call) => call[0].to === PHONE_EIGHT)).toHaveLength(1);
    const second = (await outRows(family.familyId)).filter(
      (row) => row.parentUserId === family.secondUserId,
    );
    expect(second.map((row) => row.status)).toEqual(['failed']);
  });

  it('names the hold in the delivery, and a gate that stays allowed still sends', async () => {
    const family = await twoParents('gate-named');
    const sendDirect = accepting();
    const target = (parentUserId: string, phone: string, leg: string): DutyDirectTarget => ({
      parentUserId,
      phone,
      sendKey: `gate-named:${family.familyId}:${leg}`,
      dedupeKey: `gate-named:${family.familyId}:${leg}`,
      attempt: 1,
    });
    const deliverTo = (targets: DutyDirectTarget[], gate: DutySendPorts['gate']) =>
      deliverDutyDirectLines(
        db.database,
        {
          familyId: family.familyId,
          targets,
          text: SPLIT_TEXT,
          now: AFTERNOON,
          templateKey: 'linq:group_duty_night_before',
        },
        directPorts(sendDirect, gate),
      );

    const partly = await deliverTo(
      [target(family.parentUserId, PHONE_NINE, 'a'), target(family.secondUserId, PHONE_TEN, 'b')],
      async (request) => (request.parentUserId === family.secondUserId ? onHold : allowed),
    );
    expect(partly).toEqual({ status: 'sent', chatId: PHONE_NINE, held: 'opt_out_unread' });

    const none = await deliverTo([target(family.secondUserId, PHONE_TEN, 'c')], async () => ({
      allowed: false,
      reason: 'quiet_hours',
    }));
    expect(none).toEqual({ status: 'held', reason: 'quiet_hours' });

    const both = await deliverTo(
      [target(family.parentUserId, PHONE_NINE, 'd'), target(family.secondUserId, PHONE_TEN, 'e')],
      async () => allowed,
    );
    expect(both).toEqual({ status: 'sent', chatId: PHONE_TEN });
    expect(sendDirect.mock.calls.map((call) => call[0].to)).toEqual([
      PHONE_NINE,
      PHONE_NINE,
      PHONE_TEN,
    ]);
  });

  it('the group path reads its gate after the compose too', async () => {
    vi.stubEnv(COPARENT_DUTY_SENDS_ENABLED_ENV, 'true');
    vi.stubEnv(COPARENT_SPLIT_DUTY_ENABLED_ENV, 'false');
    const family = await nightBeforeFamily('gate-group');
    let held = false;
    const send = vi.fn<DutySendPorts['send']>();
    const swept = await sweepDutyAsks(db.database, {
      now: EVENING,
      ports: {
        ...ports(send, 'chat-gate-group', pager().pager),
        gate: async () => (held ? onHold : allowed),
      },
      replyClient: scriptedReply('unused'),
      composeNight: async () => {
        held = true;
        return 'Model wording.';
      },
    });

    expect(held).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(await outRows(family.familyId)).toEqual([]);
    expect(swept.held).toBeGreaterThanOrEqual(1);
  });
});

describe('one ask across sweeps', () => {
  const openAt = async (familyId: string, now: Date) => {
    const view = await planFamilyDutyAsks(db.database, { familyId, now, bubbleLeaving: false });
    if ('skipped' in view) throw new Error(`plan skipped: ${view.skipped}`);
    return view.open;
  };
  const onlyFamily =
    (familyId: string): DutySendPorts['gate'] =>
    async (request) =>
      request.familyId === familyId ? allowed : onHold;

  it('never reaches the group after the 1:1 door carried the ask', async () => {
    vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
    vi.stubEnv(COPARENT_SPLIT_DUTY_ENABLED_ENV, 'true');
    const family = await splitFamilyOnOneToOnes('door-group-first', [PHONE_ELEVEN, PHONE_TWELVE]);
    let door: 'group' | 'legacy' = 'group';
    const send = vi.fn<DutySendPorts['send']>().mockRejectedValue(refused());
    const sendDirect = accepting();
    const sendPorts: DutySendPorts = {
      ...directPorts(sendDirect, onlyFamily(family.familyId)),
      send,
      target: async () =>
        door === 'group'
          ? { channel: 'group', chatId: 'chat-door', familyId: family.familyId }
          : { channel: 'legacy' },
    };
    const sweep = (now: Date) =>
      sweepDutyAsks(db.database, {
        now,
        ports: sendPorts,
        replyClient: scriptedReply(SPLIT_TEXT),
      });

    await sweep(AFTERNOON);
    door = 'legacy';
    await sweep(later(1, AFTERNOON));
    door = 'group';
    await sweep(later(2, AFTERNOON));

    expect(send).toHaveBeenCalledTimes(1);
    expect(sendDirect.mock.calls.map((call) => call[0].to).sort()).toEqual([
      PHONE_ELEVEN,
      PHONE_TWELVE,
    ]);
  });

  it('never reaches a parent on a 1:1 after the group carried the ask', async () => {
    vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
    vi.stubEnv(COPARENT_SPLIT_DUTY_ENABLED_ENV, 'true');
    const family = await splitFamilyOnOneToOnes('door-group-ok', [PHONE_THIRTEEN, PHONE_FOURTEEN]);
    let door: 'group' | 'legacy' = 'group';
    const send = vi
      .fn<DutySendPorts['send']>()
      .mockResolvedValue({ providerMessageId: 'linq-door-group' });
    const sendDirect = accepting();
    const sendPorts: DutySendPorts = {
      ...directPorts(sendDirect, onlyFamily(family.familyId)),
      send,
      target: async () =>
        door === 'group'
          ? { channel: 'group', chatId: 'chat-door-ok', familyId: family.familyId }
          : { channel: 'legacy' },
    };
    const sweep = (now: Date) =>
      sweepDutyAsks(db.database, {
        now,
        ports: sendPorts,
        replyClient: scriptedReply(SPLIT_TEXT),
      });

    await sweep(AFTERNOON);
    door = 'legacy';
    await sweep(later(1, AFTERNOON));

    expect(send).toHaveBeenCalledTimes(1);
    expect(sendDirect).not.toHaveBeenCalled();
  });

  it('a group send that may have landed keeps the 1:1 door shut', async () => {
    vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
    vi.stubEnv(COPARENT_SPLIT_DUTY_ENABLED_ENV, 'true');
    const family = await splitFamilyOnOneToOnes('door-unsure-group', [
      PHONE_SEVENTEEN,
      PHONE_EIGHTEEN,
    ]);
    let door: 'group' | 'legacy' = 'group';
    const send = vi
      .fn<DutySendPorts['send']>()
      .mockRejectedValueOnce(new LinqSendError('http_502', 502, false))
      .mockResolvedValueOnce({ providerMessageId: 'linq-door-original' });
    const sendDirect = accepting();
    const sendPorts: DutySendPorts = {
      ...directPorts(sendDirect, onlyFamily(family.familyId)),
      send,
      target: async () =>
        door === 'group'
          ? { channel: 'group', chatId: 'chat-door-unsure', familyId: family.familyId }
          : { channel: 'legacy' },
    };
    const sweep = (now: Date) =>
      sweepDutyAsks(db.database, {
        now,
        ports: sendPorts,
        replyClient: scriptedReply(SPLIT_TEXT),
      });

    await sweep(AFTERNOON);
    door = 'legacy';
    await sweep(later(1, AFTERNOON));
    expect(sendDirect).not.toHaveBeenCalled();

    door = 'group';
    await sweep(later(2, AFTERNOON));
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0].sendKey).toBe(send.mock.calls[0]?.[0].sendKey);
  });

  it('a 1:1 leg that may have landed keeps the group door shut', async () => {
    vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
    vi.stubEnv(COPARENT_SPLIT_DUTY_ENABLED_ENV, 'true');
    const family = await splitFamilyOnOneToOnes('door-unsure-leg', [PHONE_NINETEEN, PHONE_TWENTY]);
    let door: 'group' | 'legacy' = 'legacy';
    const send = vi.fn<DutySendPorts['send']>();
    let timeouts = 2;
    const sendDirect = vi.fn<NonNullable<DutySendPorts['sendDirect']>>(async (input) => {
      if (timeouts > 0) {
        timeouts -= 1;
        throw timedOut();
      }
      return { providerMessageId: `linq-leg-${input.sendKey}` };
    });
    const sendPorts: DutySendPorts = {
      ...directPorts(sendDirect, onlyFamily(family.familyId)),
      send,
      target: async () =>
        door === 'group'
          ? { channel: 'group', chatId: 'chat-door-leg', familyId: family.familyId }
          : { channel: 'legacy' },
    };
    const sweep = (now: Date) =>
      sweepDutyAsks(db.database, {
        now,
        ports: sendPorts,
        replyClient: scriptedReply(SPLIT_TEXT),
      });

    await sweep(AFTERNOON);
    door = 'group';
    await sweep(later(1, AFTERNOON));
    expect(send).not.toHaveBeenCalled();

    door = 'legacy';
    await sweep(later(2, AFTERNOON));
    const keysFor = (phone: string) =>
      sendDirect.mock.calls.filter((call) => call[0].to === phone).map((call) => call[0].sendKey);
    for (const phone of [PHONE_NINETEEN, PHONE_TWENTY]) {
      const keys = keysFor(phone);
      expect(keys).toHaveLength(2);
      expect(keys[1]).toBe(keys[0]);
    }
  });

  it('a hold while the plan still offers the ask does not end it', async () => {
    vi.stubEnv(COPARENT_DUTY_SENDS_ENABLED_ENV, 'true');
    vi.stubEnv(COPARENT_SPLIT_DUTY_ENABLED_ENV, 'false');
    const family = await nightBeforeFamily('hold-offered');
    /** Sunday 27 Sep 2026, 17:10 in Toronto: the first sweep of the night-before window. */
    const FIRST_TRY = new Date('2026-09-27T21:10:00.000Z');
    let paused = false;
    const send = vi
      .fn<DutySendPorts['send']>()
      .mockRejectedValueOnce(refused())
      .mockResolvedValueOnce({ providerMessageId: 'linq-after-hold' });
    const ops = pager();
    const sendPorts: DutySendPorts = {
      ...ports(send, 'chat-hold-offered', ops.pager),
      gate: async (request) =>
        request.familyId === family.familyId && !paused
          ? allowed
          : { allowed: false, reason: 'sends_paused' },
    };
    const sweep = (now: Date) =>
      sweepDutyAsks(db.database, {
        now,
        ports: sendPorts,
        replyClient: scriptedReply('unused'),
        composeNight: async () => 'Model wording.',
      });

    await sweep(FIRST_TRY);
    paused = true;
    await sweep(later(1, FIRST_TRY));
    await sweep(later(2, FIRST_TRY));
    paused = false;
    await sweep(later(3, FIRST_TRY));

    expect(send).toHaveBeenCalledTimes(2);
    expect((await outRows(family.familyId)).map((row) => row.status)).toEqual(['failed', 'sent']);
    expect(ops.pages).toEqual([]);
    expect(await sendAudits(family.familyId, 'duty_send_dropped')).toEqual([]);
  });

  it('counts a parent reached earlier even when their channel is revoked since', async () => {
    vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
    vi.stubEnv(COPARENT_SPLIT_DUTY_ENABLED_ENV, 'true');
    const family = await splitFamilyOnOneToOnes('door-revoked', [PHONE_FIFTEEN, PHONE_SIXTEEN]);
    let refusals = 1;
    const sendDirect = vi.fn<NonNullable<DutySendPorts['sendDirect']>>(async (input) => {
      if (input.to === PHONE_SIXTEEN && refusals > 0) {
        refusals -= 1;
        throw refused();
      }
      return { providerMessageId: `linq-revoked-${input.sendKey}` };
    });
    const sendPorts = directPorts(sendDirect, onlyFamily(family.familyId));
    const client = scriptedReply(SPLIT_TEXT);
    const sweep = (now: Date) =>
      sweepDutyAsks(db.database, { now, ports: sendPorts, replyClient: client });

    await sweep(AFTERNOON);
    await db.database
      .update(schema.parentChannels)
      .set({ revokedAt: AFTERNOON })
      .where(eq(schema.parentChannels.userId, family.parentUserId));
    await sweep(later(1, AFTERNOON));

    expect(sendDirect.mock.calls.filter((call) => call[0].to === PHONE_SIXTEEN)).toHaveLength(2);
    expect(JSON.stringify(vi.mocked(client.messages.create).mock.calls.at(-1))).not.toContain(
      '1 unanswered',
    );
    expect(await openAt(family.familyId, later(1, AFTERNOON))).toMatchObject({ unanswered: 1 });
  });
});

describe('a duty send nothing will offer again', () => {
  /** Monday 5 Oct 2026, 20:17 in Toronto: the last sweep before quiet hours. */
  const REFUSED_AT = new Date('2026-10-06T00:17:00.000Z');
  /** Past the sweep's lookback over every row the tests above wrote. */
  const CRASHED_AT = new Date('2026-10-12T16:17:00.000Z');

  async function failedRow(
    family: { familyId: string; parentUserId: string },
    row: { dedupeKey: string; errorCode: string; createdAt: Date; category?: 'duty_ask' | 'reply' },
  ) {
    await db.database.insert(schema.channelMessages).values({
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      channel: 'imessage',
      direction: 'out',
      category: row.category ?? 'duty_ask',
      dedupeKey: row.dedupeKey,
      providerChatId: 'chat-stranded',
      status: 'failed',
      errorCode: row.errorCode,
      createdAt: row.createdAt,
    });
  }

  it('drops a refused ask the plan stopped offering, and pages once', async () => {
    vi.stubEnv(COPARENT_DUTY_SENDS_ENABLED_ENV, 'true');
    const family = await seedFamily(db.database, 'Stranded');
    const dedupeKey = `duty_ask:night_before:evt-stranded-${family.familyId}:pickup:2026-10-05`;
    await failedRow(family, { dedupeKey, errorCode: 'http_500', createdAt: REFUSED_AT });
    const ops = pager();
    const sweep = (now: Date) =>
      sweepDutyAsks(db.database, {
        now,
        ports: ports(vi.fn<DutySendPorts['send']>(), 'chat-stranded', ops.pager),
      });

    await sweep(later(1, REFUSED_AT));
    expect(ops.pages).toEqual([]);

    await sweep(later(2, REFUSED_AT));
    await sweep(later(3, REFUSED_AT));

    expect(ops.pages).toEqual([
      { site: 'duty_unsent', facts: { surface: 'ask', reason: 'send_refused' }, count: 1 },
    ]);
    expect((await outRows(family.familyId))[0]?.errorCode).toBe('send_retries_exhausted');
    expect(await sendAudits(family.familyId, 'duty_send_dropped')).toEqual([
      {
        audience: null,
        after: {
          surface: 'ask',
          failure: 'send_refused',
          attempts: 1,
          reason: 'send_retries_exhausted',
        },
      },
    ]);
  });

  it("one family's accepted group send does not hide another family's 1:1 leg", async () => {
    const familyA = await seedFamily(db.database, 'Scope group');
    const familyB = await seedFamily(db.database, 'Scope leg');
    const at = new Date('2026-10-19T16:17:00.000Z');
    const key = `duty_ask:night_before:evt-shared-${familyA.familyId}:pickup:2026-10-19`;
    await db.database.insert(schema.channelMessages).values({
      familyId: familyA.familyId,
      parentUserId: familyA.parentUserId,
      channel: 'imessage',
      direction: 'out',
      category: 'duty_ask',
      dedupeKey: key,
      providerMessageId: 'linq-scope-group',
      status: 'sent',
      createdAt: at,
    });
    await failedRow(familyB, {
      dedupeKey: `${key}:${familyB.parentUserId}`,
      errorCode: 'http_500',
      createdAt: at,
    });
    const ops = pager();

    await settleStrandedDutySends(db.database, {
      now: later(2, at),
      pager: ops.pager,
      offered: new Set(),
    });

    expect(ops.pages).toEqual([
      { site: 'duty_unsent', facts: { surface: 'ask', reason: 'send_refused' }, count: 1 },
    ]);
    expect(await sendAudits(familyB.familyId, 'duty_send_dropped')).toHaveLength(1);
    expect(await sendAudits(familyA.familyId, 'duty_send_dropped')).toEqual([]);
  });

  it("one family's accepted 1:1 leg does not hide another family's group send", async () => {
    const familyA = await seedFamily(db.database, 'Scope leg ok');
    const familyB = await seedFamily(db.database, 'Scope group failed');
    const at = new Date('2026-10-22T16:17:00.000Z');
    const key = `duty_ask:night_before:evt-shared-${familyB.familyId}:pickup:2026-10-22`;
    await db.database.insert(schema.channelMessages).values({
      familyId: familyA.familyId,
      parentUserId: familyA.parentUserId,
      channel: 'imessage',
      direction: 'out',
      category: 'duty_ask',
      dedupeKey: `${key}:${familyA.parentUserId}`,
      providerMessageId: 'linq-scope-leg',
      status: 'sent',
      createdAt: at,
    });
    await failedRow(familyB, { dedupeKey: key, errorCode: 'http_500', createdAt: at });
    const ops = pager();

    await settleStrandedDutySends(db.database, {
      now: later(2, at),
      pager: ops.pager,
      offered: new Set(),
    });

    expect(ops.pages).toEqual([
      { site: 'duty_unsent', facts: { surface: 'ask', reason: 'send_refused' }, count: 1 },
    ]);
    expect(await sendAudits(familyB.familyId, 'duty_send_dropped')).toHaveLength(1);
  });

  it('within one family, a send the other door carried is still skipped', async () => {
    const family = await seedFamily(db.database, 'Scope same family');
    const at = new Date('2026-10-29T16:17:00.000Z');
    const key = `duty_ask:night_before:evt-same-${family.familyId}:pickup:2026-10-29`;
    await failedRow(family, { dedupeKey: key, errorCode: 'http_500', createdAt: at });
    await db.database.insert(schema.channelMessages).values({
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      channel: 'imessage',
      direction: 'out',
      category: 'duty_ask',
      dedupeKey: `${key}:${family.parentUserId}`,
      providerMessageId: 'linq-scope-same',
      status: 'sent',
      createdAt: later(1, at),
    });
    const ops = pager();

    await settleStrandedDutySends(db.database, {
      now: later(3, at),
      pager: ops.pager,
      offered: new Set(),
    });

    expect(ops.pages).toEqual([]);
    expect(await sendAudits(family.familyId, 'duty_send_dropped')).toEqual([]);
  });

  it("another family's plan does not count as offering this family's send", async () => {
    vi.stubEnv(COPARENT_DUTY_SENDS_ENABLED_ENV, 'true');
    vi.stubEnv(COPARENT_SPLIT_DUTY_ENABLED_ENV, 'false');
    /** Sunday 25 Oct 2026, 18:00 in Toronto. */
    const SUNDAY = new Date('2026-10-25T22:00:00.000Z');
    const familyA = await nightBeforeFamily(
      'scope-offered',
      new Date('2026-10-26T19:00:00.000Z'),
      SUNDAY,
    );
    const familyB = await seedFamily(db.database, 'Scope offered other');
    const key = 'duty_ask:night_before:evt-scope-offered:pickup:2026-10-25';
    await failedRow(familyB, {
      dedupeKey: `${key}:${familyB.parentUserId}`,
      errorCode: 'http_500',
      createdAt: later(-2, SUNDAY),
    });
    const ops = pager();
    const gate = vi.fn<DutySendPorts['gate']>(async () => onHold);

    await sweepDutyAsks(db.database, {
      now: SUNDAY,
      ports: { ...ports(vi.fn<DutySendPorts['send']>(), 'chat-scope', ops.pager), gate },
      replyClient: scriptedReply('unused'),
      composeNight: async () => 'Model wording.',
    });

    expect(gate).toHaveBeenCalledWith(
      expect.objectContaining({ familyId: familyA.familyId }),
      expect.anything(),
    );
    expect(await outRows(familyA.familyId)).toEqual([]);
    expect(ops.pages).toEqual([
      { site: 'duty_unsent', facts: { surface: 'ask', reason: 'send_refused' }, count: 1 },
    ]);
    expect(await sendAudits(familyB.familyId, 'duty_send_dropped')).toHaveLength(1);
  });

  it('pages a crash on the last try and a crashed ack, with only the duty memory flag on', async () => {
    vi.stubEnv(COPARENT_DUTY_SENDS_ENABLED_ENV, 'false');
    vi.stubEnv(COPARENT_SPLIT_DUTY_ENABLED_ENV, 'false');
    vi.stubEnv(COPARENT_DUTY_MEMORY_ENABLED_ENV, 'true');
    const family = await seedFamily(db.database, 'Crashed last');
    const base = `duty_ask:night_before:evt-crash-${family.familyId}:pickup:2026-10-12`;
    await failedRow(family, {
      dedupeKey: base,
      errorCode: 'http_500',
      createdAt: new Date(CRASHED_AT.getTime() - 3 * HOUR_MS),
    });
    await failedRow(family, {
      dedupeKey: `${base}:retry:1`,
      errorCode: 'http_500',
      createdAt: new Date(CRASHED_AT.getTime() - 2 * HOUR_MS),
    });
    await failedRow(family, {
      dedupeKey: `${base}:retry:2`,
      errorCode: 'http_500',
      createdAt: new Date(CRASHED_AT.getTime() - HOUR_MS),
    });
    await failedRow(family, {
      dedupeKey: `${base}:retry:3`,
      errorCode: 'send_in_flight',
      createdAt: CRASHED_AT,
    });
    await failedRow(family, {
      dedupeKey: `linq:duty_ack:${family.familyId}:in-crashed`,
      errorCode: 'send_in_flight',
      createdAt: CRASHED_AT,
      category: 'reply',
    });
    const ops = pager();

    await sweepDutyAsks(db.database, {
      now: later(2, CRASHED_AT),
      ports: ports(vi.fn<DutySendPorts['send']>(), 'chat-stranded', ops.pager),
    });

    expect(ops.pages).toEqual([
      { site: 'duty_unsent', facts: { surface: 'ask', reason: 'not_confirmed' }, count: 2 },
    ]);
    expect(await sendAudits(family.familyId, 'duty_send_dropped')).toHaveLength(2);
  });
});

describe('a duty ack is sent only once Linq accepts it', () => {
  it('leaves no sent row for a refused restatement, gives it one try, and pages', async () => {
    vi.stubEnv(COPARENT_DUTY_MEMORY_ENABLED_ENV, 'true');
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const family = await ackFamily('Ack refused', 'chat-ack-refused');
    const wire = linqFetch([400]);
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
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'failed', errorCode: 'send_retries_exhausted' });
    expect(vi.mocked(client.messages.create)).toHaveBeenCalledTimes(1);
    expect(wire.calls).toHaveLength(1);
    expect(await sendAudits(family.familyId, 'duty_send_dropped')).toEqual([
      {
        audience: family.parentUserId,
        after: {
          surface: 'ack',
          failure: 'send_refused',
          attempts: 1,
          reason: 'send_retries_exhausted',
        },
      },
    ]);
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

  it('stops retrying a tapback once another send could outrun the webhook, and pages', async () => {
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
      ackInput(family, 'chat-ack-slow', wire.fetch, {
        source: 'rules',
        pager: ops.pager,
        clockMs,
      }),
    );
    expect(ack).toMatchObject({ status: 'skipped', reason: 'send_retries_exhausted' });
    expect(wire.calls).toHaveLength(1);
    expect(ops.pages).toHaveLength(1);
  });
});

describe('with the duty flags off', () => {
  it('neither sweep nor ack sends, claims or pages anything', async () => {
    vi.stubEnv(COPARENT_DUTY_SENDS_ENABLED_ENV, 'false');
    vi.stubEnv(COPARENT_DUTY_MEMORY_ENABLED_ENV, 'false');
    vi.stubEnv(COPARENT_SPLIT_DUTY_ENABLED_ENV, 'false');
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
