import { createHmac, randomUUID } from 'node:crypto';
import { schema } from '@hale/db';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { emailBlindIndex } from '~/lib/crypto/blind-index';
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
import {
  FORWARD_REVOKE_ASK_TEMPLATE_KEY,
  forwardRevokeAskReply,
  forwardRevokeReply,
} from './forward-request';
import { FORWARD_SUBJECT_MAX } from './forward-copy';
import { PENDING_FORWARD_TTL_MS, sweepExpiredForwards } from './forward-purge';
import { UNSUBSCRIBABLE_STREAMS } from './streams';
import {
  type EmailInboundDeps,
  type EmailInboundOutcome,
  handleEmailInboundRequest,
  routeEmailInbound,
} from './inbound';
import type { ResendTransport } from '~/lib/channel/resend-transport';
import { forwardAddressHandler } from '~/lib/channel/router/handlers';
import type { HandlerContext } from '~/lib/channel/router/route';

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
/** Every content fetch this test made. The pre-fetch dedupe exists to SAVE one of these
 * on a redelivery, and the only way to see it work is to count them. */
let fetches: string[];
/** The pglite instance is shared across the file (booted in hooks, per the flake rule),
 * so every Message-ID is made unique across tests. The door's own keys are family-scoped
 * (forward-address.ts `forwardClaimKey`), but the reply door's pre-fetch dedupe is still
 * global — and one test below deliberately reuses an id across two households, which is
 * only a fair test while no other test has spent it. */
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
    content: () => {
      const reader = FakeContentReader.ok({
        text: args.text ?? FORWARDED,
        headers: { 'authentication-results': authPass(domain), ...args.headers },
      });
      return {
        fetch: async (emailId) => {
          fetches.push(emailId);
          return reader.fetch(emailId);
        },
      };
    },
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
  fetches = [];
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
      // The router's own parse, handed down rather than redone — see EmailForwardInput.
      sender: { address: SCHOOL, domain: SCHOOL_DOMAIN, displayName: 'Bayview School' },
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
    // THE EVIDENCE IS THE ASK THAT WAS SENT, not a re-render of it. A reconstruction is
    // only as good as the copy table on the day the answer arrives; what a consent record
    // has to hold is the sentence the parent actually read.
    const askAsSent = (consent?.evidence as { ask?: string }).ask;
    expect(askAsSent).toContain('You forwarded "Spring concert" from bcs.on.ca');
    expect(sent[0]?.text).toContain(askAsSent as string);
    // And it does not outlive the question: the ledger holds it now.
    expect(await senders()).toMatchObject([{ askBody: null }]);

    expect(sent).toHaveLength(2);
    expect(sent[1]?.text).toContain("from now on I'll read what bcs.on.ca sends you");
  });

  it('MUTATION GUARD: the unstripped body reads as unclear, which is why extractReply is called', async () => {
    const { readAffirmative } = await import('~/lib/channel/affirmative');
    const { extractReply } = await import('./reply-extract');
    expect(readAffirmative(quotedYes('Yes'))).toBe('unclear');
    expect(readAffirmative(extractReply(quotedYes('Yes')).text)).toBe('yes');
  });

  it('CASL: a STOP at the ask address unsubscribes, and is not answered with another email', async () => {
    // The ask is the ONE message on this door that Hale sends first, and its footer
    // promises "Reply STOP and Hale will stop emailing you" — over a Reply-To that is
    // NOT the plain address. `stop` is deliberately not a NO (affirmative.ts), so
    // without the keyword gate it reads as `unclear` and is answered with a further
    // email to somebody who just asked not to be emailed.
    const ref = await ask();
    const outcome = await route({
      to: forwardAnswerAddress(token, ref, CONFIG),
      from: `Sam <${parentEmail}>`,
      text: 'STOP',
      messageId: '<stop-at-the-ask@example.test>',
    });

    expect(outcome).toBe('unsubscribed');
    const optOuts = await db.database
      .select()
      .from(schema.emailOptOuts)
      .where(eq(schema.emailOptOuts.userId, family.parentUserId));
    expect(optOuts.map((row) => row.emailType).sort()).toEqual([...UNSUBSCRIBABLE_STREAMS].sort());
    // The ask, and not one word after it.
    expect(sent).toHaveLength(1);
    // A STOP is not an answer to the question: the sender is left undecided.
    expect(await senders()).toMatchObject([{ state: 'pending' }]);
    expect(await verbs()).toContain('email_unsubscribe_received');
  });

  it('CASL: a STOP at a ref Hale no longer holds is still an unsubscribe, not a reply', async () => {
    // The stale-ref branch answers with an email of its own, so the keyword has to win
    // before the question is even looked up — the reply door's ordering exactly.
    await ask();
    expect(
      await route({
        to: forwardAnswerAddress(token, 'deadbeef', CONFIG),
        from: `Sam <${parentEmail}>`,
        text: 'unsubscribe',
        messageId: '<stop-at-a-stale-ref@example.test>',
      }),
    ).toBe('unsubscribed');
    expect(sent).toHaveLength(1);
  });

  it('a keyword inside a forwarded DOCUMENT is the school\'s word, not the parent\'s', async () => {
    // The asymmetry the door is built on, pinned: an instruction needs a person, and the
    // body of a forwarded document is written by somebody who is not one. Reading it for
    // keywords would let a one-word school email unsubscribe a household.
    expect(
      await route({
        to: forwardAddress(token, CONFIG),
        text: 'cancel',
        messageId: '<document-says-cancel@bcs.on.ca>',
      }),
    ).toBe('forward_sender_pending');
    expect(
      await db.database
        .select()
        .from(schema.emailOptOuts)
        .where(eq(schema.emailOptOuts.userId, family.parentUserId)),
    ).toEqual([]);
  });

  it('POSITIVE CONTROL: a word that is not a keyword still reaches the affirmative reader', async () => {
    // Without this, the test above would pass just as well if the door answered
    // EVERYTHING with an unsubscribe.
    const ref = await ask();
    expect(
      await route({
        to: forwardAnswerAddress(token, ref, CONFIG),
        from: `Sam <${parentEmail}>`,
        text: quotedYes('Yes'),
        messageId: '<not-a-keyword@example.test>',
      }),
    ).toBe('forward_sender_allowed');
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
  /**
   * A CRAFTED BANNER, all the way through the shipped router. The unit twin
   * (forward-copy.test.ts) pins the sentence; this pins that the value reaching it is
   * still the banner's — that no caller composes the ask from the raw subject instead.
   */
  it('repeats a hostile subject line clamped, on one line, and inside its own quotes', async () => {
    const hostile = [
      '---------- Forwarded message ---------',
      'From: Bayview School <office@bcs.on.ca>',
      'Date: Tue, 3 Jun 2026 at 09:12',
      `Subject: R\u00e9union \u200b\u202e "urgente" ${'tr\u00e8s important pour la rentr\u00e9e '.repeat(40)}`,
      'To: Sam <sam@example.com>',
      '',
      'The spring concert is on June 18 at 6pm in the gym.',
    ].join('\n');

    expect(await route({ to: forwardAddress(token, CONFIG), text: hostile })).toBe(
      'forward_sender_pending',
    );

    // The ask is the FIRST line of the outbound body; the lines under it are Hale's own
    // CASL footer (reply-send.ts). The subject may not add one of its own.
    const body = sent[0]?.text as string;
    const askLine = body.split('\n')[0] as string;
    expect(askLine).toContain('from bcs.on.ca');
    expect(askLine).toContain('Reply YES');
    expect(body).not.toMatch(/[\u200b\u202e]/);
    // Exactly one quoted span, and it is the sender's: the subject could not close it.
    expect(askLine.split('"')).toHaveLength(3);
    const quoted = askLine.slice(askLine.indexOf('"') + 1, askLine.lastIndexOf('"'));
    expect(quoted.length).toBeLessThanOrEqual(FORWARD_SUBJECT_MAX);
    // The accents survive — this is email, and they are what the subject said.
    expect(quoted.startsWith('R\u00e9union')).toBe(true);
  });

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

  it('a transport that refuses the ask gives the QUESTION back, and keeps the claim', async () => {
    expect(await route({ to: forwardAddress(token, CONFIG), sendFails: true })).toBe(
      'forward_ask_failed',
    );
    // An un-asked question must never sit in the database waiting to be purged, and no
    // document may be held against one.
    expect(await senders()).toEqual([]);
    expect(await held()).toEqual([]);
    expect(await refusals()).toEqual([{ reason: 'forward_ask_failed' }]);
    // What is NOT given back, pinned so nobody reads the sentence above as more than it
    // says: the ledger claim stands, so this delivery is spent and THIS document is
    // dropped. Only the next forward from the school asks again.
    expect(await inboundRows()).toHaveLength(1);

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

/**
 * THE WAY IN. Until this handler existed, `mintForwardToken` had no production caller —
 * a whole rung with no door, reachable only by hand SQL, and a live probe nobody could
 * run. Driven here against the real DDL and the SHIPPED handler, because the questions
 * are all about what is really in the database afterwards: which token came back, that a
 * second ask does not mint a second one, and that a turn-off really nulls the column
 * rather than answering as if it had.
 */
describe('a parent asking for their forwarding address, in the thread', () => {
  function turn(body: string, familyId = family.familyId): HandlerContext {
    return {
      familyId,
      parentUserId: family.parentUserId,
      conversationId: randomUUID(),
      body,
      send: async () => ({ providerMessageId: 'prov-1', channel: 'sms' as const }),
      now: NOW,
      resolved: null,
      openQuestions: async () => [],
      inboundChannelMessageId: randomUUID(),
    };
  }
  const handler = () => forwardAddressHandler({ error: () => {} });

  beforeEach(() => {
    vi.stubEnv('RESEND_API_KEY', 're_test');
    vi.stubEnv('RESEND_INBOUND_WEBHOOK_SECRET', 'whsec_test');
    vi.stubEnv('HALE_INBOUND_EMAIL_DOMAIN', CONFIG.inboundDomain);
    vi.stubEnv('HALE_INBOUND_AUTHSERV_ID', MX);
  });

  it('hands back the address that actually works, and mints at most one per family', async () => {
    // A family with no token yet, so the mint is real rather than a read-back.
    const fresh = await seedFamily(db.database, 'Fresh Family');
    vi.stubEnv('F14_FAMILY_ALLOWLIST', `${family.familyId},${fresh.familyId}`);

    const verdict = await handler().handle(db.database, turn("what's my forwarding address", fresh.familyId));
    expect(verdict).toMatchObject({ claimed: true, outcome: 'address_sent' });

    const [row] = await db.database
      .select({ token: schema.families.inboundForwardToken })
      .from(schema.families)
      .where(eq(schema.families.id, fresh.familyId));
    const minted = row?.token as string;
    expect(minted).toMatch(/^[0-9a-f]{30}$/);
    expect((verdict as { reply: string }).reply).toContain(forwardAddress(minted, CONFIG));

    // THE ADDRESS IS LIVE — the point of the whole handler. A document forwarded to the
    // address this reply just handed out reaches that family's door.
    expect(
      await route({ to: forwardAddress(minted, CONFIG), messageId: '<handed-out@bcs.on.ca>' }),
    ).toBe('forward_sender_pending');

    // Asked twice is the same address, not a second credential.
    await handler().handle(db.database, turn('forwarding address', fresh.familyId));
    const [again] = await db.database
      .select({ token: schema.families.inboundForwardToken })
      .from(schema.families)
      .where(eq(schema.families.id, fresh.familyId));
    expect(again?.token).toBe(minted);
  });

  /**
   * ROUND 6 (D17): the turn-off half ASKS, it does not act. The address is still live
   * after this turn, and the whole answer half — the standing question, the YES that
   * spends it and the co-parent who cannot — is driven through the real router in
   * forward-revoke.pglite.test.ts, because the question is derived from the ledger the
   * router writes.
   */
  it('asks before it turns anything off, and the address is still live afterwards', async () => {
    const off = await handler().handle(db.database, turn('turn off my forwarding address'));
    expect(off).toMatchObject({
      claimed: true,
      outcome: 'revoke_ask_sent',
      reply: forwardRevokeAskReply('en'),
      templateKey: FORWARD_REVOKE_ASK_TEMPLATE_KEY,
    });
    expect(await familyForForwardToken(db.database, token)).toBe(family.familyId);
    expect(await route({ to: forwardAddress(token, CONFIG) })).toBe('forward_sender_pending');
    expect(await verbs()).not.toContain('email_forward_address_revoked');
  });

  it('does not ask a family with nothing to turn off - it says so, and opens no question', async () => {
    const fresh = await seedFamily(db.database, 'Nothing To Revoke');
    const nothing = await handler().handle(
      db.database,
      turn('turn off my forwarding address', fresh.familyId),
    );
    expect(nothing).toMatchObject({
      claimed: true,
      outcome: 'not_configured',
      reply: forwardRevokeReply('en', 'not_configured'),
    });
    expect((nothing as { templateKey?: string }).templateKey).toBeUndefined();
  });

  it('DECLINES a household the forwarding door is still dark for, rather than handing out a dead address', async () => {
    vi.stubEnv('F14_FAMILY_ALLOWLIST', '');
    expect(await handler().handle(db.database, turn('forwarding address'))).toEqual({
      claimed: false,
    });
    const [row] = await db.database
      .select({ token: schema.families.inboundForwardToken })
      .from(schema.families)
      .where(eq(schema.families.id, family.familyId));
    expect(row?.token).toBe(token);

    // The undo is NOT gated, for the connector pair's reason: a family may always close
    // a door they were given, whatever the flag says today. What the flag never gets to
    // do is stop the QUESTION either.
    expect(
      await handler().handle(db.database, turn('turn off my forwarding address')),
    ).toMatchObject({ claimed: true, outcome: 'revoke_ask_sent' });
  });

  it('answers a French parent in French, and leaves everybody else to the coach', async () => {
    const verdict = await handler().handle(
      db.database,
      turn('bonjour, quelle est mon adresse de transfert'),
    );
    expect((verdict as { reply: string }).reply).toContain('Transférez votre courrier');
    expect(await handler().handle(db.database, turn('yes'))).toEqual({ claimed: false });
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

  /**
   * ONE NEWSLETTER, TWO HOUSEHOLDS — the door's identity rule, proven against the real
   * indexes.
   *
   * A Message-ID on THIS door belongs to a third party, so two families can legitimately
   * present the same one: the school sends one newsletter and both parents forward it.
   * Under the reply door's global rule the second household was dropped in silence — no
   * row, no ask, no refusal — which is rule #11's exact shape.
   */
  it('each get their own question about the SAME Message-ID, and neither claims it twice', async () => {
    const other = await seedFamily(db.database, 'Other Family');
    const otherToken = (await mintForwardToken(db.database, other.familyId)).token;
    vi.stubEnv('F14_FAMILY_ALLOWLIST', `${family.familyId},${other.familyId}`);

    const shared = '-one-newsletter@bcs.on.ca';
    const first = await route({ to: forwardAddress(token, CONFIG), messageId: shared });
    const second = await route({ to: forwardAddress(otherToken, CONFIG), messageId: shared });

    expect([first, second]).toEqual(['forward_sender_pending', 'forward_sender_pending']);
    expect(sent).toHaveLength(2);

    // Each household holds its own copy of the document and its own pending sender.
    const heldBoth = await db.database
      .select({ familyId: schema.emailForwardsPending.familyId })
      .from(schema.emailForwardsPending)
      .where(
        inArray(schema.emailForwardsPending.familyId, [family.familyId, other.familyId]),
      );
    expect(heldBoth.map((row) => row.familyId).sort()).toEqual(
      [family.familyId, other.familyId].sort(),
    );
    const senderRows = await db.database
      .select({ familyId: schema.familyForwardSenders.familyId })
      .from(schema.familyForwardSenders)
      .where(
        inArray(schema.familyForwardSenders.familyId, [family.familyId, other.familyId]),
      );
    expect(senderRows).toHaveLength(2);

    // And the claim is still a claim: a redelivery of the FIRST family's own message
    // buys nothing — no second ask, no second ledger row for that household, and not
    // even the content fetch, because the pre-fetch dedupe asks the family-scoped
    // question too.
    const before = fetches.length;
    const again = await route({ to: forwardAddress(token, CONFIG), messageId: shared });
    expect(again).toBe('duplicate');
    expect(fetches.length).toBe(before);
    expect(sent).toHaveLength(2);
    expect(await inboundRows()).toHaveLength(1);
  });
});

describe('the forwarding door · the pre-fetch budget', () => {
  it('a tag that names no family does NOT mint a bucket of its own', async () => {
    // The pre-fetch limit bounds the Resend content fetch, which is the amplifier the
    // signature gate exists for. A well-formed tag is 30 hex characters and nothing
    // more, so keying on one before it is known to name a family would hand a single
    // sender a fresh budget per guess.
    const keys: string[] = [];
    const limiter: RateLimiter = {
      check: async (key, routeName) => {
        if (routeName === 'email-inbound') keys.push(key);
        return { allowed: true, retryAfterSec: 0 };
      },
    };

    await route({
      to: forwardAddress('a'.repeat(30), CONFIG),
      messageId: '<guess-1@bcs.on.ca>',
      limiter,
    });
    await route({
      to: forwardAddress('b'.repeat(30), CONFIG),
      messageId: '<guess-2@bcs.on.ca>',
      limiter,
    });

    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe(emailBlindIndex(SCHOOL));
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
    // A summary over many rows has one honest target: the household it was swept for.
    const [purge] = await db.database
      .select({
        targetTable: schema.auditLog.targetTable,
        targetId: schema.auditLog.targetId,
        after: schema.auditLog.after,
      })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.familyId, family.familyId),
          eq(schema.auditLog.actionTaken, 'email_forward_raw_purged'),
        ),
      );
    expect(purge).toMatchObject({
      targetTable: 'families',
      targetId: family.familyId,
      after: { purged: 1, senders: 1 },
    });

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

  it('a REDELIVERED signed webhook is answered 200 and buys nothing', async () => {
    const args: RouteArgs = {
      to: forwardAddress(token, CONFIG),
      messageId: '<signed-redelivery@bcs.on.ca>',
    };
    const first = await handleEmailInboundRequest(signed(args), inboundDeps(args));
    const second = await handleEmailInboundRequest(signed(args), inboundDeps(args));

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(counted).toEqual(['forward_sender_pending', 'duplicate']);
    expect(sent).toHaveLength(1);
    expect(await held()).toHaveLength(1);
    expect(await inboundRows()).toHaveLength(1);
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
