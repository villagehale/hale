import { createHmac } from 'node:crypto';
import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FakeDb, makeFakeDb } from '~/lib/channel/intake/fakes';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import type { RateLimiter } from '~/lib/rate-limit/limiter';
import type { ChannelMessageReceivedJob } from '~/lib/channel/twilio/inbound';
import { FakeContentReader, type InboundContentReader } from './content';
import {
  type EmailInboundDeps,
  type EmailInboundOutcome,
  handleEmailInboundRequest,
} from './inbound';

/**
 * The webhook end to end, minus the network. Every signature is computed here from the
 * Svix spec rather than by the module under test, so a request these helpers build is
 * exactly what the provider would send.
 */

const SECRET = `whsec_${Buffer.from('inbound-email-test-secret-32byte').toString('base64')}`;
const MX = 'mx.resend.com';
const INBOUND_DOMAIN = 'mail.villagehale.com';
const ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');

const NOW = new Date('2026-08-11T12:00:00.000Z');
const SVIX_ID = 'msg_test';
const PARENT_EMAIL = 'sam@example.com';
const FAMILY = '00000000-0000-4000-8000-00000000fa11';
const USER = '00000000-0000-4000-8000-000000000001';

function configure(): void {
  vi.stubEnv('RESEND_API_KEY', 're_test');
  vi.stubEnv('RESEND_INBOUND_WEBHOOK_SECRET', SECRET);
  vi.stubEnv('HALE_INBOUND_EMAIL_DOMAIN', INBOUND_DOMAIN);
  vi.stubEnv('HALE_INBOUND_AUTHSERV_ID', MX);
  vi.stubEnv('APP_ENCRYPTION_KEY', ENCRYPTION_KEY);
}

/** An Authentication-Results header that passes: our MTA, DKIM aligned to the sender. */
function authPass(domain = 'example.com', authserv = MX): string {
  return `${authserv}; spf=pass smtp.mailfrom=${domain}; dkim=pass header.d=${domain}; dmarc=pass header.from=${domain}`;
}

function body(overrides: Record<string, unknown> = {}, type = 'email.received'): string {
  return JSON.stringify({
    type,
    created_at: NOW.toISOString(),
    data: {
      email_id: 'email-1',
      created_at: NOW.toISOString(),
      from: `Sam <${PARENT_EMAIL}>`,
      to: [`hale@${INBOUND_DOMAIN}`],
      message_id: '<msg-1@example.com>',
      subject: 'Re: your week',
      attachments: [],
      ...overrides,
    },
  });
}

function request(raw: string, headerOverrides: Record<string, string | null> = {}): Request {
  const timestamp = String(Math.floor(NOW.getTime() / 1000));
  const key = Buffer.from(SECRET.replace(/^whsec_/, ''), 'base64');
  const digest = createHmac('sha256', key)
    .update(`${SVIX_ID}.${timestamp}.${raw}`, 'utf8')
    .digest('base64');

  const headers = new Headers({
    'svix-id': SVIX_ID,
    'svix-timestamp': timestamp,
    'svix-signature': `v1,${digest}`,
  });
  for (const [name, value] of Object.entries(headerOverrides)) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
  return new Request('https://app.villagehale.com/api/channels/email/inbound', {
    method: 'POST',
    body: raw,
    headers,
  });
}

type FamilyRole = typeof schema.familyMembers.$inferInsert.role;

function seedParent(
  fake: FakeDb,
  role: FamilyRole = 'primary_parent',
  email = PARENT_EMAIL,
): void {
  fake.db.insert(schema.users).values({ id: USER, email });
  fake.db.insert(schema.familyMembers).values({ familyId: FAMILY, userId: USER, role });
}

interface Harness {
  deps: EmailInboundDeps;
  fake: FakeDb;
  content: FakeContentReader;
  built: number;
  /** Every job handed to C1 — the assertion surface for "was this actually passed on". */
  queued: ChannelMessageReceivedJob[];
  /** The routed-outcome lines — the shell's one info line per authentic request. */
  infos: unknown[][];
  /** Every outcome the shell counted, in order (rule #11's rate). */
  counted: EmailInboundOutcome[];
}

