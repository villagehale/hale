import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import type { ChannelMessageReceivedJob } from '~/lib/channel/twilio/inbound';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import type { EmailInboundConfig } from './config';
import { FakeContentReader } from './content';
import { forwardAddress, forwardAnswerAddress, mintForwardToken } from './forward-address';
import { type EmailForwardDeps, routeEmailForward } from './forward';
import { type EmailInboundDeps, type EmailInboundOutcome, routeEmailInbound } from './inbound';
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
}

async function route(args: RouteArgs): Promise<EmailInboundOutcome> {
  const queued: ChannelMessageReceivedJob[] = [];
  const from = args.from ?? `Bayview School <${SCHOOL}>`;
  const domain = from.slice(from.lastIndexOf('@') + 1).replace(/[>\s]/g, '');
  const deps: EmailInboundDeps = {
    database: db.database,
    content: () =>
      FakeContentReader.ok({
        text: args.text ?? FORWARDED,
        headers: { 'authentication-results': authPass(domain), ...args.headers },
      }),
    limiter: new FakeRateLimiter(),
    enqueue: async (job) => {
      queued.push(job);
    },
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
    countOutcome: async (outcome) => {
      counted.push(outcome);
    },
  };
  return routeEmailInbound(deps, CONFIG, {
    emailId: `email-${nonce}-${args.messageId ?? '1'}`,
    from,
    to: [args.to],
    messageId: `<${nonce}${args.messageId ?? '-msg-1@bcs.on.ca'}>`,
    subject: 'Fwd: Spring concert',
    attachmentCount: 0,
    receivedAt: NOW,
  });
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
  });

  it('a household with no reachable address is UNROUTABLE, never silence', async () => {
    await db.database
      .update(schema.users)
      .set({ email: null })
      .where(eq(schema.users.id, family.parentUserId));

    expect(await route({ to: forwardAddress(token, CONFIG) })).toBe('forward_unroutable');
    expect(await inboundRows()).toEqual([]);
    expect(await held()).toEqual([]);
    expect(counted).toEqual([]);
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
