import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { headers } from 'next/headers';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sitemap from '../../../sitemap.js';
import CheckoutSuccessPage, { generateMetadata } from './page.js';

vi.mock('next/headers', () => ({ headers: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const EN = {
  params: Promise.resolve({ locale: 'en' as const }),
  searchParams: Promise.resolve({}),
};

beforeEach(() => {
  vi.stubEnv('CHECKOUT_SUCCESS_STATES_ENABLED', undefined);
  vi.stubEnv('BILLING_THREAD_NOTICES_ENABLED', undefined);
  vi.mocked(headers).mockImplementation(() => {
    throw new Error('outside a request scope');
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('/checkout/success', () => {
  it('is noindex and stays out of the sitemap', async () => {
    const meta = await generateMetadata(EN);
    expect(meta.title).toBe('Checkout · Hale');
    expect(meta.robots).toEqual({ index: false, follow: false });
    expect(meta.alternates?.canonical).toBe('/checkout/success');
    for (const entry of sitemap()) {
      expect(entry.url.endsWith('/checkout/success')).toBe(false);
    }
  });

  it('renders a neutral unpaid state without a purchase claim or conversion', async () => {
    const html = renderToStaticMarkup(await CheckoutSuccessPage(EN));
    expect(html).not.toContain('You&#x27;re in.');
    expect(html).toContain('Checkout');
    expect(html).toContain('This page confirms a payment after Stripe has taken it.');
    expect(html).toContain('Open Hale');
    expect(html).toContain('v4-nav v4-glass');
    expect(html).not.toContain('GooglePurchaseConversion');
    expect(html).not.toContain('Text Hale');
  });

  it("shows You're in and Text Hale only after a paid session", async () => {
    vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', '+16462352164');
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          transactionId: 'cs_test_1',
          value: 79,
          currency: 'CAD',
          paid: true,
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchImpl);
    const html = renderToStaticMarkup(
      await CheckoutSuccessPage({
        params: Promise.resolve({ locale: 'en' as const }),
        searchParams: Promise.resolve({ session_id: 'cs_test_1' }),
      }),
    );
    expect(html).toContain('You&#x27;re in.');
    expect(html).toContain('Text Hale');
    expect(html).toContain('sms:+16462352164');
  });

  it('names the plan only from the verified session tier, never the query string', async () => {
    for (const [tier, name] of [
      ['family', 'Max'],
      ['plus', 'Plus'],
    ] as const) {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(
            new Response(
              JSON.stringify({
                transactionId: 'cs_test_t',
                value: 99,
                currency: 'CAD',
                paid: true,
                tier,
              }),
              { status: 200 },
            ),
          ),
      );
      const html = renderToStaticMarkup(
        await CheckoutSuccessPage({
          params: Promise.resolve({ locale: 'en' as const }),
          searchParams: Promise.resolve({
            session_id: 'cs_test_t',
            plan: 'plus',
            tier: 'plus',
          } as never),
        }),
      );
      expect(html).toContain(`You’re on ${name}.`);
    }
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ transactionId: 'cs_test_n', value: 99, currency: 'CAD', paid: true }),
            { status: 200 },
          ),
        ),
    );
    const html = renderToStaticMarkup(
      await CheckoutSuccessPage({
        params: Promise.resolve({ locale: 'en' as const }),
        searchParams: Promise.resolve({ session_id: 'cs_test_n' }),
      }),
    );
    expect(html).not.toMatch(/You’re on/);
  });

  it('stays unpaid when Stripe says the session is not paid', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          transactionId: 'cs_test_unpaid',
          value: 79,
          currency: 'CAD',
          paid: false,
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchImpl);
    const html = renderToStaticMarkup(
      await CheckoutSuccessPage({
        params: Promise.resolve({ locale: 'en' as const }),
        searchParams: Promise.resolve({ session_id: 'cs_test_unpaid' }),
      }),
    );
    expect(html).not.toContain('You&#x27;re in.');
    expect(html).toContain('Checkout');
    expect(html).not.toContain('Text Hale');
    expect(html).not.toContain('GooglePurchaseConversion');
  });

  it('never reads value or currency from the query string', () => {
    const page = readFileSync(fileURLToPath(new URL('./page.tsx', import.meta.url)), 'utf8');
    expect(page).toContain('checkoutSessionIdFromSearch');
    expect(page).toContain('fetchCheckoutSessionFacts');
    expect(page).toContain('googlePurchaseFromPaidSession');
    expect(page).toContain('metaPurchaseFromPaidSession');
    expect(page).not.toMatch(/search\.value|searchParams\.value/);
    expect(page).not.toMatch(/search\.currency|searchParams\.currency/);
  });
});

