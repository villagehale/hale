import { createHmac } from 'node:crypto';
import { schema } from '@hale/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboundRouteDeps, InboundRouteOutcome } from '~/lib/channel/inbound-route';
import { readLinePaused } from '~/lib/channel/proactive/review';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { handleLinqInboundRequest } from './inbound';
import { parseLinqWebhook } from './payload';

/**
 * VIL-226 · Linq `phone_number.status_updated`. Armed, a flagged or throttled line is
 * stored as paused (the hourly decider then holds unrequested sends) and #ops is paged;
 * a healthy status lifts it. Unset, the event is ignored exactly as it is today.
 */

const KEY_BYTES = Buffer.alloc(32, 9);
const SECRET = `whsec_${KEY_BYTES.toString('base64')}`;
const URL_PINNED = 'https://app.example.test/api/channels/linq/inbound?version=2026-02-03';
const NOW = new Date('2026-10-08T16:00:00.000Z');
const TS = String(Math.floor(NOW.getTime() / 1000));
const LINE = '+15555550199';
const OTHER_LINE = '+15555550188';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec('truncate table linq_line_health');
  vi.stubEnv('LINQ_WEBHOOK_SECRET', SECRET);
  vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
  vi.stubEnv('LINQ_FROM_E164', LINE);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function statusEvent(status: string, phoneNumber = LINE): Record<string, unknown> {
  return {
    api_version: 'v3',
    webhook_version: '2026-02-03',
    event_type: 'phone_number.status_updated',
    event_id: 'evt_line',
    created_at: NOW.toISOString(),
    data: { phone_number: phoneNumber, status },
  };
}

function signed(payload: Record<string, unknown>): Request {
  const body = JSON.stringify(payload);
  const mac = createHmac('sha256', KEY_BYTES).update(`evt_line.${TS}.${body}`).digest('base64');
  return new Request(URL_PINNED, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'webhook-id': 'evt_line',
      'webhook-timestamp': TS,
      'webhook-signature': `v1,${mac}`,
    },
    body,
  });
}

function deps(outcomes: InboundRouteOutcome[]): InboundRouteDeps {
  return {
    database: db.database,
    intake: () => {
      throw new Error('a line status is not an intake turn');
    },
    enqueue: async () => {
      throw new Error('a line status is not enqueued');
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    countOutcome: async (outcome) => {
      outcomes.push(outcome);
    },
    now: () => NOW,
  };
}

describe('parseLinqWebhook · phone_number.status_updated', () => {
  it('is ignored as another event while the flag is unset', () => {
    expect(parseLinqWebhook(statusEvent('flagged'), NOW)).toEqual({
      kind: 'ignored',
      reason: 'not_message_received',
    });
  });

  it('reads the line and its status when armed, and names a malformed one', () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    expect(parseLinqWebhook(statusEvent('flagged'), NOW)).toEqual({
      kind: 'line_health',
      line: { phoneNumber: LINE, status: 'flagged' },
    });
    expect(
      parseLinqWebhook({ ...statusEvent('flagged'), data: { status: 'flagged' } }, NOW),
    ).toEqual({ kind: 'ignored', reason: 'malformed' });
  });
});

describe('parseLinqWebhook · a line event that is not the shape Linq sends', () => {
  it('names an unbounded or malformed number or status, and normalises a real number', () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    for (const data of [
      { phone_number: 'not a number', status: 'flagged' },
      { phone_number: '9'.repeat(400), status: 'flagged' },
      { phone_number: LINE, status: 'x'.repeat(400) },
      { phone_number: LINE, status: 'flagged\nactive' },
    ]) {
      expect(parseLinqWebhook({ ...statusEvent('flagged'), data }, NOW)).toEqual({
        kind: 'ignored',
        reason: 'malformed',
      });
    }
    expect(
      parseLinqWebhook(
        { ...statusEvent('flagged'), data: { phone_number: '(555) 555-0199', status: 'flagged' } },
        NOW,
      ),
    ).toEqual({ kind: 'line_health', line: { phoneNumber: LINE, status: 'flagged' } });
  });
});

