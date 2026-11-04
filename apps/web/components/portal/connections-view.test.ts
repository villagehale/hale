import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { FamilyConnectorView } from '~/lib/integrations/load';

vi.mock('~/components/hale/connector-disconnect-form', () => ({
  ConnectorDisconnectForm: () => null,
}));
vi.mock('~/components/hale/mcp-revoke-form', () => ({ McpRevokeForm: () => null }));

import { ConnectionsView } from './connections-view';

/**
 * A parent told "Hale keeps asking Google" sees, on their own card, when Hale stopped
 * asking without Google confirming (VIL-156 follow-up). Only their own disconnected row
 * says so; a confirmed one and a co-parent's do not.
 */

const UNCONFIRMED = 'Google hasn’t confirmed it removed Hale’s access';

function render(connections: FamilyConnectorView[]): string {
  return renderToStaticMarkup(
    createElement(ConnectionsView, {
      connections,
      assistants: [],
      maskedPhone: null,
      textsOn: false,
      gmailSince: null,
      calendarSince: null,
      driveSince: null,
    }),
  );
}

const ended = (
  provider: string,
  extra: Partial<FamilyConnectorView> = {},
): FamilyConnectorView => ({
  provider,
  status: 'revoked',
  scopes: [],
  lastSyncAt: null,
  ownedByViewer: true,
  ...extra,
});

describe('ConnectionsView: a Google revoke Hale stopped asking about', () => {
  it('says so on the parent’s own disconnected Gmail and Calendar rows, beside Connect', () => {
    const markup = render([
      ended('gmail', { googleRevokeUnconfirmed: true }),
      ended('gcal', { googleRevokeUnconfirmed: true }),
    ]);
    expect(markup.split(UNCONFIRMED)).toHaveLength(3);
    expect(markup).toContain('href="/api/integrations/gmail/connect"');
    expect(markup).toContain('href="/api/integrations/gcal/connect"');
  });

  it('positive control: a confirmed disconnect, or a co-parent’s row, shows no warning', () => {
    const markup = render([
      ended('gmail'),
      ended('gcal'),
      ended('gcal', { ownedByViewer: false, googleRevokeUnconfirmed: true }),
    ]);
    expect(markup).not.toContain(UNCONFIRMED);
    expect(markup).toContain('Catches class invites and trip dates');
    expect(markup).toContain('href="/api/integrations/gmail/connect"');
  });
});
