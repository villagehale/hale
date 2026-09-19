import { createHmac } from 'node:crypto';
import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import type { RateLimiter } from '~/lib/rate-limit/limiter';
import type { ChannelMessageReceivedJob } from '~/lib/channel/twilio/inbound';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import type { EmailInboundConfig } from './config';
import { FakeContentReader } from './content';
import {
  familyForForwardToken,
  forwardAddress,
  forwardAnswerAddress,
  mintForwardToken,
  revokeForwardToken,
} from './forward-address';
import { type EmailForwardDeps, routeEmailForward } from './forward';
import { PENDING_FORWARD_TTL_MS, sweepExpiredForwards } from './forward-purge';
import {
  type EmailInboundDeps,
  type EmailInboundOutcome,
  handleEmailInboundRequest,
  routeEmailInbound,
} from './inbound';
import type { ResendTransport } from '~/lib/channel/resend-transport';

/**
 * THE FORWARDING DOOR against the real DDL, driven through the SHIPPED router.
 *
 * pglite and `routeEmailInbound` rather than fakes and the branch function, because
 * everything that could be wrong here is either SQL or wiring: the partial unique index
 * that makes the ledger claim an idempotency key, the two unique indexes on the allowlist,
 * the cascade that is the erasure path, and — most of all — the fork itself. A test that
 * called `routeEmailForward` directly would pass just as happily with the fork never
 * wired into the router at all.
 */

const MX = 'mx.resend.com';
const CONFIG: EmailInboundConfig = {
  apiKey: 're_test',
  webhookSecret: 'whsec_test',
  inboundDomain: 'mail.villagehale.com',
  authservId: MX,
};
const NOW = new Date('2026-09-18T12:00:00.000Z');
const SCHOOL = 'office@bcs.on.ca';
const SCHOOL_DOMAIN = 'bcs.on.ca';

const FORWARDED = [
  '---------- Forwarded message ---------',
  `From: Bayview School <${SCHOOL}>`,
  'Date: Tue, 3 Jun 2026 at 09:12',
  'Subject: Spring concert',
  'To: Sam <sam@example.com>',
  '',
  'The spring concert is on June 18 at 6pm in the gym.',
].join('\n');

let db: TestDb;
let family: { familyId: string; parentUserId: string };
let parentEmail: string;
let token: string;
let sent: Array<Parameters<ResendTransport['send']>[0]>;
let counted: EmailInboundOutcome[];
/** The pglite instance is shared across the file (booted in hooks, per the flake rule),
 * so every Message-ID has to be unique across tests: the pre-fetch dedupe and the
 * `email_forwards_pending` unique index are both global by design. */
let nonce = 0;

function authPass(domain: string): string {
  return `${MX}; spf=pass smtp.mailfrom=${domain}; dkim=pass header.d=${domain}; dmarc=pass header.from=${domain}`;
}

interface RouteArgs {
  to: string;
  from?: string;
  text?: string;
  messageId?: string;
  headers?: Record<string, string>;
  /** Runs INSIDE the transport, so a test can ask what the database looked like at the
   * moment Hale spoke — which is the only way to pin an ordering. */
  onSend?: () => Promise<void>;
  /** A provider that refuses the send, the shape `sendEmailReply` turns into a throw. */
  sendFails?: boolean;
  limiter?: RateLimiter;
}

function inboundDeps(args: RouteArgs): EmailInboundDeps {
  const queued: ChannelMessageReceivedJob[] = [];
  const from = args.from ?? `Bayview School <${SCHOOL}>`;
  const domain = from.slice(from.lastIndexOf('@') + 1).replace(/[>\s]/g, '');
  return {
    database: db.database,
    content: () =>
      FakeContentReader.ok({
        text: args.text ?? FORWARDED,
        headers: { 'authentication-results': authPass(domain), ...args.headers },
      }),
    limiter: args.limiter ?? new FakeRateLimiter(),
    enqueue: async (job) => {
      queued.push(job);
    },
    reply: () => ({
      transport: {
        send: async (msg) => {
          await args.onSend?.();
          if (args.sendFails) {
            return { id: null, error: { name: 'application_error', message: 'refused' } };
          }
          sent.push(msg);
          return { id: `prov-${sent.length}`, error: null };
        },
      },
      config: CONFIG,
      from: 'aloha@villagehale.com',
    }),
    now: () => NOW,
    log: { info: () => {}, error: () => {} },
    countOutcome: async (outcome) => {
      counted.push(outcome);
    },
  };
}