function harness(
  contentReader: FakeContentReader = FakeContentReader.ok({
    text: 'Can you find a swim class?',
    headers: { 'authentication-results': authPass() },
  }),
  limiter: RateLimiter = new FakeRateLimiter(),
  enqueueFails = false,
): Harness {
  const fake = makeFakeDb();
  const state = { built: 0 };
  const queued: ChannelMessageReceivedJob[] = [];
  const infos: unknown[][] = [];
  const counted: EmailInboundOutcome[] = [];
  const deps: EmailInboundDeps = {
    database: fake.db,
    content: (): InboundContentReader => {
      state.built += 1;
      return contentReader;
    },
    limiter,
    enqueue: async (job) => {
      if (enqueueFails) throw new Error('queue refused');
      queued.push(job);
    },
    now: () => NOW,
    log: {
      info: (...args: unknown[]) => {
        infos.push(args);
      },
      error: () => {},
    },
    countOutcome: async (outcome) => {
      counted.push(outcome);
    },
  };
  return {
    deps,
    fake,
    content: contentReader,
    queued,
    infos,
    counted,
    get built() {
      return state.built;
    },
  } as Harness;
}

async function outcomeOf(res: Response): Promise<EmailInboundOutcome> {
  return (await res.json()).outcome;
}

beforeEach(configure);
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('handleEmailInboundRequest · the two refusals', () => {
  it('503s with zero side effects when the leg is not provisioned', async () => {
    vi.stubEnv('RESEND_INBOUND_WEBHOOK_SECRET', undefined);
    const h = harness();
    const res = await handleEmailInboundRequest(request(body()), h.deps);

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'email_inbound_not_configured' });
    expect(h.fake.writes).toHaveLength(0);
    expect(h.content.requested).toEqual([]);
  });

  it('403s an unsigned request with zero side effects — no fetch, no write', async () => {
    const h = harness();
    const res = await handleEmailInboundRequest(
      request(body(), { 'svix-signature': null }),
      h.deps,
    );

    expect(res.status).toBe(403);
    expect(h.fake.writes).toHaveLength(0);
    expect(h.content.requested).toEqual([]);
  });

  /** The whole gate: without it, anyone who can POST can claim to be any parent. */
  it('403s a request whose body was altered after signing', async () => {
    const h = harness();
    const signed = request(body());
    const tampered = new Request(signed.url, {
      method: 'POST',
      body: body({ from: 'attacker@evil.test' }),
      headers: signed.headers,
    });

    expect((await handleEmailInboundRequest(tampered, h.deps)).status).toBe(403);
    expect(h.fake.writes).toHaveLength(0);
  });

  it('403s a signature made with the wrong secret', async () => {
    const h = harness();
    const res = await handleEmailInboundRequest(
      request(body(), { 'svix-signature': 'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }),
      h.deps,
    );
    expect(res.status).toBe(403);
  });

  /**
   * An authenticated request always answers 200 whatever the verdict — a 4xx/5xx makes
   * the provider retry a message we have already handled.
   */
  it('answers 200 for every authentic request, whatever the outcome', async () => {
    const h = harness();
    const res = await handleEmailInboundRequest(request(body()), h.deps);
    expect(res.status).toBe(200);
  });
});

describe('every authentic outcome is logged and counted (rule #11)', () => {
  it('counts the silence outcomes — an unknown sender leaves a rate, not nothing', async () => {
    const h = harness();

    expect(await outcomeOf(await handleEmailInboundRequest(request(body()), h.deps))).toBe(
      'unknown_sender',
    );

    expect(h.counted).toEqual(['unknown_sender']);
    expect(h.infos).toEqual([
      ['inbound email: routed', { outcome: 'unknown_sender', emailId: 'email-1' }],
    ]);
  });

  it('counts ignored_event and handed_off alike — the counter is a denominator, not an error log', async () => {
    const h = harness();
    seedParent(h.fake);

    await handleEmailInboundRequest(request(body({}, 'email.delivered')), h.deps);
    await handleEmailInboundRequest(request(body()), h.deps);

    expect(h.counted).toEqual(['ignored_event', 'handed_off']);
  });

  it('counts NOTHING for a refused request — forged traffic must not pollute the rates', async () => {
    const h = harness();

    await handleEmailInboundRequest(request(body(), { 'svix-signature': null }), h.deps);

    expect(h.counted).toEqual([]);
    expect(h.infos).toEqual([]);
  });
});

