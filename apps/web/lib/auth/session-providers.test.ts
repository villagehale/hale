import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Portal sessions are phone code and the texted /connect link. Google sign-in,
 * email/password, and magic-link are not providers. Gmail and Calendar consent
 * is a separate OAuth flow (lib/integrations/google-oauth.ts) and must not be
 * registered here. The assertion reads the source: importing ~/auth pulls
 * next-auth, which this Vitest setup cannot resolve.
 */
const WEB_ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');

function read(rel: string): string {
  return readFileSync(`${WEB_ROOT}/${rel}`, 'utf8');
}

describe('Auth.js session providers', () => {
  const authTs = read('auth.ts');
  const authConfigTs = read('auth.config.ts');

  it('lists only the phone door and the texted connect link', () => {
    expect(authConfigTs).toContain('providers: []');
    expect(authTs).toContain('export const sessionProviders = [claimPhone, channelLink]');
    expect(authTs).toContain('providers: [...authConfig.providers, ...sessionProviders]');

    const ids = [...authTs.matchAll(/id: '([^']+)'/g)].map((match) => match[1]);
    expect(ids).toEqual(['claim-phone', 'channel-link']);
  });

  it('does not register a Google sign-in provider', () => {
    for (const source of [authTs, authConfigTs]) {
      expect(source).not.toContain("from 'next-auth/providers/google'");
      expect(source).not.toMatch(/\bGoogle\(/);
    }
    expect(authTs).not.toContain("from '~/lib/integrations/google-oauth'");
  });
});