function inboundEvent(args: RouteArgs) {
  return {
    emailId: `email-${nonce}-${args.messageId ?? '1'}`,
    from: args.from ?? `Bayview School <${SCHOOL}>`,
    to: [args.to],
    messageId: `<${nonce}${args.messageId ?? '-msg-1@bcs.on.ca'}>`,
    subject: 'Fwd: Spring concert',
    attachmentCount: 0,
    receivedAt: NOW,
  };
}

async function route(args: RouteArgs): Promise<EmailInboundOutcome> {
  return routeEmailInbound(inboundDeps(args), CONFIG, inboundEvent(args));
}

async function senders() {
  return db.database
    .select()
    .from(schema.familyForwardSenders)
    .where(eq(schema.familyForwardSenders.familyId, family.familyId));
}
async function held() {
  return db.database
    .select()
    .from(schema.emailForwardsPending)
    .where(eq(schema.emailForwardsPending.familyId, family.familyId));
}
async function inboundRows() {
  return db.database
    .select()
    .from(schema.channelMessages)
    .where(eq(schema.channelMessages.familyId, family.familyId));
}
async function verbs(): Promise<string[]> {
  const rows = await db.database
    .select({ verb: schema.auditLog.actionTaken })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.familyId, family.familyId));
  return rows.map((row) => row.verb).sort();
}
/** The reasons Hale wrote down for refusing — the trail entry a rejected instruction
 * against a family leaves behind (rule #6). */
async function refusals(): Promise<unknown[]> {
  const rows = await db.database
    .select({ after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, family.familyId),
        eq(schema.auditLog.actionTaken, 'email_forward_refused'),
      ),
    );
  return rows.map((row) => row.after);
}

/** One forward from an undecided school, and the `ref` its ask was addressed by. */
async function ask(): Promise<string> {
  await route({ to: forwardAddress(token, CONFIG) });
  const [sender] = await senders();
  return sender?.ref as string;
}

