import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCronSkill } from '~/lib/cron/skill';
import { authorizedSignupEnabled } from './flag';
import {
  OFFER_SIGNUP_TOOL,
  augmentCoachSkillForSignupOffer,
  planOpensAtFromModel,
  quotesParent,
  signupAtOpenEnabled,
  signupOfferToolEnabled,
  urlSeenThisTurn,
} from './offer-tool';

describe('offer_signup tool guards', () => {
  it('takes an open time only with its zone', () => {
    expect(planOpensAtFromModel('2026-12-01T19:00:00-05:00')?.toISOString()).toBe(
      '2026-12-02T00:00:00.000Z',
    );
    expect(planOpensAtFromModel('2026-12-01T19:00Z')?.toISOString()).toBe(
      '2026-12-01T19:00:00.000Z',
    );
    for (const raw of ['2026-12-01T19:00:00', 'Dec 1 at 7pm', '2026-13-45T19:00:00Z', null]) {
      expect(planOpensAtFromModel(raw)).toBeNull();
    }
  });

  it('accepts a URL Hale already saw this turn, not one the model invented', () => {
    const href = 'https://harbor-rec.example/register';
    expect(urlSeenThisTurn(href, `can you try ${href}`, [])).toBe(href);
    expect(urlSeenThisTurn(href, 'can you try this class', [{ url: href }])).toBe(href);
    expect(urlSeenThisTurn(href, 'can you try this class', [])).toBeNull();
    expect(urlSeenThisTurn('javascript:alert(1)', 'javascript:alert(1)', [])).toBeNull();
  });

  it('matches the whole URL the parent typed, never a prefix of it', () => {
    const href = 'https://cityrec.example/swim';
    // A sentence's own punctuation around the link is not part of it.
    expect(urlSeenThisTurn(href, `sign Ada up: ${href}.`, [])).toBe(href);
    expect(urlSeenThisTurn(href, `(it's ${href})`, [])).toBe(href);
    expect(urlSeenThisTurn(href, `sign Ada up at ${href.replace('cityrec', 'CityRec')}`, [])).toBe(
      href,
    );
    for (const typed of [`${href}-fall`, `${href}?term=fall`, `${href}/level-2`]) {
      expect(urlSeenThisTurn(href, `sign Ada up at ${typed}`, []), typed).toBeNull();
    }
    expect(urlSeenThisTurn('https://cityrec.example/sw', `sign Ada up at ${href}`, [])).toBeNull();
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
    expect(augmentCoachSkillForSignupOffer(skill, false, null)).toBe(skill);
    expect(augmentCoachSkillForSignupOffer(skill, true, null)).toEqual({
      ...skill,
      meta: { ...skill.meta, tools: [OFFER_SIGNUP_TOOL] },
    });
  });

  it('says Hale can register at the open only while the plan lane is lit', () => {
    expect(
      signupAtOpenEnabled({
        AUTHORIZED_SIGNUP_ENABLED: 'on',
        REGISTRATION_PLAN_RUN_ENABLED: 'true',
      }),
    ).toBe(true);
    expect(signupAtOpenEnabled({ AUTHORIZED_SIGNUP_ENABLED: 'on' })).toBe(false);
    expect(signupAtOpenEnabled({ REGISTRATION_PLAN_RUN_ENABLED: 'true' })).toBe(false);
    // The lane's own readers decide, so a value either one refuses is refused here too.
    expect(
      signupAtOpenEnabled({ AUTHORIZED_SIGNUP_ENABLED: 'on', REGISTRATION_PLAN_RUN_ENABLED: 'on' }),
    ).toBe(false);

    const skill = {
      instructions: 'coach',
      meta: { name: 'coach-channel-sms', whenToUse: 'x', task: 'converse' as const, tools: [] },
    };
    const atOpen = {
      instructions: 'can register at the open',
      meta: { name: 'coach-signup-offer', whenToUse: 'x', task: 'converse' as const, tools: [] },
    };
    expect(augmentCoachSkillForSignupOffer(skill, true, atOpen)).toEqual({
      instructions: 'coach\n\ncan register at the open',
      meta: { ...skill.meta, tools: [OFFER_SIGNUP_TOOL] },
    });
    // No verb, no addendum: the skill never describes a tool the turn cannot call.
    expect(augmentCoachSkillForSignupOffer(skill, false, atOpen)).toBe(skill);
  });

  it('ships the addendum the runtime appends, naming the verb it describes', async () => {
    const addendum = await loadCronSkill('coach-signup-offer');
    expect(addendum.meta.name).toBe('coach-signup-offer');
    expect(addendum.instructions).toContain(`\`${OFFER_SIGNUP_TOOL}\``);
    expect(addendum.instructions).toContain('`replaced`');
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
    expect(runtime).toContain('signupAtOpenEnabled');
    expect(runtime).toContain("loadCronSkill('coach-signup-offer')");
    expect(runtime).toContain('signupOffer:');
  });
});
