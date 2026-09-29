import { describe, expect, it, vi } from 'vitest';
import { paymentLinkUrlForFamily } from './payment-link.js';
import { stripeCheckoutClientFromEnv } from './stripe-client.js';
import {
  decideUpgradeAsk,
  imessageUpgradeAskEnabled,
  upgradePaymentUrl,
  yearRetentionReply,
} from './upgrade-ask.js';
import { YEAR_RETENTION_COPY } from './upgrade-copy.js';

/**
 * ENG-1 — free at the door, a later iMessage ask, a link only on yes.
 *
 * The decision is pure so the flag, the onboard gate, and the "never open a
 * 1:1 just to collect money" rule are visible without a database or Stripe.
 */

const GROUP = 'chat-group';
const DIRECT = 'chat-1-1';

function ready(overrides: Partial<Parameters<typeof decideUpgradeAsk>[0]> = {}) {
  return decideUpgradeAsk({
    flagOn: true,
    channel: 'imessage',
    parentChatId: DIRECT,
    onboardingStage: 'sms_active',
    planTier: 'free',
    priorUtilityReplies: 1,
    offerStatus: null,
    groupChatId: GROUP,
    ...overrides,
  });
}

describe('decideUpgradeAsk', () => {
  it('stays silent when the flag is off, even if every other gate is open', () => {
    expect(ready({ flagOn: false })).toEqual({ action: 'skip', reason: 'flag_off' });
  });

  it('does not ask during onboard or the first hello', () => {
    for (const onboardingStage of [
      'pending_invite',
      'profile_setup',
      'integrations_connect',
      'sms_intake',
    ]) {
      expect(ready({ onboardingStage, groupChatId: null })).toEqual({
        action: 'skip',
        reason: 'onboard',
      });
    }
    expect(ready({ priorUtilityReplies: 0 })).toEqual({ action: 'skip', reason: 'not_yet' });
  });

  it('does not ask a family that is already paid, or ask twice', () => {
    expect(ready({ planTier: 'plus' })).toEqual({ action: 'skip', reason: 'already_paid' });
    expect(ready({ planTier: 'family' })).toEqual({ action: 'skip', reason: 'already_paid' });
    expect(ready({ offerStatus: 'asked' })).toEqual({ action: 'skip', reason: 'already_offered' });
    expect(ready({ offerStatus: 'declined' })).toEqual({
      action: 'skip',
      reason: 'already_offered',
    });
    expect(ready({ offerStatus: 'link_sent' })).toEqual({
      action: 'skip',
      reason: 'already_offered',
    });
  });

  it('prefers the co-parent group when one exists', () => {
    expect(ready()).toEqual({ action: 'ask', channel: 'group', chatId: GROUP });
  });

  it('replies in the 1:1 the parent already opened when there is no group', () => {
    expect(ready({ groupChatId: null })).toEqual({
      action: 'ask',
      channel: 'direct',
      chatId: DIRECT,
    });
  });

  it('never opens a 1:1 solely to ask for money', () => {
    expect(ready({ groupChatId: null, parentChatId: null })).toEqual({
      action: 'skip',
      reason: 'would_initiate_1_1',
    });
    expect(ready({ channel: 'sms', groupChatId: null })).toEqual({
      action: 'skip',
      reason: 'not_imessage',
    });
  });

  it('may ask once the family is past the door on the free plan', () => {
    for (const onboardingStage of [
      'sms_active',
      'observation_mode',
      'drafts_mode',
      'autonomous_mode',
    ]) {
      expect(ready({ onboardingStage }).action).toBe('ask');
    }
  });
});

