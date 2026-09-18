import { randomUUID } from 'node:crypto';
import { schema } from '@hale/db';
import type PgBoss from 'pg-boss';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { acceptedStatus } from '~/lib/channel/ledger';
import {
  EMAIL_ALERT_TEMPLATE_KEY,
  type GmailAlertEnvelope,
  emailAlertDedupeKey,
} from '~/lib/integrations/email-alert';
import type { ActiveConnectorConnection } from '~/lib/integrations/store';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { connectorSyncDeps } from './connector-sync';

/**
 * The PRODUCTION wiring of the email alert — the seam that decides WHO gets texted.
 *
 * Every other test of this feature injects the ports, which means every other test is
 * blind to the one thing this file pins: that `connectorSyncDeps` maps the CONNECTION's
 * own fields onto the alert's inputs. Swap `connection.userId` for a hard-coded id here
 * and a household gets another household's parent; swap `connection.id` and the dedupe
 * key stops matching, so the same email is re-sent every sweep. Both are invisible to a
 * suite that hands the alert its arguments.
 *
 * The three cases are the three that can be reached with DB reads alone: they end before
 * the classifier, so no model is called and no token is needed.
 */

let db: TestDb;
let family: { familyId: string; parentUserId: string };

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  family = await seedFamily(db.database);
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
    id: randomUUID(),
    familyId: family.familyId,
    userId: family.parentUserId,
    provider: 'gmail',
    providerMetadata: {},
    tokens: { accessToken: 'ya29.test' },
    ...over,
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

describe('connectorSyncDeps — the email alert wiring', () => {
  it('reads the parent to text off the CONNECTION, so a mailbox with no user texts nobody', async () => {
    const outcomes = await alertPort()({
      connection: connection({ userId: null }),
      accessToken: 'ya29.test',
      seeding: false,
      envelopes: [envelope('m1'), envelope('m2')],
    });
    expect(outcomes).toEqual(['no_parent_user', 'no_parent_user']);
  });

  it("passes the sweep's SEEDING flag through, so a first sync stays silent", async () => {
    const outcomes = await alertPort()({
      connection: connection(),
      accessToken: 'ya29.test',
      seeding: true,
      envelopes: [envelope('m1')],
    });
    expect(outcomes).toEqual(['seeding_run']);
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
    expect(outcomes).toEqual(['already_sent']);
  });
});
