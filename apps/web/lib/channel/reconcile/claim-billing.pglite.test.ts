import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchLoopMessage } from '~/lib/channel/dispatch';
import { fakeChannel } from '~/lib/channel/fakes';
import type { ChannelSendOutcome, LoopMessage } from '~/lib/channel/types';
import { buildDispatchPorts } from '~/lib/channel/wiring';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { BILLING_NOTICE_TEMPLATE_KEY } from '~/lib/loop/templates/billing-notice';
import { loopTemplateRenderer } from '~/lib/loop/templates/registry';
import { scriptedClaimReader } from '~/lib/testing/claim-reader';
import { type TestDb, createTestDb, seedFamily, seedIntegration } from '~/lib/testing/pglite';
import type { BillingClaimFacts } from './billing-text';
import { billingClaimRows, loadClaimShadowContext } from './candidate-rows';
import { buildClaimCandidates } from './candidates';
import { bindDispatchClaimEnforce, createClaimEnforcer, refusedResolutions } from './claim-enforce';
import type { ReadClaim } from './claim-reader';
import { claimReadUserMessage } from './claim-reader';
import type { Segment } from './sentences';
import { loadReconcileView } from './view';

/**
 * VIL-735 · a billing notice through the real claim gate: the real loader, the real
 * verifier and the real dispatch, with only the reader's answer scripted (the reader
 * itself is the claim-read eval's job, on recordings). A correct text is backed, and a
 * wrong plan is refused whatever the reader did.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const NOW = new Date('2026-11-22T17:00:00Z');
const LINQ_SENT: ChannelSendOutcome = {
  status: 'sent',
  providerMessageId: 'linq-msg-1',
  transport: 'imessage',
};

const onPlus: BillingClaimFacts = {
  language: 'en',
  plan: 'Plus',
  previousPlan: 'Free',
  ended: false,
  refunds: [],
  paidThrough: { date: 'November 21, 2027', year: 2027, month: 11, day: 21 },
};
const refunded: BillingClaimFacts = {
  ...onPlus,
  previousPlan: null,
  refunds: [{ refundedMinor: 15900, chargeMinor: 15900 }],
};
const cancelled: BillingClaimFacts = {
  language: 'en',
  plan: 'Free',
  previousPlan: 'Plus',
  ended: true,
  refunds: [{ refundedMinor: 15900, chargeMinor: 15900 }],
  paidThrough: null,
};

let db: TestDb;
let familyId: string;
let parentUserId: string;
let phoneSeq = 0;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
  vi.stubEnv('CLAIM_READER_MODE', 'enforce');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  ({ familyId, parentUserId } = await seedFamily(db.database));
  await db.database
    .update(schema.users)
    .set({ timezone: 'America/Toronto' })
    .where(eq(schema.users.id, parentUserId));
  phoneSeq += 1;
  const phone = `+1416555${String(2000 + phoneSeq).padStart(4, '0')}`;
  await db.database.insert(schema.parentChannels).values({
    userId: parentUserId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    verifiedAt: new Date('2026-10-01T12:00:00Z'),
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

type Script = (segments: readonly Segment[]) => ReadClaim[];

function enforcerWith(script: Script) {
  const reader = scriptedClaimReader(script);
  const enforcer = createClaimEnforcer({
    enforces: () => true,
    reader,
    loadContext: loadClaimShadowContext,
  });
  return { reader, enforcer };
}

async function send(text: string, facts: BillingClaimFacts | undefined, script: Script) {
  const { reader, enforcer } = enforcerWith(script);
  const sms = fakeChannel('sms', LINQ_SENT);
  const ports = {
    ...buildDispatchPorts(db.database, {
      channels: { sms },
      renderer: loopTemplateRenderer,
      now: () => NOW,
    }),
    claimEnforce: bindDispatchClaimEnforce(db.database, enforcer),
  };
  const message: LoopMessage = {
    templateKey: BILLING_NOTICE_TEMPLATE_KEY,
    familyId,
    parentUserId,
    category: 'alert',
    urgency: 'normal',
    payload: { text },
    dedupeKey: `billing_notice:test-${phoneSeq}-${Math.random()}`,
    ...(facts ? { claimFacts: facts } : {}),
  };
  const result = await dispatchLoopMessage(message, ports);
  return { leg: result.legs[0], sms, reader };
}

/** The verdict on `text` from the real verifier, with the rows the dispatch would offer. */
async function readVerdict(text: string, facts: BillingClaimFacts, script: Script) {
  const { enforcer } = enforcerWith(script);
  const view = await loadReconcileView(db.database, { familyId, now: NOW });
  const read = await enforcer.read(db.database, {
    familyId,
    parentUserId,
    now: NOW,
    body: text,
    view,
    writerRows: billingClaimRows(familyId, facts, NOW),
    signal: new AbortController().signal,
    budgetMs: 15_000,
  });
  if (read.status !== 'read') throw new Error(`read failed: ${read.reason}`);
  return refusedResolutions(read.verdict);
}

