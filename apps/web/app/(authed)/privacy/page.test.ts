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
  what: 'Emailed coach@example.test about Practice moved',
  when: 'Sent Jun 19, 8:30 a.m.',
  calendars: [],
  teenRedacted: false,
};

const PLACEMENT: WhatHaleDidItem = {
  id: 'act-b',
  kind: 'calendar',
  what: 'Added Swim lesson to Family calendar and Google Calendar',
  when: 'Sun, Jun 21, 10:00 a.m. · done Jun 20, 9:00 a.m.',
  calendars: ['hale_calendar', 'google_calendar'],
  teenRedacted: false,
};

const PARENT_LEDE = 'What Hale did for you, what it can reach, and how to take it back.';
const SCOPED_LEDE = 'You help out with this family. Its parents manage the family’s data.';
const UNSEATED_LEDE = 'Hale’s privacy policy, and how to reach us about your data.';
const DELETE_BUTTON = new RegExp(
  `<button[^>]*class="${styles.secondary} ${styles.destructive}"[^>]*>Delete account…</button>`,
);

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

    expect(html).toContain(PARENT_LEDE);
    expect(html).toContain('What Hale did');
    expect(html).toContain('Emailed coach@example.test about Practice moved');
    expect(html).toContain('Sent Jun 19, 8:30 a.m.');
    expect(html).toContain('Added Swim lesson to Family calendar and Google Calendar');
    expect(html).toContain('Sun, Jun 21, 10:00 a.m. · done Jun 20, 9:00 a.m.');
    expect(html).toContain('Google Calendar');
    expect(html).toContain('Gmail');
    expect(html).toContain('>Connected<');
    expect(html).toContain('>Not connected<');
    expect(html).toContain('text Hale');
    expect(html).toContain('Export your data');
    expect(html).toContain('>Export<');
    expect(html).toContain('<h3>Delete your account</h3>');
    expect(html).toMatch(DELETE_BUTTON);
    expect(html).toContain('href="https://www.villagehale.com/privacy"');
    expect(html.indexOf('Swim lesson')).toBeLessThan(html.indexOf('Practice moved'));
  });

  // The receipt names where the event went in its own sentence, so a pill per calendar
  // only looked more clickable than the real controls.
  it('renders each receipt as text, with no calendar pills', async () => {
    const html = await renderPage();
    expect(html).not.toContain(styles.chips);
    expect(html).toContain('Added Swim lesson to Family calendar and Google Calendar');
  });

  // Deletion is a sibling of Export, not the page's headline: the same neutral card and
  // the same row, with red left only on the button. Its one line is the hold; the full
  // explanation is the confirm step's.
  it('sets Delete as a row like Export, red only on its button', async () => {
    const html = await renderPage();

    expect(html).not.toContain(styles.danger);
    expect(html).toContain('<h3>Export your data</h3>');
    expect(html).toContain('<h3>Delete your account</h3>');
    expect(html).toContain('Starts after a 7-day hold you can cancel.');
    expect(html).not.toContain('This removes');
    expect(html).toMatch(DELETE_BUTTON);
  });

  it('caps the page to one reading column', async () => {
    expect(await renderPage()).toContain(styles.column);
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
  // a parent's to take, not a caregiver's. A card holding only a heading read as a
  // failed load, so a caregiver gets their own lede and no card at all.
  it('gives a named caregiver their own lede and no card, export or deletion', async () => {
    listSeatsMock.mockResolvedValue([{ familyId: 'family-a', role: 'nanny' }]);
    const html = await renderPage();

    expect(html).toContain(SCOPED_LEDE);
    expect(html).not.toContain(PARENT_LEDE);
    expect(html).not.toContain(styles.card);
    expect(html).not.toContain('Export your data');
    expect(html).not.toContain('Delete account');
    expect(html).not.toContain('<button');
    expect(html).toContain('href="https://www.villagehale.com/privacy"');
  });

  it('gives the parent the parent lede inside cards (the positive control)', async () => {
    const html = await renderPage();
    expect(html).toContain(PARENT_LEDE);
    expect(html).not.toContain(SCOPED_LEDE);
    expect(html).toContain(styles.card);
  });

  // The route answers a viewer with no seat 403, so the page offers them nothing to press.
  it('offers a viewer with no seat no delete button', async () => {
    listSeatsMock.mockResolvedValue([]);
    const html = await renderPage();
    expect(html).not.toContain('Delete account');
    expect(html).not.toContain('<button');
  });

  // The same rule as the export route (exportSeat): a parent of two households is
  // refused rather than handed one, so the page does not offer what the route refuses.
  it('offers a parent of two households no export, while still showing what Hale did', async () => {
    listSeatsMock.mockResolvedValue([
      { familyId: 'family-a', role: 'primary_parent' },
      { familyId: 'family-b', role: 'co_parent' },
    ]);
    const html = await renderPage();
    expect(html).toContain('>What Hale did<');
    expect(html).not.toContain('Export your data');
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
      expect(html).toContain(SCOPED_LEDE);
      expect(html).not.toContain(styles.card);
    });
  }

  it('shows a co-parent what Hale did and their connections', async () => {
    listSeatsMock.mockResolvedValue([{ familyId: 'family-a', role: 'co_parent' }]);
    const html = await renderPage();
    expect(html).toContain('>What Hale did<');
    expect(html).toContain('Practice moved');
    expect(html).toContain('Your connections');
    expect(html).toContain('Export your data');
    expect(html).toContain('<h3>Leave this family</h3>');
  });

  // The co-parent's control is labelled like the parent's, in the same slot of the row:
  // a portal button that names its own act.
  it('labels the co-parent’s control “Leave this family…” where the parent’s says “Delete account…”', async () => {
    listSeatsMock.mockResolvedValue([{ familyId: 'family-a', role: 'co_parent' }]);
    const html = await renderPage();
    expect(html).toMatch(
      new RegExp(
        `<button[^>]*class="${styles.secondary} ${styles.destructive}"[^>]*>Leave this family…</button>`,
      ),
    );
    expect(html).not.toContain('Delete account…');
    expect(html).not.toContain('>leave this family<');
  });

  it('shows nothing family-wide to a viewer with no seat in this family', async () => {
    listSeatsMock.mockResolvedValue([{ familyId: 'family-b', role: 'primary_parent' }]);
    const html = await renderPage();
    expect(html).not.toContain('>What Hale did<');
    expect(html).not.toContain('Export your data');
    expect(html).toContain('Privacy &amp; data');
    expect(loadWhatHaleDidMock).not.toHaveBeenCalled();
  });

  // "You help out with this family" is false for someone with no seat in it, so their
  // lede claims no role at all. The caregiver test above is the positive control.
  for (const [label, seats] of [
    ['no seat at all', []],
    ['a seat only in another family', [{ familyId: 'family-b', role: 'nanny' }]],
  ] as const) {
    it(`gives a viewer with ${label} a lede that claims no role`, async () => {
      listSeatsMock.mockResolvedValue([...seats]);
      const html = await renderPage();
      expect(html).toContain(UNSEATED_LEDE);
      expect(html).not.toContain(SCOPED_LEDE);
      expect(html).not.toContain(PARENT_LEDE);
    });
  }

  // The portal's own button classes: `.shell button` resets background and border, so the
  // global btn-secondary leaves both controls reading as plain text.
  it('renders Export and Delete account as portal buttons', async () => {
    const html = await renderPage();
    expect(html).toMatch(
      new RegExp(`<button[^>]*class="${styles.secondary}"[^>]*>Export</button>`),
    );
    expect(html).toMatch(DELETE_BUTTON);
    expect(html).not.toContain('btn-secondary');
  });
});
