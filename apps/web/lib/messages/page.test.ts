import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEEN_REDACTED_PLACEHOLDER } from '~/lib/dashboard/mappers';
import type { MessageView } from './mappers';

/**
 * The web Messages page — the render contract mirrored from the mobile screen.
 * The loader owns the DB + rule-#1 redaction (covered in queries.test), so it's
 * stubbed here; this test asserts the presentation: a drafted row is the ONLY one
 * that links to /approvals (the parent decides there — rule #4), the rest are
 * plain notes, a redacted body is surfaced verbatim (never un-redacted), and the
 * empty feed shows the calm copy.
 */

const loadMessagesMock = vi.fn<() => Promise<MessageView[]>>();
vi.mock('~/lib/messages/queries', () => ({ loadMessages: () => loadMessagesMock() }));

async function renderPage(): Promise<string> {
  const { default: MessagesPage } = await import('~/app/(authed)/messages/page');
  return renderToStaticMarkup(await MessagesPage());
}

const DRAFTED: MessageView = {
  id: 'action-a1',
  kind: 'action',
  eyebrow: 'Reply to email',
  body: 'Hale drafted "Reply to email" for your yes.',
  when: 'Jun 20, 06:00',
  actionState: 'drafted_for_approval',
  teenRedacted: false,
};

const HANDLED: MessageView = {
  id: 'action-a2',
  kind: 'action',
  eyebrow: 'Add to calendar',
  body: 'Hale handled "Add to calendar".',
  when: 'Jun 19, 09:00',
  actionState: 'autonomous',
  teenRedacted: false,
};

const DIGEST: MessageView = {
  id: 'digest-d1',
  kind: 'digest',
  eyebrow: 'Daily brief',
  body: 'A calm day.',
  when: 'Jun 18, 13:00',
};

describe('MessagesPage rendering', () => {
  beforeEach(() => {
    vi.resetModules();
    loadMessagesMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('links a drafted row to /approvals so the parent decides there', async () => {
    loadMessagesMock.mockResolvedValue([DRAFTED]);
    const html = await renderPage();
    expect(html).toContain('href="/approvals"');
    expect(html).toContain('Hale drafted &quot;Reply to email&quot; for your yes.');
  });

  it('renders a non-drafted note as a plain card that never links to /approvals', async () => {
    loadMessagesMock.mockResolvedValue([HANDLED, DIGEST]);
    const html = await renderPage();
    expect(html).toContain('Hale handled &quot;Add to calendar&quot;.');
    expect(html).toContain('A calm day.');
    expect(html).not.toContain('href="/approvals"');
  });

  it('surfaces a redacted body verbatim without un-redacting it (rule #1)', async () => {
    const redacted: MessageView = {
      id: 'action-a3',
      kind: 'action',
      eyebrow: 'Private',
      body: TEEN_REDACTED_PLACEHOLDER,
      when: 'Jun 20, 06:00',
      actionState: 'drafted_for_approval',
      teenRedacted: true,
    };
    loadMessagesMock.mockResolvedValue([redacted]);
    const html = await renderPage();
    expect(html).toContain(TEEN_REDACTED_PLACEHOLDER);
    // Still routes to Approvals — the lifecycle frame survives redaction.
    expect(html).toContain('href="/approvals"');
  });

  it('shows the calm empty state when there are no messages', async () => {
    loadMessagesMock.mockResolvedValue([]);
    const html = await renderPage();
    expect(html).toContain('Nothing new from Hale yet.');
    expect(html).not.toContain('href="/approvals"');
  });
});
