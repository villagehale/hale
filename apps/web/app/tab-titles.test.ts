import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/auth-config', () => ({ authConfigured: () => true }));
vi.mock('~/lib/auth/channel-link-actions', () => ({
  redeemChannelLinkAction: async () => ({ status: 'idle' }),
}));
import {
  connectPageMeta,
  connectedStatus,
  withHaleSuffix,
} from '~/lib/channel/connect/connect-page-copy';
import {
  ADMIN_TITLE,
  DEMO_TITLE,
  PORTAL_TITLE,
  resolveDocumentTitle,
} from '~/lib/portal/document-title';
import { generateMetadata as connectMetadata } from './connect/page';
import { generateMetadata as connectedMetadata } from './connected/page';
import NotFound, { metadata as notFoundMetadata } from './not-found';

/**
 * The portal template suffixes a bare page title once. These lock the
 * approved strings and that a page body does not add a second <title>.
 */

function pageSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

function bareTitle(relativePath: string): string | { absolute: string } {
  const source = pageSource(relativePath);
  const absolute = source.match(/title: \{ absolute: '([^']+)' \}/);
  if (absolute?.[1]) return { absolute: absolute[1] };
  const plain = source.match(/title: '([^']+)'/);
  if (plain?.[1]) return plain[1];
  const quoted = source.match(/title: "([^"]+)"/);
  if (quoted?.[1]) return quoted[1];
  throw new Error(`no metadata title in ${relativePath}`);
}

function rendered(relativePath: string, template: string, fallback: string): string {
  return resolveDocumentTitle(bareTitle(relativePath), template, fallback);
}

function inlineTitles(html: string): string[] {
  return html.match(/<title\b[^>]*>[\s\S]*?<\/title>/gi) ?? [];
}

describe('portal title template', () => {
  it('renders a portal page as "<Page> · Hale"', () => {
    expect(PORTAL_TITLE).toEqual({ default: 'Hale', template: '%s · Hale' });
    expect(rendered('./(authed)/home/page.tsx', PORTAL_TITLE.template, PORTAL_TITLE.default)).toBe(
      'Home · Hale',
    );
    expect(pageSource('./layout.tsx')).toContain('title: PORTAL_TITLE');
    expect(pageSource('./layout.tsx')).not.toContain('family assistant you text');
  });

  it('keeps a child name out of the family tab', () => {
    expect(
      rendered('./(authed)/family/page.tsx', PORTAL_TITLE.template, PORTAL_TITLE.default),
    ).toBe('Family · Hale');
    expect(
      rendered('./(authed)/family/[childId]/page.tsx', PORTAL_TITLE.template, PORTAL_TITLE.default),
    ).toBe('Family · Hale');
    expect(bareTitle('./(authed)/family/[childId]/page.tsx')).toBe('Family');
  });

  it('uses the approved bare titles, each resolving through the template once', () => {
    const pages: Array<[string, string]> = [
      ['./sign-in/page.tsx', 'Sign in · Hale'],
      ['./oauth/authorize/page.tsx', 'Allow access · Hale'],
      ['./(authed)/messages/page.tsx', 'Messages · Hale'],
      ['./(authed)/settings/page.tsx', 'Settings · Hale'],
      ['./(authed)/settings/connections/page.tsx', 'Connections · Hale'],
      ['./(authed)/settings/privacy/page.tsx', 'Privacy & data · Hale'],
      ['./(authed)/settings/texts/page.tsx', 'Texts · Hale'],
      ['./(authed)/settings/plan/page.tsx', 'Plan · Hale'],
      ['./(authed)/approvals/page.tsx', 'Approvals · Hale'],
      ['./(authed)/trail/page.tsx', 'History · Hale'],
      ['./(authed)/plan/page.tsx', 'Week · Hale'],
      ['./(authed)/village/page.tsx', 'Village · Hale'],
      ['./unsubscribe/page.tsx', 'Unsubscribe · Hale'],
      ['./rsvp/[token]/page.tsx', "You're invited · Hale"],
    ];
    for (const [path, title] of pages) {
      expect(rendered(path, PORTAL_TITLE.template, PORTAL_TITLE.default), path).toBe(title);
      expect(pageSource(path).match(/export const metadata/g)?.length, path).toBe(1);
    }
  });

  it('templates admin tabs under Admin · Hale and demo pages as previews', () => {
    expect(ADMIN_TITLE).toEqual({ absolute: 'Admin · Hale', template: '%s · Admin · Hale' });
    expect(pageSource('./(authed)/admin/layout.tsx')).toContain('title: ADMIN_TITLE');
    expect(pageSource('./(authed)/admin/page.tsx')).not.toContain('export const metadata');
    expect(
      rendered('./(authed)/admin/engagement/page.tsx', ADMIN_TITLE.template, ADMIN_TITLE.absolute),
    ).toBe('Engagement · Admin · Hale');
    for (const [path, label] of [
      ['./(authed)/admin/funnels/page.tsx', 'Funnels'],
      ['./(authed)/admin/operations/page.tsx', 'Operations'],
      ['./(authed)/admin/agents/page.tsx', 'Agents'],
      ['./(authed)/admin/radar/page.tsx', 'Radar'],
      ['./(authed)/admin/ledger/page.tsx', 'Ledger'],
    ] as const) {
      expect(rendered(path, ADMIN_TITLE.template, ADMIN_TITLE.absolute), path).toBe(
        `${label} · Admin · Hale`,
      );
    }

    expect(DEMO_TITLE).toEqual({ absolute: 'Preview · Hale', template: '%s · Hale preview' });
    expect(pageSource('./demo/layout.tsx')).toContain('title: DEMO_TITLE');
    expect(pageSource('./demo/layout.tsx')).toContain("absolute: 'Page not found · Hale'");
    expect(pageSource('./demo/not-found.tsx')).toContain("absolute: 'Page not found · Hale'");
    expect(rendered('./demo/portal/home/page.tsx', DEMO_TITLE.template, DEMO_TITLE.absolute)).toBe(
      'Home · Hale preview',
    );
    expect(rendered('./demo/sign-in/page.tsx', DEMO_TITLE.template, DEMO_TITLE.absolute)).toBe(
      'Sign in · Hale preview',
    );
  });

  it('emits exactly one title on the portal 404', () => {
    expect(notFoundMetadata.title).toBe('Page not found');
    expect(
      resolveDocumentTitle(notFoundMetadata.title, PORTAL_TITLE.template, PORTAL_TITLE.default),
    ).toBe('Page not found · Hale');
    const html = renderToStaticMarkup(createElement(NotFound));
    expect(inlineTitles(html)).toEqual([]);
    expect(html).toContain('Page not found');
    expect(html).not.toContain('This page could not be found');
  });
});

