import { schema } from '@hale/db';
import type PgBoss from 'pg-boss';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { acceptedStatus } from '~/lib/channel/ledger';
import {
  CALENDAR_ALERT_TEMPLATE_KEY,
  type CalendarChange,
  calendarAlertDedupeKey,
} from '~/lib/integrations/calendar-alert';
import {
  EMAIL_ALERT_TEMPLATE_KEY,
  type GmailAlertEnvelope,
  emailAlertDedupeKey,
} from '~/lib/integrations/email-alert';
import type { ActiveConnectorConnection } from '~/lib/integrations/store';
import { type TestDb, createTestDb, seedFamily, seedIntegration } from '~/lib/testing/pglite';
import { connectorSyncDeps } from './connector-sync';

/**
 * The PRODUCTION wiring of BOTH connector alerts — the seam that decides WHO gets texted.
 *
 * Every other test of these features injects the ports, which means every other test is
 * blind to the one thing this file pins: that `connectorSyncDeps` maps the CONNECTION's
 * own fields onto each alert's inputs. Swap `connection.userId` for a hard-coded id here
 * and a household gets another household's parent; swap `connection.id` and the dedupe
 * key stops matching, so the same email or the same event is re-sent every sweep. Both
 * are invisible to a suite that hands the alert its arguments.
 *
 * The cases are the ones reachable with DB reads alone: they end before the classifier,
 * so no model is called and no token is needed.
 */

let db: TestDb;
let family: { familyId: string; parentUserId: string };
/** A REAL integrations row per test: the calendar alert's snapshot memory hangs off it by
 * a cascading foreign key, so a fabricated uuid is rejected by the production DDL. */
let CONNECTION: string;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  family = await seedFamily(db.database);
  CONNECTION = await seedIntegration(db.database, family.familyId, family.parentUserId);
  vi.stubEnv('F14_ENABLED', 'true');
  // Belt and braces for a wiring that regresses PAST the early outcomes: the alert would
  // then reach the real classifier. Both make that a loud failure rather than a live call.
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubGlobal('fetch', () => {
    throw new Error('no network in this test');
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function connection(over: Partial<ActiveConnectorConnection> = {}): ActiveConnectorConnection {
  return {
    id: CONNECTION,
    familyId: family.familyId,
    userId: family.parentUserId,
    provider: 'gmail',
    providerMetadata: {},
    tokens: { accessToken: 'ya29.test' },
    ...over,
  };
}

function change(eventId: string): CalendarChange {
  return {
    eventId,
    updated: '2026-09-17T14:55:00.000Z',
    status: 'confirmed',
    title: 'Cartwheels Gym',
    // Far enough ahead that the window is never the reason an outcome came back — these
    // cases are about the WIRING, and a stale fixture date would silently make them all
    // pass as `outside_window`.
    start: { dateTime: new Date(Date.now() + 86_400_000).toISOString() },
    end: { dateTime: new Date(Date.now() + 90_000_000).toISOString() },
  };
}

function envelope(messageId: string): GmailAlertEnvelope {
  return {
    messageId,
    subject: 'Swim cancelled',
    from: 'Pool <info@pool.example>',
    snippet: 'the pool is closed Saturday',
    receivedAt: '2026-09-17T14:00:00.000Z',
  };
}

/** The real deps, with a queue that would throw if anything tried to enqueue (this path
 * never does). */
function alertPort() {
  const deps = connectorSyncDeps(db.database, {} as PgBoss).buildDeps();
  return deps.alertGmailEnvelopes;
}

function calendarAlertPort() {
  const deps = connectorSyncDeps(db.database, {} as PgBoss).buildDeps();
  return deps.alertCalendarChanges;
}

describe('connectorSyncDeps — the email alert wiring', () => {
  it('reads the parent to text off the CONNECTION, so a mailbox with no user texts nobody', async () => {
    const outcomes = await alertPort()({
      connection: connection({ userId: null }),
      accessToken: 'ya29.test',
      seeding: false,
      envelopes: [envelope('m1'), envelope('m2')],
    });
    expect(outcomes.map((o) => o.alert)).toEqual(['no_parent_user', 'no_parent_user']);
    // The booking axis is untouched by an envelope that never reached the decision.
    expect(outcomes.map((o) => o.booking)).toEqual([null, null]);
  });

  it("passes the sweep's SEEDING flag through, so a first sync stays silent", async () => {
    const outcomes = await alertPort()({
      connection: connection(),
      accessToken: 'ya29.test',
      seeding: true,
      envelopes: [envelope('m1')],
    });
    expect(outcomes).toEqual([{ alert: 'seeding_run', booking: null, going: null }]);
  });

  it('keys the dedupe read on THIS connection and THIS message id', async () => {
    // The claim is written by the send path; here it is pre-placed, so the only way to
    // reach `already_sent` is for the wiring to have built the very same key from
    // connection.id + envelope.messageId.
    const conn = connection();
    await db.database.insert(schema.channelMessages).values({
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'email_alert',
      templateKey: EMAIL_ALERT_TEMPLATE_KEY,
      dedupeKey: emailAlertDedupeKey(conn.id, 'm1'),
      status: acceptedStatus('sms'),
      sentAt: new Date(),
    });

    const outcomes = await alertPort()({
      connection: conn,
      accessToken: 'ya29.test',
      seeding: false,
      envelopes: [envelope('m1')],
    });
    expect(outcomes).toEqual([{ alert: 'already_sent', booking: null, going: null }]);
  });
});

describe('connectorSyncDeps — the calendar alert wiring', () => {
  it('reads the parent to text off the CONNECTION, so a calendar with no user texts nobody', async () => {
    const sweep = await calendarAlertPort()({
      connection: connection({ provider: 'gcal', userId: null }),
      seeding: false,
      changes: [change('ev1'), change('ev2')],
    });
    expect(sweep).toEqual({ changes: ['no_parent_user', 'no_parent_user'], reoffers: [] });
  });

  it("passes the sweep's SEEDING flag through, so a first sync stays silent", async () => {
    const sweep = await calendarAlertPort()({
      connection: connection({ provider: 'gcal' }),
      seeding: true,
      changes: [change('ev1')],
    });
    expect(sweep).toEqual({ changes: ['seeding_run'], reoffers: [] });
  });

  it('keys the dedupe read on THIS connection, THIS event and Google\'s own stamp', async () => {
    // Pre-placed, so the only way to reach `already_sent` is for the wiring to have built
    // the very same key from connection.id + eventId + updated.
    const conn = connection({ provider: 'gcal' });
    const moved = change('ev1');
    await db.database.insert(schema.channelMessages).values({
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'calendar_alert',
      templateKey: CALENDAR_ALERT_TEMPLATE_KEY,
      dedupeKey: calendarAlertDedupeKey(conn.id, moved.eventId, moved.updated),
      status: acceptedStatus('sms'),
      sentAt: new Date(),
    });

    await expect(
      calendarAlertPort()({ connection: conn, seeding: false, changes: [moved] }),
    ).resolves.toEqual({ changes: ['already_sent'], reoffers: [] });
    // ...and the SAME event with a new stamp is a new key, so a move is heard. The
    // concrete outcome rather than `not.toEqual('already_sent')`: an absence assertion
    // passes just as happily on a wiring that stopped producing outcomes at all. This
    // family has no verified channel, so the real gate is the next thing it meets.
    await expect(
      calendarAlertPort()({
        connection: conn,
        seeding: false,
        changes: [{ ...moved, updated: '2026-09-17T15:40:00.000Z' }],
      }),
    ).resolves.toEqual({ changes: ['gate_refused:not_enrolled'], reoffers: [] });
  });
});