describe('yearRetentionReply', () => {
  it('sends the payment url only on yes', () => {
    const url = 'https://buy.stripe.com/test_year?client_reference_id=fam-1';
    const yes = yearRetentionReply({ polarity: 'yes', paymentUrl: url });
    expect(yes.nextStatus).toBe('link_sent');
    expect(yes.templateKey).toBe('linq:upgrade_link');
    expect(yes.reply).toContain(url);
    expect(yes.reply.toLowerCase()).toContain('year');

    const no = yearRetentionReply({ polarity: 'no', paymentUrl: url });
    expect(no.nextStatus).toBe('declined');
    expect(no.reply).not.toContain(url);
    expect(no.reply).not.toContain('buy.stripe.com');
  });

  it('does not invent a link when Stripe is not configured', () => {
    const pending = yearRetentionReply({ polarity: 'yes', paymentUrl: null });
    expect(pending.nextStatus).toBe('asked');
    expect(pending.templateKey).toBe('linq:upgrade_pending');
    expect(pending.reply).toBe(YEAR_RETENTION_COPY.notReady);
    expect(pending.reply).not.toMatch(/https?:\/\//);
  });
});

describe('year retention copy', () => {
  it('is framed as keeping the year, and lives in one module', () => {
    const blob = [
      YEAR_RETENTION_COPY.ask,
      YEAR_RETENTION_COPY.link('https://buy.stripe.com/test_x'),
      YEAR_RETENTION_COPY.declined,
      YEAR_RETENTION_COPY.notReady,
      YEAR_RETENTION_COPY.alreadyPaid,
      YEAR_RETENTION_COPY.groupSyncYes,
      YEAR_RETENTION_COPY.groupSyncNo,
    ].join('\n');
    expect(blob.toLowerCase()).not.toMatch(/subscription|ai assistant/);
    expect(YEAR_RETENTION_COPY.ask.toLowerCase()).toContain('year');
    expect(YEAR_RETENTION_COPY.alreadyPaid.toLowerCase()).toContain('year');
    expect(YEAR_RETENTION_COPY.groupSyncYes).not.toMatch(/https?:\/\//);
  });
});

describe('imessageUpgradeAskEnabled', () => {
  it('is off unless the flag is exactly on', () => {
    expect(imessageUpgradeAskEnabled({})).toBe(false);
    expect(imessageUpgradeAskEnabled({ IMESSAGE_UPGRADE_ASK: '' })).toBe(false);
    expect(imessageUpgradeAskEnabled({ IMESSAGE_UPGRADE_ASK: 'off' })).toBe(false);
    expect(imessageUpgradeAskEnabled({ IMESSAGE_UPGRADE_ASK: 'on' })).toBe(true);
  });
});

describe('upgradePaymentUrl', () => {
  it('uses the Payment Link and does not call Stripe when one is configured', async () => {
    const fetchMock = vi.fn();
    const client = stripeCheckoutClientFromEnv({ STRIPE_SECRET_KEY: 'sk_test' }, fetchMock);
    const url = await upgradePaymentUrl(
      'fam-1',
      {
        STRIPE_SECRET_KEY: 'sk_test',
        STRIPE_PAYMENT_LINK_URL: 'https://buy.stripe.com/test_year',
        STRIPE_PRICE_PLUS_ANNUAL: 'price_plus_annual',
        APP_URL: 'https://app.example.com',
      },
      client,
    );
    expect(url).toContain('client_reference_id=fam-1');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null when neither a Payment Link nor an annual price is configured', async () => {
    expect(await upgradePaymentUrl('fam-1', {}, null)).toBeNull();
  });
});

describe('paymentLinkUrlForFamily', () => {
  it('returns null when no payment link is configured', () => {
    expect(paymentLinkUrlForFamily('fam-1', undefined)).toBeNull();
    expect(paymentLinkUrlForFamily('fam-1', '   ')).toBeNull();
    expect(paymentLinkUrlForFamily('fam-1', 'http://buy.stripe.com/test_x')).toBeNull();
  });

  it('appends client_reference_id and keeps the existing query', () => {
    const url = paymentLinkUrlForFamily(
      'fam-1',
      'https://buy.stripe.com/test_year?prefilled_promo_code=EARLY',
    );
    expect(url).not.toBeNull();
    const parsed = new URL(url as string);
    expect(parsed.origin + parsed.pathname).toBe('https://buy.stripe.com/test_year');
    expect(parsed.searchParams.get('client_reference_id')).toBe('fam-1');
    expect(parsed.searchParams.get('prefilled_promo_code')).toBe('EARLY');
  });
});
