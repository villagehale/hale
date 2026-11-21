import { randomUUID } from 'node:crypto';
import { schema } from '@hale/db';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyDeliveryStatus } from '~/lib/channel/delivery-status';
import { FakeTransport, type OutboundMessage } from '~/lib/channel/intake/transport';
import {
  GARBLED_TEXT,
  LinqSendError,
  createLinqPhoneTransport,
} from '~/lib/channel/linq/transport';
import type { ProactiveSendVerdict } from '~/lib/channel/outbound-gate';
import type { OpsPage } from '~/lib/monitoring/failure-page';
import { assembleFamilyExport } from '~/lib/rights/export';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import {
  DRIVER_RETRY_BUDGET_MS,
  type DriverNotifyPorts,
  notifyDrivers,
  retryTeamScheduleDrivers,
} from './driver';

/**
 * VIL-734 · a driver's schedule-change text is on the ledger as sent only once Linq took it,
 * a refused send is written again by the model and retried on the VIL-730 backoff
 * (5, 10, 20 minutes), and the last try pages #ops. Real rows and real DDL. The model and
 * Linq are the two ports stood in for; what the model writes is judged by the eval.
 */

const FLAG = 'TEAM_SCHEDULE_SEND_RECEIPT_ENABLED';
const NOW = new Date('2026-11-14T15:00:00.000Z');
const START = new Date('2026-11-15T18:00:00.000Z');
const NEW_START = new Date('2026-11-15T19:00:00.000Z');
const TZ = 'America/Toronto';
const MIN = 60_000;
const at = (minutes: number) => new Date(NOW.getTime() + minutes * MIN);

let db: TestDb;
let family: { familyId: string; parentUserId: string };

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  vi.stubEnv(FLAG, 'true');
  vi.stubEnv('TEAM_SCHEDULE_CHANGES_ENABLED', 'true');
  family = await seedFamily(db.database);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await db.exec('truncate table families, users, rate_limits cascade');
});

async function seedChange(
  over: { changeKind?: 'time' | 'cancel'; newLocation?: string | null } = {},
) {
  const changeKind = over.changeKind ?? 'time';
  const [event] = await db.database
    .insert(schema.familyEvents)
    .values({
      familyId: family.familyId,
      title: 'Team practice',
      startsAt: changeKind === 'cancel' ? START : NEW_START,
      endsAt: null,
      location: over.newLocation ?? 'Rink 1',
      source: 'email',
      dutyOwnerUserId: family.parentUserId,
      deletedAt: changeKind === 'cancel' ? NOW : null,
    })
    .returning({ id: schema.familyEvents.id });
  if (!event) throw new Error('no event');
  const [source] = await db.database
    .insert(schema.events)
    .values({
      familyId: family.familyId,
      source: 'channel_sms',
      eventType: 'channel_sms.calendar_intent',
      dedupHash: randomUUID(),
    })
    .returning({ id: schema.events.id });
  if (!source) throw new Error('no source event');
  const [action] = await db.database
    .insert(schema.actions)
    .values({
      familyId: family.familyId,
      eventId: source.id,
      actionType: changeKind === 'cancel' ? 'calendar_cancel' : 'calendar_move',
      payload: {},
      userVisibleState: 'drafted_for_approval',
      reviewerVerdict: 'approved',
    })
    .returning({ id: schema.actions.id });
  if (!action) throw new Error('no action');
  const [change] = await db.database
    .insert(schema.teamScheduleChanges)
    .values({
      familyId: family.familyId,
      actionId: action.id,
      familyEventId: event.id,
      gmailMessageId: 'gmail-1',
      changeKind,
      originalStartsAt: START,
      timeZone: TZ,
      newStartsAt: changeKind === 'cancel' ? null : NEW_START,
      newLocation: over.newLocation ?? null,
      effectsAppliedAt: NOW,
    })
    .returning({ id: schema.teamScheduleChanges.id });
  if (!change) throw new Error('no change');
  return { changeId: change.id, eventId: event.id };
}

type Step = 'accept' | LinqSendError;

class ScriptedTransport extends FakeTransport {
  tried = 0;
  constructor(
    private readonly script: Step[],
    private readonly atSend: () => Promise<void>,
  ) {
    super();
  }
  override async send(input: OutboundMessage) {
    this.tried += 1;
    await this.atSend();
    const step = this.script.shift() ?? 'accept';
    if (step !== 'accept') throw step;
    return super.send(input);
  }
}

