import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * /settings/privacy offers the family export only to a seat the export route serves
 * (exportSeat): the download is the family's whole record, so a caregiver is not
 * offered it.
 */

const listSeatsMock = vi.fn<() => Promise<Array<{ familyId: string; role: string }>>>();

vi.mock('~/lib/consent-records', () => ({ listConsentRecordsForViewer: async () => [] }));
vi.mock('~/lib/db', () => ({ db: () => ({}) }));
vi.mock('~/lib/family', () => ({
  currentFamilyId: async () => 'family-a',
  currentUserId: async () => 'user-a',
  listSeatsForUser: () => listSeatsMock(),
}));

async function renderPage(): Promise<string> {
  const { default: SettingsPrivacyPage } = await import('./page');
  return renderToStaticMarkup(await SettingsPrivacyPage());
}

describe('/settings/privacy export', () => {
  beforeEach(() => {
    vi.resetModules();
    listSeatsMock.mockReset();
  });

  it('offers a parent the export (the positive control)', async () => {
    listSeatsMock.mockResolvedValue([{ familyId: 'family-a', role: 'primary_parent' }]);
    const html = await renderPage();
    expect(html).toContain('Export your data');
    expect(html).toContain('>Export</button>');
  });

  it('offers a caregiver no export', async () => {
    listSeatsMock.mockResolvedValue([{ familyId: 'family-a', role: 'nanny' }]);
    const html = await renderPage();
    expect(html).not.toContain('Export your data');
    expect(html).not.toContain('>Export</button>');
    expect(html).toContain('Your yes and no');
  });
});
