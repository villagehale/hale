import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { connectedNotice } from '~/lib/channel/connect/text-connect';
import ConnectedPage from './page';

/**
 * The end of the texted connect: a page whose whole job is to be closeable. No nav, no
 * portal, nothing family-specific — the query carries a provider slug and a status word
 * and the page renders nothing it was not given.
 */

async function render(searchParams: { provider?: string; status?: string }): Promise<string> {
  return renderToStaticMarkup(await ConnectedPage({ searchParams: Promise.resolve(searchParams) }));
}

describe('/connected — the done page', () => {
  it('tells a connected parent they can close it, and what happens next', async () => {
    const html = await render({ provider: 'gcal', status: 'ok' });

    expect(html).toContain('Google Calendar is connected.');
    expect(html).toContain('You can close this');
    expect(html).toContain('stays in the year');
  });

  it('says what Gmail will be used for, and only that', async () => {
    const html = await render({ provider: 'gmail', status: 'ok' });

    expect(html).toContain('Gmail is connected.');
    expect(html).toContain('daycare and school notices get into the year');
  });

  it('reassures a parent who said no at Google, and hands them the way back', async () => {
    const html = await render({ provider: 'gcal', status: 'denied' });

    expect(html).toContain('No changes made.');
    expect(html).toContain('connect my calendar');
  });

  it('tells an expired link from a connect that broke', async () => {
    // Two different things went wrong and the parent is told which, because only one of
    // them is worth retrying immediately. (Apostrophes come back HTML-escaped.)
    expect(await render({ provider: 'gcal', status: 'invalid' })).toContain(
      'That link has expired.',
    );
    expect(await render({ provider: 'gcal', status: 'error' })).toContain('t go through.');
  });

  it('never claims success for a status or provider it does not know', async () => {
    // Fail closed: a bare /connected, an unknown slug and an ok for a provider with no
    // words are all the honest failure, never a green tick over nothing.
    for (const params of [{}, { status: 'ok' }, { provider: 'gdrive', status: 'ok' }]) {
      const html = await render(params);
      expect(html).not.toContain('is connected.');
      expect(html).toContain('connect my calendar');
    }
  });

  it('sends the parent nowhere — the receipt is a text, not a dashboard', async () => {
    const html = await render({ provider: 'gcal', status: 'ok' });

    expect(html).not.toContain('/settings');
    expect(html).not.toMatch(/\bthe app\b/i);
  });
});

describe('connectedNotice — the words the page and the text share', () => {
  it('says the same thing about Calendar on the page as Hale texts', async () => {
    const { CONNECTOR_CONNECTED_TEXT } = await import('~/lib/channel/connect/text-connect');
    const page = connectedNotice('ok', 'gcal');

    // One promise, written once: a page that drifted from the text would tell a parent
    // two different things about the same connection inside ten seconds.
    expect(CONNECTOR_CONNECTED_TEXT.gcal).toContain(
      "What's on for the kids, and when it moves, stays in the year",
    );
    expect(page.body).toContain("what's on for the kids, and when it moves, stays in the year");
  });
});
