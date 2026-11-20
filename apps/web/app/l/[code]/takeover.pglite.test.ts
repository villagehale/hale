import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROVIDER_CREDENTIALS_ENABLED_ENV } from '~/lib/signup/credentials/flag';
import { PROVIDER_CREDENTIALS_MASTER_KEY_ENV } from '~/lib/signup/credentials/kms';
import {
  type LoginLinkPurpose,
  lookupLoginLink,
  mintFreshLoginLink,
  mintTakeoverLink,
} from '~/lib/signup/login-link/store';
import { recordSignupOffer } from '~/lib/signup/store';
import { TAKEOVER_LINK_ENABLED_ENV } from '~/lib/signup/takeover/flag';
import { type TakeoverToken, parkPlanForTakeover } from '~/lib/signup/takeover/store';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';

/**
 * VIL-718 · the takeover card's page and its two POSTs over the real DDL: the preview and the
 * page read the same row, the live view leaves only through a POST, done spends the card once,
 * and a takeover card never takes a password.
 */

const harness = vi.hoisted(() => ({ db: undefined as unknown as TestDb }));
vi.mock('~/lib/db', () => ({ db: () => harness.db.database }));

import { POST as saveLogin } from '../../api/signup/l/[code]/route';
import { POST as done } from '../../api/signup/l/[code]/done/route';
import { POST as live } from '../../api/signup/l/[code]/live/route';
import ProviderLoginPage, { generateMetadata } from './page';
import { takeoverAnswer } from './takeover';

const NOW = new Date();
const HOST = 'register.example-rec.test';
const LIVE = 'https://live.browser-use.com/s/fixture-live-view-token';
const CARD = { title: `Prouve que tu es humain sur ${HOST}`, description: 'Natation sam. 9:00' };

