import type { AgentClient } from '@hale/agent';
import { schema } from '@hale/db';
import { channelSendJobPayloadSchema } from '@hale/tools-contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import type { ReminderRunDeps } from '~/lib/loop/reminders/run';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';

/**
 * VIL-466 · the reminder cron, fired for one fake family on Preview, lands in
 * preview_captured_sends through the SHIPPED dispatch and SMS adapter, and nothing
 * reaches a real transport (fetch is a tripwire). Plus the gates: off in prod, off
 * without the secret, off for a real number or a family with any real number.
 */

let t: TestDb;
vi.mock('~/lib/db', () => ({ db: () => t.database }));

const { handlePreviewReminderTrigger } = await import('./preview-reminder-trigger');
const { handlePreviewFakeInbound, handlePreviewCapturedRead } = await import(
  './preview-fake-inbound'
);
const { defaultReminderRunDeps } = await import('~/lib/loop/reminders/run');
const { dispatchLoopMessage } = await import('~/lib/channel/dispatch');
const { buildDispatchPorts } = await import('~/lib/channel/wiring');
const { productionChannels } = await import('~/lib/channel/adapters/production');
const { loopTemplateRenderer } = await import('~/lib/loop/templates/registry');

const KEY = Buffer.alloc(32, 9).toString('base64');
const SECRET = 'preview-reminder-test-secret';
const ON = {
  VERCEL_ENV: 'preview',
  PREVIEW_CAPTURE_TRANSPORT: 'on',
  PREVIEW_FAKE_INBOUND_SECRET: SECRET,
};
const FAKE = '+14375550142';
const FAKE_COPARENT = '+14375550143';
const REAL = '+14165550142';
// Noon in Toronto, outside quiet hours.
const NOW = new Date('2026-07-25T16:00:00Z');

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  t = await createTestDb();
}, 120_000);
afterAll(async () => {
  await t.close();
});
beforeEach(() => {
  process.env.APP_ENCRYPTION_KEY = KEY;
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await t.exec('truncate table families, users, preview_captured_sends cascade');
});

let n = 0;
async function seedParent(familyId: string, phone: string, role: 'primary_parent' | 'co_parent') {
  n += 1;
  const [user] = await t.database
    .insert(schema.users)
    .values({ externalAuthId: `sms:preview-${n}`, name: 'Parent', timezone: 'America/Toronto' })
    .returning({ id: schema.users.id });
  const userId = user?.id as string;
  await t.database.insert(schema.familyMembers).values({ familyId, userId, role });
  await t.database.insert(schema.parentChannels).values({
    userId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    verifiedAt: new Date('2026-07-01T00:00:00Z'),
  });
  return userId;
}

