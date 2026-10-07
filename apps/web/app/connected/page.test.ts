import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { flattenCopy } from '~/lib/channel/connect/connect-page-copy';
import ConnectedPage from './page';

/**
 * The end of the texted connect: a page whose whole job is to be closeable. No nav, no
 * portal, nothing family-specific — the query carries a provider slug and a status word
 * and the page renders nothing it was not given.
 */

async function render(searchParams: {
  provider?: string;
  status?: string;
  who?: string;
  lang?: string;
  fresh?: string;
}): Promise<string> {
  return renderToStaticMarkup(await ConnectedPage({ searchParams: Promise.resolve(searchParams) }));
}

describe('/connected — the done page', () => {
  it('tells a connected parent they can close it, and shows the locked receipt', async () => {
    const html = await render({ provider: 'gcal', status: 'ok' });

    expect(html).toContain('Google Calendar is connected.');
    expect(html).toContain('You can close this page');
    expect(html).toContain('Calendar’s connected. I’ll catch class invites and');
    expect(html).toContain('trip dates.');
    expect(html).not.toContain('stays in the year');
    expect(html).not.toContain('Back to your texts');
  });

  it('says what Gmail will be used for, and only that', async () => {
    const html = await render({ provider: 'gmail', status: 'ok' });

    expect(html).toContain('Gmail is connected.');
    expect(html).toContain('Gmail’s connected. I’ll flag daycare and');
    expect(html).toContain('school notices.');
    expect(html).not.toContain('get into the year');
  });

  it('reassures a parent who said no at Google, without inventing a fresh text', async () => {
    const html = await render({ provider: 'gcal', status: 'denied' });

    expect(html).toContain('Nothing changed');
    expect(html).toContain('No changes made.');
    expect(html).toContain('box for Google Calendar');
    expect(html).not.toContain('A fresh link is in');
    expect(html).not.toContain('connect my calendar');
  });

  it('tells the wrong parent this link is for someone else', async () => {
    const html = await render({ provider: 'gcal', status: 'own_link', who: 'Sam' });

    expect(html).toContain(
      'This link is for Sam. Your Google account is already connected to Hale, so',
    );
    expect(html).toContain('nothing changed.');
    expect(html).toContain('Sam can connect their own Google account from');
    expect(html).not.toContain('Nothing was saved.');
    expect(html).not.toContain('Back to your texts');
  });

  it('uses the locked French sentence when the family is French', async () => {
    const html = await render({ provider: 'gcal', status: 'own_link', who: 'Sam', lang: 'fr' });

    expect(html).toContain('Ce lien est pour Sam. Le tien est deja connecte.');
    expect(html).toContain('Deja connecte');
  });

  it('uses the locked French fallback when the link owner has no name', async () => {
    const html = await render({ provider: 'gcal', status: 'own_link', lang: 'fr' });

    expect(html).toContain(
      'Ce lien est pour le parent a qui il a ete envoye. Le tien est deja connecte.',
    );
    expect(html).toContain('Deja connecte');
  });

  it('names no second sentence when the English link owner has no name', async () => {
    const html = await render({ provider: 'gcal', status: 'own_link' });

    expect(html).toContain(
      'This link is for the parent it was sent to. Your Google account is already connected to Hale, so nothing changed.',
    );
    expect(html).not.toContain('can connect their own');
  });

  it('says a fresh link is in the texts only when one was sent', async () => {
    const html = await render({ provider: 'gmail', status: 'denied', fresh: 'sent' });

    expect(html).toContain('No changes made.');
    expect(html).toContain('A fresh link is in');
    expect(html).toContain('your texts.');
    expect(html).toContain('box for Gmail');
    expect(html).not.toContain('connect my calendar');
    expect(html).not.toContain('connect my Gmail');
  });

  it('names a partial grant, and does not ship the design annotation', async () => {
    const html = await render({ provider: 'gmail', status: 'partial', fresh: 'sent' });

    expect(html).toContain('The box for Gmail wasn’t ticked');
    expect(html).toContain('Hale needs that one box to connect, so nothing changed.');
    expect(html).toContain('A fresh link is in');
    expect(html).toContain('Next time');
    expect(html).not.toContain('Concept');
  });

  it('tells an expired link from a connect that broke', async () => {
    const expired = await render({ provider: 'gcal', status: 'invalid', fresh: 'sent' });
    expect(expired).toContain('That link has expired.');
    expect(expired).toContain('A fresh one is in');
    expect(expired).toContain('15 minutes.');

    const broken = await render({ provider: 'gcal', status: 'error' });
    expect(broken).toContain('t go through.');
    expect(broken).not.toContain('A fresh link is in');
  });

  it('never claims success for a status or provider it does not know', async () => {
    for (const params of [{}, { status: 'ok' }, { provider: 'gdrive', status: 'ok' }]) {
      const html = await render(params);
      expect(html).not.toContain('is connected.');
      expect(html).not.toContain('connect my calendar');
      expect(html).toContain('t go through.');
    }
  });

  it('sends the parent nowhere — the receipt is a text, not a dashboard', async () => {
    const html = await render({ provider: 'gcal', status: 'ok' });

    expect(html).not.toContain('/settings');
    expect(html).not.toMatch(/\bthe app\b/i);
  });
});

describe('the done page keeps the locked text receipt', () => {
  it('texts the straight-apostrophe receipt and shows the curly one', async () => {
    const { CONNECTOR_CONNECTED_TEXT } = await import('~/lib/channel/connect/text-connect');
    const { connectedStatus } = await import('~/lib/channel/connect/connect-page-copy');
    const page = connectedStatus('ok', 'gcal');

    expect(CONNECTOR_CONNECTED_TEXT.gcal).toBe(
      "Calendar's connected. I'll catch class invites and trip dates.",
    );
    expect(flattenCopy(page.bubble ?? [])).toBe(
      'Calendar’s connected. I’ll catch class invites and trip dates.',
    );
    expect(flattenCopy(page.lede)).not.toContain('stays in the year');
  });
});
