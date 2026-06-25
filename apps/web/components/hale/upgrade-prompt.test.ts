import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  UPGRADE_PROMPT_STORAGE_PREFIX,
  UpgradePrompt,
  shouldOfferUpgrade,
  upgradePromptStorageKey,
} from './upgrade-prompt';

/**
 * The upgrade prompt is a gated invitation, never a wall. The two behaviours that
 * matter: it appears ONLY for a family that lacks the entitlement it promotes, and
 * it vanishes entirely (no DOM, not just hidden) once the entitlement is held —
 * otherwise it would nag a paying family. Expected tier→entitlement outcomes are
 * derived from PLAN_ENTITLEMENTS (free grants nothing; plus grants autonomy_l3;
 * family adds commerce + portal_automation), not from the component's output.
 */
function render(props: Parameters<typeof UpgradePrompt>[0]): string {
  return renderToStaticMarkup(createElement(UpgradePrompt, props));
}

describe('shouldOfferUpgrade', () => {
  it('offers autonomy to a free family (it has no entitlements)', () => {
    expect(shouldOfferUpgrade('free', 'autonomy_l3')).toBe(true);
  });

  it('offers commerce/portal automation that even plus lacks', () => {
    expect(shouldOfferUpgrade('plus', 'commerce')).toBe(true);
    expect(shouldOfferUpgrade('plus', 'portal_automation')).toBe(true);
  });

  it('does not offer an entitlement the tier already holds', () => {
    expect(shouldOfferUpgrade('plus', 'autonomy_l3')).toBe(false);
    expect(shouldOfferUpgrade('family', 'autonomy_l3')).toBe(false);
    expect(shouldOfferUpgrade('family', 'commerce')).toBe(false);
    expect(shouldOfferUpgrade('family', 'portal_automation')).toBe(false);
  });
});

describe('UpgradePrompt rendering', () => {
  it('renders the value line, a link to /settings, and a labelled dismiss for a free family', () => {
    const html = render({
      planTier: 'free',
      entitlement: 'autonomy_l3',
      children: 'Want Hale to handle the routine ones on its own?',
    });
    expect(html).toContain('Want Hale to handle the routine ones on its own?');
    expect(html).toContain('href="/settings"');
    expect(html).toContain('see plans');
    expect(html).toContain('aria-label="Dismiss this suggestion"');
  });

  it('renders nothing when the family already has the entitlement', () => {
    const html = render({
      planTier: 'plus',
      entitlement: 'autonomy_l3',
      children: 'Want Hale to handle the routine ones on its own?',
    });
    expect(html).toBe('');
  });

  it('renders nothing for the booking entitlement once on Family', () => {
    const html = render({
      planTier: 'family',
      entitlement: 'portal_automation',
      children: 'Hale can book a clinic appointment for you.',
    });
    expect(html).toBe('');
  });
});

describe('upgradePromptStorageKey', () => {
  it('namespaces the dismissal per entitlement so one dismiss never silences another', () => {
    const autonomy = upgradePromptStorageKey('autonomy_l3');
    const portal = upgradePromptStorageKey('portal_automation');
    expect(autonomy).toBe(`${UPGRADE_PROMPT_STORAGE_PREFIX}autonomy_l3`);
    expect(autonomy).not.toBe(portal);
  });
});