describe('routeEmailInbound · the order of the gates', () => {
  it('records a trusted parent’s reply and audits it', async () => {
    const h = harness();
    seedParent(h.fake);

    expect(await outcomeOf(await handleEmailInboundRequest(request(body()), h.deps))).toBe(
      'handed_off',
    );

    const messages = h.fake.rows(schema.channelMessages);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      familyId: FAMILY,
      parentUserId: USER,
      channel: 'email',
      direction: 'in',
      category: 'reply',
      providerMessageId: '<msg-1@example.com>',
      body: 'Can you find a swim class?',
    });

    const audits = h.fake.rows(schema.auditLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      familyId: FAMILY,
      actor: USER,
      actionTaken: 'email_reply_received',
      targetTable: 'channel_messages',
    });
  });

  it('ignores an event type that is not email.received, without fetching anything', async () => {
    const h = harness();
    seedParent(h.fake);
    const res = await handleEmailInboundRequest(request(body({}, 'email.delivered')), h.deps);

    expect(await outcomeOf(res)).toBe('ignored_event');
    expect(h.content.requested).toEqual([]);
    expect(h.fake.rows(schema.channelMessages)).toHaveLength(0);
    expect(h.fake.rows(schema.auditLog)).toHaveLength(0);
  });

  it('drops a sender address it cannot parse before spending anything', async () => {
    const h = harness();
    seedParent(h.fake);
    const res = await handleEmailInboundRequest(request(body({ from: 'not-an-address' })), h.deps);

    expect(await outcomeOf(res)).toBe('invalid_sender');
    expect(h.content.requested).toEqual([]);
  });

  /** The fetch is a provider round-trip; an unmetered endpoint that makes them is an
   * amplifier. The limiter must therefore run BEFORE it. */
  it('rate-limits before fetching the body', async () => {
    const denied: RateLimiter = {
      async check() {
        return { allowed: false, retryAfterSec: 600 };
      },
    };
    const h = harness(undefined, denied);
    seedParent(h.fake);

    expect(await outcomeOf(await handleEmailInboundRequest(request(body()), h.deps))).toBe(
      'rate_limited',
    );
    expect(h.content.requested).toEqual([]);
    expect(h.fake.rows(schema.channelMessages)).toHaveLength(0);
    expect(h.fake.rows(schema.auditLog)).toHaveLength(0);
  });

  it('treats a redelivery of the same Message-ID as a duplicate, without refetching', async () => {
    const h = harness();
    seedParent(h.fake);

    expect(await outcomeOf(await handleEmailInboundRequest(request(body()), h.deps))).toBe(
      'handed_off',
    );
    expect(h.content.requested).toEqual(['email-1']);

    expect(await outcomeOf(await handleEmailInboundRequest(request(body()), h.deps))).toBe(
      'duplicate',
    );
    expect(h.content.requested).toEqual(['email-1']);
    expect(h.fake.rows(schema.channelMessages)).toHaveLength(1);
  });

  /** The refusal is TYPED (PR #497): svix retries on any non-2xx and on nothing else,
   * so a transient provider blip answered 200 is a permanently dropped email. */
  it('answers a TRANSIENT content-fetch failure with a 5xx so the provider redelivers', async () => {
    const h = harness(FakeContentReader.failing('provider_error', true));
    seedParent(h.fake);

    const res = await handleEmailInboundRequest(request(body()), h.deps);
    expect(res.status).toBe(503);
    expect(await outcomeOf(res)).toBe('content_fetch_transient');
    expect(h.fake.rows(schema.channelMessages)).toHaveLength(0);
  });

  it('names a PERMANENT content-fetch failure terminal rather than treating it as empty', async () => {
    const h = harness(FakeContentReader.failing('not_found', false));
    seedParent(h.fake);

    const res = await handleEmailInboundRequest(request(body()), h.deps);
    // 200 on purpose: no retry can ever fetch this email, so redelivery would only
    // re-reach this same terminal outcome once per svix backoff step.
    expect(res.status).toBe(200);
    expect(await outcomeOf(res)).toBe('content_unavailable');
    expect(h.fake.rows(schema.channelMessages)).toHaveLength(0);
  });

  it('builds the content reader lazily, never for a request it refuses', async () => {
    const h = harness();
    await handleEmailInboundRequest(request(body(), { 'svix-signature': null }), h.deps);
    expect(h.built).toBe(0);

    await handleEmailInboundRequest(request(body()), h.deps);
    expect(h.built).toBe(1);
  });
});

