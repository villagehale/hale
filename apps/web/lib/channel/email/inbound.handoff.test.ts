import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelMessageReceivedJob } from '~/lib/channel/twilio/inbound';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { FakeContentReader } from './content';
import type { EmailInboundConfig } from './config';
import { type EmailInboundDeps, type EmailInboundOutcome, routeEmailInbound } from './inbound';
import type { InboundEmailEvent } from './payload';

/**
 * THE HAND-OFF — the two writes that decide whether a parent's email is answered, against
 * a real Postgres because both of them are decided by the database.
 *
 * `handed_off_at` exists to separate "we have this message" from "C1 has this message",
 * and the whole value of the separation is what happens when the second one fails: the
 * row stays unmarked, the outcome says so, and the reconciler finds it. A fake that does
 * not evaluate a WHERE clause cannot tell a marked row from an unmarked one, so it would
 * go green on a leg that never wrote the column at all.
 *
 * The duplicate claim is the other half, and it is a UNIQUE INDEX rather than a check in
 * this file's code: the pre-fetch dedupe upstream cannot settle two deliveries of one
 * Message-ID that arrive together, and what must never happen is both of them enqueueing.
 */

const NOW = new Date('2026-08-11T12:00:00.000Z');
const MX = 'mx.resend.com';
const PARENT_EMAIL = 'sam@example.com';

const CONFIG: EmailInboundConfig = {
  apiKey: 're_test',
  webhookSecret: 'whsec_test',
  inboundDomain: 'mail.villagehale.com',
  authservId: MX,
};

function event(over: Partial<InboundEmailEvent> = {}): InboundEmailEvent {
  return {
    emailId: 'email-1',
    from: `Sam <${PARENT_EMAIL}>`,
    to: [`hale@${CONFIG.inboundDomain}`],
    messageId: '<msg-1@example.com>',
    subject: 'Re: your week',
    attachmentCount: 0,
    receivedAt: NOW,
    ...over,
  };
}

describe('the inbound-email hand-off (real Postgres)', () => {
  let db: TestDb;
  let familyId: string;
  let userId: string;
  let queued: ChannelMessageReceivedJob[];
  let errors: unknown[][];

  beforeEach(async () => {
    db = await createTestDb();
    vi.stubEnv('APP_ENCRYPTION_KEY', Buffer.alloc(32, 9).toString('base64'));
    const [family] = await db.database
      .insert(schema.families)
      .values({ displayName: 'Test Family', provinceOrState: 'ON' })
      .returning({ id: schema.families.id });
    if (!family) throw new Error('no family');
    familyId = family.id;
    const [user] = await db.database
      .insert(schema.users)
      .values({ email: PARENT_EMAIL, name: 'Sam' })
      .returning({ id: schema.users.id });
    if (!user) throw new Error('no user');
    userId = user.id;
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId, userId, role: 'primary_parent' });
    queued = [];
    errors = [];
  });

  afterEach(async () => {
    await db.close();
    vi.unstubAllEnvs();
  });

  function deps(enqueue: EmailInboundDeps['enqueue']): EmailInboundDeps {
    return {
      database: db.database,
      content: () =>
        FakeContentReader.ok({
          text: 'Can you find a swim class?',
          headers: {
            'authentication-results': `${MX}; spf=pass smtp.mailfrom=example.com; dkim=pass header.d=example.com; dmarc=pass header.from=example.com`,
          },
        }),
      limiter: new FakeRateLimiter(),
      enqueue,
      now: () => NOW,
      log: {
        info: () => {},
        error: (...args: unknown[]) => {
          errors.push(args);
        },
      },
      countOutcome: async () => {},
    };
  }

  const accepting: EmailInboundDeps['enqueue'] = async (job) => {
    queued.push(job);
  };

  async function inboundRow() {
    const [row] = await db.database
      .select({
        id: schema.channelMessages.id,
        channel: schema.channelMessages.channel,
        handedOffAt: schema.channelMessages.handedOffAt,
        body: schema.channelMessages.body,
      })
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.direction, 'in'));
    return row;
  }

  it('hands the email to C1 and marks the row only once the job exists', async () => {
    const outcome = await routeEmailInbound(deps(accepting), CONFIG, event());

    expect(outcome).toBe<EmailInboundOutcome>('handed_off');
    const row = await inboundRow();
    expect(row?.channel).toBe('email');
    expect(row?.handedOffAt).toEqual(NOW);
    // The job points at the row, carries the sender's Message-ID, and holds no words.
    expect(queued).toEqual([
      {
        family_id: familyId,
        parent_user_id: userId,
        channel_message_id: row?.id,
        provider_message_id: '<msg-1@example.com>',
        received_at: NOW.toISOString(),
      },
    ]);
  });

  it('leaves the row unmarked for the reconciler when the queue refuses it', async () => {
    const outcome = await routeEmailInbound(
      deps(async () => {
        throw new Error('queue refused');
      }),
      CONFIG,
      event(),
    );

    expect(outcome).toBe<EmailInboundOutcome>('enqueue_failed');
    const row = await inboundRow();
    // Recorded — the parent's words are not lost — but NOT claimed as C1's.
    expect(row?.body).toBe('Can you find a swim class?');
    expect(row?.handedOffAt).toBeNull();
    expect(queued).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it('never logs what the parent wrote, even when the queue fails', async () => {
    await routeEmailInbound(
      deps(async () => {
        throw new Error('queue refused');
      }),
      CONFIG,
      event(),
    );

    const logged = JSON.stringify(errors);
    expect(logged).not.toContain('Can you find a swim class?');
    expect(logged).not.toContain(PARENT_EMAIL);
    // The positive control: the line IS about this message, so an assertion that the
    // body is absent cannot be passing because nothing was logged at all.
    expect(logged).toContain('<msg-1@example.com>');
  });

  it('enqueues once when the same Message-ID is delivered twice at once', async () => {
    // Both deliveries pass the pre-fetch dedupe (neither row exists when they read), so
    // the unique index is the only thing standing between one email and two replies.
    const [first, second] = await Promise.all([
      routeEmailInbound(deps(accepting), CONFIG, event()),
      routeEmailInbound(deps(accepting), CONFIG, event()),
    ]);

    expect([first, second].sort()).toEqual(['duplicate', 'handed_off']);
    expect(queued).toHaveLength(1);
    const rows = await db.database
      .select({ id: schema.channelMessages.id })
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.direction, 'in'));
    expect(rows).toHaveLength(1);
  });
});
