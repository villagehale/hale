import type { PlanTier } from '@hale/types';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { demoBasics, demoLoop } from '~/lib/portal/demo-fixture';
import { PortalHome } from './home-view';

const planTier = vi.fn<() => PlanTier>();

vi.mock('~/lib/dashboard/queries', () => ({
  loadFamilyBasics: vi.fn(async () => ({ ...demoBasics, planTier: planTier() })),
}));
vi.mock('~/lib/channels/sms-consent', () => ({
  loadSmsChannel: vi.fn(async () => ({
    status: 'ready',
    channel: { enrolled: false, maskedPhone: null, verifiedAt: null },
    senderConfigured: true,
  })),
}));
vi.mock('~/lib/integrations/load', () => ({ loadFamilyConnectors: vi.fn(async () => []) }));
vi.mock('~/lib/auth-actions', () => ({ signOutAction: vi.fn() }));
vi.mock('~/auth', () => ({ auth: vi.fn(async () => null), signIn: vi.fn(), signOut: vi.fn() }));
vi.mock('~/lib/family', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/lib/family')>()),
  loadViewerProfile: vi.fn(async () => null),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/settings',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const { default: SettingsPage } = await import('~/app/(authed)/settings/page');

const PLAN_NAMES: Array<[PlanTier, string]> = [
  ['free', 'Free'],
  ['plus', 'Plus'],
  ['family', 'Max'],
];

function planRowMeta(html: string): string | undefined {
  return html.match(/<h3>Plan<\/h3><p[^>]*>([^<]*)<\/p>/)?.[1];
}

describe('the Plan row names the family’s real plan', () => {
  beforeEach(() => {
    planTier.mockReset();
  });

  it.each(PLAN_NAMES)('on Settings, a %s family reads %s', async (tier, name) => {
    planTier.mockReturnValue(tier);
    const html = renderToStaticMarkup(await SettingsPage());

    expect(planRowMeta(html)).toBe(name);
    expect(html).not.toContain('Founding family');
  });

  it.each(PLAN_NAMES)('on Home, a %s family reads %s', (tier, name) => {
    const html = renderToStaticMarkup(
      createElement(PortalHome, {
        firstName: 'Pat',
        approvals: [],
        lately: [],
        basics: { ...demoBasics, planTier: tier },
        connections: [],
        loop: demoLoop,
        smsHref: null,
      }),
    );

    expect(planRowMeta(html)).toBe(name);
    expect(html).not.toContain('Founding family');
  });
});