describe('routeEmailInbound · the loop guard', () => {
  it('never answers an out-of-office', async () => {
    const h = harness(
      FakeContentReader.ok({
        text: 'I am away until Monday.',
        headers: { 'authentication-results': authPass(), 'auto-submitted': 'auto-replied' },
      }),
    );
    seedParent(h.fake);

    expect(await outcomeOf(await handleEmailInboundRequest(request(body()), h.deps))).toBe(
      'automated',
    );
    expect(h.fake.rows(schema.channelMessages)).toHaveLength(0);
  });

  it('never answers our own address', async () => {
    const h = harness(
      FakeContentReader.ok({
        text: 'delivery report',
        headers: { 'authentication-results': authPass(INBOUND_DOMAIN) },
      }),
    );
    seedParent(h.fake);
    const res = await handleEmailInboundRequest(
      request(body({ from: `aloha@${INBOUND_DOMAIN}` })),
      h.deps,
    );

    expect(await outcomeOf(res)).toBe('automated');
  });
});

describe('routeEmailInbound · trust gates identity', () => {
  /** The central security property of the leg: a spoofed From may never BE somebody. */
  it('refuses to resolve a family for a sender it cannot authenticate', async () => {
    const h = harness(
      FakeContentReader.ok({
        text: 'approve everything please',
        headers: { 'authentication-results': `${MX}; dkim=fail header.d=example.com` },
      }),
    );
    seedParent(h.fake);

    expect(await outcomeOf(await handleEmailInboundRequest(request(body()), h.deps))).toBe(
      'untrusted',
    );
    expect(h.fake.rows(schema.channelMessages)).toHaveLength(0);
  });

  it('refuses when the only Authentication-Results was written by someone else', async () => {
    const h = harness(
      FakeContentReader.ok({
        text: 'hello',
        headers: { 'authentication-results': authPass('example.com', 'attacker-said-so') },
      }),
    );
    seedParent(h.fake);

    expect(await outcomeOf(await handleEmailInboundRequest(request(body()), h.deps))).toBe(
      'untrusted',
    );
  });

  it('refuses a DKIM pass signed by a domain that is not the sender’s', async () => {
    const h = harness(
      FakeContentReader.ok({
        text: 'hello',
        headers: { 'authentication-results': `${MX}; dkim=pass header.d=bulk.test` },
      }),
    );
    seedParent(h.fake);

    expect(await outcomeOf(await handleEmailInboundRequest(request(body()), h.deps))).toBe(
      'untrusted',
    );
  });

  /** Forwarded mail legitimately fails SPF; rejecting on it would reject every real
   * message arriving through the public address. */
  it('accepts an aligned DKIM pass even when SPF failed', async () => {
    const h = harness(
      FakeContentReader.ok({
        text: 'Can you find a swim class?',
        headers: {
          'authentication-results': `${MX}; spf=fail smtp.mailfrom=forwarder.test; dkim=pass header.d=example.com`,
        },
      }),
    );
    seedParent(h.fake);

    expect(await outcomeOf(await handleEmailInboundRequest(request(body()), h.deps))).toBe(
      'handed_off',
    );
  });
});

