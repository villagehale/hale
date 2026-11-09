import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { authorizedSignupEnabled } from './flag';
import {
  OFFER_SIGNUP_TOOL,
  augmentCoachSkillForSignupOffer,
  quotesParent,
  signupOfferToolEnabled,
  urlSeenThisTurn,
} from './offer-tool';

describe('offer_signup tool guards', () => {
  it('accepts a URL Hale already saw this turn, not one the model invented', () => {
    const href = 'https://harbor-rec.example/register';
    expect(urlSeenThisTurn(href, `can you try ${href}`, [])).toBe(href);
    expect(urlSeenThisTurn(href, 'can you try this class', [{ url: href }])).toBe(href);
    expect(urlSeenThisTurn(href, 'can you try this class', [])).toBeNull();
    expect(urlSeenThisTurn('javascript:alert(1)', 'javascript:alert(1)', [])).toBeNull();
  });

  it('requires chat evidence to be a quote, without a word list', () => {
    expect(quotesParent('the flyer says Tuesday swim at the rec', 'Tuesday swim at the rec')).toBe(
      true,
    );
    expect(quotesParent('the flyer says Tuesday swim at the rec', 'sign us up')).toBe(false);
  });

  it('stays off the coach allowlist until the signup flag is exactly on', () => {
    expect(signupOfferToolEnabled({ AUTHORIZED_SIGNUP_ENABLED: 'on' })).toBe(true);
    expect(signupOfferToolEnabled({ AUTHORIZED_SIGNUP_ENABLED: 'true' })).toBe(false);
    expect(authorizedSignupEnabled({})).toBe(false);
    const skill = {
      instructions: '',
      meta: { name: 'coach-channel-sms', whenToUse: 'x', task: 'converse' as const, tools: [] },
    };
    expect(augmentCoachSkillForSignupOffer(skill, false)).toBe(skill);
    expect(augmentCoachSkillForSignupOffer(skill, true).meta.tools).toEqual([OFFER_SIGNUP_TOOL]);
  });

  it('is the production caller of offerSignupFromFacts', () => {
    const source = readFileSync(fileURLToPath(new URL('./offer-tool.ts', import.meta.url)), 'utf8');
    expect(source).toContain('offerSignupFromFacts');
    expect(source).not.toContain('signupTryOffer');
    const tools = readFileSync(
      fileURLToPath(new URL('../channel/coach/tools.ts', import.meta.url)),
      'utf8',
    );
    expect(tools).toContain('offerSignupTool');
    const runtime = readFileSync(
      fileURLToPath(new URL('../channel/coach/runtime.ts', import.meta.url)),
      'utf8',
    );
    expect(runtime).toContain('signupOfferToolEnabled');
    expect(runtime).toContain('signupOffer:');
  });
});