const NUMBER = '+15555550100';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15';
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const LOCALES = ['en', 'fr', 'zh'] as const;

type Locale = (typeof LOCALES)[number];

function stubFacts(view: unknown, over: Record<string, unknown> = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            transactionId: 'cs_test_state',
            value: 59,
            currency: 'CAD',
            paid: true,
            tier: 'plus',
            ...(view === undefined ? {} : { view }),
            ...over,
          }),
          { status: 200 },
        ),
    ),
  );
}

function pageInput(
  locale: Locale,
  search: Record<string, string> = { session_id: 'cs_test_state' },
) {
  return {
    params: Promise.resolve({ locale }),
    searchParams: Promise.resolve(search),
  };
}

async function renderPage(locale: Locale = 'en', search?: Record<string, string>) {
  return renderToStaticMarkup(await CheckoutSuccessPage(pageInput(locale, search)));
}

function mainOf(html: string): string {
  const start = html.indexOf('<main');
  const end = html.indexOf('</main>');
  if (start < 0 || end < 0) throw new Error('no <main> in the page');
  return html.slice(start, end);
}

function withUserAgent(ua: string) {
  vi.mocked(headers).mockResolvedValue(new Headers({ 'user-agent': ua }) as never);
}

function bundle(locale: Locale): Record<string, string> {
  const raw = readFileSync(
    fileURLToPath(new URL(`../../../../messages/${locale}.json`, import.meta.url)),
    'utf8',
  );
  return (JSON.parse(raw) as { CheckoutSuccess: Record<string, string> }).CheckoutSuccess;
}

describe('with the flag off', () => {
  it.each([
    ['en', 'You&#x27;re in.', 'Text Hale to start.'],
    ['fr', 'C’est fait.', 'Texte Hale pour commencer.'],
    ['zh', '已经完成。', '给 Hale 发条短信就能开始。'],
  ] as const)(
    '%s keeps today’s page, without the removed sentence',
    async (locale, heading, lede) => {
      vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', NUMBER);
      stubFacts({ state: 'receipt' });
      const main = mainOf(await renderPage(locale));
      expect(main).toContain(heading);
      expect(main).toContain(`<p class="sp-lede">${lede}</p>`);
      expect(main).toContain(`sms:${NUMBER}`);
      expect(main).not.toContain('text first');
      expect(main).not.toContain('premier');
      expect(main).not.toContain('先');
      expect(main).not.toContain(bundle(locale).receiptLede);
    },
  );
});