function harness(
  over: {
    script?: Step[];
    atSend?: () => Promise<void>;
    write?: (draft: number) => string | null;
    gate?: () => ProactiveSendVerdict;
    phone?: string | null;
  } = {},
) {
  const pages: OpsPage[] = [];
  const threaded: string[] = [];
  const chatSends: Array<{ chatId: string; text: string }> = [];
  const compose = { calls: 0 };
  const transport = new ScriptedTransport(over.script ?? [], over.atSend ?? (async () => {}));
  const ports: DriverNotifyPorts = {
    composeDriver: async () => {
      compose.calls += 1;
      return over.write ? over.write(compose.calls) : `Pickup moved, draft ${compose.calls}`;
    },
    gate: async () => (over.gate ? over.gate() : { allowed: true, optOut: 'short' }),
    resolvePhone: async () => (over.phone === undefined ? '+15555550100' : over.phone),
    transport,
    sendChat: async (input) => {
      chatSends.push({ chatId: input.chatId, text: input.text });
      await over.atSend?.();
      const step = over.script?.shift() ?? 'accept';
      if (step !== 'accept') throw step;
      return { providerMessageId: `chat-out-${chatSends.length}` };
    },
    threadMessage: async (_database, input) => {
      threaded.push(input.body);
      return 'conv-1';
    },
    clock: () => NOW,
    pager: {
      page: async (page) => {
        pages.push(page);
        return 'paged';
      },
    },
  };
  return { ports, transport, compose, pages, threaded, chatSends };
}

function firstTry(
  changeId: string,
  ports: DriverNotifyPorts,
  now = NOW,
  drivers = [{ userId: family.parentUserId }],
) {
  return notifyDrivers(
    db.database,
    {
      changeId,
      familyId: family.familyId,
      drivers,
      change: 'time',
      kid: null,
      team: 'Team practice',
      wasAt: START,
      whenAt: NEW_START,
      place: 'Rink 1',
      now,
    },
    ports,
  );
}

function tick(ports: DriverNotifyPorts, now: Date) {
  return retryTeamScheduleDrivers(db.database, { now, portsFor: () => ports });
}

async function ledger() {
  const rows = await db.database
    .select({
      status: schema.channelMessages.status,
      errorCode: schema.channelMessages.errorCode,
      sentAt: schema.channelMessages.sentAt,
      providerMessageId: schema.channelMessages.providerMessageId,
      providerChatId: schema.channelMessages.providerChatId,
      channel: schema.channelMessages.channel,
      dedupeKey: schema.channelMessages.dedupeKey,
    })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, family.familyId),
        eq(schema.channelMessages.templateKey, 'team_schedule:driver'),
      ),
    );
  return rows.sort((a, b) => (a.dedupeKey ?? '').localeCompare(b.dedupeKey ?? ''));
}

async function driverAudit() {
  const rows = await db.database
    .select({ action: schema.auditLog.actionTaken, after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, family.familyId),
        inArray(schema.auditLog.actionTaken, [
          'team_schedule_driver_sent',
          'team_schedule_driver_send_failed',
          'team_schedule_driver_unsent',
          'team_schedule_driver_unreachable',
        ]),
      ),
    );
  return rows;
}

const legKey = (changeId: string, attempt: number) =>
  `team_schedule:driver:${changeId}:${family.parentUserId}:${attempt}`;
const refused = () => new LinqSendError('http_503', 503, false);

