import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import { SIGNUP_OFFER_SENTENCE_TODO } from './offer-copy';
import { activityKeyFor, offerSignupFromFacts } from './offer-from-facts';
import { runAuthorizedSignup } from './run';
import { captureProviderSession } from './session-capture';
import { echoOfferWriter } from './test-models';

const NOW = new Date('2026-10-28T15:00:00.000Z');
const HREF = 'https://harbor-rec.example/register';
const SESSION = {
  id: 'tue-1630',
  label: 'Tue 4:30',
  startsAt: '2026-11-03T20:30:00.000Z',
  endsAt: '2026-11-03T21:15:00.000Z',
  full: false,
  priceCents: 4000,
};

describe('offerSignupFromFacts (production caller)', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(() => {
    vi.stubEnv('AUTHORIZED_SIGNUP_ENABLED', 'on');
    vi.stubEnv('BROWSER_USE_SIGNUP_ENABLED', 'true');
    vi.stubEnv('BROWSER_USE_SIGNUP_PAYMENT_ENABLED', '');
    vi.stubEnv('APP_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function family() {
    const seeded = await seedFamily(db.database);
    const childId = await seedChild(db.database, seeded.familyId, 'Ada', 36, undefined, NOW);
    return { ...seeded, childId };
  }

  it('writes from facts, records the offer, and audits without a locked sentence', async () => {
    const seeded = await family();
    const writer = echoOfferWriter();
    const result = await offerSignupFromFacts(
      db.database,
      {
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        childId: seeded.childId,
        now: NOW,
        facts: {
          source: 'email',
          evidence: 'Fall parent and tot swim Tuesday 4:30 forty dollars',
          registrationUrl: HREF,
          sessions: [SESSION],
          approvedPriceCents: 4000,
          language: null,
        },
      },
      { writer },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected recorded offer');
    expect(result.text).toContain('Tue 4:30');
    expect(result.text).toContain(HREF);
    expect(result.text).not.toContain(SIGNUP_OFFER_SENTENCE_TODO);
    expect(writer.facts[0]?.source).toBe('email');
    expect(writer.facts[0]?.evidence).toContain('Fall parent and tot swim');

    const [row] = await db.database
      .select()
      .from(schema.authorizedSignupOffers)
      .where(eq(schema.authorizedSignupOffers.id, result.offerId));
    expect(row?.status).toBe('pending');
    expect(row?.activityKey).toBe(activityKeyFor(HREF));
    expect(row?.registrationUrl).toBe(HREF);

    const audits = await db.database
      .select({ after: schema.auditLog.after })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, seeded.familyId));
    const blob = JSON.stringify(audits);
    expect(blob).toContain('"step":"offer"');
    expect(blob).toContain('harbor-rec.example');
    expect(blob).not.toContain('Ada');
    expect(blob).not.toContain(SIGNUP_OFFER_SENTENCE_TODO);
  });

  it('does not store an offer when the writer cannot write', async () => {
    const seeded = await family();
    const result = await offerSignupFromFacts(
      db.database,
      {
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        childId: seeded.childId,
        now: NOW,
        facts: {
          source: 'chat',
          evidence: 'can you sign us up for tuesday swim at https://harbor-rec.example/register',
          registrationUrl: HREF,
          sessions: [SESSION],
          approvedPriceCents: 4000,
          language: null,
        },
      },
      { writer: { write: async () => null } },
    );
    expect(result).toEqual({ ok: false, reason: 'unwritten' });
    const rows = await db.database
      .select({ id: schema.authorizedSignupOffers.id })
      .from(schema.authorizedSignupOffers)
      .where(eq(schema.authorizedSignupOffers.familyId, seeded.familyId));
    expect(rows).toHaveLength(0);
  });

  it('refuses empty evidence and a bad URL without calling the writer', async () => {
    const seeded = await family();
    const writer = echoOfferWriter();
    await expect(
      offerSignupFromFacts(
        db.database,
        {
          familyId: seeded.familyId,
          parentUserId: seeded.parentUserId,
          childId: seeded.childId,
          now: NOW,
          facts: {
            source: 'flyer',
            evidence: '   ',
            registrationUrl: HREF,
            sessions: [SESSION],
            approvedPriceCents: null,
            language: null,
          },
        },
        { writer },
      ),
    ).resolves.toEqual({ ok: false, reason: 'no_facts' });
    await expect(
      offerSignupFromFacts(
        db.database,
        {
          familyId: seeded.familyId,
          parentUserId: seeded.parentUserId,
          childId: seeded.childId,
          now: NOW,
          facts: {
            source: 'calendar',
            evidence: 'swim opens tuesday',
            registrationUrl: 'javascript:alert(1)',
            sessions: [SESSION],
            approvedPriceCents: null,
            language: null,
          },
        },
        { writer },
      ),
    ).resolves.toEqual({ ok: false, reason: 'url_refused' });
    expect(writer.facts).toHaveLength(0);
  });

  it('lets a parent yes run to reached_checkout with payment off, after a captured session', async () => {
    const seeded = await family();
    const writer = echoOfferWriter();
    const offered = await offerSignupFromFacts(
      db.database,
      {
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        childId: seeded.childId,
        now: NOW,
        facts: {
          source: 'flyer',
          evidence: 'Harbor Rec parent and tot swim Tue 4:30 $40',
          registrationUrl: HREF,
          sessions: [SESSION],
          approvedPriceCents: 4000,
          language: null,
        },
      },
      { writer },
    );
    expect(offered.ok).toBe(true);

    const captured = await captureProviderSession(db.database, {
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      providerHost: 'harbor-rec.example',
      storageState: {
        cookies: [{ name: 'JSESSIONID', value: 'rec-session', domain: 'harbor-rec.example' }],
      },
      capturedAt: NOW,
    });
    expect(captured.ok).toBe(true);

    const run = vi.fn(async () => ({
      outcome: 'reached_checkout' as const,
      detail: 'none' as const,
      liveViewUrl: 'https://live.browser-use.com/s/fixture',
      checkoutUrl: `${HREF}/checkout`,
      holdExpiresAt: new Date('2026-10-28T15:15:00.000Z'),
      cartTotalCents: 4000,
      confirmationNumber: null,
      opensAt: null,
      amountChargedCents: null,
      runId: 'run-fixture',
      sessionId: 'bu-session',
      costUsd: '0.01',
      sessionCostUsd: null,
      browserId: null,
    }));
    const result = await runAuthorizedSignup(
      db.database,
      {
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        body: 'Yes, sign us up',
        inboundChannelMessageId: 'msg-yes-1',
        existingThread: true,
        now: NOW,
      },
      {
        consentReader: {
          async read() {
            return { verdict: 'consent', sessionId: 'tue-1630' };
          },
        },
        outcomeWriter: {
          async write() {
            return null;
          },
        },
        browser: null,
        browserUseSignup: { run },
      },
    );
    expect(result.outcome).toBe('reached_checkout');
    expect(result.browserUse?.outcome).toBe('reached_checkout');
    const [engineInput] = run.mock.calls[0] as unknown as [{ payment: unknown }];
    expect(engineInput.payment).toBeNull();
    expect(process.env.BROWSER_USE_SIGNUP_PAYMENT_ENABLED ?? '').toBe('');
  });

  it('is the production caller: offer-copy is not imported', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./offer-from-facts.ts', import.meta.url)),
      'utf8',
    );
    expect(source).toContain('recordSignupOffer');
    expect(source).not.toContain('offer-copy');
    expect(source).not.toContain('signupTryOffer');
    expect(source).not.toContain(SIGNUP_OFFER_SENTENCE_TODO);
  });
});