describe('with the flag on', () => {
  beforeEach(() => {
    vi.stubEnv('CHECKOUT_SUCCESS_STATES_ENABLED', 'true');
    vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', NUMBER);
  });

  describe('A: an existing family on its first paid plan', () => {
    it('says the plan and thanks the parent, with no name even if one is sent', async () => {
      withUserAgent(IPHONE);
      stubFacts({ state: 'plan_active', firstName: 'Riley', checkInDue: false });
      const main = mainOf(await renderPage());
      expect(main).toContain('<h1 class="sp-h1">You’re on Plus.</h1>');
      expect(main).toContain('Thanks. Keep texting Hale like you do now.');
      expect(main).not.toContain('Riley');
      expect(main).not.toContain('ph-no-capture');
      expect(main).toContain('Text Hale');
      expect(main).toContain('Open Hale');
      expect(main).not.toContain('Hale will check in');
    });

    it.each([
      ['Windows', DESKTOP],
      ['no user agent', null],
    ])('offers no Text Hale door on %s, where it would open the new-visitor page', async (_name, ua) => {
      if (ua) withUserAgent(ua);
      stubFacts({ state: 'plan_active', firstName: 'Riley', checkInDue: false });
      const main = mainOf(await renderPage());
      expect(main).toContain('Keep texting Hale like you do now.');
      expect(main).toContain('Open Hale');
      expect(main).not.toContain('Text Hale<');
      expect(main).not.toContain('checkout_success');
      expect(main).not.toContain('<svg');
    });

    it.each([
      ['iPhone', IPHONE],
      ['Android', ANDROID],
      ['Mac', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15'],
    ])('offers the Text Hale door on %s', async (_name, ua) => {
      withUserAgent(ua);
      stubFacts({ state: 'plan_active', firstName: 'Riley', checkInDue: false });
      const main = mainOf(await renderPage());
      expect(main).toContain('data-cta-placement="checkout_success"');
      expect(main).toContain('Text Hale');
    });

    it('names the plan from the verified tier', async () => {
      stubFacts({ state: 'plan_active', checkInDue: false }, { tier: 'family' });
      expect(mainOf(await renderPage())).toContain('You’re on Max.');
    });

    it('promises the check-in only with the site flag and hale-web agreeing', async () => {
      stubFacts({ state: 'plan_active', firstName: 'Riley', checkInDue: true });
      expect(mainOf(await renderPage())).not.toContain('Hale will check in');

      vi.stubEnv('BILLING_THREAD_NOTICES_ENABLED', 'true');
      stubFacts({ state: 'plan_active', firstName: 'Riley', checkInDue: false });
      expect(mainOf(await renderPage())).not.toContain('Hale will check in');

      stubFacts({ state: 'plan_active', firstName: 'Riley', checkInDue: true });
      expect(mainOf(await renderPage())).toContain(
        'Thanks. Keep texting Hale like you do now. Hale will check in with you in your thread shortly.',
      );
    });
  });

  it('B renders its final copy with the same buttons as A', async () => {
    withUserAgent(IPHONE);
    stubFacts({ state: 'upgraded' }, { tier: 'family' });
    const main = mainOf(await renderPage());
    expect(main).toContain('<h1 class="sp-h1">You’re on Max now.</h1>');
    expect(main).toContain(
      'You paid only the difference for the rest of your year. Everything carries over.',
    );
    expect(main).toContain('Text Hale');
    expect(main).toContain('Open Hale');
  });

  it('B offers no Text Hale door where it cannot open their thread', async () => {
    withUserAgent(DESKTOP);
    stubFacts({ state: 'upgraded' }, { tier: 'family' });
    const main = mainOf(await renderPage());
    expect(main).toContain('You’re on Max now.');
    expect(main).toContain('Open Hale');
    expect(main).not.toContain('checkout_success');
  });

  it('C renders its final copy with Open Hale alone', async () => {
    stubFacts({ state: 'already_on_plan' });
    const main = mainOf(await renderPage());
    expect(main).toContain('<h1 class="sp-h1">You’re already on Plus.</h1>');
    expect(main).toContain(
      'This payment won’t be kept. We’ll refund it in full within a few days.',
    );
    expect(main).toContain('Open Hale');
    expect(main).not.toContain('Text Hale');
  });

  describe('D and E: a new visitor', () => {
    it.each([
      ['iPhone', IPHONE],
      ['Android', ANDROID],
    ])('D on %s: Text Hale, the number, and no QR', async (_name, ua) => {
      withUserAgent(ua);
      stubFacts({ state: 'new_visitor' });
      const main = mainOf(await renderPage());
      expect(main).toContain('<h1 class="sp-h1">You&#x27;re in.</h1>');
      expect(main).toContain('<p class="sp-lede">Text Hale to start.</p>');
      expect(main).toContain('data-cta-placement="checkout_success"');
      expect(main).toContain('Hale’s number: (555) 555-0100');
      expect(main).toContain('Open Hale');
      expect(main).not.toContain('<svg');
    });

    it.each([
      ['a desktop browser', DESKTOP],
      ['no user agent', null],
    ])('E on %s: the QR, the number and the opener', async (_name, ua) => {
      if (ua) withUserAgent(ua);
      stubFacts({ state: 'new_visitor' });
      const main = mainOf(await renderPage());
      expect(main).toContain('<h1 class="sp-h1">You&#x27;re in.</h1>');
      expect(main).toContain('Text Hale from your phone to start.');
      expect(main).toContain('<svg');
      expect(main).toContain('Hale’s number: (555) 555-0100');
      expect(main).toContain('Hey Hale, what&#x27;s going on?');
      expect(main).toContain('Copy number');
      expect(main).toContain('Copy message');
      expect(main).toContain('data-cta-placement="checkout_success_opener"');
      expect(main).toContain('Open Hale');
    });

    it('hides the number and QR when no number is live', async () => {
      vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', '');
      withUserAgent(DESKTOP);
      stubFacts({ state: 'new_visitor' });
      const main = mainOf(await renderPage());
      expect(main).toContain('Text Hale from your phone to start.');
      expect(main).not.toContain('<svg');
      expect(main).not.toContain('Hale’s number');
      expect(main).toContain('Open Hale');
    });
  });

  it('F says the payment is going through, as a live status', async () => {
    stubFacts({ state: 'pending' });
    const main = mainOf(await renderPage());
    expect(main).toContain('<h1 class="sp-h1">Almost there.</h1>');
    expect(main).toContain(
      '<output class="sp-lede" style="display:block">Your payment is still going through. This page will update on its own.</output>',
    );
  });

  it('a purchase under review gets the slow line, with a way to reach us and no polling', async () => {
    stubFacts({ state: 'under_review' });
    const main = mainOf(await renderPage());
    expect(main).toContain('<h1 class="sp-h1">Almost there.</h1>');
    expect(main).toContain('It can take a few minutes. You’ll see it in Hale once it clears.');
    expect(main).toContain('Open Hale');
    expect(main).toContain('Email us');
    expect(main).toContain('href="mailto:aloha@villagehale.com"');
    expect(main).not.toContain('<output');
  });

  it('the neutral view names no plan and no person', async () => {
    stubFacts({ state: 'receipt', firstName: 'Riley' });
    const main = mainOf(await renderPage());
    expect(main).toContain('<h1 class="sp-h1">Checkout</h1>');
    expect(main).toContain('This checkout is finished. Open Hale to see your plan.');
    expect(main).toContain('Open Hale');
    expect(main).toContain('Email us');
    expect(main).not.toContain('Riley');
    expect(main).not.toContain('Plus');
    expect(main).not.toContain('<output');
  });

  describe('G: no finished payment', () => {
    it('says no charge only when Stripe confirmed it', async () => {
      stubFacts({ state: 'not_paid' }, { paid: false });
      const main = mainOf(await renderPage());
      expect(main).toContain('<h1 class="sp-h1">Checkout</h1>');
      expect(main).toContain('We couldn’t find a finished payment here. You haven’t been charged.');
      expect(main).toContain('See pricing');
      expect(main).toContain('href="/pricing"');
      expect(main).toContain('Email us');
    });

    it('says nothing about a charge when nobody knows', async () => {
      const assertNoClaim = (main: string) => {
        expect(main).toContain('We couldn’t find a finished payment here.');
        expect(main).not.toContain('charged');
        expect(main).toContain('See pricing');
        expect(main).toContain('Email us');
      };
      vi.stubGlobal('fetch', vi.fn());
      assertNoClaim(mainOf(await renderPage('en', {})));
      assertNoClaim(mainOf(await renderPage('en', { session_id: 'not-a-session' })));
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
      assertNoClaim(mainOf(await renderPage()));
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('{}', { status: 502 })),
      );
      assertNoClaim(mainOf(await renderPage()));
      stubFacts({ state: 'unknown' }, { paid: false });
      assertNoClaim(mainOf(await renderPage()));
    });
  });

  it('keeps paid sessions on today’s page when hale-web sends no view', async () => {
    stubFacts(undefined);
    const main = mainOf(await renderPage());
    expect(main).toContain('You&#x27;re in.');
    expect(main).toContain('You’re on Plus.');
    expect(main).toContain('Text Hale to start.');
  });

  it('reads nothing from the query string but the session id', async () => {
    stubFacts({ state: 'receipt' });
    const plain = await renderPage();
    const crafted = await renderPage('en', {
      session_id: 'cs_test_state',
      tier: 'family',
      plan: 'max',
      firstName: 'Evil',
      familyId: 'x',
      state: 'plan_active',
    });
    expect(crafted).toBe(plain);
    expect(crafted).not.toContain('Evil');
  });

  it('shows a name carried on any state but A nowhere', async () => {
    for (const state of [
      'upgraded',
      'already_on_plan',
      'new_visitor',
      'pending',
      'under_review',
      'receipt',
      'not_paid',
      'unknown',
    ]) {
      stubFacts({ state, firstName: 'Riley', checkInDue: true });
      expect(mainOf(await renderPage()), state).not.toContain('Riley');
    }
  });

  it('never puts a composer link in the server HTML, in any state', async () => {
    for (const ua of [IPHONE, ANDROID, DESKTOP]) {
      withUserAgent(ua);
      for (const view of [
        { state: 'plan_active', firstName: 'Riley', checkInDue: false },
        { state: 'upgraded' },
        { state: 'new_visitor' },
      ]) {
        stubFacts(view);
        const html = await renderPage();
        expect(html).not.toContain('href="sms:');
        if (ua !== DESKTOP) {
          expect(mainOf(html)).toMatch(
            /<a href="\/text"[^>]*data-cta-placement="checkout_success"/,
          );
        }
      }
    }
  });

  it('titles the tab as a purchase only where one is confirmed', async () => {
    const titleFor = async (view: unknown, over: Record<string, unknown> = {}) => {
      stubFacts(view, over);
      return (await generateMetadata(pageInput('en'))).title;
    };
    expect(await titleFor({ state: 'plan_active' })).toBe("You're in · Hale");
    expect(await titleFor({ state: 'upgraded' })).toBe("You're in · Hale");
    expect(await titleFor({ state: 'new_visitor' })).toBe("You're in · Hale");
    for (const state of [
      'already_on_plan',
      'pending',
      'under_review',
      'receipt',
      'not_paid',
      'unknown',
    ]) {
      expect(await titleFor({ state })).toBe('Checkout · Hale');
    }
  });

  it.each(LOCALES)('%s renders every state without a missing key', async (locale) => {
    withUserAgent(DESKTOP);
    for (const view of [
      { state: 'plan_active', firstName: 'Riley', checkInDue: true },
      { state: 'upgraded' },
      { state: 'already_on_plan' },
      { state: 'new_visitor' },
      { state: 'pending' },
      { state: 'under_review' },
      { state: 'receipt' },
      { state: 'not_paid' },
      { state: 'unknown' },
    ]) {
      stubFacts(view);
      const main = mainOf(await renderPage(locale));
      expect(main, view.state).not.toContain('CheckoutSuccess.');
      expect(main, view.state).not.toContain('undefined');
    }
  });
});

describe('the CheckoutSuccess copy', () => {
  it('has the same keys in every language', () => {
    const keys = Object.keys(bundle('en')).sort();
    expect(keys.length).toBeGreaterThan(20);
    expect(Object.keys(bundle('fr')).sort()).toEqual(keys);
    expect(Object.keys(bundle('zh')).sort()).toEqual(keys);
  });

  it('never says founding, first or early, in any language', () => {
    const banned: Record<Locale, RegExp> = {
      en: /founding|first|early/i,
      fr: /fondateur|fondatrice|premier|première|tôt/i,
      zh: /创始|先|早/,
    };
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(bundle(locale))) {
        expect(value, `${locale}.${key}`).not.toMatch(banned[locale]);
      }
    }
  });
});