describe('routeEmailInbound · who is talking', () => {
  it('files a cold stranger as unknown rather than guessing a family', async () => {
    const h = harness();
    const res = await handleEmailInboundRequest(request(body()), h.deps);

    expect(await outcomeOf(res)).toBe('unknown_sender');
    expect(h.fake.rows(schema.channelMessages)).toHaveLength(0);
  });

  it.each(['grandparent', 'nanny', 'babysitter'] as const)(
    'never routes a %s’s email to a household agent',
    async (role) => {
      const h = harness();
      seedParent(h.fake, role);

      expect(await outcomeOf(await handleEmailInboundRequest(request(body()), h.deps))).toBe(
        'not_a_parent',
      );
      expect(h.fake.rows(schema.channelMessages)).toHaveLength(0);
    },
  );

  /** The legacy buckets carry an EMPTY content scope precisely so they fail closed; a
   * negative role check would route them. */
  it.each(['extended', 'service'] as const)('never routes the legacy %s role', async (role) => {
    const h = harness();
    seedParent(h.fake, role);
    expect(await outcomeOf(await handleEmailInboundRequest(request(body()), h.deps))).toBe(
      'not_a_parent',
    );
  });

  it('routes a co-parent', async () => {
    const h = harness();
    seedParent(h.fake, 'co_parent');
    expect(await outcomeOf(await handleEmailInboundRequest(request(body()), h.deps))).toBe(
      'handed_off',
    );
  });
});

describe('routeEmailInbound · CASL', () => {
  it('honours an unsubscribe by opting the sender out of every stream', async () => {
    const h = harness(
      FakeContentReader.ok({
        text: 'unsubscribe',
        headers: { 'authentication-results': authPass() },
      }),
    );
    seedParent(h.fake);

    expect(await outcomeOf(await handleEmailInboundRequest(request(body()), h.deps))).toBe(
      'unsubscribed',
    );

    const optOuts = h.fake.rows(schema.emailOptOuts);
    expect(optOuts.map((r) => r.emailType).sort()).toEqual([
      'alert',
      'approval',
      'daily_digest',
      'reminder',
      'weekly_plan',
    ]);
    expect(optOuts.every((r) => r.userId === USER)).toBe(true);
  });

  it('audits the unsubscribe (rule #6)', async () => {
    const h = harness(
      FakeContentReader.ok({ text: 'STOP', headers: { 'authentication-results': authPass() } }),
    );
    seedParent(h.fake);
    await handleEmailInboundRequest(request(body()), h.deps);

    expect(h.fake.rows(schema.auditLog)[0]).toMatchObject({
      familyId: FAMILY,
      actor: USER,
      actionTaken: 'email_unsubscribe_received',
      targetTable: 'email_opt_outs',
    });
  });

  /**
   * An unsubscribe writes no channel_messages row, so it is invisible to the Message-ID
   * dedupe — every redelivery re-runs it, and it must stay honoured rather than erroring
   * or flipping to another outcome.
   *
   * NOT asserted here: that the second delivery skips the audit row. That guard rides on
   * `recordOptOut` returning false on a unique-index conflict, and this fake does not
   * enforce indexes — an assertion about it would only be testing the fake's permissiveness.
   * The behaviour is `recordOptOut`'s own contract, covered against real semantics in
   * lib/cron/email-compliance's suite, and worth re-checking on the live probe.
   */
  it('stays honoured, and does not error, when the same unsubscribe is redelivered', async () => {
    const h = harness(
      FakeContentReader.ok({
        text: 'unsubscribe',
        headers: { 'authentication-results': authPass() },
      }),
    );
    seedParent(h.fake);

    for (const _attempt of [1, 2, 3]) {
      expect(await outcomeOf(await handleEmailInboundRequest(request(body()), h.deps))).toBe(
        'unsubscribed',
      );
    }
    expect(h.fake.rows(schema.channelMessages)).toHaveLength(0);
  });

  /** A3's rule, kept identical: an unsubscribe with a photo attached is still an
   * unsubscribe, and must not be answered with "I can't read attachments". */
  it('honours an unsubscribe that arrives with an attachment', async () => {
    const h = harness(
      FakeContentReader.ok({
        text: 'unsubscribe',
        headers: { 'authentication-results': authPass() },
      }),
    );
    seedParent(h.fake);
    const res = await handleEmailInboundRequest(
      request(body({ attachments: [{ id: 'a', filename: 'photo.png' }] })),
      h.deps,
    );

    expect(await outcomeOf(res)).toBe('unsubscribed');
    expect(h.fake.rows(schema.emailOptOuts)).toHaveLength(5);
  });

  it('reads the keyword out of the NEW turn, not out of quoted history', async () => {
    const h = harness(
      FakeContentReader.ok({
        text: [
          'unsubscribe',
          '',
          'On Mon, Aug 10, 2026 at 4:12 PM Hale <aloha@villagehale.com> wrote:',
          '> Reply STOP to unsubscribe.',
        ].join('\n'),
        headers: { 'authentication-results': authPass() },
      }),
    );
    seedParent(h.fake);

    expect(await outcomeOf(await handleEmailInboundRequest(request(body()), h.deps))).toBe(
      'unsubscribed',
    );
  });

  /**
   * The inverse, and the one that would be a real bug: Hale's own footer says "Reply
   * STOP to unsubscribe". If quoted history were read as the parent's words, every
   * ordinary reply would unsubscribe them.
   */
  it('does NOT unsubscribe when the only STOP is inside the quoted footer', async () => {
    const h = harness(
      FakeContentReader.ok({
        text: [
          'Yes please, Tuesday works.',
          '',
          'On Mon, Aug 10, 2026 at 4:12 PM Hale <aloha@villagehale.com> wrote:',
          '> Reply STOP to unsubscribe.',
        ].join('\n'),
        headers: { 'authentication-results': authPass() },
      }),
    );
    seedParent(h.fake);

    expect(await outcomeOf(await handleEmailInboundRequest(request(body()), h.deps))).toBe(
      'handed_off',
    );
    expect(h.fake.rows(schema.emailOptOuts)).toHaveLength(0);
    expect(h.fake.rows(schema.channelMessages)[0]).toMatchObject({
      body: 'Yes please, Tuesday works.',
    });
  });

  it('cannot be unsubscribed by an untrusted sender spoofing the address', async () => {
    const h = harness(
      FakeContentReader.ok({
        text: 'unsubscribe',
        headers: { 'authentication-results': `${MX}; dkim=fail header.d=example.com` },
      }),
    );
    seedParent(h.fake);

    expect(await outcomeOf(await handleEmailInboundRequest(request(body()), h.deps))).toBe(
      'untrusted',
    );
    expect(h.fake.rows(schema.emailOptOuts)).toHaveLength(0);
  });
});

