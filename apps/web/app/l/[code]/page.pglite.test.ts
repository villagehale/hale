import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROVIDER_CREDENTIALS_ENABLED_ENV } from '~/lib/signup/credentials/flag';
import { type LoginLinkPurpose, mintFreshLoginLink } from '~/lib/signup/login-link/store';
import { recordSignupOffer } from '~/lib/signup/store';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';

/**
 * /l/<code> over the real DDL: the link preview and the page both read the row, so what
 * the card in the thread says and what the page says come from the same host and purpose.
 */

const harness = vi.hoisted(() => ({ db: undefined as unknown as TestDb }));
vi.mock('~/lib/db', () => ({ db: () => harness.db.database }));

import ProviderLoginPage, { generateMetadata } from './page';

const NOW = new Date();
const HOST = 'haltonhills.perfectmind.com';
const TITLE = `Hale needs your login for ${HOST}`;
const PURPOSE: LoginLinkPurpose = {
  kind: 'login_ask',
  sessionLabel: 'Preschool Swim Sat 9:00',
  opensAt: { local: 'Tuesday, December 1, 2026 at 7:00 a.m.', timeZone: 'America/Toronto' },
};
const PURPOSE_LINE = 'Preschool Swim Sat 9:00 · opens Tuesday, December 1, 2026 at 7:00 a.m.';

beforeAll(async () => {
  harness.db = await createTestDb();
});
afterAll(async () => {
  await harness.db.close();
});
beforeEach(() => {
  vi.stubEnv('DATABASE_URL', 'postgres://pglite.invalid/test');
  vi.stubEnv(PROVIDER_CREDENTIALS_ENABLED_ENV, 'true');
  vi.stubEnv('LINQ_FROM_E164', '+14165550100');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function card(): Promise<{ code: string; mintAgain: () => Promise<string> }> {
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
  const mint = async () => {
    const minted = await mintFreshLoginLink(database, {
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      offerId: offer.id,
      providerHost: HOST,
      purpose: PURPOSE,
      now: new Date(),
    });
    return minted.url.split('/').pop() as string;
  };
  return { code: await mint(), mintAgain: mint };
}

async function open(code: string) {
  const params = Promise.resolve({ code });
  return {
    meta: await generateMetadata({ params }),
    html: renderToStaticMarkup(await ProviderLoginPage({ params })),
  };
}

describe('/l/<code> — the login card and its page', () => {
  it('names the provider and the purpose in the preview and on the page, and says honestly what happens to the login', async () => {
    const { code } = await card();
    const { meta, html } = await open(code);

    expect(meta.title).toEqual({ absolute: TITLE });
    expect(meta.description).toBe(PURPOSE_LINE);
    expect(meta.openGraph).toMatchObject({ title: TITLE, description: PURPOSE_LINE });
    expect(meta.robots).toEqual({ index: false, follow: false });

    expect(html).toContain(TITLE);
    expect(html).toContain(PURPOSE_LINE);
    expect(html).toMatch(/<a [^>]*href="sms:\+14165550100"[^>]*>Not now<\/a>/);
    expect(html).toContain(`Used only to sign in to ${HOST} for you.`);
    expect(html).toContain('Deleted after 45 days unless a registration there is still open.');
    expect(html).not.toMatch(/\bcity\b/i);
    expect(html).not.toMatch(/never sees|sealed/i);
  });

  it('keeps the code out of the next page and out of a session replay', async () => {
    const { code } = await card();
    const { meta, html } = await open(code);
    // The next page's referrer, and so PostHog's $referrer, never carries the code.
    expect(meta.referrer).toBe('no-referrer');
    // rrweb blocks a `ph-no-capture` subtree whole: no field, value or text is recorded.
    expect(html).toMatch(/<main class="[^"]*\bph-no-capture\b[^"]*"[^>]*>.*<input /);
    const gone = await open('ZzZzZzZz99');
    expect(gone.meta.referrer).toBe('no-referrer');
  });

  it('a card replaced by a fresh one is gone, and its preview names no provider', async () => {
    const { code: replaced, mintAgain } = await card();
    const fresh = await mintAgain();

    const gone = await open(replaced);
    expect(gone.html).toContain('this link isn&#x27;t here anymore');
    expect(gone.html).not.toContain(HOST);
    expect(gone.meta.title).toEqual({ absolute: 'Hale' });
    expect(gone.meta.description).toBeNull();
    expect(gone.meta.openGraph).toMatchObject({ title: 'Hale' });
    expect(JSON.stringify(gone.meta)).not.toContain(HOST);

    // Positive control: the fresh card for the same host is live.
    const live = await open(fresh);
    expect(live.html).toContain(TITLE);
  });
});