describe('connect tab titles', () => {
  it('splits the Gmail and calendar landing titles from the full preview strings', async () => {
    const gmail = await connectMetadata({
      searchParams: Promise.resolve({ t: 'tok', to: 'gmail' }),
    });
    const calendar = await connectMetadata({
      searchParams: Promise.resolve({ t: 'tok', to: 'gcal' }),
    });
    expect(gmail.title).toBe('Connect Gmail');
    expect(calendar.title).toBe('Connect your calendar');
    expect(gmail.openGraph?.title).toBe('Connect Gmail · Hale');
    expect(calendar.openGraph?.title).toBe('Connect your calendar · Hale');
    expect((gmail.twitter as { title?: string }).title).toBe(withHaleSuffix('Connect Gmail'));
    expect((calendar.twitter as { title?: string }).title).toBe(
      withHaleSuffix('Connect your calendar'),
    );
    expect(resolveDocumentTitle(gmail.title, PORTAL_TITLE.template, PORTAL_TITLE.default)).toBe(
      'Connect Gmail · Hale',
    );
  });

  it('uses a tab title for two connected states and keeps the aria label', async () => {
    const gmail = await connectedMetadata({
      searchParams: Promise.resolve({ provider: 'gmail', status: 'ok', who: 'Sam' }),
    });
    const calendar = await connectedMetadata({
      searchParams: Promise.resolve({ provider: 'gcal', status: 'ok' }),
    });
    expect(gmail.title).toBe('Gmail connected');
    expect(calendar.title).toBe('Calendar connected');
    expect(gmail.openGraph?.title).toBe('Gmail connected · Hale');
    expect(calendar.openGraph?.title).toBe('Calendar connected · Hale');
    expect((gmail.twitter as { title?: string }).title).toBe('Gmail connected · Hale');
    expect(JSON.stringify(gmail)).not.toContain('Sam');

    expect(connectedStatus('ok', 'gmail').aria).toBe('Connected');
    expect(connectedStatus('ok', 'gcal').aria).toBe('Connected');
    expect(connectPageMeta('gmail').tabTitle).toBe('Connect Gmail');
  });

  it('titles the French own-link state Déjà connecté and never puts who in it', async () => {
    const meta = await connectedMetadata({
      searchParams: Promise.resolve({
        provider: 'gmail',
        status: 'own_link',
        lang: 'fr',
        who: 'Sam',
      }),
    });
    expect(meta.title).toBe('Déjà connecté');
    expect(meta.openGraph?.title).toBe('Déjà connecté · Hale');
    expect(JSON.stringify(meta)).not.toContain('Sam');
    expect(connectedStatus('own_link', 'gmail', { name: 'Sam', language: 'fr' }).aria).toBe(
      'Déjà connecté',
    );
  });
});
