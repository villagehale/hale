import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LandingPage from './[locale]/page.js';

async function render(number = '+16475551234') {
  vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', number);
  return renderToStaticMarkup(await LandingPage({ params: Promise.resolve({ locale: 'en' }) }));
}
const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
afterEach(() => vi.unstubAllEnvs());

describe('October 2026 supplied landing', () => {
  it('keeps one locked H1 and the supplied calendar/group conversation proof', async () => {
    const html = await render();
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(textOf(html.match(/<h1>[\s\S]*?<\/h1>/)?.[0] ?? '')).toBe('Your kids’ year, handled.');
    expect(html).toContain('Example: a family calendar filled in by Hale');
    expect(html).toContain('Your kids’ plans already live in group chats.');
    expect(html).toContain('href="#group-chats"');
    expect(html).not.toMatch(/onboarding|#waitlist|redo-message-event/);
  });

  it('keeps the product story, shared chrome and Canadian privacy', async () => {
    const html = await render();
    const text = textOf(html);
    for (const copy of [
      'Finds activities',
      'Watches for spots',
      'Reminds you',
      'Asks how it went',
      'co-parent',
      'stays in Canada',
      '/HAH-leh/',
    ])
      expect(text).toContain(copy);
    expect(html).toContain('href="/privacy"');
    expect(html.match(/<header class="site-header"/g)).toHaveLength(1);
    expect(html.match(/<footer\b/g)).toHaveLength(1);
    expect(text).not.toMatch(
      /Never miss it|never books|does not book|More to come|Across 21 municipalities/,
    );
  });

  it('keeps paid sign-ups unavailable today and only one active pricing door', async () => {
    const html = await render();
    const pricing = html.match(/<section[^>]*id="pricing"[\s\S]*?<\/section>/)?.[0] ?? '';
    expect(pricing).toContain('Priority support');
    expect(pricing).toContain('Sign-ups done for you, when you say yes');
    expect(pricing.match(/<button[^>]*disabled/g)).toHaveLength(2);
    expect(pricing.match(/href="\/text"/g)).toHaveLength(1);
    expect(pricing).toContain('Only Free is available today.');
    expect(html).not.toMatch(/href="sms:|href="[^\"]*(?:checkout|onboarding)/);
    expect(textOf(html)).not.toContain('6475551234');
  });

  it('has a working email fallback with no configured texting number', async () => {
    const html = await render('');
    expect(html).toContain('mailto:aloha@villagehale.com');
    expect(html).not.toContain('href="sms:');
    expect(html).not.toContain('href="/text"');
  });
});