const nothing: Script = () => [];
const citing =
  (kind: ReadClaim['kind'], row: ReadClaim['row']): Script =>
  () => [{ segment: 0, kind, row }];

describe('a correct text is backed', () => {
  it('"You\'re on Plus" citing the plan row is clean and sent', async () => {
    const { leg, sms } = await send(
      "You're on Plus now.",
      onPlus,
      citing('registration_done', 'r1'),
    );
    expect(leg?.outcome).toBe('sent');
    expect(sms.calls).toHaveLength(1);
    expect(sms.calls[0]?.rendered.text).toBe("You're on Plus now.");
  });

  it('a refund and a cancel, each citing its own row, are clean and sent', async () => {
    const script: Script = () => [
      { segment: 0, kind: 'cancelled', row: 'x1' },
      { segment: 1, kind: 'send_done', row: 'm1' },
      { segment: 2, kind: 'registration_done', row: 'r1' },
    ];
    const { leg, sms } = await send(
      'Your Plus plan ended. $159.00 went back to your card. You are on the free plan now.',
      cancelled,
      script,
    );
    expect(leg?.outcome).toBe('sent');
    expect(sms.calls).toHaveLength(1);
  });

  it('the plan row is offered ahead of ten existing registration rows', async () => {
    const integrationId = await seedIntegration(db.database, familyId, parentUserId);
    await db.database.insert(schema.activityBookings).values(
      Array.from({ length: 10 }, (_, i) => ({
        familyId,
        parentUserId,
        integrationId,
        messageId: `mail-${phoneSeq}-${i}`,
        providerHost: 'register.example.org',
        title: `Class ${i}`,
        firstSessionAt: new Date(NOW.getTime() + (i + 1) * 86_400_000),
      })),
    );
    const context = await loadClaimShadowContext(db.database, {
      familyId,
      now: NOW,
      parentUserId,
    });
    if (context.status !== 'ready') throw new Error('no context');
    const candidates = buildClaimCandidates(
      familyId,
      [...billingClaimRows(familyId, onPlus, NOW), ...context.rows],
      context.timeZone,
    );
    expect(candidates.projected.find((row) => row.a === 'r1')?.what).toBe(
      'Hale plan now: Plus (was Free), paid through November 21, 2027',
    );
    expect(candidates.capped).toEqual([{ slot: 'r', dropped: 1 }]);
  });
});

