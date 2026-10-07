import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LandingPage from './[locale]/page.js';

/**
 * villagehale.com — the English homepage is the approved redesign.
 * French and Chinese still render the v4 landing; those pins live in
 * landing-locales.test.ts. What stays true here: no signup funnel, no
 * readable phone number, the chooser owns the homepage doors, and the
 * outward copy is the final design.
 */

const LIVE_NUMBER = '+16475551234';

async function renderLanding(number: string): Promise<string> {
  vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', number);
  const html = renderToStaticMarkup(
    await LandingPage({ params: Promise.resolve({ locale: 'en' as const }) }),
  );
  vi.unstubAllEnvs();
  return html;
}

const LIVE_HTML = await renderLanding(LIVE_NUMBER);
const EMPTY_HTML = await renderLanding('');

function render({ number = LIVE_NUMBER }: { number?: string } = {}): string {
  return number === '' ? EMPTY_HTML : LIVE_HTML;
}

function visibleText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('landing — the redesign hero', () => {
  const html = render();
  const text = visibleText(html);

  it('opens on the shore, with one H1 at the approved sizes', () => {
    expect(html).toContain('class="stage"');
    expect(html).toContain('shore-art');
    expect([...html.matchAll(/<h1[\s>]/g)]).toHaveLength(1);
    expect(html).toContain('Your kids’ year,<br/>handled.');
    const css = readFileSync(fileURLToPath(new URL('./redesign.css', import.meta.url)), 'utf8');
    expect(css).toMatch(/\.rd h1 \{[^}]*font-size: 84px;/);
    expect(css).toContain('.rd h1 { font-size: 54px;');
  });

  it('shows Library playgroup on the hero calendar', () => {
    expect(text).toContain('Library playgroup');
    expect(text).not.toContain('EarlyON');
  });

  it('keeps the homepage doors on the chooser, never a composer', () => {
    expect(html).not.toContain('href="sms:');
    expect(html).toContain('data-cta="cta_message_click"');
    for (const placement of ['header', 'hero', 'closing', 'home_pricing']) {
      expect(html).toContain(`data-cta-placement="${placement}"`);
    }
  });

  it('never prints the digits, in any grouping', () => {
    const digits = LIVE_NUMBER.replace(/\D/g, '');
    expect(text).not.toContain(digits);
    expect(html).not.toContain(LIVE_NUMBER);
  });

  it('states the founding offer without a countdown', () => {
    expect(text).toContain('Founding families join free.');
    expect(text).toContain('Only Free is available today.');
    expect(text).not.toMatch(/only \d+ (spots|left)|hurry|limited time/i);
  });

  it('says Hale does not register yet, and drops place names outside the design', () => {
    expect(text).toContain('Not yet.');
    expect(text).toContain('You register yourself.');
    for (const banned of ['GTA', 'Georgetown', 'Stouffville', 'Your data stays in Canada']) {
      expect(text).not.toContain(banned);
    }
  });
});

describe('landing — no signup funnel', () => {
  it('has no web signup funnel anywhere', () => {
    const html = render();
    expect(html).not.toContain('/onboarding');
    expect(html).not.toContain('Get started');
  });

  it('offers Sign in only as the chrome’s quiet door', () => {
    const html = render();
    expect(html).toContain('href="https://app.villagehale.com/sign-in"');
    expect(html).not.toContain('btn-primary">Sign in');
  });
});

describe('landing — structured data and the empty number', () => {
  it('emits its own JSON-LD graph', () => {
    expect(render()).toContain('application/ld+json');
    expect(render()).toContain('SoftwareApplication');
  });

  it('never renders a dead sms: link, and the header falls back to email', () => {
    const html = render({ number: '' });
    expect(html).not.toContain('href="sms:');
    expect(html).toContain('href="mailto:aloha@villagehale.com"');
    expect(html).toContain('Library playgroup');
  });
});
