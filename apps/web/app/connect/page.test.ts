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

async function render(searchParams: { t?: string; to?: string }): Promise<string> {
  const { default: ConnectPage } = await import('./page');
  return renderToStaticMarkup(await ConnectPage({ searchParams: Promise.resolve(searchParams) }));
}

describe('/connect — the texted redeem page', () => {
  it('names the connector on the button when the link asks for Calendar', async () => {
    const html = await render({ t: 'tok', to: 'gcal' });

    expect(html).toContain('Connect Google Calendar');
    expect(html).not.toContain('Continue');
  });

  it('names Gmail when the link asks for Gmail', async () => {
    const html = await render({ t: 'tok', to: 'gmail' });

    expect(html).toContain('Connect Gmail');
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

  it('keeps the calm dead end for a link with no token', async () => {
    const html = await render({ to: 'gcal' });

    expect(html).toContain('missing or incomplete');
    expect(html).not.toContain('Connect Google Calendar');
  });
});