describe('a wrong plan is refused whatever the reader did', () => {
  it('"You\'re on Max" on a Plus family with no claim read is refused by the floor, unsent', async () => {
    const { leg, sms, reader } = await send("You're on Max now.", onPlus, nothing);
    expect(leg).toMatchObject({ outcome: 'failed', reason: 'unbacked_claim' });
    expect(sms.calls).toHaveLength(0);
    expect(reader.bodies).toEqual([]);
    // Positive control: the right plan with the same empty read goes out.
    const right = await send("You're on Plus now.", onPlus, nothing);
    expect(right.leg?.outcome).toBe('sent');
    expect(right.sms.calls).toHaveLength(1);
  });

  it('"You\'re on Max" citing the Plus row is refused kind_incompatible by the real verifier', async () => {
    const refused = await readVerdict(
      "You're on Max now.",
      onPlus,
      citing('registration_done', 'r1'),
    );
    expect(refused.map((r) => r.why)).toEqual(['kind_incompatible']);
  });

  it('a registration sentence cited to the plan row is refused, zero Linq calls', async () => {
    const text = "She's registered for Saturday swim.";
    const refused = await readVerdict(text, onPlus, citing('registration_done', 'r1'));
    expect(refused.map((r) => r.why)).toEqual(['kind_incompatible']);
    const { leg, sms } = await send(text, onPlus, citing('registration_done', 'r1'));
    expect(leg).toMatchObject({ outcome: 'failed', reason: 'unbacked_claim' });
    expect(sms.calls).toHaveLength(0);
  });

  it('a wrong amount with no claim read is refused by the floor', async () => {
    const { leg, sms } = await send('$99 went back to your card.', refunded, nothing);
    expect(leg).toMatchObject({ outcome: 'failed', reason: 'unbacked_claim' });
    expect(sms.calls).toHaveLength(0);
  });

  it('"still on Plus" after a cancel with the reader citing none is refused', async () => {
    const { leg, sms } = await send(
      "You're still on Plus.",
      { ...cancelled, previousPlan: 'Plus' },
      citing('registration_done', 'none'),
    );
    expect(leg).toMatchObject({ outcome: 'failed', reason: 'unbacked_claim' });
    expect(sms.calls).toHaveLength(0);
  });

  it('a cancel claim on a payment notice, with no ended row, is refused', async () => {
    const refused = await readVerdict(
      'Your plan was cancelled.',
      onPlus,
      citing('cancelled', 'x1'),
    );
    expect(refused.map((r) => r.why)).toEqual(['alias_not_offered']);
  });

  it('a cancel claim citing a refund row is refused kind_incompatible', async () => {
    const refused = await readVerdict(
      'Your subscription is cancelled.',
      refunded,
      citing('cancelled', 'm1'),
    );
    expect(refused.map((r) => r.why)).toEqual(['kind_incompatible']);
  });
});

describe('nothing is loosened for any other message', () => {
  it('the same "You\'re on Plus" with no claimFacts is still refused', async () => {
    const { leg, sms } = await send(
      "You're on Plus now.",
      undefined,
      citing('registration_done', 'none'),
    );
    expect(leg).toMatchObject({ outcome: 'failed', reason: 'unbacked_claim' });
    expect(sms.calls).toHaveLength(0);
  });

  it('with no claimFacts the reader is sent the same request as before', async () => {
    let seen: Parameters<ReturnType<typeof scriptedClaimReader>['read']>[0] | undefined;
    const reader = scriptedClaimReader(() => []);
    const spy = {
      bodies: reader.bodies,
      read: (input: Parameters<typeof reader.read>[0]) => {
        seen = input;
        return reader.read(input);
      },
    };
    const enforcer = createClaimEnforcer({
      enforces: () => true,
      reader: spy,
      loadContext: loadClaimShadowContext,
    });
    await bindDispatchClaimEnforce(db.database, enforcer).decide({
      familyId,
      parentUserId,
      body: 'See you Saturday.',
      now: NOW,
    });
    const context = await loadClaimShadowContext(db.database, {
      familyId,
      now: NOW,
      parentUserId,
    });
    if (context.status !== 'ready' || !seen) throw new Error('no read');
    const baseline = buildClaimCandidates(familyId, context.rows, context.timeZone);
    const message = (candidates: typeof baseline) =>
      claimReadUserMessage({ languageHint: null, now: 'x', segments: [], candidates });
    expect(message(seen.candidates)).toBe(message(baseline));
    expect(seen.candidates.projected.some((row) => row.what.startsWith('Hale plan'))).toBe(false);
  });
});