describe('the Linq door · line health', () => {
  it('stores nothing for a malformed line event, and says so', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    const outcomes: InboundRouteOutcome[] = [];
    const bad = {
      ...statusEvent('flagged'),
      data: { phone_number: LINE, status: 'x'.repeat(400) },
    };
    const response = await handleLinqInboundRequest(signed(bad), deps(outcomes));
    expect(await response.json()).toEqual({ outcome: 'malformed' });
    expect(await db.database.select().from(schema.linqLineHealth)).toEqual([]);
  });

  it('stores a flagged line as paused, then clears it on a healthy status', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    const outcomes: InboundRouteOutcome[] = [];

    const flagged = await handleLinqInboundRequest(signed(statusEvent('flagged')), deps(outcomes));
    expect(await flagged.json()).toEqual({ outcome: 'line_health', paused: true });
    expect(await db.database.select().from(schema.linqLineHealth)).toMatchObject([
      { phoneNumber: LINE, status: 'flagged', paused: true },
    ]);

    const cleared = await handleLinqInboundRequest(signed(statusEvent('active')), deps(outcomes));
    expect(await cleared.json()).toEqual({ outcome: 'line_health', paused: false });
    expect(await db.database.select().from(schema.linqLineHealth)).toMatchObject([
      { phoneNumber: LINE, status: 'active', paused: false },
    ]);
    expect(outcomes).toEqual(['line_health', 'line_health']);
  });

  it('pauses sends for Hale’s sending line, and never for another line on the account', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    const outcomes: InboundRouteOutcome[] = [];

    const other = await handleLinqInboundRequest(
      signed(statusEvent('flagged', OTHER_LINE)),
      deps(outcomes),
    );
    expect(await other.json()).toEqual({ outcome: 'other_line' });
    expect(await db.database.select().from(schema.linqLineHealth)).toEqual([]);
    expect(await readLinePaused(db.database)).toBe(false);

    const sending = await handleLinqInboundRequest(signed(statusEvent('flagged')), deps(outcomes));
    expect(await sending.json()).toEqual({ outcome: 'line_health', paused: true });
    expect(await readLinePaused(db.database)).toBe(true);
  });

  it('reads the sending line however its variable is spelled', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    vi.stubEnv('LINQ_FROM_E164', ' +1 (555) 555-0199 ');
    const outcomes: InboundRouteOutcome[] = [];

    const response = await handleLinqInboundRequest(signed(statusEvent('flagged')), deps(outcomes));
    expect(await response.json()).toEqual({ outcome: 'line_health', paused: true });
    expect(await db.database.select().from(schema.linqLineHealth)).toMatchObject([
      { phoneNumber: LINE, paused: true },
    ]);
    expect(await readLinePaused(db.database)).toBe(true);
  });

  it('names a line status with no sending line configured, and stores nothing', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    vi.stubEnv('LINQ_FROM_E164', '');
    const outcomes: InboundRouteOutcome[] = [];

    const response = await handleLinqInboundRequest(signed(statusEvent('flagged')), deps(outcomes));
    expect(await response.json()).toEqual({ outcome: 'no_sending_line' });
    expect(await db.database.select().from(schema.linqLineHealth)).toEqual([]);
  });

  it('reads a pause only for the sending line, whoever wrote the row', async () => {
    await db.database
      .insert(schema.linqLineHealth)
      .values({ phoneNumber: OTHER_LINE, status: 'flagged', paused: true, updatedAt: NOW });
    expect(await readLinePaused(db.database)).toBe(false);

    await db.database
      .insert(schema.linqLineHealth)
      .values({ phoneNumber: LINE, status: 'flagged', paused: true, updatedAt: NOW });
    expect(await readLinePaused(db.database)).toBe(true);
  });

  it('writes nothing while the flag is unset', async () => {
    const outcomes: InboundRouteOutcome[] = [];
    const response = await handleLinqInboundRequest(signed(statusEvent('flagged')), deps(outcomes));
    expect(await response.json()).toEqual({ outcome: 'ignored_event' });
    expect(await db.database.select().from(schema.linqLineHealth)).toEqual([]);
    expect(outcomes).not.toContain('line_health');
  });
});
