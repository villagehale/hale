import { createHmac } from 'node:crypto';
import { schema } from '@hale/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboundRouteDeps, InboundRouteOutcome } from '~/lib/channel/inbound-route';
import { readLineHold } from '~/lib/channel/proactive/review';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { handleLinqInboundRequest } from './inbound';
import { parseLinqWebhook } from './payload';

/**
 * VIL-226 · Linq `phone_number.status_updated`. Armed, a flagged line or a CRITICAL
 * reputation is stored as paused (the hourly decider then holds unrequested sends) and
 * #ops is paged; an active, healthy line lifts it. Unset, the event is ignored exactly as
 * it is today. VIL-611 · the fixture is Linq's documented payload (webhook version
 * 2026-02-03): `new_status` and `new_reputation`, not a `status` field.
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

type Line = { status: string; reputation: string };
const FLAGGED: Line = { status: 'FLAGGED', reputation: 'HEALTHY' };
const CRITICAL: Line = { status: 'ACTIVE', reputation: 'CRITICAL' };
const AT_RISK: Line = { status: 'ACTIVE', reputation: 'AT_RISK' };
const CLEAR: Line = { status: 'ACTIVE', reputation: 'HEALTHY' };

function lineData(line: Line, phoneNumber = LINE): Record<string, unknown> {
  return {
    phone_number: phoneNumber,
    previous_status: 'ACTIVE',
    new_status: line.status,
    previous_reputation: 'HEALTHY',
    new_reputation: line.reputation,
    changed_at: NOW.toISOString(),
  };
}

function statusEvent(line: Line, phoneNumber = LINE): Record<string, unknown> {
  return {
    api_version: 'v3',
    webhook_version: '2026-02-03',
    event_type: 'phone_number.status_updated',
    event_id: 'evt_line',
    created_at: NOW.toISOString(),
    trace_id: 'trace_line',
    partner_id: 'partner_fixture',
    data: lineData(line, phoneNumber),
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
    expect(parseLinqWebhook(statusEvent(FLAGGED), NOW)).toEqual({
      kind: 'ignored',
      reason: 'not_message_received',
    });
  });

  it('reads the line, its new status and its new reputation when armed', () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    expect(parseLinqWebhook(statusEvent(CRITICAL), NOW)).toEqual({
      kind: 'line_health',
      line: { phoneNumber: LINE, status: 'ACTIVE', reputation: 'CRITICAL' },
    });
    expect(parseLinqWebhook(statusEvent(FLAGGED), NOW)).toEqual({
      kind: 'line_health',
      line: { phoneNumber: LINE, status: 'FLAGGED', reputation: 'HEALTHY' },
    });
  });

  it('names an event without the number, the new status or the new reputation', () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    for (const drop of ['phone_number', 'new_status', 'new_reputation']) {
      const data = lineData(CRITICAL);
      delete data[drop];
      expect(parseLinqWebhook({ ...statusEvent(CRITICAL), data }, NOW)).toEqual({
        kind: 'ignored',
        reason: 'malformed',
      });
    }
  });
});

describe('parseLinqWebhook · a line event that is not the shape Linq sends', () => {
  it('names an unbounded or malformed number or status, and normalises a real number', () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    for (const data of [
      lineData(FLAGGED, 'not a number'),
      lineData(FLAGGED, '9'.repeat(400)),
      lineData({ status: 'x'.repeat(400), reputation: 'HEALTHY' }),
      lineData({ status: 'FLAGGED\nACTIVE', reputation: 'HEALTHY' }),
      lineData({ status: 'ACTIVE', reputation: 'x'.repeat(400) }),
      lineData({ status: 'ACTIVE', reputation: 'CRITICAL HEALTHY' }),
    ]) {
      expect(parseLinqWebhook({ ...statusEvent(FLAGGED), data }, NOW)).toEqual({
        kind: 'ignored',
        reason: 'malformed',
      });
    }
    expect(
      parseLinqWebhook({ ...statusEvent(FLAGGED), data: lineData(FLAGGED, '(555) 555-0199') }, NOW),
    ).toEqual({
      kind: 'line_health',
      line: { phoneNumber: LINE, status: 'FLAGGED', reputation: 'HEALTHY' },
    });
  });
});

describe('the Linq door · line health', () => {
  it('stores nothing for a malformed line event, and says so', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    const outcomes: InboundRouteOutcome[] = [];
    const bad = {
      ...statusEvent(FLAGGED),
      data: lineData({ status: 'x'.repeat(400), reputation: 'HEALTHY' }),
    };
    const response = await handleLinqInboundRequest(signed(bad), deps(outcomes));
    expect(await response.json()).toEqual({ outcome: 'malformed' });
    expect(await db.database.select().from(schema.linqLineHealth)).toEqual([]);
  });

  it('pauses unrequested sends on a CRITICAL reputation, then clears on an active, healthy line', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    const outcomes: InboundRouteOutcome[] = [];

    const critical = await handleLinqInboundRequest(signed(statusEvent(CRITICAL)), deps(outcomes));
    expect(await critical.json()).toEqual({ outcome: 'line_health', paused: true });
    expect(await db.database.select().from(schema.linqLineHealth)).toMatchObject([
      { phoneNumber: LINE, status: 'ACTIVE/CRITICAL', paused: true },
    ]);
    expect(await readLineHold(db.database)).toBe('line_health');

    const cleared = await handleLinqInboundRequest(signed(statusEvent(CLEAR)), deps(outcomes));
    expect(await cleared.json()).toEqual({ outcome: 'line_health', paused: false });
    expect(await db.database.select().from(schema.linqLineHealth)).toMatchObject([
      { phoneNumber: LINE, status: 'ACTIVE/HEALTHY', paused: false },
    ]);
    expect(await readLineHold(db.database)).toBeNull();
    expect(outcomes).toEqual(['line_health', 'line_health']);
  });

  it('pauses a FLAGGED line, and does not pause an AT_RISK one', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    const outcomes: InboundRouteOutcome[] = [];

    const atRisk = await handleLinqInboundRequest(signed(statusEvent(AT_RISK)), deps(outcomes));
    expect(await atRisk.json()).toEqual({ outcome: 'line_health', paused: false });
    expect(await readLineHold(db.database)).toBeNull();

    const flagged = await handleLinqInboundRequest(signed(statusEvent(FLAGGED)), deps(outcomes));
    expect(await flagged.json()).toEqual({ outcome: 'line_health', paused: true });
    expect(await readLineHold(db.database)).toBe('line_health');
  });

  it('pauses sends for Hale’s sending line, and never for another line on the account', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    const outcomes: InboundRouteOutcome[] = [];

    const other = await handleLinqInboundRequest(
      signed(statusEvent(FLAGGED, OTHER_LINE)),
      deps(outcomes),
    );
    expect(await other.json()).toEqual({ outcome: 'other_line' });
    expect(await db.database.select().from(schema.linqLineHealth)).toEqual([]);
    expect(await readLineHold(db.database)).toBeNull();

    const sending = await handleLinqInboundRequest(signed(statusEvent(FLAGGED)), deps(outcomes));
    expect(await sending.json()).toEqual({ outcome: 'line_health', paused: true });
    expect(await readLineHold(db.database)).toBe('line_health');
  });

  it('reads the sending line however its variable is spelled', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    vi.stubEnv('LINQ_FROM_E164', ' +1 (555) 555-0199 ');
    const outcomes: InboundRouteOutcome[] = [];

    const response = await handleLinqInboundRequest(signed(statusEvent(FLAGGED)), deps(outcomes));
    expect(await response.json()).toEqual({ outcome: 'line_health', paused: true });
    expect(await db.database.select().from(schema.linqLineHealth)).toMatchObject([
      { phoneNumber: LINE, paused: true },
    ]);
    expect(await readLineHold(db.database)).toBe('line_health');
  });

  it('names a line status with no sending line configured, and stores nothing', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    vi.stubEnv('LINQ_FROM_E164', '');
    const outcomes: InboundRouteOutcome[] = [];

    const response = await handleLinqInboundRequest(signed(statusEvent(FLAGGED)), deps(outcomes));
    expect(await response.json()).toEqual({ outcome: 'no_sending_line' });
    expect(await db.database.select().from(schema.linqLineHealth)).toEqual([]);
    expect(await readLineHold(db.database)).toBe('no_sending_line');
  });

  it('reads a pause only for the sending line, whoever wrote the row', async () => {
    await db.database
      .insert(schema.linqLineHealth)
      .values({ phoneNumber: OTHER_LINE, status: 'flagged', paused: true, updatedAt: NOW });
    expect(await readLineHold(db.database)).toBeNull();

    await db.database
      .insert(schema.linqLineHealth)
      .values({ phoneNumber: LINE, status: 'flagged', paused: true, updatedAt: NOW });
    expect(await readLineHold(db.database)).toBe('line_health');
  });

  it('writes nothing while the flag is unset', async () => {
    const outcomes: InboundRouteOutcome[] = [];
    const response = await handleLinqInboundRequest(signed(statusEvent(FLAGGED)), deps(outcomes));
    expect(await response.json()).toEqual({ outcome: 'ignored_event' });
    expect(await db.database.select().from(schema.linqLineHealth)).toEqual([]);
    expect(outcomes).not.toContain('line_health');
  });
});
