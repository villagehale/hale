import { createRequire } from 'node:module';
import type { PageSnapshot, SignupBrowser, SignupPage } from './types';
import { registrationUrlAllowed } from './url';

interface EvalPage {
  url(): string;
  goto(url: string, options: { waitUntil: 'domcontentloaded'; timeout: number }): Promise<unknown>;
  locator(selector: string): {
    fill(value: string): Promise<void>;
    selectOption(value: string): Promise<unknown>;
    first(): { click(): Promise<void> };
  };
  evaluate<T>(fn: () => T): Promise<T>;
  waitForSelector(selector: string, options: { timeout: number }): Promise<unknown>;
}

interface Launched {
  newContext(): Promise<{ newPage(): Promise<EvalPage> }>;
  close(): Promise<void>;
}

interface ChromiumLike {
  launch(options: { headless: boolean; args: string[] }): Promise<Launched>;
}

/**
 * The sandboxed headless browser. Playwright is the one already in this repo.
 * If it is not installed in the runtime, the caller gets null and hands back
 * `browser_unavailable` instead of pretending the form was submitted.
 */
export async function playwrightSignupBrowser(): Promise<SignupBrowser | null> {
  const chromium = loadChromium();
  if (!chromium) return null;
  return {
    async open(url: string): Promise<SignupPage> {
      const allowed = registrationUrlAllowed(url);
      if (!allowed.ok) throw new Error('url_refused');
      const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
      });
      try {
        const page = await (await browser.newContext()).newPage();
        await page.goto(allowed.href, { waitUntil: 'domcontentloaded', timeout: 15_000 });
        return new PlaywrightSignupPage(browser, page);
      } catch (err) {
        await browser.close();
        throw err;
      }
    },
  };
}

function loadChromium(): ChromiumLike | null {
  try {
    const require = createRequire(import.meta.url);
    const mod = require('@playwright/test') as { chromium?: ChromiumLike };
    return mod.chromium ?? null;
  } catch {
    return null;
  }
}

class PlaywrightSignupPage implements SignupPage {
  constructor(
    private readonly browser: Launched,
    private readonly page: EvalPage,
  ) {}

  snapshot(): Promise<PageSnapshot> {
    return readSnapshot(this.page);
  }

  async fill(name: string, value: string): Promise<void> {
    await this.page.locator(byName(name)).fill(value);
  }

  async select(name: string, value: string): Promise<void> {
    await this.page.locator(byName(name)).selectOption(value);
  }

  async submit(): Promise<void> {
    await this.page.locator('button[type="submit"], input[type="submit"]').first().click();
    await this.page
      .waitForSelector('[data-signup-status="confirmed"]', { timeout: 10_000 })
      .catch(() => undefined);
  }

  async close(): Promise<void> {
    await this.browser.close();
  }
}

function byName(name: string): string {
  return `[name="${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
}

async function readSnapshot(page: EvalPage): Promise<PageSnapshot> {
  return page.evaluate(() => {
    const text = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
    const controls = Array.from(document.querySelectorAll('input, select, textarea')).map(
      (node) => {
        const el = node as HTMLInputElement;
        const explicit = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
        const label = text(explicit?.textContent ?? el.closest('label')?.textContent);
        const options =
          el instanceof HTMLSelectElement
            ? Array.from(el.options)
                .filter((option) => option.value.length > 0)
                .map((option) => ({
                  value: option.value,
                  label: text(option.label),
                  disabled: option.disabled,
                }))
            : [];
        return {
          name: el.name || '',
          type: (el.getAttribute('type') || el.tagName).toLowerCase(),
          required: el.required,
          label,
          autocomplete: el.getAttribute('autocomplete'),
          options,
        };
      },
    );
    const marked = document.querySelector('[data-price-cents]')?.getAttribute('data-price-cents');
    const fromAttr = marked && /^\d+$/.test(marked) ? [Number(marked)] : [];
    const fromText = Array.from(
      (document.body?.innerText ?? '').matchAll(/\$\s*(\d+)(?:\.(\d{2}))?/g),
    ).map((match) => Number(match[1]) * 100 + (match[2] ? Number(match[2]) : 0));
    const captcha =
      document.querySelector(
        'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], .g-recaptcha, .h-captcha, [data-sitekey]',
      ) !== null;
    return {
      href: location.href,
      controls,
      priceCents: Array.from(new Set([...fromAttr, ...fromText])),
      captcha,
      confirmed: document.querySelector('[data-signup-status="confirmed"]') !== null,
    };
  });
}