/** A real Gmail reply: one word, then the ask quoted underneath an attribution. */
function quotedYes(word: string): string {
  return [
    word,
    '',
    'On Tue, 3 Jun 2026 at 09:12, Hale <hale@mail.villagehale.com> wrote:',
    '> You forwarded "Spring concert" from bcs.on.ca. I haven\'t read it.',
  ].join('\n');
}

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  family = await seedFamily(db.database);
  parentEmail = `${family.familyId}@example.test`;
  token = (await mintForwardToken(db.database, family.familyId)).token;
  sent = [];
  counted = [];
  nonce += 1;
  vi.stubEnv('APP_ENCRYPTION_KEY', Buffer.alloc(32, 9).toString('base64'));
  vi.stubEnv('F14_FAMILY_ALLOWLIST', family.familyId);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the forwarding door · a document from a sender nobody has decided about', () => {
  it('holds it, asks the parent once, and spends nothing', async () => {
    const outcome = await route({ to: forwardAddress(token, CONFIG) });
    expect(outcome).toBe('forward_sender_pending');

    const [sender] = await senders();
    expect(sender).toMatchObject({
      familyId: family.familyId,
      senderDomain: SCHOOL_DOMAIN,
      state: 'pending',
      decidedBy: null,
      decidedAt: null,
    });
    expect(sender?.ref).toMatch(/^[0-9a-f]{8}$/);

    const [raw] = await held();
    expect(raw).toMatchObject({
      familyId: family.familyId,
      senderId: sender?.id,
      originalFrom: SCHOOL,
      subject: 'Spring concert',
      rawBody: 'The spring concert is on June 18 at 6pm in the gym.',
    });

    // The ledger claim: its own category, and NO body — the forwarded document is a third
    // party's, held in email_forwards_pending and nowhere else.
    const [ledger] = await inboundRows();
    expect(ledger).toMatchObject({ category: 'forwarded_mail', body: null, channel: 'email' });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(parentEmail);
    expect(sent[0]?.replyTo).toBe(forwardAnswerAddress(token, sender?.ref as string, CONFIG));
    expect(sent[0]?.text).toContain('You forwarded "Spring concert" from bcs.on.ca');
    expect(sent[0]?.text).toContain("I haven't read it");
    // The document's own words never leave the database.
    expect(sent[0]?.text).not.toContain('June 18');

    const audits = await db.database
      .select({ verb: schema.auditLog.actionTaken })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, family.familyId));
    expect(audits.map((row) => row.verb).sort()).toEqual([
      'email_forward_address_minted',
      'email_forward_received',
      'email_forward_sender_asked',
    ]);
  });

  it('holds a second forward from the same sender and deliberately does not ask twice', async () => {
    await route({ to: forwardAddress(token, CONFIG) });
    const outcome = await route({
      to: forwardAddress(token, CONFIG),
      messageId: '<msg-2@bcs.on.ca>',
    });

    expect(outcome).toBe('forward_sender_pending_again');
    expect(await held()).toHaveLength(2);
    expect(await senders()).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it('REDELIVERY: the same Message-ID buys no second ask, no second row, no unique violation', async () => {
    await route({ to: forwardAddress(token, CONFIG) });
    const again = await route({ to: forwardAddress(token, CONFIG) });

    // The pre-fetch dedupe catches a settled redelivery; the ledger claim catches the
    // race. Both are named, and neither spends anything.
    expect(again).toBe('duplicate');
    expect(sent).toHaveLength(1);
    expect(await held()).toHaveLength(1);
    expect(await inboundRows()).toHaveLength(1);
  });

  it('THE CLAIM: two deliveries racing past the pre-fetch dedupe still buy one ask', async () => {
    // The pre-fetch dedupe cannot settle a race — two deliveries of one Message-ID can
    // both pass it while the first is still in flight — so the claim is exercised
    // directly here. Remove `onConflictDoNothing` from `claim()` and this test fails.
    const deps: EmailForwardDeps = {
      database: db.database,
      limiter: new FakeRateLimiter(),
      reply: () => ({
        transport: {
          send: async (msg) => {
            sent.push(msg);
            return { id: `prov-${sent.length}`, error: null };
          },
        },
        config: CONFIG,
        from: 'aloha@villagehale.com',
      }),
      now: () => NOW,
      log: { info: () => {}, error: () => {} },
    };
    const input = {
      event: {
        emailId: `email-race-${nonce}`,
        from: `Bayview School <${SCHOOL}>`,
        to: [forwardAddress(token, CONFIG)],
        messageId: `<race-${nonce}@bcs.on.ca>`,
        subject: 'Fwd: Spring concert',
        attachmentCount: 0,
        receivedAt: NOW,
      },
      token,
      ref: null,
      text: FORWARDED,
      machine: null,
      headers: { 'authentication-results': authPass(SCHOOL_DOMAIN) },
    };

    expect(await routeEmailForward(deps, CONFIG, input)).toBe('forward_sender_pending');
    expect(await routeEmailForward(deps, CONFIG, input)).toBe('forward_duplicate');
    expect(sent).toHaveLength(1);
    expect(await held()).toHaveLength(1);
    expect(await senders()).toHaveLength(1);
  });

  it('a school sending under Precedence: bulk is READ here and refused on the reply door', async () => {
    const bulk = { Precedence: 'bulk' };
    expect(
      await route({ to: forwardAddress(token, CONFIG), headers: bulk }),
    ).toBe('forward_sender_pending');

    // The same message at the plain reply address: the loop guard still refuses it,
    // because that door answers the SENDER and this one never does.
    expect(
      await route({
        to: `hale@${CONFIG.inboundDomain}`,
        headers: bulk,
        messageId: '<msg-bulk@bcs.on.ca>',
      }),
    ).toBe('automated');
  });
});

