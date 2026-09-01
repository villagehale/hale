import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadSmsChannelResult } from '~/lib/channels/sms-consent';

/**
 * Where the parent's number comes from, on the two surfaces that show it: the
 * Settings Account card's Phone row, and the sidebar account chip's secondary line.
 * Both read ONE loader — loadSmsChannel — and both are RENDERED here rather than
 * source-scanned, because only a render can tell whether the value a parent sees
 * still traces to the store (a hardcoded row and a live one look identical in the
 * source). Same technique as auth-passwordless.test.ts: mock the server-only chains
 * the page pulls in, then render the real page/layout function.
 *
 * The masked number is the only thing the loader can supply, so an assertion on it
 * fails the moment either surface stops asking (rule #1 — nothing shown that the
 * store can't back).
 */

const MASKED = '+1 ••• ••• 4821';

vi.mock('~/lib/channels/sms-consent', () => ({ loadSmsChannel: vi.fn() }));

// The page/layout's other server-only reads. None of them can answer the phone
// question, so each degrades to its own honest empty state.
vi.mock('~/lib/db', () => ({ db: () => ({}) }));
vi.mock('~/lib/dashboard/queries', () => ({
  loadFamilyBasics: vi.fn(async () => ({
    location: { country: null, province: null, city: null, postalCode: null },
    planTier: 'free' as const,
    intents: [],
    foundingNumber: null,
    children: [],
  })),
  loadFamilyMembers: vi.fn(async () => ({ primary: null, coParent: null })),
}));
vi.mock('~/lib/dashboard/notifications', () => ({ loadNotifications: vi.fn(async () => []) }));
vi.mock('~/lib/village/switcher', () => ({
  loadAreaSwitcher: vi.fn(async () => ({ areas: [], activeLabel: null })),
}));
vi.mock('~/lib/integrations/load', () => ({ loadFamilyConnectors: vi.fn(async () => []) }));
vi.mock('~/lib/mcp/oauth-store', () => ({ listMcpConnectionsForUser: vi.fn(async () => []) }));
vi.mock('~/lib/consent-records', () => ({ listConsentRecordsForViewer: vi.fn(async () => []) }));
vi.mock('~/lib/settings/push-notification-prefs', () => ({
  loadPushNotificationPrefs: vi.fn(async () => ({ status: 'preview' as const })),
}));
vi.mock('~/lib/settings/loop-prefs', () => ({
  loadLoopNotificationPrefs: vi.fn(async () => ({ status: 'preview' as const })),
}));
vi.mock('~/lib/auth-actions', () => ({ signOutAction: vi.fn() }));
vi.mock('~/auth', () => ({ auth: vi.fn(async () => null), signIn: vi.fn(), signOut: vi.fn() }));
vi.mock('~/lib/family', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/lib/family')>()),
  loadViewerProfile: vi.fn(async () => ({
    name: 'Maya Okonkwo',
    email: 'maya@example.com',
    timezone: 'America/Toronto',
    locale: 'en-CA',
    units: 'metric' as const,
    weekStartDay: 1,
  })),
  loadViewerName: vi.fn(async () => null),
  currentFamilyId: vi.fn(async () => null),
  currentUserId: vi.fn(async () => null),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/settings',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  redirect: vi.fn(),
  notFound: vi.fn(),
}));
// The layout reads the middleware's admin-probe header (a request store the
// test render has none of); an empty header bag is the non-admin-path arm.
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));

const { loadSmsChannel } = await import('~/lib/channels/sms-consent');
const { default: SettingsPage } = await import('~/app/(authed)/settings/page');
const { default: AuthedLayout } = await import('~/app/(authed)/layout');

function enrolled(): LoadSmsChannelResult {
  return {
    status: 'ready',
    channel: { enrolled: true, maskedPhone: MASKED, verifiedAt: new Date('2026-08-01T12:00:00Z') },
    senderConfigured: true,
  };
}

function notEnrolled(): LoadSmsChannelResult {
  return {
    status: 'ready',
    channel: { enrolled: false, maskedPhone: null, verifiedAt: null },
    senderConfigured: true,
  };
}

async function renderSettings(channel: LoadSmsChannelResult): Promise<string> {
  vi.mocked(loadSmsChannel).mockResolvedValue(channel);
  return renderToStaticMarkup(await SettingsPage());
}

async function renderShell(channel: LoadSmsChannelResult): Promise<string> {
  vi.mocked(loadSmsChannel).mockResolvedValue(channel);
  return renderToStaticMarkup(await AuthedLayout({ children: null }));
}

beforeEach(() => {
  // The layout renders its account chip in the dev-preview auth state, which keeps
  // the session/redirect chain out of a question that is only about the phone.
  process.env.GOOGLE_OAUTH_CLIENT_ID = '';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = '';
  process.env.AUTH_SECRET = '';
  // The admin gate resolves not_configured, keeping the founder stop out of a
  // question that is only about the phone.
  process.env.ADMIN_PHONES = '';
});
afterEach(() => {
  vi.mocked(loadSmsChannel).mockReset();
});

describe('the Settings Account card’s Phone row', () => {
  it('shows the enrolled parent’s MASKED number, straight from the sms-channel loader', async () => {
    const html = await renderSettings(enrolled());

    expect(html).toContain(MASKED);
    expect(html).toContain('the number you text Hale from');
    // Enrolled → the row offers a change, and its value line is PII (replay masking).
    expect(html).toContain('>Change<');
    expect(html).toContain('data-hale-pii');
    expect(html).not.toContain('No number linked yet');
  });

  it('says no number is linked yet, and offers the link, when the parent has not enrolled', async () => {
    const html = await renderSettings(notEnrolled());

    expect(html).toContain('No number linked yet');
    expect(html).toContain('>Link<');
    // Positive control: the row really rendered, so the absence below isn't vacuous.
    expect(html).toContain('Phone');
    expect(html).not.toContain(MASKED);
  });
});

describe('the sidebar account chip’s secondary line', () => {
  it('is the masked number once the parent’s channel is live', async () => {
    const html = await renderShell(enrolled());

    expect(html).toContain('account-chip-family');
    expect(html).toContain(MASKED);
    // One secondary line, never both — the number replaces the plan label.
    expect(html).not.toContain('Free plan');
  });

  it('falls back to the plan label while no number is enrolled', async () => {
    const html = await renderShell(notEnrolled());

    expect(html).toContain('account-chip-family');
    expect(html).toContain('Free plan');
    expect(html).not.toContain(MASKED);
  });
});
