import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { FamilyConnectorView } from '~/lib/integrations/load';
import { ConnectionSources } from './connection-sources';

/**
 * The Google sources card's honesty contract:
 * - scope chips render from the CONNECTION's granted scopes (an unknown scope
 *   renders literally and is never relabelled read-only) — never a hardcoded list;
 * - Connect links point at the real connect entry points;
 * - `error` renders as connected-but-failing, never as "not connected" (the row
 *   still holds tokens and is retried);
 * - `revoked` (tokens purged) renders as the connect invitation;
 * - a co-parent's connection is attributed and non-actionable (no disconnect).
 *
 * The disconnect form's server action module is stubbed (the markup-only pattern
 * the preferences-card test uses).
 */
vi.mock('~/app/(authed)/settings/connector-actions', () => ({
  disconnectConnectorAction: vi.fn(),
}));

const GCAL_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

function connection(overrides: Partial<FamilyConnectorView> = {}): FamilyConnectorView {
  return {
    provider: 'gcal',
    status: 'active',
    scopes: [GCAL_SCOPE],
    lastSyncAt: new Date('2026-08-20T12:00:00Z'),
    connectedAt: new Date('2026-08-01T12:00:00Z'),
    ownedByViewer: true,
    ...overrides,
  };
}

const render = (connections: FamilyConnectorView[]) =>
  renderToStaticMarkup(h(ConnectionSources, { connections }));

describe('ConnectionSources — empty state is an invitation', () => {
  const html = render([]);

  it('offers all three real connect entry points and nothing to disconnect', () => {
    expect(html).toContain('href="/api/integrations/gcal/connect"');
    expect(html).toContain('href="/api/integrations/gmail/connect"');
    expect(html).toContain('href="/api/integrations/gdrive/connect"');
    expect(html).not.toContain('disconnect');
  });

  it('renders no scope chips when nothing is granted', () => {
    expect(html).not.toContain('class="pill');
  });
});

describe('ConnectionSources — scope chips derive from the granted scopes', () => {
  it('labels a known read-only scope as read-only', () => {
    const html = render([connection()]);
    expect(html).toContain('Calendar · read-only');
  });

  it('renders an unknown granted scope literally, without a read-only claim', () => {
    const html = render([connection({ scopes: ['https://example.com/custom.scope'] })]);
    expect(html).toContain('https://example.com/custom.scope');
    expect(html).not.toContain('custom.scope · read-only');
  });

  it('renders no chips for a connection whose row carries no scopes', () => {
    const html = render([connection({ scopes: [] })]);
    expect(html).not.toContain('class="pill');
  });
});

describe('ConnectionSources — a connected row is honest about its state', () => {
  it('shows connected + last-synced for an active row, with disconnect and no connect link', () => {
    const html = render([connection()]);
    expect(html).toContain('Connected');
    expect(html).toContain('Last synced');
    expect(html).toContain('disconnect');
    expect(html).not.toContain('href="/api/integrations/gcal/connect"');
  });

  it('renders error as connected-but-failing (still disconnectable, reconnect offered) — never as not-connected', () => {
    const html = render([connection({ status: 'error' })]);
    expect(html).toContain('Sync failing');
    expect(html).toContain('disconnect');
    expect(html).toContain('reconnect');
  });

  it('renders revoked (tokens purged) as the connect invitation again', () => {
    const html = render([connection({ status: 'revoked' })]);
    expect(html).toContain('href="/api/integrations/gcal/connect"');
    expect(html).not.toContain('disconnect');
  });
});

describe('ConnectionSources — co-parent attribution (rule #5 doctrine)', () => {
  it('attributes a co-parent connection, renders no disconnect, and still offers the viewer their own connect', () => {
    const html = render([connection({ provider: 'gmail', ownedByViewer: false })]);
    expect(html).toContain('co-parent');
    expect(html).not.toContain('disconnect');
    expect(html).toContain('href="/api/integrations/gmail/connect"');
  });

  it('keeps account-level detail with the owner: no scope chips on a co-parent row', () => {
    const html = render([connection({ provider: 'gmail', ownedByViewer: false })]);
    expect(html).not.toContain('class="pill');
  });
});
