import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { referralLink } from './code';
import {
  MAX_FORWARD_CHARS,
  type ReferralShare,
  forwardViolations,
  referralBlock,
  shareReferralLinkTool,
} from './share';

const KEY = Buffer.alloc(32, 5).toString('base64');
const FAMILY = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

/** A line that should sail through, so every refusal below is measured against a
 * positive control through the same function rather than against nothing. */
const GOOD_FORWARD =
  "It's a text line that keeps the family week straight - registrations, plans, the stuff that slips.";

describe('forwardViolations', () => {
  it('accepts a plain forwardable line', () => {
    expect(forwardViolations(GOOD_FORWARD)).toEqual([]);
  });

  it('refuses a line with no words in it', () => {
    expect(forwardViolations('   ')).toEqual(['The line was empty.']);
  });

  it('refuses a composed URL — the real link is appended, so any URL here is invented', () => {
    for (const bad of [
      'Try Hale: https://www.villagehale.com/text?s=friend-0123456789ab',
      'Try Hale at villagehale.com',
      'Sign up at https://hale.example',
      'Have a look at www.somewhere.ca',
    ]) {
      expect(forwardViolations(bad).join(' ')).toMatch(/contains a link/);
    }
  });

  it('refuses THE live fabrication: a line pointing at an app, an account or settings', () => {
    // 2026-08-15 — "Referral links live in your account settings in the app." Every
    // noun in that sentence is refused here, in code, not discouraged in prose.
    for (const bad of [
      'Download the app and you get a referral bonus',
      'Check your account settings for the code',
      'Make an account and mention my name',
      'Their dashboard has the invite link',
      'Find it on the website',
      'Download it and mention my name',
    ]) {
      expect(forwardViolations(bad).join(' ')).toMatch(/points at an app, a website or an account/);
    }
  });

  it('does not refuse ordinary words that merely contain the forbidden ones', () => {
    // `\b` on "app" would otherwise eat "happens" and "appointments" — the words a
    // sentence about a family calendar is most likely to use.
    expect(
      forwardViolations('It happens to catch appointments and sign-up dates before they close.'),
    ).toEqual([]);
  });

  it('refuses characters that halve the SMS budget', () => {
    expect(forwardViolations('It keeps the week straight — quietly').join(' ')).toMatch(
      /doubles the cost to send/,
    );
  });

  it('refuses a line too long to leave the link room beside it', () => {
    const long = `${'a'.repeat(MAX_FORWARD_CHARS + 1)}`;
    expect(forwardViolations(long).join(' ')).toMatch(
      new RegExp(`at most ${MAX_FORWARD_CHARS}`),
    );
  });
});

describe('referralBlock', () => {
  it('puts the link last, where a phone will linkify it', () => {
    const share: ReferralShare = { forward: 'It keeps the week straight.', link: 'https://x/y' };
    expect(referralBlock(share)).toBe('It keeps the week straight. https://x/y');
  });
});

describe('shareReferralLinkTool', () => {
  const prev = process.env.APP_ENCRYPTION_KEY;
  beforeEach(() => {
    process.env.APP_ENCRYPTION_KEY = KEY;
  });
  afterEach(() => {
    process.env.APP_ENCRYPTION_KEY = prev;
  });

  const build = () => {
    const shared: ReferralShare[] = [];
    return { shared, tool: shareReferralLinkTool(FAMILY, (share) => shared.push(share)) };
  };

  it('registers THIS family’s link — the model supplies the words, never the URL', async () => {
    const { shared, tool } = build();

    const result = await tool.handler({ forward: GOOD_FORWARD }, {} as never);

    expect(result).toEqual({ shared: true });
    expect(shared).toEqual([{ forward: GOOD_FORWARD, link: referralLink(FAMILY) }]);
  });

  it('drops a phone number handed to it (CASL: Hale never texts the friend first)', () => {
    const { tool } = build();
    // The schema is the guarantee, and this is it exercised: a number does not reach the
    // handler even when one is supplied. There is no argument through which this turn
    // could acquire a recipient, so there is no turn on which it could send to one.
    expect(tool.inputSchema.parse({ forward: GOOD_FORWARD, to: '+15195551234' })).toEqual({
      forward: GOOD_FORWARD,
    });
  });

  it('registers NOTHING when the line is refused, and says how to fix it', async () => {
    const { shared, tool } = build();

    await expect(
      tool.handler({ forward: 'Referral links live in your account settings in the app.' }, {} as never),
    ).rejects.toThrow(/Call share_referral_link again/);
    expect(shared).toEqual([]);
  });
});
