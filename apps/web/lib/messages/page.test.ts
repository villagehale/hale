import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEEN_REDACTED_PLACEHOLDER } from '~/lib/dashboard/mappers';
import type { MessageView } from './mappers';

/**
 * The web Messages page renders the portal thread. Loaders own the DB; this
 * asserts the presentation: a handled note shows its body, a draft is not
 * repeated in the thread, and an empty feed shows the calm copy.
 */

const loadMessagesMock = vi.fn<() => Promise<MessageView[]>>();
const listSeatsMock = vi.fn<() => Promise<Array<{ familyId: string; role: string }>>>();
vi.mock('~/lib/messages/queries', () => ({ loadMessages: () => loadMessagesMock() }));
vi.mock('~/lib/dashboard/queries', () => ({
  loadTrail: async () => [],
  loadPendingApprovals: async () => [],
  loadFamilyTimezone: async () => 'America/Toronto',
  loadViewerSeats: () => listSeatsMock(),
}));
vi.mock('~/components/hale/approve-button', () => ({ ApproveButton: () => null }));
vi.mock('~/components/hale/dismiss-button', () => ({ DismissButton: () => null }));

async function renderPage(): Promise<string> {
  const { default: MessagesPage } = await import('~/app/(authed)/messages/page');
  return renderToStaticMarkup(await MessagesPage());
}

const HANDLED: MessageView = {
  id: 'action-a2',
  kind: 'action',
  eyebrow: 'Add to calendar',
  body: 'Hale handled "Add to calendar".',
  when: 'Jun 19, 09:00',
  actionState: 'autonomous',
  teenRedacted: false,
};

const DRAFTED: MessageView = {
  id: 'action-a1',
  kind: 'action',
  eyebrow: 'Reply to email',
  body: 'Hale drafted "Reply to email" for your yes.',
  when: 'Jun 20, 06:00',
  actionState: 'drafted_for_approval',
  teenRedacted: false,
};

describe('MessagesPage rendering', () => {
  beforeEach(() => {
    vi.resetModules();
    loadMessagesMock.mockReset();
    listSeatsMock.mockResolvedValue([{ familyId: 'family-a', role: 'primary_parent' }]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders a handled note in the portal thread', async () => {
    loadMessagesMock.mockResolvedValue([HANDLED]);
    const html = await renderPage();
    expect(html).toContain('Messages');
    expect(html).toContain('Hale handled &quot;Add to calendar&quot;.');
  });

  it('does not repeat a drafted note in the thread', async () => {
    loadMessagesMock.mockResolvedValue([DRAFTED]);
    const html = await renderPage();
    expect(html).not.toContain('Hale drafted');
    expect(html).toContain('Nothing here yet. Text Hale and it shows up here.');
  });

  it('surfaces a redacted body verbatim without un-redacting it (rule #1)', async () => {
    const redacted: MessageView = {
      id: 'action-a3',
      kind: 'action',
      eyebrow: 'Private',
      body: TEEN_REDACTED_PLACEHOLDER,
      when: 'Jun 20, 06:00',
      actionState: 'autonomous',
      teenRedacted: true,
    };
    loadMessagesMock.mockResolvedValue([redacted]);
    const html = await renderPage();
    expect(html).toContain(TEEN_REDACTED_PLACEHOLDER);
  });

  it('shows the calm empty state when there are no messages', async () => {
    loadMessagesMock.mockResolvedValue([]);
    const html = await renderPage();
    expect(html).toContain('Nothing here yet. Text Hale and it shows up here.');
  });
});

// The export is the family's whole record, so it follows the export route's own rule
// (exportSeat): a parent is offered it, a caregiver is not.
describe('MessagesPage export', () => {
  beforeEach(() => {
    vi.resetModules();
    loadMessagesMock.mockResolvedValue([]);
  });

  it('offers a parent the export (the positive control)', async () => {
    listSeatsMock.mockResolvedValue([{ familyId: 'family-a', role: 'primary_parent' }]);
    expect(await renderPage()).toContain('Export</button>');
  });

  it('offers a caregiver no export', async () => {
    listSeatsMock.mockResolvedValue([{ familyId: 'family-a', role: 'nanny' }]);
    const html = await renderPage();
    expect(html).not.toContain('Export</button>');
    expect(html).toContain('Messages');
  });
});
