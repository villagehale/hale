import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import styles from '~/components/portal/portal.module.css';
import { TEEN_REDACTED_PLACEHOLDER } from '~/lib/dashboard/mappers';
import type { WhatHaleDidItem } from '~/lib/dashboard/what-hale-did';
import type { ConnectionSummary } from '~/lib/integrations/store';

/**
 * /privacy — one page for a parent's data rights: what Hale did on their behalf, what
 * it can still reach, a copy of their data, and deletion. It is a receipt, so it offers
 * no decision: nothing here approves, undoes, declines, connects or disconnects.
 * Loaders own the DB; this asserts the presentation.
 */

const loadWhatHaleDidMock = vi.fn<() => Promise<WhatHaleDidItem[]>>();
const listUserConnectionsMock =
  vi.fn<(database: unknown, familyId: string, userId: string) => Promise<ConnectionSummary[]>>();
const listSeatsMock = vi.fn<() => Promise<Array<{ familyId: string; role: string }>>>();

vi.mock('~/lib/dashboard/queries', () => ({ loadWhatHaleDid: () => loadWhatHaleDidMock() }));
vi.mock('~/lib/integrations/store', () => ({
  listUserConnections: (database: unknown, familyId: string, userId: string) =>
    listUserConnectionsMock(database, familyId, userId),
}));
vi.mock('~/lib/family', () => ({
  currentFamilyId: async () => 'family-a',
  currentUserId: async () => 'user-a',
  listSeatsForUser: () => listSeatsMock(),
}));
vi.mock('~/lib/db', () => ({ db: () => ({}) }));

const EMAIL: WhatHaleDidItem = {
  id: 'act-a',
  kind: 'email',
  what: 'Email coach@example.test — Practice moved',
  when: 'Jun 19, 08:30',
  calendars: [],
  teenRedacted: false,
};

const PLACEMENT: WhatHaleDidItem = {
  id: 'act-b',
  kind: 'calendar',
  what: 'Add to your calendar — Swim lesson, Jun 21, 10:00',
  when: 'Jun 20, 09:00',
  calendars: ['hale_calendar', 'google_calendar'],
  teenRedacted: false,
};

async function renderPage(): Promise<string> {
  const { default: PrivacyPage } = await import('./page');
  return renderToStaticMarkup(await PrivacyPage());
}