describe('the forwarding door · the answer', () => {
  it('a quoted YES from the parent allows the sender, records the consent, and purges the raw', async () => {
    const ref = await ask();
    const outcome = await route({
      to: forwardAnswerAddress(token, ref, CONFIG),
      from: `Sam <${parentEmail}>`,
      text: quotedYes('Yes'),
      messageId: '<answer-1@example.test>',
    });

    expect(outcome).toBe('forward_sender_allowed');
    expect(await senders()).toMatchObject([
      { state: 'allowed', decidedBy: family.parentUserId, decidedAt: NOW },
    ]);
    // Decision 10: nothing raw survives a settled sender.
    expect(await held()).toEqual([]);

    const [consent] = await db.database
      .select()
      .from(schema.consentRecords)
      .where(eq(schema.consentRecords.familyId, family.familyId));
    expect(consent).toMatchObject({
      userId: family.parentUserId,
      familyId: family.familyId,
      consentType: 'integration_specific',
      consentScope: `email_forward:${SCHOOL_DOMAIN}`,
      granted: true,
    });
    expect(consent?.evidence).toMatchObject({ verbatimReply: 'Yes', interpretation: 'yes' });

    expect(sent).toHaveLength(2);
    expect(sent[1]?.text).toContain("from now on I'll read what bcs.on.ca sends you");
  });

  it('MUTATION GUARD: the unstripped body reads as unclear, which is why extractReply is called', async () => {
    const { readAffirmative } = await import('~/lib/channel/affirmative');
    const { extractReply } = await import('./reply-extract');
    expect(readAffirmative(quotedYes('Yes'))).toBe('unclear');
    expect(readAffirmative(extractReply(quotedYes('Yes')).text)).toBe('yes');
  });

  it('a NO blocks the sender, deletes the raw, and later forwards from it go nowhere', async () => {
    const ref = await ask();
    expect(
      await route({
        to: forwardAnswerAddress(token, ref, CONFIG),
        from: `Sam <${parentEmail}>`,
        text: quotedYes('No'),
        messageId: '<answer-2@example.test>',
      }),
    ).toBe('forward_sender_refused');
    expect(await senders()).toMatchObject([{ state: 'blocked' }]);
    expect(await held()).toEqual([]);
    expect(sent[1]?.text).toContain("I won't read mail from bcs.on.ca");

    expect(
      await route({ to: forwardAddress(token, CONFIG), messageId: '<msg-3@bcs.on.ca>' }),
    ).toBe('forward_sender_blocked');
    expect(sent).toHaveLength(2);
    expect(await refusals()).toEqual([{ reason: 'forward_sender_blocked' }]);

    // POSITIVE CONTROL: the door is not simply dead — a different school still asks.
    expect(
      await route({
        to: forwardAddress(token, CONFIG),
        from: 'Camp Wildwood <info@wildwood.test>',
        text: 'Session two starts July 6.',
        messageId: '<msg-4@wildwood.test>',
      }),
    ).toBe('forward_sender_pending');
    expect(sent).toHaveLength(3);
  });

  it('an answer from somebody who is not a parent of that family decides nothing', async () => {
    const ref = await ask();
    const outcome = await route({
      to: forwardAnswerAddress(token, ref, CONFIG),
      from: 'Stranger <nobody@elsewhere.test>',
      text: 'Yes',
      messageId: '<answer-3@elsewhere.test>',
    });

    expect(outcome).toBe('forward_answer_unauthorised');
    expect(await senders()).toMatchObject([{ state: 'pending' }]);
    expect(
      await db.database
        .select()
        .from(schema.consentRecords)
        .where(eq(schema.consentRecords.familyId, family.familyId)),
    ).toEqual([]);
    expect(sent).toHaveLength(1);
  });

  it('a parents own address with NO DKIM pass decides nothing either', async () => {
    const ref = await ask();
    const outcome = await route({
      to: forwardAnswerAddress(token, ref, CONFIG),
      from: `Sam <${parentEmail}>`,
      text: 'Yes',
      messageId: '<answer-4@example.test>',
      headers: { 'authentication-results': `${MX}; dkim=fail header.d=example.test` },
    });

    expect(outcome).toBe('forward_answer_unauthorised');
    expect(await senders()).toMatchObject([{ state: 'pending' }]);
  });

  it('anything but yes or no is asked once more, and decides nothing', async () => {
    const ref = await ask();
    const outcome = await route({
      to: forwardAnswerAddress(token, ref, CONFIG),
      from: `Sam <${parentEmail}>`,
      text: 'what is this about?',
      messageId: '<answer-5@example.test>',
    });

    expect(outcome).toBe('forward_answer_unclear');
    expect(await senders()).toMatchObject([{ state: 'pending' }]);
    expect(sent[1]?.text).toContain('was that a yes or a no');
  });
});