beforeAll(async () => {
  harness.db = await createTestDb();
});
afterAll(async () => {
  await harness.db.close();
});
beforeEach(() => {
  vi.stubEnv('DATABASE_URL', 'postgres://pglite.invalid/test');
  vi.stubEnv(TAKEOVER_LINK_ENABLED_ENV, 'true');
  vi.stubEnv('APP_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  vi.stubEnv('LINQ_FROM_E164', '+14165550100');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

/** A plan parked on a captcha takeover, and the code of its card. */
async function takeoverCard(card: LoginLinkPurpose['card'] = CARD) {
  const database = harness.db.database;
  const seeded = await seedFamily(database);
  const childId = await seedChild(database, seeded.familyId, 'Ada', 40, undefined, NOW);
  const offer = await recordSignupOffer(database, {
    familyId: seeded.familyId,
    childId,
    parentUserId: seeded.parentUserId,
    activityKey: 'swim-preschool',
    registrationUrl: `https://${HOST}/Clients/x`,
    sessions: [
      {
        id: 'sat-0900',
        label: 'Preschool Swim Sat 9:00',
        startsAt: '2027-01-09T14:00:00.000Z',
        endsAt: '2027-01-09T14:45:00.000Z',
        full: false,
        priceCents: 9800,
      },
    ],
    approvedPriceCents: null,
    now: NOW,
  });
  if (!offer.ok) throw new Error(offer.reason);
  await database
    .update(schema.authorizedSignupOffers)
    .set({ status: 'submitting' })
    .where(eq(schema.authorizedSignupOffers.id, offer.id));
  const expiresAt = new Date(NOW.getTime() + 13 * 60_000);
  const minted = await mintTakeoverLink(database, {
    familyId: seeded.familyId,
    parentUserId: seeded.parentUserId,
    offerId: offer.id,
    providerHost: HOST,
    purpose: {
      kind: 'takeover',
      sessionLabel: 'Preschool Swim Sat 9:00',
      opensAt: null,
      card,
      takeover: 'captcha',
    },
    expiresAt,
    browser: { browserId: 'browser-1', liveViewUrl: LIVE },
    now: NOW,
  });
  const token: TakeoverToken = {
    phase: 'takeover',
    runId: 'run-1',
    sessionId: 'bu-session-1',
    browserId: 'browser-1',
    purpose: 'captcha',
    loginLinkId: minted.id,
    expiresAt: expiresAt.toISOString(),
    round: 1,
    doneAt: null,
    lapsedAt: null,
  };
  expect(
    await parkPlanForTakeover(database, {
      offerId: offer.id,
      familyId: seeded.familyId,
      token,
      now: NOW,
    }),
  ).toBe(true);
  return {
    ...seeded,
    offerId: offer.id,
    linkId: minted.id,
    code: minted.url.split('/').pop() as string,
  };
}

async function open(code: string) {
  const params = Promise.resolve({ code });
  return {
    meta: await generateMetadata({ params }),
    html: renderToStaticMarkup(await ProviderLoginPage({ params })),
  };
}

function post(handler: typeof live, code: string) {
  return handler(
    new Request(`https://app.example.test/api/signup/l/${code}/x`, { method: 'POST' }),
    {
      params: Promise.resolve({ code }),
    },
  );
}

async function auditSteps(offerId: string) {
  const rows = await harness.db.database
    .select({ after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.targetId, offerId),
        eq(schema.auditLog.actionTaken, 'authorized_signup_step'),
      ),
    )
    .orderBy(schema.auditLog.occurredAt);
  return rows.map((row) => row.after as Record<string, unknown>);
}

describe('/l/<code> — a takeover card', () => {
  it('previews the model’s words and opens Hale’s browser by a tap, with no live view and no password in the page', async () => {
    const { code } = await takeoverCard();
    const { meta, html } = await open(code);

    expect(meta.title).toEqual({ absolute: CARD.title });
    expect(meta.description).toBe(CARD.description);
    expect(meta.referrer).toBe('no-referrer');
    expect(meta.robots).toEqual({ index: false, follow: false });
    expect(html).toContain('Prouve que tu es humain sur');
    expect(html).toContain(CARD.description);
    expect(html).toContain(`Open ${HOST}`);
    // Whoever fetches the preview gets no live view, and the page never asks for a login.
    expect(html).not.toContain('live.browser-use.com');
    expect(html).not.toContain('fixture-live-view-token');
    expect(html).not.toMatch(/<input|<form|password/i);
    expect(html).toMatch(/<main class="[^"]*\bph-no-capture\b/);
  });

  it('with no card words, the heading and the preview are the bare host', async () => {
    const { code } = await takeoverCard(null);
    const { meta, html } = await open(code);
    expect(meta.title).toEqual({ absolute: HOST });
    expect(meta.description).toBeNull();
    expect(html).toContain('<h1');
    expect(html).toContain(HOST);
  });

  it('is gone while the takeover link is off, whatever the saved-login flag says', async () => {
    const { code } = await takeoverCard();
    vi.stubEnv(TAKEOVER_LINK_ENABLED_ENV, 'true\n');
    vi.stubEnv(PROVIDER_CREDENTIALS_ENABLED_ENV, 'true');
    const { meta, html } = await open(code);
    expect(html).toContain('this link isn&#x27;t here anymore');
    expect(meta.title).toEqual({ absolute: 'Hale' });
    expect(JSON.stringify(meta)).not.toContain(HOST);
  });

  it('a saved-login card stays behind its own flag: the takeover flag does not open it', async () => {
    const seeded = await seedFamily(harness.db.database);
    const minted = await mintFreshLoginLink(harness.db.database, {
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      offerId: null,
      providerHost: 'other.example-rec.test',
      purpose: { kind: 'login_ask', sessionLabel: null, opensAt: null, card: null },
      now: NOW,
    });
    const code = minted.url.split('/').pop() as string;
    expect((await open(code)).html).toContain('this link isn&#x27;t here anymore');
    expect((await post(live, code)).status).toBe(404);
    expect((await post(done, code)).status).toBe(404);
  });
});

describe('POST /api/signup/l/<code>/live and /done', () => {
  it('hands the live view to the page only, privately, and audits the host and the step', async () => {
    const { code, offerId } = await takeoverCard();
    const response = await post(live, code);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(await response.json()).toEqual({ liveViewUrl: LIVE });
    // Opening spends nothing: the parent may open it again until done.
    expect((await post(live, code)).status).toBe(200);
    const opened = (await auditSteps(offerId)).filter((s) => s.step === 'plan_takeover_opened');
    expect(opened).toHaveLength(2);
    expect(opened[0]).toEqual({ step: 'plan_takeover_opened', purpose: 'captcha', host: HOST });
    expect(JSON.stringify(await auditSteps(offerId))).not.toContain('live.browser-use.com');
  });

  it('done spends the card once and lets the next sweep pick the session back up', async () => {
    const { code, offerId, familyId } = await takeoverCard();
    const first = await post(done, code);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ done: true });
    expect((await post(done, code)).status).toBe(404);
    expect((await post(live, code)).status).toBe(404);
    expect(await lookupLoginLink(harness.db.database, code, new Date())).toEqual({
      ok: false,
      reason: 'used',
    });
    const [offer] = await harness.db.database
      .select()
      .from(schema.authorizedSignupOffers)
      .where(
        and(
          eq(schema.authorizedSignupOffers.id, offerId),
          eq(schema.authorizedSignupOffers.familyId, familyId),
        ),
      );
    expect(offer?.planLeaseUntil).toBeNull();
    expect((offer?.planResume as TakeoverToken).doneAt).not.toBeNull();
    expect((await auditSteps(offerId)).map((s) => s.step)).toContain('plan_takeover_done');
  });

  it('with the flag off, neither POST answers and the card is left as it was', async () => {
    const { code } = await takeoverCard();
    vi.stubEnv(TAKEOVER_LINK_ENABLED_ENV, undefined);
    expect((await post(live, code)).status).toBe(404);
    expect((await post(done, code)).status).toBe(404);
    vi.stubEnv(TAKEOVER_LINK_ENABLED_ENV, 'true');
    expect((await lookupLoginLink(harness.db.database, code, new Date())).ok).toBe(true);
  });

  it('an unknown code is gone', async () => {
    expect((await post(live, 'ZzZzZzZz99')).status).toBe(404);
    expect((await post(done, 'ZzZzZzZz99')).status).toBe(404);
  });

  it('never saves a password on a takeover card, and leaves the card live', async () => {
    vi.stubEnv(PROVIDER_CREDENTIALS_ENABLED_ENV, 'true');
    vi.stubEnv(PROVIDER_CREDENTIALS_MASTER_KEY_ENV, Buffer.alloc(32, 9).toString('base64'));
    const { code, familyId } = await takeoverCard();
    const response = await saveLogin(
      new Request(`https://app.example.test/api/signup/l/${code}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'parent-login', password: 'fixture-pass' }),
      }),
      { params: Promise.resolve({ code }) },
    );
    expect(response.status).toBe(404);
    expect((await lookupLoginLink(harness.db.database, code, new Date())).ok).toBe(true);
    const saved = await harness.db.database
      .select()
      .from(schema.providerSignupCredentials)
      .where(eq(schema.providerSignupCredentials.familyId, familyId));
    expect(saved).toEqual([]);
  });
});

describe('takeoverAnswer', () => {
  it('reads only a 404 as gone, and anything else that failed as worth another tap', () => {
    expect(takeoverAnswer(200)).toBe('ok');
    expect(takeoverAnswer(404)).toBe('gone');
    expect(takeoverAnswer(500)).toBe('retry');
    expect(takeoverAnswer(400)).toBe('retry');
    expect(takeoverAnswer(null)).toBe('retry');
  });
});
