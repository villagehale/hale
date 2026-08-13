import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import config from '~/next.config';
import { MARKETING_SITE_URL } from '~/lib/legal-links';

/**
 * /onboarding is retired (F14). Not hidden behind a flag — DELETED, because the web
 * wizard's whole output was a family with no phone number, and Hale cannot run a week
 * for a family it cannot text. Every front door must now produce a reachable family,
 * and the only one that does is the text conversation.
 *
 * What replaces it is a PERMANENT redirect rather than a 404, and that is the point of
 * this file: the dark marketing site's "Get started" buttons, already-sent emails, and
 * a year of bookmarks all still point at /onboarding. None of those can be rewritten
 * after the fact, so the forward is kept forever — the same reasoning (and the same
 * next.config seam) as the /terms and /privacy forwards D20 left behind.
 */

function webPath(rel: string): string {
  return fileURLToPath(new URL(`../../${rel}`, import.meta.url));
}

async function redirects() {
  if (typeof config.redirects !== 'function') throw new Error('next.config has no redirects()');
  return config.redirects();
}

describe('the /onboarding surface is gone', () => {
  it.each([
    'app/onboarding/page.tsx',
    'app/onboarding/wizard.tsx',
    'app/api/onboarding/city-search/route.ts',
    'components/hale/onboarding-shell.tsx',
    'components/hale/onboarding-connect.tsx',
    'components/hale/onboarding-location-map.tsx',
    'components/hale/city-autocomplete-input.tsx',
    'lib/onboarding/intake-storage.ts',
    'lib/onboarding/steps.ts',
    'lib/onboarding/resume.ts',
    'lib/onboarding/sign-in-action.ts',
    'lib/onboarding/complete-onboarding-copy.ts',
    'lib/onboarding/invite-gate.ts',
  ])('%s no longer exists', (rel) => {
    expect(existsSync(webPath(rel))).toBe(false);
  });

  it.each([
    // Provisioning, reached by the SMS intake and the family editor — the wizard was
    // one caller of these, never their owner. Deleting them would delete the product.
    'lib/onboarding/complete-onboarding.ts',
    'lib/onboarding/persist.ts',
    'lib/onboarding/children.ts',
    'lib/onboarding/founding.ts',
    'lib/onboarding/trigger-discovery.ts',
    'lib/onboarding/welcome-email.ts',
    'lib/onboarding/send-welcome.ts',
    // Still read by live surfaces: the village map, and the area switcher's city
    // lookup.
    'lib/onboarding/load-places.ts',
    'lib/onboarding/city-search.ts',
  ])('%s survives — it was never the wizard’s', (rel) => {
    expect(existsSync(webPath(rel))).toBe(true);
  });
});

describe('every /onboarding URL forwards, permanently, off the app', () => {
  it('forwards the bare route and everything under it', async () => {
    const rules = await redirects();
    const sources = rules.map((r) => r.source);

    expect(sources).toContain('/onboarding');
    expect(sources).toContain('/onboarding/:path*');
  });

  it('lands on the marketing site, permanently (308), so old links never 404', async () => {
    const rules = await redirects();
    for (const rule of rules.filter((r) => r.source.startsWith('/onboarding'))) {
      expect(rule.destination).toBe(MARKETING_SITE_URL);
      expect(rule.permanent).toBe(true);
    }
  });

  it('leaves the /terms and /privacy forwards alone', async () => {
    const sources = (await redirects()).map((r) => r.source);
    expect(sources).toContain('/terms');
    expect(sources).toContain('/privacy');
  });
});

describe('nothing inside apps/web still points at the wizard', () => {
  it('no source file links, redirects, or hands off to /onboarding', async () => {
    const { spawnSync } = await import('node:child_process');
    // Comments may still narrate the history; a LINK, a REDIRECT or a post-auth
    // destination may not — those are the three shapes that would strand a parent on
    // a route that no longer exists.
    const found = spawnSync(
      'grep',
      [
        '-rEn',
        String.raw`(href=["'\`]/onboarding|redirect\(['"\`]/onboarding|redirectTo: ['"\`]/onboarding|callbackUrl=/onboarding)`,
        webPath(''),
        '--include=*.ts',
        '--include=*.tsx',
        '--exclude-dir=node_modules',
        '--exclude-dir=.next',
      ],
      { encoding: 'utf8' },
    );
    // grep exits 1 with empty stdout when there is nothing left to find — the pass.
    // Test files are excluded because asserting the ABSENCE of these strings is how
    // several suites (this one included) pin the retirement.
    const hits = found.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .filter((line) => !/\.test\.tsx?:/.test(line));
    expect(hits).toEqual([]);
  });
});
