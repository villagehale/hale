import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * The redeem page reads WHICH connector the texted link was for, so the one tap it
 * already asks for is also the last one. An unrecognised `to` is not an error the
 * parent has to read — it is simply the flow the page has always had.
 */

vi.mock('~/lib/auth-config', () => ({ authConfigured: () => true }));
vi.mock('~/lib/auth/channel-link-actions', () => ({
  redeemChannelLinkAction: async () => ({ status: 'idle' }),
}));

const consumeMock = vi.fn();
vi.mock('~/lib/auth/channel-signin', () => ({
  consumeChannelSigninToken: (...args: unknown[]) => consumeMock(...args),
  mintChannelSigninTokens: () => {
    throw new Error('the redeem page mints nothing');
  },
}));

async function render(searchParams: { t?: string; to?: string }): Promise<string> {
  const { default: ConnectPage } = await import('./page');
  return renderToStaticMarkup(await ConnectPage({ searchParams: Promise.resolve(searchParams) }));
}

describe('/connect — the texted redeem page', () => {
  it('names the connector on the button when the link asks for Calendar', async () => {
    const html = await render({ t: 'tok', to: 'gcal' });

    expect(html).toContain('Connect your calendar');
    expect(html).toContain('I never see your password. Disconnect my calendar anytime.');
    expect(html).toContain('Connect Google Calendar');
    expect(html).not.toContain('Continue');
    expect(html).not.toContain('tok');
  });

  it('names Gmail when the link asks for Gmail', async () => {
    const html = await render({ t: 'tok', to: 'gmail' });

    expect(html).toContain('Connect Gmail');
    expect(html).toContain('Disconnect my gmail anytime.');
    expect(html).not.toContain('tok');
  });

  it('unfurls a different card for each connector, and never puts the token in it', async () => {
    const { generateMetadata } = await import('./page');
    const calendar = await generateMetadata({
      searchParams: Promise.resolve({ t: 'secret-token', to: 'gcal' }),
    });
    const gmail = await generateMetadata({
      searchParams: Promise.resolve({ t: 'secret-token', to: 'gmail' }),
    });

    expect(calendar.title).toBe('Connect your calendar');
    expect(calendar.description).toBe(
      'I never see your password. Disconnect my calendar anytime.',
    );
    expect(gmail.title).toBe('Connect Gmail');
    expect(gmail.description).toBe('I never see your password. Disconnect my gmail anytime.');
    expect(calendar.openGraph?.title).toBe(calendar.title);
    expect(gmail.openGraph?.description).toBe(gmail.description);
    expect(JSON.stringify(calendar)).not.toContain('secret-token');
    expect(JSON.stringify(gmail)).not.toContain('secret-token');
  });

  it('falls back to the plain sign-in tap for a `to` it does not recognise', async () => {
    // Drive has no text-back path, and `../evil` is somebody probing: both land on the
    // destination the flow has always had rather than on a provider-shaped promise.
    for (const to of ['gdrive', '../evil', 'GCAL ']) {
      const html = await render({ t: 'tok', to });
      expect(html).toContain('Continue');
      expect(html).not.toContain('Connect Google Calendar');
    }
  });

  /**
   * THE GET SPENDS NOTHING. Carrier link scanners and message previews follow SMS URLs
   * with no JS, so a page that consumed the token while rendering would burn the
   * parent's one link before they ever saw it. The tap — the POST inside the server
   * action — is the only thing allowed to spend it.
   */
  it('never spends the token while rendering', async () => {
    consumeMock.mockClear();

    await render({ t: 'tok', to: 'gcal' });
    await render({ t: 'tok', to: 'gdrive' });

    expect(consumeMock.mock.calls.length).toBe(0);
  });

  it('keeps the calm dead end for a link with no token', async () => {
    const html = await render({ to: 'gcal' });

    expect(html).toContain('missing or incomplete');
    expect(html).not.toContain('Connect Google Calendar');
  });
});