describe('routeEmailInbound · the body that gets stored', () => {
  it('stores only the new turn, never the quoted history', async () => {
    const h = harness(
      FakeContentReader.ok({
        text: [
          'Tuesday is better for us.',
          '',
          'On Mon, Aug 10, 2026 at 4:12 PM Hale <aloha@villagehale.com> wrote:',
          '> I found a Monday 4pm swim class. Want it?',
        ].join('\n'),
        headers: { 'authentication-results': authPass() },
      }),
    );
    seedParent(h.fake);
    await handleEmailInboundRequest(request(body()), h.deps);

    const stored = h.fake.rows(schema.channelMessages)[0] as { body: string };
    expect(stored.body).toBe('Tuesday is better for us.');
    expect(stored.body).not.toContain('swim class');
  });

  it('names a message that is nothing but quoted history rather than filing a blank', async () => {
    const h = harness(
      FakeContentReader.ok({
        text: [
          'On Mon, Aug 10, 2026 at 4:12 PM Hale <aloha@villagehale.com> wrote:',
          '> Anything else?',
        ].join('\n'),
        headers: { 'authentication-results': authPass() },
      }),
    );
    seedParent(h.fake);

    expect(await outcomeOf(await handleEmailInboundRequest(request(body()), h.deps))).toBe(
      'empty_after_extraction',
    );
    expect(h.fake.rows(schema.channelMessages)).toHaveLength(0);
  });

  it('treats an html-only message as an empty turn rather than storing markup', async () => {
    const h = harness(
      FakeContentReader.ok({
        text: null,
        html: '<p>hello</p>',
        headers: { 'authentication-results': authPass() },
      }),
    );
    seedParent(h.fake);

    expect(await outcomeOf(await handleEmailInboundRequest(request(body()), h.deps))).toBe(
      'empty_after_extraction',
    );
  });
});