describe('the forwarding door · an instruction needs a person', () => {
  /**
   * THE MAIL LOOP, on the one branch that really can have one. The door relaxes the
   * loop guard because it answers the token's parent rather than the sender — true of a
   * forwarded DOCUMENT, and false of an ANSWER, where the address that just wrote to
   * Hale is the address Hale writes back to. A parent's out-of-office replying to the
   * ask is exactly that, and every hop carries a fresh Message-ID, so nothing downstream
   * dedupes it.
   */
  for (const [what, headers] of [
    ['an out-of-office', { 'Auto-Submitted': 'auto-replied' }],
    ['an auto-reply precedence', { Precedence: 'auto_reply' }],
    ['a vendor autoresponder', { 'X-Autoreply': 'yes' }],
  ] as const) {
    it(`${what} answering the ask is refused, and Hale says nothing back`, async () => {
      const ref = await ask();
      for (const hop of [1, 2, 3]) {
        expect(
          await route({
            to: forwardAnswerAddress(token, ref, CONFIG),
            from: `Sam <${parentEmail}>`,
            text: 'I am out of the office until Monday.',
            messageId: `<ooo-${what}-${hop}@example.test>`,
            headers,
          }),
        ).toBe('forward_answer_machine');
      }
      // The ask, and not one word after it.
      expect(sent).toHaveLength(1);
      expect(await senders()).toMatchObject([{ state: 'pending' }]);
      expect(await refusals()).toHaveLength(3);
    });
  }

  it('POSITIVE CONTROL: the same bulk marker on a forwarded DOCUMENT is still read', async () => {
    expect(
      await route({
        to: forwardAddress(token, CONFIG),
        headers: { Precedence: 'auto_reply' },
      }),
    ).toBe('forward_sender_pending');
    expect(sent).toHaveLength(1);
  });

  it('one unclear answer is re-asked, and the next one is met with silence', async () => {
    const ref = await ask();
    const unclear = (n: number): Promise<EmailInboundOutcome> =>
      route({
        to: forwardAnswerAddress(token, ref, CONFIG),
        from: `Sam <${parentEmail}>`,
        text: 'what is this about?',
        messageId: `<unclear-${n}@example.test>`,
      });

    expect(await unclear(1)).toBe('forward_answer_unclear');
    expect(sent).toHaveLength(2);
    expect(sent[1]?.text).toContain('was that a yes or a no');

    // The bound the ask copy promises. Without it a responder that sets no machine
    // marker at all still trades messages with Hale until the hourly cap stops it.
    expect(await unclear(2)).toBe('forward_answer_unclear_again');
    expect(await unclear(3)).toBe('forward_answer_unclear_again');
    expect(sent).toHaveLength(2);
    expect(await senders()).toMatchObject([{ state: 'pending' }]);
  });

  it('an answer to a ref Hale no longer holds tells the parent, instead of nothing', async () => {
    await ask();
    const outcome = await route({
      to: forwardAnswerAddress(token, 'deadbeef', CONFIG),
      from: `Sam <${parentEmail}>`,
      text: quotedYes('Yes'),
      messageId: '<stale-ref@example.test>',
    });

    expect(outcome).toBe('forward_answer_unknown');
    expect(sent).toHaveLength(2);
    expect(sent[1]?.text).toContain('Forward it to me again');
    expect(await refusals()).toEqual([{ reason: 'forward_answer_unknown' }]);
  });

  it('a stranger holding the token still gets nothing back, and leaves a reason', async () => {
    const ref = await ask();
    expect(
      await route({
        to: forwardAnswerAddress(token, ref, CONFIG),
        from: 'Stranger <nobody@elsewhere.test>',
        text: 'Yes',
        messageId: '<unauth-trail@elsewhere.test>',
      }),
    ).toBe('forward_answer_unauthorised');
    expect(sent).toHaveLength(1);
    expect(await refusals()).toEqual([{ reason: 'forward_answer_unauthorised' }]);
  });
});

