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

async function render(searchParams: {
  t?: string;
  to?: string;
  preview?: string;
}): Promise<string> {
  const { default: ConnectPage } = await import('./page');
  return renderToStaticMarkup(await ConnectPage({ searchParams: Promise.resolve(searchParams) }));
}

describe('/connect — the texted redeem page', () => {
  it('names the connector on the button when the link asks for Calendar', async () => {
    const html = await render({ t: 'tok', to: 'gcal' });

    expect(html).toContain('Connect');
    expect(html).toContain('your calendar');
    expect(html).toContain('So Hale can catch class invites and trip dates for');
    expect(html).toContain('the kids.');
    expect(html).toContain('What Hale reads');
    expect(html).toContain('What Hale never does');
    expect(html).toContain('box for Google Calendar');
    expect(html).toContain('Tap Advanced, then continue.');
    expect(html).toContain('unverified app');
    expect(html).not.toContain('connect my calendar');
    expect(html).not.toContain('Connect Google Calendar');
    expect(html).toContain('Continue with Google');
    expect(html).toContain('Never sold.');
    expect(html).toContain('https://www.villagehale.com/privacy');
    expect(html).not.toContain('tok');
  });

  it('names Gmail when the link asks for Gmail', async () => {
    const html = await render({ t: 'tok', to: 'gmail' });

    expect(html).toContain('Connect Gmail');
    expect(html).toContain('So Hale can flag daycare and school notices');
    expect(html).toContain('for you.');
    expect(html).toContain('box for Gmail');
    expect(html).toContain('Tap Advanced, then continue.');
    expect(html).toContain('Continue with Google');
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
      'So Hale can catch class invites and trip dates for the kids.',
    );
    expect(gmail.title).toBe('Connect Gmail');
    expect(gmail.description).toBe('So Hale can flag daycare and school notices for you.');
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
      expect(html).not.toContain('Continue with Google');
      expect(html).not.toContain('Connect Google Calendar');
      expect(html).toContain('One tap signs you in and opens your connected apps.');
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

    expect(html).toContain('This link is incomplete');
    expect(html).toContain('This link is missing');
    expect(html).toContain('or incomplete.');
    expect(html).not.toContain('connect my calendar');
    expect(html).not.toContain('Connect Google Calendar');
  });

  it('ignores a force-state outside development', async () => {
    const html = await render({ t: 'tok', to: 'gmail', preview: 'denied' });

    expect(html).toContain('Connect Gmail');
    expect(html).not.toContain('Nothing changed');
    expect(html).not.toContain('Concept');
  });
});