async function seedFakeFamily(coparentPhone?: string) {
  const [family] = await t.database
    .insert(schema.families)
    .values({ displayName: 'Preview family', provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;
  const parentUserId = await seedParent(familyId, FAKE, 'primary_parent');
  if (coparentPhone) await seedParent(familyId, coparentPhone, 'co_parent');
  // Starts in 50 minutes, so its T-1h reminder is due now.
  await t.database.insert(schema.familyEvents).values({
    familyId,
    title: 'Swim class',
    startsAt: new Date(NOW.getTime() + 50 * 60_000),
    source: 'placement',
  });
  return { familyId, parentUserId };
}

function post(path: string, body: unknown, secret: string | null = SECRET): Request {
  return new Request(`https://preview.example${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret ? { authorization: `Bearer ${secret}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

/** Stands in for the model: the text is whatever the composer hands back. */
const MODEL_TEXT = 'test double: model-written reminder';

function captureRunDeps() {
  return () => ({
    ...defaultReminderRunDeps(),
    client: {} as AgentClient,
    composeText: async () => ({ texts: [MODEL_TEXT], bold: null }),
    capture: (async () => undefined) as unknown as ReminderRunDeps['capture'],
    // The queue hop, in-process: the same parse and dispatch the drain runs.
    enqueue: async (job: unknown) => {
      const message = channelSendJobPayloadSchema.parse(job);
      await dispatchLoopMessage(
        message,
        buildDispatchPorts(t.database, {
          channels: productionChannels(t.database),
          renderer: loopTemplateRenderer,
          now: () => NOW,
        }),
      );
    },
  });
}

function armCaptureEnv() {
  for (const [k, v] of Object.entries(ON)) vi.stubEnv(k, v);
  vi.stubEnv('LINQ_API_KEY', '');
  vi.stubEnv('LINQ_FROM_E164', '');
  vi.stubEnv('LINQ_WEBHOOK_SECRET', '');
  vi.stubEnv('LOOP_SEND_ENABLED', 'true');
  const tripwire = vi.fn(async () => {
    throw new Error('a real transport was reached');
  });
  vi.stubGlobal('fetch', tripwire);
  vi.spyOn(console, 'info').mockImplementation(() => {});
  return tripwire;
}

describe('every Preview route is a plain empty 404 outside Preview', () => {
  it.each([
    ['production', 'production'],
    ['local', undefined],
  ])('%s: inbound, captured and reminders give no reason', async (_label, vercelEnv) => {
    const env = { ...ON, VERCEL_ENV: vercelEnv };
    const responses = [
      await handlePreviewFakeInbound(post('/api/channels/preview/inbound', { from: FAKE }), {
        database: t.database,
        intake: () => {
          throw new Error('unreached');
        },
        enqueue: async () => {},
        log: { info: () => {}, warn: () => {}, error: () => {} },
        countOutcome: async () => {},
        env,
      }),
      await handlePreviewCapturedRead(
        new Request(`https://x/api/channels/preview/captured?to=${encodeURIComponent(FAKE)}`, {
          headers: { authorization: `Bearer ${SECRET}` },
        }),
        { database: t.database, env },
      ),
      await handlePreviewReminderTrigger(post('/api/channels/preview/reminders', { phone: FAKE }), {
        database: t.database,
        env,
      }),
    ];
    for (const res of responses) {
      expect(res.status).toBe(404);
      expect(await res.text()).toBe('');
      expect(res.headers.get('content-type')).toBeNull();
    }
  });

  it('is an empty 404 with no reason code, even on Preview', async () => {
    const res = await handlePreviewReminderTrigger(
      post('/api/channels/preview/reminders', { phone: FAKE }),
      { database: t.database, env: { ...ON, PREVIEW_CAPTURE_TRANSPORT: 'off' } },
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('');
  });
});

describe('preview reminder trigger gates', () => {
  it('rejects a wrong or missing bearer, and runs nothing', async () => {
    const runCron = vi.fn();
    for (const secret of ['wrong', null]) {
      const res = await handlePreviewReminderTrigger(
        post('/api/channels/preview/reminders', { phone: FAKE }, secret),
        { database: t.database, env: ON, runCron },
      );
      expect(res.status).toBe(403);
    }
    expect(runCron).not.toHaveBeenCalled();
  });

  it('is off when its secret is unset', async () => {
    const res = await handlePreviewReminderTrigger(
      post('/api/channels/preview/reminders', { phone: FAKE }),
      { database: t.database, env: { ...ON, PREVIEW_FAKE_INBOUND_SECRET: '' } },
    );
    expect(res.status).toBe(404);
  });

  it('refuses a real number', async () => {
    const runCron = vi.fn();
    const res = await handlePreviewReminderTrigger(
      post('/api/channels/preview/reminders', { phone: REAL }),
      { database: t.database, env: ON, runCron },
    );
    expect(res.status).toBe(400);
    expect(runCron).not.toHaveBeenCalled();
  });

  it('refuses a fake number whose family also holds a real number', async () => {
    await seedFakeFamily(REAL);
    const runCron = vi.fn();
    const res = await handlePreviewReminderTrigger(
      post('/api/channels/preview/reminders', { phone: FAKE }),
      { database: t.database, env: ON, runCron },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'family_not_fictional' });
    expect(runCron).not.toHaveBeenCalled();
  });
});

describe('a reminder fired by cron for a fake family is captured, never sent', () => {
  it('lands in preview_captured_sends and no real transport is reached', async () => {
    const tripwire = armCaptureEnv();
    const { familyId } = await seedFakeFamily(FAKE_COPARENT);
    // A second, untouched family: the trigger is scoped to one.
    const [other] = await t.database
      .insert(schema.families)
      .values({ displayName: 'Other', provinceOrState: 'ON' })
      .returning({ id: schema.families.id });
    await seedParent(other?.id as string, '+14375550199', 'primary_parent');
    await t.database.insert(schema.familyEvents).values({
      familyId: other?.id as string,
      title: 'Other swim',
      startsAt: new Date(NOW.getTime() + 50 * 60_000),
      source: 'placement',
    });

    const res = await handlePreviewReminderTrigger(
      post('/api/channels/preview/reminders', { phone: FAKE }),
      { database: t.database, env: ON, reminderDeps: captureRunDeps(), now: () => NOW },
    );
    expect(res.status).toBe(200);
    // Both offsets are past for an event 50 minutes out, for each of the two parents.
    const summary = (await res.json()) as { ok: boolean; fired: number; sendEnabled: boolean };
    expect(summary).toMatchObject({ ok: true, sendEnabled: true });
    expect(summary.fired).toBeGreaterThanOrEqual(2);

    const rows = await t.database.select().from(schema.previewCapturedSends);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect([...new Set(rows.map((r) => r.toE164))].sort()).toEqual([FAKE, FAKE_COPARENT]);
    expect(rows.every((r) => r.body === MODEL_TEXT)).toBe(true);
    expect(tripwire).not.toHaveBeenCalled();

    const reminders = await t.database.select().from(schema.eventReminders);
    expect(reminders.every((r) => r.familyId === familyId)).toBe(true);
  });

  it('VIL-474: capture on sends in-process — no pg-boss enqueue, no drain kick, decorations kept', async () => {
    const tripwire = armCaptureEnv();
    await seedFakeFamily(FAKE_COPARENT);
    const base = captureRunDeps();
    const inProcess = base().enqueue;
    const queued = vi.fn(async () => {
      throw new Error('pg-boss reached on Preview capture');
    });
    const afterRun = vi.fn();
    const dispatchInProcess = vi.fn(inProcess);
    const res = await handlePreviewReminderTrigger(
      post('/api/channels/preview/reminders', { phone: FAKE }),
      {
        database: t.database,
        env: ON,
        reminderDeps: () => ({ ...base(), enqueue: queued }),
        dispatchInProcess,
        afterRun,
        now: () => NOW,
      },
    );
    expect(res.status).toBe(200);
    const summary = (await res.json()) as { fired: number; dispatch: string };
    expect(summary.dispatch).toBe('in_process');
    expect(summary.fired).toBeGreaterThanOrEqual(2);
    expect(queued).not.toHaveBeenCalled();
    expect(afterRun).not.toHaveBeenCalled();
    expect(dispatchInProcess).toHaveBeenCalledTimes(summary.fired);
    const rows = await t.database.select().from(schema.previewCapturedSends);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((r) => 'decorations' in r)).toBe(true);
    expect(tripwire).not.toHaveBeenCalled();
  });

  it('VIL-474: without an in-process dispatcher it still enqueues and kicks the drain', async () => {
    armCaptureEnv();
    await seedFakeFamily(FAKE_COPARENT);
    const base = captureRunDeps();
    const enqueue = vi.fn(base().enqueue);
    const afterRun = vi.fn();
    const res = await handlePreviewReminderTrigger(
      post('/api/channels/preview/reminders', { phone: FAKE }),
      {
        database: t.database,
        env: ON,
        reminderDeps: () => ({ ...base(), enqueue }),
        afterRun,
        now: () => NOW,
      },
    );
    const summary = (await res.json()) as { fired: number; dispatch: string };
    expect(summary.dispatch).toBe('queued');
    expect(enqueue).toHaveBeenCalledTimes(summary.fired);
    expect(afterRun).toHaveBeenCalledOnce();
  });
});