describe('the forwarding door · the ask and the ref it hands out', () => {
  it('THE DOMAIN IS CLAIMED BEFORE THE ASK, so the ref a parent is handed always resolves', async () => {
    // The orphan this forbids: two first forwards from one new domain racing, both
    // sending an ask, one of the two refs never reaching the database — and that
    // parent's YES landing on a ref nobody knows. Claiming first makes it impossible.
    let refsAtSendTime: string[] = [];
    await route({
      to: forwardAddress(token, CONFIG),
      onSend: async () => {
        refsAtSendTime = (await senders()).map((row) => row.ref);
      },
    });
    const [sender] = await senders();
    expect(refsAtSendTime).toEqual([sender?.ref]);
    expect(sent[0]?.replyTo).toBe(forwardAnswerAddress(token, sender?.ref as string, CONFIG));
  });

  it('TWO FIRST FORWARDS FROM ONE SCHOOL, racing: one question, two held documents', async () => {
    // Both deliveries read an empty allowlist before either writes one. Without a
    // conflict-tolerant claim the loser raises a unique violation, the webhook 500s, and
    // the ask it already sent names a ref that does not exist.
    const deps = inboundDeps({ to: forwardAddress(token, CONFIG) });
    const one = routeEmailInbound(deps, CONFIG, inboundEvent({ to: forwardAddress(token, CONFIG), messageId: '<race-a@bcs.on.ca>' }));
    const two = routeEmailInbound(deps, CONFIG, inboundEvent({ to: forwardAddress(token, CONFIG), messageId: '<race-b@bcs.on.ca>' }));
    const outcomes = (await Promise.all([one, two])).sort();

    expect(outcomes).toEqual(['forward_sender_pending', 'forward_sender_pending_again']);
    expect(await senders()).toHaveLength(1);
    expect(await held()).toHaveLength(2);
    expect(sent).toHaveLength(1);
  });

  it('a transport that refuses the ask leaves NOTHING behind, and the next forward asks again', async () => {
    expect(await route({ to: forwardAddress(token, CONFIG), sendFails: true })).toBe(
      'forward_ask_failed',
    );
    // An un-asked question must never sit in the database waiting to be purged.
    expect(await senders()).toEqual([]);
    expect(await held()).toEqual([]);
    expect(await refusals()).toEqual([{ reason: 'forward_ask_failed' }]);

    expect(
      await route({ to: forwardAddress(token, CONFIG), messageId: '<after-failure@bcs.on.ca>' }),
    ).toBe('forward_sender_pending');
    expect(sent).toHaveLength(1);
  });

  it('THE DECISION COMMITS BEFORE THE ACKNOWLEDGEMENT, so a dead transport cannot lose a YES', async () => {
    const ref = await ask();
    await expect(
      route({
        to: forwardAnswerAddress(token, ref, CONFIG),
        from: `Sam <${parentEmail}>`,
        text: quotedYes('Yes'),
        messageId: '<yes-with-transport-down@example.test>',
        sendFails: true,
      }),
    ).rejects.toThrow();

    // The parent's own word survived the failure to say thank you for it. Send the ack
    // first and this is still `pending`, with the YES recoverable only from a webhook
    // alert.
    expect(await senders()).toMatchObject([{ state: 'allowed' }]);
    expect(await held()).toEqual([]);
  });

  it('a parent whose locale is French is asked in French', async () => {
    // Proves the SWITCH, not the product: nothing in apps/web writes users.locale today,
    // so every parent in production is en-CA and this column is one row away from live.
    await db.database
      .update(schema.users)
      .set({ locale: 'fr-CA' })
      .where(eq(schema.users.id, family.parentUserId));

    await route({ to: forwardAddress(token, CONFIG) });
    expect(sent[0]?.text).toContain("Vous m'avez transféré « Spring concert »");
  });
});

describe('the forwarding address · minted once, revoked once', () => {
  it('a second mint returns the same token and writes no second row, and a revoke is idempotent', async () => {
    expect((await mintForwardToken(db.database, family.familyId)).token).toBe(token);

    expect(await revokeForwardToken(db.database, family.familyId)).toBe(true);
    expect(await revokeForwardToken(db.database, family.familyId)).toBe(false);
    expect(await familyForForwardToken(db.database, token)).toBeNull();

    expect(await verbs()).toEqual([
      'email_forward_address_minted',
      'email_forward_address_revoked',
    ]);
  });

  it('a revoked address stops resolving, and the forward is refused by name', async () => {
    await revokeForwardToken(db.database, family.familyId);
    expect(await route({ to: forwardAddress(token, CONFIG) })).toBe('forward_unknown_token');
    expect(sent).toEqual([]);
  });
});

describe('the forwarding door · two families, one school', () => {
  it('do not share a rate-limit bucket at either gate', async () => {
    const other = await seedFamily(db.database, 'Other Family');
    const otherToken = (await mintForwardToken(db.database, other.familyId)).token;
    vi.stubEnv('F14_FAMILY_ALLOWLIST', `${family.familyId},${other.familyId}`);

    const keys: Array<[string, string]> = [];
    const limiter: RateLimiter = {
      check: async (key, routeName) => {
        keys.push([routeName, key]);
        return { allowed: true, retryAfterSec: 0 };
      },
    };

    await route({ to: forwardAddress(token, CONFIG), limiter });
    await route({
      to: forwardAddress(otherToken, CONFIG),
      messageId: '<other-family@bcs.on.ca>',
      limiter,
    });

    // The same school forwarded by two households: one bucket each, at BOTH gates. The
    // pre-fetch key is the tag (not the sender, who is the school); the post-fetch key is
    // the family.
    const inbound = keys.filter(([routeName]) => routeName === 'email-inbound');
    const forward = keys.filter(([routeName]) => routeName === 'email-forward');
    expect(new Set(inbound.map(([, key]) => key)).size).toBe(2);
    expect(forward.map(([, key]) => key)).toEqual([family.familyId, other.familyId]);
  });
});

