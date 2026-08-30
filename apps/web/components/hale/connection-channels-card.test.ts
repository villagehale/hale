import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LoadSmsChannelResult } from '~/lib/channels/sms-consent';
import { ConnectionChannelsCard } from './connection-channels-card';

/**
 * "How Hale reaches you" — the contact-channels card's honesty contract: every
 * row derives from the sms loader's REAL result shape (never a restated string),
 * the masked number is replay-masked (rule #1), absent states read as honest
 * absence, and no channel Hale cannot actually use today (WhatsApp) is rendered —
 * not even as a dead Connect button.
 */

const ENROLLED: LoadSmsChannelResult = {
  status: 'ready',
  channel: { enrolled: true, maskedPhone: '+1 ••• ••• 1234', verifiedAt: new Date('2026-08-01') },
  senderConfigured: true,
};

const NOT_LINKED: LoadSmsChannelResult = {
  status: 'ready',
  channel: { enrolled: false, maskedPhone: null, verifiedAt: null },
  senderConfigured: true,
};

const render = (sms: LoadSmsChannelResult, email: string | null) =>
  renderToStaticMarkup(h(ConnectionChannelsCard, { sms, email }));

describe('ConnectionChannelsCard — text messages row', () => {
  it('renders the enrolled state with the loader-provided masked number, replay-masked', () => {
    const html = render(ENROLLED, null);
    expect(html).toContain('+1 ••• ••• 1234');
    expect(html).toContain('data-hale-pii');
  });

  it('renders the honest not-linked state — no number, no fabricated enrolment', () => {
    const html = render(NOT_LINKED, null);
    expect(html).toContain('Not linked yet');
    expect(html).not.toContain('Enrolled');
  });

  it('renders the honest not-switched-on state when no sender is configured', () => {
    const html = render({ ...NOT_LINKED, senderConfigured: false }, null);
    expect(html).toContain('isn’t switched on yet');
  });

  it('degrades to a sign-in line when the loader could not resolve the viewer', () => {
    const html = render({ status: 'unauthenticated' }, null);
    expect(html).toContain('Sign in');
  });
});

describe('ConnectionChannelsCard — email row', () => {
  it('renders the address, replay-masked', () => {
    const html = render(NOT_LINKED, 'alex@example.com');
    expect(html).toContain('alex@example.com');
    expect(html).toContain('data-hale-pii');
  });

  it('renders honest absence for a phone-claim account', () => {
    const html = render(NOT_LINKED, null);
    expect(html).toContain('No email on file');
    expect(html).not.toContain('data-hale-pii');
  });
});

describe('ConnectionChannelsCard — nothing Hale cannot back', () => {
  it('never renders a WhatsApp row or any dead Connect button', () => {
    const html = render(ENROLLED, 'alex@example.com').toLowerCase();
    expect(html).not.toContain('whatsapp');
    expect(html).not.toContain('<button');
  });
});