describe('/privacy', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    loadWhatHaleDidMock.mockResolvedValue([PLACEMENT, EMAIL]);
    listUserConnectionsMock.mockResolvedValue([
      { provider: 'gcal', status: 'active', scopes: [], lastSyncAt: null },
    ]);
    listSeatsMock.mockResolvedValue([{ familyId: 'family-a', role: 'primary_parent' }]);
  });

  it('shows what Hale did, the connections, export, delete and the policy link', async () => {
    const html = await renderPage();

    expect(html).toContain('What Hale did');
    expect(html).toContain('Email coach@example.test — Practice moved');
    expect(html).toContain('Jun 19, 08:30');
    expect(html).toContain('Add to your calendar — Swim lesson, Jun 21, 10:00');
    expect(html).toContain('Google Calendar');
    expect(html).toContain('Gmail');
    expect(html).toContain('>Connected<');
    expect(html).toContain('>Not connected<');
    expect(html).toContain('text Hale');
    expect(html).toContain('Export your data');
    expect(html).toContain('>Export<');
    expect(html).toContain('Delete everything');
    expect(html).toContain('href="https://www.villagehale.com/privacy"');
    expect(html.indexOf('Swim lesson')).toBeLessThan(html.indexOf('Practice moved'));
  });

  it('reads the viewer’s own connections, keyed on their family and user', async () => {
    await renderPage();
    expect(listUserConnectionsMock).toHaveBeenCalledTimes(1);
    expect(listUserConnectionsMock).toHaveBeenCalledWith(expect.anything(), 'family-a', 'user-a');
  });

  it('reads the Gmail row as not connected and the calendar row as connected', async () => {
    const html = await renderPage();
    const gmail = html.slice(html.indexOf('<h3>Gmail</h3>'), html.indexOf('<h3>Google Calendar'));
    expect(gmail).toContain('Not connected');
    const calendar = html.slice(html.indexOf('<h3>Google Calendar</h3>'));
    expect(calendar).toMatch(/>Connected</);
  });

  it('offers no decision: no approve, undo, decline, connect or disconnect', async () => {
    const html = await renderPage();

    for (const control of ['Approve', 'Undo', 'Decline', '/api/actions/', '/api/integrations/']) {
      expect(html).not.toContain(control);
    }
    expect(html).toContain('>Export<');
  });

  it('says so plainly when Hale has done nothing yet', async () => {
    loadWhatHaleDidMock.mockResolvedValue([]);
    expect(await renderPage()).toContain('Nothing yet.');

    loadWhatHaleDidMock.mockResolvedValue([EMAIL]);
    expect(await renderPage()).not.toContain('Nothing yet.');
  });

  it('renders a 13+ child’s row as the placeholder', async () => {
    loadWhatHaleDidMock.mockResolvedValue([
      { ...PLACEMENT, what: TEEN_REDACTED_PLACEHOLDER, teenRedacted: true },
    ]);
    expect(await renderPage()).toContain(TEEN_REDACTED_PLACEHOLDER);
  });

  // The export is the family's whole record (audit trail, members, children), so it is
  // a parent's to take, not a caregiver's.
  it('gives a named caregiver neither the family export nor deletion, under one "Your data" heading', async () => {
    listSeatsMock.mockResolvedValue([{ familyId: 'family-a', role: 'nanny' }]);
    const html = await renderPage();

    expect(html).not.toContain('Export your data');
    expect(html).not.toContain('>Export<');
    expect(html.split('>Your data<').length - 1).toBe(1);
    expect(html).not.toContain('Delete everything');
  });

  // Security P1: the activity list is family-wide (recipients, subjects, calendar
  // titles), and a scoped seat may not read another adult's mail or calendar.
  for (const role of ['nanny', 'grandparent', 'babysitter', 'extended', 'service']) {
    it(`shows a ${role} neither what Hale did nor the connection list`, async () => {
      listSeatsMock.mockResolvedValue([{ familyId: 'family-a', role }]);
      const html = await renderPage();

      for (const absent of [
        '>What Hale did<',
        'Practice moved',
        'Swim lesson',
        'Your connections',
        'Gmail',
        'Export your data',
        '>Export<',
      ]) {
        expect(html).not.toContain(absent);
      }
      expect(loadWhatHaleDidMock).not.toHaveBeenCalled();
      expect(listUserConnectionsMock).not.toHaveBeenCalled();
      expect(html).toContain('>Your data<');
    });
  }

  it('shows a co-parent what Hale did and their connections', async () => {
    listSeatsMock.mockResolvedValue([{ familyId: 'family-a', role: 'co_parent' }]);
    const html = await renderPage();
    expect(html).toContain('>What Hale did<');
    expect(html).toContain('Practice moved');
    expect(html).toContain('Your connections');
    expect(html).toContain('Export your data');
    expect(html).toMatch(
      new RegExp(`<button[^>]*class="${styles.secondary}"[^>]*>leave this family</button>`),
    );
  });

  it('shows nothing family-wide to a viewer with no seat in this family', async () => {
    listSeatsMock.mockResolvedValue([{ familyId: 'family-b', role: 'primary_parent' }]);
    const html = await renderPage();
    expect(html).not.toContain('>What Hale did<');
    expect(html).not.toContain('Export your data');
    expect(html).toContain('Privacy &amp; data');
    expect(loadWhatHaleDidMock).not.toHaveBeenCalled();
  });

  // The portal's own button classes: `.shell button` resets background and border, so the
  // global btn-secondary leaves both controls reading as plain text.
  it('renders Export and Delete everything as portal buttons', async () => {
    const html = await renderPage();
    expect(html).toMatch(
      new RegExp(`<button[^>]*class="${styles.secondary}"[^>]*>Export</button>`),
    );
    expect(html).toMatch(
      new RegExp(`<button[^>]*class="${styles.secondary}"[^>]*>Delete everything</button>`),
    );
    expect(html).not.toContain('btn-secondary');
  });
});