describe('the forwarding door · the three-day promise', () => {
  // The sweep is global, as a lifecycle sweep has to be, and the pglite instance is
  // shared across this file — so the earlier tests' households are cleared first and the
  // summary below is exactly this test's own work.
  beforeEach(async () => {
    await db.database.delete(schema.emailForwardsPending);
    await db.database.delete(schema.familyForwardSenders);
  });

  it('a held forward past the TTL is purged, its pending sender with it, and the next forward asks again', async () => {
    await route({ to: forwardAddress(token, CONFIG) });
    expect(await held()).toHaveLength(1);

    const later = new Date(Date.now() + PENDING_FORWARD_TTL_MS + 60_000);
    expect(await sweepExpiredForwards(db.database, later)).toEqual({ purged: 1, senders: 1 });
    expect(await held()).toEqual([]);
    // The sender goes back to undecided, so a later forward asks rather than sitting
    // silently against a question nobody answered.
    expect(await senders()).toEqual([]);
    expect(await verbs()).toContain('email_forward_raw_purged');

    expect(
      await route({ to: forwardAddress(token, CONFIG), messageId: '<after-sweep@bcs.on.ca>' }),
    ).toBe('forward_sender_pending');
    expect(sent).toHaveLength(2);
  });

  it('POSITIVE CONTROL: a forward inside the window is left alone', async () => {
    await route({ to: forwardAddress(token, CONFIG) });
    const soon = new Date(Date.now() + PENDING_FORWARD_TTL_MS - 60_000);
    expect(await sweepExpiredForwards(db.database, soon)).toEqual({ purged: 0, senders: 0 });
    expect(await held()).toHaveLength(1);
    expect(await senders()).toHaveLength(1);
  });

  it('a DECIDED sender is never swept — only an unanswered question lapses', async () => {
    const ref = await ask();
    await route({
      to: forwardAnswerAddress(token, ref, CONFIG),
      from: `Sam <${parentEmail}>`,
      text: quotedYes('Yes'),
      messageId: '<sweep-allowed@example.test>',
    });

    const later = new Date(Date.now() + PENDING_FORWARD_TTL_MS + 60_000);
    expect(await sweepExpiredForwards(db.database, later)).toEqual({ purged: 0, senders: 0 });
    expect(await senders()).toMatchObject([{ state: 'allowed' }]);
  });
});

describe('the forwarding door · through the signed webhook', () => {
  const SVIX_ID = 'msg_forward_test';
  const SECRET = `whsec_${Buffer.from('inbound-email-test-secret-32byte').toString('base64')}`;

  beforeEach(() => {
    vi.stubEnv('RESEND_API_KEY', CONFIG.apiKey);
    vi.stubEnv('RESEND_INBOUND_WEBHOOK_SECRET', SECRET);
    vi.stubEnv('HALE_INBOUND_EMAIL_DOMAIN', CONFIG.inboundDomain);
    vi.stubEnv('HALE_INBOUND_AUTHSERV_ID', CONFIG.authservId);
  });

  function signed(args: RouteArgs): Request {
    const event = inboundEvent(args);
    const raw = JSON.stringify({
      type: 'email.received',
      created_at: NOW.toISOString(),
      data: {
        email_id: event.emailId,
        created_at: NOW.toISOString(),
        from: event.from,
        to: event.to,
        message_id: event.messageId,
        subject: event.subject,
        attachments: [],
      },
    });
    const timestamp = String(Math.floor(NOW.getTime() / 1000));
    const digest = createHmac('sha256', Buffer.from(SECRET.replace(/^whsec_/, ''), 'base64'))
      .update(`${SVIX_ID}.${timestamp}.${raw}`, 'utf8')
      .digest('base64');
    return new Request('https://app.villagehale.com/api/channels/email/inbound', {
      method: 'POST',
      headers: {
        'svix-id': SVIX_ID,
        'svix-timestamp': timestamp,
        'svix-signature': `v1,${digest}`,
      },
      body: raw,
    });
  }

  it('an unroutable forward is COUNTED — the silence outcomes are only visible as a rate', async () => {
    await db.database
      .update(schema.users)
      .set({ email: null })
      .where(eq(schema.users.id, family.parentUserId));

    const args: RouteArgs = { to: forwardAddress(token, CONFIG) };
    const res = await handleEmailInboundRequest(signed(args), inboundDeps(args));

    expect(res.status).toBe(200);
    expect(counted).toEqual(['forward_unroutable']);
  });

  it('a throttled forward is answered 200 and counted — the cap is a cap, not a delay', async () => {
    const args: RouteArgs = {
      to: forwardAddress(token, CONFIG),
      limiter: {
        check: async (_key, routeName) => ({
          allowed: routeName !== 'email-forward',
          retryAfterSec: 60,
        }),
      },
    };
    const res = await handleEmailInboundRequest(signed(args), inboundDeps(args));

    // NOT 503: redelivering a throttled forward would turn a spend cap into a delay, and
    // a sustained 5xx is how a provider disables the whole inbound endpoint.
    expect(res.status).toBe(200);
    expect(counted).toEqual(['forward_rate_limited']);
    expect(await inboundRows()).toEqual([]);
    expect(sent).toEqual([]);
  });
});