describe('the driver text, flag on', () => {
  it('claims nothing as sent while Linq has not answered, then records the accept', async () => {
    const { changeId } = await seedChange();
    const during: Awaited<ReturnType<typeof ledger>> = [];
    const h = harness({
      atSend: async () => {
        during.push(...(await ledger()));
      },
    });

    await firstTry(changeId, h.ports);

    expect(during).toHaveLength(1);
    expect(during[0]).toMatchObject({
      status: 'failed',
      errorCode: 'send_in_flight',
      sentAt: null,
      providerMessageId: null,
      dedupeKey: legKey(changeId, 1),
    });
    expect(await ledger()).toEqual([
      {
        status: 'queued',
        errorCode: null,
        sentAt: NOW,
        providerMessageId: 'fake-out-1',
        providerChatId: null,
        channel: 'sms',
        dedupeKey: legKey(changeId, 1),
      },
    ]);
    expect(h.threaded).toEqual(['Pickup moved, draft 1']);
    expect(await driverAudit()).toEqual([
      { action: 'team_schedule_driver_sent', after: { attempt: 1, channel: 'sms' } },
    ]);
    expect(h.pages).toEqual([]);
  });

  it('records an iMessage accept on the 1:1 chat', async () => {
    const { changeId } = await seedChange();
    await db.database.insert(schema.channelMessages).values({
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      channel: 'imessage',
      direction: 'in',
      category: 'reply',
      providerMessageId: `in-${randomUUID()}`,
      providerChatId: 'chat-driver',
      status: 'delivered',
      inGroup: false,
    });
    const h = harness();

    await firstTry(changeId, h.ports);

    expect(h.chatSends).toEqual([{ chatId: 'chat-driver', text: 'Pickup moved, draft 1' }]);
    expect(h.transport.tried).toBe(0);
    expect(await ledger()).toEqual([
      {
        status: 'sent',
        errorCode: null,
        sentAt: NOW,
        providerMessageId: 'chat-out-1',
        providerChatId: 'chat-driver',
        channel: 'imessage',
        dedupeKey: legKey(changeId, 1),
      },
    ]);
  });

  it('retries a refused send with a fresh compose once the backoff has passed', async () => {
    const { changeId } = await seedChange();
    const h = harness({ script: [refused(), 'accept'] });

    await firstTry(changeId, h.ports);

    expect(await ledger()).toMatchObject([
      { status: 'failed', errorCode: 'http_503', sentAt: null, providerMessageId: null },
    ]);
    expect(h.threaded).toEqual([]);

    await tick(h.ports, at(4));
    expect(h.transport.tried).toBe(1);
    expect(h.compose.calls).toBe(1);

    await tick(h.ports, at(5));
    expect(h.transport.tried).toBe(2);
    expect(h.compose.calls).toBe(2);
    expect(h.transport.bodies()).toEqual(['Pickup moved, draft 2']);
    expect(h.threaded).toEqual(['Pickup moved, draft 2']);
    expect(await ledger()).toMatchObject([
      { status: 'failed', errorCode: 'http_503', dedupeKey: legKey(changeId, 1) },
      { status: 'queued', errorCode: null, sentAt: at(5), dedupeKey: legKey(changeId, 2) },
    ]);
    expect(await driverAudit()).toEqual(
      expect.arrayContaining([
        {
          action: 'team_schedule_driver_send_failed',
          after: { attempt: 1, reason: 'http_503' },
        },
        { action: 'team_schedule_driver_sent', after: { attempt: 2, channel: 'sms' } },
      ]),
    );

    await tick(h.ports, at(60));
    expect(h.transport.tried).toBe(2);
    expect(h.pages).toEqual([]);
  });

  it('gives up after the fourth refusal, pages #ops once, and stops', async () => {
    const { changeId } = await seedChange();
    const h = harness({ script: [refused(), refused(), refused(), refused()] });

    await firstTry(changeId, h.ports);
    await tick(h.ports, at(5));
    expect(h.pages).toEqual([]);
    await tick(h.ports, at(15));
    expect(h.pages).toEqual([]);
    await tick(h.ports, at(35));

    expect(h.transport.tried).toBe(4);
    expect(h.compose.calls).toBe(4);
    expect(h.pages).toEqual([
      { site: 'team_schedule_driver_unsent', facts: { reason: 'send_refused' }, count: 1 },
    ]);
    const rows = await ledger();
    expect(rows.map((row) => row.errorCode)).toEqual([
      'http_503',
      'http_503',
      'http_503',
      'send_retries_exhausted',
    ]);
    expect(rows.every((row) => row.status === 'failed' && row.sentAt === null)).toBe(true);
    expect(await driverAudit()).toContainEqual({
      action: 'team_schedule_driver_unsent',
      after: { reason: 'http_503', attempts: 4 },
    });

    await tick(h.ports, at(120));
    expect(h.transport.tried).toBe(4);
    expect(h.pages).toHaveLength(1);
  });

  it('does not retry a refusal Linq calls permanent, and pages at once', async () => {
    const { changeId } = await seedChange();
    const h = harness({ script: [new LinqSendError('http_403', 403, true)] });

    await firstTry(changeId, h.ports);
    await tick(h.ports, at(5));

    expect(h.transport.tried).toBe(1);
    expect(h.compose.calls).toBe(1);
    expect(h.pages).toEqual([
      { site: 'team_schedule_driver_unsent', facts: { reason: 'send_refused' }, count: 1 },
    ]);
    expect(await ledger()).toMatchObject([
      { status: 'failed', errorCode: 'send_retries_exhausted', sentAt: null },
    ]);
    expect(await driverAudit()).toContainEqual({
      action: 'team_schedule_driver_unsent',
      after: { reason: 'http_403', attempts: 1 },
    });
  });

  it('never resends a timeout, which may have landed, and pages it as unconfirmed', async () => {
    const { changeId } = await seedChange();
    const h = harness({ script: [new LinqSendError('timeout', 0, false)] });

    await firstTry(changeId, h.ports);
    await tick(h.ports, at(5));
    await tick(h.ports, at(60));

    expect(h.transport.tried).toBe(1);
    expect(h.pages).toEqual([
      { site: 'team_schedule_driver_unsent', facts: { reason: 'send_unconfirmed' }, count: 1 },
    ]);
    expect(await ledger()).toMatchObject([
      { status: 'failed', errorCode: 'send_unconfirmed', sentAt: null },
    ]);
  });

  it('never resends a text Linq took but answered with an unreadable receipt', async () => {
    vi.stubEnv('LINQ_API_KEY', 'test-key-not-a-secret');
    vi.stubEnv('LINQ_FROM_E164', '+15555550199');
    const { changeId } = await seedChange();
    let linqCalls = 0;
    const tookItNoMessageId = (async () => {
      linqCalls += 1;
      return Response.json({ chat: { id: 'chat-new' } }, { status: 201 });
    }) as typeof fetch;
    const h = harness();
    const ports = { ...h.ports, transport: createLinqPhoneTransport({ fetch: tookItNoMessageId }) };

    await firstTry(changeId, ports);
    await tick(ports, at(5));
    await tick(ports, at(60));

    expect(linqCalls).toBe(1);
    expect(h.compose.calls).toBe(1);
    expect(await ledger()).toMatchObject([
      { status: 'failed', errorCode: 'send_unconfirmed', sentAt: null },
    ]);
    expect(h.pages).toEqual([
      { site: 'team_schedule_driver_unsent', facts: { reason: 'send_unconfirmed' }, count: 1 },
    ]);
  });

  it('positive control: a local missing-chat refusal before any send is still retried', async () => {
    const { changeId } = await seedChange();
    const h = harness({ script: [new LinqSendError('missing_chat_id', 400, false), 'accept'] });

    await firstTry(changeId, h.ports);
    await tick(h.ports, at(5));

    expect(h.transport.tried).toBe(2);
    expect(h.transport.bodies()).toEqual(['Pickup moved, draft 2']);
  });

  it('closes a send a dead run left unanswered, without sending it again', async () => {
    const { changeId } = await seedChange();
    await db.database.insert(schema.channelMessages).values({
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'plan_check_in',
      templateKey: 'team_schedule:driver',
      dedupeKey: legKey(changeId, 1),
      status: 'failed',
      errorCode: 'send_in_flight',
      createdAt: NOW,
    });
    const h = harness();

    await tick(h.ports, at(9));
    expect(h.pages).toEqual([]);
    expect((await ledger())[0]?.errorCode).toBe('send_in_flight');

    await tick(h.ports, at(10));
    await tick(h.ports, at(11));

    expect(h.compose.calls).toBe(0);
    expect(h.transport.tried).toBe(0);
    expect((await ledger())[0]?.errorCode).toBe('send_unconfirmed');
    expect(h.pages).toEqual([
      { site: 'team_schedule_driver_unsent', facts: { reason: 'send_unconfirmed' }, count: 1 },
    ]);
  });

  it('sends nothing when the model cannot write it, asks again, then pages', async () => {
    const { changeId } = await seedChange();
    const h = harness({ write: () => null });

    await firstTry(changeId, h.ports);
    await tick(h.ports, at(5));
    await tick(h.ports, at(15));
    await tick(h.ports, at(35));

    expect(h.compose.calls).toBe(4);
    expect(h.transport.tried).toBe(0);
    expect(h.threaded).toEqual([]);
    expect(h.pages).toEqual([
      { site: 'team_schedule_driver_unsent', facts: { reason: 'unwritten' }, count: 1 },
    ]);
    expect((await ledger()).every((row) => row.status === 'failed' && row.sentAt === null)).toBe(
      true,
    );
  });

  it('a text the model writes on the retry goes out', async () => {
    const { changeId } = await seedChange();
    const h = harness({ write: (draft) => (draft === 1 ? null : 'Pickup moved to two') });

    await firstTry(changeId, h.ports);
    expect(h.transport.tried).toBe(0);
    await tick(h.ports, at(5));

    expect(h.transport.bodies()).toEqual(['Pickup moved to two']);
    expect(h.pages).toEqual([]);
  });

  it('does not retry a change the calendar has since moved past, and pages nobody', async () => {
    const { changeId, eventId } = await seedChange();
    const h = harness({ script: [refused()] });
    await firstTry(changeId, h.ports);

    await db.database
      .update(schema.familyEvents)
      .set({ startsAt: new Date(NEW_START.getTime() + 60 * MIN) })
      .where(eq(schema.familyEvents.id, eventId));
    await tick(h.ports, at(5));
    await tick(h.ports, at(30));

    expect(h.compose.calls).toBe(1);
    expect(h.transport.tried).toBe(1);
    expect(h.pages).toEqual([]);
    expect(await driverAudit()).toContainEqual({
      action: 'team_schedule_driver_unsent',
      after: { reason: 'superseded', attempts: 1 },
    });
  });

  it('positive control: retries a cancel while the event stays cancelled', async () => {
    const { changeId } = await seedChange({ changeKind: 'cancel' });
    const h = harness({ script: [refused(), 'accept'] });
    await firstTry(changeId, h.ports);

    await tick(h.ports, at(5));

    expect(h.transport.tried).toBe(2);
    expect(h.transport.bodies()).toEqual(['Pickup moved, draft 2']);
  });

  it('stops once the event has started, and pages that nothing reached the driver', async () => {
    const { changeId } = await seedChange();
    const applied = new Date(NEW_START.getTime() - 3 * MIN);
    await db.database
      .update(schema.teamScheduleChanges)
      .set({ effectsAppliedAt: applied })
      .where(eq(schema.teamScheduleChanges.id, changeId));
    const h = harness({ script: [refused()] });
    await firstTry(changeId, h.ports, applied);

    const afterStart = new Date(applied.getTime() + 5 * MIN);
    await tick(h.ports, afterStart);
    await tick(h.ports, new Date(afterStart.getTime() + MIN));

    expect(h.compose.calls).toBe(1);
    expect(h.pages).toEqual([
      { site: 'team_schedule_driver_unsent', facts: { reason: 'event_started' }, count: 1 },
    ]);
  });

  it('does not send a retry whose event started while the model was writing it', async () => {
    const { changeId } = await seedChange();
    const h = harness({ script: [refused()] });
    await firstTry(changeId, h.ports);

    let written = false;
    const ports: DriverNotifyPorts = {
      ...h.ports,
      composeDriver: async (input) => {
        written = true;
        return h.ports.composeDriver(input);
      },
      clock: () => (written ? new Date(NEW_START.getTime() + MIN) : at(5)),
    };
    await tick(ports, at(5));

    expect(h.compose.calls).toBe(2);
    expect(h.transport.tried).toBe(1);
    expect(h.pages).toEqual([
      { site: 'team_schedule_driver_unsent', facts: { reason: 'event_started' }, count: 1 },
    ]);
    expect(await driverAudit()).toContainEqual({
      action: 'team_schedule_driver_unsent',
      after: { reason: 'event_started', attempts: 1 },
    });
  });

  it('waits out quiet hours with no model call, then sends the retry', async () => {
    const { changeId } = await seedChange();
    let quiet = false;
    const h = harness({
      script: [refused(), 'accept'],
      gate: () =>
        quiet ? { allowed: false, reason: 'quiet_hours' } : { allowed: true, optOut: 'short' },
    });
    await firstTry(changeId, h.ports);

    quiet = true;
    await tick(h.ports, at(5));
    await tick(h.ports, at(6));
    expect(h.compose.calls).toBe(1);
    expect(h.transport.tried).toBe(1);
    expect(h.pages).toEqual([]);

    quiet = false;
    await tick(h.ports, at(7));
    expect(h.compose.calls).toBe(2);
    expect(h.transport.bodies()).toEqual(['Pickup moved, draft 2']);
  });

  it('drops a retry for someone who has since stopped Hale, with no page', async () => {
    const { changeId } = await seedChange();
    let stopped = false;
    const h = harness({
      script: [refused()],
      gate: () =>
        stopped ? { allowed: false, reason: 'not_enrolled' } : { allowed: true, optOut: 'short' },
    });
    await firstTry(changeId, h.ports);

    stopped = true;
    await tick(h.ports, at(5));
    await tick(h.ports, at(30));

    expect(h.compose.calls).toBe(1);
    expect(h.transport.tried).toBe(1);
    expect(h.pages).toEqual([]);
    expect(await driverAudit()).toContainEqual({
      action: 'team_schedule_driver_unreachable',
      after: { reason: 'held:not_enrolled', attempts: 1 },
    });
  });

  it('stops a queued retry once the feature is switched off', async () => {
    const { changeId } = await seedChange();
    const h = harness({ script: [refused(), 'accept'] });
    await firstTry(changeId, h.ports);

    vi.stubEnv('TEAM_SCHEDULE_CHANGES_ENABLED', 'false');
    await tick(h.ports, at(5));

    expect(h.compose.calls).toBe(1);
    expect(h.transport.tried).toBe(1);
    expect(h.pages).toEqual([]);

    vi.stubEnv('TEAM_SCHEDULE_CHANGES_ENABLED', 'true');
    await tick(h.ports, at(6));
    expect(h.transport.bodies()).toEqual(['Pickup moved, draft 2']);
  });

  it('a first try the gate holds sends nothing and is not retried, as today', async () => {
    const { changeId } = await seedChange();
    const h = harness({ gate: () => ({ allowed: false, reason: 'quiet_hours' }) });

    await firstTry(changeId, h.ports);
    await tick(h.ports, at(5));

    expect(h.transport.tried).toBe(0);
    expect(h.compose.calls).toBe(1);
    expect(await ledger()).toEqual([]);
    expect(h.pages).toEqual([]);
  });

  it('records a driver with no number to reach, once, with no model call and no page', async () => {
    const { changeId } = await seedChange();
    const h = harness({ phone: null });

    await firstTry(changeId, h.ports);
    await tick(h.ports, at(5));

    expect(h.compose.calls).toBe(0);
    expect(h.transport.tried).toBe(0);
    expect(await ledger()).toMatchObject([
      { status: 'failed', errorCode: 'no_send_target', sentAt: null },
    ]);
    expect(await driverAudit()).toEqual([
      {
        action: 'team_schedule_driver_unreachable',
        after: { reason: 'no_send_target', attempts: 1 },
      },
    ]);
    const [row] = await db.database
      .select({
        audience: schema.auditLog.audience,
        targetTable: schema.auditLog.targetTable,
        targetId: schema.auditLog.targetId,
      })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, family.familyId));
    expect(row).toEqual({
      audience: family.parentUserId,
      targetTable: 'users',
      targetId: family.parentUserId,
    });
    expect(h.pages).toEqual([]);
  });

  it('a redelivered effects run does not text a driver who already has the text', async () => {
    const { changeId } = await seedChange();
    const h = harness();

    await firstTry(changeId, h.ports);
    await firstTry(changeId, h.ports);

    expect(h.transport.tried).toBe(1);
    expect(await ledger()).toHaveLength(1);
  });

  it('takes five retries a tick, so an outage cannot hold up the queues, and the rest next', async () => {
    const changes: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      changes.push((await seedChange()).changeId);
    }
    const h = harness({ script: changes.map(() => refused()) });
    for (const changeId of changes) await firstTry(changeId, h.ports);
    expect(h.transport.tried).toBe(6);

    expect(await tick(h.ports, at(5))).toMatchObject({ sent: 5, waiting: 1 });
    expect(h.compose.calls).toBe(11);

    expect(await tick(h.ports, at(6))).toMatchObject({ sent: 1, waiting: 0 });
    expect(h.transport.bodies()).toHaveLength(6);
    expect(h.pages).toEqual([]);
  });

  it('does not let quiet-hours holds use up the retries of a driver who can be texted', async () => {
    const changes: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      changes.push((await seedChange()).changeId);
    }
    let quietLeft = 0;
    const h = harness({
      script: changes.map(() => refused()),
      gate: () => {
        if (quietLeft === 0) return { allowed: true, optOut: 'short' };
        quietLeft -= 1;
        return { allowed: false, reason: 'quiet_hours' };
      },
    });
    for (const changeId of changes) await firstTry(changeId, h.ports);

    quietLeft = 5;
    expect(await tick(h.ports, at(5))).toMatchObject({ sent: 1, waiting: 5 });

    expect(h.compose.calls).toBe(7);
    expect(h.transport.bodies()).toHaveLength(1);
  });

  it('when the cap bites, the driver whose event starts soonest goes first', async () => {
    const seeded: Array<{ changeId: string; eventId: string }> = [];
    for (let index = 0; index < 6; index += 1) seeded.push(await seedChange());
    const soonest = seeded[5];
    if (!soonest) throw new Error('expected six changes');
    const earlier = new Date(NEW_START.getTime() - 60 * MIN);
    await db.database
      .update(schema.familyEvents)
      .set({ startsAt: earlier })
      .where(eq(schema.familyEvents.id, soonest.eventId));
    await db.database
      .update(schema.teamScheduleChanges)
      .set({ newStartsAt: earlier })
      .where(eq(schema.teamScheduleChanges.id, soonest.changeId));
    const h = harness({ script: seeded.map(() => refused()) });
    for (const { changeId } of seeded) await firstTry(changeId, h.ports);

    await tick(h.ports, at(5));

    const retried = (await ledger()).map((row) => row.dedupeKey);
    expect(retried).toContain(legKey(soonest.changeId, 2));
  });

  it('two overlapping ticks send one retry', async () => {
    const { changeId } = await seedChange();
    const h = harness({ script: [refused(), 'accept'] });
    await firstTry(changeId, h.ports);

    await Promise.all([tick(h.ports, at(5)), tick(h.ports, at(5))]);

    expect(h.transport.tried).toBe(2);
    expect(h.transport.bodies()).toHaveLength(1);
    expect((await ledger()).map((row) => row.dedupeKey)).toEqual([
      legKey(changeId, 1),
      legKey(changeId, 2),
    ]);
  });

  it.each([
    ['carrying a code', '3007'],
    ['with no code', null],
  ])('never resends a text Linq took after a failed receipt %s', async (_name, code) => {
    const { changeId } = await seedChange();
    const h = harness();

    await firstTry(changeId, h.ports);
    expect(
      await applyDeliveryStatus(db.database, {
        providerMessageId: 'fake-out-1',
        rawStatus: 'failed',
        errorCode: code,
      }),
    ).toBe('updated');
    await tick(h.ports, at(6));
    await tick(h.ports, at(60));

    expect(h.transport.tried).toBe(1);
    expect(h.compose.calls).toBe(1);
    expect(h.pages).toEqual([]);
    expect(await ledger()).toMatchObject([
      {
        status: 'failed',
        errorCode: code,
        providerMessageId: 'fake-out-1',
        dedupeKey: legKey(changeId, 1),
      },
    ]);
    expect(await driverAudit()).toEqual([
      { action: 'team_schedule_driver_sent', after: { attempt: 1, channel: 'sms' } },
    ]);
  });

  it('waits out an operator pause, then sends the retry once it lifts', async () => {
    const { changeId } = await seedChange();
    let paused = false;
    const h = harness({
      script: [refused(), 'accept'],
      gate: () =>
        paused ? { allowed: false, reason: 'sends_paused' } : { allowed: true, optOut: 'short' },
    });
    await firstTry(changeId, h.ports);

    paused = true;
    expect(await tick(h.ports, at(5))).toMatchObject({ waiting: 1, closed: 0 });
    await tick(h.ports, at(6));
    expect(h.compose.calls).toBe(1);
    expect(h.transport.tried).toBe(1);

    paused = false;
    await tick(h.ports, at(30));

    expect(h.compose.calls).toBe(2);
    expect(h.transport.bodies()).toEqual(['Pickup moved, draft 2']);
    expect(h.pages).toEqual([]);
    expect(await ledger()).toMatchObject([
      { status: 'failed', errorCode: 'http_503', dedupeKey: legKey(changeId, 1) },
      { status: 'queued', errorCode: null, dedupeKey: legKey(changeId, 2) },
    ]);
  });

  it('closes and pages a retry a long pause kept held, before it leaves the sweep', async () => {
    const { changeId } = await seedChange();
    let paused = false;
    const h = harness({
      script: [refused()],
      gate: () =>
        paused ? { allowed: false, reason: 'sends_paused' } : { allowed: true, optOut: 'short' },
    });
    await firstTry(changeId, h.ports);

    paused = true;
    await tick(h.ports, at(22 * 60));
    expect(h.pages).toEqual([]);
    expect((await ledger())[0]?.errorCode).toBe('http_503');

    await tick(h.ports, at(23 * 60));
    await tick(h.ports, at(23 * 60 + 1));

    expect(h.compose.calls).toBe(1);
    expect(h.transport.tried).toBe(1);
    expect(h.pages).toEqual([
      { site: 'team_schedule_driver_unsent', facts: { reason: 'held_too_long' }, count: 1 },
    ]);
    expect(await ledger()).toMatchObject([
      { status: 'failed', errorCode: 'send_retries_exhausted' },
    ]);
    expect(await driverAudit()).toContainEqual({
      action: 'team_schedule_driver_unsent',
      after: { reason: 'held:sends_paused', attempts: 1 },
    });
  });

  it('asks the model again after a garbled draft, and sends the clean one', async () => {
    const { changeId } = await seedChange();
    const h = harness({ script: [new LinqSendError(GARBLED_TEXT, 0, true), 'accept'] });

    await firstTry(changeId, h.ports);
    expect(h.pages).toEqual([]);
    await tick(h.ports, at(5));

    expect(h.compose.calls).toBe(2);
    expect(h.transport.bodies()).toEqual(['Pickup moved, draft 2']);
    expect(h.pages).toEqual([]);
  });

  it('pages a draft garbled on every try as unwritten', async () => {
    const { changeId } = await seedChange();
    const garbled = () => new LinqSendError(GARBLED_TEXT, 0, true);
    const h = harness({ script: [garbled(), garbled(), garbled(), garbled()] });

    await firstTry(changeId, h.ports);
    await tick(h.ports, at(5));
    await tick(h.ports, at(15));
    await tick(h.ports, at(35));

    expect(h.compose.calls).toBe(4);
    expect(h.transport.bodies()).toEqual([]);
    expect(h.pages).toEqual([
      { site: 'team_schedule_driver_unsent', facts: { reason: 'unwritten' }, count: 1 },
    ]);
  });

  it('closes a leg whose driver came off the event, with no text and no page', async () => {
    const { changeId, eventId } = await seedChange();
    const h = harness({ script: [refused()] });
    await firstTry(changeId, h.ports);

    await db.database
      .update(schema.familyEvents)
      .set({ dutyOwnerUserId: null })
      .where(eq(schema.familyEvents.id, eventId));
    await tick(h.ports, at(5));
    await tick(h.ports, at(30));

    expect(h.compose.calls).toBe(1);
    expect(h.transport.tried).toBe(1);
    expect(h.pages).toEqual([]);
    expect(await ledger()).toMatchObject([
      { status: 'failed', errorCode: 'send_retries_exhausted' },
    ]);
    expect(await driverAudit()).toContainEqual({
      action: 'team_schedule_driver_unsent',
      after: { reason: 'superseded', attempts: 1 },
    });
  });

  it('closes the leg of a carpool driver seated only in the group once replaced', async () => {
    const { changeId } = await seedChange();
    const [other] = await db.database
      .insert(schema.users)
      .values({ email: `${randomUUID()}@example.test`, name: 'Other Driver' })
      .returning({ id: schema.users.id });
    if (!other) throw new Error('no user');
    await db.database.insert(schema.linqGroupMembers).values({
      familyId: family.familyId,
      chatId: 'chat-team',
      userId: other.id,
      phoneE164Encrypted: 'not-read-here',
      phoneE164Hash: `hash-${other.id}`,
      role: 'other_family',
    });
    const [carpool] = await db.database
      .insert(schema.linqGroupCarpools)
      .values({
        chatId: 'chat-team',
        familyId: family.familyId,
        planKey: `team:${changeId}`,
        pickupAt: START,
        driverUserId: other.id,
        status: 'assigned',
      })
      .returning({ id: schema.linqGroupCarpools.id });
    if (!carpool) throw new Error('no carpool');
    const h = harness({ script: [refused()] });
    await firstTry(changeId, h.ports, NOW, [{ userId: other.id }]);

    await db.database
      .update(schema.linqGroupCarpools)
      .set({ driverUserId: null, status: 'open' })
      .where(eq(schema.linqGroupCarpools.id, carpool.id));
    await tick(h.ports, at(5));

    expect(h.compose.calls).toBe(1);
    expect(h.pages).toEqual([]);
    expect(await ledger()).toMatchObject([
      { status: 'failed', errorCode: 'send_retries_exhausted' },
    ]);
  });

  it.each(['true', 'false'])(
    "keeps a retry closed by the driver's own stop off the other parent (audience read %s)",
    async (lit) => {
      vi.stubEnv('AUDIT_LOG_AUDIENCE_ENABLED', lit);
      const { changeId } = await seedChange();
      const [second] = await db.database
        .insert(schema.users)
        .values({ email: `${randomUUID()}@example.test`, name: 'Second Parent' })
        .returning({ id: schema.users.id });
      if (!second) throw new Error('no user');
      await db.database
        .insert(schema.familyMembers)
        .values({ familyId: family.familyId, userId: second.id, role: 'co_parent' });
      let stopped = false;
      const h = harness({
        script: [refused()],
        gate: () =>
          stopped ? { allowed: false, reason: 'not_enrolled' } : { allowed: true, optOut: 'short' },
      });
      await firstTry(changeId, h.ports);
      stopped = true;
      await tick(h.ports, at(5));

      const trailFor = async (actorUserId: string) =>
        (
          await assembleFamilyExport(db.database, family.familyId, { actorUserId, now: at(6) })
        ).trail.map((row) => row.summary);

      const others = await trailFor(second.id);
      expect(others).toContain(
        'Hale could not reach the driver about a schedule change and will try again',
      );
      expect(others).not.toContain('Hale could not reach the driver about a schedule change');
      expect(others).not.toContain('Hale did not text you about a schedule change');
      expect(await trailFor(family.parentUserId)).toContain(
        'Hale did not text you about a schedule change',
      );
    },
  );

  it('starts no further retry once the tick has spent its time budget', async () => {
    const changes = [(await seedChange()).changeId, (await seedChange()).changeId];
    const h = harness({ script: changes.map(() => refused()) });
    for (const changeId of changes) await firstTry(changeId, h.ports);

    let clockNow = at(5);
    const ports: DriverNotifyPorts = {
      ...h.ports,
      clock: () => clockNow,
      composeDriver: async (input) => {
        clockNow = new Date(at(5).getTime() + DRIVER_RETRY_BUDGET_MS);
        return h.ports.composeDriver(input);
      },
    };

    expect(await tick(ports, at(5))).toMatchObject({ sent: 1, waiting: 1 });
    expect(h.compose.calls).toBe(3);

    expect(await tick(h.ports, at(6))).toMatchObject({ sent: 1, waiting: 0 });
    expect(h.transport.bodies()).toHaveLength(2);
  });
});

describe('the driver text, flag off', () => {
  beforeEach(() => {
    vi.stubEnv(FLAG, 'true\n');
  });

  it('keeps today path: no per-attempt key, a refusal is not retried, nobody is paged', async () => {
    const { changeId } = await seedChange();
    const h = harness({ script: [refused()] });

    await firstTry(changeId, h.ports);
    expect(await tick(h.ports, at(5))).toEqual({ skipped: 'flag_off' });

    expect(h.transport.tried).toBe(1);
    expect(h.compose.calls).toBe(1);
    expect(h.pages).toEqual([]);
    expect(await ledger()).toMatchObject([
      { status: 'failed', errorCode: 'http_503', dedupeKey: null, sentAt: NOW },
    ]);
    expect(await driverAudit()).toEqual([]);
  });
});