describe('the forwarding door · refusals and erasure', () => {
  it('a tag that resolves to no family STOPS — it never falls through to the reply door', async () => {
    const outcome = await route({ to: forwardAddress('f'.repeat(30), CONFIG) });
    expect(outcome).toBe('forward_unknown_token');
    expect(await inboundRows()).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('a hale+ tag it cannot even read STOPS too', async () => {
    expect(await route({ to: `hale+nonsense@${CONFIG.inboundDomain}` })).toBe(
      'forward_unknown_token',
    );
    expect(await inboundRows()).toEqual([]);
  });

  it('POSITIVE CONTROL: the plain reply address still reaches the reply door', async () => {
    const address = `positive-control-${nonce}@example.com`;
    await db.database
      .update(schema.users)
      .set({ email: address })
      .where(eq(schema.users.id, family.parentUserId));
    const outcome = await route({
      to: `hale@${CONFIG.inboundDomain}`,
      from: `Sam <${address}>`,
      text: 'Can you find a swim class?',
      messageId: '<plain-1@example.com>',
    });
    expect(outcome).toBe('handed_off');
    expect(await held()).toEqual([]);
  });

  it('a family that is not armed for F14 is dark, and nothing is written', async () => {
    vi.stubEnv('F14_FAMILY_ALLOWLIST', '');
    expect(await route({ to: forwardAddress(token, CONFIG) })).toBe('forward_family_dark');
    expect(await inboundRows()).toEqual([]);
    expect(sent).toEqual([]);
    expect(await refusals()).toEqual([{ reason: 'forward_family_dark' }]);
  });

  it('a household with no reachable address is UNROUTABLE, never silence', async () => {
    await db.database
      .update(schema.users)
      .set({ email: null })
      .where(eq(schema.users.id, family.parentUserId));

    expect(await route({ to: forwardAddress(token, CONFIG) })).toBe('forward_unroutable');
    expect(await inboundRows()).toEqual([]);
    expect(await held()).toEqual([]);
    // Named in the trail as well as in the return value: a household Hale could not
    // answer is a thing that happened to them (rule #6). The COUNTER is asserted at the
    // handler below, which is the only place countOutcome is actually called.
    expect(await refusals()).toEqual([{ reason: 'forward_unroutable' }]);
  });

  it('a bounce is refused on this door, though ordinary bulk mail is not', async () => {
    expect(
      await route({
        to: forwardAddress(token, CONFIG),
        from: 'mailer-daemon@bcs.on.ca',
      }),
    ).toBe('forward_machine');
    expect(await inboundRows()).toEqual([]);
  });

  it('erasing the family takes both new tables with it (the PIPEDA cascade)', async () => {
    await route({ to: forwardAddress(token, CONFIG) });
    expect(await senders()).toHaveLength(1);
    expect(await held()).toHaveLength(1);

    await db.database.delete(schema.families).where(eq(schema.families.id, family.familyId));

    expect(await senders()).toEqual([]);
    expect(await held()).toEqual([]);
  });
});
